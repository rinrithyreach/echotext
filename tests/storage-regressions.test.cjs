const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers.cjs');

function fixture(t) {
  const env = createApp();
  t.after(() => env.window.close());
  return env;
}

function result(id, extra = {}) {
  return { id, text: 'Saved narration.', title: id, language: 'en-US', createdAt: Date.now(), ...extra };
}

test('deleting while another recording is saved preserves the new recording and current title for Undo', async (t) => {
  const { app } = fixture(t);
  const blob = new Blob(['first audio'], { type: 'audio/wav' });
  await app.History.add(result('first', { blob }));
  let release;
  const read = new Promise((resolve) => { release = resolve; });
  app.AudioStore.get = () => read;
  const removal = app.History.remove('first');
  await app.History.add(result('second'));
  app.History.rename('first', 'Renamed during deletion');
  release(blob);
  const removed = await removal;
  assert.equal(removed.item.title, 'Renamed during deletion');
  assert.deepEqual(Array.from(app.History.list(), (item) => item.id), ['second']);
  await app.History.restore(removed);
  assert.equal(app.History.list().length, 2);
  assert.equal(app.History.get('first').hasAudio, true);
});

test('simultaneous History deletions do not resurrect one another', async (t) => {
  const { app } = fixture(t);
  const blob = new Blob(['audio']);
  await app.History.add(result('first', { blob }));
  await app.History.add(result('second', { blob }));
  const pending = [];
  app.AudioStore.get = () => new Promise((resolve) => pending.push(resolve));
  const first = app.History.remove('first');
  const second = app.History.remove('second');
  pending[0](blob);
  await first;
  pending[1](blob);
  await second;
  assert.equal(app.History.list().length, 0);
});

test('failed removal read and failed Undo write leave History metadata accurate', async (t) => {
  const { app } = fixture(t);
  const blob = new Blob(['audio']);
  await app.History.add(result('first', { blob }));
  const get = app.AudioStore.get;
  app.AudioStore.get = async () => { throw new Error('Read unavailable'); };
  await assert.rejects(app.History.remove('first'), /Read unavailable/);
  assert.equal(app.History.get('first').hasAudio, true);
  app.AudioStore.get = get;
  const removed = await app.History.remove('first');
  app.AudioStore.put = async () => { throw new Error('Storage full'); };
  await assert.rejects(app.History.restore(removed), /Storage full/);
  assert.equal(app.History.get('first'), null);
});

test('failed History metadata saves preserve old audio and do not orphan new files', async (t) => {
  const { app } = fixture(t);
  const old = new Blob(['old audio']);
  await app.History.add(result('existing', { blob: old }));
  app.storage.set = () => false;
  await assert.rejects(app.History.add(result('existing', { blob: new Blob(['replacement']) })), /History could not/);
  assert.equal(await (await app.History.getAudio('existing')).text(), 'old audio');
  await assert.rejects(app.History.add(result('new', { blob: new Blob(['new audio']) })), /History could not/);
  assert.equal(await app.History.getAudio('new'), null);
});

test('language pruning only removes audio after metadata has been saved', async (t) => {
  const { app } = fixture(t);
  await app.History.add(result('legacy', { language: 'fr-FR', blob: new Blob(['legacy audio']) }));
  app.storage.set = () => false;
  assert.throws(() => app.History.pruneLanguages(), /History could not/);
  assert.equal(await (await app.History.getAudio('legacy')).text(), 'legacy audio');
  assert.equal(app.History.list().length, 1);
});

test('malformed saved History and presets do not break the studio', (t) => {
  const { app } = fixture(t);
  for (const invalid of [null, {}, 'broken', 42]) {
    app.storage.set('history', invalid);
    assert.equal(app.History.list().length, 0);
    assert.doesNotThrow(() => app.History.pruneLanguages());
  }
  app.storage.set('history', [null, [], 42, { title: 'Missing id' }, { id: 'missing-text' }, result('valid', { project: 42, title: null, createdAt: 'invalid' })]);
  assert.equal(app.History.list().length, 1);
  assert.equal(app.History.projects()[0], '42');
  assert.equal(app.History.get('valid').title, 'Saved narration.');
  assert.doesNotThrow(() => app.utils.relativeTime(app.History.get('valid').createdAt));
  app.storage.set('settings', { presets: [{ id: 'invalid', name: 42 }, null, { id: 'good', name: 'Narration' }] });
  assert.equal(app.Presets.list().length, 1);
  assert.doesNotThrow(() => app.Presets.save('Narration', app.config.voiceDefaults));
  assert.doesNotThrow(() => app.Settings.voice(null));
});

test('short PDFs with selectable text import successfully; empty scans still fail', async (t) => {
  const { app, window } = fixture(t);
  let text = 'Hi!';
  let destroyed = 0;
  window.pdfjsWorker = {};
  window.pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument: () => ({ promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({ getTextContent: async () => ({ items: [{ str: text, hasEOL: true, height: 12, transform: [1, 0, 0, 1, 0, 10] }] }), cleanup() {} }),
      destroy() { destroyed++; },
    }) }),
  };
  const file = { name: 'short.pdf', type: 'application/pdf', size: 3, arrayBuffer: async () => new ArrayBuffer(3) };
  assert.equal((await app.DocumentImport.extract(file)).text, 'Hi!');
  text = '  ';
  await assert.rejects(app.DocumentImport.extract(file), (error) => error.code === 'no_text');
  assert.equal(destroyed, 2);
});
