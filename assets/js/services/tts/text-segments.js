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
    if (typeof Intl.Segmenter !== 'function') return null;
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

  /** Where to cut `text` so the first piece is at most `max` characters: a space, else a word boundary. */
  function cutPoint(text, max, language) {
    let cut = text.lastIndexOf(' ', max);
    if (cut >= max / 3) return cut;
    const words = segmenter(language, 'word');
    if (words) {
      let best = -1;
      for (const { index } of words.segment(text.slice(0, max + 1))) {
        if (index > 0 && index <= max) best = index;
      }
      if (best >= max / 3) return best;
    }
    cut = max;
    if (/[\uD800-\uDBFF]/.test(text[cut - 1])) cut--; // never split a UTF-16 surrogate pair
    return cut;
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
        ? paragraph.match(/[^។៕!?\n]+(?:[។៕!?]+[»"'”’)\]]*)?|[។៕!?]+/g) || []
        : sentences
          ? Array.from(sentences.segment(paragraph), (s) => s.segment)
          : paragraph.match(/[^.!?។៕]+[.!?។៕]*|[.!?។៕]+/g) || [];
      const before = out.length;
      for (const sentence of found) {
        let rest = sentence.replace(/\s+/g, ' ').trim();
        while (rest.length > max) {
          const cut = cutPoint(rest, max, language);
          out.push({ text: rest.slice(0, cut).trim(), paragraphEnd: false });
          rest = rest.slice(cut).trim();
        }
        if (rest) out.push({ text: rest, paragraphEnd: false });
      }
      if (out.length > before) out[out.length - 1].paragraphEnd = true;
    }
    if (out.length) out[out.length - 1].paragraphEnd = false; // nothing follows the last one
    return out;
  }

  function cues(text, max = 180, language = 'en-US') {
    return units(text, max, language).map((unit) => unit.text);
  }

  /**
   * Splits text into sections of at most `max` characters for resumable generation.
   * Returns { sections: string[][], breaks: boolean[][] } — breaks[i][j] is true when cue j of
   * section i ends a paragraph.
   */
  function plan(text, language = 'en-US', max = 900) {
    const sections = [];
    const breaks = [];
    let current = [];
    let ends = [];
    let size = 0;
    for (const unit of units(text, 180, language)) {
      if (size + unit.text.length + 1 > max && current.length) {
        sections.push(current);
        breaks.push(ends);
        current = [];
        ends = [];
        size = 0;
      }
      current.push(unit.text);
      ends.push(unit.paragraphEnd);
      size += unit.text.length + 1;
    }
    if (current.length) {
      sections.push(current);
      breaks.push(ends);
    }
    return { sections, breaks };
  }

  function sections(text, max = 900, language = 'en-US') {
    return plan(text, language, max).sections;
  }

  App.TextSegments = { units, cues, plan, sections };
})(window.VoiceAI = window.VoiceAI || {});
