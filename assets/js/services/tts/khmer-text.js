/**
 * EchoText — Khmer text handling
 *
 * The Khmer voice (Meta MMS) reads only the letters it was trained on: anything
 * else is dropped silently. Before speaking, numbers (Khmer ០–៩ or 0–9) become
 * Khmer words, common symbols and initials (USB, PDF) are spelled out, ៗ says
 * its word again, and letters and spellings the voice never learned are written
 * the way they sound. Subtitles keep the original text; only the spoken copy is changed.
 */
(function (App) {
  'use strict';

  const ONES = ['សូន្យ', 'មួយ', 'ពីរ', 'បី', 'បួន', 'ប្រាំ', 'ប្រាំមួយ', 'ប្រាំពីរ', 'ប្រាំបី', 'ប្រាំបួន'];
  const TENS = ['', 'ដប់', 'ម្ភៃ', 'សាមសិប', 'សែសិប', 'ហាសិប', 'ហុកសិប', 'ចិតសិប', 'ប៉ែតសិប', 'កៅសិប'];
  const KHMER_DIGITS = '០១២៣៤៥៦៧៨៩';
  const SYMBOLS = [
    [/%/g, ' ភាគរយ '],
    [/\$/g, ' ដុល្លារ '],
    [/៛/g, ' រៀល '],
    [/&/g, ' និង '],
    [/\+/g, ' បូក '],
    [/=/g, ' ស្មើ '],
    [/@/g, ' អាត់ '],
  ];

  // Letters missing from the voice's vocabulary, written as they are pronounced (Unicode Khmer chart):
  // ឍ sounds like ធ, the Sanskrit letters ឝ ឞ like ស, and the rare independent vowels like អ + vowel.
  const UNLEARNED = [
    [/\u178D/g, 'ធ'], // ឍ, as in អភិវឌ្ឍ
    [/[\u179D\u179E]/g, 'ស'], // ឝ ឞ
    [/\u17A6/g, 'អី'], // ឦ
    [/\u17A9/g, 'អូ'], // ឩ
    [/\u17B0/g, 'អៃ'], // ឰ
    [/\u17B3/g, 'អៅ'], // ឳ
  ];

  // Above the vowels ិ ី ឹ ឺ ើ the shifters ៊ and ៉ are drawn like ុ, so ុ is often typed instead (សុី for ស៊ី).
  // The voice learned the standard spelling: ៊ after ស ហ អ, ៉ after ង ញ ម យ រ វ. (ប takes either, so it is left as typed.)
  const SHIFTERS = { ស: '\u17CA', ហ: '\u17CA', អ: '\u17CA', ង: '\u17C9', ញ: '\u17C9', ម: '\u17C9', យ: '\u17C9', រ: '\u17C9', វ: '\u17C9' };
  const TYPED_SHIFTER = /(?<!\u17D2)([សហអងញមយរវ])(?:\u17BB([\u17B7-\u17BA\u17BE])|([\u17B7-\u17BA\u17BE])\u17BB)/g;

  // Words ៗ commonly doubles. The browser's word list joins some phrases into one entry (និយាយតិច, អ្នកធំ):
  // when the word before ៗ is such an entry ending in one of these, only this word is said again.
  const DOUBLED = [
    'តិច', 'ធំ', 'តូច', 'ចាស់', 'ក្មេង', 'លឿន', 'យឺត', 'ថ្មី', 'ល្អ', 'ស្អាត', 'ខ្លះ', 'ម្ដង', 'ម្តង', 'ផ្សេង',
    'ឆាប់', 'យូរ', 'ស្រាល', 'ធ្ងន់', 'ជិត', 'ឆ្ងាយ', 'ខ្ពស់', 'ទាប', 'វែង', 'ខ្លី', 'ក្ដៅ', 'ក្តៅ', 'ត្រជាក់',
    'ស្រួល', 'ច្រើន', 'ខ្លាំង', 'ស្ងាត់', 'ថ្លៃ', 'ថោក', 'ម្នាក់', 'មួយ',
  ];

  // English letter names, for initials such as USB or PDF inside Khmer text.
  const LETTER_NAMES = {
    A: 'អេ', B: 'ប៊ី', C: 'ស៊ី', D: 'ឌី', E: 'អ៊ី', F: 'អេហ្វ', G: 'ជី', H: 'អេច', I: 'អាយ', J: 'ជេ', K: 'ខេ', L: 'អែល', M: 'អែម',
    N: 'អែន', O: 'អូ', P: 'ភី', Q: 'ឃ្យូ', R: 'អា', S: 'អេស', T: 'ធី', U: 'យូ', V: 'វី', W: 'ដាប់ប៊ែលយូ', X: 'អិច', Y: 'វ៉ាយ', Z: 'ហ្សេដ',
  };

  /** Khmer words for a whole number, 0 – 999,999,999,999. */
  function numberToWords(n) {
    n = Math.floor(Math.abs(n));
    if (n === 0) return ONES[0];
    if (n >= 1e12) return String(n).split('').map((d) => ONES[d]).join(' ');
    let words = '';
    if (n >= 1e9) {
      words += `${numberToWords(Math.floor(n / 1e9))}ពាន់`; // a thousand million
      n %= 1e9;
      if (n < 1e6) words += 'លាន';
    }
    if (n >= 1e6) {
      words += `${numberToWords(Math.floor(n / 1e6))}លាន`;
      n %= 1e6;
    }
    const units = [
      [1e5, 'សែន'],
      [1e4, 'ម៉ឺន'],
      [1e3, 'ពាន់'],
      [1e2, 'រយ'],
    ];
    for (const [size, name] of units) {
      const digit = Math.floor(n / size) % 10;
      if (digit) words += ONES[digit] + name;
    }
    const rest = n % 100;
    if (rest >= 10) words += TENS[Math.floor(rest / 10)] + (rest % 10 ? ONES[rest % 10] : '');
    else if (rest) words += ONES[rest];
    return words;
  }

  const toAsciiDigits = (text) => text.replace(/[០-៩]/g, (d) => String(KHMER_DIGITS.indexOf(d)));

  /** Reads one number token ("1,250", "3.5", "012 345 678") as Khmer words. */
  function readNumber(token) {
    const digits = toAsciiDigits(token);
    // Phone numbers and codes with a leading zero are read digit by digit.
    if (/^0\d/.test(digits.replace(/[\s-]/g, ''))) {
      return digits.replace(/[^\d]/g, '').split('').map((d) => ONES[d]).join(' ');
    }
    const grouped = /^\d{1,3}([,\s]\d{3})+(\.\d+)?$/.test(digits);
    let plain = grouped ? digits.replace(/[,\s]/g, '') : digits;
    if ((plain.match(/\./g) || []).length > 1) plain = plain.replace(/\./g, ''); // 1.250.000: dots group thousands
    const [whole, fraction] = plain.split('.');
    let words = whole ? numberToWords(Number(whole)) : ONES[0];
    if (fraction) words += ` ចុច ${fraction.split('').map((d) => ONES[d]).join(' ')}`;
    return words;
  }

  /** The word ៗ says again: the last word written before it (a ZWSP or the browser's word list ends a word). */
  function doubledWord(before) {
    const text = before.replace(/\u200B+$/, '');
    let word = text.slice(text.lastIndexOf('\u200B') + 1);
    const words = App.utils && App.utils.wordSegmenter;
    if (words) for (const { segment } of words.segment(word)) word = segment;
    const common = DOUBLED.find((w) => word.length > w.length && word.endsWith(w) && word[word.length - w.length - 1] !== '\u17D2');
    return common || word;
  }

  /** The spoken copy; optional word-break hints help inference split without adding phrase pauses. */
  function normalize(text, { preserveWordBreaks = false } = {}) {
    let out = String(text || '')
      .normalize('NFC')
      // Unicode recommends these ordinary spellings for the deprecated independent vowels.
      .replace(/\u17A3/g, 'អ')
      .replace(/\u17A4/g, 'អា')
      // QOO type two is the same vowel in ឲ្យ, but the MMS vocabulary only has type one.
      .replace(/\u17B2/g, 'ឱ')
      // Unicode's chart defines the obsolete QUK ligature as QU + KA.
      // https://www.unicode.org/charts/PDF/U1780.pdf
      .replace(/\u17A8/g, 'ឧក')
      // Inherent-vowel compatibility marks, the silent Sanskrit signs ៑ ៓ and join controls have no spoken counterpart.
      .replace(/[\u17B4\u17B5\u17D1\u17D3\u200C\u200D\u2060\uFEFF]/g, '')
      // NFC does not repair these documented Khmer typing variants (UTN61, pp. 28, 46–47).
      // https://www.unicode.org/notes/tn61/utn61-Khmer_Encoding_Structure_V2.pdf
      .replace(/\u17C6([\u17BB\u17B6])/g, '$1\u17C6')
      .replace(/\u17C1\u17B8/g, 'ើ')
      .replace(/\u17C1\u17B6|\u17B6\u17C1/g, 'ោ')
      .replace(TYPED_SHIFTER, (match, consonant, vowel, vowelFirst) => consonant + SHIFTERS[consonant] + (vowel || vowelFirst));
    UNLEARNED.forEach(([pattern, spelling]) => { out = out.replace(pattern, spelling); });
    // ៗ repeats the word before it: ផ្សេងៗ is read ផ្សេងផ្សេង.
    out = out.replace(/([\u1780-\u17D3\u17DD\u200B]+)\s*\u17D7/g, (match, before) => `${before}\u200B${doubledWord(before)}\u200B`);
    out = out.replace(/(?<![A-Za-z])[A-Z]{1,4}(?![A-Za-z])/g, (letters) => ` ${Array.from(letters, (letter) => LETTER_NAMES[letter]).join('\u200B')} `);
    // ZWSP marks a word boundary; a visible Khmer space instead separates phrases.
    out = out.replace(/\u200B/g, preserveWordBreaks ? '\u200B' : '');
    out = out.replace(/[0-9០-៩]+(?:[.,][0-9០-៩]+)*/g, (token) => ` ${readNumber(toAsciiDigits(token).replace(/,(?=\d{1,2}$)/, '.'))} `);
    SYMBOLS.forEach(([pattern, word]) => { out = out.replace(pattern, word); });
    return out.replace(/\s+/g, ' ').trim();
  }

  /** True when the text is mostly Khmer letters. */
  function isKhmer(text) {
    const value = String(text || '');
    const khmer = (value.match(/[ក-៿᧠-᧿]/g) || []).length;
    const latin = (value.match(/[A-Za-z]/g) || []).length;
    return khmer > 0 && khmer >= latin;
  }

  App.KhmerText = { numberToWords, readNumber, normalize, isKhmer };
})(window.VoiceAI = window.VoiceAI || {});
