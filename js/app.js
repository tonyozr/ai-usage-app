/*
 * AI Usage — core app.
 * Plugins register themselves via AIUsage.registerPlugin() before start() runs.
 */
(function () {
  'use strict';

  var VERSION = '1.16.0';
  var THEME_KEY = 'aiusage.theme';
  var HINT_KEY = 'aiusage.installHintDismissed';
  var CORS_PROXY_KEY = 'aiusage.corsProxy';
  var THEMES = ['auto', 'light', 'dark'];

  var plugins = [];
  var tickTimer = null;

  /* ---------- Storage (namespaced localStorage) ---------- */

  function createStore(namespace) {
    var key = 'aiusage.plugin.' + namespace;
    return {
      load: function (fallback) {
        try {
          var raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
          return fallback;
        }
      },
      save: function (data) {
        try {
          localStorage.setItem(key, JSON.stringify(data));
        } catch (e) { /* storage full or unavailable — keep running in-memory */ }
      },
      clear: function () {
        try { localStorage.removeItem(key); } catch (e) {}
      }
    };
  }

  /* ---------- Theme ---------- */

  function getTheme() {
    var t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch (e) {}
    return THEMES.indexOf(t) >= 0 ? t : 'auto';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  }

  function cycleTheme() {
    var next = THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length];
    applyTheme(next);
  }

  /* ---------- CORS proxy ----------
   * Optional, global: routes fetches that would otherwise be blocked by CORS
   * through the user's own Cloudflare "CORS Header Proxy" Worker (see
   * https://developers.cloudflare.com/workers/examples/cors-header-proxy/),
   * following its ?apiurl=<target> convention.
   *
   * If that Worker is protected with Cloudflare Access, the "Open proxy to
   * sign in" button opens the proxy URL directly so the user can complete
   * the Access login there; the resulting CF_Authorization session cookie
   * is then forwarded cross-origin via credentials: 'include' on every
   * proxied request, handled at Cloudflare's edge before the Worker ever
   * runs. Access still needs an OPTIONS bypass policy, since preflight
   * requests carry no cookies. */

  function loadCorsProxyConfig() {
    try {
      var raw = localStorage.getItem(CORS_PROXY_KEY);
      var cfg = raw ? JSON.parse(raw) : null;
      var url = (cfg && typeof cfg.url === 'string') ? cfg.url : '';
      // Migrate away from the old Service Token shape (aud/clientId/clientSecret),
      // which stored a real credential in localStorage — purge it on first read
      // rather than waiting for the user to hit Save again.
      if (cfg && (cfg.clientId || cfg.clientSecret || cfg.aud)) {
        saveCorsProxyConfig({ url: url });
      }
      return { url: url };
    } catch (e) {
      return { url: '' };
    }
  }

  function saveCorsProxyConfig(cfg) {
    try { localStorage.setItem(CORS_PROXY_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  function corsProxyUrl(targetUrl) {
    var cfg = loadCorsProxyConfig();
    if (!cfg.url) return targetUrl;
    // No slash normalization: some proxy Workers route on an exact path
    // (e.g. Cloudflare's example requires a trailing "/corsproxy/"), so the
    // URL is used exactly as configured.
    return cfg.url + '?apiurl=' + encodeURIComponent(targetUrl);
  }

  function corsProxyFetchOptions() {
    return loadCorsProxyConfig().url ? { credentials: 'include' } : {};
  }

  // Extra headers to merge into a proxied request's own headers object
  // (don't spread this into fetch()'s top-level options — that would
  // replace the request's headers entirely instead of adding to them).
  // Kept as a stable hook for plugins even though the interactive-login
  // flow doesn't need any extra headers of its own right now.
  function corsProxyHeaders() {
    return {};
  }

  function initCorsProxyPanel() {
    var toggle = document.getElementById('cors-proxy-toggle');
    var panel = document.getElementById('cors-proxy-panel');
    var urlInput = document.getElementById('cors-proxy-url');
    var openBtn = document.getElementById('cors-proxy-open');
    var saveBtn = document.getElementById('cors-proxy-save');
    var clearBtn = document.getElementById('cors-proxy-clear');
    if (!toggle || !panel) return;

    function fillInputs() {
      var cfg = loadCorsProxyConfig();
      urlInput.value = cfg.url;
    }

    toggle.addEventListener('click', function () {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) fillInputs();
    });

    openBtn.addEventListener('click', function () {
      var url = urlInput.value.trim();
      if (!url) { toast('Enter a proxy URL first'); return; }
      window.open(url, '_blank', 'noopener');
    });

    saveBtn.addEventListener('click', function () {
      saveCorsProxyConfig({ url: urlInput.value.trim() });
      toast('CORS proxy settings saved');
    });

    clearBtn.addEventListener('click', function () {
      saveCorsProxyConfig({ url: '' });
      fillInputs();
      toast('CORS proxy cleared');
    });
  }

  /* ---------- Config export / import ----------
   * Backs up (or transfers to another device) everything the app keeps in
   * localStorage under the "aiusage." namespace: theme, the install-hint
   * dismissal flag, CORS proxy URL, and every plugin's saved state —
   * including any tokens/keys/cookies plugins store there. The file is
   * plain JSON with no encryption, so it's exactly as sensitive as the
   * credentials pasted into the app. */

  var APP_NAMESPACE_PREFIX = 'aiusage.';

  function collectNamespacedStorage() {
    var data = {};
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && key.indexOf(APP_NAMESPACE_PREFIX) === 0) {
        data[key] = localStorage.getItem(key);
      }
    }
    return data;
  }

  function exportConfig() {
    var payload = {
      app: 'ai-usage',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      data: collectNamespacedStorage()
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    var stamp = payload.exportedAt.replace(/[:.]/g, '-');
    a.download = 'ai-usage-config-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Config exported');
  }

  function importConfigFromFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var payload;
      try {
        payload = JSON.parse(String(reader.result));
      } catch (e) {
        toast('Not a valid config file');
        return;
      }
      var data = payload && typeof payload.data === 'object' ? payload.data : null;
      if (!data) {
        toast('Not a valid config file');
        return;
      }
      var keys = Object.keys(data).filter(function (k) {
        return k.indexOf(APP_NAMESPACE_PREFIX) === 0 && typeof data[k] === 'string';
      });
      if (keys.length === 0) {
        toast('Config file has no importable data');
        return;
      }
      if (!confirm('Import ' + keys.length + ' setting(s)? This overwrites matching data already on this device (including any saved tokens/keys).')) {
        return;
      }
      keys.forEach(function (k) {
        try { localStorage.setItem(k, data[k]); } catch (e) {}
      });
      toast('Config imported');
      // Simplest correct way to reflect imported plugin state everywhere
      // (settings fields, meters, CORS proxy panel) without re-deriving
      // each plugin's render logic here.
      setTimeout(function () { window.location.reload(); }, 600);
    };
    reader.onerror = function () { toast('Could not read file'); };
    reader.readAsText(file);
  }

  function initConfigTransferButtons() {
    var exportBtn = document.getElementById('config-export');
    var importBtn = document.getElementById('config-import');
    var fileInput = document.getElementById('config-import-file');
    if (exportBtn) exportBtn.addEventListener('click', exportConfig);
    if (importBtn && fileInput) {
      importBtn.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0];
        importConfigFromFile(file);
        fileInput.value = '';
      });
    }
  }

  /* ---------- Plugin lifecycle ---------- */

  function registerPlugin(plugin) {
    if (!plugin || typeof plugin.id !== 'string' || typeof plugin.render !== 'function') {
      throw new Error('Plugin must have an id and a render() function');
    }
    plugins.push(plugin);
  }

  function mountPlugins() {
    var container = document.getElementById('plugin-container');
    container.innerHTML = '';

    if (plugins.length === 0) {
      var note = document.createElement('p');
      note.className = 'empty-note';
      note.textContent = 'No plugins installed.';
      container.appendChild(note);
      return;
    }

    plugins.forEach(function (plugin) {
      var card = document.createElement('section');
      card.className = 'plugin-card';
      card.id = 'plugin-' + plugin.id;
      container.appendChild(card);

      var ctx = {
        root: card,
        store: createStore(plugin.id)
      };
      plugin._ctx = ctx;

      try {
        plugin.render(ctx);
      } catch (e) {
        card.innerHTML = '<p class="empty-note">Plugin "' + plugin.id + '" failed to load.</p>';
      }
    });
  }

  function tickPlugins() {
    plugins.forEach(function (plugin) {
      if (typeof plugin.tick === 'function' && plugin._ctx) {
        try { plugin.tick(plugin._ctx); } catch (e) {}
      }
    });
    updateBadge();
  }

  function startTicking() {
    if (tickTimer) clearInterval(tickTimer);
    tickPlugins();
    tickTimer = setInterval(tickPlugins, 30000);
  }

  /* ---------- Icon badge (iOS 16.4+ installed PWAs, desktop Chrome/Edge) ---------- */

  function updateBadge() {
    if (!('setAppBadge' in navigator)) return;
    var total = 0;
    plugins.forEach(function (plugin) {
      if (typeof plugin.badgeCount === 'function' && plugin._ctx) {
        try { total += plugin.badgeCount(plugin._ctx) || 0; } catch (e) {}
      }
    });
    // iOS rejects without notification permission — harmless, so always try.
    if (total > 0) {
      navigator.setAppBadge(total).catch(function () {});
    } else {
      navigator.clearAppBadge().catch(function () {});
    }
  }

  function initBadgeButton() {
    var btn = document.getElementById('badge-enable');
    if (!btn) return;
    var anyBadgePlugin = plugins.some(function (p) { return typeof p.badgeCount === 'function'; });
    var supported = 'setAppBadge' in navigator && typeof Notification !== 'undefined';
    if (!anyBadgePlugin || !supported || Notification.permission !== 'default') return;

    btn.hidden = false;
    btn.addEventListener('click', function () {
      Notification.requestPermission().then(function (result) {
        btn.hidden = true;
        if (result === 'granted') {
          updateBadge();
          toast('Icon badge enabled');
        }
      });
    });
  }

  /* ---------- Install hint (iOS Safari, not yet installed) ---------- */

  function isStandalone() {
    return navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }

  function initInstallHint() {
    var hint = document.getElementById('install-hint');
    if (!hint) return;

    var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var dismissed = false;
    try { dismissed = localStorage.getItem(HINT_KEY) === '1'; } catch (e) {}

    if (!isIOS || isStandalone() || dismissed) return;

    hint.hidden = false;
    document.getElementById('install-hint-dismiss').addEventListener('click', function () {
      hint.hidden = true;
      try { localStorage.setItem(HINT_KEY, '1'); } catch (e) {}
    });
  }

  /* ---------- Toast ---------- */

  var toastTimer = null;

  function toast(message) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    el.classList.add('toast--show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('toast--show');
      toastTimer = setTimeout(function () { el.hidden = true; }, 300);
    }, 2200);
  }

  /* ---------- URL actions (iOS Shortcuts integration) ----------
   * e.g. index.html?action=log&plugin=claude&n=1 logs a prompt on launch,
   * so a Shortcut / Action-button automation can log with one tap. */

  function handleUrlActions() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
    var action = params.get('action');
    if (!action) return;

    // Clean the URL so a reload doesn't repeat the action.
    try { history.replaceState(null, '', window.location.pathname); } catch (e) {}

    var pluginId = params.get('plugin') || (plugins[0] && plugins[0].id);
    var plugin = plugins.filter(function (p) { return p.id === pluginId; })[0];
    if (plugin && typeof plugin.handleAction === 'function' && plugin._ctx) {
      try { plugin.handleAction(plugin._ctx, action, params); } catch (e) {}
      updateBadge();
    }
  }

  /* ---------- Offline indicator ---------- */

  function updateOnlineStatus() {
    var badge = document.getElementById('offline-badge');
    if (badge) badge.hidden = navigator.onLine;
  }

  /* ---------- Service worker ---------- */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').catch(function () {
      /* offline or unsupported — app still works, just not cached */
    });
  }

  /* ---------- Boot ---------- */

  function start() {
    applyTheme(getTheme());

    document.getElementById('theme-toggle').addEventListener('click', cycleTheme);
    document.getElementById('app-version').textContent = 'v' + VERSION;

    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    updateOnlineStatus();

    // Refresh countdowns when the PWA is brought back to the foreground.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) tickPlugins();
    });

    mountPlugins();
    handleUrlActions();
    startTicking();
    initInstallHint();
    initBadgeButton();
    initCorsProxyPanel();
    initConfigTransferButtons();
    registerServiceWorker();

    // Ask the browser not to evict our data under storage pressure.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () {});
    }
  }

  /* ---------- Shared formatting helpers for plugins ---------- */

  function formatDuration(ms) {
    if (ms <= 0) return 'now';
    var totalMinutes = Math.ceil(ms / 60000);
    var days = Math.floor(totalMinutes / 1440);
    var hours = Math.floor((totalMinutes % 1440) / 60);
    var minutes = totalMinutes % 60;
    if (days > 0) return days + 'd ' + hours + 'h';
    if (hours > 0) return hours + 'h ' + minutes + 'm';
    return minutes + 'm';
  }

  /* Share text via the native sheet, falling back to the clipboard. */
  function share(text) {
    if (navigator.share) {
      return navigator.share({ text: text }).catch(function () {});
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () {
        toast('Copied to clipboard');
      }).catch(function () {});
    }
    return Promise.resolve();
  }

  window.AIUsage = {
    version: VERSION,
    registerPlugin: registerPlugin,
    formatDuration: formatDuration,
    toast: toast,
    share: share,
    start: start,
    corsProxy: {
      getConfig: loadCorsProxyConfig,
      wrap: corsProxyUrl,
      fetchOptions: corsProxyFetchOptions,
      headers: corsProxyHeaders
    }
  };
})();
