// Uses the real bundled phonemizer, ONNX runtime and voice models; no network or mocked inference.
const assert = require('node:assert/strict');
const { createApp } = require('./helpers.cjs');

const SAMPLES = {
  'en-US': { text: 'Hello there. This is a second sentence.', cues: 2 },
  'km-KH': { text: 'សួស្តី! សូមឲ្យពាក្យរបស់អ្នកមានជីវិត, ហើយស្តាប់សំឡេងខ្មែរ។\n\nឆ្នាំ២០២៦។', cues: 4 },
};

/** RMS of the 20 ms frames within 20 dB of the loudest: how loud the speech in a stretch of audio is. */
function speechLevel(samples, sampleRate) {
  const size = Math.round(sampleRate * 0.02);
  const powers = [];
  for (let start = 0; start < samples.length; start += size) {
    const end = Math.min(samples.length, start + size);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    powers.push(sum / (end - start));
  }
  const loudest = Math.max(...powers);
  const voiced = powers.filter((power) => power >= loudest * 0.01);
  return Math.sqrt(voiced.reduce((a, b) => a + b, 0) / voiced.length);
}

(async () => {
  const { dom, window, app, errors } = createApp();
  const feeds = [];
  let sessionPrototype;
  let originalRun;
  const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} versus ${expected}`);
  async function synthesize(item) {
    const before = feeds.length;
    const result = await app.AIVoice.synthesize(item);
    const scales = feeds.slice(before);
    assert.ok(scales.length, 'real inference receives synthesis scales');
    assert.ok(scales.every((values) => values.length === 3 && values.every(Number.isFinite)));
    return { result, scales };
  }
  try {
    for (const voice of app.AIVoice.voices.filter((v) => v.bundled)) {
      const sample = SAMPLES[voice.language];
      const started = Date.now();
      await app.AIVoice.load(voice);
      if (!originalRun) {
        sessionPrototype = window.ort.InferenceSession.prototype;
        originalRun = sessionPrototype.run;
        sessionPrototype.run = function (...args) {
          if (args[0].scales) feeds.push(Array.from(args[0].scales.data));
          return originalRun.apply(this, args); // Observe the public runtime API; inference remains real.
        };
      }
      const input = { text: sample.text, language: voice.language, gender: voice.gender, voiceId: voice.id, rate: 1, pitch: 1, volume: 1, sentencePause: 0.3 };
      const normal = await synthesize(input);
      const made = normal.result;
      assert.ok(made.duration > 1 && made.duration < 30, `${voice.name}: duration ${made.duration}`);
      assert.equal(made.cues.length, sample.cues);
      assert.ok(made.cues[1].start - made.cues[0].end >= 0.299, 'the sentence pause is used');
      assert.ok(Math.abs(made.cues.at(-1).end - made.duration) < 0.001);
      assert.ok(made.samples.some((s) => Math.abs(s) > 0.1), 'not silent');
      assert.ok(made.samples.every(Number.isFinite), 'samples are finite');
      if (voice.language === 'km-KH') {
        assert.equal(made.sampleRate, 16000, 'clearer delivery keeps the original sample rate at default pitch');
        assert.ok(Math.abs(made.cues[2].start - made.cues[1].end - 0.15) < 1 / made.sampleRate, 'a comma uses a shorter clause pause');
        assert.ok(Math.abs(made.cues[3].start - made.cues[2].end - 0.6) < 1 / made.sampleRate, 'a blank line uses the paragraph pause');
      }
      const original = await synthesize({ ...input, synthesisProfile: 'original' });
      for (const values of normal.scales) {
        near(values[0], original.scales[0][0], `${voice.name}: acoustic noise remains unchanged`);
        near(values[2], original.scales[0][2], `${voice.name}: duration noise remains unchanged`);
        near(values[1] / original.scales[0][1], voice.language === 'km-KH' ? 1 / 0.92 : 1, `${voice.name}: delivery profile preserves the expected length scale`);
      }
      if (voice.language === 'km-KH') {
        near(original.scales[0][0], 0.667, 'Khmer uses the bundled acoustic-noise setting');
        near(original.scales[0][1], 1, 'original Khmer delivery retains the model speaking rate');
        near(original.scales[0][2], 0.8, 'Khmer uses the bundled duration-noise setting');
        // New Khmer audio: every sentence equally loud, short ones (ឆ្នាំ២០២៦។) included, and still never clipped.
        const levels = made.cues.map((cue) => speechLevel(made.samples.subarray(Math.round(cue.start * made.sampleRate), Math.round(cue.end * made.sampleRate)), made.sampleRate));
        const spread = 20 * Math.log10(Math.max(...levels) / Math.min(...levels));
        assert.ok(spread < 1, `Khmer sentences are within 1 dB of each other (${spread.toFixed(2)} dB)`);
        assert.ok(made.samples.every((s) => Math.abs(s) <= 0.9 + 1e-6), 'levelled Khmer keeps the peak ceiling');
      }
      // Speed and pitch change the result.
      const faster = await synthesize({ ...input, rate: 1.6, pitch: 1.3 });
      const fast = faster.result;
      for (const values of faster.scales) {
        near(values[1] / normal.scales[0][1], (2 ** 0.3) / 1.6, `${voice.name}: speed and pitch compose with the delivery profile`);
        near(values[0], normal.scales[0][0], `${voice.name}: speed and pitch preserve acoustic noise`);
        near(values[2], normal.scales[0][2], `${voice.name}: speed and pitch preserve duration noise`);
      }
      assert.ok(fast.duration < made.duration * 0.85, `${voice.name}: faster speech is shorter`);
      assert.notEqual(fast.sampleRate, made.sampleRate, 'pitch moves the sample rate');
      const mp3 = await app.AudioUtils.encodeMp3(made.samples, made.sampleRate);
      assert.equal(mp3.type, 'audio/mpeg');
      assert.ok(mp3.size > 1000);
      console.log(`${voice.name}: ${made.duration.toFixed(2)} s, ${made.cues.length} measured cues, ${made.sampleRate} Hz, MP3 ${mp3.size} bytes, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
    assert.equal(errors.length, 0, errors.map(String).join('\n'));
  } finally {
    if (originalRun) sessionPrototype.run = originalRun;
    dom.window.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
