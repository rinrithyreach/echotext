/**
 * EchoText — History service
 * Metadata for generated audio lives in localStorage; the audio files
 * themselves live in IndexedDB (see audio-store.js).
 */
(function (App) {
  'use strict';

  const KEY = 'history';

  const History = {
    list() {
      const saved = App.storage.get(KEY, []);
      // A damaged or older storage entry must not prevent the studio from opening.
      if (!Array.isArray(saved)) return [];
      return saved
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' && item.id && typeof item.text === 'string')
        .map((item) => ({
          ...item,
          title: typeof item.title === 'string' && item.title.trim() ? item.title : App.utils.titleFromText(item.text),
          createdAt: Number.isFinite(item.createdAt) && Math.abs(item.createdAt) <= 8640000000000000 ? item.createdAt : 0,
          project: cleanProject(item.project),
        }));
    },

    get(id) {
      return this.list().find((item) => item.id === id) || null;
    },

    _save(items) {
      if (!App.storage.set(KEY, items)) throw new Error(App.t('History could not be saved. Browser storage may be full.'));
      App.bus.emit('history:change', items);
    },

    /** Saves a generation result. Returns the stored item. */
    async add(result, { preserveHistory = false } = {}) {
      const item = {
        id: result.id,
        title: result.title,
        text: result.text,
        chars: result.text.length,
        language: result.language,
        gender: result.gender,
        voiceId: result.voiceId,
        voiceName: result.voiceName,
        cues: result.cues || [],
        narrationSegments: result.narrationSegments || result.cues || [],
        revision: result.revision || 1,
        revisionOf: result.revisionOf || null,
        peaks: result.peaks || null,
        engine: result.engine,
        engineName: result.engineName,
        rate: result.rate,
        pitch: result.pitch,
        volume: result.volume,
        sentencePause: result.sentencePause,
        paragraphPause: result.paragraphPause,
        project: cleanProject(result.project),
        fileName: result.fileName || null,
        duration: result.duration,
        isEstimate: result.isEstimate,
        mime: result.mime || null,
        size: result.blob ? result.blob.size : 0,
        hasAudio: false,
        createdAt: result.createdAt,
      };

      const previous = this.get(item.id);
      let previousBlob = null;
      if (result.blob) {
        try {
          if (previous && previous.hasAudio) previousBlob = await App.AudioStore.get(item.id);
          await App.AudioStore.put(item.id, result.blob);
          item.hasAudio = true;
        } catch (err) { throw new Error(App.t('Audio could not be saved to History. Download it now or continue the saved generation later.'), { cause: err }); }
      }

      const items = [item, ...this.list().filter((existing) => existing.id !== item.id)];
      // Past the limit, the oldest items go.
      const removed = preserveHistory ? [] : items.splice(App.config.historyLimit);
      try {
        this._save(items);
      } catch (err) {
        // Keep IndexedDB in step with metadata if localStorage rejects this save.
        if (result.blob) {
          if (previousBlob) await App.AudioStore.put(item.id, previousBlob).catch(() => {});
          else await App.AudioStore.delete(item.id).catch(() => {});
        }
        throw err;
      }
      removed.forEach((old) => old.hasAudio && App.AudioStore.delete(old.id).catch(() => {}));
      return item;
    },

    /** Removes items (and their audio) in languages EchoText no longer has. */
    pruneLanguages() {
      const supported = (code) => App.config.languages.some((lang) => lang.code === code);
      const items = this.list();
      const removed = items.filter((item) => item.language && !supported(item.language));
      if (!removed.length) return;
      this._save(items.filter((item) => !removed.includes(item)));
      removed.forEach((item) => item.hasAudio && App.AudioStore.delete(item.id).catch(() => {}));
    },

    update(id, patch) {
      const items = this.list().map((item) => (item.id === id ? { ...item, ...patch } : item));
      this._save(items);
    },

    /** Renames an item (its title, which downloads are named after unless a file name was typed). */
    rename(id, title) {
      const value = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!value) throw new Error(App.t('Give it a name.'));
      this.update(id, { title: value });
    },

    /** Moves an item into a project (null: no project). */
    setProject(id, project) {
      this.update(id, { project: cleanProject(project) });
    },

    /** Project names in use, A–Z. */
    projects() {
      const names = new Set(this.list().map((item) => item.project).filter(Boolean));
      return [...names].sort((a, b) => a.localeCompare(b, App.i18n ? App.i18n.locale() : undefined));
    },

    /** Stores an audio file for an existing item (e.g. a recorded browser voice). */
    async attachAudio(id, blob, duration) {
      await App.AudioStore.put(id, blob);
      this.update(id, { hasAudio: true, mime: blob.type, size: blob.size, duration, isEstimate: false });
    },

    /** Removes an item and returns what is needed to undo the removal. */
    async remove(id) {
      const original = this.get(id);
      if (!original) return null;
      // Do not delete audio that could not be read for Undo.
      const blob = original.hasAudio ? await App.AudioStore.get(id) : null;
      // Reading audio is asynchronous: retain generations, renames and deletions
      // that happened while IndexedDB was returning this file.
      const items = this.list();
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) return null;
      const [item] = items.splice(index, 1);
      this._save(items);
      if (item.hasAudio) await App.AudioStore.delete(id).catch(() => {});
      return { item, blob, index };
    },

    async restore({ item, blob, index }) {
      if (blob) await App.AudioStore.put(item.id, blob);
      const items = this.list().filter((existing) => existing.id !== item.id);
      items.splice(Math.min(index, items.length), 0, { ...item, hasAudio: !!blob });
      this._save(items);
    },

    async clear() {
      this._save([]);
      await App.AudioStore.clear().catch(() => {});
    },

    getAudio(id) {
      return App.AudioStore.get(id);
    },

    stats() {
      const items = this.list();
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      const languages = {};
      let chars = 0;
      let seconds = 0;
      let monthChars = 0;
      let bytes = 0;
      items.forEach((item) => {
        chars += item.chars || 0;
        seconds += item.duration || 0;
        bytes += item.size || 0;
        if (item.createdAt >= monthStart) monthChars += item.chars || 0;
        languages[item.language] = (languages[item.language] || 0) + 1;
      });
      const topLanguage = Object.entries(languages).sort((a, b) => b[1] - a[1])[0];
      return {
        count: items.length,
        chars,
        seconds,
        monthChars,
        bytes,
        languageCount: Object.keys(languages).length,
        topLanguage: topLanguage ? topLanguage[0] : null,
      };
    },
  };

  function cleanProject(name) {
    const value = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return value || null;
  }

  App.History = History;
})(window.VoiceAI = window.VoiceAI || {});
