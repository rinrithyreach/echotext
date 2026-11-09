/**
 * EchoText — Home page: the Text-to-Speech studio, with the audio history under it
 */
(function (App) {
  'use strict';

  const { $ } = App.utils;

  App.pages.home = {
    id: 'home',
    title: null,
    render(view) {
      view.innerHTML = `
        <section class="studio-section" id="studio" aria-label="${App.utils.escapeHtml(App.t('Text to speech studio'))}">
          <div class="container" data-generator></div>
        </section>
        <section class="container history-section" id="history" aria-label="${App.utils.escapeHtml(App.t('Audio history'))}" data-history></section>`;
      // The result on screen stays when the page is redrawn (switching the interface language).
      const carried = this.carry && (this.carry.blob || App.History.get(this.carry.id)) ? this.carry : null; // not if deleted since
      this.generator = App.components.Generator.mount($('[data-generator]', view), { shown: carried });
      this.carry = null;
      this.history = App.components.HistoryList.mount($('[data-history]', view), {
        onOpen: (item) => {
          this.generator.load(item);
          App.utils.scrollToId('studio');
          App.toast.info(App.t('Loaded into the studio'), App.t('Edit the text or voice, then generate again.'));
        },
      });
    },
    onSection(section) {
      clearTimeout(this.focusTimer);
      if (section === 'studio' && this.generator) {
        const generator = this.generator;
        this.focusTimer = setTimeout(() => {
          if (this.generator === generator) generator.focus();
        }, 500);
      }
    },
    unmount() {
      clearTimeout(this.focusTimer);
      this.focusTimer = null;
      if (this.generator) this.carry = (this.generator.destroy() || {}).shown || null;
      if (this.history) this.history.destroy();
      this.generator = null;
      this.history = null;
    },
  };
})(window.VoiceAI = window.VoiceAI || {});
