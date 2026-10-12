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
