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

function mmsConfig() {
  const script = fs.readFileSync(path.join(root, 'assets/voices/km_KH-mms-medium.onnx.json.0.js'), 'utf8');
  return JSON.parse(Buffer.from(script.match(/"([^"]+)"\);/)[1], 'base64').toString('utf8'));
}

test('Khmer pronunciation cleanup restores supported vowels without changing valid syllable marks', (t) => {
  const { app } = fixture(t);
  assert.equal(app.KhmerText.normalize('ឣ ឤ ឲ្យ'), 'អ អា ឱ្យ');
  assert.equal(app.KhmerText.normalize('ក\u17B4ខ\u17B5'), 'កខ');
  assert.equal(app.KhmerText.normalize('ខ្ញុំ ស៊ី ប៉ី'), 'ខ្ញុំ ស៊ី ប៉ី');
  assert.equal(app.KhmerText.normalize('ខ្\u200Dញុំ\u200C\u2060\uFEFF'), 'ខ្ញុំ');
});

test('Khmer word-break hints stay distinct from visible phrase spaces', (t) => {
  const { app } = fixture(t);
  const text = 'សួស្តី\u200Bខ្មែរ របស់ខ្ញុំ';
  assert.equal(app.KhmerText.normalize(text), 'សួស្តីខ្មែរ របស់ខ្ញុំ');
  assert.equal(app.KhmerText.normalize(text, { preserveWordBreaks: true }), text);
  assert.equal(app.KhmerText.normalize(text, { preserveWordBreaks: false }), 'សួស្តីខ្មែរ របស់ខ្ញុំ');
});

test('normalized Khmer vowel variants reach the bundled MMS vocabulary', (t) => {
  const { app } = fixture(t);
  const config = mmsConfig();
  assert.equal(config.vocab['ឲ'], undefined);
  assert.equal(typeof config.vocab['ឱ'], 'number');
  const ids = app.AIVoice.mmsTokens(config, app.KhmerText.normalize('ឣ ឤ ឲ្យ'));
  assert.deepEqual(Array.from(ids), Array.from(app.AIVoice.mmsTokens(config, 'អ អា ឱ្យ')));
  assert.ok(ids.includes(config.vocab['ឱ']), 'the vowel in ឲ្យ must survive tokenization');
  assert.notDeepEqual(Array.from(ids), Array.from(app.AIVoice.mmsTokens(config, 'ឣ ឤ ឲ្យ')));
});

test('documented Khmer vowel typing variants normalize to the intended spelling and model tokens', (t) => {
  const { app } = fixture(t);
  const config = mmsConfig();
  const variants = [
    ['កំុ', 'កុំ'],
    ['ចំា', 'ចាំ'],
    ['ស៊េីប', 'ស៊ើប'],
    ['លេាក', 'លោក'],
    ['លាេក', 'លោក'],
    ['ឨ', 'ឧក'],
  ];
  for (const [typed, expected] of variants) {
    const normalized = app.KhmerText.normalize(typed);
    assert.equal(normalized, expected, typed);
    assert.equal(app.KhmerText.normalize(normalized), expected, `idempotent: ${typed}`);
    assert.deepEqual(Array.from(app.AIVoice.mmsTokens(config, normalized)), Array.from(app.AIVoice.mmsTokens(config, expected)), typed);
  }
  const withWordBreak = 'កំុ\u200Bចំា លោក';
  assert.equal(app.KhmerText.normalize(withWordBreak), 'កុំចាំ លោក');
  assert.equal(app.KhmerText.normalize(withWordBreak, { preserveWordBreaks: true }), 'កុំ\u200Bចាំ លោក');
  assert.equal(app.KhmerText.normalize('សុី សីុ អភិវឌ្ឍ'), 'ស៊ី ស៊ី អភិវឌ្ធ', 'shifters typed as ុ and the unlearned ឍ are respelled');
});

test('ៗ says its word again, also after a phrase the word list keeps together', (t) => {
  const { app } = fixture(t);
  const ZWSP = String.fromCodePoint(0x200b);
  const cases = [
    ['ផ្សេងៗ', 'ផ្សេងផ្សេង'],
    ['ផ្សេង ៗ គ្នា', 'ផ្សេងផ្សេង គ្នា'],
    ['សប្បាយៗ', 'សប្បាយសប្បាយ'],
    ['ក្មេងៗ ទៅសាលា', 'ក្មេងក្មេង ទៅសាលា'],
    ['និយាយតិចៗ', 'និយាយតិចតិច'],
    ['បន្តិចម្តងៗ', 'បន្តិចម្តងម្តង'],
    ['មនុស្សម្នាក់ៗ', 'មនុស្សម្នាក់ម្នាក់'],
  ];
  for (const [typed, spoken] of cases) assert.equal(app.KhmerText.normalize(typed), spoken, typed);
  assert.equal(app.KhmerText.normalize('ផ្សេងៗគ្នា', { preserveWordBreaks: true }), ['ផ្សេង', 'ផ្សេង', 'គ្នា'].join(ZWSP));
  assert.equal(app.KhmerText.normalize(`ពួក${ZWSP}ក្មេងៗ`), 'ពួកក្មេងក្មេង', 'a typed word break marks where the word starts');
});

test('letters, shifter spellings and initials the voice never learned become ones it reads', (t) => {
  const { app } = fixture(t);
  const config = mmsConfig();
  const cases = [
    ['អភិវឌ្ឍ', 'អភិវឌ្ធ'],
    ['ឦសាន', 'អីសាន'],
    ['ឩ ឰ ឳ', 'អូ អៃ អៅ'],
    ['ឝ ឞ', 'ស ស'],
    ['សុី', 'ស៊ី'],
    ['សីុ', 'ស៊ី'],
    ['អុីនធឺណិត', 'អ៊ីនធឺណិត'],
    ['មុឺន', 'ម៉ឺន'],
    ['ឯកសារ PDF និង USB', 'ឯកសារ ភីឌីអេហ្វ និង យូអេសប៊ី'],
    ['OK', 'អូខេ'],
  ];
  for (const [typed, spoken] of cases) {
    const normalized = app.KhmerText.normalize(typed);
    assert.equal(normalized, spoken, typed);
    assert.equal(app.KhmerText.normalize(normalized), spoken, `idempotent: ${typed}`);
    assert.ok([...normalized].every((ch) => ch in config.vocab), `every letter reaches the voice: ${typed}`);
  }
  assert.equal(app.KhmerText.normalize('បុី ស្សុី'), 'បុី ស្សុី', 'ប takes either shifter, and a subscript is not the letter shifted');
  assert.equal(app.KhmerText.normalize('Facebook'), 'Facebook', 'only initials are spelled out');
});
