# 🔗 UnShort

**Reveal the real link behind any short URL — fast, free, no signup, built for developers.**

Paste a short link (`bit.ly`, `tinyurl`, `t.co`, `is.gd`, ad-gate shorteners, nested chains…) and UnShort follows the redirect chain **server-side** — your browser never touches the shortener — then shows you:

- ✅ The **final real destination URL**
- 🧭 The **full hop-by-hop redirect chain** with HTTP status codes and timing
- 🔒 Whether the destination uses HTTPS
- 📄 The destination page title
- ⚡ Detection of HTML `<meta http-equiv="refresh">` redirects (used by sneaky shorteners that don't send HTTP 3xx)

Zero dependencies. Pure Node.js. No database, no logs, no ads.

## Deploy on Render (Free Tier)

This repo includes `package.json` and `render.yaml` so you can host it publicly on [Render](https://render.com) in 60 seconds:

1. Go to **Render Dashboard → New → Web Service** (or **Blueprint**) and connect `harshi79/YORI-K`.
2. Settings (auto-detected from `render.yaml` / `package.json`):
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/api/health`
3. Once live at `https://your-app.onrender.com`, anyone can bypass links in 3 ways:
   - **Web UI**: Paste any link at `https://your-app.onrender.com`
   - **URL-bar shortcut** (like `bypass.city`): prepend your site to any shortlink — `https://your-app.onrender.com/https://exe.io/abc123`
   - **Browser Userscript** (for Cloudflare Turnstile walls): click **Install Companion Userscript** (`/unshort-bypass.user.js`)

## Run locally

```bash
npm start
# → UnShort listening on http://0.0.0.0:3000
```

Requires Node.js ≥ 18 (uses built-in `fetch`). Zero npm dependencies.

## Developer API

Free JSON API, CORS enabled, no key needed:

```bash
curl "http://localhost:3000/api/expand?url=https://bit.ly/abc123"
```

```json
{
  "ok": true,
  "finalUrl": "https://the-real-site.com/page",
  "finalHost": "the-real-site.com",
  "https": true,
  "redirects": 2,
  "hops": 3,
  "chain": [
    { "url": "https://bit.ly/abc123", "status": 301, "ms": 142, "type": "http-redirect", "next": "…" },
    { "url": "https://t.co/xyz",      "status": 301, "ms": 98,  "type": "http-redirect", "next": "…" },
    { "url": "https://the-real-site.com/page", "status": 200, "ms": 210, "type": "final" }
  ]
}
```

Get just the final URL in one line:

```bash
curl -s "http://localhost:3000/api/expand?url=$LINK" | jq -r .finalUrl
```

| Parameter | Default | Description |
|---|---|---|
| `url` | *(required)* | The short link to expand |
| `max` | `15` | Max redirect hops to follow (cap 30) |

Health check: `GET /api/health`

## Safety

- Blocks requests to private/internal hosts (localhost, `10.x`, `192.168.x`, `172.16-31.x`, …) — basic SSRF protection
- Detects redirect loops
- 8-second timeout per hop
- Only reads the first 32 KB of HTML (just enough to detect meta-refresh) — never downloads files
