/**
 * EchoText — Navbar
 * Sticky glass bar: the logo, the interface language (English / ខ្មែរ),
 * and the dark / light switch.
 */
(function (App) {
  'use strict';

  const { $, escapeHtml } = App.utils;
  const icon = App.icon;
  const t = (text, params) => App.t(text, params);

  let root = null;

  const currentTheme = () => App.Theme.resolve(App.Settings.get().theme);

  /** The button shows the look it switches to: a sun in dark mode, a moon in light mode. */
  function paintToggle() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    const toggle = $('[data-theme-toggle]', root);
    toggle.innerHTML = icon(next === 'light' ? 'sun' : 'moon', 19);
    toggle.setAttribute('aria-label', t(next === 'light' ? 'Switch to light mode' : 'Switch to dark mode')); // no tooltip: nothing pops up on hover
  }

  function render() {
    const current = App.i18n.language;
    root.innerHTML = `
      <nav class="nav container" aria-label="${escapeHtml(t('Main'))}">
        <a href="#/" class="brand" aria-label="${escapeHtml(t('EchoText home'))}">${App.logo(34)}<span class="brand-name">Echo<span>Text</span></span></a>
        <div class="nav-actions">
          <div class="lang-switch" role="group" aria-label="${escapeHtml(t('Interface language'))}">
            ${App.i18n.languages.map((lang) => `<button type="button" class="lang-option" data-ui-language="${lang.code}" lang="${lang.code}" aria-pressed="${lang.code === current}">${escapeHtml(lang.code === 'en' ? 'EN' : lang.native)}</button>`).join('')}
          </div>
          <button class="nav-button" type="button" data-theme-toggle></button>
        </div>
      </nav>`;
    paintToggle();
  }

  /** Switches the interface language and redraws the page in it. */
  function setLanguage(code) {
    if (code === App.i18n.language) return;
    App.i18n.set(code);
    App.Settings.update({ uiLanguage: App.i18n.language });
    render();
    const y = window.scrollY;
    if (App.router) App.router.resolve({ force: true });
    window.scrollTo(0, y); // stay where you were reading
    $(`[data-ui-language="${App.i18n.language}"]`, root).focus();
  }

  App.components.Navbar = {
    mount(element) {
      root = element;
      render();
      root.addEventListener('click', (event) => {
        if (event.target.closest('[data-theme-toggle]')) {
          App.Settings.update({ theme: currentTheme() === 'dark' ? 'light' : 'dark' });
          return;
        }
        const language = event.target.closest('[data-ui-language]');
        if (language) setLanguage(language.dataset.uiLanguage);
      });
      App.bus.on('settings:change', ({ patch }) => {
        if ('theme' in patch) paintToggle();
      });

      const onScroll = () => root.classList.toggle('is-scrolled', window.scrollY > 8);
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    },
    render,
  };
})(window.VoiceAI = window.VoiceAI || {});
