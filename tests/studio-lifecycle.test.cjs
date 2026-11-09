const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp, root: projectRoot } = require('./helpers.cjs');

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t) {
  const env = createApp();
  t.after(() => env.window.close());
  env.app.AIVoice.checkDevice = async () => ({ ok: true, errors: [], warnings: [] });
  env.root = env.window.document.getElementById('root');
  env.generator = env.app.components.Generator.mount(env.root);
  return env;
}
function playback(app) {
  const pb = new app.Emitter();
  pb.state = 'idle';
  pb.play = () => { pb.played = true; };
  pb.destroy = () => { pb.destroyed = true; };
  return pb;
}

test('a pending preview never starts after the studio closes or the voice changes', async (t) => {
  for (const action of ['destroy', 'language']) {
    const { app, window, root, generator } = fixture(t);
    await tick();
    const check = deferred();
    app.AIVoice.checkDevice = () => check.promise;
    let previews = 0;
    app.TTS.preview = async () => { previews++; return playback(app); };
    root.querySelector('[data-preview-voice]').click();
    if (action === 'destroy') generator.destroy();
    else {
      const radio = root.querySelector('[value="km-KH"]');
      radio.checked = true;
      radio.dispatchEvent(new window.Event('change', { bubbles: true }));
    }
    check.resolve({ ok: true, errors: [], warnings: [] });
    await tick();
    assert.equal(previews, 0, action);
  }
});

test('preview device-check failures are caught and a second click cancels a pending preview', async (t) => {
  const { app, root } = fixture(t);
  await tick();
  const check = deferred();
  app.AIVoice.checkDevice = () => check.promise;
  let previews = 0;
  app.TTS.preview = async () => { previews++; return playback(app); };
  const button = root.querySelector('[data-preview-voice]');
  button.click();
  button.click();
  check.resolve({ ok: true, errors: [], warnings: [] });
  await tick();
  assert.equal(previews, 0);
  const failed = deferred();
  app.AIVoice.checkDevice = () => failed.promise;
  const errors = [];
  app.toast.error = (...args) => errors.push(args);
  button.click();
  failed.reject(new Error('Storage unavailable'));
  await tick();
  assert.equal(errors[0][0], 'Preview failed');
  assert.match(errors[0][1], /Storage unavailable/);
});

test('older device notes cannot replace notes for the latest voice', async (t) => {
  const { app, window, root } = fixture(t);
  await tick();
  const checks = [];
  app.AIVoice.checkDevice = () => {
    const check = deferred();
    checks.push(check);
    return check.promise;
  };
  for (const code of ['km-KH', 'en-US']) {
    const radio = root.querySelector(`[value="${code}"]`);
    radio.checked = true;
    radio.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  checks[1].resolve({ ok: true, errors: [], warnings: ['Current voice warning'] });
  await tick();
  checks[0].resolve({ ok: true, errors: [], warnings: ['Stale voice warning'] });
  await tick();
  assert.equal(root.querySelector('[data-notes]').textContent.trim(), 'Current voice warning');
});

test('late document imports cannot overwrite a newer import or a closed studio draft', async (t) => {
  const { app, window, root, generator } = fixture(t);
  const imports = [];
  app.DocumentImport.extract = () => {
    const item = deferred();
    imports.push(item);
    return item.promise;
  };
  function drop(name) {
    const event = new window.Event('drop', { bubbles: true, cancelable: true });
    event.dataTransfer = { types: ['Files'], files: [{ name }] };
    root.querySelector('[data-editor]').dispatchEvent(event);
  }
  drop('first.txt');
  drop('second.txt');
  imports[1].resolve({ kind: 'txt', text: 'Newest document' });
  await tick();
  imports[0].resolve({ kind: 'txt', text: 'Old document' });
  await tick();
  assert.equal(root.querySelector('[data-text]').value, 'Newest document');
  drop('third.txt');
  generator.destroy();
  imports[2].resolve({ kind: 'txt', text: 'Detached document' });
  await tick();
  assert.equal(root.querySelector('[data-text]').value, 'Newest document');
  assert.equal(app.storage.get('draft'), 'Newest document');
});

test('opening a History item without audio clears the previous result and carried player', (t) => {
  const { app, root, generator } = fixture(t);
  app.components.Player.create = (mount) => {
    mount.innerHTML = '<div data-old-player></div>';
    return { destroy() { mount.innerHTML = ''; } };
  };
  generator.load({ id: 'with-audio', text: 'First item', hasAudio: true });
  generator.load({ id: 'no-audio', text: 'Second item', hasAudio: false });
  assert.equal(root.querySelector('[data-result]').hidden, true);
  assert.equal(generator.destroy().shown, null);
});

test('pagehide saves the latest text and voice before debounce timers run', (t) => {
  const { app, window, root, generator } = fixture(t);
  generator.setText('The final keystroke');
  const slider = root.querySelector('[data-range="rate"]');
  slider.value = '1.5';
  slider.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.dispatchEvent(new window.Event('pagehide'));
  assert.equal(app.storage.get('draft'), 'The final keystroke');
  assert.equal(app.Settings.get().lastVoice.rate, 1.5);
});

test('full settings storage cannot interrupt studio teardown', (t) => {
  const { app, generator } = fixture(t);
  app.storage.set = (key) => key !== 'settings';
  generator.setText('Keep the editor usable');
  assert.doesNotThrow(() => generator.destroy());
});

test('delayed clipboard reads cannot change the text after edits, teardown or generation', async (t) => {
  for (const action of ['edit', 'destroy', 'generate']) {
    const { app, window, root, generator } = fixture(t);
    generator.setText('Original text');
    const read = deferred();
    Object.defineProperty(window.navigator, 'clipboard', { value: { readText: () => read.promise } });
    root.querySelector('[data-action="paste"]').click();
    if (action === 'edit') generator.setText('Newer text');
    else if (action === 'destroy') generator.destroy();
    else {
      app.AIVoice.checkDevice = () => new Promise(() => {});
      root.querySelector('[data-action="generate"]').click();
    }
    const expected = root.querySelector('[data-text]').value;
    read.resolve('Late clipboard contents');
    await tick();
    assert.equal(root.querySelector('[data-text]').value, expected, action);
  }
});

test('audio downloads keep the chosen name when History persistence fails', (t) => {
  const { app, root } = fixture(t);
  const item = { id: 'recording', text: 'Download this', title: 'Download this', language: 'en-US', duration: 1 };
  app.History.get = () => ({ ...item, fileName: null });
  app.History.update = () => { throw new Error('Storage is full'); };
  let exported;
  app.AudioUtils.exportAudio = (result) => { exported = result.fileName; };
  const mount = root.ownerDocument.createElement('div');
  root.appendChild(mount);
  app.components.Player.create(mount, item);
  mount.querySelector('[data-filename]').value = 'My recording';
  mount.querySelector('[data-download]').click();
  assert.equal(exported, 'My recording');
});

test('the site still boots when legacy History cleanup cannot be saved', async (t) => {
  const { app, window, generator } = fixture(t);
  await tick();
  generator.destroy();
  window.document.body.innerHTML = '<a data-skip href="#main">Skip</a><header id="navbar"></header><main id="main"></main><div id="toast-region"></div><div id="modal-root"></div>';
  app.History.pruneLanguages = () => { throw new Error('Storage is full'); };
  assert.doesNotThrow(() => window.eval(fs.readFileSync(path.join(projectRoot, 'assets/js/app.js'), 'utf8')));
  assert.ok(window.document.querySelector('[data-text]'));
});
