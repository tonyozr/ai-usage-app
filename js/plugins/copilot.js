/*
 * GitHub Copilot plugin for AI Usage — real data via GitHub's OAuth Device
 * Flow + the same internal usage endpoint VS Code's Copilot Chat extension
 * reads from. This is the technique CodexBar's Copilot provider uses.
 *
 * There's no documented per-user Copilot quota API, but there is a real,
 * working one: GET https://api.github.com/copilot_internal/user, called
 * with a plain GitHub OAuth token (not a Copilot-specific token) plus a
 * few headers that identify the caller as an editor extension. That
 * endpoint does send `Access-Control-Allow-Origin: *`, but its preflight
 * response uses a fixed `Access-Control-Allow-Headers` allowlist that
 * does not include `Editor-Version`/`Editor-Plugin-Version` — so a direct
 * browser call still fails preflight. This needs the CORS proxy for every
 * request, not just sign-in (unlike a plain CORS block, this can't be
 * fixed by dropping credentials or headers we don't control).
 *
 * Getting the token needs GitHub's OAuth Device Flow (the same flow VS
 * Code itself uses, via VS Code's public client ID — no client secret
 * involved), which also needs the proxy since github.com's device-flow
 * endpoints (login/device/code, login/oauth/access_token) send no CORS
 * headers at all.
 *
 * Credentials and snapshots are stored only on this device (localStorage).
 */
(function () {
  'use strict';

  var CLIENT_ID = 'Iv1.b507a08c87ecfe98'; // VS Code's public OAuth client ID
  var SCOPE = 'read:user';
  var DEVICE_CODE_URL = 'https://github.com/login/device/code';
  var ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
  var USAGE_URL = 'https://api.github.com/copilot_internal/user';
  var USER_URL = 'https://api.github.com/user';

  var WINDOW_LABELS = {
    premium: 'Premium requests',
    chat: 'Chat'
  };

  var DEFAULTS = {
    token: '',
    login: '',
    snap: null // { fetchedAt, copilotPlan, tokenBasedBilling, windows: {premium:{usedPercent,resetsAt}, chat:{...}}, error }
  };

  // Device-flow-in-progress state lives outside localStorage (transient,
  // short-lived codes) and outside plugin state (rebuild() fully replaces
  // innerHTML, so it can't live in the DOM either).
  var pendingLogin = null; // { message, userCode, verificationUri, deviceCode, interval, expiresAt }
  var pollTimer = null;

  function now() { return Date.now(); }

  function loadState(ctx) {
    return Object.assign({}, DEFAULTS, ctx.store.load({}));
  }

  function clampPct(n) {
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function formBody(params) {
    return Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
  }

  /* ---------- Device flow (one-time sign-in, via CORS proxy) ---------- */

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  function cancelLogin(ctx, plugin) {
    stopPolling();
    pendingLogin = null;
    rebuild(ctx, plugin);
  }

  function startLogin(ctx, plugin) {
    if (pendingLogin) return;
    if (!AIUsage.corsProxy.getConfig().url) {
      AIUsage.toast('Set a CORS proxy in the app footer first — required to sign in');
      return;
    }

    pendingLogin = { message: 'Requesting a sign-in code…' };
    rebuild(ctx, plugin);

    fetch(AIUsage.corsProxy.wrap(DEVICE_CODE_URL), Object.assign({
      method: 'POST',
      headers: Object.assign({
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      }, AIUsage.corsProxy.headers()),
      body: formBody({ client_id: CLIENT_ID, scope: SCOPE })
    }, AIUsage.corsProxy.fetchOptions())).then(function (res) {
      return res.json();
    }).then(function (data) {
      if (!data || !data.device_code) {
        throw new Error((data && data.error_description) || 'Failed to start GitHub sign-in');
      }
      pendingLogin = {
        message: 'Waiting for you to authorize…',
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        deviceCode: data.device_code,
        interval: data.interval || 5,
        expiresAt: now() + (data.expires_in || 900) * 1000
      };
      rebuild(ctx, plugin);
      schedulePoll(ctx, plugin);
    }).catch(function (err) {
      pendingLogin = null;
      AIUsage.toast((err && err.message) || 'Sign-in failed');
      rebuild(ctx, plugin);
    });
  }

  function schedulePoll(ctx, plugin) {
    stopPolling();
    if (!pendingLogin) return;
    pollTimer = setTimeout(function () { pollOnce(ctx, plugin); }, pendingLogin.interval * 1000);
  }

  function pollOnce(ctx, plugin) {
    if (!pendingLogin) return;
    if (now() > pendingLogin.expiresAt) {
      pendingLogin = null;
      AIUsage.toast('Sign-in code expired — try again');
      rebuild(ctx, plugin);
      return;
    }

    fetch(AIUsage.corsProxy.wrap(ACCESS_TOKEN_URL), Object.assign({
      method: 'POST',
      headers: Object.assign({
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      }, AIUsage.corsProxy.headers()),
      body: formBody({
        client_id: CLIENT_ID,
        device_code: pendingLogin.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    }, AIUsage.corsProxy.fetchOptions())).then(function (res) {
      return res.json();
    }).then(function (data) {
      if (!pendingLogin) return; // cancelled while request was in flight
      if (data && data.access_token) {
        var s = loadState(ctx);
        s.token = data.access_token;
        ctx.store.save(s);
        pendingLogin = null;
        rebuild(ctx, plugin);
        fetchGitHubLogin(ctx, plugin);
        fetchUsage(ctx, plugin);
        return;
      }
      var error = data && data.error;
      if (error === 'authorization_pending') {
        schedulePoll(ctx, plugin);
      } else if (error === 'slow_down') {
        pendingLogin.interval += 5;
        schedulePoll(ctx, plugin);
      } else if (error === 'expired_token') {
        pendingLogin = null;
        AIUsage.toast('Sign-in code expired — try again');
        rebuild(ctx, plugin);
      } else {
        pendingLogin = null;
        AIUsage.toast((data && data.error_description) || error || 'Sign-in failed');
        rebuild(ctx, plugin);
      }
    }).catch(function () {
      // Transient network hiccup during polling — keep trying until expiry.
      schedulePoll(ctx, plugin);
    });
  }

  function fetchGitHubLogin(ctx, plugin) {
    var state = loadState(ctx);
    fetch(AIUsage.corsProxy.wrap(USER_URL), Object.assign({
      headers: Object.assign({
        'Authorization': 'token ' + state.token,
        'Accept': 'application/vnd.github+json'
      }, AIUsage.corsProxy.headers())
    }, AIUsage.corsProxy.fetchOptions())).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (body) {
      if (!body || !body.login) return;
      var s = loadState(ctx);
      s.login = body.login;
      ctx.store.save(s);
      rebuild(ctx, plugin);
    }).catch(function () { /* best-effort only */ });
  }

  /* ---------- Usage response parsing (mirrors CodexBar's CopilotUsageFetcher) ---------- */

  function numOrZero(v) {
    return typeof v === 'number' && !isNaN(v) ? v : 0;
  }

  function parseQuotaSnapshot(raw) {
    if (!raw) return null;
    var unlimited = !!raw.unlimited;
    if (unlimited) return null; // no meaningful percentage to show

    var entitlement = numOrZero(raw.entitlement);
    var remaining = numOrZero(raw.remaining);
    var percentRemaining = null;
    if (typeof raw.percent_remaining === 'number') {
      percentRemaining = raw.percent_remaining;
    } else if (entitlement > 0) {
      percentRemaining = (remaining / entitlement) * 100;
    }

    if (percentRemaining == null) return null;
    if (entitlement === 0 && remaining === 0 && percentRemaining === 0) return null; // placeholder shape

    return { usedPercent: Math.max(0, 100 - percentRemaining) };
  }

  function parseQuotaResetDate(raw) {
    if (!raw) return null;
    var t = Date.parse(raw);
    return isNaN(t) ? null : new Date(t).toISOString();
  }

  function parseUsageBody(body) {
    var qs = body.quota_snapshots || {};
    var resetsAt = parseQuotaResetDate(body.quota_reset_date);
    var premium = parseQuotaSnapshot(qs.premium_interactions);
    var chat = parseQuotaSnapshot(qs.chat);

    var windows = {};
    if (premium) windows.premium = Object.assign({ resetsAt: resetsAt }, premium);
    if (chat) windows.chat = Object.assign({ resetsAt: resetsAt }, chat);

    return {
      copilotPlan: body.copilot_plan || null,
      tokenBasedBilling: !!body.token_based_billing,
      windows: windows
    };
  }

  /* ---------- Fetch ---------- */

  function fetchUsage(ctx, plugin) {
    var state = loadState(ctx);
    if (!state.token) {
      AIUsage.toast('Sign in with GitHub in Settings first');
      return;
    }
    if (!AIUsage.corsProxy.getConfig().url) {
      AIUsage.toast('Set a CORS proxy in the app footer first — required for Copilot');
      return;
    }

    var statusEl = ctx.root.querySelector('[data-role="status"]');
    if (statusEl) statusEl.textContent = 'Refreshing…';

    fetch(AIUsage.corsProxy.wrap(USAGE_URL), Object.assign({
      method: 'GET',
      headers: Object.assign({
        'Authorization': 'token ' + state.token,
        'Accept': 'application/json',
        'Editor-Version': 'vscode/1.96.2',
        'Editor-Plugin-Version': 'copilot-chat/0.26.7',
        'X-Github-Api-Version': '2025-04-01'
      }, AIUsage.corsProxy.headers())
    }, AIUsage.corsProxy.fetchOptions())).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var msg = (res.status === 401 || res.status === 403)
            ? 'Token invalid or expired — sign in with GitHub again'
            : (body.message || ('HTTP ' + res.status));
          throw new Error(msg);
        }
        var parsed = parseUsageBody(body);
        var s = loadState(ctx);
        s.snap = {
          fetchedAt: now(),
          copilotPlan: parsed.copilotPlan,
          tokenBasedBilling: parsed.tokenBasedBilling,
          windows: parsed.windows,
          error: null
        };
        ctx.store.save(s);
        plugin.tick(ctx);
        AIUsage.toast('Usage updated');
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

  function loginSectionHtml(state) {
    if (pendingLogin) {
      var codeBlock = pendingLogin.userCode
        ? '<p class="plugin-note">Enter code <code>' + pendingLogin.userCode + '</code> at ' +
          '<a href="' + pendingLogin.verificationUri + '" target="_blank" rel="noopener">' +
          pendingLogin.verificationUri + '</a></p>'
        : '';
      return (
        '<p class="plugin-note">' + pendingLogin.message + '</p>' +
        codeBlock +
        '<div class="controls">' +
          '<button type="button" class="btn btn--ghost" data-action="cancel-login">Cancel</button>' +
        '</div>'
      );
    }
    if (state.token) {
      return (
        '<p class="plugin-note">Signed in' + (state.login ? ' as <strong>' + state.login + '</strong>' : '') + '.</p>' +
        '<div class="controls">' +
          '<button type="button" class="btn btn--ghost" data-action="sign-out">Sign out</button>' +
        '</div>'
      );
    }
    return (
      '<p class="plugin-note">Sign in with GitHub to read your Copilot usage. Requires a ' +
      '<a href="#" data-action="open-cors-proxy">CORS proxy</a> to be configured — both for sign-in ' +
      '(GitHub’s device-flow endpoints send no CORS headers) and for refreshes afterward (the usage ' +
      'endpoint\'s CORS preflight doesn’t allow the editor-identification headers it needs).</p>' +
      '<div class="controls">' +
        '<button type="button" class="btn btn--primary" data-action="sign-in">Sign in with GitHub</button>' +
      '</div>'
    );
  }

  function settingsHtml(state) {
    return (
      '<details class="plugin-settings"' + (pendingLogin ? ' open' : '') + '>' +
        '<summary>Settings</summary>' +
        loginSectionHtml(state) +
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
        '<div class="plugin-card__logo">Ⓒ</div>' +
        '<div>' +
          '<h2 class="plugin-card__title">GitHub Copilot</h2>' +
          '<p class="plugin-card__subtitle">' +
            (state.snap && state.snap.copilotPlan
              ? state.snap.copilotPlan.charAt(0).toUpperCase() + state.snap.copilotPlan.slice(1) + ' plan · live data'
              : 'Subscription · live data from GitHub') +
          '</p>' +
        '</div>' +
      '</div>' +
      '<div id="copilot-meters"></div>' +
      '<div class="controls">' +
        '<button type="button" class="btn btn--primary" data-action="refresh">Refresh</button>' +
        '<button type="button" class="btn btn--ghost" data-action="share">Share stats</button>' +
      '</div>' +
      '<p class="plugin-note" data-role="status"></p>' +
      settingsHtml(state);

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

  function emptyNote(state) {
    if (!state.token) return 'Sign in with GitHub in Settings, then tap Refresh.';
    if (state.snap && state.snap.tokenBasedBilling) return 'Token-based billing plan — no fixed quota to show.';
    if (state.snap && state.snap.fetchedAt) return 'Unlimited plan, or no metered quota on this account.';
    return 'No data yet — tap Refresh to fetch your Copilot usage.';
  }

  function renderMeters(ctx, state) {
    var container = ctx.root.querySelector('#copilot-meters');
    if (!container) return;

    var keys = state.snap && state.snap.windows ? Object.keys(state.snap.windows) : [];
    if (keys.length === 0) {
      container.innerHTML = '<p class="empty-note">' + emptyNote(state) + '</p>';
      return;
    }
    container.innerHTML = keys.map(function (k, i) {
      return meterHtml('copilot-w-' + i, WINDOW_LABELS[k] || k);
    }).join('');
    keys.forEach(function (k, i) {
      var w = state.snap.windows[k];
      var p = clampPct(w.usedPercent);
      updateMeter(ctx.root.querySelector('#copilot-w-' + i),
        p, p + '% used', resetCountdown(w.resetsAt));
    });
  }

  function summaryText(state) {
    var lines = ['GitHub Copilot usage'];
    if (state.snap) {
      if (state.snap.copilotPlan) lines.push('Plan: ' + state.snap.copilotPlan);
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
    id: 'copilot',
    name: 'GitHub Copilot',

    render: function (ctx) {
      var self = this;

      ctx.root.addEventListener('click', function (e) {
        var action = e.target.getAttribute('data-action');
        if (!action) return;

        if (action === 'refresh') { fetchUsage(ctx, self); return; }
        if (action === 'share') { AIUsage.share(summaryText(loadState(ctx))); return; }
        if (action === 'sign-in') { startLogin(ctx, self); return; }
        if (action === 'cancel-login') { cancelLogin(ctx, self); return; }
        if (action === 'sign-out') {
          if (!confirm('Sign out of GitHub Copilot (clears the stored token)?')) return;
          ctx.store.save(Object.assign({}, DEFAULTS));
          rebuild(ctx, self);
          return;
        }
        if (action === 'open-cors-proxy') {
          e.preventDefault();
          var toggle = document.getElementById('cors-proxy-toggle');
          if (toggle) toggle.click();
          return;
        }
        if (action === 'reset-all') {
          if (!confirm('Clear all GitHub Copilot data (including the stored token)?')) return;
          stopPolling();
          pendingLogin = null;
          ctx.store.save(Object.assign({}, DEFAULTS));
          rebuild(ctx, self);
        }
      });

      rebuild(ctx, this);
    },

    handleAction: function (ctx, action) {
      if (action === 'refresh') fetchUsage(ctx, this);
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
