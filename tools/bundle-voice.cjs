// Writes a file as the base64 scripts in assets/voices that a page opened from disk can read.
//   node tools/bundle-voice.cjs <file> <key>
// Then set BUNDLED[key] in assets/js/services/tts/ai-voice.js to the number of parts printed.
const fs = require('node:fs');
const path = require('node:path');

const [file, key] = process.argv.slice(2);
if (!file || !key) {
  console.error('Usage: node tools/bundle-voice.cjs <file> <key>');
  process.exit(1);
}
const PART = 16 * 1024 * 1024; // 16 MB of data → about 22 MB of base64 per script
const dir = path.resolve(__dirname, '..', 'assets', 'voices');
const data = fs.readFileSync(file);
let parts = 0;
for (let offset = 0; offset < data.length; offset += PART, parts++) {
  const chunk = data.subarray(offset, offset + PART).toString('base64');
  fs.writeFileSync(path.join(dir, `${key}.${parts}.js`), `VoiceAI.AIVoice.receive(${JSON.stringify(key)}, ${parts}, ${JSON.stringify(chunk)});\n`);
}
console.log(`${key}: ${data.length} bytes in ${parts} part(s)`);
