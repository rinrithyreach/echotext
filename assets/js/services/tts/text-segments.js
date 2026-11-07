/**
 * Sentence-sized speech segments and bounded sections for resumable synthesis.
 *
 * Paragraphs are separated by a blank line. Each cue remembers whether it ends
 * a paragraph, so the paragraph pause can follow it. Sentences are found with
 * Intl.Segmenter in the text's language (Khmer ends sentences with ។ and ៕);
 * an over-long sentence is cut at the last word break that fits — for Khmer,
 * which has no spaces between words, at a dictionary word boundary.
 */
(function (App) {
  'use strict';

  const segmenters = new Map();
  function segmenter(language, granularity) {
    if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
    const key = `${language}|${granularity}`;
    if (!segmenters.has(key)) {
      try {
        segmenters.set(key, new Intl.Segmenter(String(language || 'en').split('-')[0], { granularity }));
      } catch {
        segmenters.set(key, new Intl.Segmenter('en', { granularity }));
      }
    }
    return segmenters.get(key);
  }

  // A Khmer coeng and its subscript consonant belong together even on browsers whose
  // grapheme segmenter treats that consonant as a new cluster.
  function safeBoundary(text, index) {
    if (index <= 0 || index >= text.length) return index > 0;
    if (/[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index])) return false;
    if (/\p{M}/u.test(text[index])) return false;
    let before = index - 1;
    while (before >= 0 && /[\u200c\u200d]/.test(text[before])) before--;
    return text[before] !== '\u17d2';
  }

  /** Prefer explicit word breaks, then dictionary words, then an intact grapheme. */
  function cutPoint(text, max, language) {
    const limit = Math.min(Math.max(1, Math.floor(max)), text.length);
    if (text.length <= limit) return text.length;
    let cut = -1;
    for (let index = limit; index > 0; index--) {
      if (/[ \t\n\u200b]/.test(text[index]) && safeBoundary(text, index)) { cut = index; break; }
    }
    if (cut >= limit / 3) return cut;
    const words = segmenter(language, 'word');
    if (words) {
      let best = -1;
      for (const { index } of words.segment(text)) {
        if (index > limit) break;
        if (safeBoundary(text, index)) best = index;
      }
      if (best >= limit / 3) return best;
    }
    const graphemes = segmenter(language, 'grapheme');
    if (graphemes) {
      let best = -1;
      for (const { index } of graphemes.segment(text)) {
        if (index > limit) break;
        if (safeBoundary(text, index)) best = index;
      }
      if (best > 0) return best;
    }
    for (let index = limit; index > 0; index--) if (safeBoundary(text, index)) return index;
    // An unusually long combining sequence cannot be cut to the limit safely.
    for (let index = limit + 1; index < text.length; index++) if (safeBoundary(text, index)) return index;
    return text.length;
  }

  function khmerPhrases(paragraph) {
    const out = [];
    // KhmerText.normalize spells these symbols aloud, even in a paragraph of their own.
    const readable = (text) => /[\p{L}\p{N}%$៛&+=@]/u.test(text);
    const digit = (ch) => /[0-9\u17e0-\u17e9]/.test(ch || '');
    const closing = /[»"'”’)\]]/;
    let start = 0;
    for (let at = 0; at < paragraph.length; at++) {
      const ch = paragraph[at];
      const sentence = /[។៕!?！？]/.test(ch);
      const ellipsis = ch === '.' && paragraph[at + 1] === '.';
      const clause = /[,;:…，；：、៖\n]/.test(ch) || ellipsis;
      if (!sentence && !clause) continue;
      // A comma in a number and a colon in a time are spoken as part of it.
      if (/[,，:：៖]/.test(ch) && digit(paragraph[at - 1]) && digit(paragraph[at + 1])) continue;
      let end = at + 1;
      const run = sentence ? /[។៕!?！？]/ : ellipsis ? /[.]/ : /[,;:…，；：、៖]/;
      while (end < paragraph.length && run.test(paragraph[end])) end++;
      while (end < paragraph.length && closing.test(paragraph[end])) end++;
      const text = paragraph.slice(start, end);
      if (readable(text)) {
        out.push({ text, pauseAfter: sentence ? 'sentence' : 'clause' });
        start = end;
      } else if (out.length) {
        // Mixed endings such as ...! or ,។ remain on the preceding spoken phrase.
        out[out.length - 1].text += text;
        if (sentence) out[out.length - 1].pauseAfter = 'sentence';
        start = end;
      }
      at = end - 1;
    }
    if (start < paragraph.length) {
      const text = paragraph.slice(start);
      if (readable(text)) out.push({ text, pauseAfter: 'sentence' });
      else if (out.length) out[out.length - 1].text += text;
    }
    return out;
  }

  /** Cues with paragraph ends: [{ text, paragraphEnd }]. */
  function units(text, max = 180, language = 'en-US') {
    const out = [];
    const sentences = segmenter(language, 'sentence');
    const paragraphs = String(text).replace(/\r\n?/g, '\n').split(/\n\s*\n/);
    const khmer = /^km/i.test(language);
    for (const paragraph of paragraphs) {
      // Khmer ends sentences with ។ ៕ ! or ?; a full stop there marks an abbreviation (ក.ម.), so it
      // doesn't end a sentence the way Intl.Segmenter would assume.
      const found = khmer
        ? khmerPhrases(paragraph)
        : sentences
          ? Array.from(sentences.segment(paragraph), (s) => s.segment)
          : paragraph.match(/[^.!?។៕]+[.!?។៕]*|[.!?។៕]+/g) || [];
      const before = out.length;
      for (const sentence of found) {
        let rest = (khmer ? sentence.text : sentence).replace(/\s+/g, ' ').trim();
        while (rest.length > max) {
          const cut = cutPoint(rest, max, language);
          out.push({ text: rest.slice(0, cut).trim(), paragraphEnd: false, ...(khmer ? { pauseAfter: 'continuation' } : {}) });
          rest = rest.slice(cut).trim();
        }
        if (rest) out.push({ text: rest, paragraphEnd: false, ...(khmer ? { pauseAfter: sentence.pauseAfter } : {}) });
      }
      if (out.length > before) out[out.length - 1].paragraphEnd = true;
    }
    if (out.length) out[out.length - 1].paragraphEnd = false; // nothing follows the last one
    return out;
  }

  function cues(text, max = 180, language = 'en-US') {
    return units(text, max, language).map((unit) => unit.text);
  }

  /** Keep phrase breaths shorter than a sentence and preserve the user's zero-pause choice. */
  function pauseFor(unit, settings = {}) {
    const seconds = (key) => {
      const value = settings[key] ?? App.config.voiceDefaults[key];
      return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : App.config.voiceDefaults[key];
    };
    if (unit.paragraphEnd) return seconds('paragraphPause');
    const sentence = seconds('sentencePause');
    if (unit.pauseAfter === 'clause') return Math.min(sentence * 0.5, 0.2);
    if (unit.pauseAfter === 'continuation') return Math.min(sentence * 0.25, 0.08);
    return sentence;
  }

  /**
   * Splits text into sections of at most `max` characters for resumable generation.
   * Returns { sections: string[][], breaks: boolean[][] } — breaks[i][j] is true when cue j of
   * section i ends a paragraph.
   */
  function plan(text, language = 'en-US', max = 900) {
    const sections = [];
    const breaks = [];
    const pauses = [];
    let current = [];
    let ends = [];
    let kinds = [];
    let size = 0;
    for (const unit of units(text, 180, language)) {
      if (size + unit.text.length + 1 > max && current.length) {
        sections.push(current);
        breaks.push(ends);
        pauses.push(kinds);
        current = [];
        ends = [];
        kinds = [];
        size = 0;
      }
      current.push(unit.text);
      ends.push(unit.paragraphEnd);
      kinds.push(unit.pauseAfter || 'sentence');
      size += unit.text.length + 1;
    }
    if (current.length) {
      sections.push(current);
      breaks.push(ends);
      pauses.push(kinds);
    }
    return { sections, breaks, pauses };
  }

  function sections(text, max = 900, language = 'en-US') {
    return plan(text, language, max).sections;
  }

  App.TextSegments = { units, cues, plan, sections, cutPoint, pauseFor };
})(window.VoiceAI = window.VoiceAI || {});
