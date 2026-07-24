/*
 * ChatGPT plugin for AI Usage — real data from your ChatGPT/Codex account.
 *
 * Uses the same endpoint as the Codex CLI's usage display
 * (GET https://chatgpt.com/backend-api/wham/usage) with the OAuth access
 * token Codex stores after `codex login` (in ~/.codex/auth.json). Returns
 * real 5-hour-session and weekly rate-limit utilization with reset times,
 * plus plan type. This is the same technique the CodexBar menu-bar app
 * uses for its Codex/ChatGPT provider.
 *
 * chatgpt.com's CORS policy on this endpoint allowlists only its own
 * first-party origins (chatgpt.com, chat.openai.com), so a direct browser
 * fetch from any other origin is always blocked. This needs the CORS proxy
 * configured — but note it must NOT be hosted on Cloudflare Workers:
 * chatgpt.com's edge fingerprints and blocks Cloudflare Workers' egress IPs
 * as VPN/datacenter traffic (a generic block page, unrelated to CORS or
 * auth), unlike Anthropic's endpoint which Cloudflare Workers reach fine.
 *
 * Credentials and snapshots are stored only on this device (localStorage).
 */
(function () {
  'use strict';

  var USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

  var WINDOW_LABELS = {
    session: '5-hour session',
    weekly: 'Weekly'
  };

  var DEFAULTS = {
    accessToken: '',
    accountId: '',
    snap: null // { fetchedAt, planType, windows: {session:{usedPercent,resetsAt}, weekly:{...}}, error }
  };

  function now() { return Date.now(); }

  function loadState(ctx) {
    return Object.assign({}, DEFAULTS, ctx.store.load({}));
  }

  function clampPct(n) {
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  /* ---------- Response parsing ---------- */

  /* Classify a rate-limit window by its length: Codex's primary/secondary
   * windows aren't consistently ordered session-then-weekly, so classify by
   * limit_window_seconds the same way CodexBar's CodexRateWindowNormalizer
   * does (300 min = 5h session, 10080 min = 7-day weekly). */
  function windowRole(w) {
    if (!w || typeof w.limit_window_seconds !== 'number') return 'unknown';
    var minutes = Math.round(w.limit_window_seconds / 60);
    if (minutes === 300) return 'session';
    if (minutes === 10080) return 'weekly';
    return 'unknown';
  }

  function toWindow(w) {
    if (!w || typeof w.used_percent !== 'number') return null;
    return {
      usedPercent: w.used_percent,
      resetsAt: typeof w.reset_at === 'number' && w.reset_at > 0
        ? new Date(w.reset_at * 1000).toISOString()
        : null
    };
  }

  function parseUsageBody(body) {
    var windows = {};
    var rateLimit = body && body.rate_limit;
    if (rateLimit) {
      var primary = rateLimit.primary_window;
      var secondary = rateLimit.secondary_window;
      var primaryRole = windowRole(primary);
      var secondaryRole = windowRole(secondary);

      var session = null, weekly = null;
      if (primaryRole === 'weekly') weekly = primary;
      else if (primaryRole === 'session' || primaryRole === 'unknown') session = primary;
      if (secondaryRole === 'weekly') weekly = weekly || secondary;
      else if (secondaryRole === 'session') session = session || secondary;
      else if (secondaryRole === 'unknown' && !session) session = secondary;

      var sessionWindow = toWindow(session);
      var weeklyWindow = toWindow(weekly);
      if (sessionWindow) windows.session = sessionWindow;
      if (weeklyWindow) windows.weekly = weeklyWindow;
    }
    return windows;
  }

  /* ---------- Fetch ---------- */

  function refresh(ctx, plugin) {
    var state = loadState(ctx);
    if (!state.accessToken) {
      AIUsage.toast('Add an access token in Settings first');
      return;
    }
    if (!AIUsage.corsProxy.getConfig().url) {
      AIUsage.toast('Set a CORS proxy in the app footer first — required for ChatGPT');
      return;
    }

    var statusEl = ctx.root.querySelector('[data-role="status"]');
    if (statusEl) statusEl.textContent = 'Refreshing…';

    var headers = Object.assign({
      'Authorization': 'Bearer ' + state.accessToken,
      'Accept': 'application/json'
    }, AIUsage.corsProxy.headers());
    if (state.accountId) headers['ChatGPT-Account-Id'] = state.accountId;

    fetch(AIUsage.corsProxy.wrap(USAGE_URL), Object.assign({
      method: 'GET',
      headers: headers
    }, AIUsage.corsProxy.fetchOptions())).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var msg = (res.status === 401 || res.status === 403)
            ? 'Token invalid or expired — run `codex login` again and copy the fresh access_token'
            : (body.error && body.error.message) || ('HTTP ' + res.status);
          throw new Error(msg);
        }
        var s = loadState(ctx);
        s.snap = {
          fetchedAt: now(),
          planType: body.plan_type || null,
          windows: parseUsageBody(body),
          error: null
        };
        ctx.store.save(s);
        plugin.tick(ctx);
        AIUsage.toast(Object.keys(s.snap.windows).length
          ? 'Usage updated'
          : 'No usage windows found in the data');
      });
    }).catch(function (err) {
      var s = loadState(ctx);
      var msg = (err && err.message) || 'Request failed';
      if (err instanceof TypeError) msg = 'Blocked by the browser (CORS) or offline.';
      s.snap = Object.assign({ fetchedAt: null, windows: {} }, s.snap, { error: msg });
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
          '<label for="chatgpt-token">Access token</label>' +
          '<input id="chatgpt-token" type="password" placeholder="eyJhbGciOi..." autocomplete="off">' +
        '</div>' +
        '<div class="field">' +
          '<label for="chatgpt-account">Account ID</label>' +
          '<input id="chatgpt-account" type="text" placeholder="optional" autocomplete="off">' +
        '</div>' +
        '<p class="plugin-note">Run <code>codex login</code> in a terminal, then open ' +
        '<code>~/.codex/auth.json</code> and copy <code>tokens.access_token</code> (and, if you use ' +
        'multiple ChatGPT accounts, <code>tokens.account_id</code>). Both are stored only on this device. ' +
        'chatgpt.com blocks direct browser calls (CORS) — set a <a href="#" data-action="open-cors-proxy">CORS proxy</a> ' +
        'in the app footer to route around the block. It must not be hosted on Cloudflare Workers: ' +
        'chatgpt.com blocks Cloudflare’s egress IPs outright (a generic VPN/datacenter block), so the ' +
        'proxy needs to run somewhere else (a small VPS, a home server, etc).</p>' +
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
        '<div class="plugin-card__logo">✦</div>' +
        '<div>' +
          '<h2 class="plugin-card__title">ChatGPT</h2>' +
          '<p class="plugin-card__subtitle">' +
            (state.snap && state.snap.planType ? state.snap.planType + ' plan · live data' : 'Subscription · live data from OpenAI') +
          '</p>' +
        '</div>' +
      '</div>' +
      '<div id="chatgpt-meters"></div>' +
      '<div class="controls">' +
        '<button type="button" class="btn btn--primary" data-action="refresh">Refresh</button>' +
        '<button type="button" class="btn btn--ghost" data-action="share">Share stats</button>' +
      '</div>' +
      '<p class="plugin-note" data-role="status"></p>' +
      settingsHtml(state);

    var tokenInput = ctx.root.querySelector('#chatgpt-token');
    if (tokenInput) tokenInput.value = state.accessToken;
    var accountInput = ctx.root.querySelector('#chatgpt-account');
    if (accountInput) accountInput.value = state.accountId;

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

  function emptyNote(state) {
    return state.accessToken
      ? 'No data yet — tap Refresh to fetch your ChatGPT usage.'
      : 'Add your access token in Settings, then tap Refresh.';
  }

  function resetCountdown(resetsAt) {
    if (!resetsAt) return '';
    var left = Date.parse(resetsAt) - now();
    return left > 0
      ? 'Resets in ' + AIUsage.formatDuration(left)
      : 'Window has reset — refresh for current data';
  }

  function renderMeters(ctx, state) {
    var container = ctx.root.querySelector('#chatgpt-meters');
    if (!container) return;

    var keys = state.snap && state.snap.windows ? Object.keys(state.snap.windows) : [];
    if (keys.length === 0) {
      container.innerHTML = '<p class="empty-note">' + emptyNote(state) + '</p>';
      return;
    }
    container.innerHTML = keys.map(function (k, i) {
      return meterHtml('chatgpt-w-' + i, WINDOW_LABELS[k] || k);
    }).join('');
    keys.forEach(function (k, i) {
      var w = state.snap.windows[k];
      var p = clampPct(w.usedPercent);
      updateMeter(ctx.root.querySelector('#chatgpt-w-' + i),
        p, p + '% used', resetCountdown(w.resetsAt));
    });
  }

  function summaryText(state) {
    var lines = ['ChatGPT usage'];
    if (state.snap) {
      if (state.snap.planType) lines.push('Plan: ' + state.snap.planType);
      if (state.snap.windows) {
        Object.keys(state.snap.windows).forEach(function (k) {
          lines.push((WINDOW_LABELS[k] || k) + ': ' + clampPct(state.snap.windows[k].usedPercent) + '%');
        });
      }
    }
    return lines.join('\n');
  }

  /* ---------- Plugin ---------- */

  AIUsage.registerPlugin({
    id: 'chatgpt',
    name: 'ChatGPT',

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
          if (!confirm('Clear all ChatGPT data (including the stored access token)?')) return;
          ctx.store.save(Object.assign({}, DEFAULTS));
          rebuild(ctx, self);
        }
      });

      ctx.root.addEventListener('change', function (e) {
        var s = loadState(ctx);
        switch (e.target.id) {
          case 'chatgpt-token':
            s.accessToken = e.target.value.trim();
            break;
          case 'chatgpt-account':
            s.accountId = e.target.value.trim();
            break;
          default:
            return;
        }
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
