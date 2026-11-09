const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers.cjs');

function fixture(t) {
  const env = createApp();
  t.after(() => env.dom.window.close());
  const track = new env.window.EventTarget();
  track.stopped = false;
  track.stop = () => { track.stopped = true; };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  env.window.navigator.mediaDevices = { getDisplayMedia: async () => stream };
  env.window.MediaStream = class {};
  const recorders = [];
  env.window.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  };
  let plays = 0;
  const playback = new env.app.Emitter();
  playback.play = () => { plays++; };
  playback.destroy = () => { playback.destroyed = true; playback.removeAll(); };
  env.app.TTS.openPlayback = async () => playback;
  return { ...env, track, recorders, playback, plays: () => plays };
}

test('cancelling while the browser voice loads always ends screen sharing', async (t) => {
  const { app, track, recorders, playback } = fixture(t);
  let voiceReady;
  let loading;
  const startedLoading = new Promise((resolve) => { loading = resolve; });
  app.TTS.openPlayback = () => { loading(); return new Promise((resolve) => { voiceReady = resolve; }); };
  const controller = new AbortController();
  const pending = app.SpeechRecorder.record({ text: 'Hello' }, { signal: controller.signal });
  await startedLoading;
  controller.abort();
  voiceReady(playback);
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(track.stopped, true);
  assert.equal(playback.destroyed, true);
  assert.equal(recorders.length, 0);
});

test('ending screen sharing during lead-in never starts a delayed voice', async (t) => {
  const { app, window, track, recorders, playback, plays } = fixture(t);
  const pending = app.SpeechRecorder.record({ text: 'Hello' });
  while (!recorders.length) await new Promise((resolve) => setImmediate(resolve));
  track.dispatchEvent(new window.Event('ended'));
  await assert.rejects(pending, { code: 'capture_ended' });
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(plays(), 0);
  assert.equal(recorders[0].state, 'inactive');
  assert.equal(playback.destroyed, true);
  assert.equal(track.stopped, true);
});
