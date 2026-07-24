/*
 * Ollama plugin for AI Usage — real data via HTML scraping.
 *
 * ollama.com's cloud API has no documented endpoint for an account's own
 * usage, credits, or spending limits, and its responses carry no
 * rate-limit headers to read instead. There is a real number, though: the
 * account settings page (https://ollama.com/settings) renders "Session
 * usage" / "Weekly usage" percentages server-side. This plugin fetches
 * that page with a user-supplied session cookie (routed through the CORS
 * proxy, since ollama.com doesn't send CORS headers and browsers won't let
 * JS set a real Cookie header directly) and regex-parses the numbers out
 * of the HTML — the same technique CodexBar (a native Ollama usage
 * tracker) uses. This is unofficial screen-scraping of an authenticated
 * page, not a supported API: it can break silently if Ollama changes
 * their markup, and it requires the CORS proxy to be configured.
 */
(function () {
  'use strict';

  var SETTINGS_URL = 'https://ollama.com/settings';
  var PRIMARY_USAGE_LABELS = ['Session usage', 'Hourly usage'];
  var ALL_USAGE_LABELS = PRIMARY_USAGE_LABELS.concat(['Weekly usage']);
  var MAX_WINDOW = 4000;

  var DEFAULTS = {
    sessionCookie: '',
    snap: null // { fetchedAt, planName, accountEmail, sessionUsedPercent, weeklyUsedPercent, sessionResetsAt, weeklyResetsAt, error }
  };

  function now() { return Date.now(); }

  function loadState(ctx) {
    return Object.assign({}, DEFAULTS, ctx.store.load({}));
  }

  function clampPct(n) {
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  /* ---------- HTML parsing (mirrors CodexBar's OllamaUsageParser) ---------- */

  function firstCapture(text, pattern) {
    var m = text.match(pattern);
    return m ? m[1] : null;
  }

  function parsePlanName(html) {
    var raw = firstCapture(html, /Cloud Usage\s*<\/span>\s*<span[^>]*>([^<]+)<\/span>/);
    if (!raw) return null;
    var trimmed = raw.trim();
    return trimmed || null;
  }

  function parseAccountEmail(html) {
    var raw = firstCapture(html, /id="header-email"[^>]*>([^<]+)</);
    if (!raw) return null;
    var trimmed = raw.trim();
    return trimmed.indexOf('@') !== -1 ? trimmed : null;
  }

  function usageBlockWindow(label, tail) {
    var boundary = -1;
    ALL_USAGE_LABELS.forEach(function (other) {
      if (other === label) return;
      var idx = tail.indexOf(other);
      if (idx !== -1 && (boundary === -1 || idx < boundary)) boundary = idx;
    });
    var bounded = boundary !== -1 ? tail.slice(0, boundary) : tail.slice(0, MAX_WINDOW);
    return bounded.slice(0, MAX_WINDOW);
  }

  function parsePercent(text) {
    var raw = firstCapture(text, /([0-9]+(?:\.[0-9]+)?)\s*%\s*used/i);
    if (raw != null) return parseFloat(raw);
    raw = firstCapture(text, /width:\s*([0-9]+(?:\.[0-9]+)?)%/i);
    return raw != null ? parseFloat(raw) : null;
  }

  function parseISODate(text) {
    var raw = firstCapture(text, /data-time="([^"]+)"/);
    if (!raw) return null;
    var t = Date.parse(raw);
    return isNaN(t) ? null : new Date(t).toISOString();
  }

  function parseUsageBlockForLabel(label, html) {
    var idx = html.indexOf(label);
    if (idx === -1) return null;
    var tail = html.slice(idx + label.length);
    var window = usageBlockWindow(label, tail);
    var usedPercent = parsePercent(window);
    if (usedPercent == null) return null;
    return { usedPercent: usedPercent, resetsAt: parseISODate(window) };
  }

  function parseUsageBlock(labels, html) {
    for (var i = 0; i < labels.length; i++) {
      var parsed = parseUsageBlockForLabel(labels[i], html);
      if (parsed) return parsed;
    }
    return null;
  }

  function looksSignedOut(html) {
    var lower = html.toLowerCase();
    var hasSignInHeading = lower.indexOf('sign in to ollama') !== -1 || lower.indexOf('log in to ollama') !== -1;
    var hasAuthRoute = lower.indexOf('/api/auth/signin') !== -1 || lower.indexOf('/auth/signin') !== -1;
    var hasLoginRoute = lower.indexOf('action="/login"') !== -1 || lower.indexOf("action='/login'") !== -1 ||
      lower.indexOf('href="/login"') !== -1 || lower.indexOf("href='/login'") !== -1 ||
      lower.indexOf('action="/signin"') !== -1 || lower.indexOf("action='/signin'") !== -1 ||
      lower.indexOf('href="/signin"') !== -1 || lower.indexOf("href='/signin'") !== -1;
    var hasPasswordField = lower.indexOf('type="password"') !== -1 || lower.indexOf("type='password'") !== -1 ||
      lower.indexOf('name="password"') !== -1 || lower.indexOf("name='password'") !== -1;
    var hasEmailField = lower.indexOf('type="email"') !== -1 || lower.indexOf("type='email'") !== -1 ||
      lower.indexOf('name="email"') !== -1 || lower.indexOf("name='email'") !== -1;
    var hasAuthForm = lower.indexOf('<form') !== -1;
    var hasAuthEndpoint = hasAuthRoute || hasLoginRoute;

    if (hasSignInHeading && hasAuthForm && (hasEmailField || hasPasswordField || hasAuthEndpoint)) return true;
    if (hasAuthForm && hasAuthEndpoint) return true;
    if (hasAuthForm && hasPasswordField && hasEmailField) return true;
    return false;
  }

  function parseSnapshot(html) {
    var session = parseUsageBlock(PRIMARY_USAGE_LABELS, html);
    var weekly = parseUsageBlock(['Weekly usage'], html);
    if (!session && !weekly) {
      if (looksSignedOut(html)) throw new Error('Session cookie expired or not signed in — paste a fresh one');
      throw new Error('Could not find usage data in the page (Ollama may have changed their markup)');
    }
    return {
      fetchedAt: now(),
      planName: parsePlanName(html),
      accountEmail: parseAccountEmail(html),
      sessionUsedPercent: session ? session.usedPercent : null,
      weeklyUsedPercent: weekly ? weekly.usedPercent : null,
      sessionResetsAt: session ? session.resetsAt : null,
      weeklyResetsAt: weekly ? weekly.resetsAt : null,
      error: null
    };
  }

  /* ---------- Fetch ---------- */

  function refresh(ctx, plugin) {
    var state = loadState(ctx);
    if (!state.sessionCookie) {
      AIUsage.toast('Add your ollama.com session cookie in Settings first');
      return;
    }
    if (!AIUsage.corsProxy.getConfig().url) {
      AIUsage.toast('Set a CORS proxy in the app footer first — required for Ollama');
      return;
    }

    var statusEl = ctx.root.querySelector('[data-role="status"]');
    if (statusEl) statusEl.textContent = 'Refreshing…';

    fetch(AIUsage.corsProxy.wrap(SETTINGS_URL), Object.assign({
      method: 'GET',
      headers: Object.assign({
        'X-Cors-Proxy-Set-Cookie': state.sessionCookie,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }, AIUsage.corsProxy.headers())
    }, AIUsage.corsProxy.fetchOptions())).then(function (res) {
      return res.text().then(function (html) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var snap = parseSnapshot(html);
        var s = loadState(ctx);
        s.snap = snap;
        ctx.store.save(s);
        plugin.tick(ctx);
        AIUsage.toast('Usage updated');
      });
    }).catch(function (err) {
      var s = loadState(ctx);
      var msg = (err && err.message) || 'Request failed';
      if (err instanceof TypeError) msg = 'Blocked by the browser (CORS) or offline.';
      s.snap = Object.assign({ fetchedAt: null }, s.snap, { error: msg });
      ctx.store.save(s);
      plugin.tick(ctx);
    });
  }

  /* ---------- HTML ---------- */

  function meterHtml(id, name) {
    return (
      '<div class="meter" id="' + id + '">' +
        '<div class="meter__labels">' +
          '<span class="meter__name">' + name + '</span>' +
          '<span class="meter__value" data-role="value">—</span>' +
        '</div>' +
        '<div class="meter__bar"><div class="meter__fill" data-role="fill" style="width:0%"></div></div>' +
        '<div class="meter__reset" data-role="reset"></div>' +
      '</div>'
    );
  }

  function settingsHtml(state) {
    return (
      '<details class="plugin-settings">' +
        '<summary>Settings</summary>' +
        '<div class="field">' +
          '<label for="ollama-cookie">Session cookie</label>' +
          '<input id="ollama-cookie" type="password" placeholder="__Secure-next-auth.session-token=..." autocomplete="off">' +
        '</div>' +
        '<p class="plugin-note">Unofficial: this scrapes your signed-in <code>ollama.com/settings</code> page ' +
        'for the usage percentages shown there, since Ollama has no usage API. Sign in to ollama.com in a browser, ' +
        'open DevTools → Application/Storage → Cookies → ollama.com, and paste the full cookie header value ' +
        '(or just the session cookie, e.g. <code>__Secure-next-auth.session-token=&lt;value&gt;</code>). ' +
        'Requires a <a href="#" data-action="open-cors-proxy">CORS proxy</a> to be configured, since browsers ' +
        'won’t let a page set a real Cookie header and ollama.com doesn’t send CORS headers. ' +
        'The cookie is stored only on this device and only ever sent to your own proxy.</p>' +
        '<div class="controls">' +
          '<button type="button" class="btn btn--ghost" data-action="reset-all">Reset all data</button>' +
        '</div>' +
      '</details>'
    );
  }

  function rebuild(ctx, plugin) {
    var state = loadState(ctx);
    ctx.store.save(state);

    ctx.root.innerHTML =
      '<div class="plugin-card__header">' +
        '<div class="plugin-card__logo">◆</div>' +
        '<div>' +
          '<h2 class="plugin-card__title">Ollama</h2>' +
          '<p class="plugin-card__subtitle">' +
            (state.snap && state.snap.accountEmail ? state.snap.accountEmail : 'Cloud usage · scraped from account settings') +
          '</p>' +
        '</div>' +
      '</div>' +
      '<div id="ollama-meters"></div>' +
      '<div class="controls">' +
        '<button type="button" class="btn btn--primary" data-action="refresh">Refresh</button>' +
        '<button type="button" class="btn btn--ghost" data-action="share">Share stats</button>' +
      '</div>' +
      '<p class="plugin-note" data-role="status"></p>' +
      settingsHtml(state);

    var cookieInput = ctx.root.querySelector('#ollama-cookie');
    if (cookieInput) cookieInput.value = state.sessionCookie;

    plugin.tick(ctx);
  }

  function updateMeter(rootEl, percent, valueText, resetText) {
    if (!rootEl) return;
    var fill = rootEl.querySelector('[data-role="fill"]');
    fill.style.width = percent + '%';
    fill.className = 'meter__fill' +
      (percent >= 90 ? ' meter__fill--danger' : percent >= 70 ? ' meter__fill--warn' : '');
    rootEl.querySelector('[data-role="value"]').textContent = valueText;
    rootEl.querySelector('[data-role="reset"]').textContent = resetText;
  }

  function resetCountdown(resetsAt) {
    if (!resetsAt) return '';
    var left = Date.parse(resetsAt) - now();
    return left > 0
      ? 'Resets in ' + AIUsage.formatDuration(left)
      : 'Window has reset — refresh for current data';
  }

  function renderMeters(ctx, state) {
    var container = ctx.root.querySelector('#ollama-meters');
    if (!container) return;

    var snap = state.snap;
    var rows = [];
    if (snap) {
      if (typeof snap.sessionUsedPercent === 'number') rows.push({ id: 'ollama-session', name: 'Session usage', percent: snap.sessionUsedPercent, resetsAt: snap.sessionResetsAt });
      if (typeof snap.weeklyUsedPercent === 'number') rows.push({ id: 'ollama-weekly', name: 'Weekly usage', percent: snap.weeklyUsedPercent, resetsAt: snap.weeklyResetsAt });
    }

    if (rows.length === 0) {
      container.innerHTML = '<p class="empty-note">' + (state.sessionCookie
        ? 'No data yet — tap Refresh to fetch your Ollama usage.'
        : 'Add your session cookie in Settings, then tap Refresh.') + '</p>';
      return;
    }

    container.innerHTML = rows.map(function (r) { return meterHtml(r.id, r.name); }).join('');
    rows.forEach(function (r) {
      var p = clampPct(r.percent);
      updateMeter(ctx.root.querySelector('#' + r.id), p, p + '% used', resetCountdown(r.resetsAt));
    });
  }

  function summaryText(state) {
    var lines = ['Ollama usage'];
    if (state.snap) {
      if (state.snap.planName) lines.push('Plan: ' + state.snap.planName);
      if (typeof state.snap.sessionUsedPercent === 'number') lines.push('Session usage: ' + clampPct(state.snap.sessionUsedPercent) + '%');
      if (typeof state.snap.weeklyUsedPercent === 'number') lines.push('Weekly usage: ' + clampPct(state.snap.weeklyUsedPercent) + '%');
    }
    return lines.join('\n');
  }

  /* ---------- Plugin ---------- */

  AIUsage.registerPlugin({
    id: 'ollama',
    name: 'Ollama',

    render: function (ctx) {
      var self = this;

      ctx.root.addEventListener('click', function (e) {
        var action = e.target.getAttribute('data-action');
        if (!action) return;

        if (action === 'refresh') { refresh(ctx, self); return; }
        if (action === 'share') { AIUsage.share(summaryText(loadState(ctx))); return; }
        if (action === 'open-cors-proxy') {
          e.preventDefault();
          var toggle = document.getElementById('cors-proxy-toggle');
          if (toggle) toggle.click();
          return;
        }
        if (action === 'reset-all') {
          if (!confirm('Clear all Ollama data (including the stored session cookie)?')) return;
          ctx.store.save(Object.assign({}, DEFAULTS));
          rebuild(ctx, self);
        }
      });

      ctx.root.addEventListener('change', function (e) {
        if (e.target.id !== 'ollama-cookie') return;
        var s = loadState(ctx);
        s.sessionCookie = e.target.value.trim();
        ctx.store.save(s);
        self.tick(ctx);
      });

      rebuild(ctx, this);
    },

    handleAction: function (ctx, action) {
      if (action === 'refresh') refresh(ctx, this);
    },

    tick: function (ctx) {
      var state = loadState(ctx);
      renderMeters(ctx, state);

      var statusEl = ctx.root.querySelector('[data-role="status"]');
      if (!statusEl) return;
      if (state.snap && state.snap.error) {
        statusEl.textContent = 'Error: ' + state.snap.error;
        statusEl.className = 'plugin-note plugin-note--error';
      } else if (state.snap && state.snap.fetchedAt) {
        statusEl.textContent = 'Updated ' + new Date(state.snap.fetchedAt).toLocaleTimeString();
        statusEl.className = 'plugin-note';
      } else {
        statusEl.textContent = '';
      }
    }
  });
})();
