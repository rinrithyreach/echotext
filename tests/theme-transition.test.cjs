const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers.cjs');

function fixture(t, { reducedMotion = false } = {}) {
  const env = createApp();
  const { app, window } = env;
  t.after(() => env.dom.window.close());
  window.document.body.insertAdjacentHTML('afterbegin', '<header id="navbar"></header><main id="main"><textarea>Keep this draft.</textarea></main>');
  window.document.head.insertAdjacentHTML('beforeend', '<meta name="theme-color" content="#04070a">');
  window.matchMedia = () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} });
  app.Theme.init();
  app.components.Navbar.mount(window.document.getElementById('navbar'));
  return { ...env, document: window.document, toggle: window.document.querySelector('[data-theme-toggle]') };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// A skipped view transition still invokes its update callback. Keep that callback
// under test control so stale updates can run after newer clicks, as browsers allow.
function viewTransitions(document) {
  const calls = [];
  document.startViewTransition = (callback) => {
    const ready = deferred();
    const updated = deferred();
    const finished = deferred();
    let ran = false;
    let skipped = false;
    const transition = {
      ready: ready.promise,
      updateCallbackDone: updated.promise,
      finished: finished.promise,
      skips: 0,
      skipTransition() {
        skipped = true;
        this.skips++;
        ready.reject(new Error('Snapshot skipped'));
        if (ran) finished.resolve();
      },
      async update() {
        if (ran) return;
        ran = true;
        try {
          await callback();
          updated.resolve();
          if (skipped) finished.resolve();
          else ready.resolve();
        } catch (error) {
          updated.reject(error);
          ready.reject(error);
          finished.reject(error);
        }
        await Promise.resolve();
      },
      finish: () => finished.resolve(),
      rejectReady: () => ready.reject(new Error('Snapshot unavailable')),
    };
    calls.push(transition);
    return transition;
  };
  return calls;
}

async function until(condition) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Theme transition did not settle');
}

const motionClasses = ['is-switching-theme', 'is-switching-language', 'is-theme-fading'];
function assertSettled(document) {
  for (const name of motionClasses) assert.equal(document.documentElement.classList.contains(name), false, name);
  assert.equal(document.getElementById('main').classList.contains('is-language-fading'), false);
  for (const name of ['--theme-x', '--theme-y', '--theme-radius']) assert.equal(document.documentElement.style.getPropertyValue(name), '');
}

test('theme fallback persists the new look, keeps both icon nodes and preserves the draft', async (t) => {
  const { app, document, toggle, errors } = fixture(t);
  const sun = toggle.querySelector('.theme-icon-sun');
  const moon = toggle.querySelector('.theme-icon-moon');
  toggle.click();
  assert.equal(app.Settings.get().theme, 'light');
  assert.equal(app.storage.get('settings').theme, 'light');
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(document.querySelector('meta[name="theme-color"]').content, '#f3f7f8');
  assert.equal(toggle.getAttribute('aria-label'), 'Switch to dark mode');
  assert.equal(toggle.querySelector('.theme-icon-sun'), sun);
  assert.equal(toggle.querySelector('.theme-icon-moon'), moon);
  assert.equal(document.querySelector('textarea').value, 'Keep this draft.');
  await until(() => !document.documentElement.classList.contains('is-theme-fading'));
  assertSettled(document);
  assert.deepEqual(errors, []);
});

test('view-transition theme changes happen inside the snapshot callback and clean up afterward', async (t) => {
  const { app, document, toggle, errors } = fixture(t);
  const calls = viewTransitions(document);
  const sun = toggle.querySelector('.theme-icon-sun');
  toggle.getBoundingClientRect = () => ({ left: 80, top: 20, width: 40, height: 40 });
  toggle.click();
  assert.equal(calls.length, 1);
  assert.equal(app.Settings.get().theme, 'dark');
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(document.documentElement.classList.contains('is-switching-theme'), true);
  assert.ok(parseFloat(document.documentElement.style.getPropertyValue('--theme-radius')) > 0);
  await calls[0].update();
  assert.equal(app.storage.get('settings').theme, 'light');
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(toggle.querySelector('.theme-icon-sun'), sun);
  calls[0].finish();
  await Promise.resolve();
  assertSettled(document);
  assert.deepEqual(errors, []);
});

test('rapid theme clicks ignore stale snapshot callbacks and land on the last choice', async (t) => {
  const { app, document, toggle, errors } = fixture(t);
  const calls = viewTransitions(document);
  toggle.click(); // pending light
  toggle.click(); // back to dark, before either snapshot changes the page
  assert.equal(calls[0].skips, 1);
  toggle.click(); // latest choice is light again
  assert.equal(calls.length, 2);
  await calls[0].update();
  assert.equal(app.Settings.get().theme, 'dark', 'stale callback must not commit the newer pending choice');
  assert.equal(document.documentElement.classList.contains('is-switching-theme'), true, 'stale cleanup cannot remove the active reveal');
  await calls[1].update();
  assert.equal(app.Settings.get().theme, 'light');
  calls[1].finish();
  await Promise.resolve();
  assertSettled(document);
  assert.deepEqual(errors, []);
});

test('theme and language choices both survive interrupted view transitions', async (t) => {
  const { app, document, toggle, errors } = fixture(t);
  const calls = viewTransitions(document);
  toggle.click(); // theme snapshot is still pending
  document.querySelector('[data-ui-language="km"]').click();
  assert.equal(app.Settings.get().theme, 'light', 'language switch settles the pending theme');
  assert.equal(app.Settings.get().uiLanguage, 'km');
  assert.equal(app.i18n.language, 'en');
  await calls[0].update();
  assert.equal(app.i18n.language, 'en');
  toggle.click(); // theme switch now interrupts the pending language snapshot
  assert.equal(app.i18n.language, 'km', 'theme switch settles the pending language');
  await calls[1].update();
  assert.equal(app.Settings.get().theme, 'light', 'stale language callback must not commit the next theme');
  await calls[2].update();
  assert.equal(app.Settings.get().theme, 'dark');
  assert.equal(app.storage.get('settings').uiLanguage, 'km');
  assert.equal(toggle.getAttribute('aria-label'), app.t('Switch to light mode'));
  calls[2].finish();
  await Promise.resolve();
  assertSettled(document);
  assert.deepEqual(errors, []);
});

test('reduced motion changes theme immediately without starting a view transition', (t) => {
  const { app, document, toggle } = fixture(t, { reducedMotion: true });
  const calls = viewTransitions(document);
  toggle.click();
  assert.equal(calls.length, 0);
  assert.equal(app.Settings.get().theme, 'light');
  assert.equal(document.documentElement.dataset.theme, 'light');
  assertSettled(document);
});

test('failed persistence leaves the theme and toggle unchanged', (t) => {
  const { app, document, toggle, errors } = fixture(t);
  const messages = [];
  app.toast.error = (message) => messages.push(message);
  app.storage.set = () => false;
  const sun = toggle.querySelector('.theme-icon-sun');
  toggle.click();
  assert.equal(app.Settings.get().theme, 'dark');
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(toggle.getAttribute('aria-label'), 'Switch to light mode');
  assert.equal(toggle.querySelector('.theme-icon-sun'), sun);
  assert.equal(messages.length, 1);
  assertSettled(document);
  assert.deepEqual(errors, []);
});

test('a rejected snapshot still applies the chosen theme and clears transition state', async (t) => {
  const { app, document, toggle, errors } = fixture(t);
  const calls = viewTransitions(document);
  toggle.click();
  calls[0].rejectReady();
  await calls[0].update();
  calls[0].finish();
  await Promise.resolve();
  assert.equal(app.Settings.get().theme, 'light');
  assert.equal(document.documentElement.dataset.theme, 'light');
  assertSettled(document);
  assert.deepEqual(errors, []);
});
