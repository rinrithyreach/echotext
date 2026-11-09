/**
 * EchoText — Audio file playback
 *
 * Both playback engines (AudioPlayback for files, SpeechPlayback for live
 * browser speech) share one interface so the UI never cares which it has:
 *
 *   play() · pause() · toggle() · stop() · seek(ratio) · setVolume(v) · destroy()
 *   state: 'idle' | 'playing' | 'paused' | 'ended'
 *   events: 'state', 'progress' ({ currentTime, duration, progress, isEstimate }), 'error', 'measured'
 */
(function (App) {
  'use strict';

  const { clamp } = App.utils;

  /** Guarantees only one source is audible at a time. */
  const Playback = {
    active: null,
    claim(playback) {
      if (this.active && this.active !== playback) this.active.pause();
      this.active = playback;
    },
    release(playback) {
      if (this.active === playback) this.active = null;
    },
    stopAll() {
      if (this.active) this.active.stop();
      this.active = null;
    },
  };

  class AudioPlayback extends App.Emitter {
    constructor(blob, { volume = 1, duration = 0 } = {}) {
      super();
      this.kind = 'audio';
      this.state = 'idle';
      this.knownDuration = duration;
      this.url = URL.createObjectURL(blob);
      this.audio = new Audio(this.url);
      this.audio.preload = 'auto';
      this.audio.volume = clamp(volume, 0, 1);
      this._raf = 0;
      this._playToken = 0;
      this._pendingPlay = false;
      this._destroyed = false;
      this._tick = this._tick.bind(this);

      const audio = this.audio;
      audio.addEventListener('loadedmetadata', () => {
        if (!this._destroyed) this.emit('progress', this.snapshot());
      });
      audio.addEventListener('play', () => {
        // Media events are queued: another player may have claimed playback before this arrives.
        if (this._destroyed || Playback.active !== this) { audio.pause(); return; }
        if (!audio.paused) this._setState('playing');
      });
      audio.addEventListener('pause', () => {
        if (!this._destroyed && audio.paused && this.state === 'playing') this._setState('paused');
      });
      audio.addEventListener('ended', () => {
        if (this._destroyed) return;
        this._setState('ended');
        this.emit('progress', this.snapshot());
        Playback.release(this);
      });
      audio.addEventListener('error', () => {
        if (this._destroyed) return;
        this._playToken++;
        this._pendingPlay = false;
        this._setState('paused');
        Playback.release(this);
        this.emit('error', new Error('This audio file could not be played.'));
      });
    }

    get duration() {
      const d = this.audio.duration;
      return Number.isFinite(d) && d > 0 ? d : this.knownDuration || 0;
    }

    get currentTime() {
      return this.audio.currentTime;
    }

    snapshot() {
      const duration = this.duration;
      const progress = this.state === 'ended' ? 1 : duration ? this.currentTime / duration : 0;
      return { currentTime: this.state === 'ended' ? duration : this.currentTime, duration, progress: clamp(progress, 0, 1), isEstimate: false };
    }

    async play() {
      if (this._destroyed || this._pendingPlay || this.state === 'playing') return;
      const token = ++this._playToken;
      this._pendingPlay = true;
      Playback.claim(this);
      if (this.state === 'ended') this.audio.currentTime = 0;
      try {
        await this.audio.play();
      } catch (err) {
        if (token !== this._playToken || this._destroyed) return;
        this._setState('paused');
        Playback.release(this);
        if (err.name === 'AbortError') return;
        this.emit(
          'error',
          err.name === 'NotAllowedError' ? new Error('Your browser blocked autoplay. Press play to listen.') : err
        );
      } finally {
        if (token === this._playToken) this._pendingPlay = false;
      }
    }

    pause() {
      if (this._destroyed) return;
      const wasActive = this._pendingPlay || this.state === 'playing';
      this._playToken++;
      this._pendingPlay = false;
      // pause() must also cancel a play() waiting for enough audio to become available.
      this.audio.pause();
      if (wasActive && this.state !== 'paused') this._setState('paused');
      Playback.release(this);
    }

    toggle() {
      return this._pendingPlay || this.state === 'playing' ? this.pause() : this.play();
    }

    stop() {
      if (this._destroyed) return;
      this._playToken++;
      this._pendingPlay = false;
      this.audio.pause();
      this.audio.currentTime = 0;
      this._setState('idle');
      this.emit('progress', this.snapshot());
      Playback.release(this);
    }

    seek(ratio) {
      const duration = this.duration;
      if (!duration) return;
      this.audio.currentTime = clamp(ratio, 0, 1) * duration;
      if (this.state === 'ended' || this.state === 'idle') this._setState('paused');
      this.emit('progress', this.snapshot());
    }

    setVolume(volume) {
      this.audio.volume = clamp(volume, 0, 1);
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this._playToken++;
      this._pendingPlay = false;
      cancelAnimationFrame(this._raf);
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      URL.revokeObjectURL(this.url);
      Playback.release(this);
      this.state = 'idle';
      this.removeAll();
    }

    _setState(state) {
      this.state = state;
      this.emit('state', state);
      cancelAnimationFrame(this._raf);
      if (state === 'playing') this._raf = requestAnimationFrame(this._tick);
    }

    _tick() {
      this.emit('progress', this.snapshot());
      if (this.state === 'playing') this._raf = requestAnimationFrame(this._tick);
    }
  }

  App.Playback = Playback;
  App.AudioPlayback = AudioPlayback;
})(window.VoiceAI = window.VoiceAI || {});
