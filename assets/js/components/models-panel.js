/**
 * EchoText — Models & storage
 *
 * A dialog (opened from the navbar) that shows every voice model and the
 * speech engine: size, where it is (built in, downloaded, not downloaded),
 * whether it's loaded, and progress while it downloads or loads. Each can be
 * downloaded, loaded, unloaded, repaired or removed. It also checks the device
 * (WebAssembly, memory) and shows how much browser storage is used and free.
 */
(function (App) {
  'use strict';

  const { $, escapeHtml, formatBytes, debounce } = App.utils;
  const icon = App.icon;
  const t = (text, params) => App.t(text, params);
  const genderLabel = (gender) => t({ female: 'Female', male: 'Male' }[gender] || 'Gender-neutral');

  function check(ok, label, detail) {
    return `<li class="device-check ${ok === true ? 'is-ok' : ok === false ? 'is-bad' : 'is-unknown'}">
      ${icon(ok === true ? 'check-circle' : ok === false ? 'x-circle' : 'info', 16)}
      <span><strong>${escapeHtml(label)}</strong>${detail ? ` <span>${escapeHtml(detail)}</span>` : ''}</span></li>`;
  }

  async function deviceHtml() {
    const storage = await App.AIVoice.storage();
    const memory = navigator.deviceMemory;
    const items = [
      check(typeof WebAssembly === 'object', t('WebAssembly'), typeof WebAssembly === 'object' ? t('Supported') : t('Not supported: AI voices can’t run')),
      check(typeof BigInt64Array === 'function', t('Modern JavaScript'), typeof BigInt64Array === 'function' ? t('Supported') : t('Update this browser')),
      check('indexedDB' in window, t('Browser storage'), 'indexedDB' in window ? t('Available') : t('Off: History and downloads can’t be kept')),
      check(memory ? memory >= 4 : null, t('Memory'), memory ? t('{n} GB reported{note}', { n: memory, note: memory < 4 ? t(' — large voices may be slow') : '' }) : t('Not reported by this browser')),
    ];
    const history = App.History.stats();
    const pct = storage.known && storage.quota ? Math.min(100, (storage.usage / storage.quota) * 100) : 0;
    return `
      <ul class="device-checks">${items.join('')}</ul>
      <div class="storage-box">
        <div class="storage-head">
          <strong>${icon('database', 15)} ${escapeHtml(t('Browser storage'))}</strong>
          <span>${storage.known ? escapeHtml(t('{used} used · {free} free', { used: formatBytes(storage.usage), free: formatBytes(storage.available) })) : escapeHtml(t('Size not reported by this browser'))}</span>
        </div>
        ${storage.known ? `<div class="storage-bar" role="img" aria-label="${escapeHtml(t('{pct}% of browser storage used', { pct: Math.round(pct) }))}"><span style="width:${pct.toFixed(1)}%"></span></div>` : ''}
        <p class="field-hint">${escapeHtml(t('History audio: {size} in {n} items.', { size: formatBytes(history.bytes), n: history.count }))}</p>
        <div class="storage-persist">
          ${storage.persisted
            ? `<span class="badge badge-success">${icon('shield-check', 13)} ${escapeHtml(t('Kept even when space runs low'))}</span>`
            : `<span class="field-hint">${escapeHtml(t('The browser may clear downloads and History when space runs low.'))}</span>
               <button type="button" class="btn btn-ghost btn-xs" data-model-act="persist">${icon('lock', 13)} ${escapeHtml(t('Keep my files'))}</button>`}
        </div>
      </div>`;
  }

  function where(status) {
    if (status.bundled) return t('Built in');
    if (status.installed) return t('Downloaded');
    if (status.partial) return t('Partly downloaded');
    return t('Not downloaded');
  }

  function progressHtml(activity) {
    if (!activity) return '';
    if (activity.phase === 'download') {
      return `<div class="model-progress"><progress max="${activity.total}" value="${activity.loaded}"></progress><span>${escapeHtml(t('Downloading {loaded} of {total}', { loaded: formatBytes(activity.loaded), total: formatBytes(activity.total) }))}</span></div>`;
    }
    if (activity.phase === 'speak') {
      return `<div class="model-progress"><progress max="${activity.total || 1}" value="${activity.loaded || 0}"></progress><span>${escapeHtml(t('Speaking…'))}</span></div>`;
    }
    return `<div class="model-progress"><progress></progress><span>${escapeHtml(t('Loading into memory…'))}</span></div>`;
  }

  function actionsFor(model, status) {
    const busy = !!status.activity;
    const button = (act, label, iconName, extra = '') => `<button type="button" class="btn btn-ghost btn-xs" data-model-act="${act}" data-model="${model.id}"${busy ? ' disabled' : ''}${extra}>${icon(iconName, 13)} ${escapeHtml(label)}</button>`;
    if (model.id === 'runtime') return button('repair', t('Repair'), 'refresh-cw');
    const out = [];
    if (!status.installed) out.push(button('download', status.partial ? t('Resume download') : t('Download'), 'download'));
    else if (!status.inMemory) out.push(button('load', t('Load'), 'cpu'));
    else out.push(button('unload', t('Unload'), 'power'));
    if (status.installed || status.partial) out.push(button('repair', t('Repair'), 'refresh-cw'));
    if (!model.bundled && (status.installed || status.partial)) out.push(button('remove', t('Remove'), 'trash', ' data-danger'));
    return out.join('');
  }

  async function modelRow(model) {
    const status = await App.AIVoice.status(model);
    const lang = model.language ? App.config.getLanguage(model.language) : null;
    const meta = model.id === 'runtime'
      ? [t('ONNX Runtime + espeak-ng'), formatBytes(model.size)]
      : [t(lang.name), genderLabel(model.gender), formatBytes(model.size), model.license];
    const state = [where(status), status.inMemory ? t('In memory') : null].filter(Boolean).join(' · ');
    return `
      <li class="model-row${status.inMemory ? ' is-loaded' : ''}" data-model-row="${model.id}">
        <div class="model-info">
          <strong>${escapeHtml(model.id === 'runtime' ? t('Speech engine') : model.name)}</strong>
          <span>${escapeHtml(meta.filter(Boolean).join(' · '))}</span>
          <span class="model-state">${escapeHtml(state)}</span>
          ${progressHtml(status.activity)}
        </div>
        <div class="model-actions">${actionsFor(model, status)}</div>
      </li>`;
  }

  async function modelsHtml() {
    const rows = await Promise.all([App.AIVoice.runtime, ...App.AIVoice.voices].map(modelRow));
    return `<ul class="model-list">${rows.join('')}</ul>`;
  }

  async function runAction(act, model, button) {
    const voice = model;
    try {
      if (act === 'persist') {
        const ok = await App.AIVoice.persist();
        if (ok) App.toast.success(t('Files will be kept'), t('The browser won’t clear EchoText’s storage when space runs low.'));
        else App.toast.info(t('The browser decided'), t('It didn’t allow permanent storage right now. Bookmarking EchoText or using it often can help.'));
        return;
      }
      if (act === 'download' || act === 'load') {
        const checked = await App.AIVoice.checkDevice(voice);
        if (!checked.ok) {
          App.toast.error(t('Can’t load {name}', { name: voice.name }), checked.errors[0], { duration: 8000 });
          return;
        }
        if (checked.warnings.length && !(await App.modal.confirm({ title: t('Load {name} on this device?', { name: voice.name }), message: checked.warnings.join(' '), confirmText: t('Load anyway'), icon: 'cpu' }))) return;
      }
      if (act === 'download') {
        await App.AIVoice.install(voice);
        App.toast.success(t('{name} downloaded', { name: voice.name }), t('It now works offline.'));
      } else if (act === 'load') {
        await App.AIVoice.load(voice);
        App.toast.success(t('{name} is ready', { name: voice.name }));
      } else if (act === 'unload') {
        await App.AIVoice.unload(voice);
        App.toast.info(t('{name} unloaded', { name: voice.name }), t('Its memory was freed. It loads again when used.'));
      } else if (act === 'remove') {
        const ok = await App.modal.confirm({
          title: t('Remove {name}?', { name: voice.name }), message: t('Its downloaded files ({size}) are deleted from this browser. You can download it again later.', { size: formatBytes(voice.size) }),
          confirmText: t('Remove'), danger: true, icon: 'trash',
        });
        if (!ok) return;
        await App.AIVoice.remove(voice);
        App.toast.success(t('{name} removed', { name: voice.name }));
      } else if (act === 'repair') {
        App.utils.setBusy(button, true);
        const { seconds } = await App.AIVoice.repair(voice);
        App.toast.success(t('{name} works', { name: model.id === 'runtime' ? t('Speech engine') : voice.name }), seconds ? t('Test sentence made in {n} s.', { n: seconds.toFixed(1) }) : t('The engine loaded again.'));
      }
    } catch (err) {
      if (err.code !== 'aborted') App.toast.error(t('Something went wrong'), err.message, { duration: 8000 });
    } finally {
      if (button && button.isConnected) App.utils.setBusy(button, false);
    }
  }

  function open() {
    const details = `
      <div class="models-panel" data-models-panel>
        <h3 class="models-section-title">${escapeHtml(t('This device'))}</h3>
        <div data-device><p class="field-hint">${escapeHtml(t('Checking…'))}</p></div>
        <h3 class="models-section-title">${escapeHtml(t('Voices and engine'))}</h3>
        <div data-models><p class="field-hint">${escapeHtml(t('Checking…'))}</p></div>
        <p class="field-hint">${escapeHtml(t('Built-in voices come with EchoText and work offline. Downloaded voices are kept in this browser. Repair reloads a voice and tests it.'))}</p>
      </div>`;
    return App.modal.confirm({
      title: t('Models & storage'), details, wide: true, icon: 'database', confirmText: null, cancelText: t('Close'),
      onOpen(close, dialog) {
        let closed = false;
        let renderId = 0;
        const pending = new Set();
        const render = async () => {
          const id = ++renderId;
          try {
            const [device, models] = await Promise.all([deviceHtml(), modelsHtml()]);
            if (closed || id !== renderId) return;
            const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset : {};
            $('[data-device]', dialog).innerHTML = device;
            $('[data-models]', dialog).innerHTML = models;
            // Device checks and confirmation dialogs can precede a model's activity event.
            dialog.querySelectorAll('[data-model-act]').forEach((button) => {
              if (pending.has(button.dataset.model || button.dataset.modelAct)) button.disabled = true;
            });
            // Keep keyboard focus on the same button after a redraw.
            if (focused.modelAct) {
              const again = $(`[data-model-act="${focused.modelAct}"]${focused.model ? `[data-model="${focused.model}"]` : ''}`, dialog)
                || $(`[data-model-row="${focused.model}"] [data-model-act]`, dialog);
              if (again) again.focus();
            }
          } catch (err) {
            if (closed || id !== renderId) return;
            App.toast.error(t('Something went wrong'), err.message);
            for (const selector of ['[data-device]', '[data-models]']) {
              const area = $(selector, dialog);
              if (!area.querySelector('ul')) area.textContent = t('Something went wrong');
            }
          }
        };
        const later = debounce(render, 150);
        dialog.addEventListener('click', (event) => {
          const button = event.target.closest('[data-model-act]');
          if (!button || button.disabled) return;
          const key = button.dataset.model || button.dataset.modelAct;
          if (pending.has(key)) return;
          pending.add(key);
          App.utils.setBusy(button, true);
          const model = button.dataset.model ? App.AIVoice.get(button.dataset.model) : null;
          runAction(button.dataset.modelAct, model, button).finally(() => {
            pending.delete(key);
            if (!closed) render();
          });
        });
        const offs = [App.bus.on('models:change', later), App.bus.on('history:change', later)];
        render();
        return () => {
          closed = true;
          later.cancel();
          offs.forEach((off) => off());
        };
      },
    });
  }

  App.components.ModelsPanel = { open };
})(window.VoiceAI = window.VoiceAI || {});
