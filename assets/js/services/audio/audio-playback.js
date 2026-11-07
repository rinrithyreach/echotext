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
      this._tick = this._tick.bind(this);

      const audio = this.audio;
      audio.addEventListener('loadedmetadata', () => this.emit('progress', this.snapshot()));
      audio.addEventListener('play', () => this._setState('playing'));
      audio.addEventListener('pause', () => {
        if (this.state === 'playing') this._setState('paused');
      });
      audio.addEventListener('ended', () => {
        this._setState('ended');
        this.emit('progress', this.snapshot());
        Playback.release(this);
      });
      audio.addEventListener('error', () => this.emit('error', new Error('This audio file could not be played.')));
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
      Playback.claim(this);
      if (this.state === 'ended') this.audio.currentTime = 0;
      try {
        await this.audio.play();
      } catch (err) {
        if (err.name === 'AbortError') return;
        this._setState('paused');
        this.emit(
          'error',
          err.name === 'NotAllowedError' ? new Error('Your browser blocked autoplay. Press play to listen.') : err
        );
      }
    }

    pause() {
      if (this.state === 'playing') this.audio.pause();
    }

    toggle() {
      return this.state === 'playing' ? this.pause() : this.play();
    }

    stop() {
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
      cancelAnimationFrame(this._raf);
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      URL.revokeObjectURL(this.url);
      Playback.release(this);
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
