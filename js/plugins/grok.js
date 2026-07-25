/*
 * Grok plugin for AI Usage — real data via grok.com's internal billing RPC.
 *
 * There's no documented usage API, but the account settings surface calls
 * a real, working gRPC-Web endpoint to render it:
 *   POST https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig
 * authenticated with either a grok.com session cookie (cookie names `sso` /
 * `sso-rw`) or the OAuth access token `grok login` stores in
 * ~/.grok/auth.json. This is the same technique CodexBar's Grok provider
 * uses for its web-billing fallback (it also supports a local `grok agent
 * stdio` JSON-RPC path, but that needs a local process — not available to
 * a static PWA).
 *
 * The response is gRPC-Web: length-prefixed frames of raw protobuf bytes,
 * with a final "trailer" frame carrying grpc-status as text. This plugin
 * hand-parses just enough of that (varint/fixed32 field scanning) to pull
 * the usage percent and reset timestamp out, mirroring CodexBar's
 * GrokWebBillingFetcher field-shape heuristics field-for-field.
 *
 * grok.com sends no CORS headers for this endpoint, so it always needs the
 * CORS proxy, for both the (binary) request body and the custom headers.
 *
 * Credentials and snapshots are stored only on this device (localStorage).
 */
(function () {
  'use strict';

  var BILLING_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';

  var DEFAULTS = {
    cookie: '',
    token: '',
    snap: null // { fetchedAt, usedPercent, resetsAt, error }
  };

  function now() { return Date.now(); }

  function loadState(ctx) {
    return Object.assign({}, DEFAULTS, ctx.store.load({}));
  }

  function clampPct(n) {
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  /* ---------- Minimal protobuf / gRPC-Web parsing (mirrors CodexBar's GrokWebBillingFetcher) ---------- */

  function readVarint(bytes, state) {
    var shift = 0, result = 0;
    for (;;) {
      if (state.i >= bytes.length) return null;
      var b = bytes[state.i]; state.i++;
      result += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) return null;
    }
  }

  function looksLikeProtobuf(bytes) {
    if (!bytes.length) return false;
    var first = bytes[0];
    var fieldNumber = first >> 3;
    var wireType = first & 0x07;
    return fieldNumber > 0 && (wireType === 0 || wireType === 1 || wireType === 2 || wireType === 5);
  }

  function scanProtobuf(bytes, start, end, depth, path, orderRef) {
    var fixed32Fields = [];
    var varintFields = [];
    var i = start;

    while (i < end) {
      var fieldStart = i;
      var keyState = { i: i };
      var key = readVarint(bytes, keyState);
      if (key === null || key === 0) { i = fieldStart + 1; continue; }
      i = keyState.i;
      var fieldNumber = Math.floor(key / 8);
      var wireType = key % 8;
      var fieldPath = path.concat([fieldNumber]);

      if (wireType === 0) {
        var vState = { i: i };
        var v = readVarint(bytes, vState);
        if (v === null) { i = fieldStart + 1; continue; }
        i = vState.i;
        varintFields.push({ path: fieldPath, value: v });
      } else if (wireType === 1) {
        if (i + 8 > end) break;
        i += 8;
      } else if (wireType === 2) {
        var lState = { i: i };
        var len = readVarint(bytes, lState);
        if (len === null || lState.i + len > end) { i = fieldStart + 1; continue; }
        i = lState.i;
        var subStart = i, subEnd = i + len;
        if (depth < 4) {
          var nested = scanProtobuf(bytes, subStart, subEnd, depth + 1, fieldPath, orderRef);
          fixed32Fields = fixed32Fields.concat(nested.fixed32Fields);
          varintFields = varintFields.concat(nested.varintFields);
        }
        i = subEnd;
      } else if (wireType === 5) {
        if (i + 4 > end) break;
        var dv = new DataView(bytes.buffer, bytes.byteOffset + i, 4);
        var floatVal = dv.getFloat32(0, true);
        fixed32Fields.push({ path: fieldPath, value: floatVal, order: orderRef.n });
        orderRef.n++;
        i += 4;
      } else {
        i = fieldStart + 1;
      }
    }
    return { fixed32Fields: fixed32Fields, varintFields: varintFields };
  }

  function parseFrames(bytes) {
    var frames = [];
    var i = 0;
    while (i < bytes.length) {
      if (i + 5 > bytes.length) return null;
      var flags = bytes[i];
      var length = (bytes[i + 1] * 16777216) + (bytes[i + 2] * 65536) + (bytes[i + 3] * 256) + bytes[i + 4];
      var start = i + 5, end = start + length;
      if (length < 0 || end > bytes.length) return null;
      frames.push({ isTrailer: (flags & 0x80) !== 0, data: bytes.subarray(start, end) });
      i = end;
    }
    return frames;
  }

  function decodeUtf8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function trailerFields(bytes) {
    var fields = {};
    var frames = parseFrames(bytes) || [];
    frames.forEach(function (f) {
      if (!f.isTrailer) return;
      var text = decodeUtf8(f.data);
      text.split(/\r?\n/).forEach(function (line) {
        var idx = line.indexOf(':');
        if (idx === -1) return;
        var k = line.slice(0, idx).trim().toLowerCase();
        var v = line.slice(idx + 1).trim();
        try { v = decodeURIComponent(v); } catch (e) { /* leave as-is */ }
        fields[k] = v;
      });
    });
    return fields;
  }

  function parseGrpcWebResponse(bytes, nowMs) {
    var frames = parseFrames(bytes);
    var payloads = frames ? frames.filter(function (f) { return !f.isTrailer; }).map(function (f) { return f.data; }) : [];
    if (payloads.length === 0 && looksLikeProtobuf(bytes)) payloads = [bytes];
    if (payloads.length === 0) throw new Error('Grok billing returned no usable data.');

    var fixed32Fields = [], varintFields = [];
    var orderRef = { n: 0 };
    payloads.forEach(function (p) {
      var scan = scanProtobuf(p, 0, p.length, 0, [], orderRef);
      fixed32Fields = fixed32Fields.concat(scan.fixed32Fields);
      varintFields = varintFields.concat(scan.varintFields);
    });

    var percentCandidates = fixed32Fields.filter(function (f) {
      return f.path[f.path.length - 1] === 1 && isFinite(f.value) && f.value >= 0 && f.value <= 100;
    }).sort(function (a, b) {
      return a.path.length !== b.path.length ? a.path.length - b.path.length : a.order - b.order;
    });
    var parsedPercent = percentCandidates.length ? percentCandidates[0].value : null;

    var resetFields = varintFields
      .filter(function (f) { return f.value >= 1700000000 && f.value <= 2100000000; })
      .map(function (f) { return { path: f.path, date: f.value * 1000 }; });
    var futureResetFields = resetFields.filter(function (f) { return f.date > nowMs; });
    var pathMatch = futureResetFields.filter(function (f) {
      return f.path.length === 3 && f.path[0] === 1 && f.path[1] === 5 && f.path[2] === 1;
    });
    var resetCandidates = pathMatch.length ? pathMatch : futureResetFields;
    var reset = resetCandidates.length
      ? resetCandidates.reduce(function (min, f) { return (min === null || f.date < min) ? f.date : min; }, null)
      : null;

    var hasUsagePeriod = varintFields.some(function (f) {
      return (f.path.length >= 2 && f.path[0] === 1 && f.path[1] === 6) ||
        (f.path.length === 3 && f.path[0] === 1 && f.path[1] === 8 && f.path[2] === 1 && (f.value === 1 || f.value === 2));
    });
    var noUsageYet = parsedPercent === null && fixed32Fields.length === 0 && reset !== null && hasUsagePeriod;
    var percent = parsedPercent !== null ? parsedPercent : (noUsageYet ? 0 : null);
    if (percent === null) throw new Error('Could not parse Grok usage from the response.');

    return { usedPercent: percent, resetsAt: reset ? new Date(reset).toISOString() : null };
  }

  function isAuthFailure(status, message) {
    if (status === 16) return true;
    if (status !== 7) return false;
    var lower = (message || '').toLowerCase();
    return lower.indexOf('bad-credentials') !== -1 ||
      lower.indexOf('unauthenticated') !== -1 ||
      (lower.indexOf('oauth2') !== -1 && lower.indexOf('could not be validated') !== -1) ||
      (lower.indexOf('access token') !== -1 &&
        (lower.indexOf('invalid') !== -1 || lower.indexOf('expired') !== -1 || lower.indexOf('could not be validated') !== -1));
  }

  /* ---------- Fetch ---------- */

  function refresh(ctx, plugin) {
    var state = loadState(ctx);
    if (!state.cookie && !state.token) {
      AIUsage.toast('Add a session cookie or access token in Settings first');
      return;
    }
    if (!AIUsage.corsProxy.getConfig().url) {
      AIUsage.toast('Set a CORS proxy in the app footer first — required for Grok');
      return;
    }

    var statusEl = ctx.root.querySelector('[data-role="status"]');
    if (statusEl) statusEl.textContent = 'Refreshing…';

    var headers = Object.assign({
      'Accept': '*/*',
      'Content-Type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
      'x-user-agent': 'connect-es/2.1.1'
    }, AIUsage.corsProxy.headers());
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    if (state.cookie) headers['X-Cors-Proxy-Set-Cookie'] = state.cookie;

    fetch(AIUsage.corsProxy.wrap(BILLING_URL), Object.assign({
      method: 'POST',
      headers: headers,
      body: new Uint8Array([0, 0, 0, 0, 0])
    }, AIUsage.corsProxy.fetchOptions())).then(function (res) {
      return res.arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }
        var trailers = trailerFields(bytes);
        var grpcStatus = trailers['grpc-status'] != null ? parseInt(trailers['grpc-status'], 10) : null;
        if (grpcStatus) {
          var msg = trailers['grpc-message'] || '';
          throw new Error(isAuthFailure(grpcStatus, msg)
            ? 'Grok rejected the credentials — sign in to grok.com again or run `grok login`'
            : ('Grok billing error ' + grpcStatus + (msg ? ': ' + msg : '')));
        }
        var snap = parseGrpcWebResponse(bytes, now());
        var s = loadState(ctx);
        s.snap = { fetchedAt: now(), usedPercent: snap.usedPercent, resetsAt: snap.resetsAt, error: null };
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
          '<label for="grok-cookie">Session cookie</label>' +
          '<input id="grok-cookie" type="password" placeholder="sso=..." autocomplete="off">' +
        '</div>' +
        '<div class="field">' +
          '<label for="grok-token">Access token</label>' +
          '<input id="grok-token" type="password" placeholder="optional: from ~/.grok/auth.json" autocomplete="off">' +
        '</div>' +
        '<p class="plugin-note">Unofficial: this calls grok.com\'s internal billing RPC, since there\'s no ' +
        'documented usage API. Either sign in to grok.com in a browser and copy the <code>sso</code> (or ' +
        '<code>sso-rw</code>) cookie value, or run <code>grok login</code> and copy the <code>key</code> field ' +
        'from <code>~/.grok/auth.json</code> as the access token — either works, and both can be set at once. ' +
        'Requires a <a href="#" data-action="open-cors-proxy">CORS proxy</a> to be configured, since grok.com ' +
        'sends no CORS headers and browsers won’t let a page set a real Cookie header. Credentials are stored ' +
        'only on this device and only ever sent to your own proxy.</p>' +
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
        '<div class="plugin-card__logo">𝕏</div>' +
        '<div>' +
          '<h2 class="plugin-card__title">Grok</h2>' +
          '<p class="plugin-card__subtitle">Billing usage · scraped from grok.com</p>' +
        '</div>' +
      '</div>' +
      '<div id="grok-meters"></div>' +
      '<div class="controls">' +
        '<button type="button" class="btn btn--primary" data-action="refresh">Refresh</button>' +
        '<button type="button" class="btn btn--ghost" data-action="share">Share stats</button>' +
      '</div>' +
      '<p class="plugin-note" data-role="status"></p>' +
      settingsHtml(state);

    var cookieInput = ctx.root.querySelector('#grok-cookie');
    if (cookieInput) cookieInput.value = state.cookie;
    var tokenInput = ctx.root.querySelector('#grok-token');
    if (tokenInput) tokenInput.value = state.token;

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
    var container = ctx.root.querySelector('#grok-meters');
    if (!container) return;

    if (!state.snap || typeof state.snap.usedPercent !== 'number') {
      container.innerHTML = '<p class="empty-note">' + (state.cookie || state.token
        ? 'No data yet — tap Refresh to fetch your Grok usage.'
        : 'Add a session cookie or access token in Settings, then tap Refresh.') + '</p>';
      return;
    }

    container.innerHTML = meterHtml('grok-usage', 'Monthly usage');
    var p = clampPct(state.snap.usedPercent);
    updateMeter(ctx.root.querySelector('#grok-usage'), p, p + '% used', resetCountdown(state.snap.resetsAt));
  }

  function summaryText(state) {
    var lines = ['Grok usage'];
    if (state.snap && typeof state.snap.usedPercent === 'number') {
      lines.push('Monthly usage: ' + clampPct(state.snap.usedPercent) + '%');
    }
    return lines.join('\n');
  }

  /* ---------- Plugin ---------- */

  AIUsage.registerPlugin({
    id: 'grok',
    name: 'Grok',

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
          if (!confirm('Clear all Grok data (including stored credentials)?')) return;
          ctx.store.save(Object.assign({}, DEFAULTS));
          rebuild(ctx, self);
        }
      });

      ctx.root.addEventListener('change', function (e) {
        var s = loadState(ctx);
        switch (e.target.id) {
          case 'grok-cookie':
            s.cookie = e.target.value.trim();
            break;
          case 'grok-token':
            s.token = e.target.value.trim();
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
