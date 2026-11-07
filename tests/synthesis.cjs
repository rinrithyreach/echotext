// Uses the real bundled phonemizer, ONNX runtime and voice models; no network or mocked inference.
const assert = require('node:assert/strict');
const { createApp } = require('./helpers.cjs');

const SAMPLES = {
  'en-US': { text: 'Hello there. This is a second sentence.', cues: 2 },
  'km-KH': { text: 'សួស្តី! នេះជាសំឡេងរបស់ខ្ញុំ។ ឆ្នាំ២០២៦។', cues: 3 },
};

(async () => {
  const { dom, app, errors } = createApp();
  try {
    for (const voice of app.AIVoice.voices.filter((v) => v.bundled)) {
      const sample = SAMPLES[voice.language];
      const started = Date.now();
      const made = await app.AIVoice.synthesize({ text: sample.text, language: voice.language, gender: voice.gender, voiceId: voice.id, rate: 1, pitch: 1, volume: 1, sentencePause: 0.3 });
      assert.ok(made.duration > 1 && made.duration < 30, `${voice.name}: duration ${made.duration}`);
      assert.equal(made.cues.length, sample.cues);
      assert.ok(made.cues[1].start - made.cues[0].end >= 0.299, 'the sentence pause is used');
      assert.ok(Math.abs(made.cues.at(-1).end - made.duration) < 0.001);
      assert.ok(made.samples.some((s) => Math.abs(s) > 0.1), 'not silent');
      // Speed and pitch change the result.
      const fast = await app.AIVoice.synthesize({ text: sample.text, language: voice.language, gender: voice.gender, voiceId: voice.id, rate: 1.6, pitch: 1.3, volume: 1 });
      assert.ok(fast.duration < made.duration * 0.85, `${voice.name}: faster speech is shorter`);
      assert.notEqual(fast.sampleRate, made.sampleRate, 'pitch moves the sample rate');
      const mp3 = await app.AudioUtils.encodeMp3(made.samples, made.sampleRate);
      assert.equal(mp3.type, 'audio/mpeg');
      assert.ok(mp3.size > 1000);
      console.log(`${voice.name}: ${made.duration.toFixed(2)} s, ${made.cues.length} measured cues, ${made.sampleRate} Hz, MP3 ${mp3.size} bytes, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
    assert.equal(errors.length, 0, errors.map(String).join('\n'));
  } finally { dom.window.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
