const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { JSDOM, requestInterceptor, VirtualConsole } = require('jsdom');
const { createApp, root } = require('./helpers.cjs');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const base = 'https://echotext.test/index.html';
const indexFile = pathToFileURL(path.join(root, 'index.html'));
const segmenterPath = 'assets/js/services/tts/text-segments.js';
const speechPaths = [segmenterPath, 'assets/js/services/tts/khmer-text.js', 'assets/js/services/tts/ai-voice.js', 'assets/js/services/tts/tts-service.js'];
const sources = [...html.matchAll(/<script defer src="([^"]+)"/g)].map((match) => match[1]);
const voice = { voiceId: 'km_KH-mms-medium', language: 'km-KH', rate: 1, pitch: 1, sentencePause: 0.4, paragraphPause: 0.8 };

async function loadPage(t, markup) {
  const errors = [];
  let staleHits = 0;
  const cachedScripts = requestInterceptor((request, { element }) => {
    const url = new URL(request.url);
    if (url.origin !== new URL(base).origin || element.localName !== 'script') return new Response('');
    if (url.pathname === '/assets/js/app.js') return new Response(''); // Test speech bootstrap without mounting the UI.
    const local = new URL(url.pathname.slice(1), indexFile);
    let code = fs.readFileSync(fileURLToPath(local), 'utf8');
    if (request.url === new URL(segmenterPath, base).href) {
      staleHits++;
      // A cached pre-upgrade segmenter has units/cues/plan/sections, but lacks the new helpers.
      code += '\ndelete VoiceAI.TextSegments.pauseFor; delete VoiceAI.TextSegments.cutPoint;';
    }
    return new Response(code, { headers: { 'Content-Type': 'application/javascript' } });
  });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM(markup, { url: base, runScripts: 'dangerously', resources: { interceptors: [cachedScripts] }, virtualConsole });
  t.after(() => dom.window.close());
  await new Promise((resolve) => dom.window.addEventListener('load', resolve, { once: true }));
  assert.deepEqual(errors, [], errors.map(String).join('\n'));
  return { app: dom.window.VoiceAI, staleHits };
}

test('speech bootstrap bypasses an old cached segmenter and loads a consistent helper contract', async (t) => {
  const speechSources = sources.filter((source) => speechPaths.includes(source.split('?')[0]));
  assert.deepEqual(speechSources.map((source) => source.split('?')[0]), speechPaths, 'speech dependencies precede their callers');
  const versions = speechSources.map((source) => new URL(source, base).searchParams.get('v'));
  assert.ok(versions.every((version) => version && version === versions[0]), 'all four related scripts share a nonempty release version');

  const segmenterSource = speechSources[0];
  const stale = await loadPage(t, html.replace(`src="${segmenterSource}"`, `src="${segmenterPath}"`));
  assert.equal(stale.staleHits, 1);
  await assert.rejects(stale.app.TTS.preview(voice), /App\.TextSegments\.pauseFor is not a function/);

  const fresh = await loadPage(t, html);
  assert.equal(fresh.staleHits, 0);
  assert.equal(typeof fresh.app.TextSegments.pauseFor, 'function');
  assert.equal(typeof fresh.app.TextSegments.cutPoint, 'function');
  let input;
  fresh.app.AIVoice.synthesize = async (item) => {
    input = item;
    return { samples: new Float32Array(16000), sampleRate: 16000, duration: 1 };
  };
  fresh.app.AudioPlayback = class { constructor(_blob, options) { this.duration = options.duration; } };
  const preview = await fresh.app.TTS.preview(voice, { text: 'សួស្តី, សូមស្តាប់។\n\nសំឡេងខ្មែរ។' });
  assert.equal(preview.duration, 1);
  assert.deepEqual(Array.from(input.gaps), [0.2, 0.8, 0.4]);

  const env = createApp(); // The shared test loader also accepts the versioned HTML URLs.
  t.after(() => env.dom.window.close());
  assert.equal(typeof env.app.TextSegments.pauseFor, 'function');
});
