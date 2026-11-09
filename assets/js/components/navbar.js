/**
 * EchoText — Navbar
 * Sticky glass bar: the logo, the interface language (English / ខ្មែរ),
 * and the dark / light switch.
 */
(function (App) {
  'use strict';

  const { $, $$, escapeHtml, prefersReducedMotion } = App.utils;
  const icon = App.icon;
  const t = (text, params) => App.t(text, params);

  let root = null;
  let wanted = null; // the language a switch still on its way is heading to
  let transitions = 0; // stale snapshot callbacks must not overwrite a newer choice
  let activeTransition = null;
  let fadeTimer = null;
  let pendingTheme = null;

  const currentTheme = () => App.Theme.resolve(App.Settings.get().theme);

  function clearMotion() {
    document.documentElement.classList.remove('is-switching-language', 'is-switching-theme', 'is-theme-fading');
    document.getElementById('main')?.classList.remove('is-language-fading');
    ['--theme-x', '--theme-y', '--theme-radius'].forEach((key) => document.documentElement.style.removeProperty(key));
  }

  function interruptTransition() {
    transitions++;
    if (activeTransition) activeTransition.skipTransition();
    activeTransition = null;
    clearTimeout(fadeTimer);
    fadeTimer = null;
    clearMotion();
  }

  function watchTransition(transition, id) {
    activeTransition = transition;
    const finish = () => {
      if (id !== transitions) return;
      activeTransition = null;
      clearMotion();
    };
    // A skipped snapshot can reject ready even though its update callback still runs.
    transition.ready.catch(() => {});
    transition.updateCallbackDone.catch(() => {});
    transition.finished.then(finish, finish);
  }

  function commitTheme() {
    const next = pendingTheme;
    pendingTheme = null;
    if (!next) return true;
    try {
      App.Settings.update({ theme: next });
      return true;
    } catch (err) {
      App.toast.error(err.message);
      return false;
    }
  }

  /** Reveal the new palette from the toggle, without redrawing or interrupting the studio. */
  function switchTheme(button) {
    const next = (pendingTheme || currentTheme()) === 'dark' ? 'light' : 'dark';
    interruptTransition();
    applyLanguage(); // settle a language choice before taking the theme snapshot
    pendingTheme = next;
    if (next === currentTheme()) { pendingTheme = null; return; }
    if (prefersReducedMotion()) { commitTheme(); return; }

    const html = document.documentElement;
    const id = ++transitions;
    if (typeof document.startViewTransition === 'function') {
      const rect = button.getBoundingClientRect();
      const width = window.innerWidth;
      const height = window.innerHeight;
      const x = Math.max(0, Math.min(width, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(height, rect.top + rect.height / 2));
      html.style.setProperty('--theme-x', `${x}px`);
      html.style.setProperty('--theme-y', `${y}px`);
      html.style.setProperty('--theme-radius', `${Math.hypot(Math.max(x, width - x), Math.max(y, height - y)) + 2}px`);
      html.classList.add('is-switching-theme');
      try {
        const transition = document.startViewTransition(() => {
          if (id === transitions) commitTheme();
        });
        watchTransition(transition, id);
        return;
      } catch {
        clearMotion();
      }
    }
    html.classList.add('is-theme-fading');
    if (!commitTheme()) { clearMotion(); return; }
    fadeTimer = setTimeout(() => {
      if (id === transitions) clearMotion();
      fadeTimer = null;
    }, 650);
  }

  /** The button shows the look it switches to: a sun in dark mode, a moon in light mode. */
  function paintToggle() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    const toggle = $('[data-theme-toggle]', root);
    if (!toggle.querySelector('.theme-icon')) {
      toggle.innerHTML = `<span class="theme-icon theme-icon-sun" aria-hidden="true">${icon('sun', 19)}</span><span class="theme-icon theme-icon-moon" aria-hidden="true">${icon('moon', 19)}</span>`;
    }
    toggle.setAttribute('aria-label', t(next === 'light' ? 'Switch to light mode' : 'Switch to dark mode')); // no tooltip: nothing pops up on hover
  }

  /** Labels for screen readers, in the interface language (nothing visible changes). */
  function relabel() {
    $('.nav', root).setAttribute('aria-label', t('Main'));
    $('.brand', root).setAttribute('aria-label', t('EchoText home'));
    $('.lang-switch', root).setAttribute('aria-label', t('Interface language'));
    $('[data-models-open]', root).setAttribute('aria-label', t('Models & storage'));
    $('[data-models-open]', root).dataset.tooltip = t('Models & storage');
    paintToggle();
  }

  /** Moves the highlight under a language. It glides there (see .lang-thumb in features.css). */
  function markLanguage(code) {
    const languages = App.i18n.languages;
    const group = $('.lang-switch', root);
    group.style.setProperty('--lang-count', languages.length);
    group.style.setProperty('--lang-index', Math.max(0, languages.findIndex((lang) => lang.code === code)));
    $$('[data-ui-language]', root).forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.uiLanguage === code)));
  }

  function render() {
    root.innerHTML = `
      <nav class="nav container">
        <a href="#/" class="brand">${App.logo(34)}<span class="brand-name">Echo<span>Text</span></span></a>
        <div class="nav-actions">
          <div class="lang-switch" role="group">
            <span class="lang-thumb" aria-hidden="true"></span>
            ${App.i18n.languages.map((lang) => `<button type="button" class="lang-option" data-ui-language="${lang.code}" lang="${lang.code}">${escapeHtml(lang.code === 'en' ? 'EN' : lang.native)}</button>`).join('')}
          </div>
          <button class="nav-button" type="button" data-models-open aria-haspopup="dialog">${icon('database', 19)}</button>
          <button class="nav-button theme-toggle" type="button" data-theme-toggle></button>
        </div>
      </nav>`;
    markLanguage(App.i18n.language);
    relabel();
  }

  /**
   * Runs a redraw of the page as a crossfade: a view transition where the browser has them,
   * otherwise a quick fade of the page out and back in. With reduced motion it simply happens.
   */
  function crossfade(update) {
    if (prefersReducedMotion()) {
      update();
      return;
    }
    const html = document.documentElement;
    const id = ++transitions;
    if (typeof document.startViewTransition === 'function') {
      html.classList.add('is-switching-language'); // lets the language switch animate live above the fade
      try {
        const transition = document.startViewTransition(() => {
          if (id === transitions) update();
        });
        watchTransition(transition, id);
        return;
      } catch {
        clearMotion();
      }
    }
    const main = document.getElementById('main');
    main.classList.add('is-language-fading');
    fadeTimer = setTimeout(() => {
      if (id !== transitions) return;
      update();
      main.classList.remove('is-language-fading'); // fades back in, now in the other language
      fadeTimer = null;
    }, 140);
  }

  /** Redraws the interface in the language picked last (clicks during a switch just change the target). */
  function applyLanguage() {
    const code = wanted;
    wanted = null;
    if (!code || code === App.i18n.language) return;
    App.i18n.set(code);
    relabel();
    if (App.router) App.router.resolve({ force: true, instant: true }); // stays where you were reading
  }

  /** Switches the interface language: the highlight slides over and the page crossfades into it. */
  function setLanguage(code) {
    if (code === (wanted || App.i18n.language)) return;
    try {
      App.Settings.update({ uiLanguage: code }); // save before changing the interface
    } catch (err) {
      App.toast.error(err.message);
      return;
    }
    const switching = wanted !== null;
    if (!switching) {
      interruptTransition();
      commitTheme(); // a theme click still waiting for its snapshot must not get lost
    }
    markLanguage(code);
    wanted = code;
    if (!switching) crossfade(applyLanguage);
  }

  App.components.Navbar = {
    mount(element) {
      root = element;
      render();
      root.addEventListener('click', (event) => {
        if (event.target.closest('[data-models-open]')) {
          App.components.ModelsPanel.open();
          return;
        }
        const theme = event.target.closest('[data-theme-toggle]');
        if (theme) {
          switchTheme(theme);
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
