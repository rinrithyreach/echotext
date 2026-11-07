/**
 * EchoText — Browser provider (Web Speech API)
 * The voice engine: free, private, instant. It speaks with Google US English
 * (see BrowserVoices.resolve). Audio is spoken live and can't be saved as a
 * file, so Download makes the MP3 with an AI voice in the browser
 * (services/tts/ai-voice.js), or records it where that can't run.
 */
(function (App) {
  'use strict';

  App.TTSProviders.register({
    id: 'browser',
    name: 'Browser voices',
    shortName: 'Browser',
    kind: 'browser',
    icon: 'app-window',
    description: 'Free, private and instant. Uses the voices built into your device through the Web Speech API.',
    capabilities: { download: false, pitch: true, rate: [0.5, 2] },
    fields: [],

    isConfigured() {
      return App.BrowserVoices.supported;
    },

    async getVoices({ language }) {
      await App.BrowserVoices.load();
      return App.BrowserVoices.list(language);
    },
  });
})(window.VoiceAI = window.VoiceAI || {});
