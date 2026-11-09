/**
 * EchoText — Text-to-Speech studio
 * Text editor (import / paste / copy / clear / drag & drop), voice settings
 * (voice + language, speed, pitch), the
 * generation flow with progress, cancel and continue, and the result player.
 */
(function (App) {
  'use strict';

  const { $, $$, escapeHtml, debounce, formatNumber, formatBytes, countWords, copyToClipboard } = App.utils;
  const icon = App.icon;
  const t = (text, params) => App.t(text, params);
  const DRAFT_KEY = 'draft';

  const FORMAT = {
    rate: (v) => `${Number(v).toFixed(2).replace(/0$/, '')}x`,
    pitch: (v) => Number(v).toFixed(2).replace(/0$/, ''),
  };

  // Volume isn't a choice: it's always 100% (config.voiceDefaults).
  const SLIDERS = [
    { key: 'rate', label: 'Speed', icon: 'gauge' },
    { key: 'pitch', label: 'Pitch', icon: 'music' },
  ];
  const TABS = [
    { id: 'voice', label: 'Voice', icon: 'mic' },
    { id: 'controls', label: 'Controls', icon: 'sliders' },
  ];

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const genderLabel = (gender) => t({ female: 'Female', male: 'Male' }[gender] || 'Gender-neutral');

  /** Where a slider's value sits along its track, 0–1 (drives the drawn fill and knob). */
  const sliderPosition = (key, value) => {
    const range = App.config.ranges[key];
    return ((value - range.min) / (range.max - range.min)).toFixed(4);
  };

  function sliderField({ key, label, icon: iconName }, value) {
    const range = App.config.ranges[key];
    return `
      <div class="field">
        <div class="field-head">
          <label class="field-label" for="gen-${key}">${icon(iconName, 15)} ${escapeHtml(t(label))}</label>
          <output class="range-value" for="gen-${key}" data-out="${key}">${FORMAT[key](value)}</output>
        </div>
        <div class="range-wrap" style="--p:${sliderPosition(key, value)}">
          <input class="range" type="range" id="gen-${key}" data-range="${key}"
            min="${range.min}" max="${range.max}" step="${range.step}" value="${value}" />
          <span class="range-track" aria-hidden="true"><span class="range-fill"></span></span>
          <span class="range-thumb" aria-hidden="true"></span>
        </div>
        <div class="range-scale"><span>${FORMAT[key](range.min)}</span><span>${FORMAT[key](range.max)}</span></div>
        <p class="field-hint" data-hint="${key}" hidden></p>
      </div>`;
  }

  function template(voice) {
    const cfg = App.config;
    return `
      <div class="studio glass glass-glow" data-reveal>
        <h1 class="sr-only">${escapeHtml(t('Text to Speech Studio'))}</h1>

        <div class="studio-grid">
          <div class="editor" data-editor>
            <div class="editor-toolbar">
              <label class="field-label" for="gen-text">${icon('type', 15)} ${escapeHtml(t('Your text'))}</label>
              <div class="toolbar-actions">
                <button type="button" class="btn-icon is-accent" data-action="upload" data-tooltip="${escapeHtml(t('Import .txt, .docx or .pdf'))}" aria-label="${escapeHtml(t('Import a document'))}">${icon('upload', 18)}</button>
                <button type="button" class="btn-icon is-accent" data-action="paste" data-tooltip="${escapeHtml(t('Paste'))}" aria-label="${escapeHtml(t('Paste from clipboard'))}">${icon('clipboard', 18)}</button>
                <button type="button" class="btn-icon is-accent" data-action="copy" data-tooltip="${escapeHtml(t('Copy text'))}" aria-label="${escapeHtml(t('Copy text'))}">${icon('copy', 18)}</button>
                <button type="button" class="btn-icon is-danger" data-action="clear" data-tooltip="${escapeHtml(t('Clear text'))}" data-tooltip-pos="left" aria-label="${escapeHtml(t('Clear text'))}">${icon('eraser', 18)}</button>
                <input type="file" accept="${App.DocumentImport.ACCEPT}" hidden data-file />
              </div>
            </div>
            <div class="editor-surface">
              <textarea id="gen-text" class="editor-textarea" data-text lang="${voice.language}"
                placeholder="${escapeHtml(t('Type or paste your text here...'))}" spellcheck="true" aria-describedby="text-limit"></textarea>
              <div class="drop-overlay" aria-hidden="true">
                <div class="drop-overlay-inner">
                  ${icon('file-text', 34)}
                  <strong>${escapeHtml(t('Drop a .txt, .docx or .pdf file'))}</strong>
                  <span>${escapeHtml(t('You’ll see its text before it’s loaded'))}</span>
                </div>
              </div>
            </div>
            <div class="editor-footer">
              <button type="button" class="editor-hint" data-action="upload">${icon('upload', 14)} <span class="hint-long">${t('Drag & drop .txt, .docx or .pdf, or <u>browse</u>')}</span><span class="hint-short"><u>${escapeHtml(t('Import a document'))}</u></span></button>
              <div class="counter" data-counter aria-live="polite">
                <span data-words>0</span><span aria-hidden="true">·</span><span id="text-limit" data-chars>0 / ${formatNumber(cfg.maxChars)}</span>
              </div>
            </div>
            <div class="char-meter" data-meter><span></span></div>
          </div>

          <aside class="voice-panel" aria-label="${escapeHtml(t('Voice settings'))}" data-voice-panel>
            <div class="voice-panel-head">
              <h3>
                <button type="button" class="voice-panel-toggle" data-action="toggle-panel" aria-controls="voice-panel-body">
                  <span class="voice-panel-title">${icon('sliders', 17)} ${escapeHtml(t('Voice settings'))} ${icon('chevron-down', { size: 16, className: 'voice-panel-chevron' })}</span>
                  <span class="voice-panel-summary" data-panel-summary></span>
                </button>
              </h3>
              <button type="button" class="btn btn-ghost btn-xs" data-action="reset">${icon('rotate-ccw', 14)} ${escapeHtml(t('Reset'))}</button>
            </div>

            <div class="voice-panel-body" id="voice-panel-body">
              <div class="tabs" role="tablist" aria-label="${escapeHtml(t('Voice settings'))}">
                ${TABS.map((tab, i) => `<button type="button" class="tab" role="tab" id="tab-${tab.id}" data-tab="${tab.id}" aria-controls="panel-${tab.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${escapeHtml(t(tab.label))}</button>`).join('')}
              </div>

              <div class="tab-panel" role="tabpanel" id="panel-voice" aria-labelledby="tab-voice" data-panel="voice">
                <div class="field">
                  <span class="field-label" id="gen-language-label">${icon('languages', 15)} ${escapeHtml(t('Speech language'))}</span>
                  <div class="segmented segmented-2" role="radiogroup" aria-labelledby="gen-language-label" data-languages>
                    ${cfg.languages.map((lang) => `<label class="segmented-item"><input type="radio" name="gen-language" value="${lang.code}" data-language-radio${lang.code === voice.language ? ' checked' : ''} /><span>${escapeHtml(lang.native)}</span></label>`).join('')}
                  </div>
                </div>
                <div class="field">
                  <span class="field-label" id="gen-voice-label">${icon('mic', 15)} ${escapeHtml(t('Voice'))}</span>
                  <div class="voice-list" role="group" aria-labelledby="gen-voice-label" data-voice-list></div>
                </div>
              </div>

              <div class="tab-panel" role="tabpanel" id="panel-controls" aria-labelledby="tab-controls" data-panel="controls" hidden>
                ${SLIDERS.map((s) => sliderField(s, voice[s.key])).join('')}
              </div>

              <div class="voice-notes" data-notes aria-live="polite"></div>
            </div>
          </aside>
        </div>

        <div class="studio-actions">
          <button type="button" class="btn btn-primary btn-xl btn-generate" data-action="generate">
            <span class="btn-generate-content">${icon('sparkles', 20)} <span>${escapeHtml(t('Generate Audio'))}</span></span>
            <span class="btn-generate-loading"><span class="spinner"></span><span>${escapeHtml(t('Generating audio…'))}</span></span>
          </button>
          <p class="studio-shortcut"><kbd>${isMac ? '⌘' : 'Ctrl'}</kbd> + <kbd>Enter</kbd> ${escapeHtml(t('to generate'))}</p>
        </div>

        <section class="recovery-list" data-recovery aria-label="${escapeHtml(t('Saved generations'))}" hidden></section>
        <div class="studio-result" data-result hidden></div>
      </div>`;
  }

  /**
   * @param {HTMLElement} root
   * @param {{shown?: object}} options  shown: a result to show again (the page was redrawn, e.g. in another language)
   */
  function mount(root, options = {}) {
    const cfg = App.config;
    const state = {
      voice: App.Settings.voice(),
      generating: false,
      controller: null,
      result: null,
      player: null,
      preview: null, // { id, playback } — the voice whose preview is playing
      previewLoading: null, // voice id
      previewController: null,
      destroyed: false,
      jobs: new Map(),
      deviceOk: new Set(), // voices whose device warnings were accepted this session
      tab: 'voice',
      importRequest: 0,
      notesRequest: 0,
    };

    root.innerHTML = template(state.voice);
    const el = {
      editor: $('[data-editor]', root),
      text: $('[data-text]', root),
      file: $('[data-file]', root),
      counter: $('[data-counter]', root),
      words: $('[data-words]', root),
      chars: $('[data-chars]', root),
      meter: $('[data-meter]', root),
      panel: $('[data-voice-panel]', root),
      panelToggle: $('[data-action="toggle-panel"]', root),
      panelSummary: $('[data-panel-summary]', root),
      voices: $('[data-voice-list]', root),
      notes: $('[data-notes]', root),
      generate: $('[data-action="generate"]', root),
      result: $('[data-result]', root),
      recovery: $('[data-recovery]', root),
    };
    const cleanups = [];

    /* ---------- Text & counter ---------- */

    function updateCounter() {
      const value = el.text.value;
      const chars = value.length;
      const words = countWords(value);
      const ratio = chars / cfg.maxChars;
      el.words.textContent = t(words === 1 ? '{n} word' : '{n} words', { n: formatNumber(words) });
      el.chars.textContent = `${formatNumber(chars)} / ${formatNumber(cfg.maxChars)}`;
      el.counter.classList.toggle('is-warning', ratio >= 0.9 && ratio < 1);
      el.counter.classList.toggle('is-limit', ratio >= 1);
      el.text.setAttribute('aria-invalid', String(ratio > 1));
      el.meter.classList.toggle('is-warning', ratio >= 0.9 && ratio < 1);
      el.meter.classList.toggle('is-limit', ratio >= 1);
      el.meter.firstElementChild.style.setProperty('--fill', `${Math.min(100, ratio * 100)}%`);
    }

    const saveDraft = debounce(() => App.storage.set(DRAFT_KEY, el.text.value), 400);
    const notesLater = debounce(() => updateNotes(), 350);

    function onTextChange() {
      ++state.importRequest;
      updateCounter();
      saveDraft();
      notesLater();
      el.editor.classList.remove('has-error');
    }

    function setText(value, { focus = true } = {}) {
      if (state.destroyed) return;
      el.text.value = value;
      onTextChange();
      if (focus) el.text.focus({ preventScroll: true });
    }

    function showInputError() {
      el.editor.classList.remove('has-error');
      void el.editor.offsetWidth; // restart the shake animation
      el.editor.classList.add('has-error');
      el.text.focus({ preventScroll: true });
    }

    el.text.addEventListener('input', onTextChange);
    el.text.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        generate();
      }
    });

    /* ---------- Document import & drag-and-drop ---------- */

    function warnIfLong(text) {
      if (text.length > cfg.maxChars) {
        App.toast.warning(t('Text is too long'), t('Your full text was loaded. Shorten it to {n} characters before generating.', { n: formatNumber(cfg.maxChars) }));
        return true;
      }
      return false;
    }

    /** Shows text taken from a .docx or .pdf so it can be checked (and edited) before it's used. */
    async function previewImport(result, request) {
      const paragraphs = result.text.split(/\n\s*\n/).length;
      const stats = [
        result.pages ? t(result.pages === 1 ? '{n} page' : '{n} pages', { n: formatNumber(result.pages) }) : null,
        t('{n} characters', { n: formatNumber(result.text.length) }),
        t(countWords(result.text) === 1 ? '{n} word' : '{n} words', { n: formatNumber(countWords(result.text)) }),
        t(paragraphs === 1 ? '{n} paragraph' : '{n} paragraphs', { n: formatNumber(paragraphs) }),
      ].filter(Boolean);
      const warnings = [...result.warnings];
      if (result.text.length > cfg.maxChars) warnings.push(t('This is longer than {n} characters. Shorten it before generating.', { n: formatNumber(cfg.maxChars) }));
      const hasText = !!el.text.value.trim();
      const details = `
        <p class="import-stats">${icon('file-text', 15)} <strong>${escapeHtml(result.name)}</strong> · ${escapeHtml(stats.join(' · '))}</p>
        ${warnings.map((w) => `<div class="note note-warning">${icon('alert-triangle', 15)}<span>${escapeHtml(w)}</span></div>`).join('')}
        <label class="field-label" for="import-text">${escapeHtml(t('Extracted text — edit it here if anything is wrong'))}</label>
        <textarea class="textarea import-preview" id="import-text" data-import-text spellcheck="false">${escapeHtml(result.text)}</textarea>
        ${hasText ? `
          <div class="segmented segmented-2 import-mode" role="radiogroup" aria-label="${escapeHtml(t('Where to put it'))}">
            <label class="segmented-item"><input type="radio" name="import-mode" value="replace" checked /><span>${escapeHtml(t('Replace my text'))}</span></label>
            <label class="segmented-item"><input type="radio" name="import-mode" value="append" /><span>${escapeHtml(t('Add after my text'))}</span></label>
          </div>` : ''}`;
      const choice = await App.modal.confirm({
        title: t('Check the imported text'), details, wide: true, icon: 'file-text', confirmText: t('Use this text'),
        beforeConfirm: (dialog) => {
          const text = $('[data-import-text]', dialog).value.trim();
          if (!text) throw new Error(t('There’s no text to use.'));
          const mode = $('input[name="import-mode"]:checked', dialog);
          return { text, mode: mode ? mode.value : 'replace' };
        },
      });
      if (!choice || state.destroyed || state.generating || request !== state.importRequest) return;
      const text = choice.mode === 'append' ? `${el.text.value.replace(/\s+$/, '')}\n\n${choice.text}` : choice.text;
      setText(text);
      if (!warnIfLong(text)) App.toast.success(t('Text loaded'), `${result.name} · ${t('{n} characters', { n: formatNumber(choice.text.length) })}`);
    }

    async function loadFile(file) {
      if (state.destroyed || state.generating || App.TTS.isBusy() || !file) return;
      const request = ++state.importRequest;
      const kind = App.DocumentImport.kindOf(file);
      let status = null;
      try {
        if (kind === 'pdf' || kind === 'docx') {
          status = App.toast.show({ type: 'info', title: t('Reading {name}…', { name: file.name }), duration: 0 });
        }
        const result = await App.DocumentImport.extract(file, {
          onProgress: ({ page, pages }) => status && status.update({ title: t('Reading {name}…', { name: file.name }), message: t('Page {n} of {total}', { n: page, total: pages }) }),
        });
        if (status) status.close();
        status = null;
        if (state.destroyed || state.generating || request !== state.importRequest) return;
        if (result.kind === 'txt') {
          setText(result.text);
          if (!warnIfLong(result.text)) App.toast.success(t('File loaded'), `${file.name} · ${t('{n} characters', { n: formatNumber(result.text.length) })}`);
          return;
        }
        await previewImport(result, request);
      } catch (err) {
        if (status) status.close();
        if (state.destroyed || request !== state.importRequest) return;
        const titles = { unsupported: 'Unsupported file', too_large: 'File too large', empty: 'Empty file', no_text: 'No text found', password: 'Password-protected PDF' };
        const title = t(titles[err.code] || 'Couldn’t read file');
        if (err.code === 'empty') App.toast.warning(title, err.message);
        else App.toast.error(title, err.message, { duration: 6000 });
      }
    }

    el.file.addEventListener('change', () => {
      loadFile(el.file.files[0]);
      el.file.value = '';
    });

    let dragDepth = 0;
    const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
    el.editor.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth++;
      el.editor.classList.add('is-dragging');
    });
    el.editor.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    el.editor.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) el.editor.classList.remove('is-dragging');
    });
    el.editor.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      el.editor.classList.remove('is-dragging');
      const files = event.dataTransfer.files;
      if (files.length > 1) App.toast.info(t('One file at a time'), t('Loading {name}.', { name: files[0].name }));
      loadFile(files[0]);
    });

    /* ---------- Toolbar actions ---------- */

    async function paste() {
      const request = ++state.importRequest;
      try {
        if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('unsupported');
        const clip = await navigator.clipboard.readText();
        if (state.destroyed || state.generating || App.TTS.isBusy() || request !== state.importRequest) return;
        if (!clip) {
          App.toast.info(t('Clipboard is empty'));
          return;
        }
        el.text.focus();
        const { selectionStart, selectionEnd } = el.text;
        el.text.setRangeText(clip, selectionStart, selectionEnd, 'end');
        if (el.text.value.length > cfg.maxChars) {
          App.toast.warning(t('Text is too long'), t('Your full text was kept. Shorten it to {n} characters before generating.', { n: formatNumber(cfg.maxChars) }));
        }
        onTextChange();
      } catch {
        if (state.destroyed || state.generating || request !== state.importRequest) return;
        App.toast.info(t('Paste with your keyboard'), t('Clipboard access was blocked — press {keys} instead.', { keys: `${isMac ? '⌘' : 'Ctrl'} + V` }));
        el.text.focus();
      }
    }

    async function copy() {
      if (!el.text.value.trim()) {
        App.toast.info(t('Nothing to copy'), t('Type or paste some text first.'));
        return;
      }
      try {
        await copyToClipboard(el.text.value);
        App.toast.success(t('Copied to clipboard'), t('{n} characters copied.', { n: formatNumber(el.text.value.length) }));
      } catch {
        App.toast.error(t('Copy failed'), t('Your browser blocked clipboard access.'));
      }
    }

    function clear() {
      const previous = el.text.value;
      if (!previous) {
        App.toast.info(t('Editor is already empty'));
        return;
      }
      setText('');
      App.toast.info(t('Text cleared'), '', { action: { label: t('Undo'), onClick: () => setText(previous) } });
    }

    /* ---------- Voice list ---------- */

    function statusText(voice, status) {
      const parts = [t('Default'), genderLabel(voice.gender)];
      const busy = status.activity;
      if (busy && busy.phase === 'download') parts.push(t('Downloading {pct}%', { pct: Math.floor((busy.loaded / Math.max(1, busy.total)) * 100) }));
      else if (busy && busy.phase === 'load') parts.push(t('Loading…'));
      else if (status.inMemory) parts.push(t('Ready'));
      else if (status.bundled) parts.push(t('Built in'));
      else if (status.installed) parts.push(t('Downloaded'));
      else if (status.partial) parts.push(t('Download paused · {size}', { size: formatBytes(voice.size - status.downloadedBytes) }));
      else parts.push(t('{size} download', { size: formatBytes(voice.size) }));
      return parts.join(' · ');
    }

    function renderVoices() {
      const list = App.AIVoice.forLanguage(state.voice.language);
      el.voices.innerHTML = list.map((voice) => {
        const playing = state.preview && state.preview.id === voice.id;
        const loading = state.previewLoading === voice.id;
        return `
          <div class="voice-option${voice.id === state.voice.voiceId ? ' is-selected' : ''}" data-voice-row="${voice.id}">
            <div class="voice-option-main">
              <span class="voice-avatar voice-${voice.gender}" aria-hidden="true">${escapeHtml(Array.from(voice.name)[0])}</span>
              <span class="voice-option-text">
                <strong>${escapeHtml(voice.name)}</strong>
                <span data-voice-status>${escapeHtml(t('Default'))} · ${escapeHtml(genderLabel(voice.gender))}</span>
              </span>
            </div>
            <button type="button" class="btn-icon is-accent voice-preview${playing ? ' is-playing' : ''}${loading ? ' is-loading' : ''}" data-preview-voice="${voice.id}"
              aria-label="${escapeHtml(t(playing ? 'Stop preview of {name}' : 'Preview {name}', { name: voice.name }))}"${state.generating ? ' disabled' : ''}>${icon(playing ? 'stop' : 'play', 15)}</button>
          </div>`;
      }).join('');
      refreshVoiceStatus();
      refreshBusy();
    }

    async function refreshVoiceStatus() {
      for (const row of $$('[data-voice-row]', el.voices)) {
        const voice = App.AIVoice.get(row.dataset.voiceRow);
        const status = await App.AIVoice.status(voice).catch(() => null);
        if (state.destroyed || !status || !row.isConnected) return;
        const text = statusText(voice, status);
        const label = $('[data-voice-status]', row);
        if (label.textContent !== text) label.textContent = text;
      }
    }
    const refreshVoicesLater = debounce(refreshVoiceStatus, 120);
    cleanups.push(App.bus.on('models:change', () => refreshVoicesLater()));

    /* ---------- Voice settings ---------- */

    function saveVoice({ quiet = false } = {}) {
      try {
        App.Settings.update({ lastVoice: { ...state.voice } });
        return true;
      } catch (err) {
        if (!quiet) App.toast.error(t('Settings could not be saved. Browser storage may be full.'), err.message);
        return false;
      }
    }
    const persistVoice = debounce(() => saveVoice(), 300);

    // Closing or reloading can happen before the editor and controls' debounce timers fire.
    function saveSession() {
      saveDraft.cancel();
      persistVoice.cancel();
      App.storage.set(DRAFT_KEY, el.text.value);
      saveVoice({ quiet: true });
    }
    window.addEventListener('pagehide', saveSession);
    cleanups.push(() => window.removeEventListener('pagehide', saveSession));

    function syncControls() {
      const v = state.voice;
      const selectedVoice = App.AIVoice.voiceFor(v);
      el.panelSummary.textContent = `${t(App.config.getLanguage(v.language).name)} · ${selectedVoice.name}`;
      SLIDERS.forEach(({ key }) => {
        const input = $(`[data-range="${key}"]`, root);
        input.value = v[key];
        input.parentElement.style.setProperty('--p', sliderPosition(key, v[key])); // the fill and knob glide there
        const out = $(`[data-out="${key}"]`, root);
        const text = FORMAT[key](v[key]);
        if (out.textContent !== text) {
          out.textContent = text;
          out.classList.remove('is-changing');
          void out.offsetWidth; // restart the pop
          out.classList.add('is-changing');
        }
      });
      $$('[data-language-radio]', root).forEach((radio) => { radio.checked = radio.value === v.language; });
      el.text.setAttribute('lang', v.language);
    }

    function setVoice(patch, { rerender = false } = {}) {
      const languageChanged = patch.language && patch.language !== state.voice.language;
      stopPreview();
      state.voice = { ...state.voice, ...patch };
      if (languageChanged || rerender) {
        renderVoices();
      }
      syncControls();
      persistVoice();
      updateNotes();
    }

    function chooseLanguage(code) {
      if (code === state.voice.language) return;
      const remembered = App.Settings.get().lastVoiceByLanguage || {};
      const voice = App.AIVoice.get(remembered[code]) || App.AIVoice.pick(code, state.voice.gender);
      if (voice) setVoice({ voiceId: voice.id, gender: voice.gender, language: voice.language });
    }

    // Each speech language remembers its own last voice.
    cleanups.push(App.bus.on('settings:change', ({ patch }) => {
      if (patch.lastVoice && patch.lastVoice.voiceId) {
        const map = { ...(App.Settings.get().lastVoiceByLanguage || {}), [patch.lastVoice.language]: patch.lastVoice.voiceId };
        const saved = App.Settings.get().lastVoiceByLanguage || {};
        if (saved[patch.lastVoice.language] !== patch.lastVoice.voiceId) App.Settings.update({ lastVoiceByLanguage: map });
      }
    }));

    async function updateNotes() {
      const request = ++state.notesRequest;
      const notes = [];
      const voice = App.AIVoice.voiceFor(state.voice);
      if (!App.AIVoice.isSupported()) {
        notes.push(['error', 'x-circle', t('This browser cannot run local AI voices. Use a recent browser with WebAssembly and browser storage enabled.')]);
      }
      const text = el.text.value;
      if (text.trim()) {
        const khmer = App.KhmerText.isKhmer(text);
        if (khmer && state.voice.language !== 'km-KH') notes.push(['warning', 'languages', t('Your text looks like Khmer. Choose the Khmer voice to read it.'), 'use-khmer']);
        if (!khmer && state.voice.language === 'km-KH' && /[A-Za-z]{3}/.test(text) && !/[ក-៿]/.test(text)) {
          notes.push(['warning', 'languages', t('The Khmer voice reads Khmer script only. Choose an English voice for English text.'), 'use-english']);
        }
      }
      if (voice) {
        const check = await App.AIVoice.checkDevice(voice).catch(() => null);
        if (state.destroyed || request !== state.notesRequest) return;
        if (check) {
          check.errors.forEach((message) => notes.push(['error', 'x-circle', message]));
          check.warnings.forEach((message) => notes.push(['warning', 'alert-triangle', message]));
        }
      }
      el.notes.innerHTML = notes
        .map(([type, iconName, message, action]) => `<div class="note note-${type}">${icon(iconName, 15)}<span>${escapeHtml(message)}${action ? ` <button type="button" class="link-button" data-note-action="${action}">${escapeHtml(t(action === 'use-khmer' ? 'Use Khmer' : 'Use English'))}</button>` : ''}</span></div>`)
        .join('');
    }

    root.addEventListener('input', (event) => {
      const range = event.target.closest('[data-range]');
      if (range) setVoice({ [range.dataset.range]: Number(range.value) });
    });
    root.addEventListener('change', (event) => {
      const language = event.target.closest('[data-language-radio]');
      if (language && language.checked) chooseLanguage(language.value);
    });

    function resetVoice() {
      const voice = App.AIVoice.pick(state.voice.language, 'female') || App.AIVoice.voices[0];
      state.voice = { ...App.config.voiceDefaults, voiceId: voice.id, gender: voice.gender, language: voice.language };
      stopPreview();
      renderVoices();
      syncControls();
      const saved = saveVoice();
      updateNotes();
      if (saved) App.toast.success(t('Voice settings reset'), t('{name}, normal speed, pitch and pauses.', { name: voice.name }));
    }

    /* ---------- Tabs ---------- */

    function selectTab(id, { focus = false } = {}) {
      state.tab = id;
      $$('[data-tab]', root).forEach((tab) => {
        const on = tab.dataset.tab === id;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
        if (on && focus) tab.focus();
      });
      $$('[data-panel]', root).forEach((panel) => { panel.hidden = panel.dataset.panel !== id; });
    }

    $('[role="tablist"]', root).addEventListener('keydown', (event) => {
      const ids = TABS.map((tab) => tab.id);
      const at = ids.indexOf(state.tab);
      const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: ids.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      selectTab(ids[(next + ids.length) % ids.length], { focus: true });
    });

    /* ---------- Preview ---------- */

    function stopPreview() {
      if (state.previewController) state.previewController.abort(); // a preview still being made
      state.previewController = null;
      if (state.preview) {
        state.preview.playback.destroy();
        state.preview = null;
      }
      state.previewLoading = null;
      paintPreviewButtons();
    }

    function paintPreviewButtons() {
      $$('[data-preview-voice]', root).forEach((button) => {
        const voice = App.AIVoice.get(button.dataset.previewVoice);
        const playing = !!(state.preview && state.preview.id === voice.id && state.preview.playback.state === 'playing');
        button.classList.toggle('is-playing', playing);
        button.classList.toggle('is-loading', state.previewLoading === voice.id);
        button.innerHTML = icon(playing ? 'stop' : 'play', 15);
        button.setAttribute('aria-label', t(playing ? 'Stop preview of {name}' : 'Preview {name}', { name: voice.name }));
      });
    }

    /** Plays a short sample with `voiceId` and the current speed and pitch. */
    async function preview(voiceId) {
      if (state.destroyed || state.generating || App.TTS.isBusy()) return;
      if ((state.preview && state.preview.id === voiceId) || state.previewLoading === voiceId) {
        stopPreview();
        return;
      }
      stopPreview();
      const voice = App.AIVoice.get(voiceId);
      if (!voice) return;
      state.previewLoading = voiceId;
      paintPreviewButtons();
      const controller = new AbortController();
      state.previewController = controller;
      let status = null;
      try {
        if (!(await confirmDevice(voice, controller.signal)) || controller.signal.aborted || state.destroyed) return;
        const playback = await App.TTS.preview({ ...state.voice, voiceId: voice.id, language: voice.language, gender: voice.gender }, {
          signal: controller.signal,
          onProgress: (info) => {
            if (controller.signal.aborted || state.destroyed || info.phase !== 'download') return;
            if (!status) status = App.toast.show({ type: 'info', title: t('Downloading {name}…', { name: voice.name }), duration: 0, action: { label: t('Cancel'), onClick: () => controller.abort() } });
            status.update({ title: t('Downloading {name}…', { name: voice.name }), message: `${formatBytes(info.loaded)} / ${formatBytes(info.total)}` });
          },
        });
        if (controller.signal.aborted || state.destroyed) {
          playback.destroy(); // stopped while it was being made
          return;
        }
        state.preview = { id: voiceId, playback };
        playback.on('state', (s) => {
          if (s === 'ended' && state.preview && state.preview.playback === playback) stopPreview();
          else paintPreviewButtons();
        });
        playback.on('error', (err) => {
          App.toast.error(t('Preview failed'), err.message);
          stopPreview();
        });
        playback.play();
      } catch (err) {
        if (!controller.signal.aborted && !state.destroyed && err.code !== 'aborted') App.toast.error(t('Preview failed'), err.message);
      } finally {
        if (status) status.close();
        if (state.previewController === controller) {
          state.previewController = null;
          state.previewLoading = null;
          paintPreviewButtons();
          refreshVoiceStatus();
        }
      }
    }

    /** Device warnings (low memory) are shown once per voice before it loads. Resolves false to stop. */
    async function confirmDevice(voice, signal) {
      const check = await App.AIVoice.checkDevice(voice);
      if (state.destroyed || signal?.aborted) return false;
      if (!check.ok) {
        App.toast.error(t('Can’t load {name}', { name: voice.name }), check.errors[0], { duration: 8000 });
        return false;
      }
      if (!check.warnings.length || state.deviceOk.has(voice.id)) return true;
      const ok = await App.modal.confirm({
        title: t('Load {name} on this device?', { name: voice.name }), message: check.warnings.join(' '),
        confirmText: t('Load anyway'), icon: 'cpu',
      });
      if (ok) state.deviceOk.add(voice.id);
      return ok;
    }

    /* ---------- Generation ---------- */

    function destroyPlayer() {
      if (state.player) {
        state.player.destroy();
        state.player = null;
      }
    }

    function showLoading(speaker, chars) {
      el.result.hidden = false;
      el.result.innerHTML = `
        <div class="result-loading" role="status">
          <div class="eq" aria-hidden="true">${'<span></span>'.repeat(7)}</div>
          <div class="result-loading-text" data-loading-text>
            <strong>${escapeHtml(t('Generating your audio…'))}</strong>
            <span>${escapeHtml(t('{name} is voicing {n} characters', { name: speaker, n: formatNumber(chars) }))}</span>
            <progress class="generation-progress" data-generation-progress max="1" aria-label="${escapeHtml(t('Generation progress'))}"></progress>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-action="cancel">${icon('x', 15)} ${escapeHtml(t('Cancel'))}</button>
        </div>`;
    }

    function showError(err) {
      el.result.hidden = false;
      el.result.innerHTML = `
        <div class="result-error" role="alert">
          <span class="result-error-icon">${icon('alert-triangle', 22)}</span>
          <div class="result-error-text">
            <strong>${escapeHtml(t('Generation failed'))}</strong>
            <span>${escapeHtml(err.message || t('Something went wrong. Please try again.'))}</span>
          </div>
          <div class="result-actions">
            <button type="button" class="btn btn-outline btn-sm" data-action="generate">${icon('rotate-ccw', 15)} ${escapeHtml(t('Try again'))}</button>
          </div>
        </div>`;
    }

    function showResult(result, autoplay = true) {
      state.shown = result;
      el.result.hidden = false;
      el.result.innerHTML = '<div data-player-mount></div>';
      state.player = App.components.Player.create($('[data-player-mount]', el.result), result, {
        autoplay,
        onMeasured: (seconds, cps) => {
          const measured = { duration: seconds, isEstimate: false, ...(cps ? { cps } : {}) }; // cps: the pace the next play keeps to
          Object.assign(result, measured);
          if (App.History.get(result.id)) App.History.update(result.id, measured);
        },
      });
    }

    function setGenerating(on) {
      state.generating = on;
      el.generate.classList.toggle('is-generating', on);
      el.generate.setAttribute('aria-busy', String(on));
      refreshBusy();
    }

    function refreshBusy() {
      const locked = state.generating || App.TTS.isBusy();
      el.generate.disabled = locked;
      el.text.readOnly = locked;
      $$('[data-range], [data-language-radio], [data-preview-voice], [data-action="reset"], [data-action="upload"], [data-action="paste"], [data-action="clear"], [data-resume], [data-discard]', root).forEach((control) => { control.disabled = locked; });
    }
    cleanups.push(App.bus.on('tts:busy', refreshBusy));

    function progress(info) {
      if (state.destroyed) return;
      const text = $('[data-loading-text]', root);
      if (!text) return;
      const titles = { load: 'Loading your voice…', download: 'Downloading voice files…', speak: 'Generating your audio…', section: 'Section saved', assemble: 'Preparing your audio…' };
      $('strong', text).textContent = t(titles[info.phase] || 'Generating your audio…');
      $('span', text).textContent = info.phase === 'download'
        ? `${formatBytes(info.loaded)} / ${formatBytes(info.total)}`
        : t('Section {n} of {total} · {saved} saved. Keep this tab open while generating.', { n: info.section || info.sections, total: info.sections, saved: info.completed || 0 });
      const meter = $('[data-generation-progress]', text);
      meter.max = info.sections || 1;
      meter.value = (info.completed || 0) + (info.phase === 'speak' && info.total ? info.loaded / info.total : 0);
    }

    async function refreshJobs() {
      try {
        const jobs = (await App.TTS.listJobs()).sort((a, b) => b.createdAt - a.createdAt);
        if (state.destroyed) return;
        state.jobs = new Map(jobs.map((job) => [job.id, job]));
        el.recovery.hidden = !jobs.length;
        el.recovery.innerHTML = jobs.length ? `<h2 class="recovery-heading">${escapeHtml(t('Continue a saved generation'))}</h2>${jobs.map((job) => `
          <div class="recovery-item">
            <div><strong>${escapeHtml(job.title)}</strong><span>${escapeHtml(t('{done} / {total} sections saved', { done: job.completed, total: job.sections.length }))} · ${escapeHtml(App.AIVoice.voiceFor(job.input)?.name || t('Voice'))}</span>
              <progress class="generation-progress" max="${job.sections.length}" value="${job.completed}" aria-hidden="true"></progress></div>
            <button class="btn btn-outline btn-sm" type="button" data-resume="${escapeHtml(job.id)}"${state.generating ? ' disabled' : ''}>${escapeHtml(t('Continue'))}</button>
            <button class="btn-icon is-danger" type="button" data-discard="${escapeHtml(job.id)}" aria-label="${escapeHtml(t('Delete saved generation'))}"${state.generating ? ' disabled' : ''}>${icon('trash', 16)}</button>
          </div>`).join('')}` : '';
        refreshBusy();
      } catch {
        if (!state.destroyed) {
          el.recovery.hidden = false;
          el.recovery.textContent = t('Recovery storage is unavailable. Enable browser storage before generating audio.');
        }
      }
    }

    async function generate(resumeId) {
      if (state.generating || state.destroyed || App.TTS.isBusy()) return;
      const saved = resumeId && state.jobs.get(resumeId);
      if (saved) {
        setVoice(App.Settings.voice(saved.input), { rerender: true });
        setText(saved.input.text);
      }
      try {
        App.TTS.validate(el.text.value, state.voice.language);
      } catch (err) {
        showInputError();
        App.toast.error(err.code === 'empty_text' ? t('Add some text first') : t('Can’t generate yet'), err.message);
        return;
      }
      const speaker = App.AIVoice.voiceFor(state.voice);
      // Reserve the studio before the asynchronous check so a second click cannot replace
      // the first run's AbortController or re-enable its controls.
      ++state.importRequest;
      stopPreview();
      setGenerating(true);
      let allowed = false;
      try {
        allowed = await confirmDevice(speaker);
      } catch (err) {
        if (!state.destroyed) App.toast.error(t('Generation failed'), err.message);
      }
      if (!allowed || state.destroyed) {
        if (!state.destroyed) setGenerating(false);
        return;
      }

      stopPreview();
      App.Playback.stopAll();
      const voice = { ...state.voice };
      destroyPlayer();
      state.shown = null;
      state.controller = new AbortController();
      setGenerating(true);
      showLoading(speaker.name, el.text.value.trim().length);

      try {
        const result = await App.TTS.generate({ ...voice, text: el.text.value }, { signal: state.controller.signal, onProgress: progress, resumeId });
        if (state.destroyed) return;
        state.result = result;
        showResult(result);
        try {
          await App.History.add(result);
          await App.GenerationStore.remove(result.id);
        } catch (err) {
          App.toast.warning(t('Audio is ready; history could not be saved'), t('Download your audio now. The saved generation remains available to retry.'));
          return;
        }
        // The history list is further down this page.
        App.toast.success(t('Audio generated'), t('{language} · {voice} — saved to History', { language: result.languageName, voice: result.voiceName }), {
          action: { label: t('View'), onClick: () => App.utils.scrollToId('history') },
        });
      } catch (err) {
        if (state.destroyed) return;
        if (err.code === 'aborted') {
          el.result.hidden = true;
          el.result.innerHTML = '';
          App.toast.info(t('Generation stopped'), t('Use Continue to resume from the last saved section.'));
        } else {
          console.error('[EchoText] Generation failed', err);
          showError(err);
          App.toast.error(t('Generation failed'), err.message || t('Please try again.'));
        }
      } finally {
        state.controller = null;
        if (!state.destroyed) {
          setGenerating(false);
          refreshJobs();
          refreshVoiceStatus();
        }
      }
    }

    /* ---------- Voice panel (folds on phones) ---------- */

    // Phones start with the settings folded; tapping "Voice settings" opens them. Wider screens
    // always show them, so the title there is plain text rather than a button.
    const phone = window.matchMedia('(max-width: 640px)');

    function setPanelOpen(open) {
      el.panel.classList.toggle('is-collapsed', !open);
      if (phone.matches) el.panelToggle.setAttribute('aria-expanded', String(open));
    }

    function syncPanelMode() {
      el.panelToggle.disabled = !phone.matches;
      if (phone.matches) el.panelToggle.setAttribute('aria-expanded', String(!el.panel.classList.contains('is-collapsed')));
      else el.panelToggle.removeAttribute('aria-expanded');
    }

    phone.addEventListener('change', syncPanelMode);
    cleanups.push(() => phone.removeEventListener('change', syncPanelMode));

    /* ---------- Delegated clicks ---------- */

    root.addEventListener('click', (event) => {
      const target = event.target;
      const resume = target.closest('[data-resume]');
      if (resume) { generate(resume.dataset.resume); return; }
      const discard = target.closest('[data-discard]');
      if (discard && !state.generating) {
        App.modal.confirm({ title: t('Delete saved generation?'), message: t('Its completed sections will be removed from this device.'), confirmText: t('Delete'), danger: true }).then(async (confirmed) => {
          if (confirmed && !state.generating) { await App.GenerationStore.remove(discard.dataset.discard); await refreshJobs(); }
        }).catch((err) => App.toast.error(t('Could not delete'), err.message));
        return;
      }
      const previewButton = target.closest('[data-preview-voice]');
      if (previewButton) { preview(previewButton.dataset.previewVoice); return; }
      const tab = target.closest('[data-tab]');
      if (tab) { selectTab(tab.dataset.tab); return; }
      const noteAction = target.closest('[data-note-action]');
      if (noteAction) { chooseLanguage(noteAction.dataset.noteAction === 'use-khmer' ? 'km-KH' : 'en-US'); return; }
      const action = target.closest('[data-action]');
      if (!action) return;
      switch (action.dataset.action) {
        case 'upload':
          el.file.click();
          break;
        case 'paste':
          paste();
          break;
        case 'copy':
          copy();
          break;
        case 'clear':
          clear();
          break;
        case 'toggle-panel':
          setPanelOpen(el.panel.classList.contains('is-collapsed'));
          break;
        case 'reset':
          resetVoice();
          break;
        case 'generate':
          generate();
          break;
        case 'cancel':
          if (state.controller) state.controller.abort();
          break;
        default:
          break;
      }
    });

    /* ---------- Init ---------- */

    const draft = App.storage.get(DRAFT_KEY, '');
    if (draft) el.text.value = String(draft);
    renderVoices();
    syncControls();
    el.panel.classList.toggle('is-collapsed', phone.matches);
    syncPanelMode();
    updateCounter();
    updateNotes();
    refreshJobs();
    if (options.shown) showResult(options.shown, false);
    refreshBusy();

    return {
      setText,
      focus() {
        el.text.focus({ preventScroll: true });
      },
      /** Loads a History item back into the editor with its text and voice settings. */
      load(item) {
        if (state.destroyed) return;
        if (state.generating) { App.toast.info(t('Generation is running'), t('Stop it before opening another item.')); return; }
        ++state.importRequest;
        stopPreview();
        const voice = App.Settings.voice(item);
        setVoice(voice, { rerender: true });
        setText(String(item.text || ''));
        destroyPlayer();
        state.shown = null;
        el.result.hidden = true;
        el.result.innerHTML = '';
        if (item.hasAudio) showResult(item, false);
      },
      destroy() {
        state.destroyed = true;
        cleanups.forEach((off) => off && off());
        if (state.controller) state.controller.abort();
        stopPreview();
        destroyPlayer();
        saveDraft.cancel();
        persistVoice.cancel();
        notesLater.cancel();
        refreshVoicesLater.cancel();
        saveSession();
        return { shown: state.generating ? null : state.shown || null };
      },
    };
  }

  App.components.Generator = { mount };
})(window.VoiceAI = window.VoiceAI || {});
