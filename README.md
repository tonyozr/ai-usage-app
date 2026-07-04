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

Uses the same endpoint as Claude Code's `/usage` command (`GET /api/oauth/usage`) and shows your real **5-hour session** and **weekly** utilization with reset countdowns. Get an OAuth token by running `claude setup-token` in a terminal (requires a Pro/Max subscription).

Anthropic's usage endpoint does not send CORS headers, so a direct browser call from *Refresh* is usually blocked — the button tries anyway, and will simply start working on its own if Anthropic ever adds CORS support there.

#### API key

Paste an Anthropic API key and tap *Refresh*: the app calls `POST /v1/messages/count_tokens` (free, no tokens billed) directly from the browser — officially supported via the `anthropic-dangerous-direct-browser-access` header — and reads your account's real rate limits from the `anthropic-ratelimit-*` response headers: requests/min and tokens/min with used, limit, and reset countdown. Prefer a key from a restricted workspace; it is sent only to `api.anthropic.com`.

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

Add the script to `APP_SHELL` in `sw.js` (and bump `CACHE_NAME`) so it is cached for offline use.

## License

MIT — see [LICENSE](LICENSE).
