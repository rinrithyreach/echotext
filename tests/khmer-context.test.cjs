const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers.cjs');

function fixture(t) {
  const env = createApp();
  t.after(() => env.dom.window.close());
  return env;
}

/* A tiny protobuf reader, enough to check the ONNX patch: [{ field, wire, value | bytes }]. */
function varint(bytes, at) {
  let value = 0;
  let scale = 1;
  let byte;
  do {
    byte = bytes[at++];
    value += (byte & 0x7f) * scale;
    scale *= 128;
  } while (byte & 0x80);
  return [value, at];
}
function fields(bytes) {
  const out = [];
  let at = 0;
  while (at < bytes.length) {
    const [tag, next] = varint(bytes, at);
    if ((tag & 7) === 0) {
      const [value, after] = varint(bytes, next);
      out.push({ field: tag >> 3, value });
      at = after;
    } else {
      const [length, body] = varint(bytes, next);
      out.push({ field: tag >> 3, bytes: bytes.subarray(body, body + length) });
      at = body + length;
    }
  }
  return out;
}
const message = (...parts) => Uint8Array.from(parts.flat());
const bytesField = (field, content) => [(field << 3) | 2, content.length, ...content];
const text = (value) => Array.from(Buffer.from(value, 'utf8'));
const outputNames = (model) => {
  const graph = fields(model).find((f) => f.field === 7).bytes;
  return fields(graph).filter((f) => f.field === 12).map((f) => Buffer.from(fields(f.bytes).find((g) => g.field === 1).bytes).toString('utf8'));
};

test('an ONNX graph gains an extra output while everything around it stays as it was', (t) => {
  const { app } = fixture(t);
  const graph = message(bytesField(2, text('g')), bytesField(12, bytesField(1, text('output'))));
  const model = message([0x08, 0x08], bytesField(7, graph), bytesField(8, [0x10, 0x11])); // ir_version 8, graph, opset 17
  const patched = app.AIVoice.withGraphOutput(model.buffer, '/m/Ceil_output_0');
  assert.deepEqual(outputNames(patched), ['output', '/m/Ceil_output_0']);
  const top = fields(patched);
  assert.deepEqual(top.map((f) => f.field), [1, 7, 8]);
  assert.equal(top[0].value, 8);
  assert.deepEqual(Array.from(top[2].bytes), [0x10, 0x11]);
  const added = fields(fields(top[1].bytes).filter((f) => f.field === 12)[1].bytes);
  const tensor = fields(fields(added.find((f) => f.field === 2).bytes)[0].bytes);
  assert.equal(tensor[0].value, 1, 'declared as a float tensor');
  assert.equal(app.AIVoice.withGraphOutput(Uint8Array.from([0x0b, 0x01]).buffer, 'x'), null, 'not a model: unchanged');
});

test('pieces are grouped into calls that fit the token budget, a space token between them', (t) => {
  const { app } = fixture(t);
  const piece = (n) => new Array(n).fill(1);
  const groups = (...args) => JSON.parse(JSON.stringify(app.AIVoice.contextGroups(...args)));
  assert.deepEqual(groups([piece(3), piece(1), piece(2), piece(380)], 8), [[0, 1, 2], [3]]);
  assert.deepEqual(groups([piece(5), piece(3)], 8), [[0], [1]], '5 + space + 3 is over 8');
  assert.deepEqual(groups([]), []);
});

test('speaking pieces together cuts each back out exactly, leaving out the joining space', async (t) => {
  const { app } = fixture(t);
  const config = { sample_rate: 16000, vocab: { ' ': 19 } };
  const hop = 256;
  let fed = null;
  // Fake model: token i lasts (i % 3) + 1 frames, and its samples hold the value i + 1.
  const session = {
    async run(feeds) {
      fed = Array.from(feeds.input.data, Number);
      const durations = Float32Array.from(fed, (_, i) => (i % 3) + 1);
      const samples = [];
      durations.forEach((d, i) => { for (let s = 0; s < d * hop; s++) samples.push(i + 1); });
      return { output: { data: Float32Array.from(samples) }, '/m/Ceil_output_0': { data: durations } };
    },
  };
  class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
  const rt = { ort: { Tensor } };
  const voice = { engine: 'mms' };
  const pieces = [[0, 5, 0], [0, 6, 0, 7, 0], [0, 8, 0]];
  const parts = await app.AIVoice.inferInContext(rt, { config, session }, voice, pieces, 1, 'khmer-clear-v3');
  assert.deepEqual(fed, [0, 5, 0, 19, 0, 6, 0, 7, 0, 19, 0, 8, 0], 'one call, a space between pieces');
  assert.equal(parts.length, 3);
  const tokensIn = (part) => [...new Set(Array.from(part))];
  // Values are token index + 1; the first and last 64 samples are faded, so look inside them.
  assert.deepEqual(tokensIn(parts[0].subarray(80, -80)), [1, 2, 3]);
  assert.deepEqual(tokensIn(parts[1].subarray(80, -80)), [5, 6, 7, 8, 9]);
  assert.deepEqual(tokensIn(parts[2].subarray(80, -80)), [11, 12, 13]);
  const frames = (from, to) => [...Array(to - from)].reduce((sum, _, k) => sum + ((from + k) % 3) + 1, 0) * hop;
  assert.deepEqual(Array.from(parts, (p) => p.length), [frames(0, 3), frames(4, 9), frames(10, 13)], 'exact spans; space tokens 3 and 9 left out');
  assert.equal(parts[1][0], 0, 'faded in where it was cut');
  assert.equal(parts[1][parts[1].length - 1], 0, 'faded out where it was cut');
});

test('audio that cannot be aligned with its letters is not cut', async (t) => {
  const { app } = fixture(t);
  class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
  const config = { sample_rate: 16000, vocab: { ' ': 19 } };
  const run = async (feeds) => ({ output: { data: new Float32Array(1000) }, '/m/Ceil_output_0': { data: Float32Array.from(feeds.input.data, () => 3) } });
  const parts = await app.AIVoice.inferInContext({ ort: { Tensor } }, { config, session: { run } }, { engine: 'mms' }, [[0, 5, 0], [0, 6, 0]], 1, 'khmer-clear-v3');
  assert.equal(parts, null, '1000 samples are not a whole number of frames');
  const none = await app.AIVoice.inferInContext({ ort: { Tensor } }, { config, session: { run: async () => ({ output: { data: new Float32Array(768) } }) } }, { engine: 'mms' }, [[0, 5, 0], [0, 6, 0]], 1, 'khmer-clear-v3');
  assert.equal(none, null, 'a model without durations');
});
