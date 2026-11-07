/**
 * EchoText — Interface language (English / Khmer)
 *
 *   App.t('Generate Audio')                         → the text in the interface language
 *   App.t('Section {n} of {total}', { n, total })   → with values filled in
 *
 * English is the key, so anything without a Khmer translation still reads in
 * English instead of showing a code. Khmer strings live in i18n-km.js.
 * The choice is kept in settings (`uiLanguage`) and switching re-renders the page.
 */
(function (App) {
  'use strict';

  const LANGUAGES = [
    { code: 'en', name: 'English', native: 'English', locale: 'en-US' },
    { code: 'km', name: 'Khmer', native: 'ខ្មែរ', locale: 'km-KH' },
  ];
  const dictionaries = { en: {} };
  let current = 'en';

  // Digits shown in the Khmer interface (numbers inside the user's own text are never touched).
  const KHMER_DIGITS = '០១២៣៤៥៦៧៨៩';

  function fill(text, params) {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
  }

  const i18n = {
    languages: LANGUAGES,

    get language() {
      return current;
    },

    /** The BCP 47 locale used for dates and numbers. */
    locale() {
      return (LANGUAGES.find((l) => l.code === current) || LANGUAGES[0]).locale;
    },

    /** Registers translations for a language (English text → translation). */
    register(code, entries) {
      dictionaries[code] = { ...(dictionaries[code] || {}), ...entries };
    },

    has(code, text) {
      return !!(dictionaries[code] && Object.prototype.hasOwnProperty.call(dictionaries[code], text));
    },

    set(code) {
      const next = LANGUAGES.some((l) => l.code === code) ? code : 'en';
      current = next;
      if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('lang', next);
        document.documentElement.classList.toggle('ui-km', next === 'km');
      }
      return next;
    },

    t(text, params) {
      const dict = dictionaries[current];
      const translated = dict && Object.prototype.hasOwnProperty.call(dict, text) ? dict[text] : text;
      return fill(translated, params);
    },

    /** Digits for display in the interface language (Khmer digits in the Khmer interface). */
    digits(value) {
      const text = String(value);
      return current === 'km' ? text.replace(/[0-9]/g, (d) => KHMER_DIGITS[d]) : text;
    },
  };

  App.i18n = i18n;
  App.t = (text, params) => i18n.t(text, params);
})(window.VoiceAI = window.VoiceAI || {});
