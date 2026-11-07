/**
 * EchoText — TTS provider registry & errors
 *
 * EchoText uses one engine, browser voices (providers/browser.js). Engines
 * register themselves here and the studio and settings render from this
 * metadata.
 *
 * Provider shape:
 * {
 *   id: 'browser',
 *   name: 'Browser voices',
 *   kind: 'browser',
 *   description: '…',
 *   capabilities: { download: boolean, pitch: boolean, rate: [min, max] },
 *   isConfigured() → boolean,
 *   getVoices({ language, gender }) → Promise<Voice[]>,      // Voice = { id, name, gender, tag? }
 * }
 */
(function (App) {
  'use strict';

  class TTSError extends Error {
    /**
     * @param {string} message  user-facing explanation
     * @param {{code?: string, status?: number, cause?: unknown}} [meta]
     */
    constructor(message, { code = 'tts_error', status, cause } = {}) {
      super(message);
      this.name = 'TTSError';
      this.code = code;
      this.status = status;
      this.cause = cause;
    }
  }

  const registry = new Map();

  const TTSProviders = {
    register(provider) {
      registry.set(provider.id, provider);
      return provider;
    },
    get(id) {
      return registry.get(id) || registry.get('browser');
    },
    list() {
      return [...registry.values()];
    },
  };

  App.TTSError = TTSError;
  App.TTSProviders = TTSProviders;
})(window.VoiceAI = window.VoiceAI || {});
