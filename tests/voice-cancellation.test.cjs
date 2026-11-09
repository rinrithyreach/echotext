const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers.cjs');

function fixture(t) {
  const env = createApp();
  t.after(() => env.dom.window.close());
  env.app.AIVoice.checkDevice = async () => ({ ok: true });
  return env;
}

test('a model load cancelled while queued never starts loading scripts', async (t) => {
  const { app, window } = fixture(t);
  let scripts = 0;
  window.document.head.appendChild = () => { scripts++; };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(app.AIVoice.load(app.AIVoice.voices[0], { signal: controller.signal }), { code: 'aborted' });
  assert.equal(scripts, 0);
});

test('cancelling between bundled files stops before reading the rest of the engine or voice', async (t) => {
  const { app, window } = fixture(t);
  const scripts = [];
  const controller = new AbortController();
  window.document.head.appendChild = (script) => {
    scripts.push(script.src);
    // Simulate the first bundled chunk finishing just as Cancel is pressed.
    app.AIVoice.receive('ort-wasm-simd.wasm', 0, 'AA==');
    controller.abort();
    script.onload();
    return script;
  };
  await assert.rejects(app.AIVoice.load(app.AIVoice.voices[0], { signal: controller.signal }), { code: 'aborted' });
  assert.equal(scripts.length, 1, 'the runtime loader and remaining voice files are never requested');
  assert.equal(app.AIVoice.activity(app.AIVoice.voices[0].id), null);
});
