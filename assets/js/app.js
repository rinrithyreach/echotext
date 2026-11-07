/**
 * EchoText — Application bootstrap
 */
(function (App) {
  'use strict';

  function init() {
    App.Theme.init();
    App.i18n.set(App.Settings.get().uiLanguage);
    // Clear out what removed languages and voices left behind: History items and downloaded voices.
    App.History.pruneLanguages();
    if (App.AIVoice.isSupported()) App.AIVoice.prune();
    App.components.Navbar.mount(document.getElementById('navbar'));

    // History and Settings used to be pages of their own: their old links land on the home page.
    const movedTo = (hash) => ({ id: 'moved', title: null, render: () => window.location.replace(hash) });
    const router = new App.Router(document.getElementById('main'));
    router
      .register('/', App.pages.home)
      .register('/history', movedTo('#/?section=history'))
      .register('/settings', movedTo('#/'))
      .register('*', App.pages.notFound);
    App.router = router;

    // Clicking a link to the page you're already on re-scrolls instead of doing nothing.
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[href^="#/"]');
      if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey) return;
      const href = link.getAttribute('href');
      if (href !== window.location.hash) return;
      event.preventDefault();
      const section = new URLSearchParams(href.split('?')[1] || '').get('section');
      if (section) {
        App.utils.scrollToId(section);
        if (router.current && router.current.page.onSection) router.current.page.onSection(section);
      } else {
        window.scrollTo({ top: 0, behavior: App.utils.prefersReducedMotion() ? 'auto' : 'smooth' });
      }
    });

    document.querySelector('[data-skip]').addEventListener('click', (event) => {
      event.preventDefault();
      document.getElementById('main').focus();
    });

    // Stop live speech when the page is closed or reloaded.
    window.addEventListener('pagehide', () => {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    });

    router.start();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.VoiceAI = window.VoiceAI || {});
