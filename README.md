# AI Usage

A tiny installable web app (PWA) for monitoring your AI assistant usage limits. Built for iOS home-screen installation, but works in any modern browser.

**100% static** — no build step, no server, no external requests. All data stays on your device in `localStorage`. Host it anywhere that serves files, e.g. GitHub Pages.

## Features

- **Installable** — add to home screen on iOS, full-screen standalone mode; shows an install hint when opened in the browser
- **Offline-first** — service worker precaches the app shell; works with no network
- **Own icon & splash screens** — light and dark splash variants for current iPhones
- **Light / dark theme** — follows the system by default, tap ◐ to override
- **Icon badge support** (iOS 16.4+) — plugins can show a number on the home-screen icon via the optional `badgeCount` hook
- **Share** — share your usage summary via the native share sheet
- **Plugin architecture** — each AI service is a self-contained plugin

## Plugins

### Claude

Shows **real data from your account**. Two account types, switchable in the card's settings; credentials live only in this device's `localStorage`, and the last snapshot is cached for offline viewing.

#### Subscription (Pro/Max) — default

Uses the same endpoint as Claude Code's `/usage` command (`GET /api/oauth/usage`) and shows your real **5-hour session** and **weekly** utilization with reset countdowns.

Don't use `claude setup-token` — it issues a token scoped to `user:inference` only, and this endpoint requires `user:profile` too, so it fails with an auth error. Instead, run `claude login` (a full interactive login, requires a Pro/Max subscription), then open `~/.claude/.credentials.json` and copy `claudeAiOauth.accessToken`. That token expires every few hours; Claude Code refreshes it automatically in that file whenever you use `claude`, so just re-copy the current value if Refresh starts failing.

Anthropic's usage endpoint also actively rejects browser calls: it 401s on any request carrying an `Origin` header at all (not just a CORS-headers omission), so a direct browser call from *Refresh* will always fail. Set a [CORS proxy](#cors-proxy-optional) to route around it — the proxy Worker rewrites the `Origin` header to the target's own origin before forwarding, which satisfies this check.

#### API key

Paste an Anthropic API key and tap *Refresh*: the app calls `POST /v1/messages/count_tokens` (free, no tokens billed) directly from the browser — officially supported via the `anthropic-dangerous-direct-browser-access` header — and reads your account's real rate limits from the `anthropic-ratelimit-*` response headers: requests/min and tokens/min with used, limit, and reset countdown. Prefer a key from a restricted workspace; it is sent only to `api.anthropic.com`.

### Google / Gemini

Shows **real data from your Google / Gemini account**. Two data sources, switchable in Settings; credentials live only in this device's `localStorage`.

#### Account / OAuth (Gemini CLI / Code Assist) — default

Uses Google's internal Cloud Code quota endpoints (`POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` or `retrieveUserQuota`, plus `fetchAvailableModels`) to fetch real quota utilization percentages and reset countdowns for Gemini models.

Sign in to the Gemini CLI with **OAuth** (not an API key — `gemini` prompts for this on first run, or run `/auth` inside it to switch), then copy the `access_token` field from `~/.gemini/oauth_creds.json` or `~/.config/gemini/oauth_creds.json` (access tokens expire after ~1 hour, so you'll need to re-copy periodically). Optionally set a GCP Project ID if required by your GCP organization.

**`gcloud auth print-access-token` will not work here** — this internal endpoint only accepts tokens minted by the Gemini CLI's own OAuth client and rejects tokens from gcloud's client with a 401, even though they're otherwise valid. If your `~/.gemini/settings.json` has `"selectedType": "gemini-api-key"` instead of an OAuth type, or `~/.gemini/google_accounts.json` has no `active` account, there's no OAuth token to copy yet — complete the CLI's OAuth login first.

#### API key (Google AI Studio)

Paste a Google Gemini API key (`AIzaSy...`) from [Google AI Studio](https://aistudio.google.com/). Calls `GET https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY` to verify the key and show how many models it can access. The public Gemini API exposes no per-key usage data, so this mode shows no meters.

### ChatGPT

Shows **real data from your ChatGPT/Codex account** — the same endpoint the Codex CLI uses for its own usage display (`GET https://chatgpt.com/backend-api/wham/usage`), with **5-hour session** and **weekly** rate-limit utilization, reset countdowns, and plan type (the same technique [CodexBar](https://github.com/steipete/CodexBar) uses for its Codex provider).

Get an access token by running `codex login` in a terminal, then opening `~/.codex/auth.json` and copying `tokens.access_token` (and `tokens.account_id`, if you use multiple ChatGPT accounts — sent as the `ChatGPT-Account-Id` header). Both are stored only on this device.

chatgpt.com's CORS policy on this endpoint is an explicit allowlist of its own first-party origins (`chatgpt.com`, `chat.openai.com`) — it never sends `Access-Control-Allow-Origin` for any other origin, so a direct browser call from this app is always blocked, regardless of headers. A [CORS proxy](#cors-proxy-optional) is required, **but it must not be hosted on Cloudflare Workers**: chatgpt.com's edge fingerprints and blocks Cloudflare Workers' egress IPs as VPN/datacenter traffic (a generic `"Unable to load site"` block page, unrelated to CORS or auth) before the request even reaches this endpoint. The [Claude CORS proxy](#cors-proxy-optional) setup works fine on Cloudflare Workers since Anthropic doesn't block that IP range — but for ChatGPT you'll need the same proxy code running somewhere else (a small VPS, a home server, or another provider not on Cloudflare's network).

### GitHub Copilot

Shows **real data**, via GitHub's OAuth Device Flow plus the same internal endpoint VS Code's Copilot Chat extension reads from (`GET https://api.github.com/copilot_internal/user`) — the same technique [CodexBar](https://github.com/steipete/CodexBar) uses for its Copilot provider. There's no documented per-user quota API, but this undocumented one works and returns real premium-request/chat quota percentages and reset dates.

Tap **Sign in with GitHub** in Settings: it runs the same OAuth Device Flow VS Code itself uses (via VS Code's public client ID, no client secret), shows you a code to enter at github.com, and stores the resulting token once you authorize it. This needs a [CORS proxy](#cors-proxy-optional) configured for both steps: sign-in, since GitHub's device-flow endpoints (`github.com/login/device/code`, `github.com/login/oauth/access_token`) send no CORS headers at all; and refreshes, since although `api.github.com/copilot_internal/user` does send `Access-Control-Allow-Origin: *`, its preflight response uses a fixed header allowlist that excludes the `Editor-Version`/`Editor-Plugin-Version` headers the endpoint needs — so a direct browser call still fails.

### Ollama

Shows **real data**, scraped from your signed-in `https://ollama.com/settings` page — ollama.com's cloud API has no documented usage endpoint, so this is the only way to get real numbers (the same technique the [CodexBar](https://github.com/steipete/CodexBar) menu-bar app uses).

Paste your ollama.com session cookie in Settings (DevTools → Application/Storage → Cookies → `ollama.com`, copy the session cookie's value or the whole `Cookie` header). Requires the [CORS proxy](#cors-proxy-optional) to be configured: browsers refuse to let a page set a real `Cookie` request header, so the cookie is sent under a custom header (`X-Cors-Proxy-Set-Cookie`) that your Worker translates to a real `Cookie` header before forwarding to ollama.com.

This is unofficial screen-scraping of an authenticated page, not a supported API — it can break silently if Ollama changes their markup, and it needs a real, live session cookie (more sensitive than a scoped API key). The cookie is stored only in this device's `localStorage` and is only ever sent to your own configured proxy.

### Grok

Shows **real data**, via grok.com's internal billing RPC (`POST grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig`) — there's no documented usage API, but this undocumented gRPC-Web endpoint is what the account settings page itself calls, and it works (the same technique [CodexBar](https://github.com/steipete/CodexBar)'s web-billing fallback uses).

Authenticate with either your grok.com session cookie (sign in to grok.com in a browser, DevTools → Application/Storage → Cookies → `grok.com`, copy the `sso` or `sso-rw` cookie value) or the access token `grok login` stores in `~/.grok/auth.json` (the `key` field) — either works, and both can be set at once. Requires the [CORS proxy](#cors-proxy-optional): grok.com sends no CORS headers, and the cookie is forwarded the same way as Ollama's, under the `X-Cors-Proxy-Set-Cookie` header.

The response is raw gRPC-Web: length-prefixed protobuf frames with a trailing status frame. This app hand-parses just enough of that wire format (varint/fixed32 field scanning, no protobuf library) to pull out the usage percent and reset time, mirroring CodexBar's field-shape heuristics. Unofficial and undocumented — it can break if xAI changes the response shape.

### JetBrains AI

Shows **real data**, but unlike every other plugin here it's not from a network endpoint at all — JetBrains AI Assistant has no usage API, only a local file the IDE itself writes: `AIAssistantQuotaManager2.xml`, under your JetBrains IDE's `options` folder (e.g. on macOS, `~/Library/Application Support/JetBrains/<IDE><version>/options/`; on Windows, `%APPDATA%\JetBrains\<IDE><version>\options\`).

Tap **Refresh** and pick that file with the browser's native file picker — it's parsed entirely on this device with the browser's built-in `DOMParser`, nothing is uploaded, and no CORS proxy or credentials are involved. Since a web page can't watch a local file for changes, there's no auto-refresh: pick the file again whenever you want current numbers (the same technique CodexBar's JetBrains provider parses, just read manually instead of by a background process).

## CORS proxy (optional)

Some endpoints — notably Claude's subscription usage endpoint — don't send CORS headers, so the browser blocks a direct fetch. The **CORS proxy** button in the footer lets you point the app at your own [Cloudflare CORS Header Proxy Worker](https://developers.cloudflare.com/workers/examples/cors-header-proxy/): once a proxy URL is set, blocked requests are sent to `<proxy URL>?apiurl=<encoded target>` instead of the target directly, and the Worker adds the CORS headers on the way back.

- **Proxy URL** — your deployed Worker's URL, including whatever path it routes on (Cloudflare's example uses `/corsproxy/`, so e.g. `https://proxy.example.workers.dev/corsproxy/` — trailing slash matters, the app doesn't normalize it).

Protect the Worker with a **shared secret checked by the Worker itself**, not Cloudflare Access. Access sits in front of the Worker and rejects unauthorized requests at Cloudflare's edge before the Worker ever runs — which sounds ideal, but it also means it rejects every CORS preflight (`OPTIONS`), since browsers never send credentials on a preflight by spec. Carving out an OPTIONS exception normally means either an Access policy condition on HTTP method (not available in every account) or a zone-level WAF "skip Access" rule — but that requires your own domain as a Cloudflare zone, which a bare `<name>.workers.dev` Worker doesn't have. So instead:

1. Set a secret on the Worker: `wrangler secret put PROXY_TOKEN` (any random string).
2. Paste the same value into the **Proxy token** field in the app.

The app sends it as an `X-Proxy-Token` header on every proxied request, which the Worker checks itself — see [cors-header-proxy](https://github.com/tonyozr/cors-header-proxy)'s `isAuthorized()`. The Worker always answers `OPTIONS` without checking the token (a preflight carries no sensitive data anyway), so there's nothing left for a preflight to fail on. If you'd previously set up Cloudflare Access in front of this Worker, remove that Application in the Zero Trust dashboard — it would otherwise still block `OPTIONS` regardless of the token.

Both fields are stored only in this device's `localStorage` (`aiusage.corsProxy`), same as everything else. Leave the URL blank to disable the proxy — requests go directly to the target, as before.

## Export / import config

**Export config** and **Import config** in the footer back up (or transfer to another device) everything the app keeps in `localStorage` — theme, CORS proxy URL, and every plugin's saved state, including any tokens, keys, or cookies you've pasted in. Export downloads a plain JSON file named `ai-usage-config-<timestamp>.json`; Import reads one back in, after confirming, and reloads the page.

The file is **not encrypted** — it's exactly as sensitive as the credentials you've entered into the app (Claude/ChatGPT/Copilot tokens, Ollama session cookie), in plain text. Treat it like a password export: don't store it somewhere shared, and delete it once you're done with it.

## Hosting on GitHub Pages

1. Push this repository to GitHub.
2. In the repo: **Settings → Pages → Source: Deploy from a branch**, pick `main` / `/ (root)`.
3. Open `https://<user>.github.io/<repo>/` on your iPhone in Safari.
4. Share → **Add to Home Screen**.

All paths are relative, so the app works from a subpath out of the box.

## Local development

Any static file server works, e.g.:

```sh
python -m http.server 8080
# or
npx serve .
```

Service workers require `localhost` or HTTPS.

## Writing a plugin

Create `js/plugins/<name>.js`, include it in `index.html` before `AIUsage.start()`, and register:

```js
AIUsage.registerPlugin({
  id: 'myservice',
  name: 'My Service',
  render(ctx) {
    // ctx.root  — the plugin's card element
    // ctx.store — namespaced localStorage: load(fallback) / save(data) / clear()
    ctx.root.innerHTML = '...';
  },
  tick(ctx) {
    // called every 30s and when the app returns to the foreground
  },
  handleAction(ctx, action, params) {
    // optional: invoked for launch URLs like ?action=...&plugin=myservice
  },
  badgeCount(ctx) {
    // optional: number shown on the app icon (summed across plugins)
    return 0;
  }
});
```

Core helpers available to plugins: `AIUsage.formatDuration(ms)`, `AIUsage.toast(message)`, `AIUsage.share(text)`.

For a request that might be CORS-blocked, route it through the user's optional [CORS proxy](#cors-proxy-optional):

```js
fetch(AIUsage.corsProxy.wrap(targetUrl), Object.assign({
  method: 'GET',
  headers: { /* ... */ }
}, AIUsage.corsProxy.fetchOptions()))
```

`wrap()` returns `targetUrl` unchanged when no proxy is configured, so this is safe to use unconditionally.

Add the script to `APP_SHELL` in `sw.js` (and bump `CACHE_NAME`) so it is cached for offline use.

## License

MIT — see [LICENSE](LICENSE).
