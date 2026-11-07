/**
 * EchoText — Scroll reveal
 * Elements with [data-reveal] fade up when they enter the viewport.
 * Optional stagger: style="--reveal-delay: 120ms".
 */
(function (App) {
  'use strict';

  let observer = null;

  App.reveal = {
    observe(root = document) {
      const elements = App.utils.$$('[data-reveal]:not(.is-revealed)', root);
      if (!('IntersectionObserver' in window) || App.utils.prefersReducedMotion()) {
        elements.forEach((el) => el.classList.add('is-revealed'));
        return;
      }
      if (!observer) {
        observer = new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              if (!entry.isIntersecting) return;
              entry.target.classList.add('is-revealed');
              observer.unobserve(entry.target);
            });
          },
          { rootMargin: '0px 0px -6% 0px', threshold: 0.06 }
        );
      }
      elements.forEach((el) => observer.observe(el));
    },
  };
})(window.VoiceAI = window.VoiceAI || {});
