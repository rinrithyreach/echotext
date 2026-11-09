/**
 * EchoText — Settings service
 * Persists what the app remembers in localStorage (the dark / light look, set
 * from the navbar, and the studio's last voice settings) and broadcasts
 * `settings:change` so open views can react. There is no Settings page.
 */
(function (App) {
  'use strict';

  const KEY = 'settings';

  const DEFAULTS = {
    theme: 'dark', // 'dark' | 'light'
    uiLanguage: 'en', // interface language: 'en' | 'km' (see core/i18n.js)
    engine: 'piper',
    lastVoice: null, // voice settings last used in the studio
    presets: [], // saved voice presets (App.Presets)
  };

  /** Settings saved by older versions: removed engines (and their API keys), languages and options. */
  function migrate(stored) {
    if (!isObject(stored)) return {};
    const out = { ...stored };
    let changed = false;
    if ('providers' in out || (out.engine && out.engine !== DEFAULTS.engine)) {
      delete out.providers; // also removes any saved API keys from this browser
      out.engine = DEFAULTS.engine;
      changed = true;
    }
    ['downloadFormat', 'exportFormat', 'saveLocation', 'voiceDefaults', 'aiVoices', 'historyLimit', 'autoplay', 'saveHistory'].forEach((key) => {
      // Downloads are always MP3, saved through the browser; the studio's Reset uses the built-in voice defaults;
      // each speech language has one default voice; History always keeps 100 items (config.historyLimit);
      // new audio always plays right away and is always saved to History.
      if (key in out) {
        delete out[key];
        changed = true;
      }
    });
    if (out.theme === 'system') {
      // "System" is no longer offered: keep whichever look the device has now.
      out.theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      changed = true;
    }
    const supported = (code) => App.config.languages.some((lang) => lang.code === code);
    if (isObject(out.lastVoice) && out.lastVoice.language && !supported(out.lastVoice.language)) {
      out.lastVoice = { ...out.lastVoice, language: App.config.voiceDefaults.language, voiceId: 'auto' };
      changed = true;
    }
    if (changed) App.storage.set(KEY, out);
    return out;
  }

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function deepMerge(base, patch) {
    const out = { ...base };
    Object.entries(patch || {}).forEach(([key, value]) => {
      out[key] = isObject(value) && isObject(base[key]) ? deepMerge(base[key], value) : value;
    });
    return out;
  }

  let cache = null;

  const Settings = {
    defaults: DEFAULTS,

    get() {
      if (!cache) cache = deepMerge(clone(DEFAULTS), migrate(App.storage.get(KEY, {})));
      return cache;
    },

    update(patch) {
      const next = deepMerge(this.get(), patch);
      if (!App.storage.set(KEY, next)) throw new Error(App.t('Settings could not be saved. Browser storage may be full.'));
      cache = next;
      App.bus.emit('settings:change', { settings: cache, patch });
      return cache;
    },

    replace(next) {
      if (!isObject(next)) throw new TypeError('Settings must be an object.');
      const copy = clone(next);
      if (!App.storage.set(KEY, copy)) throw new Error(App.t('Settings could not be saved. Browser storage may be full.'));
      cache = copy;
      App.bus.emit('settings:change', { settings: cache, patch: copy });
      return cache;
    },

    /** Restore only supported voices and valid controls, including older browser-voice settings. */
    voice(saved = this.get().lastVoice || {}) {
      if (!isObject(saved)) saved = {};
      const voice = App.AIVoice.voices.find((v) => v.id === saved.voiceId) || App.AIVoice.pick(saved.language, saved.gender) || App.AIVoice.voices[0];
      return { ...App.config.voiceDefaults, ...controlsOf(saved), voiceId: voice.id, gender: voice.gender, language: voice.language };
    },
  };

  /** Speed, pitch and pauses from saved settings, each kept within its range. */
  function controlsOf(saved) {
    const controls = {};
    for (const [key, range] of Object.entries(App.config.ranges)) {
      const value = Number(saved[key]);
      controls[key] = App.utils.clamp(Number.isFinite(value) && saved[key] !== null && saved[key] !== '' ? value : App.config.voiceDefaults[key], range.min, range.max);
    }
    return controls;
  }

  /** Saved voice presets: a name with a voice, speed, pitch and pauses. */
  const Presets = {
    list() {
      const saved = Settings.get().presets;
      return Array.isArray(saved) ? saved.filter((p) => isObject(p) && typeof p.id === 'string' && p.id && typeof p.name === 'string' && p.name.trim()) : [];
    },

    get(id) {
      return this.list().find((p) => p.id === id) || null;
    },

    /** Saves the voice settings under a name (replacing a preset with the same name). */
    save(name, voice) {
      const label = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!label) throw new Error(App.t('Give the preset a name.'));
      const list = this.list();
      const same = list.find((p) => p.name.toLowerCase() === label.toLowerCase());
      if (!same && list.length >= App.config.presetLimit) throw new Error(App.t('You can keep up to {n} presets. Delete one first.', { n: App.config.presetLimit }));
      const preset = { id: same ? same.id : App.utils.uid('preset'), name: label, voiceId: voice.voiceId, language: voice.language, ...controlsOf(voice), savedAt: Date.now() };
      Settings.update({ presets: same ? list.map((p) => (p.id === same.id ? preset : p)) : [...list, preset] });
      return preset;
    },

    remove(id) {
      const removed = this.get(id);
      Settings.update({ presets: this.list().filter((p) => p.id !== id) });
      return removed;
    },

    restore(preset) {
      if (preset) Settings.update({ presets: [...this.list().filter((p) => p.id !== preset.id), preset] });
    },

    /** The voice settings a preset stands for (falls back safely if its voice is gone). */
    voiceOf(preset) {
      return Settings.voice(preset);
    },
  };

  const Theme = {
    resolve(preference) {
      return preference === 'light' ? 'light' : 'dark';
    },

    apply(preference = Settings.get().theme) {
      const theme = this.resolve(preference);
      document.documentElement.setAttribute('data-theme', theme);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', theme === 'light' ? '#f3f7f8' : '#04070a');
    },

    init() {
      this.apply();
      App.bus.on('settings:change', ({ patch }) => {
        if ('theme' in patch) this.apply();
      });
    },
  };

  App.Settings = Settings;
  App.Presets = Presets;
  App.Theme = Theme;
})(window.VoiceAI = window.VoiceAI || {});
