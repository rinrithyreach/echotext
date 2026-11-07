const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers.cjs');

function fixture(t) {
  const env = createApp();
  t.after(() => env.dom.window.close());
  const calls = [];
  env.app.AIVoice.synthesize = async (input) => {
    calls.push(input);
    let at = 0;
    const cues = input.cueLabels.map((text, index) => {
      const cue = { text, start: at, end: at + 1 };
      at += 1 + (index < input.cueLabels.length - 1 ? input.gaps[index] : 0);
      return cue;
    });
    const sampleRate = 16000;
    const samples = new Float32Array(Math.round(at * sampleRate)).fill(0.25);
    return { samples, sampleRate, duration: samples.length / sampleRate, cues };
  };
  return { ...env, calls };
}

const voice = { voiceId: 'km_KH-mms-medium', language: 'km-KH', rate: 1, pitch: 1, sentencePause: 0.4, paragraphPause: 1.2 };
const plain = (value) => JSON.parse(JSON.stringify(value));

test('Khmer preview and generation use the same clause and paragraph pauses without changing the script', async (t) => {
  const { app, calls } = fixture(t);
  const text = 'សួស្តី, នេះជាឧទាហរណ៍; សូមស្តាប់: សំឡេងខ្មែរ។\n\nនេះជាកថាខណ្ឌទីពីរ។';
  const result = await app.TTS.generate({ ...voice, text });
  assert.equal(result.text, text);
  assert.equal(result.synthesisProfile, 'khmer-clear-v3');
  assert.equal(calls[0].rate, voice.rate, 'the visible speed setting is retained');
  assert.deepEqual(plain(calls[0].cueTexts), ['សួស្តី,', 'នេះជាឧទាហរណ៍;', 'សូមស្តាប់:', 'សំឡេងខ្មែរ។', 'នេះជាកថាខណ្ឌទីពីរ។']);
  assert.deepEqual(plain(calls[0].gaps), [0.2, 0.2, 0.2, 1.2, 0.4]);
  assert.deepEqual(plain(result.cues.map((cue) => +cue.start.toFixed(2))), [0, 1.2, 2.4, 3.6, 5.8]);
  const preview = await app.TTS.preview(voice, { text });
  preview.destroy();
  assert.deepEqual(plain(calls[1].gaps), plain(calls[0].gaps));
  assert.equal(calls[1].synthesisProfile, calls[0].synthesisProfile);
  assert.deepEqual(plain(calls[1].cueLabels), plain(calls[0].cueLabels));
});

test('resuming Khmer generation preserves continuation pauses across saved section boundaries', async (t) => {
  const { app, calls } = fixture(t);
  const phrase = 'ខ្ញុំរស់នៅភ្នំពេញជាមួយគ្រួសាររបស់ខ្ញុំ';
  const text = `${phrase.repeat(70)}, សូមស្តាប់សំឡេងខ្មែរ។\n\nនេះជាកថាខណ្ឌទីពីរ។`;
  const controller = new AbortController();
  await assert.rejects(app.TTS.generate({ ...voice, text }, {
    signal: controller.signal,
    onProgress: (info) => { if (info.phase === 'section' && info.completed === 1) controller.abort(); },
  }), (error) => error.code === 'aborted');
  const [job] = await app.GenerationStore.list();
  assert.equal(job.completed, 1);
  assert.equal(job.input.synthesisProfile, 'khmer-clear-v3');
  assert.ok(job.sections.length > 1);
  assert.equal(job.pauses[0].at(-1), 'continuation');
  const firstPart = await app.GenerationStore.part(job.id, 0);
  assert.equal(firstPart.gapAfter, 0.08);
  const result = await app.TTS.generate({}, { resumeId: job.id });
  assert.equal(calls.length, job.sections.length, 'saved audio is reused');
  assert.ok(calls.every((input) => input.synthesisProfile === 'khmer-clear-v3'), 'resumed sections retain the saved delivery');
  assert.equal(result.text, text);
  assert.ok(Math.abs(result.cues[firstPart.cues.length].start - firstPart.duration - 0.08) < 1 / 16000);
  assert.ok(calls.flatMap((input) => input.gaps).includes(0.2), 'a clause pause is preserved');
  assert.ok(calls.flatMap((input) => input.gaps).includes(1.2), 'a paragraph pause is preserved');
});

test('saved jobs without new pause metadata still resume with their existing sentence and paragraph settings', async (t) => {
  const { app, calls } = fixture(t);
  await app.GenerationStore.create({
    id: 'legacy-khmer-job', title: 'សួស្តី', createdAt: Date.now(), completed: 0,
    input: { ...voice, text: 'សួស្តី។\n\nនេះជាសំឡេងខ្មែរ។' },
    sections: [['សួស្តី។', 'នេះជាសំឡេងខ្មែរ។']], breaks: [[true, false]],
  });
  const result = await app.TTS.generate({}, { resumeId: 'legacy-khmer-job' });
  assert.deepEqual(plain(calls[0].gaps), [1.2, 0.4]);
  assert.equal(calls[0].synthesisProfile, 'original', 'older audio is not joined to a different pace');
  assert.equal(result.cues.length, 2);
});

test('a job started with the earlier clear delivery resumes with it, not the newer loudness levelling', async (t) => {
  const { app, calls } = fixture(t);
  await app.GenerationStore.create({
    id: 'clear-v1-job', title: 'សួស្តី', createdAt: Date.now(), completed: 0,
    input: { ...voice, synthesisProfile: 'khmer-clear-v1', text: 'សួស្តី។ នេះជាសំឡេងខ្មែរ។' },
    sections: [['សួស្តី។', 'នេះជាសំឡេងខ្មែរ។']], breaks: [[false, false]],
  });
  await app.TTS.generate({}, { resumeId: 'clear-v1-job' });
  assert.equal(calls[0].synthesisProfile, 'khmer-clear-v1');
});
