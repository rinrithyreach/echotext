/**
 * EchoText — Core utilities
 * Small, dependency-free helpers shared across the app.
 * Every script registers itself on the global `VoiceAI` namespace so the app
 * runs from a plain static server or straight from the file system.
 */
(function (App) {
  'use strict';

  App.components = App.components || {};
  App.pages = App.pages || {};

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
  }

  function debounce(fn, wait = 200) {
    let timer;
    function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    }
    debounced.cancel = () => clearTimeout(timer);
    return debounced;
  }

  function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  // Formatters follow the interface language (App.i18n), made once per locale.
  const formatters = new Map();
  const uiLocale = () => (App.i18n ? App.i18n.locale() : undefined);
  function formatter(kind, options, make) {
    const key = `${kind}|${uiLocale()}|${JSON.stringify(options)}`;
    if (!formatters.has(key)) {
      try {
        formatters.set(key, make(uiLocale(), options));
      } catch {
        formatters.set(key, make(undefined, options));
      }
    }
    return formatters.get(key);
  }
  const formatNumber = (n) => formatter('number', {}, (l, o) => new Intl.NumberFormat(l, o)).format(n);
  const formatCompact = (n) => formatter('number', { notation: 'compact', maximumFractionDigits: 1 }, (l, o) => new Intl.NumberFormat(l, o)).format(n);

  function formatDate(ts, options = { dateStyle: 'medium', timeStyle: 'short' }) {
    try {
      return formatter('date', options, (l, o) => new Intl.DateTimeFormat(l, o)).format(new Date(ts));
    } catch {
      return new Date(ts).toLocaleString();
    }
  }

  function relativeTime(ts) {
    const diff = (ts - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 45) return App.t ? App.t('Just now') : 'Just now';
    const relativeFormat = typeof Intl.RelativeTimeFormat === 'function' ? formatter('relative', { numeric: 'auto' }, (l, o) => new Intl.RelativeTimeFormat(l, o)) : null;
    if (!relativeFormat) return formatDate(ts, { dateStyle: 'medium' });
    if (abs < 3600) return relativeFormat.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return relativeFormat.format(Math.round(diff / 3600), 'hour');
    if (abs < 604800) return relativeFormat.format(Math.round(diff / 86400), 'day');
    return formatDate(ts, { dateStyle: 'medium' });
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 KB';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  // Intl.Segmenter understands scripts without spaces, like Khmer.
  const wordSegmenter =
    typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

  function countWords(text) {
    const value = String(text || '').trim();
    if (!value) return 0;
    if (wordSegmenter) {
      let count = 0;
      for (const segment of wordSegmenter.segment(value)) if (segment.isWordLike) count++;
      return count;
    }
    return value.split(/\s+/).length;
  }

  function truncate(text, max) {
    const chars = Array.from(String(text || ''));
    return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('');
  }

  function titleFromText(text, max = 64) {
    const firstLine = String(text || '')
      .trim()
      .split('\n')[0]
      .replace(/\s+/g, ' ')
      .trim();
    return truncate(firstLine || (App.t ? App.t('Untitled audio') : 'Untitled audio'), max);
  }

  function slugify(text, max = 40) {
    const slug = String(text || '')
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-') // \p{M}: vowel signs, as in Khmer, belong to their letters
      .replace(/^-+|-+$/g, '');
    return Array.from(slug).slice(0, max).join('').replace(/-+$/, '') || 'audio';
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('Copy command was rejected');
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const first = Array.from(parts[0])[0] || '';
    const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] : '';
    return (first + last).toUpperCase();
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.classList.toggle('is-loading', busy);
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
  }

  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function scrollToId(id, { focus } = {}) {
    const target = document.getElementById(id);
    if (!target) return;
    const navHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nav-h'), 10) || 72;
    const top = target.getBoundingClientRect().top + window.scrollY - navHeight - 16;
    window.scrollTo({ top: Math.max(0, top), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    if (focus) {
      const el = typeof focus === 'string' ? target.querySelector(focus) : target;
      setTimeout(() => el && el.focus({ preventScroll: true }), 450);
    }
  }

  /** Minimal event emitter used by services and playback engines. */
  class Emitter {
    constructor() {
      this._handlers = new Map();
    }

    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, new Set());
      this._handlers.get(event).add(handler);
      return () => this.off(event, handler);
    }

    off(event, handler) {
      const set = this._handlers.get(event);
      if (set) set.delete(handler);
    }

    emit(event, payload) {
      const set = this._handlers.get(event);
      if (!set) return;
      [...set].forEach((handler) => {
        try {
          handler(payload);
        } catch (err) {
          console.error(`[EchoText] "${event}" handler failed`, err);
        }
      });
    }

    removeAll() {
      this._handlers.clear();
    }
  }

  App.utils = {
    $,
    $$,
    escapeHtml,
    debounce,
    uid,
    clamp,
    sleep,
    formatTime,
    formatDuration,
    formatNumber,
    formatCompact,
    formatDate,
    relativeTime,
    formatBytes,
    countWords,
    truncate,
    titleFromText,
    slugify,
    copyToClipboard,
    downloadBlob,
    initials,
    setBusy,
    prefersReducedMotion,
    scrollToId,
    wordSegmenter,
  };
  App.Emitter = Emitter;
})(window.VoiceAI = window.VoiceAI || {});
