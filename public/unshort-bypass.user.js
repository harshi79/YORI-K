// ==UserScript==
// @name         UnShort AIO Bypass — Exe.io / AdLinkFly / Universal Shortlink Bypasser
// @namespace    https://github.com/harshi79/YORI-K
// @version      2.0.0
// @description  Combines Exe.io/Exey.io/Exeygo Turnstile & Step-1 auto-submitter + Bloggerpemula AdLinkFly form#go-link instant XHR POST + Universal Shortlink Auto-Bypasser v4.0.
// @author       UnShort (credits: ArvindSaini978, Bloggerpemula, Universal Bypasser)
// @match        *://*/*
// @exclude      /^(https?:\/\/)([^\/]+\.)?((cloudflare|github|reddit|bing|yahoo|microsoft|whatsapp|amazon|ebay|paypal|stripe|discord|netflix|spotify|youtube|twitter|x|linkedin|chatgpt|openai|google).com|(greasyfork|wikipedia|telegram).org)(\/.*)/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self) return;

  const AD_DOMAINS = ['llvpn.com', 'cleverwebserver.com', 'abscloud.org', 'doubleclick.net', 'justkoalas.com', 'adsterra', 'monetag', 'hilltopads'];
  const TARGET_PATTERN = /(pixeldrain|filecrypt|dramaday|mega\.nz|drive\.google|mediafire|1fichier|krakenfiles|gofile|qiwi|rapidgator|ddownload|katfile|nitroflare|turbobit|upload\.ee|github\.com)/i;
  const AD_PATTERN = /(exe\.io|exey\.io|exeygo|cuty\.io|cuttty|adsterra|doubleclick|monetag|hilltopads|llvpn|cleverwebserver|abscloud)/i;

  // 1. Fast-decode unpadded Base64 ?url= / &url= before page even loads
  try {
    const params = new URLSearchParams(window.location.search);
    for (const key of ['url', 'u', 'go', 'dest', 'destination', 'target', 'BypassResults']) {
      if (!params.has(key)) continue;
      let raw = decodeURIComponent(params.get(key)).trim();
      if (/^https?:\/\//i.test(raw) && !AD_PATTERN.test(raw)) {
        window.location.replace(raw);
        return;
      }
      let cleaned = raw.replace(/-/g, '+').replace(/_/g, '/');
      while (cleaned.length % 4 !== 0) cleaned += '=';
      const decoded = atob(cleaned);
      if (/^https?:\/\//i.test(decoded) && !AD_PATTERN.test(decoded)) {
        window.location.replace(decoded);
        return;
      }
    }
  } catch (e) {}

  // 2. Neutralize ad scripts & popups on known ad-gate hosts
  const isExeFamily = /(exe\.io|exey\.io|exeygo\.com|shrinkme|gplinks|shrtfly|cuty\.io|ouo\.io|fc\.lc|clk\.sh)/i.test(location.hostname);
  if (isExeFamily) {
    const origCreate = document.createElement;
    document.createElement = function(tag, opts) {
      const el = origCreate.call(document, tag, opts);
      if (tag && tag.toLowerCase() === 'script') {
        const origSetAttr = el.setAttribute;
        el.setAttribute = function(n, v) {
          if (n === 'src' && AD_DOMAINS.some(d => String(v).includes(d))) return;
          return origSetAttr.apply(this, arguments);
        };
      }
      return el;
    };
    const origSetInterval = window.setInterval;
    window.setInterval = function(cb, delay, ...args) {
      if (delay >= 950 && delay <= 1050) delay = 550;
      return origSetInterval(cb, delay, ...args);
    };
    window.open = () => null;
    try {
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    } catch (e) {}
  }

  // 3. Bloggerpemula's AdLinkFly form#go-link instant XHR POST bypass
  function tryGoLinkXHR() {
    const form = document.querySelector('form#go-link, form[action*="/links/go"]');
    if (!form || form.dataset.unshortSubmitted) return false;
    form.dataset.unshortSubmitted = '1';
    const action = form.getAttribute('action') || '/links/go';
    const body = new URLSearchParams(new FormData(form)).toString();
    fetch(action, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      },
      body,
      credentials: 'same-origin'
    })
      .then(r => r.json())
      .then(data => {
        if (data && data.url && /^https?:\/\//i.test(data.url)) {
          let finalUrl = data.url;
          if (/swiftcut\.xyz/i.test(finalUrl)) {
            finalUrl = finalUrl.replace(/[?&]i=[^&]*/g, '').replace(/\?&/, '?').replace(/&&/g, '&').replace(/[?&]$/, '');
          }
          window.location.replace(finalUrl);
        }
      })
      .catch(() => {});
    return true;
  }

  // 4. ArvindSaini978 Exe.io / Exeygo 3-Step Automation Engine
  document.addEventListener('DOMContentLoaded', () => {
    setInterval(() => {
      // Try AdLinkFly XHR POST first (skips countdown completely when allowed)
      tryGoLinkXHR();

      // Step 1: form#before-captcha
      const beforeCaptcha = document.getElementById('before-captcha');
      if (beforeCaptcha && !beforeCaptcha.dataset.triggered) {
        beforeCaptcha.dataset.triggered = 'true';
        HTMLFormElement.prototype.submit.call(beforeCaptcha);
        return;
      }

      // Step 2: form#link-view + Cloudflare Turnstile
      const captchaForm = document.getElementById('link-view');
      const cfToken = document.querySelector('[name="cf-turnstile-response"]');
      if (captchaForm && cfToken && cfToken.value && !captchaForm.dataset.triggered) {
        captchaForm.dataset.triggered = 'true';
        HTMLFormElement.prototype.submit.call(captchaForm);
        return;
      }

      // Step 3: Get Link anchor
      const anchors = Array.from(document.querySelectorAll('a, button'));
      for (const el of anchors) {
        const txt = (el.innerText || el.value || '').trim();
        if (/^get link$/i.test(txt)) {
          const href = el.getAttribute('href');
          if (href && /^https?:\/\//i.test(href) && !AD_PATTERN.test(href)) {
            window.location.replace(href);
            return;
          }
          el.click();
          return;
        }
      }
    }, 250);
  });
})();
