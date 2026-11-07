/**
 * EchoText — 404 page
 */
(function (App) {
  'use strict';

  const icon = App.icon;
  const t = (text) => App.utils.escapeHtml(App.t(text));

  App.pages.notFound = {
    id: 'not-found',
    get title() {
      return App.t('Page not found');
    },
    render(view) {
      view.innerHTML = `
        <section class="container not-found">
          <div class="not-found-code gradient-text">404</div>
          <h1 style="margin-top:8px;font-size:28px">${t('This page is silent')}</h1>
          <p>${t('The page you’re looking for doesn’t exist or has moved.')}</p>
          <div class="not-found-actions">
            <a class="btn btn-primary" href="#/">${icon('audio-lines', 17)} ${t('Back to the studio')}</a>
            <a class="btn btn-outline" href="#/?section=history">${icon('history', 17)} ${t('Audio history')}</a>
          </div>
        </section>`;
    },
  };
})(window.VoiceAI = window.VoiceAI || {});
