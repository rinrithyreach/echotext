const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers.cjs');

function fixture(t) {
  const env = createApp();
  t.after(() => env.dom.window.close());
  env.window.Audio = class extends env.window.EventTarget {
    constructor() {
      super();
      this.paused = true;
      this.currentTime = 0;
      this.duration = 4;
      this.pending = [];
      this.pauseCalls = 0;
    }
    play() {
      this.paused = false;
      return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
    }
    pause() { this.paused = true; this.pauseCalls++; }
    removeAttribute() {}
    load() {}
    event(name) { this.dispatchEvent(new env.window.Event(name)); }
  };
  const make = () => new env.app.AudioPlayback(new Blob(['audio']));
  return { ...env, make };
}

test('switching players cancels pending audio before its queued play event', async (t) => {
  const { app, make } = fixture(t);
  const first = make();
  const second = make();
  t.after(() => { first.destroy(); second.destroy(); });
  const firstPlay = first.play();
  const secondPlay = second.play();
  assert.equal(first.audio.paused, true, 'the pending first player is paused immediately');
  assert.equal(first.state, 'paused');
  first.audio.event('play');
  assert.equal(first.state, 'paused', 'a stale play event cannot restart its UI animation');
  second.audio.event('play');
  assert.equal(second.state, 'playing');
  first.audio.pending[0].reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  second.audio.pending[0].resolve();
  await Promise.all([firstPlay, secondPlay]);
  assert.equal(app.Playback.active, second);
});

test('a second toggle pauses loading audio and stale failures cannot change a stopped player', async (t) => {
  const { make } = fixture(t);
  const playback = make();
  t.after(() => playback.destroy());
  const errors = [];
  playback.on('error', (error) => errors.push(error));
  const pending = playback.toggle();
  playback.toggle();
  assert.equal(playback.audio.paused, true);
  assert.equal(playback.state, 'paused');
  playback.stop();
  playback.audio.pending[0].reject(Object.assign(new Error('late denial'), { name: 'NotAllowedError' }));
  await pending;
  assert.equal(playback.state, 'idle');
  assert.deepEqual(errors, []);
});

test('destroyed audio ignores queued events and cannot reclaim playback', async (t) => {
  const { app, make } = fixture(t);
  const playback = make();
  const pending = playback.play();
  playback.destroy();
  playback.audio.event('play');
  playback.audio.event('error');
  playback.audio.pending[0].resolve();
  await pending;
  await playback.play();
  assert.equal(playback.audio.paused, true);
  assert.equal(playback.state, 'idle');
  assert.equal(app.Playback.active, null);
});
