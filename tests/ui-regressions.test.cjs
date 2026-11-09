const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers.cjs');

function fixture(t) {
  const env = createApp();
  t.after(() => env.window.close());
  return env;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for the interface');
}

function historyItems(app, ...ids) {
  app.storage.set('history', ids.map((id, index) => ({
    id, title: `Audio ${index}`, text: `Text ${index}`, language: 'en-US',
    duration: 2, createdAt: Date.now() - index, voiceName: 'ENGLISH',
  })));
}

function fakePlayback(app) {
  return new class extends app.Emitter {
    constructor() { super(); this.state = 'idle'; this.plays = 0; this.toggles = 0; }
    play() { this.plays++; this.state = 'playing'; this.emit('state', this.state); }
    toggle() { this.toggles++; }
    destroy() { this.destroyed = true; }
    snapshot() { return { progress: 0 }; }
  }();
}

test('a stale History playback failure cannot cancel a newer selection', async (t) => {
  const { app, window } = fixture(t);
  historyItems(app, 'first', 'second');
  const gates = [];
  app.TTS.openPlayback = () => new Promise((resolve, reject) => gates.push({ resolve, reject }));
  const root = window.document.getElementById('root');
  const list = app.components.HistoryList.mount(root);
  const play = [...root.querySelectorAll('[data-act="play"]')];
  play[0].click();
  play[1].click();
  gates[0].reject(new Error('Old selection failed'));
  await tick();
  const playback = fakePlayback(app);
  gates[1].resolve(playback);
  await until(() => playback.plays === 1);
  assert.equal(root.querySelector('.is-playing').dataset.id, 'second');
  assert.equal(window.document.querySelector('.toast-error'), null);
  play[1].click();
  assert.equal(playback.toggles, 1);
  list.destroy();
});

test('History ignores duplicate loading clicks and destroys playback resolved after unmount', async (t) => {
  const { app, window } = fixture(t);
  historyItems(app, 'first');
  let resolve;
  let calls = 0;
  app.TTS.openPlayback = () => { calls++; return new Promise((done) => { resolve = done; }); };
  const root = window.document.getElementById('root');
  const list = app.components.HistoryList.mount(root);
  const button = root.querySelector('[data-act="play"]');
  button.click();
  button.click();
  assert.equal(calls, 1);
  list.destroy();
  const playback = fakePlayback(app);
  resolve(playback);
  await tick();
  assert.equal(playback.destroyed, true);
  assert.equal(playback.plays, 0);
  assert.equal(button.classList.contains('is-loading'), false);
});

test('failed History removal leaves the audio visible and reports the error', async (t) => {
  const { app, window } = fixture(t);
  historyItems(app, 'first');
  app.modal.confirm = async () => true;
  app.History.remove = async () => { throw new Error('Storage unavailable'); };
  const root = window.document.getElementById('root');
  const list = app.components.HistoryList.mount(root);
  root.querySelector('[data-act="delete"]').click();
  await until(() => window.document.querySelector('.toast-error'));
  assert.equal(root.querySelector('.history-item').classList.contains('is-removing'), false);
  assert.match(window.document.querySelector('.toast-error').textContent, /Storage unavailable/);
  list.destroy();
});

test('failed History Undo reports its storage error without an unhandled rejection', async (t) => {
  const { app, window } = fixture(t);
  historyItems(app, 'first');
  app.modal.confirm = async () => true;
  let undo;
  app.toast.success = (_title, _message, options) => { undo = options.action.onClick; };
  app.History.restore = async () => { throw new Error('Audio restoration failed'); };
  const root = window.document.getElementById('root');
  const list = app.components.HistoryList.mount(root);
  root.querySelector('[data-act="delete"]').click();
  await until(() => undo);
  await undo();
  assert.match(window.document.querySelector('.toast-error').textContent, /Audio restoration failed/);
  list.destroy();
});

test('saved History IDs are rendered as data even when they contain markup and CSS syntax', (t) => {
  const { app, window, errors } = fixture(t);
  const id = 'audio\"]<img src=x onerror="bad()">';
  historyItems(app, id);
  const root = window.document.getElementById('root');
  const list = app.components.HistoryList.mount(root);
  assert.equal(root.querySelector('.history-item').dataset.id, id);
  assert.equal(root.querySelector('img'), null);
  app.History.update(id, { duration: 9 });
  assert.equal(root.querySelector('[data-length]').textContent, '0:09');
  assert.equal(errors.length, 0);
  list.destroy();
});

test('navbar reports a failed language save', (t) => {
  const { app, window, errors } = fixture(t);
  app.Theme.init();
  const root = window.document.getElementById('root');
  app.components.Navbar.mount(root);
  app.storage.set = () => false;
  root.querySelector('[data-ui-language="km"]').click();
  assert.equal(app.i18n.language, 'en');
  assert.equal(root.querySelector('[data-ui-language="en"]').getAttribute('aria-pressed'), 'true');
  assert.match(window.document.querySelector('.toast-error').textContent, /Settings could not/);
  assert.equal(errors.length, 0);
});

test('voice panel summary follows the selected speech language and interface translation', (t) => {
  const { app, window } = fixture(t);
  const root = window.document.getElementById('root');
  const studio = app.components.Generator.mount(root);
  const summary = () => root.querySelector('[data-panel-summary]').textContent;
  assert.equal(summary(), 'English · ENGLISH');
  const khmer = root.querySelector('[data-language-radio][value="km-KH"]');
  khmer.checked = true;
  khmer.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(summary(), 'Khmer · KHMER');
  studio.destroy();
  app.i18n.set('km');
  const translated = app.components.Generator.mount(root);
  assert.equal(summary(), `${app.t('Khmer')} · KHMER`);
  translated.destroy();
});

test('a queued studio section focus is cancelled when navigating away', async (t) => {
  const { app, errors } = fixture(t);
  let focused = 0;
  app.pages.home.generator = { focus() { focused++; }, destroy() {} };
  app.pages.home.onSection('studio');
  app.pages.home.unmount();
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(focused, 0);
  assert.equal(errors.length, 0, errors.map(String).join('\n'));
});

