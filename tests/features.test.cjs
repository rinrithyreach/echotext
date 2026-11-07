// Tests for voices, Khmer, pauses, presets, exports, History tools, models and import.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createApp, root } = require('./helpers.cjs');
const { allKeys } = require('../tools/i18n-keys.cjs');

// Arrays made inside the page belong to its realm; compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

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
    const labels = input.cueLabels || texts;
    const sampleRate = 16000;
    // One second per cue plus each requested gap, like the real engine.
    let at = 0;
    const cues = texts.map((text, i) => {
      const cue = { text: labels[i], start: at, end: at + 1 };
      at += 1 + (i < texts.length - 1 ? (input.gaps ? input.gaps[i] : 0.2) : 0);
      return cue;
    });
    const samples = new Float32Array(Math.round(at * sampleRate)).fill(0.25);
    onProgress?.({ phase: 'speak', loaded: texts.length, total: texts.length });
    return { samples, sampleRate, duration: samples.length / sampleRate, voice: app.AIVoice.voiceFor(input), cues };
  };
}

async function until(condition) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out');
}

/** A minimal .docx: word/document.xml deflated, as Word writes it. */
function docx(xml) {
  const name = Buffer.from('word/document.xml');
  const data = Buffer.from(xml);
  const packed = zlib.deflateRawSync(data);
  const crc = zlib.crc32 ? zlib.crc32(data) : 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + packed.length, 16);
  return Buffer.concat([local, name, packed, central, name, end]);
}

/** A one-page PDF with standard-font text: two lines of one paragraph, then a second paragraph. */
function pdf() {
  const content = 'BT /F1 12 Tf 72 720 Td (Hello from a PDF file that) Tj 0 -14 Td (wraps onto a second line.) Tj 0 -48 Td (Second paragraph here.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('every interface string has a Khmer translation, and switching re-renders the studio in Khmer', (t) => {
  const { app, window } = fixture(t);
  const missing = allKeys().filter((key) => !app.i18n.has('km', key));
  assert.deepEqual(missing, [], `Missing Khmer translations:\n${missing.join('\n')}`);
  // Placeholders survive translation.
  app.i18n.set('km');
  const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort().join();
  for (const key of allKeys()) assert.equal(placeholders(app.t(key)), placeholders(key), `Placeholders differ for: ${key}`);
  const root = window.document.getElementById('root');
  const studio = app.components.Generator.mount(root);
  assert.match(root.textContent, /បង្កើតសំឡេង/); // "Generate Audio"
  assert.equal(window.document.documentElement.getAttribute('lang'), 'km');
  studio.destroy();
  app.i18n.set('en');
});

test('Khmer text: sentences split on ។, long sentences split at words, numbers become words', (t) => {
  const { app } = fixture(t);
  const text = 'សួស្តី! នេះជាសំឡេងរបស់ខ្ញុំ។ ខ្ញុំរស់នៅភ្នំពេញ។\n\nកថាខណ្ឌទីពីរ។';
  const units = app.TextSegments.units(text, 180, 'km-KH');
  assert.deepEqual(plain(units.map((u) => u.text)), ['សួស្តី!', 'នេះជាសំឡេងរបស់ខ្ញុំ។', 'ខ្ញុំរស់នៅភ្នំពេញ។', 'កថាខណ្ឌទីពីរ។']);
  assert.deepEqual(plain(units.map((u) => u.paragraphEnd)), [false, false, true, false]);
  const long = 'ខ្ញុំរស់នៅភ្នំពេញជាមួយគ្រួសាររបស់ខ្ញុំ'.repeat(12);
  const pieces = app.TextSegments.cues(long, 60, 'km-KH');
  assert.ok(pieces.length > 1 && pieces.every((p) => p.length <= 60));
  assert.equal(pieces.join(''), long);
  assert.equal(app.KhmerText.numberToWords(2026), 'ពីរពាន់ម្ភៃប្រាំមួយ');
  assert.equal(app.KhmerText.numberToWords(15000), 'មួយម៉ឺនប្រាំពាន់');
  assert.equal(app.KhmerText.numberToWords(2500000), 'ពីរលានប្រាំសែន');
  assert.equal(app.KhmerText.normalize('ឆ្នាំ២០២៦'), 'ឆ្នាំ ពីរពាន់ម្ភៃប្រាំមួយ');
  assert.equal(app.KhmerText.normalize('3.5%'), 'បី ចុច ប្រាំ ភាគរយ');
  assert.equal(app.KhmerText.normalize('1.250.000'), 'មួយលានពីរសែនប្រាំម៉ឺន');
  assert.ok(app.KhmerText.isKhmer(text));
  assert.ok(!app.KhmerText.isKhmer('Hello world'));
  assert.throws(() => app.TTS.validate('Only English here', 'km-KH'), /Khmer script/);
});

test('Khmer tokens match the official MMS tokenizer', (t) => {
  const { app } = fixture(t);
  const script = fs.readFileSync(path.join(root, 'assets/voices/km_KH-mms-medium.onnx.json.0.js'), 'utf8');
  const config = JSON.parse(Buffer.from(script.match(/"([^"]+)"\);/)[1], 'base64').toString('utf8'));
  for (const { text, ids } of JSON.parse(fs.readFileSync(path.join(__dirname, 'km-mms.ref.json'), 'utf8'))) {
    assert.deepEqual(plain(app.AIVoice.mmsTokens(config, text)), ids, text);
  }
});

test('sentence and paragraph pauses reach the engine and the joined audio', async (t) => {
  const { app } = fixture(t);
  const calls = [];
  fakeSynthesis(app, calls);
  const text = 'First sentence. Second sentence.\n\nNew paragraph.';
  const result = await app.TTS.generate({ ...app.config.voiceDefaults, sentencePause: 0.5, paragraphPause: 1.5, text });
  assert.deepEqual(plain(calls[0].gaps), [0.5, 1.5, 0.5]);
  assert.deepEqual(plain(result.cues.map((c) => c.start)), [0, 1.5, 4]);
  assert.equal(result.sentencePause, 0.5);
  assert.equal(result.paragraphPause, 1.5);
  // Sections are joined with the pause that belongs after their last cue.
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here and it is long enough to matter.`).join(' ') + '\n\nEnd.';
  const joined = await app.TTS.generate({ ...app.config.voiceDefaults, sentencePause: 0.3, paragraphPause: 2, text: long });
  const cues = joined.cues;
  const gaps = cues.slice(1).map((c, i) => +(c.start - cues[i].end).toFixed(3));
  assert.ok(gaps.every((g) => g === 0.3 || g === 2));
  assert.equal(gaps.at(-1), 2);
  assert.ok(Math.abs(cues.at(-1).end - joined.duration) < 0.001);
});

test('speech and previews use the original text when older pronunciation settings exist', async (t) => {
  const { app } = fixture(t);
  app.Settings.update({ pronunciations: [{ from: 'SQL', to: 'sequel', language: 'en-US' }] });
  const calls = [];
  fakeSynthesis(app, calls);
  const text = 'SQL stays in the script.';
  const result = await app.TTS.generate({ ...app.config.voiceDefaults, text });
  assert.deepEqual(plain(calls[0].cueTexts), [text]);
  assert.deepEqual(plain(result.cues.map((cue) => cue.text)), [text]);
  const preview = await app.TTS.preview(app.config.voiceDefaults, { text });
  assert.deepEqual(plain(calls[1].cueTexts), [text]);
  preview.destroy();
});

test('voice presets fall back to the default voice and restore speed, pitch and pauses', (t) => {
  const { app } = fixture(t);
  const preset = app.Presets.save('Narration', { voiceId: 'en_US-john-medium', language: 'en-US', rate: 1.25, pitch: 0.9, sentencePause: 0.4, paragraphPause: 1.2 });
  assert.equal(app.Presets.list().length, 1);
  const voice = app.Presets.voiceOf(app.Presets.get(preset.id));
  assert.equal(voice.voiceId, 'en_US-kristin-medium');
  assert.equal(voice.gender, 'female');
  assert.deepEqual([voice.rate, voice.pitch, voice.sentencePause, voice.paragraphPause], [1.25, 0.9, 0.4, 1.2]);
  app.Presets.save('narration', { voiceId: 'km_KH-mms-medium', language: 'km-KH', rate: 9, pitch: 1 });
  assert.equal(app.Presets.list().length, 1, 'same name replaces');
  assert.equal(app.Presets.list()[0].rate, 2, 'out-of-range speed is clamped');
  const removed = app.Presets.remove(preset.id);
  assert.equal(app.Presets.list().length, 0);
  app.Presets.restore(removed);
  assert.equal(app.Presets.list().length, 1);
});

test('audio exports use the typed file name', async (t) => {
  const { app } = fixture(t);
  fakeSynthesis(app);
  const result = await app.TTS.generate({ ...app.config.voiceDefaults, text: 'One. Two.' });
  assert.equal(app.AudioUtils.sanitizeName('  My: "talk"/v2.mp3 '), 'My- -talk-v2');
  assert.equal(app.AudioUtils.sanitizeName('con'), 'con-audio');
  result.fileName = 'Episode 1';
  const saved = [];
  app.FileSaver.prepare = async (filename) => ({ filename });
  app.FileSaver.commit = async (target, blob) => { saved.push({ target, blob }); return 'downloaded'; };
  app.FileSaver.announce = () => {};
  assert.equal(await app.AudioUtils.exportAudio(result, null, 'wav'), true);
  assert.equal(saved[0].target.filename, 'Episode 1.wav');
  assert.equal(saved[0].blob, result.blob);
});

test('History: the oldest items go past the limit, rename, projects and search in the list', async (t) => {
  const { app, window } = fixture(t);
  fakeSynthesis(app);
  app.config.historyLimit = 3;
  const made = [];
  for (let i = 0; i < 3; i++) {
    const r = await app.TTS.generate({ ...app.config.voiceDefaults, text: `Item ${i}.` });
    r.createdAt = 1000 + i;
    await app.History.add(r);
    made.push(r);
  }
  for (let i = 3; i < 5; i++) {
    const r = await app.TTS.generate({ ...app.config.voiceDefaults, text: `Item ${i}.`, project: 'Podcast' });
    await app.History.add(r);
  }
  const ids = app.History.list().map((item) => item.id);
  assert.equal(ids.length, 3);
  assert.ok(!ids.includes(made[0].id) && !ids.includes(made[1].id), 'the two oldest went');
  assert.ok(ids.includes(made[2].id));
  app.History.rename(made[2].id, '  Best   take ');
  assert.equal(app.History.get(made[2].id).title, 'Best take');
  assert.deepEqual(plain(app.History.projects()), ['Podcast']);
  app.History.setProject(made[2].id, '  ');
  assert.equal(app.History.get(made[2].id).project, null, 'an empty name removes the project');

  const rootEl = window.document.getElementById('root');
  const list = app.components.HistoryList.mount(rootEl);
  assert.equal(rootEl.querySelectorAll('.history-group').length, 2); // Podcast, and items without a project
  assert.equal(rootEl.querySelector('[data-act="favorite"], [data-filter-favorites]'), null, 'no favourites');
  const search = rootEl.querySelector('[data-filter-query]');
  search.value = 'best';
  search.dispatchEvent(new window.Event('input'));
  await until(() => rootEl.querySelectorAll('.history-item').length === 1);
  assert.match(rootEl.querySelector('[data-count]').textContent, /1 of 3/);
  search.value = '';
  search.dispatchEvent(new window.Event('input'));
  await until(() => rootEl.querySelectorAll('.history-item').length === 3);
  let menuItems;
  app.menu.open = (_button, items) => { menuItems = items; };
  rootEl.querySelector('[data-act="more"]').click();
  assert.deepEqual(plain(menuItems.filter((item) => !item.separator).map((item) => item.label)), ['Rename', 'Download MP3']);
  list.destroy();
});

test('models: status, device check before loading, and remove only deletes downloads', async (t) => {
  const { app, window } = fixture(t);
  const kristin = app.AIVoice.get('en_US-kristin-medium');
  // Exercise the download/storage checks without offering an extra voice in the catalogue.
  const joe = { ...kristin, id: 'test-download', bundled: false };
  assert.equal((await app.AIVoice.status(kristin)).bundled, true);
  const joeStatus = await app.AIVoice.status(joe);
  assert.equal(joeStatus.installed, false);
  Object.defineProperty(window.navigator, 'storage', { configurable: true, value: { estimate: async () => ({ usage: 900, quota: 1000 }), persisted: async () => false } });
  const check = await app.AIVoice.checkDevice(joe);
  assert.equal(check.ok, false);
  assert.match(check.errors[0], /needs .* of browser storage/);
  assert.equal((await app.AIVoice.checkDevice(kristin)).ok, true, 'built-in voices need no space');
  await assert.rejects(app.AIVoice.install(joe), /browser storage/);
  Object.defineProperty(window.navigator, 'deviceMemory', { configurable: true, value: 2 });
  assert.match((await app.AIVoice.checkDevice(kristin)).warnings[0], /2 GB of memory/);
  assert.equal(await app.AIVoice.remove(kristin), false, 'built-in voices are not deleted');
});

test('document import: .docx paragraphs and tables, .pdf paragraphs, and a preview before use', async (t) => {
  const { app, window } = fixture(t);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Hello </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>world.</w:t></w:r></w:p>
    <w:p></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell one</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>ក្រឡាពីរ</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:t>Line</w:t></w:r><w:r><w:br/><w:t>break</w:t></w:r><w:r><w:delText>deleted</w:delText></w:r></w:p>
  </w:body></w:document>`;
  const docxFile = new window.File([docx(xml)], 'notes.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const fromDocx = await app.DocumentImport.extract(docxFile);
  assert.equal(fromDocx.text, 'Hello world.\n\nCell one\n\nក្រឡាពីរ\n\nLine\nbreak');

  const pdfFile = new window.File([pdf()], 'paper.pdf', { type: 'application/pdf' });
  const fromPdf = await app.DocumentImport.extract(pdfFile);
  assert.equal(fromPdf.pages, 1);
  assert.equal(fromPdf.text, 'Hello from a PDF file that wraps onto a second line.\n\nSecond paragraph here.');

  await assert.rejects(app.DocumentImport.extract(new window.File(['x'], 'old.doc')), /\.docx/);
  await assert.rejects(app.DocumentImport.extract(new window.File(['x'], 'image.png')), /\.txt, \.docx or \.pdf/);

  // In the studio, the extracted text is shown in a dialog and only loaded when confirmed.
  const rootEl = window.document.getElementById('root');
  const studio = app.components.Generator.mount(rootEl);
  const input = rootEl.querySelector('[data-file]');
  Object.defineProperty(input, 'files', { configurable: true, value: [docxFile] });
  input.dispatchEvent(new window.Event('change'));
  await until(() => window.document.querySelector('[data-import-text]'));
  assert.equal(rootEl.querySelector('[data-text]').value, '', 'nothing is loaded before confirming');
  const preview = window.document.querySelector('[data-import-text]');
  preview.value = 'Edited text.';
  window.document.querySelector('[data-modal="confirm"]').click();
  await until(() => rootEl.querySelector('[data-text]').value === 'Edited text.');
  studio.destroy();
});

test('studio: Khmer language uses its default voice without a pronunciation panel', async (t) => {
  const { app, window } = fixture(t);
  const calls = [];
  fakeSynthesis(app, calls);
  const rootEl = window.document.getElementById('root');
  const studio = app.components.Generator.mount(rootEl);
  const khmer = rootEl.querySelector('[data-language-radio][value="km-KH"]');
  khmer.checked = true;
  khmer.dispatchEvent(new window.Event('change', { bubbles: true }));
  const rows = [...rootEl.querySelectorAll('[data-voice-row]')];
  assert.deepEqual(plain(rows.map((row) => row.dataset.voiceRow)), ['km_KH-mms-medium']);
  assert.equal(rows[0].querySelector('strong').textContent, 'KHMER');
  assert.ok(rows[0].classList.contains('is-selected'));
  assert.match(rows[0].querySelector('[data-voice-status]').textContent, /Default/);
  assert.equal(rootEl.querySelectorAll('[data-voice-radio]').length, 0);
  assert.equal(rootEl.querySelector('[data-text]').getAttribute('lang'), 'km-KH');

  assert.equal(rootEl.querySelector('[data-tab="say"]'), null);

  const text = rootEl.querySelector('[data-text]');
  text.value = 'សួស្តី ក.ម.។';
  text.dispatchEvent(new window.Event('input'));
  rootEl.querySelector('[data-action="generate"]').click();
  await until(() => rootEl.querySelector('[data-player]') && !rootEl.querySelector('[data-action="generate"]').disabled);
  assert.equal(calls[0].voiceId, 'km_KH-mms-medium');
  assert.deepEqual(plain(calls[0].cueTexts), ['សួស្តី ក.ម.។']);
  assert.equal(app.History.list()[0].language, 'km-KH');
  assert.equal(app.History.list()[0].voiceName, 'KHMER');
  studio.destroy();
});
