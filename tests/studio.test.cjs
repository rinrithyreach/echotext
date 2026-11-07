const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp, root } = require('./helpers.cjs');

function fixture(t) {
  const env = createApp();
  t.after(() => env.dom.window.close());
  return env;
}

function fakeSynthesis(app, calls = []) {
  app.AIVoice.synthesize = async (input, { signal, onProgress } = {}) => {
    if (signal?.aborted) throw new app.TTSError('Stopped', { code: 'aborted' });
    calls.push(input);
    const texts = input.cueTexts || app.TextSegments.cues(input.text);
    const sampleRate = 22050;
    const samples = new Float32Array(texts.length * sampleRate);
    samples.fill(0.25);
    onProgress?.({ phase: 'speak', loaded: texts.length, total: texts.length });
    return { samples, sampleRate, duration: texts.length, voice: app.AIVoice.voiceFor(input), cues: texts.map((text, index) => ({ text, start: index, end: index + 1 })) };
  };
}

function playbackStub(app) {
  const played = [];
  app.AudioPlayback = class extends app.Emitter {
    constructor(blob, options) { super(); this.blob = blob; this.duration = options.duration; this.state = 'idle'; played.push(this); }
    play() { this.state = 'playing'; this.emit('state', this.state); }
    pause() { this.state = 'paused'; }
    stop() { this.state = 'idle'; }
    toggle() { this.state === 'playing' ? this.pause() : this.play(); }
    snapshot() { return { progress: 0, currentTime: 0, duration: this.duration, isEstimate: false }; }
    destroy() { this.destroyed = true; }
  };
  return played;
}

async function until(condition) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for the studio');
}

test('long text is preserved across bounded sections, including long words and Unicode', (t) => {
  const { app } = fixture(t);
  const text = ('Dr. Smith speaks clearly. Numbers like 3.14 stay readable.\n\n' + 'x'.repeat(230) + ' 😀 Hello! ').repeat(35);
  assert.ok(text.length > 5000);
  const groups = app.TextSegments.sections(text);
  assert.ok(groups.length > 1);
  assert.ok(groups.every((group) => group.join(' ').length <= 900));
  assert.equal(groups.flat().join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.equal(app.TTS.validate(text), text.trim());
  assert.throws(() => app.TTS.validate('a'.repeat(50001)), /not been shortened/);
});

test('stopping checkpoints completed sections; a reloaded service resumes without regenerating them', async (t) => {
  const { app, window } = fixture(t);
  const calls = [];
  fakeSynthesis(app, calls);
  const controller = new AbortController();
  const text = 'This is a long narration with several sentences. '.repeat(150);
  await assert.rejects(app.TTS.generate({ ...app.config.voiceDefaults, text }, {
    signal: controller.signal,
    onProgress: (info) => { if (info.phase === 'section' && info.completed === 1) controller.abort(); },
  }), (error) => error.code === 'aborted');
  const [job] = await app.GenerationStore.list();
  assert.equal(job.completed, 1);
  assert.equal(calls.length, 1);
  // Reset the facade's in-memory state to simulate a page reload.
  window.eval(fs.readFileSync(path.join(root, 'assets/js/services/tts/tts-service.js'), 'utf8'));
  const result = await app.TTS.generate({}, { resumeId: job.id });
  assert.equal(result.id, job.id);
  assert.equal(result.text, text.trim());
  assert.equal(calls.length, job.sections.length);
  assert.equal(result.cues.map((cue) => cue.text).join(''), app.TextSegments.cues(text).join(''));
  assert.ok(result.cues.every((cue, index) => cue.end > cue.start && (index === 0 || cue.start >= result.cues[index - 1].end)));
  assert.ok(Math.abs(result.cues.at(-1).end - result.duration) < 0.001);
  const data = new DataView(await result.blob.arrayBuffer());
  assert.equal(data.getUint32(40, true), result.blob.size - 44);
  assert.equal(data.getUint32(24, true), 22050);
  await app.History.add(result);
  const saved = app.History.get(result.id);
  assert.equal(saved.cues.length, result.cues.length);
  assert.equal(saved.hasAudio, true);
  assert.equal((await app.History.getAudio(result.id)).size, result.blob.size);
  await app.GenerationStore.remove(result.id);
  assert.equal((await app.GenerationStore.list()).length, 0);
  assert.equal(await app.GenerationStore.part(result.id, 0), undefined);
});

test('failed inference preserves earlier sections and retries only unfinished work', async (t) => {
  const { app } = fixture(t);
  const calls = [];
  fakeSynthesis(app, calls);
  const synthesize = app.AIVoice.synthesize;
  app.AIVoice.synthesize = (...args) => {
    if (calls.length === 1) return Promise.reject(new Error('Model interrupted'));
    return synthesize(...args);
  };
  await assert.rejects(app.TTS.generate({ ...app.config.voiceDefaults, text: 'A sentence for recovery. '.repeat(100) }), /Model interrupted/);
  const [job] = await app.GenerationStore.list();
  assert.equal(job.completed, 1);
  app.AIVoice.synthesize = synthesize;
  const result = await app.TTS.generate({}, { resumeId: job.id });
  assert.equal(calls.length, job.sections.length);
  assert.ok(result.blob.size > 44);
});

test('a checkpoint storage failure never marks an unsaved section complete', async (t) => {
  const { app } = fixture(t);
  fakeSynthesis(app);
  const save = app.GenerationStore.save;
  app.GenerationStore.save = async () => { const error = new Error('Full'); error.name = 'QuotaExceededError'; throw error; };
  await assert.rejects(app.TTS.generate({ ...app.config.voiceDefaults, text: 'Storage failure example.' }), (error) => error.code === 'storage');
  const [job] = await app.GenerationStore.list();
  assert.equal(job.completed, 0);
  assert.equal(await app.GenerationStore.part(job.id, 0), undefined);
  app.GenerationStore.save = save;
  assert.ok((await app.TTS.generate({}, { resumeId: job.id })).blob.size > 44);
});

test('playback and WAV export reuse the generated blob without another synthesis', async (t) => {
  const { app } = fixture(t);
  const calls = [];
  fakeSynthesis(app, calls);
  const result = await app.TTS.generate({ ...app.config.voiceDefaults, text: 'Use this exact audio.' });
  const played = playbackStub(app);
  await app.TTS.openPlayback(result);
  assert.equal(played[0].blob, result.blob);
  let saved;
  app.FileSaver.prepare = async (filename) => ({ filename });
  app.FileSaver.commit = async (target, blob) => { saved = { target, blob }; return 'downloaded'; };
  app.FileSaver.announce = () => {};
  assert.equal(await app.AudioUtils.exportAudio(result, null, 'wav'), true);
  assert.equal(saved.blob, result.blob);
  assert.match(saved.target.filename, /\.wav$/);
  assert.equal(calls.length, 1);
});

test('studio default voice, generation, audio downloads and history reopening are connected', async (t) => {
  const { app, window, errors } = fixture(t);
  const calls = [];
  fakeSynthesis(app, calls);
  playbackStub(app);
  const root = window.document.getElementById('root');
  const studio = app.components.Generator.mount(root);
  // English has one automatically selected default and one Preview button.
  assert.deepEqual([...root.querySelectorAll('[data-tab]')].map((tab) => tab.dataset.tab), ['voice', 'controls']);
  assert.deepEqual([...root.querySelectorAll('[data-panel="controls"] [data-range]')].map((input) => input.dataset.range), ['rate', 'pitch']);
  assert.equal(root.querySelector('[data-say-form]'), null);
  assert.equal(root.querySelector('[data-project], [data-project-list]'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(app.AIVoice.forLanguage('en-US').map((v) => v.id))), ['en_US-kristin-medium']);
  assert.equal(root.querySelectorAll('[data-voice-row]').length, 1);
  assert.equal(root.querySelector('[data-voice-row]').dataset.voiceRow, 'en_US-kristin-medium');
  assert.match(root.querySelector('[data-voice-status]').textContent, /Default/);
  assert.equal(root.querySelectorAll('[data-voice-radio]').length, 0);
  assert.equal(root.querySelectorAll('[data-preview-voice]').length, 1);
  const input = root.querySelector('[data-text]');
  input.value = 'Kristin should read this sentence.';
  input.dispatchEvent(new window.Event('input'));
  root.querySelector('[data-action="generate"]').click();
  await until(() => root.querySelector('[data-player]') && !root.querySelector('[data-action="generate"]').disabled);
  assert.equal(calls[0].voiceId, 'en_US-kristin-medium');
  assert.equal(calls[0].gender, 'female');
  assert.equal(app.Editing, undefined);
  assert.equal(app.components.CueEditor, undefined);
  assert.equal(root.querySelector('[data-cue-editor], .cue-editor'), null);
  assert.match(root.textContent, /Kristin/);
  assert.equal(root.querySelectorAll('[data-format]').length, 2);
  assert.equal(root.querySelector('[data-bundle], [data-subtitle]'), null);
  assert.equal(app.AudioUtils.exportSubtitles, undefined);
  assert.equal(app.AudioUtils.exportBundle, undefined);
  assert.equal(app.TextSegments.subtitles, undefined);
  assert.ok(root.querySelector('[data-filename]').value.startsWith('echotext-kristin-should-read'));
  assert.equal(app.History.list()[0].voiceName, 'Kristin');
  assert.equal((await app.GenerationStore.list()).length, 0);
  studio.load(app.History.list()[0]);
  assert.equal(root.querySelector('[data-cue-editor], .cue-editor'), null);
  assert.equal(root.querySelector('[data-voice-row]').dataset.voiceRow, 'en_US-kristin-medium');
  assert.equal(input.value, 'Kristin should read this sentence.');
  studio.setText('x'.repeat(50001));
  assert.equal(input.value.length, 50001);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  studio.destroy();
  assert.equal(errors.length, 0, errors.map(String).join('\n'));
});

test('older preferences migrate and saved browser-era audio remains playable', async (t) => {
  const { app } = fixture(t);
  app.storage.set('settings', { engine: 'browser', lastVoice: { voiceId: 'auto', rate: 1.4, pitch: 1.1 } });
  assert.equal(app.Settings.voice().voiceId, 'en_US-kristin-medium');
  assert.equal(app.Settings.voice().rate, 1.4);
  assert.equal(app.Settings.get().engine, 'piper');
  const played = playbackStub(app);
  const blob = new Blob(['legacy MP3'], { type: 'audio/mpeg' });
  await app.AudioStore.put('legacy', blob);
  await app.TTS.openPlayback({ id: 'legacy', engine: 'browser', hasAudio: true, duration: 2 });
  assert.equal(await played[0].blob.text(), 'legacy MP3');
});

test('ZIP downloads use a ZIP file picker and cancelling never triggers a fallback download', async (t) => {
  const { app, dom, window } = fixture(t);
  dom.reconfigure({ url: 'https://example.test/' });
  let picked;
  window.showSaveFilePicker = async (options) => { picked = options; return { name: options.suggestedName }; };
  await app.FileSaver.prepare('narration.zip');
  assert.equal(picked.suggestedName, 'narration.zip');
  assert.equal(picked.types[0].accept['application/zip'][0], '.zip');
  window.showSaveFilePicker = async () => { throw new window.DOMException('Cancelled', 'AbortError'); };
  await assert.rejects(app.FileSaver.prepare('narration.mp3'), (error) => error.name === 'AbortError');
});

test('failed MP3 encoding never writes WAV bytes to a chosen MP3 file', async (t) => {
  const { app, window } = fixture(t);
  const blob = app.AudioUtils.encodeWavChannels([new Float32Array(22050)], 22050);
  window.AudioContext = class { decodeAudioData(buffer, success, fail) { fail(new Error('Decoder unavailable')); } };
  let committed = false;
  app.FileSaver.prepare = async () => ({ filename: 'narration.mp3', handle: {} });
  app.FileSaver.commit = async () => { committed = true; };
  assert.equal(await app.AudioUtils.exportAudio({ blob, engine: 'piper', title: 'Test' }, null, 'mp3'), false);
  assert.equal(committed, false);
});

test('repeated generation clicks during a device check start only one cancellable job', async (t) => {
  const { app, window } = fixture(t);
  const root = window.document.getElementById('root');
  const studio = app.components.Generator.mount(root);
  studio.setText('One generation at a time.');
  let releaseCheck;
  const gate = new Promise((resolve) => { releaseCheck = resolve; });
  app.AIVoice.checkDevice = async () => { await gate; return { ok: true, errors: [], warnings: [] }; };
  let calls = 0;
  let runSignal;
  app.TTS.generate = async (input, { signal }) => {
    calls++;
    runSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new app.TTSError('Stopped', { code: 'aborted' })), { once: true }));
  };
  const button = root.querySelector('[data-action="generate"]');
  button.click();
  // Keyboard shortcut also enters generation and must respect the device-check lock.
  root.querySelector('[data-text]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  releaseCheck();
  await until(() => calls > 0);
  assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  root.querySelector('[data-action="cancel"]').click();
  await until(() => !button.disabled);
  assert.equal(runSignal.aborted, true);
  studio.destroy();
});

test('the actual app boots and switches interface language without losing the draft', async (t) => {
  const { app, window, errors } = fixture(t);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  window.document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  window.eval(fs.readFileSync(path.join(root, 'assets/js/app.js'), 'utf8'));
  await until(() => window.document.querySelector('[data-text]'));
  assert.equal(app.Pronunciation, undefined);
  assert.equal(app.Batch, undefined);
  assert.equal(app.Backup, undefined);
  assert.equal(window.document.querySelector('[data-batch-panel], [data-backup-panel], [data-panel="say"]'), null);
  const input = window.document.querySelector('[data-text]');
  input.value = 'Keep this draft.';
  input.dispatchEvent(new window.Event('input'));
  window.document.querySelector('[data-ui-language="km"]').click();
  await until(() => window.document.documentElement.lang === 'km');
  assert.equal(window.document.querySelector('[data-text]').value, 'Keep this draft.');
  assert.equal(app.i18n.language, 'km');
  assert.equal(window.document.querySelector('[data-batch-panel], [data-backup-panel], [data-panel="say"]'), null);
  assert.equal(errors.length, 0, errors.map(String).join('\n'));
  app.pages.home.unmount();
});

test('settings only change in memory after persistence succeeds', (t) => {
  const { app } = fixture(t);
  const before = JSON.parse(JSON.stringify(app.Settings.get()));
  app.storage.set = () => false;
  assert.throws(() => app.Settings.update({ theme: 'light' }), /Settings could not/);
  assert.deepEqual(JSON.parse(JSON.stringify(app.Settings.get())), before);
  assert.throws(() => app.Settings.replace({ theme: 'light' }), /Settings could not/);
  assert.deepEqual(JSON.parse(JSON.stringify(app.Settings.get())), before);
});
