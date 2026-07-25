/*
 * JetBrains plugin for AI Usage — real data from a local quota file.
 *
 * Unlike every other plugin here, JetBrains AI Assistant's quota isn't
 * behind any network endpoint at all — there's no API, documented or
 * otherwise. The IDE itself writes its current quota numbers to a local
 * XML file whenever AI Assistant is used:
 *
 *   macOS:   ~/Library/Application Support/JetBrains/<IDE><version>/options/AIAssistantQuotaManager2.xml
 *   Windows: %APPDATA%\JetBrains\<IDE><version>\options\AIAssistantQuotaManager2.xml
 *   Linux:   ~/.config/JetBrains/<IDE><version>/options/AIAssistantQuotaManager2.xml
 *
 * (same file CodexBar's JetBrains provider reads). A static PWA can't read
 * an arbitrary local path on its own, but the browser's native file picker
 * can — so "Refresh" here means "pick the file again": there's no way to
 * watch a local file for changes from a web page, so each refresh is a
 * manual re-select. No CORS proxy, no network request, no credentials —
 * the file never leaves this device.
 *
 * The file's <component name="AIAssistantQuotaManager2"> holds two options
 * whose `value` attribute is itself a JSON string: `quotaInfo` (type,
 * current, maximum, until, tariffQuota.available) and `nextRefill` (next,
 * amount, duration). DOMParser decodes the XML-entity-escaped JSON for us,
 * so it's a plain JSON.parse() once extracted.
 */
(function () {
  'use strict';

  var DEFAULTS = {
    fileName: '',
    snap: null // { fetchedAt, usedPercent, resetsAt, quotaType, error }
  };

  function now() { return Date.now(); }

  function loadState(ctx) {
    return Object.assign({}, DEFAULTS, ctx.store.load({}));
  }

  function clampPct(n) {
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  /* ---------- Quota file parsing (mirrors CodexBar's JetBrainsStatusProbe) ---------- */

  function findOptionValue(doc, optionName) {
    var options = doc.querySelectorAll(
      'component[name="AIAssistantQuotaManager2"] > option[name="' + optionName + '"]');
    if (!options.length) return null;
    return options[0].getAttribute('value');
  }

  function parseQuotaInfo(jsonString) {
    var json = JSON.parse(jsonString);
    var current = parseFloat(json.current);
    var maximum = parseFloat(json.maximum);
    var used = isFinite(current) ? current : 0;
    var max = isFinite(maximum) ? maximum : 0;
    var tariffQuota = json.tariffQuota || {};
    var availableRaw = parseFloat(tariffQuota.available);
    var available = isFinite(availableRaw) ? availableRaw : Math.max(0, max - used);
    return {
      type: json.type || null,
      used: used,
      maximum: max,
      available: available,
      until: json.until || null,
      usedPercent: max > 0 ? Math.min(100, Math.max(0, (used / max) * 100)) : 0
    };
  }

  function parseRefillInfo(jsonString) {
    var json = JSON.parse(jsonString);
    var tariff = json.tariff || {};
    return {
      next: json.next || null,
      amount: json.amount != null ? json.amount : tariff.amount,
      duration: json.duration || tariff.duration || null
    };
  }

  function parseQuotaFile(xmlText) {
    var doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('Not a valid XML file');
    }
    var quotaInfoRaw = findOptionValue(doc, 'quotaInfo');
    if (!quotaInfoRaw) {
      throw new Error('No quota information found — enable AI Assistant and use it at least once first');
    }
    var quotaInfo = parseQuotaInfo(quotaInfoRaw);

    var refillInfo = null;
    var nextRefillRaw = findOptionValue(doc, 'nextRefill');
    if (nextRefillRaw) {
      try { refillInfo = parseRefillInfo(nextRefillRaw); } catch (e) { /* optional */ }
    }

    return {
      usedPercent: quotaInfo.usedPercent,
      quotaType: quotaInfo.type,
      resetsAt: refillInfo && refillInfo.next ? refillInfo.next : null
    };
  }

  /* ---------- File picking ---------- */

  function loadFromFile(ctx, plugin, file) {
    if (!file) return;
    var statusEl = ctx.root.querySelector('[data-role="status"]');
    if (statusEl) statusEl.textContent = 'Reading…';

    var reader = new FileReader();
    reader.onload = function () {
      var s = loadState(ctx);
      try {
        var parsed = parseQuotaFile(String(reader.result));
        s.fileName = file.name;
        s.snap = {
          fetchedAt: now(),
          usedPercent: parsed.usedPercent,
          resetsAt: parsed.resetsAt,
          quotaType: parsed.quotaType,
          error: null
        };
        ctx.store.save(s);
        plugin.tick(ctx);
        AIUsage.toast('Usage updated');
      } catch (err) {
        s.snap = Object.assign({ fetchedAt: null }, s.snap, { error: (err && err.message) || 'Could not parse file' });
        ctx.store.save(s);
        plugin.tick(ctx);
      }
    };
    reader.onerror = function () {
      var s = loadState(ctx);
      s.snap = Object.assign({ fetchedAt: null }, s.snap, { error: 'Could not read file' });
      ctx.store.save(s);
      plugin.tick(ctx);
    };
    reader.readAsText(file);
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
        '<p class="plugin-note">JetBrains AI Assistant has no usage API — its quota only exists in a local ' +
        'file the IDE itself writes: <code>AIAssistantQuotaManager2.xml</code>, under your JetBrains IDE\'s ' +
        '<code>options</code> folder (e.g. on macOS, <code>~/Library/Application Support/JetBrains/&lt;IDE&gt;&lt;version&gt;/options/</code>; ' +
        'on Windows, <code>%APPDATA%\\JetBrains\\&lt;IDE&gt;&lt;version&gt;\\options\\</code>). Tap Refresh and ' +
        'pick that file — nothing is uploaded, it\'s parsed entirely on this device. Since a web page can\'t ' +
        'watch a local file for changes, there\'s no auto-refresh: pick the file again whenever you want current ' +
        'numbers.</p>' +
        (state.fileName ? '<p class="plugin-note">Last file: <code>' + state.fileName + '</code></p>' : '') +
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
        '<div class="plugin-card__logo">◈</div>' +
        '<div>' +
          '<h2 class="plugin-card__title">JetBrains AI</h2>' +
          '<p class="plugin-card__subtitle">' +
            (state.snap && state.snap.quotaType
              ? state.snap.quotaType.charAt(0).toUpperCase() + state.snap.quotaType.slice(1) + ' quota · local file'
              : 'AI Assistant quota · local file') +
          '</p>' +
        '</div>' +
      '</div>' +
      '<div id="jetbrains-meters"></div>' +
      '<div class="controls">' +
        '<button type="button" class="btn btn--primary" data-action="refresh">Refresh</button>' +
        '<button type="button" class="btn btn--ghost" data-action="share">Share stats</button>' +
      '</div>' +
      '<input id="jetbrains-file-input" type="file" accept=".xml" hidden>' +
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
    if (isNaN(left)) return '';
    return left > 0
      ? 'Resets in ' + AIUsage.formatDuration(left)
      : 'Window has reset — refresh for current data';
  }

  function renderMeters(ctx, state) {
    var container = ctx.root.querySelector('#jetbrains-meters');
    if (!container) return;

    if (!state.snap || typeof state.snap.usedPercent !== 'number') {
      container.innerHTML = '<p class="empty-note">Tap Refresh and pick your ' +
        '<code>AIAssistantQuotaManager2.xml</code> file to see your AI credits usage.</p>';
      return;
    }

    container.innerHTML = meterHtml('jetbrains-credits', 'AI credits');
    var p = clampPct(state.snap.usedPercent);
    updateMeter(ctx.root.querySelector('#jetbrains-credits'), p, p + '% used', resetCountdown(state.snap.resetsAt));
  }

  function summaryText(state) {
    var lines = ['JetBrains AI usage'];
    if (state.snap && typeof state.snap.usedPercent === 'number') {
      lines.push('AI credits: ' + clampPct(state.snap.usedPercent) + '%');
    }
    return lines.join('\n');
  }

  /* ---------- Plugin ---------- */

  AIUsage.registerPlugin({
    id: 'jetbrains',
    name: 'JetBrains AI',

    render: function (ctx) {
      var self = this;

      ctx.root.addEventListener('click', function (e) {
        var action = e.target.getAttribute('data-action');
        if (!action) return;

        if (action === 'refresh') {
          var input = ctx.root.querySelector('#jetbrains-file-input');
          if (input) input.click();
          return;
        }
        if (action === 'share') { AIUsage.share(summaryText(loadState(ctx))); return; }
        if (action === 'reset-all') {
          if (!confirm('Clear all JetBrains data?')) return;
          ctx.store.save(Object.assign({}, DEFAULTS));
          rebuild(ctx, self);
        }
      });

      ctx.root.addEventListener('change', function (e) {
        if (e.target.id !== 'jetbrains-file-input') return;
        var file = e.target.files && e.target.files[0];
        loadFromFile(ctx, self, file);
        e.target.value = '';
      });

      rebuild(ctx, this);
    },

    handleAction: function (ctx, action) {
      // No network refresh possible — a launch-URL "refresh" action can't
      // auto-pick a local file, so there's nothing to do here.
      void ctx; void action;
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
