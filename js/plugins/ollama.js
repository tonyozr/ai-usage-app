/*
 * Ollama plugin for AI Usage — stub.
 *
 * ollama.com's cloud API has no documented endpoint for an account's own
 * API-key usage, remaining credits, spending limits, or billing, and its
 * responses carry no rate-limit headers (unlike Anthropic's `/v1/*`
 * endpoints). The "usage" fields it does document are per-request token/
 * timing counters (eval_count, prompt_eval_duration, …), not an account
 * quota. Rather than fake numbers, this plugin stays a stub until a real
 * per-account data source exists.
 */
(function () {
  'use strict';

  AIUsage.registerPlugin({
    id: 'ollama',
    name: 'Ollama',

    render: function (ctx) {
      ctx.root.innerHTML =
        '<div class="plugin-card__header">' +
          '<div class="plugin-card__logo">◆</div>' +
          '<div>' +
            '<h2 class="plugin-card__title">Ollama</h2>' +
            '<p class="plugin-card__subtitle">Not available yet</p>' +
          '</div>' +
        '</div>' +
        '<p class="empty-note">ollama.com’s cloud API does not expose an endpoint for your ' +
        'account’s own usage, credits, or spending limits, and its responses carry no ' +
        'rate-limit headers to read instead. This card will show real usage as soon as ' +
        'Ollama exposes one.</p>';
    }
  });
})();
