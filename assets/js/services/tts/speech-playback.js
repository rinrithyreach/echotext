/**
 * EchoText — Live speech playback (Web Speech API)
 *
 * speechSynthesis has no seeking, unreliable pause() and no duration. This
 * engine adds them by speaking the text in short chunks:
 *  - pause = cancel + remember the position; resume restarts from that word
 *  - seek  = restart from the nearest word boundary
 *  - progress runs at the expected speaking speed (calibrated against the
 *    real rate) and is steered by what the voice reports — chunk starts and
 *    ends, word boundaries where available — so it moves smoothly.
 * Short chunks also dodge Chrome's habit of silently stopping long utterances.
 */
(function (App) {
  'use strict';

  const { clamp, wordSegmenter } = App.utils;
  const synth = window.speechSynthesis;

  const MAX_CHUNK = 180;
  const SENTENCE_END = /([.!?…]+["'”’)\]]*\s+|[។៕]+\s*|\n+)/g;
  const SPOKEN = /[\p{L}\p{N}]/u;

  /** Length of the slice to cut so a chunk ends on a natural boundary. */
  function softCut(text, start, limit) {
    const slice = text.slice(start, start + limit);
    const punct = Math.max(slice.lastIndexOf(', '), slice.lastIndexOf('; '));
    if (punct > limit * 0.4) return punct + 1;
    const space = slice.lastIndexOf(' ');
    if (space > limit * 0.4) return space + 1;
    // Scripts without spaces (Khmer): use dictionary word boundaries.
    if (wordSegmenter) {
      let boundary = 0;
      for (const seg of wordSegmenter.segment(slice)) {
        if (seg.index > 0 && seg.index <= limit) boundary = seg.index;
      }
      if (boundary > limit * 0.3) return boundary;
    }
    return limit;
  }

  function chunkText(text) {
    const sentences = [];
    let last = 0;
    let match;
    SENTENCE_END.lastIndex = 0;
    while ((match = SENTENCE_END.exec(text))) {
      const end = match.index + match[0].length;
      sentences.push([last, end]);
      last = end;
    }
    if (last < text.length) sentences.push([last, text.length]);

    const chunks = [];
    sentences.forEach(([from, to]) => {
      let start = from;
      while (to - start > MAX_CHUNK) {
        const cut = softCut(text, start, MAX_CHUNK);
        chunks.push({ start, end: start + cut });
        start += cut;
      }
      if (to > start) chunks.push({ start, end: to });
    });

    // Merge very short neighbours so playback has fewer gaps.
    const merged = [];
    chunks.forEach((chunk) => {
      const prev = merged[merged.length - 1];
      if (prev && prev.end - prev.start < 60 && chunk.end - prev.start <= MAX_CHUNK) prev.end = chunk.end;
      else merged.push({ ...chunk });
    });
    return merged.filter((chunk) => SPOKEN.test(text.slice(chunk.start, chunk.end)));
  }

  function errorMessage(code) {
    switch (code) {
      case 'not-allowed':
        return 'The browser blocked speech playback. Press play to start listening.';
      case 'language-unavailable':
      case 'voice-unavailable':
        return 'This voice isn’t available on your device. Choose another voice.';
      case 'audio-busy':
      case 'audio-hardware':
        return 'Your audio device is busy or unavailable.';
      case 'network':
        return 'An online voice failed to load. Check your connection or pick a local voice.';
      case 'text-too-long':
        return 'This text is too long for the selected voice.';
      case 'synthesis-unavailable':
      case 'synthesis-failed':
        return 'The speech engine couldn’t synthesize this text. Try another voice.';
      default:
        return `Speech playback failed${code ? ` (${code})` : ''}.`;
    }
  }

  class SpeechPlayback extends App.Emitter {
    constructor({ text, voice = null, lang, rate = 1, pitch = 1, volume = 1, cps = 14 }) {
      super();
      this.kind = 'speech';
      this.state = 'idle';
      this.text = text;
      this.voice = voice;
      this.lang = lang;
      this.rate = rate;
      this.pitch = pitch;
      this.volume = volume;
      this.cps = cps;
      this.chunks = chunkText(text);
      this.length = Math.max(1, text.length);
      this.position = 0; // confirmed character offset
      this._display = 0; // smoothed offset used for the progress bar
      this._token = 0; // invalidates callbacks from cancelled utterances
      this._chunk = null;
      this._utterance = null;
      this._raf = 0;
      this._tickedAt = 0; // when the progress last moved (see _tick)
      this._pace = null; // { at, from }: when and where the voice began since playback (re)started
      this._watchdog = 0;
      this._run = null; // tracks an uninterrupted play-through to measure real duration
      this._tick = this._tick.bind(this);
    }

    static get supported() {
      return !!synth && typeof window.SpeechSynthesisUtterance === 'function';
    }

    get duration() {
      return this.length / (this.cps * this.rate);
    }

    get currentTime() {
      return (this._display / this.length) * this.duration;
    }

    snapshot() {
      return {
        currentTime: this.currentTime,
        duration: this.duration,
        progress: clamp(this._display / this.length, 0, 1),
        isEstimate: true,
      };
    }

    play() {
      if (!SpeechPlayback.supported) {
        this.emit('error', new Error('Speech synthesis isn’t supported in this browser.'));
        return;
      }
      if (this.state === 'playing') return;
      if (!this.chunks.length) {
        this.emit('error', new Error('There is nothing readable in this text.'));
        return;
      }
      App.Playback.claim(this);
      if (this.state === 'ended' || this.position >= this.length - 1) this.position = 0;
      this._display = this.position;
      this._run = this.position === 0 ? { startedAt: performance.now() } : null;
      this._setState('playing');
      this._speakFrom(this.position, true);
    }

    pause() {
      if (this.state !== 'playing') return;
      // Word boundaries are exact; without them fall back to the time estimate.
      // The progress may be drawn slightly past the chunk being spoken (see _tick); the voice can't be.
      const drawn = Math.min(Math.floor(this._display), this._chunk ? this._chunk.end : this.length);
      const reached = this._chunk && this._chunk.hasBoundaries ? this.position : Math.max(this.position, drawn);
      this._halt();
      this.position = this._snapBack(reached);
      this._display = this.position;
      this._run = null;
      this._setState('paused');
      this._emitProgress();
    }

    toggle() {
      if (this.state === 'playing') this.pause();
      else this.play();
    }

    stop() {
      if (this.state === 'playing') this._halt();
      else this._token++;
      this.position = 0;
      this._display = 0;
      this._run = null;
      this._setState('idle');
      this._emitProgress();
      App.Playback.release(this);
    }

    seek(ratio) {
      const target = this._snapBack(Math.floor(clamp(ratio, 0, 1) * this.length));
      this.position = target;
      this._display = target;
      this._run = null;
      if (this.state === 'playing') {
        this._halt();
        this._setState('playing');
        this._speakFrom(target, true);
      } else if (this.state !== 'paused') {
        this._setState('paused');
      }
      this._emitProgress();
    }

    setVolume(volume) {
      this.volume = clamp(volume, 0, 1); // applies from the next chunk
    }

    destroy() {
      if (this.state === 'playing') this._halt();
      this._token++;
      cancelAnimationFrame(this._raf);
      App.Playback.release(this);
      this.state = 'idle';
      this.removeAll();
    }

    /* ---------- internals ---------- */

    _halt() {
      this._token++;
      clearTimeout(this._watchdog);
      cancelAnimationFrame(this._raf);
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
      this._utterance = null;
      this._chunk = null;
    }

    _snapBack(pos) {
      if (pos <= 0) return 0;
      const before = this.text.slice(Math.max(0, pos - 40), pos);
      const space = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n'));
      return space === -1 ? pos : pos - before.length + space + 1;
    }

    _speakFrom(pos, afterCancel) {
      const token = ++this._token;
      const index = this.chunks.findIndex((chunk) => pos < chunk.end);
      if (index === -1) {
        this._finish();
        return;
      }
      this._tickedAt = 0;
      this._pace = null;
      this._raf = requestAnimationFrame(this._tick);
      // Chrome can drop a speak() issued in the same tick as cancel().
      const start = () => token === this._token && this._speakChunk(index, pos, token);
      if (afterCancel) setTimeout(start, 80);
      else start();
    }

    _speakChunk(index, from, token) {
      const chunk = this.chunks[index];
      if (!chunk) {
        this._finish();
        return;
      }
      const start = Math.max(from, chunk.start);
      const utterance = new SpeechSynthesisUtterance(this.text.slice(start, chunk.end));
      if (this.voice) utterance.voice = this.voice;
      utterance.lang = (this.voice && this.voice.lang) || this.lang;
      utterance.rate = this.rate;
      utterance.pitch = this.pitch;
      utterance.volume = this.volume;
      this._chunk = { start, end: chunk.end, startedAt: 0, hasBoundaries: false };

      let started = false;
      const markStarted = () => {
        if (started) return;
        started = true;
        clearTimeout(this._watchdog);
        this._chunk.startedAt = performance.now();
        if (!this._pace) this._pace = { at: this._chunk.startedAt, from: start }; // the voice has begun: time it from here
      };

      clearTimeout(this._watchdog);
      this._watchdog = setTimeout(() => {
        if (token === this._token && !started) {
          this._fail(new Error('The speech engine didn’t respond. Try another voice or reload the page.'));
        }
      }, 15000);

      utterance.onstart = () => token === this._token && markStarted();
      utterance.onboundary = (event) => {
        if (token !== this._token) return;
        markStarted();
        if (event.name && event.name !== 'word') return;
        this._chunk.hasBoundaries = true;
        this.position = Math.max(this.position, start + event.charIndex);
      };
      utterance.onend = () => {
        if (token !== this._token) return;
        clearTimeout(this._watchdog);
        this._calibrate(chunk.end);
        this.position = chunk.end;
        if (index + 1 < this.chunks.length) this._speakChunk(index + 1, this.chunks[index + 1].start, token);
        else this._finish();
      };
      utterance.onerror = (event) => {
        if (token !== this._token) return;
        if (event.error === 'interrupted' || event.error === 'canceled') return;
        this._fail(new Error(errorMessage(event.error)));
      };

      this._utterance = utterance; // keep a reference: Chrome may GC it and skip onend
      if (synth.paused) synth.resume();
      synth.speak(utterance);
    }

    /**
     * Learns the real speaking pace from everything spoken since playback (re)started, the pauses
     * between chunks included — that overall pace is what the progress has to keep to.
     */
    _calibrate(end) {
      const pace = this._pace;
      if (!pace) return;
      const seconds = (performance.now() - pace.at) / 1000;
      const chars = end - pace.from;
      if (seconds < 0.8 || chars < 15) return;
      const measured = chars / seconds / this.rate;
      if (measured > 1 && measured < 60) this.cps = this.cps * 0.35 + measured * 0.65;
    }

    _finish() {
      clearTimeout(this._watchdog);
      cancelAnimationFrame(this._raf);
      this.position = this.length;
      this._display = this.length;
      if (this._run) this.emit('measured', (performance.now() - this._run.startedAt) / 1000);
      this._run = null;
      this._setState('ended');
      this._emitProgress();
      App.Playback.release(this);
    }

    _fail(error) {
      this._halt();
      this._run = null;
      this._setState('paused');
      this.emit('error', error);
    }

    _setState(state) {
      this.state = state;
      this.emit('state', state);
    }

    _emitProgress() {
      this.emit('progress', this.snapshot());
    }

    /**
     * Moves the progress forward each frame. The voice doesn't say where it is — only that a chunk
     * started or ended, plus word boundaries for some voices — so the progress runs at the overall
     * speaking pace and holds that pace across chunks. It is steered gently, never snapped: a touch
     * faster when the voice turns out to be ahead, a touch slower when it has run too far past the
     * chunk being spoken, a creep while the voice is still loading, and an ease-out only at the very
     * end of the text.
     */
    _tick() {
      if (this.state !== 'playing') return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - (this._tickedAt || now)) / 1000); // a tab coming back from the background doesn't leap
      this._tickedAt = now;

      const chunk = this._chunk;
      if (chunk) {
        const speed = this.cps * this.rate; // characters per second
        const known = Math.max(this.position, chunk.start); // the voice is at least here
        const last = chunk.end >= this.chunks[this.chunks.length - 1].end;
        // The next chunk follows at once, so the progress may run a little past the one being spoken.
        const limit = last ? this.length - 0.5 : Math.min(this.length - 0.5, chunk.end + speed * 0.6);
        let factor = 1;
        if (!this._pace) factor = 0.3; // the voice is still loading: only creep
        else if (this._display < known) factor = 1 + Math.min(1.2, (known - this._display) / speed); // behind: make it up over about a second
        else if (chunk.hasBoundaries && this._display > this.position + speed * 0.6) factor = 0.6; // ahead of the last word heard
        const easeZone = Math.max(1.5, speed * (last ? 0.8 : 0.3));
        factor = Math.min(factor, Math.max(0.05, (limit - this._display) / easeZone)); // slow down toward the limit, don't stop
        this._display = Math.max(this._display, Math.min(this._display + speed * factor * dt, limit));
      }
      this._emitProgress();
      this._raf = requestAnimationFrame(this._tick);
    }
  }

  App.SpeechPlayback = SpeechPlayback;
})(window.VoiceAI = window.VoiceAI || {});
