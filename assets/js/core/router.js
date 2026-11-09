/**
 * EchoText — Hash router
 * Routes look like `#/path?query`. Pages are plain objects:
 *   { id, title, render(view, ctx), onSection?(id), unmount?() }
 * `?section=<id>` scrolls to an element on the page instead of the top.
 */
(function (App) {
  'use strict';

  const { scrollToId } = App.utils;

  /**
   * Shows a freshly drawn page as it already looked: scroll reveals are done and entry animations
   * (the page fade, rows sliding in…) skip to their end. Endless ones, like spinners, keep going.
   */
  function settle(view) {
    App.utils.$$('[data-reveal]', view).forEach((el) => el.classList.add('is-revealed'));
    if (typeof view.getAnimations !== 'function') return;
    view.getAnimations({ subtree: true }).forEach((animation) => {
      const timing = animation.effect && animation.effect.getComputedTiming();
      if (timing && timing.endTime !== Infinity) animation.finish();
    });
  }

  class Router {
    constructor(outlet) {
      this.outlet = outlet;
      this.routes = new Map();
      this.current = null;
    }

    register(path, page) {
      this.routes.set(path, page);
      return this;
    }

    parse() {
      const hash = window.location.hash.replace(/^#/, '') || '/';
      const separator = hash.indexOf('?');
      const rawPath = separator < 0 ? hash : hash.slice(0, separator);
      const search = separator < 0 ? '' : hash.slice(separator + 1);
      const path = `/${rawPath.replace(/^\/+|\/+$/g, '')}`;
      return { path, query: new URLSearchParams(search), search };
    }

    navigate(path) {
      const target = `#${path}`;
      if (window.location.hash === target) this.resolve({ force: true });
      else window.location.hash = path;
    }

    start() {
      window.addEventListener('hashchange', () => this.resolve());
      this.resolve();
    }

    /**
     * @param {{force?: boolean, instant?: boolean}} options
     *   force:   redraw even if the route is unchanged
     *   instant: redraw in place (switching the interface language): the page keeps its scroll
     *            position and shows up as it already was, without replaying entry animations
     */
    resolve({ force = false, instant = false } = {}) {
      const { path, query, search } = this.parse();
      const section = query.get('section');
      const page = this.routes.get(path) || this.routes.get('*');

      if (this.current && this.current.page === page && this.current.path === path && !force) {
        if (this.current.search === search) return;
        // Adding, changing or removing a section anchor keeps the mounted studio,
        // including its active generation and player. Other query changes may
        // affect a page's content, so those still render the page again.
        const previous = new URLSearchParams(this.current.search);
        const next = new URLSearchParams(search);
        previous.delete('section');
        next.delete('section');
        previous.sort();
        next.sort();
        if (previous.toString() === next.toString()) {
          this.current.search = search;
          if (section) this._scrollToSection(page, section);
          else window.scrollTo(0, 0);
          App.bus.emit('route:change', { path, query });
          return;
        }
      }

      if (this.current && this.current.page.unmount) {
        try {
          this.current.page.unmount();
        } catch (err) {
          console.error('[EchoText] unmount failed', err);
        }
      }
      App.Playback.stopAll();

      const scrollY = window.scrollY;
      const view = document.createElement('div');
      view.className = `page page-${page.id}`;
      this.outlet.replaceChildren(view);
      this.current = { page, path, search };

      try {
        page.render(view, { path, query, router: this });
      } catch (err) {
        console.error('[EchoText] render failed', err);
        view.innerHTML = '<section class="container not-found"><h1>Something went wrong</h1><p>Please reload the page.</p></section>';
      }

      document.title = page.title ? `${page.title} · EchoText` : 'EchoText — Turn Your Text Into Natural Voice';
      App.bus.emit('route:change', { path, query });
      if (instant) {
        settle(view);
        window.scrollTo(0, scrollY);
        return;
      }
      App.reveal.observe(view);

      if (section) {
        requestAnimationFrame(() => this._scrollToSection(page, section, true));
      } else {
        window.scrollTo(0, 0);
      }
    }

    _scrollToSection(page, section, instant) {
      const target = document.getElementById(section);
      if (!target) return;
      if (instant) {
        // Reveal everything above the target so the layout doesn't shift mid-scroll.
        App.utils.$$('[data-reveal]', this.outlet).forEach((el) => {
          if (el.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) el.classList.add('is-revealed');
        });
      }
      scrollToId(section);
      if (page.onSection) page.onSection(section);
    }
  }

  App.Router = Router;
})(window.VoiceAI = window.VoiceAI || {});
