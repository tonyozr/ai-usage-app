/*
 * GitHub Copilot plugin for AI Usage — stub.
 *
 * GitHub has no API — documented or otherwise official — that returns an
 * individual's own Copilot premium-request quota/usage. The only real
 * Copilot data the REST API exposes is org/enterprise engagement metrics
 * (GET /orgs/{org}/copilot/metrics), which needs an org-admin token and
 * isn't a personal usage limit at all. Rather than fake numbers or scrape
 * github.com's authenticated web UI, this plugin stays a stub until a real
 * per-user data source exists.
 */
(function () {
  'use strict';

  AIUsage.registerPlugin({
    id: 'copilot',
    name: 'GitHub Copilot',

    render: function (ctx) {
      ctx.root.innerHTML =
        '<div class="plugin-card__header">' +
          '<div class="plugin-card__logo">Ⓒ</div>' +
          '<div>' +
            '<h2 class="plugin-card__title">GitHub Copilot</h2>' +
            '<p class="plugin-card__subtitle">Not available yet</p>' +
          '</div>' +
        '</div>' +
        '<p class="empty-note">GitHub does not provide an API for an individual account’s ' +
        'own Copilot usage or premium-request quota — that data only exists in the ' +
        'github.com web UI. This card will show real usage as soon as GitHub exposes one.</p>';
    }
  });
})();
