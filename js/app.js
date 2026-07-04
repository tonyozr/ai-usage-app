/*
 * AI Usage — core app.
 * Plugins register themselves via AIUsage.registerPlugin() before start() runs.
 */
(function () {
  'use strict';

  var VERSION = '1.8.0';
  var THEME_KEY = 'aiusage.theme';
  var HINT_KEY = 'aiusage.installHintDismissed';
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
    start: start
  };
})();
