#!/usr/bin/env node
/**
 * Mock ad-gate shortener for testing UnShort's Deep Scan extractors.
 * Simulates the real hiding techniques used by exe.io / shrtfly / safelink-
 * style shorteners, since those hosts aren't reachable from this sandbox.
 *
 *   SHORTENER on :4000   — serves pages that HIDE the destination
 *   DESTINATION on :4100 — the "real site" the link points to
 */
const http = require("http");

const DEST = "http://127.0.0.1:4100/the-real-file";
const B64 = Buffer.from(DEST).toString("base64"); // aHR0cDovLzEyNy4wLjAuMTo0MTAwL3RoZS1yZWFsLWZpbGU=

const page = (body) =>
  `<!DOCTYPE html><html><head><title>FreeShort - please wait...</title></head>
   <body><h1>Your link is almost ready!</h1><div class="ad">BUY CRYPTO NOW!!</div>${body}</body></html>`;

// ------------------------------------------------ shortener (:4000)
http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    res.setHeader("Content-Type", "text/html");

    switch (u.pathname) {
      // Technique 1: JS redirect after fake countdown
      case "/js/abc123":
        return res.end(page(`<script>
          var t = 5;
          setTimeout(function(){ window.location.href = "${DEST}"; }, 100);
        </script><p>Redirecting in <span id="t">5</span>s</p>`));

      // Technique 2: destination hidden as base64 blob in inline script (atob style)
      case "/atob/abc123":
        return res.end(page(`<script>
          var _0xa1 = "${B64}";
          function go(){ document.location = atob(_0xa1); }
        </script><button onclick="go()">GET LINK</button>`));

      // Technique 3: hidden form input
      case "/form/abc123":
        return res.end(page(`<form method="POST" action="/go">
          <input type="hidden" name="url" value="${DEST}">
          <button>Continue</button></form>`));

      // Technique 4: "skip ad" button
      case "/skip/abc123":
        return res.end(page(`<a id="skip" class="btn" href="${DEST}">Skip Ad &raquo;</a>`));

      // Technique 5: JSON blob in inline script
      case "/json/abc123":
        return res.end(page(`<script>
          window.__DATA__ = {"ads":true,"destination":"${DEST.replace(/\//g, "\\/")}","wait":10};
        </script>`));

      // Technique 6: nested — JS redirect to the atob page (multi-layer maze)
      case "/nest/abc123":
        return res.end(page(`<script>location.replace("http://127.0.0.1:4000/atob/abc123");</script>`));

      // Technique 8: meta refresh
      case "/meta/abc123":
        return res.end(`<html><head><meta http-equiv="refresh" content="3;url=${DEST}"><title>wait...</title></head><body>wait</body></html>`);

      // Technique 9 (from Bloggerpemula BASS): AdLinkFly <form id="go-link" action="/links/go">
      // The URL is NOT in the HTML at all — only returned as JSON when /links/go is POSTed via XHR!
      case "/adlinkfly/abc123":
        res.setHeader("Set-Cookie", "csrfToken=tok_998877; Path=/");
        return res.end(page(`
          <form id="go-link" method="post" action="/links/go">
            <input type="hidden" name="_method" value="POST">
            <input type="hidden" name="_csrfToken" value="tok_998877">
            <input type="hidden" name="ad_form_data" value="ENC_BLOB_XYZ">
          </form>
          <a href="javascript:void(0)" class="btn get-link disabled">Please wait 10s...</a>`));

      case "/links/go": {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.setHeader("Content-Type", "application/json");
          if (req.headers["x-requested-with"] === "XMLHttpRequest" && body.includes("ad_form_data=ENC_BLOB_XYZ")) {
            res.end(JSON.stringify({ status: "success", url: DEST }));
          } else {
            res.statusCode = 403;
            res.end(JSON.stringify({ status: "error", message: "Bad XHR/token" }));
          }
        });
        return;
      }

      // Technique 10 (from BASS): Double-Base64 + ROT13 obfuscated payload
      case "/rot13b64/abc123": {
        const b64x2 = Buffer.from(B64).toString("base64");
        const rot = b64x2.replace(/[a-z]/gi, (c) => {
          const base = c <= "Z" ? 90 : 122;
          const code = c.charCodeAt(0) + 13;
          return String.fromCharCode(base >= code ? code : code - 26);
        });
        return res.end(page(`<script>var secret = "${rot}";</script>`));
      }

      // Technique 11 (from Universal Auto-Bypasser v4): data-url / data-destination attribute
      case "/dataattr/abc123":
        return res.end(page(`<div class="countdown" id="timer">Please wait 8 seconds...</div>
          <button data-destination="${DEST}">Proceed</button>`));

      // Technique 12 (from Universal Auto-Bypasser v4): unquoted JS variable assignment (final_url = "...")
      case "/jsvar/abc123":
        return res.end(page(`<script>let final_url = "${DEST}";</script>`));

      // Technique 13: Uncrackable captcha wall on an unknown domain -> triggers 0..5 confidence scorer
      case "/go/locked":
        return res.end(page(`<div class="spinner" id="timer">Please wait 15 seconds</div>
          <iframe src="https://ads.example.com/banner"></iframe>
          <button disabled>Verify &amp; Continue</button>`));

      // Technique 14 (from ArvindSaini978 Exe.io v1.1.0):
      // Step 1 <form id="before-captcha"> + ad-network decoys (llvpn.com, cleverwebserver.com)
      // Server must ignore the ad-network scripts, POST form#before-captcha -> /adlinkfly/abc123 -> /links/go -> DEST!
      case "/exe/step1":
        res.setHeader("Set-Cookie", "csrfToken=tok_998877; Path=/");
        return res.end(page(`
          <script>window.open("https://llvpn.com/popup");</script>
          <a href="https://cleverwebserver.com/clickjack">Click here</a>
          <form id="before-captcha" method="POST" action="/adlinkfly/abc123">
            <input type="hidden" name="ref" value="exe">
            <button type="submit">Continue</button>
          </form>`));

      // Technique 15 (from ArvindSaini978 Exe.io v1.1.0):
      // Step 2 <form id="link-view"> with Cloudflare Turnstile ([name="cf-turnstile-response"])
      case "/exe/turnstile":
        return res.end(page(`
          <form id="link-view" method="POST" action="/exe/step3">
            <div class="cf-turnstile" data-sitekey="0x4AAAAAAA"></div>
            <input type="hidden" name="cf-turnstile-response" value="">
            <button type="submit">Continue</button>
          </form>`));

      default:
        res.statusCode = 404;
        return res.end(page("<p>404</p>"));
    }
  })
  .listen(4000, "127.0.0.1", () => console.log("mock shortener on :4000"));

// ------------------------------------------------ real destination (:4100)
http
  .createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end("<html><head><title>The REAL Destination Site</title></head><body><h1>You found the real file!</h1></body></html>");
  })
  .listen(4100, "127.0.0.1", () => console.log("mock destination on :4100"));
