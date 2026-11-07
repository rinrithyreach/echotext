/**
 * EchoText — Storage & event bus
 * JSON wrappers around localStorage / sessionStorage that never throw
 * (private mode, quota errors and blocked storage all degrade gracefully).
 */
(function (App) {
  'use strict';

  const PREFIX = 'voiceai:'; // Keep the original storage key so existing projects and preferences remain accessible.

  function createStore(getArea) {
    return {
      get(key, fallback = null) {
        try {
          const raw = getArea().getItem(PREFIX + key);
          return raw == null ? fallback : JSON.parse(raw);
        } catch {
          return fallback;
        }
      },
      set(key, value) {
        try {
          getArea().setItem(PREFIX + key, JSON.stringify(value));
          return true;
        } catch (err) {
          console.warn('[EchoText] Could not persist', key, err);
          return false;
        }
      },
      remove(key) {
        try {
          getArea().removeItem(PREFIX + key);
        } catch {
          /* storage unavailable */
        }
      },
    };
  }

  App.storage = createStore(() => window.localStorage);
  App.storage.session = createStore(() => window.sessionStorage);

  /**
   * App-wide event bus.
   * Events: settings:change, history:change, voices:change, route:change
   */
  App.bus = new App.Emitter();
})(window.VoiceAI = window.VoiceAI || {});
