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

const plain = (value) => JSON.parse(JSON.stringify(value));

test('Khmer clauses pause without separating numbers, times, abbreviations or ordinary spaces', (t) => {
  const { app } = fixture(t);
  const text = 'តម្លៃ១,២៥០.៥០រៀល, ម៉ោង១០:៣០; ចម្ងាយ៣ក.ម.៖ សូមរង់ចាំ… ចប់។';
  const units = app.TextSegments.units(text, 180, 'km-KH');
  assert.deepEqual(plain(units.map((unit) => [unit.text, unit.pauseAfter])), [
    ['តម្លៃ១,២៥០.៥០រៀល,', 'clause'],
    ['ម៉ោង១០:៣០;', 'clause'],
    ['ចម្ងាយ៣ក.ម.៖', 'clause'],
    ['សូមរង់ចាំ…', 'clause'],
    ['ចប់។', 'sentence'],
  ]);
  const phrase = 'ខ្ញុំរស់នៅភ្នំពេញ ជាមួយគ្រួសារ\u200bរបស់ខ្ញុំ។';
  const symbols = ['$', '%', '៛', '&', '+', '=', '@'];
  const symbolUnits = app.TextSegments.units(symbols.join('\n\n') + '\n\nចប់។', 180, 'km-KH');
  assert.deepEqual(plain(symbolUnits.map((unit) => unit.text)), [...symbols, 'ចប់។']);
  assert.ok(symbolUnits.slice(0, -1).every((unit) => unit.paragraphEnd));
  assert.deepEqual(plain(app.TextSegments.cues(phrase, 180, 'km-KH')), [phrase]);
  assert.deepEqual(plain(app.TextSegments.cues('Hello, there; wait: a moment… Done.', 180, 'en-US')), ['Hello, there; wait: a moment… Done.']);
  assert.deepEqual(plain(app.TextSegments.units('… សួស្តី...! បន្ទាប់,។', 180, 'km-KH').map((unit) => [unit.text, unit.pauseAfter])), [
    ['… សួស្តី...!', 'sentence'], ['បន្ទាប់,។', 'sentence'],
  ]);
  assert.deepEqual(plain(app.TextSegments.cues('!!! ,\n\nសួស្តី។', 180, 'km-KH')), ['សួស្តី។']);
});

test('Khmer continuation, clause and paragraph pauses retain their strength across saved sections', (t) => {
  const { app } = fixture(t);
  const settings = { sentencePause: 0.4, paragraphPause: 0.9 };
  assert.equal(app.TextSegments.pauseFor({ pauseAfter: 'continuation' }, settings), 0.08);
  assert.equal(app.TextSegments.pauseFor({ pauseAfter: 'clause' }, settings), 0.2);
  assert.equal(app.TextSegments.pauseFor({ pauseAfter: 'sentence' }, settings), 0.4);
  assert.equal(app.TextSegments.pauseFor({ paragraphEnd: true, pauseAfter: 'clause' }, settings), 0.9);
  for (const pauseAfter of ['continuation', 'clause', 'sentence']) {
    assert.equal(app.TextSegments.pauseFor({ pauseAfter }, { sentencePause: 0 }), 0);
  }
  assert.equal(app.TextSegments.pauseFor({ paragraphEnd: true }, { paragraphPause: 0 }), 0);
  const text = ('នេះជាឃ្លាទីមួយ, នេះជាឃ្លាទីពីរ។ '.repeat(9)) + '\n\nចប់។';
  const units = app.TextSegments.units(text, 180, 'km-KH');
  const plan = app.TextSegments.plan(text, 'km-KH', 75);
  assert.ok(plan.sections.length > 1);
  assert.deepEqual(plain(plan.sections.flat()), plain(units.map((unit) => unit.text)));
  assert.deepEqual(plain(plan.pauses.flat()), plain(units.map((unit) => unit.pauseAfter)));
  assert.deepEqual(plain(plan.breaks.flat()), plain(units.map((unit) => unit.paragraphEnd)));
});

test('Khmer length limits use word boundaries and give continuations shorter breaths', (t) => {
  const { app } = fixture(t);
  const text = 'ខ្ញុំរស់នៅភ្នំពេញជាមួយគ្រួសាររបស់ខ្ញុំ'.repeat(10);
  const boundaries = new Set(Array.from(new Intl.Segmenter('km', { granularity: 'word' }).segment(text), ({ index }) => index));
  const units = app.TextSegments.units(text, 60, 'km-KH');
  let offset = 0;
  for (const unit of units.slice(0, -1)) {
    offset += unit.text.length;
    assert.ok(boundaries.has(offset), `Cut at ${offset} is a dictionary word boundary`);
    assert.equal(unit.pauseAfter, 'continuation');
    assert.equal(app.TextSegments.pauseFor(unit, { sentencePause: 0.2 }), 0.05);
  }
  assert.equal(units.map((unit) => unit.text).join(''), text);
  assert.ok(units.every((unit) => unit.text.length <= 60));
  const prefix = 'កម្ពុជាខ្មែរ';
  assert.equal(app.TextSegments.cutPoint(prefix + '\u200bភាសាខ្មែរ', prefix.length + 2, 'km-KH'), prefix.length);
});

test('missing Intl.Segmenter never cuts Khmer coeng stacks, combining marks or surrogate pairs', (t) => {
  const { app, window } = fixture(t);
  window.Intl.Segmenter = undefined;
  const cluster = 'ក្នុំ';
  const text = cluster.repeat(8);
  const units = app.TextSegments.units(text, 7, 'km-KH');
  assert.equal(units.map((unit) => unit.text).join(''), text);
  assert.ok(units.every((unit) => unit.text === cluster));
  assert.equal(app.TextSegments.cutPoint('😀😀😀', 3, 'km-KH'), 2);
  window.Intl = undefined;
  assert.equal(app.TextSegments.cutPoint(text, 7, 'km-KH'), cluster.length);
});

test('MMS length splitting observes real vocabulary budgets with and without blank tokens', (t) => {
  const { app } = fixture(t);
  const script = fs.readFileSync(path.join(root, 'assets/voices/km_KH-mms-medium.onnx.json.0.js'), 'utf8');
  const model = JSON.parse(Buffer.from(script.match(/"([^"]+)"\);/)[1], 'base64').toString('utf8'));
  const text = 'ខ្ញុំរស់នៅភ្នំពេញជាមួយគ្រួសារ'.repeat(12);
  const boundaries = new Set(Array.from(new Intl.Segmenter('km', { granularity: 'word' }).segment(text), ({ index }) => index));
  const chars = new Map(Object.entries(model.vocab).map(([char, id]) => [id, char]));
  for (const add_blank of [true, false]) {
    const config = { ...model, add_blank };
    const groups = app.AIVoice.splitMms(config, text, 80);
    assert.ok(groups.length > 1);
    assert.ok(groups.every((ids) => ids.length <= 80));
    const pieces = groups.map((ids) => ids.filter((_, index) => !add_blank || index % 2 === 1).map((id) => chars.get(id)).join(''));
    assert.equal(pieces.join(''), text);
    let offset = 0;
    for (const piece of pieces.slice(0, -1)) {
      offset += piece.length;
      assert.ok(boundaries.has(offset), `MMS cut at ${offset} is a dictionary word boundary`);
    }
  }
});
