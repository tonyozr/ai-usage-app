/*
 * Claude plugin for AI Usage — real account data, fully local.
 *
 * Two data sources:
 *
 *  - "subscription" (default): your claude.ai Pro/Max account, via the same
 *    endpoint as Claude Code's /usage command (GET /api/oauth/usage) with an
 *    OAuth token (sk-ant-oat..., from `claude setup-token`). It returns real
 *    5-hour-session and weekly utilization percentages with reset times.
 *    Anthropic's usage endpoint does not send CORS headers, so a direct
 *    browser fetch is usually blocked — Refresh tries it anyway in case
 *    that ever changes.
 *
 *  - "api": an Anthropic API key. Makes a free /v1/messages/count_tokens
 *    request (officially browser-supported via the
 *    `anthropic-dangerous-direct-browser-access` header) and reads real
 *    rate limits from the `anthropic-ratelimit-*` response headers.
 *
 * Credentials and snapshots are stored only on this device (localStorage).
 */
(function () {
  'use strict';

  var ANTHROPIC_BASE = 'https://api.anthropic.com';
  var COUNT_TOKENS_PATH = '/v1/messages/count_tokens';
  var OAUTH_USAGE_PATH = '/api/oauth/usage';
  var API_MODEL = 'claude-opus-4-8';

  var RATE_METRIC_LABELS = {
    'requests': 'Requests / min',
    'input-tokens': 'Input tokens / min',
    'output-tokens': 'Output tokens / min',
    'tokens': 'Tokens / min'
  };
  var RATE_METRIC_ORDER = ['requests', 'input-tokens', 'output-tokens', 'tokens'];

  var WINDOW_LABELS = {
    'five_hour': '5-hour session',
    'seven_day': 'Weekly (all models)',
    'seven_day_opus': 'Weekly (Opus)',
    'seven_day_sonnet': 'Weekly (Sonnet)',
    'seven_day_oauth_apps': 'Weekly (connected apps)'
  };

  var DEFAULTS = {
    source: 'subscription',   // 'subscription' | 'api'
    oauthToken: '',
    sub: null,                // { fetchedAt, windows: {key: {utilization, resetsAt}}, error }
    apiKey: '',
    api: null                 // { fetchedAt, metrics: {name: {limit, remaining, reset}}, error }
  };

  function now() { return Date.now(); }

  function loadState(ctx) {
    return Object.assign({}, DEFAULTS, ctx.store.load({}));
  }

  function clampPct(n) {
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function windowLabel(key) {
    return WINDOW_LABELS[key] || key.replace(/_/g, ' ');
  }

  /* ---------- Subscription source ---------- */

  /* Extract usage windows from an /api/oauth/usage response body.
   * Defensive: any top-level object with a numeric utilization counts. */
  function parseUsageBody(body) {
    var windows = {};
    if (body && typeof body === 'object') {
      Object.keys(body).forEach(function (key) {
        var w = body[key];
        if (w && typeof w === 'object' && typeof w.utilization === 'number') {
          windows[key] = {
            utilization: w.utilization,
            resetsAt: w.resets_at || null
          };
        }
      });
    }
    return windows;
  }

  function saveSubscriptionSnapshot(ctx, plugin, windows) {
    var s = loadState(ctx);
    s.sub = { fetchedAt: now(), windows: windows, error: null };
    ctx.store.save(s);
    plugin.tick(ctx);
    AIUsage.toast(Object.keys(windows).length
      ? 'Usage updated'
      : 'No usage windows found in the data');
  }

  function fetchSubscriptionUsage(ctx, plugin) {
    var state = loadState(ctx);
    if (!state.oauthToken) {
      AIUsage.toast('Add an OAuth token in Settings first');
      return;
    }

    var statusEl = ctx.root.querySelector('[data-role="status"]');
    if (statusEl) statusEl.textContent = 'Refreshing…';

    fetch(ANTHROPIC_BASE + OAUTH_USAGE_PATH, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + state.oauthToken,
        'anthropic-beta': 'oauth-2025-04-20'
      }
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var msg = res.status === 401
            ? 'Token invalid or expired — run `claude setup-token` again'
            : (body.error && body.error.message) || ('HTTP ' + res.status);
          throw new Error(msg);
        }
        saveSubscriptionSnapshot(ctx, plugin, parseUsageBody(body));
      });
    }).catch(function (err) {
      var s = loadState(ctx);
      var msg = (err && err.message) || 'Request failed';
      // fetch() rejects with a TypeError on CORS blocks and network failures.
      if (err instanceof TypeError) {
        msg = 'Blocked by the browser (CORS) or offline.';
      }
      s.sub = Object.assign({ fetchedAt: null, windows: {} }, s.sub, { error: msg });
      ctx.store.save(s);
      plugin.tick(ctx);
    });
  }

  /* ---------- API-key source (rate-limit headers) ---------- */

  function fetchApiUsage(ctx, plugin) {
    var state = loadState(ctx);
    if (!state.apiKey) {
      AIUsage.toast('Add an API key in Settings first');
      return;
    }

    var statusEl = ctx.root.querySelector('[data-role="status"]');
    if (statusEl) statusEl.textContent = 'Refreshing…';

    fetch(ANTHROPIC_BASE + COUNT_TOKENS_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': state.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: API_MODEL,
        messages: [{ role: 'user', content: 'ping' }]
      })
    }).then(function (res) {
      var metrics = {};
      res.headers.forEach(function (value, name) {
        var m = name.match(/^anthropic-ratelimit-(.+)-(limit|remaining|reset)$/);
        if (m) {
          if (!metrics[m[1]]) metrics[m[1]] = {};
          metrics[m[1]][m[2]] = value;
        }
      });

      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          var msg = res.status === 401
            ? 'Invalid API key'
            : (body.error && body.error.message) || ('HTTP ' + res.status);
          throw new Error(msg);
        });
      }

      var s = loadState(ctx);
      s.api = { fetchedAt: now(), metrics: metrics, error: null };
      ctx.store.save(s);
      plugin.tick(ctx);
      AIUsage.toast(Object.keys(metrics).length
        ? 'Usage updated'
        : 'Key valid, but no rate-limit data exposed');
    }).catch(function (err) {
      var s = loadState(ctx);
      s.api = Object.assign({ fetchedAt: null, metrics: {} }, s.api, {
        error: (err && err.message) || 'Request failed (offline?)'
      });
      ctx.store.save(s);
      plugin.tick(ctx);
    });
  }

  function refresh(ctx, plugin) {
    var state = loadState(ctx);
    if (state.source === 'api') fetchApiUsage(ctx, plugin);
    else fetchSubscriptionUsage(ctx, plugin);
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
    var fields =
      '<div class="field">' +
        '<label for="claude-source">Account</label>' +
        '<select id="claude-source">' +
          '<option value="subscription"' + (state.source === 'subscription' ? ' selected' : '') + '>Subscription (Pro/Max)</option>' +
          '<option value="api"' + (state.source === 'api' ? ' selected' : '') + '>API key</option>' +
        '</select>' +
      '</div>';

    if (state.source === 'api') {
      fields +=
        '<div class="field">' +
          '<label for="claude-api-key">API key</label>' +
          '<input id="claude-api-key" type="password" placeholder="sk-ant-api..." autocomplete="off">' +
        '</div>' +
        '<p class="plugin-note">The key is stored only on this device and sent only to api.anthropic.com. ' +
        'Prefer a key from a restricted workspace. Refresh makes a free count_tokens request.</p>';
    } else {
      fields +=
        '<div class="field">' +
          '<label for="claude-oauth-token">OAuth token</label>' +
          '<input id="claude-oauth-token" type="password" placeholder="sk-ant-oat..." autocomplete="off">' +
        '</div>' +
        '<p class="plugin-note">Get a token by running <code>claude setup-token</code> in a terminal ' +
        '(requires a Pro/Max subscription). It is stored only on this device. ' +
        'Anthropic’s usage endpoint usually blocks direct browser calls (CORS) — tap Refresh to try it.</p>';
    }

    return (
      '<details class="plugin-settings">' +
        '<summary>Settings</summary>' +
        fields +
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
        '<div class="plugin-card__logo">✳</div>' +
        '<div>' +
          '<h2 class="plugin-card__title">Claude</h2>' +
          '<p class="plugin-card__subtitle">' +
            (state.source === 'api'
              ? 'API account · live data from Anthropic'
              : 'Subscription · live data from Anthropic') +
          '</p>' +
        '</div>' +
      '</div>' +
      '<div id="claude-meters"></div>' +
      '<div class="controls">' +
        '<button type="button" class="btn btn--primary" data-action="refresh">Refresh</button>' +
        '<button type="button" class="btn btn--ghost" data-action="share">Share stats</button>' +
      '</div>' +
      '<p class="plugin-note" data-role="status"></p>' +
      settingsHtml(state);

    // Set secrets via the property, never via HTML, to avoid attribute injection.
    var keyInput = ctx.root.querySelector('#claude-api-key');
    if (keyInput) keyInput.value = state.apiKey;
    var tokenInput = ctx.root.querySelector('#claude-oauth-token');
    if (tokenInput) tokenInput.value = state.oauthToken;

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
    if (state.source === 'api') {
      return state.apiKey
        ? 'No data yet — tap Refresh to fetch your account limits.'
        : 'Add your API key in Settings, then tap Refresh.';
    }
    return state.oauthToken
      ? 'No data yet — tap Refresh to fetch your subscription usage.'
      : 'Add your OAuth token in Settings, then tap Refresh.';
  }

  function resetCountdown(resetsAt) {
    if (!resetsAt) return '';
    var left = Date.parse(resetsAt) - now();
    return left > 0
      ? 'Resets in ' + AIUsage.formatDuration(left)
      : 'Window has reset — refresh for current data';
  }

  function renderMeters(ctx, state) {
    var container = ctx.root.querySelector('#claude-meters');
    if (!container) return;

    if (state.source === 'api') {
      var names = RATE_METRIC_ORDER.filter(function (n) {
        return state.api && state.api.metrics && state.api.metrics[n] &&
          state.api.metrics[n].limit && state.api.metrics[n].remaining;
      });
      if (names.length === 0) {
        container.innerHTML = '<p class="empty-note">' + emptyNote(state) + '</p>';
        return;
      }
      container.innerHTML = names.map(function (n) {
        return meterHtml('claude-m-' + n, RATE_METRIC_LABELS[n] || n);
      }).join('');
      names.forEach(function (n) {
        var m = state.api.metrics[n];
        var limit = parseInt(m.limit, 10) || 0;
        var remaining = parseInt(m.remaining, 10) || 0;
        var used = Math.max(0, limit - remaining);
        var p = limit ? clampPct((used / limit) * 100) : 0;
        updateMeter(ctx.root.querySelector('#claude-m-' + n),
          p, used + ' / ' + limit + ' (' + p + '%)', resetCountdown(m.reset));
      });
      return;
    }

    var keys = state.sub && state.sub.windows ? Object.keys(state.sub.windows) : [];
    if (keys.length === 0) {
      container.innerHTML = '<p class="empty-note">' + emptyNote(state) + '</p>';
      return;
    }
    container.innerHTML = keys.map(function (k, i) {
      return meterHtml('claude-w-' + i, windowLabel(k));
    }).join('');
    keys.forEach(function (k, i) {
      var w = state.sub.windows[k];
      var p = clampPct(w.utilization);
      updateMeter(ctx.root.querySelector('#claude-w-' + i),
        p, p + '% used', resetCountdown(w.resetsAt));
    });
  }

  function summaryText(state) {
    var lines;
    if (state.source === 'api') {
      lines = ['Claude API rate limits'];
      if (state.api && state.api.metrics) {
        RATE_METRIC_ORDER.forEach(function (n) {
          var m = state.api.metrics[n];
          if (!m || !m.limit) return;
          var limit = parseInt(m.limit, 10) || 0;
          var used = Math.max(0, limit - (parseInt(m.remaining, 10) || 0));
          var p = limit ? clampPct((used / limit) * 100) : 0;
          lines.push((RATE_METRIC_LABELS[n] || n) + ': ' + used + '/' + limit + ' (' + p + '%)');
        });
      }
      return lines.join('\n');
    }
    lines = ['Claude subscription usage'];
    if (state.sub && state.sub.windows) {
      Object.keys(state.sub.windows).forEach(function (k) {
        lines.push(windowLabel(k) + ': ' + clampPct(state.sub.windows[k].utilization) + '%');
      });
    }
    return lines.join('\n');
  }

  /* ---------- Plugin ---------- */

  AIUsage.registerPlugin({
    id: 'claude',
    name: 'Claude',

    render: function (ctx) {
      var self = this;

      // Delegated listeners attached once; rebuild() only replaces innerHTML.
      ctx.root.addEventListener('click', function (e) {
        var action = e.target.getAttribute('data-action');
        if (!action) return;

        if (action === 'refresh') { refresh(ctx, self); return; }
        if (action === 'share') { AIUsage.share(summaryText(loadState(ctx))); return; }
        if (action === 'reset-all') {
          if (!confirm('Clear all Claude data (including stored credentials)?')) return;
          ctx.store.save(Object.assign({}, DEFAULTS));
          rebuild(ctx, self);
        }
      });

      ctx.root.addEventListener('change', function (e) {
        var s = loadState(ctx);
        switch (e.target.id) {
          case 'claude-source':
            s.source = e.target.value === 'api' ? 'api' : 'subscription';
            ctx.store.save(s);
            rebuild(ctx, self);
            return;
          case 'claude-api-key':
            s.apiKey = e.target.value.trim();
            break;
          case 'claude-oauth-token':
            s.oauthToken = e.target.value.trim();
            break;
          default:
            return;
        }
        ctx.store.save(s);
        self.tick(ctx);
      });

      rebuild(ctx, this);
    },

    /* URL action: ?action=refresh&plugin=claude */
    handleAction: function (ctx, action) {
      if (action === 'refresh') refresh(ctx, this);
    },

    tick: function (ctx) {
      var state = loadState(ctx);
      renderMeters(ctx, state);

      var snap = state.source === 'api' ? state.api : state.sub;
      var statusEl = ctx.root.querySelector('[data-role="status"]');
      if (!statusEl) return;
      if (snap && snap.error) {
        statusEl.textContent = 'Error: ' + snap.error;
        statusEl.className = 'plugin-note plugin-note--error';
      } else if (snap && snap.fetchedAt) {
        statusEl.textContent = 'Updated ' + new Date(snap.fetchedAt).toLocaleTimeString();
        statusEl.className = 'plugin-note';
      } else {
        statusEl.textContent = '';
      }
    }
  });
})();
