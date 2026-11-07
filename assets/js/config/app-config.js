/**
 * EchoText — App configuration
 * Languages, limits and voice defaults live here so they can be tuned
 * without touching UI code.
 */
(function (App) {
  'use strict';

  /**
   * Speech languages: the language of the text being spoken (not the interface language, see i18n.js).
   * cps = average characters spoken per second at 1x, used for rough estimates.
   */
  const LANGUAGES = [
    {
      code: 'en-US',
      short: 'EN',
      name: 'English',
      native: 'English',
      cps: 17.5,
      sample: 'Hello! This is my voice. Let’s bring your words to life.',
    },
    {
      code: 'km-KH',
      short: 'KM',
      name: 'Khmer',
      native: 'ខ្មែរ',
      cps: 9,
      sample: 'សួស្តី! នេះជាសំឡេងរបស់ខ្ញុំ។ សូមឲ្យពាក្យរបស់អ្នកមានជីវិត។',
    },
  ];

  const config = {
    appName: 'EchoText',
    maxChars: 50000,
    // Largest file accepted per import type. Office and PDF files carry layout and images, so they may be bigger.
    maxFileBytes: { txt: 2 * 1024 * 1024, docx: 25 * 1024 * 1024, pdf: 40 * 1024 * 1024 },
    peaks: 72,
    historyLimit: 100, // non-favourite items kept; favourites are never removed automatically
    languages: LANGUAGES,
    voiceDefaults: {
      language: 'en-US', gender: 'female', voiceId: 'en_US-kristin-medium',
      rate: 1, pitch: 1, volume: 1,
      sentencePause: 0.2, // seconds of silence after each sentence
      paragraphPause: 0.6, // seconds of silence after each paragraph (a blank line in the text)
    },
    ranges: {
      rate: { min: 0.5, max: 2, step: 0.05 },
      pitch: { min: 0.5, max: 1.5, step: 0.05 },
      sentencePause: { min: 0, max: 1.5, step: 0.05 },
      paragraphPause: { min: 0, max: 3, step: 0.1 },
    },
    presetLimit: 20,

    getLanguage(code) {
      return LANGUAGES.find((lang) => lang.code === code) || LANGUAGES[0];
    },
  };

  App.config = config;
})(window.VoiceAI = window.VoiceAI || {});
