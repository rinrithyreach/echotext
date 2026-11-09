const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers.cjs');

function fixture(t) {
  const env = createApp();
  t.after(() => env.window.close());
  env.router = new env.app.Router(env.window.document.getElementById('root'));
  return env;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('adding and removing home section anchors keeps the active generation and mounted editor', async (t) => {
  const { app, window, router } = fixture(t);
  app.AIVoice.checkDevice = async () => ({ ok: true, errors: [], warnings: [] });
  let signal;
  app.TTS.generate = async (input, options) => {
    signal = options.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new app.TTSError('Stopped', { code: 'aborted' })), { once: true }));
  };
  router.register('/', app.pages.home).register('*', app.pages.notFound);
  router.resolve();
  app.pages.home.generator.setText('Keep generating while navigating around this page.');
  const editor = window.document.querySelector('[data-text]');
  window.document.querySelector('[data-action="generate"]').click();
  await tick();
  assert.ok(signal);
  for (const hash of ['#/?section=history', '#/?section=studio', '#/']) {
    window.location.hash = hash;
    router.resolve();
    assert.equal(window.document.querySelector('[data-text]'), editor, hash);
    assert.equal(signal.aborted, false, hash);
    assert.equal(window.document.querySelector('[data-action="generate"]').disabled, true, hash);
  }
  assert.equal(router.current.search, '');
  app.pages.home.unmount();
  await tick();
});

test('section navigation updates route listeners and scrolls to the top when the section is removed', (t) => {
  const { app, window, router } = fixture(t);
  let renders = 0;
  const sections = [];
  const scrolls = [];
  const routes = [];
  window.scrollTo = (...args) => scrolls.push(args);
  router.register('/', { id: 'home', render(view) { renders++; view.innerHTML = '<section id="history"></section>'; }, onSection: (section) => sections.push(section) });
  app.bus.on('route:change', ({ query }) => routes.push(query.get('section')));
  router.resolve();
  window.location.hash = '#/?section=history';
  router.resolve();
  window.location.hash = '#/';
  router.resolve();
  assert.equal(renders, 1);
  assert.deepEqual(sections, ['history']);
  assert.deepEqual(scrolls.at(-1), [0, 0]);
  assert.deepEqual(routes, [null, 'history', null]);
});

test('other query changes and forced redraws still remount a page', (t) => {
  const { window, router } = fixture(t);
  let renders = 0;
  let unmounts = 0;
  router.register('/', { id: 'home', render() { renders++; }, unmount() { unmounts++; } });
  router.resolve();
  window.location.hash = '#/?filter=one';
  router.resolve();
  window.location.hash = '#/?filter=two';
  router.resolve();
  router.resolve({ force: true, instant: true });
  assert.equal(renders, 4);
  assert.equal(unmounts, 3);
  router.resolve();
  assert.equal(renders, 4);
});

test('different missing routes update the current path even when they share the fallback page', (t) => {
  const { window, router } = fixture(t);
  const visited = [];
  router.register('*', { id: 'missing', render(view, { path }) { visited.push(path); view.textContent = path; } });
  for (const path of ['/missing-one', '/missing-two']) {
    window.location.hash = '#' + path;
    router.resolve();
    assert.equal(router.current.path, path);
  }
  assert.deepEqual(visited, ['/missing-one', '/missing-two']);
});

test('hash parsing retains question marks inside query values', (t) => {
  const { window, router } = fixture(t);
  window.location.hash = '#/?section=history?details&other=value';
  const route = router.parse();
  assert.equal(route.path, '/');
  assert.equal(route.query.get('section'), 'history?details');
  assert.equal(route.query.get('other'), 'value');
});
