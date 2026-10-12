#!/usr/bin/env node
/**
 * UnShort — fast, free short-link expander for developers.
 * Zero dependencies. Pure Node.js (>=18).
 *
 * Web UI :  GET /
 * API    :  GET /api/expand?url=<short-link>[&max=15][&deep=0]
 *
 * Two engines:
 *  1. HTTP chain follower — follows 3xx redirects hop by hop.
 *  2. DEEP SCAN (reverse-engineering mode) — when a shortener hides the
 *     destination in its page instead of sending a redirect, we download the
 *     HTML and extract the real URL using the same tricks bypassers use:
 *       • <meta http-equiv="refresh"> redirects
 *       • JS redirects: window.location=, location.href=, location.replace()
 *       • base64-encoded destinations in query params / path segments
 *       •   (exe.io / shrtfly / "safelink" family trick)
 *       • hidden <form> inputs named url/link/destination/token targets
 *       • "skip ad / continue / get link" anchor buttons
 *       • JSON blobs in inline scripts: "url":"https:\/\/real.site\/..."
 *       • og:url / canonical pointing off-site
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ALLOW_PRIVATE = process.env.UNSHORT_ALLOW_PRIVATE === "1"; // for tests only
const MAX_HOPS_DEFAULT = 15;
const MAX_HOPS_LIMIT = 30;
const HOP_TIMEOUT_MS = 8000;
const DEEP_SCAN_BYTES = 512 * 1024; // read up to 512 KB of HTML for deep scan

// ---------------------------------------------------------------- helpers

function normalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname || (!u.hostname.includes(".") && !ALLOW_PRIVATE)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function isPrivateHost(hostname) {
  if (ALLOW_PRIVATE) return false;
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === "[::1]" || h === "::1") return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  return false;
}

// Known ad-gate shortener families (captcha/countdown walls). If even deep
// scan can't extract a destination on these, we tell the user why.
const AD_GATE_HOSTS = [
  "ouo.io", "ouo.press", "linkvertise.com", "link-to.net", "up-to-down.net",
  "exe.io", "exey.io", "exe.app", "exee.io", "shrinkme.io", "shrinkme.ink",
  "gplinks.co", "gplinks.in", "za.gl", "zee.gl", "sh.st", "shorte.st",
  "fc.lc", "fc-lc.com", "shrinkearn.com", "clk.sh", "clks.pro", "shrtfly.com",
  "adf.ly", "cutt.ly", "linkshortify.com", "droplink.co", "tnlink.in",
  "rocklinks.net", "ez4short.com", "tii.ai", "oke.io", "mboost.me",
];

function isAdGateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  return AD_GATE_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

// Caesar/ROT13 cipher used by Bloggerpemula's BASS script (Decrypter(str, 13))
function rot13(str, shift = 13) {
  return String(str).replace(/[a-z]/gi, (c) => {
    const base = c <= "Z" ? 90 : 122;
    const code = c.charCodeAt(0) + shift;
    return String.fromCharCode(base >= code ? code : code - 26);
  });
}

function rawB64Decode(s) {
  if (!s || s.length < 8 || s.length > 4096) return null;
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(s)) return null;
  try {
    return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return null;
  }
}

// Supports 1x/2x/3x base64 + ROT13 combinations (BASS DecodeBase64 + Decrypter)
function tryBase64Url(s) {
  if (!s || s.length < 12 || s.length > 4096) return null;
  const variants = [s, rot13(s)];
  for (let cur of variants) {
    for (let depth = 0; depth < 3; depth++) {
      const dec = rawB64Decode(cur);
      if (!dec) break;
      for (const candidate of [dec, rot13(dec)]) {
        let u = candidate;
        try { if (/%[0-9A-Fa-f]{2}/.test(u)) u = decodeURIComponent(u); } catch {}
        if (/^https?:\/\/[^\s"'<>]+$/i.test(u)) return u;
      }
      cur = dec.trim();
    }
  }
  return null;
}

// Classic AdFly `var ysmm = '...'` decoder
function decodeAdFlyYsmm(ysmm) {
  if (!ysmm || ysmm.length < 8) return null;
  let left = "", right = "";
  for (let i = 0; i < ysmm.length; i++) {
    if (i % 2 === 0) left += ysmm[i];
    else right = ysmm[i] + right;
  }
  let arr = (left + right).split("");
  for (let i = 0; i < arr.length; i++) {
    if (/\d/.test(arr[i])) {
      for (let j = i + 1; j < arr.length; j++) {
        if (/\d/.test(arr[j])) {
          const s = parseInt(arr[i], 10) ^ parseInt(arr[j], 10);
          if (s < 10) arr[i] = String(s);
          i = j;
          break;
        }
      }
    }
  }
  const dec = rawB64Decode(arr.join(""));
  if (!dec || dec.length <= 32) return null;
  const stripped = dec.slice(16, -16);
  return /^https?:\/\//i.test(stripped) ? stripped : null;
}

// Strip swiftcut.xyz tracking param (from BASS form#go-link handler)
function cleanBypassedUrl(rawUrl) {
  let u = rawUrl;
  if (/swiftcut\.xyz/i.test(u)) {
    u = u.replace(/[?&]i=[^&]*/g, "").replace(/\?&/, "?").replace(/&&/g, "&").replace(/[?&]$/, "");
  }
  return u;
}

function cleanUrl(raw, baseUrl) {
  if (!raw) return null;
  try {
    const u = new URL(String(raw).replace(/\\\//g, "/").replace(/&amp;/g, "&"), baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function findMetaRefresh(html, baseUrl) {
  const m = html.match(
    /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']?\s*\d+\s*;\s*url\s*=\s*([^"'>\s]+)/i
  );
  return m ? cleanUrl(m[1], baseUrl) : null;
}

/**
 * Reverse-engineering extractors. Given the URL itself (before even fetching),
 * try to decode a destination hidden IN the link — many "safelink" shorteners
 * put the target as base64 in a query param or path segment.
 */
function extractFromUrlItself(urlStr) {
  const u = new URL(urlStr);
  const candidates = [];

  // BASS extractFlexibleUrl: full-page-script links like
  //   https://exe.io/st?api=XXXX&url=https://real.com/file
  //   or chained &url=...&url=... or ?BypassResults=...
  const flexMatch = urlStr.split(/[?&](?:url|BypassResults)=/i);
  if (flexMatch.length >= 2) {
    let tail = flexMatch[flexMatch.length - 1].replace(/&m=1$/, "");
    try { tail = decodeURIComponent(tail); } catch {}
    const direct = cleanUrl(tail, urlStr) || tryBase64Url(tail);
    if (direct && new URL(direct).host !== u.host) {
      candidates.push({ next: direct, via: "fullpage-script-url" });
    }
  }

  for (const [k, v] of u.searchParams) {
    if (/^(url|link|u|go|dest|destination|target|redirect|r|to|out|q|s)$/i.test(k)) {
      const direct = cleanUrl(v, urlStr);
      if (direct && new URL(direct).host !== u.host) candidates.push({ next: direct, via: "query-param" });
    }
    const b64 = tryBase64Url(v);
    if (b64) candidates.push({ next: b64, via: "base64-in-query" });
  }
  // last path segment as base64 (safelink style: site.com/aHR0cHM6Ly8...)
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length) {
    const b64 = tryBase64Url(decodeURIComponent(segs[segs.length - 1]));
    if (b64) candidates.push({ next: b64, via: "base64-in-path" });
  }
  // fragment too: site.com/x#aHR0cHM6...
  if (u.hash && u.hash.length > 1) {
    const b64 = tryBase64Url(decodeURIComponent(u.hash.slice(1)));
    if (b64) candidates.push({ next: b64, via: "base64-in-fragment" });
  }
  return candidates[0] || null;
}

/**
 * DEEP SCAN: dig the real destination out of a shortener's HTML/JS page.
 * Returns { next, via } or null.
 */
function deepScan(html, pageUrl) {
  const page = new URL(pageUrl);
  const offPage = (uStr) => {
    try {
      const t = new URL(uStr);
      if (t.href === page.href) return false;
      // ignore links to common junk
      if (/\.(png|jpe?g|gif|svg|css|woff2?|ico)(\?|$)/i.test(t.pathname)) return false;
      return true;
    } catch { return false; }
  };
  const offSite = (uStr) => {
    try { return new URL(uStr).host !== page.host; } catch { return false; }
  };

  // 1. meta-refresh
  const meta = findMetaRefresh(html, pageUrl);
  if (meta && offPage(meta)) return { next: meta, via: "meta-refresh" };

  // 2. JS redirects
  const jsPatterns = [
    /(?:window\.|document\.|top\.|self\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/gi,
    /location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/gi,
    /window\.open\(\s*["'](https?:[^"']+)["']/gi,
  ];
  for (const re of jsPatterns) {
    let m;
    while ((m = re.exec(html))) {
      const u = cleanUrl(m[1], pageUrl);
      if (u && offPage(u) && !/(google|facebook|twitter|\.css|\.js)/i.test(u)) {
        return { next: u, via: "js-redirect" };
      }
    }
  }

  // 3. base64 blobs anywhere in the page that decode to a URL
  //    (shorteners love var target = atob("aHR0cHM6..."))
  const b64Re = /["']([A-Za-z0-9+/_-]{16,2048}={0,2})["']/g;
  let bm;
  while ((bm = b64Re.exec(html))) {
    const dec = tryBase64Url(bm[1]);
    if (dec && offSite(dec)) return { next: dec, via: "base64-in-page" };
  }

  // 4. hidden form inputs named url/link/destination
  const inputRe = /<input[^>]+name\s*=\s*["']?(url|link|dest|destination|target|redirect|go|token_url|surl)["']?[^>]*>/gi;
  let im;
  while ((im = inputRe.exec(html))) {
    const valM = im[0].match(/value\s*=\s*["']([^"']+)["']/i);
    if (valM) {
      const direct = cleanUrl(valM[1], pageUrl);
      if (direct && offSite(direct)) return { next: direct, via: "hidden-form-input" };
      const b64 = tryBase64Url(valM[1]);
      if (b64 && offSite(b64)) return { next: b64, via: "hidden-form-input-b64" };
    }
  }

  // 5. "skip ad / continue / get link / download" buttons
  const aRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let am;
  while ((am = aRe.exec(html))) {
    const label = (am[2] || "").replace(/<[^>]+>/g, " ");
    const attrs = am[0];
    const looksLikeSkip =
      /skip|continue|get\s*link|go\s*to\s*(link|url|destination)|download|proceed|unlock/i.test(label) ||
      /id\s*=\s*["']?(skip|continue|getlink|go-link|btn-main|surl|dl-btn)/i.test(attrs);
    if (!looksLikeSkip) continue;
    const u = cleanUrl(am[1], pageUrl);
    if (u && offSite(u)) return { next: u, via: "skip-button" };
    const b64 = tryBase64Url(am[1].split(/[#?/]/).pop() || "");
    if (b64) return { next: b64, via: "skip-button-b64" };
  }

  // 6. JSON blobs in inline scripts: "url":"https:\/\/real.site\/file"
  const jsonRe = /["'](?:url|link|destination|redirect_url|safelink|download_url|original)["']\s*:\s*["'](https?:[^"']+)["']/gi;
  let jm;
  while ((jm = jsonRe.exec(html))) {
    const u = cleanUrl(jm[1], pageUrl);
    if (u && offSite(u)) return { next: u, via: "json-blob" };
  }

  // 7. AdFly `var ysmm = '...'` obfuscated token
  const ysmmM = html.match(/ysmm\s*=\s*["']([A-Za-z0-9+/=]{16,})["']/);
  if (ysmmM) {
    const u = decodeAdFlyYsmm(ysmmM[1]);
    if (u && offPage(u)) return { next: u, via: "adfly-ysmm" };
  }

  // 8. og:url / canonical pointing off-site
  const ogM = html.match(/<meta[^>]+property\s*=\s*["']og:url["'][^>]+content\s*=\s*["']([^"']+)["']/i)
           || html.match(/<link[^>]+rel\s*=\s*["']canonical["'][^>]+href\s*=\s*["']([^"']+)["']/i);
  if (ogM) {
    const u = cleanUrl(ogM[1], pageUrl);
    if (u && offSite(u)) return { next: u, via: "og-url" };
  }

  return null;
}

/**
 * Ported from Bloggerpemula's "Bypass All Shortlinks" (BASS) userscript:
 * AdLinkFly shorteners (exe.io, shrinkme, gplinks, shrtfly, cuty.io, etc.)
 * put a <form id="go-link" action="/links/go"> on the page with hidden CSRF +
 * ad_form_data tokens and normally make you wait 10s before XHR-POSTing it.
 * We serialize the form and POST it immediately with X-Requested-With: XMLHttpRequest
 * to get {"status":"success","url":"https://real-destination..."}.
 */
async function tryGoLinkAjax(html, pageUrl, setCookies) {
  const formM = html.match(/<form\b[^>]*(?:id\s*=\s*["']?go-link["']?|action\s*=\s*["'][^"']*\/links\/go["'])[^>]*>([\s\S]*?)<\/form>/i);
  if (!formM) return null;

  const formTag = formM[0];
  const formBody = formM[1];
  const actM = formTag.match(/action\s*=\s*["']([^"']+)["']/i);
  const actionUrl = cleanUrl(actM ? actM[1] : "/links/go", pageUrl);
  if (!actionUrl) return null;

  const params = new URLSearchParams();
  const inputRe = /<input\b[^>]*>/gi;
  let im;
  while ((im = inputRe.exec(formBody))) {
    const nameM = im[0].match(/name\s*=\s*["']([^"']+)["']/i);
    const valM = im[0].match(/value\s*=\s*["']([^"']*)["']/i);
    if (nameM) params.append(nameM[1], valM ? valM[1] : "");
  }

  const cookieParts = ["ab=2"];
  for (const c of setCookies || []) {
    const kv = String(c).split(";")[0].trim();
    if (kv) cookieParts.push(kv);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOP_TIMEOUT_MS);
  try {
    const res = await fetch(actionUrl, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/javascript, */*; q=0.01",
        Origin: new URL(pageUrl).origin,
        Referer: pageUrl,
        Cookie: cookieParts.join("; "),
      },
      body: params.toString(),
    });
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      if (data && data.url) {
        const cleaned = cleanUrl(cleanBypassedUrl(data.url), pageUrl);
        if (cleaned) return { next: cleaned, via: "adlinkfly-go-link-ajax" };
      }
    } catch {}
  } catch {} finally {
    clearTimeout(timer);
  }
  return null;
}

// ---------------------------------------------------------------- engine

async function fetchHop(url, deep) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: new URL(url).origin + "/",
      },
    });

    const hop = {
      url,
      status: res.status,
      statusText: res.statusText || "",
      ms: Date.now() - started,
      type: null,
      via: null,
      next: null,
    };

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      res.body?.cancel?.().catch(() => {});
      if (loc) {
        hop.type = "http-redirect";
        hop.next = new URL(loc, url).toString();
        return hop;
      }
    }

    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (res.status === 200 && ctype.includes("html") && res.body) {
      const reader = res.body.getReader();
      let html = "";
      let bytes = 0;
      while (bytes < DEEP_SCAN_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        html += Buffer.from(value).toString("utf8");
      }
      reader.cancel().catch(() => {});

      if (deep) {
        const found = deepScan(html, url);
        if (found && found.next !== url) {
          hop.type = "deep-scan";
          hop.via = found.via;
          hop.next = found.next;
          return hop;
        }
        const setCookies =
          typeof res.headers.getSetCookie === "function"
            ? res.headers.getSetCookie()
            : [res.headers.get("set-cookie")].filter(Boolean);
        const ajaxFound = await tryGoLinkAjax(html, url, setCookies);
        if (ajaxFound && ajaxFound.next !== url) {
          hop.type = "deep-scan";
          hop.via = ajaxFound.via;
          hop.next = ajaxFound.next;
          hop.ms = Date.now() - started;
          return hop;
        }
      } else {
        const meta = findMetaRefresh(html, url);
        if (meta && meta !== url) {
          hop.type = "deep-scan";
          hop.via = "meta-refresh";
          hop.next = meta;
          return hop;
        }
      }

      const t = html.match(/<title[^>]*>([^<]{0,200})/i);
      if (t) hop.title = t[1].trim();
    } else {
      res.body?.cancel?.().catch(() => {});
    }

    hop.type = "final";
    return hop;
  } finally {
    clearTimeout(timer);
  }
}

async function expand(rawUrl, maxHops, deep) {
  const start = normalizeUrl(rawUrl);
  if (!start) return { ok: false, error: "Invalid URL. Provide something like https://exe.io/abc123" };

  const chain = [];
  const seen = new Set();
  let current = start;

  // Trick 0: sometimes the destination is encoded in the link itself —
  // decode it without even touching the network.
  if (deep) {
    const inUrl = extractFromUrlItself(start);
    if (inUrl) {
      chain.push({ url: start, status: null, statusText: "decoded offline", ms: 0, type: "deep-scan", via: inUrl.via, next: inUrl.next });
      seen.add(start);
      current = inUrl.next;
    }
  }

  for (let i = chain.length; i < maxHops; i++) {
    let host;
    try { host = new URL(current).hostname; } catch { return { ok: false, error: "Shortener produced an invalid URL: " + current, chain }; }
    if (isPrivateHost(host)) return { ok: false, error: `Refusing to request private/internal host "${host}".`, chain };
    if (seen.has(current)) return { ok: false, error: "Redirect loop detected.", chain };
    seen.add(current);

    let hop;
    try {
      hop = await fetchHop(current, deep);
    } catch (e) {
      const reason = e.name === "AbortError" ? `timed out after ${HOP_TIMEOUT_MS} ms` : (e.cause?.code || e.message || "network error");
      chain.push({ url: current, status: 0, statusText: String(reason), ms: null, type: "error", next: null });
      return {
        ok: chain.length > 1,
        partial: true,
        error: `Could not reach ${host} (${reason}).`,
        input: rawUrl,
        finalUrl: chain.length > 1 ? current : null,
        hops: chain.length,
        chain,
      };
    }

    chain.push(hop);
    if (hop.type === "final" || !hop.next) {
      const result = {
        ok: true,
        input: rawUrl,
        finalUrl: hop.url,
        finalHost: new URL(hop.url).hostname,
        https: hop.url.startsWith("https://"),
        title: hop.title || null,
        hops: chain.length,
        redirects: chain.length - 1,
        deepScan: deep,
        chain,
      };
      // Stuck on a known captcha/countdown ad-gate?
      if (isAdGateHost(result.finalHost) && chain.length <= 2) {
        result.adGate = true;
        result.adGateNote =
          "This shortener hides the destination behind a captcha/countdown that must be solved by a human in a browser. " +
          "No server-side tool can fully bypass it. Deep Scan found no embedded destination in the page it serves to first-time visitors.";
      }
      return result;
    }
    current = hop.next;
  }

  return { ok: false, error: `Gave up after ${maxHops} hops (possible redirect maze).`, chain };
}

// ---------------------------------------------------------------- server

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (u.pathname === "/api/expand") {
    const target = u.searchParams.get("url");
    const max = Math.min(parseInt(u.searchParams.get("max"), 10) || MAX_HOPS_DEFAULT, MAX_HOPS_LIMIT);
    const deep = u.searchParams.get("deep") !== "0"; // deep scan ON by default
    if (!target) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Missing ?url= parameter." }));
    }
    const result = await expand(target, max, deep);
    res.writeHead(result.ok || result.partial ? 200 : 422, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(result, null, 2));
  }

  if (u.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, service: "unshort", deepScan: true, time: new Date().toISOString() }));
  }

  let file = u.pathname === "/" ? "/index.html" : u.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(PUBLIC_DIR, file);
  if (full.startsWith(PUBLIC_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    return fs.createReadStream(full).pipe(res);
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "Not found. Try GET /api/expand?url=..." }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`UnShort listening on http://0.0.0.0:${PORT} (deep scan: on)`);
});
