/**
 * EchoText — Khmer text handling
 *
 * The Khmer voice (Meta MMS) reads Khmer letters only: digits, symbols and
 * Latin letters are dropped silently. Before speaking, numbers (Khmer ០–៩ or
 * 0–9) become Khmer words and common symbols are spelled out. Subtitles keep
 * the original text; only the spoken copy is changed.
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

  /** The spoken copy of Khmer text: numbers and symbols as words, invisible characters removed. */
  function normalize(text) {
    let out = String(text || '')
      .normalize('NFC')
      .replace(/[​‌‍⁠﻿]/g, ''); // zero-width spaces mark word breaks in Khmer text
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
