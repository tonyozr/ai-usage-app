/*
 * Google / Gemini plugin for AI Usage — real account & API quota data.
 *
 * Two data sources:
 *
 *  - "subscription" (default): your Google Gemini / Cloud Code / Antigravity
 *    account, using the internal Cloud Code quota API
 *    (POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
 *     or POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota)
 *    authenticated with a Google OAuth access token (from ~/.gemini/oauth_creds.json,
 *    ~/.config/gemini/oauth_creds.json, or `gcloud auth print-access-token`).
 *    Returns real session, daily, or model-specific utilization and reset countdowns.
 *
 *  - "api": a Google AI Studio API key (AIzaSy...). Calls
 *    GET https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY
 *    to verify access, retrieve active models, and track standard Gemini rate limits.
 *
 * Credentials and snapshots are stored only on this device (localStorage).
 */
(function () {
  'use strict';

  var CLOUDCODE_BASE = 'https://cloudcode-pa.googleapis.com';
  var QUOTA_SUMMARY_PATH = '/v1internal:retrieveUserQuotaSummary';
  var QUOTA_PATH = '/v1internal:retrieveUserQuota';
  var LOAD_CODEASSIST_PATH = '/v1internal:loadCodeAssist';
  var GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';
  var GEMINI_MODELS_PATH = '/v1beta/models';
  var GEMINI_USAGE_URL = 'https://gemini.google.com/usage';

  var DEFAULTS = {
    source: 'subscription', // 'subscription' | 'api'
    oauthToken: '',
    projectId: '',
    sub: null, // { fetchedAt, planType, windows: {key: {name, usedPercent, resetsAt}}, error }
    apiKey: '',
    api: null  // { fetchedAt, modelsCount, windows: {key: {name, usedPercent, resetsAt}}, error }
  };

  function now() { return Date.now(); }

  function loadState(ctx) {
    return Object.assign({}, DEFAULTS, ctx.store.load({}));
  }

  function clampPct(n) {
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------- Subscription / OAuth Source ---------- */

  function parseQuotaResponse(body) {
    var windows = {};
    if (!body || typeof body !== 'object') return windows;

    var items = body.quotaBuckets || body.buckets || body.bottleneckFamilies || body.userQuota || body.windows;
    if (!items && Array.isArray(body)) items = body;

    if (Array.isArray(items)) {
      items.forEach(function (item, idx) {
        if (!item || typeof item !== 'object') return;
        var rawName = item.modelId || item.model || item.name || item.id || item.group || item.tokenType || ('Quota ' + (idx + 1));

        var usedPct = null;
        if (typeof item.usedPercent === 'number') {
          usedPct = item.usedPercent;
        } else if (typeof item.used_percent === 'number') {
          usedPct = item.used_percent;
        } else if (typeof item.usedFraction === 'number') {
          usedPct = item.usedFraction * 100;
        } else if (typeof item.utilization === 'number') {
          usedPct = item.utilization <= 1 ? item.utilization * 100 : item.utilization;
        } else if (typeof item.remainingFraction === 'number') {
          usedPct = (1 - item.remainingFraction) * 100;
        } else if (typeof item.remainingAmount === 'number' && typeof item.limit === 'number' && item.limit > 0) {
          usedPct = ((item.limit - item.remainingAmount) / item.limit) * 100;
        }

        if (usedPct === null) return;

        var resetsAt = item.resetTime || item.resetsAt || item.reset_at || item.resetTimestamp || null;
        if (typeof resetsAt === 'number' && resetsAt > 0 && resetsAt < 10000000000) {
          resetsAt = new Date(resetsAt * 1000).toISOString();
        }

        var key = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        windows[key] = {
          name: rawName,
          usedPercent: Math.max(0, Math.min(100, Math.round(usedPct))),
          resetsAt: resetsAt
        };
      });
    } else if (typeof items === 'object') {
      Object.keys(items).forEach(function (k) {
        var item = items[k];
        if (!item || typeof item !== 'object') return;
        var usedPct = null;
        if (typeof item.usedPercent === 'number') usedPct = item.usedPercent;
        else if (typeof item.used_percent === 'number') usedPct = item.used_percent;
        else if (typeof item.remainingFraction === 'number') usedPct = (1 - item.remainingFraction) * 100;
        else if (typeof item.utilization === 'number') usedPct = item.utilization <= 1 ? item.utilization * 100 : item.utilization;

        if (usedPct !== null) {
          windows[k] = {
            name: item.name || item.modelId || k,
            usedPercent: Math.max(0, Math.min(100, Math.round(usedPct))),
            resetsAt: item.resetTime || item.resetsAt || null
          };
        }
      });
    }

    return windows;
  }

  // Identify as a generic Gemini CLI / Code Assist client.
  function getCodeAssistMetadata() {
    return {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI'
    };
  }

  function fetchSubscriptionUsage(ctx, plugin) {
    var state = loadState(ctx);
    if (!state.oauthToken) {
      AIUsage.toast('Add a Google OAuth token in Settings first');
      return;
    }

    var statusEl = ctx.root.querySelector('[data-role="status"]');
    if (statusEl) statusEl.textContent = 'Refreshing…';

    var proxyConfigured = !!AIUsage.corsProxy.getConfig().url;
    
    function makeRequest(path, bodyObj) {
      var targetUrl = CLOUDCODE_BASE + path;
      var fetchUrl = proxyConfigured ? AIUsage.corsProxy.wrap(targetUrl) : targetUrl;
      var reqHeaders = Object.assign({
        'Authorization': 'Bearer ' + state.oauthToken,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }, AIUsage.corsProxy.headers());
      return fetch(fetchUrl, Object.assign({
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify(bodyObj)
      }, AIUsage.corsProxy.fetchOptions())).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) {
            var msg = (res.status === 401 || res.status === 403)
              ? 'OAuth token invalid or expired — update in Settings'
              : (body.error && body.error.message) || ('HTTP ' + res.status);
            throw new Error(msg);
          }
          return body;
        });
      });
    }

    function pickTier(res) {
      if (res.allowedTiers && res.allowedTiers.length > 0) {
        var def = res.allowedTiers.find(function (t) { return t.isDefault && t.id; });
        if (def) return def.id;
        var first = res.allowedTiers.find(function (t) { return t.id; });
        if (first) return first.id;
      }
      if (res.paidTier && res.paidTier.id) return res.paidTier.id;
      if (res.currentTier && res.currentTier.id) return res.currentTier.id;
      return null;
    }

    function extractProject(obj) {
      if (!obj) return null;
      var proj = obj.cloudaicompanionProject || (obj.response && obj.response.cloudaicompanionProject);
      if (proj && proj.projectId) return proj.projectId;
      if (proj && proj.id) return proj.id;
      return null;
    }

    var resolvedProject = state.projectId || null;
    var currentPlan = 'Gemini Account';

    makeRequest(LOAD_CODEASSIST_PATH, { metadata: getCodeAssistMetadata() })
      .then(function (codeAssist) {
        if (codeAssist.planInfo && codeAssist.planInfo.planType) {
          currentPlan = codeAssist.planInfo.planType;
        } else if (codeAssist.tier) {
          currentPlan = codeAssist.tier;
        }

        if (resolvedProject) return null; // Already have a project ID

        var pId = extractProject(codeAssist);
        if (pId) {
          resolvedProject = pId;
          return null;
        }

        // Need to onboard
        var tierId = pickTier(codeAssist);
        if (!tierId) throw new Error('No allowed tiers found for onboarding personal account');

        return makeRequest('/v1internal:onboardUser', {
          tierId: tierId,
          metadata: getCodeAssistMetadata()
        }).then(function (onboardRes) {
          var newId = extractProject(onboardRes);
          if (newId) resolvedProject = newId;
          // Note: In real app, might need to wait/poll, but trying immediately
          return null;
        });
      })
      .then(function () {
        // Try fetchAvailableModels for pretty names and quota
        var bodyObj = resolvedProject ? { project: resolvedProject } : {};
        return makeRequest('/v1internal:fetchAvailableModels', bodyObj)
          .then(function (modelsRes) {
            // Models contain quotaInfo
            var models = modelsRes.models || {};
            var windows = {};
            Object.keys(models).forEach(function (k) {
              var m = models[k];
              var label = m.displayName || m.label || k;
              if (m.quotaInfo && typeof m.quotaInfo.remainingFraction === 'number') {
                var usedPct = (1 - m.quotaInfo.remainingFraction) * 100;
                var resetsAt = m.quotaInfo.resetTime || null;
                windows[k] = {
                  name: label,
                  usedPercent: Math.max(0, Math.min(100, Math.round(usedPct))),
                  resetsAt: resetsAt
                };
              }
            });
            // Try to fetch quota summary or buckets if full data isn't there
            return makeRequest(QUOTA_SUMMARY_PATH, bodyObj)
              .catch(function () {
                // Fallback to retrieveUserQuota if retrieveUserQuotaSummary fails
                return makeRequest(QUOTA_PATH, bodyObj);
              })
              .then(function (quotaRes) {
                var moreWindows = parseQuotaResponse(quotaRes);
                // Merge
                Object.keys(moreWindows).forEach(function (k) {
                  windows[k] = moreWindows[k];
                });
                return windows;
              })
              .catch(function () {
                // If quota endpoints fail, return what we got from fetchAvailableModels
                return windows;
              });
          })
          .catch(function (err) {
            // If fetchAvailableModels fails (e.g. 403), fallback directly to retrieveUserQuota
            var bodyObj = resolvedProject ? { project: resolvedProject } : {};
            return makeRequest(QUOTA_SUMMARY_PATH, bodyObj)
              .catch(function () {
                return makeRequest(QUOTA_PATH, bodyObj);
              })
              .then(function (quotaRes) {
                return parseQuotaResponse(quotaRes);
              });
          });
      })
      .then(function (windows) {
        var s = loadState(ctx);
        s.sub = {
          fetchedAt: now(),
          planType: currentPlan,
          windows: windows || {},
          error: null
        };
        // Auto-save discovered project ID if not set
        if (!s.projectId && resolvedProject) {
          s.projectId = resolvedProject;
        }
        ctx.store.save(s);
        rebuild(ctx, plugin);
        AIUsage.toast(Object.keys(windows || {}).length ? 'Google usage updated' : 'Quota data refreshed');
      })
      .catch(function (err) {
        var s = loadState(ctx);
        var msg = (err && err.message) || 'Request failed';
        if (err instanceof TypeError) {
          msg = 'Blocked by browser CORS or network error.' +
            (proxyConfigured ? '' : ' Configure CORS proxy in footer if needed.');
        }
        s.sub = Object.assign({ fetchedAt: null, windows: {} }, s.sub, { error: msg });
        ctx.store.save(s);
        plugin.tick(ctx);
      });
  }

  /* ---------- API Key Source ---------- */

  function fetchApiUsage(ctx, plugin) {
    var state = loadState(ctx);
    if (!state.apiKey) {
      AIUsage.toast('Add a Gemini API key in Settings first');
      return;
    }

    var statusEl = ctx.root.querySelector('[data-role="status"]');
    if (statusEl) statusEl.textContent = 'Refreshing…';

    var targetUrl = GEMINI_API_BASE + GEMINI_MODELS_PATH + '?key=' + encodeURIComponent(state.apiKey);
    var proxyConfigured = !!AIUsage.corsProxy.getConfig().url;
    var fetchUrl = proxyConfigured ? AIUsage.corsProxy.wrap(targetUrl) : targetUrl;

    var reqHeaders = Object.assign({
      'Accept': 'application/json'
    }, AIUsage.corsProxy.headers());

    fetch(fetchUrl, Object.assign({
      method: 'GET',
      headers: reqHeaders
    }, AIUsage.corsProxy.fetchOptions())).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var msg = (res.status === 400 || res.status === 403)
            ? 'Invalid API key or access denied'
            : (body.error && body.error.message) || ('HTTP ' + res.status);
          throw new Error(msg);
        }

        // The public Gemini API has no per-key usage endpoint, so this mode
        // only verifies the key and lists available models — no meters are
        // invented for data the API doesn't report.
        var models = body.models || [];
        var s = loadState(ctx);
        s.api = {
          fetchedAt: now(),
          modelsCount: models.length,
          windows: {},
          error: null
        };
        ctx.store.save(s);
        rebuild(ctx, plugin);
        AIUsage.toast('Gemini API verified (' + models.length + ' models available)');
      });
    }).catch(function (err) {
      var s = loadState(ctx);
      var msg = (err && err.message) || 'Request failed';
      if (err instanceof TypeError) {
        msg = 'Blocked by browser CORS or network error.';
      }
      s.api = Object.assign({ fetchedAt: null, windows: {} }, s.api, { error: msg });
      ctx.store.save(s);
      plugin.tick(ctx);
    });
  }

  function refresh(ctx, plugin) {
    var state = loadState(ctx);
    if (state.source === 'api') {
      fetchApiUsage(ctx, plugin);
    } else {
      fetchSubscriptionUsage(ctx, plugin);
    }
  }

  /* ---------- HTML Render Helpers ---------- */

  function meterHtml(id, name) {
    return (
      '<div class="meter" id="' + id + '">' +
        '<div class="meter__labels">' +
          '<span class="meter__name">' + escapeHtml(name) + '</span>' +
          '<span class="meter__value" data-role="value">—</span>' +
        '</div>' +
        '<div class="meter__bar"><div class="meter__fill" data-role="fill" style="width:0%"></div></div>' +
        '<div class="meter__reset" data-role="reset"></div>' +
      '</div>'
    );
  }

  function settingsHtml(state) {
    var isApi = state.source === 'api';
    return (
      '<details class="plugin-settings">' +
        '<summary>Settings</summary>' +
        '<div class="field">' +
          '<label for="google-source">Data source</label>' +
          '<select id="google-source">' +
            '<option value="subscription"' + (!isApi ? ' selected' : '') + '>Account / OAuth (Gemini CLI / Code Assist)</option>' +
            '<option value="api"' + (isApi ? ' selected' : '') + '>API key (Google AI Studio)</option>' +
          '</select>' +
        '</div>' +
        (!isApi ? (
          '<div class="field">' +
            '<label for="google-oauth-token">OAuth token</label>' +
            '<input id="google-oauth-token" type="password" placeholder="ya29.a0..." autocomplete="off">' +
          '</div>' +
          '<div class="field">' +
            '<label for="google-project-id">GCP Project ID (optional)</label>' +
            '<input id="google-project-id" type="text" placeholder="my-gcp-project" autocomplete="off">' +
          '</div>' +
          '<p class="plugin-note">Sign in to the Gemini CLI with <strong>OAuth</strong> (not an API key), then copy the ' +
          '<code>access_token</code> from <code>~/.gemini/oauth_creds.json</code> or <code>~/.config/gemini/oauth_creds.json</code>. ' +
          '<code>gcloud auth print-access-token</code> will not work here — this endpoint only accepts tokens minted by the ' +
          'Gemini CLI\'s own OAuth client, and rejects gcloud\'s client with a 401. ' +
          'Credentials are stored only on this device.</p>'
        ) : (
          '<div class="field">' +
            '<label for="google-api-key">Gemini API key</label>' +
            '<input id="google-api-key" type="password" placeholder="AIzaSy..." autocomplete="off">' +
          '</div>' +
          '<p class="plugin-note">Get an API key from <a href="https://aistudio.google.com/" target="_blank" rel="noopener">Google AI Studio</a>. ' +
          'The key is stored only on this device and only used to check account quota status.</p>'
        )) +
        '<div class="controls">' +
          '<button type="button" class="btn btn--ghost" data-action="reset-all">Reset all data</button>' +
        '</div>' +
      '</details>'
    );
  }

  function rebuild(ctx, plugin) {
    var state = loadState(ctx);
    ctx.store.save(state);

    var isApi = state.source === 'api';
    var snap = isApi ? state.api : state.sub;

    var subtitle = isApi
      ? (snap && snap.modelsCount ? snap.modelsCount + ' models available · Google AI Studio' : 'Google AI Studio API')
      : (snap && snap.planType ? escapeHtml(snap.planType) + ' · Gemini Account' : 'Gemini CLI / Code Assist');

    ctx.root.innerHTML =
      '<div class="plugin-card__header">' +
        '<div class="plugin-card__logo">✦</div>' +
        '<div>' +
          '<h2 class="plugin-card__title">Google / Gemini</h2>' +
          '<p class="plugin-card__subtitle">' + subtitle + '</p>' +
        '</div>' +
      '</div>' +
      '<div id="google-meters"></div>' +
      '<div class="controls">' +
        '<button type="button" class="btn btn--primary" data-action="refresh">Refresh</button>' +
        '<button type="button" class="btn btn--ghost" data-action="share">Share stats</button>' +
      '</div>' +
      '<p class="plugin-note" data-role="status"></p>' +
      settingsHtml(state);

    if (isApi) {
      var apiKeyInput = ctx.root.querySelector('#google-api-key');
      if (apiKeyInput) apiKeyInput.value = state.apiKey;
    } else {
      var tokenInput = ctx.root.querySelector('#google-oauth-token');
      if (tokenInput) tokenInput.value = state.oauthToken;
      var projInput = ctx.root.querySelector('#google-project-id');
      if (projInput) projInput.value = state.projectId;
    }

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

  function emptyNote(state, snap) {
    if (state.source === 'api') {
      if (snap && snap.fetchedAt) {
        return 'API key verified — ' + snap.modelsCount + ' models available. ' +
          'The public Gemini API does not expose per-key usage, so no meters are shown.';
      }
      return state.apiKey
        ? 'No data yet — tap Refresh to check your Gemini API key.'
        : 'Add your Gemini API key in Settings, then tap Refresh.';
    }
    return state.oauthToken
      ? 'No data yet — tap Refresh to fetch your Google Gemini limits.'
      : 'Add your Google OAuth token in Settings, then tap Refresh.';
  }

  function resetCountdown(resetsAt) {
    if (!resetsAt) return '';
    var left = Date.parse(resetsAt) - now();
    return left > 0
      ? 'Resets in ' + AIUsage.formatDuration(left)
      : 'Window has reset — refresh for current data';
  }

  function renderMeters(ctx, state) {
    var container = ctx.root.querySelector('#google-meters');
    if (!container) return;

    var snap = state.source === 'api' ? state.api : state.sub;
    var keys = snap && snap.windows ? Object.keys(snap.windows) : [];

    if (keys.length === 0) {
      container.innerHTML = '<p class="empty-note">' + emptyNote(state, snap) +
        ' <a href="' + GEMINI_USAGE_URL + '" target="_blank" rel="noopener">Open usage page ↗</a></p>';
      return;
    }

    container.innerHTML = keys.map(function (k, i) {
      var w = snap.windows[k];
      return meterHtml('google-w-' + i, w.name || k);
    }).join('');

    keys.forEach(function (k, i) {
      var w = snap.windows[k];
      var p = clampPct(w.usedPercent);
      updateMeter(ctx.root.querySelector('#google-w-' + i),
        p, p + '% used', resetCountdown(w.resetsAt));
    });
  }

  function summaryText(state) {
    var lines = ['Google / Gemini usage'];
    var snap = state.source === 'api' ? state.api : state.sub;
    if (snap && snap.windows) {
      Object.keys(snap.windows).forEach(function (k) {
        var w = snap.windows[k];
        lines.push((w.name || k) + ': ' + clampPct(w.usedPercent) + '%');
      });
    }
    return lines.join('\n');
  }

  /* ---------- Plugin Registration ---------- */

  AIUsage.registerPlugin({
    id: 'google',
    name: 'Google / Gemini',

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
          if (!confirm('Clear all Google / Gemini data (including stored credentials)?')) return;
          ctx.store.save(Object.assign({}, DEFAULTS));
          rebuild(ctx, self);
        }
      });

      ctx.root.addEventListener('change', function (e) {
        var s = loadState(ctx);
        switch (e.target.id) {
          case 'google-source':
            s.source = e.target.value === 'api' ? 'api' : 'subscription';
            ctx.store.save(s);
            rebuild(ctx, self);
            return;
          case 'google-api-key':
            s.apiKey = e.target.value.trim();
            break;
          case 'google-oauth-token':
            s.oauthToken = e.target.value.trim();
            break;
          case 'google-project-id':
            s.projectId = e.target.value.trim();
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
