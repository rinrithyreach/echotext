/**
 * EchoText — Audio history
 * The list of generated audio shown under the studio on the home page:
 * search, projects (grouped), rename, play, open in the studio,
 * download audio and delete with undo. It stays hidden
 * until something has been generated.
 */
(function (App) {
  'use strict';

  const { $, escapeHtml, formatTime, formatDate, relativeTime, formatNumber, debounce } = App.utils;
  const icon = App.icon;
  const t = (text, params) => App.t(text, params);
  const FILTER_KEY = 'historyFilter';
  const ALL = '__all__';
  const NONE = '__none__';

  const state = { activeId: null, playback: null, filter: { query: '', project: ALL } };
  const shown = new Set(); // ids already in the list: only rows that are new slide in

  /** History, newest first. */
  function sorted() {
    return [...App.History.list()].sort((a, b) => b.createdAt - a.createdAt);
  }

  function matches(item) {
    const { query, project } = state.filter;
    if (project === NONE && item.project) return false;
    if (project !== ALL && project !== NONE && item.project !== project) return false;
    if (!query) return true;
    const haystack = [item.title, item.text, item.voiceName, item.project].filter(Boolean).join('\n').toLocaleLowerCase();
    return query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
  }

  /** The visible items, grouped by project when showing all projects and any exist. */
  function groupsOf(items) {
    const visible = items.filter(matches);
    const projects = App.History.projects();
    if (state.filter.project !== ALL || !projects.length) return [{ name: null, items: visible }];
    const groups = projects.map((name) => ({ name, items: visible.filter((item) => item.project === name) }));
    groups.push({ name: '', items: visible.filter((item) => !item.project) });
    return groups.filter((group) => group.items.length);
  }

  const whenText = (item) => relativeTime(item.createdAt);
  const lengthText = (item) => `${item.isEstimate ? '~' : ''}${formatTime(item.duration)}`;

  function itemHtml(item, index, isNew) {
    const lang = App.config.getLanguage(item.language);
    const active = state.activeId === item.id;
    const playing = active && state.playback && state.playback.state === 'playing';
    const downloadTip = t('Download MP3');
    return `
      <article class="history-item glass${isNew ? ' is-new' : ''}${active ? ' is-active' : ''}${playing ? ' is-playing' : ''}" data-id="${item.id}"${isNew ? ` style="animation-delay:${Math.min(index, 10) * 35}ms"` : ''}>
        <button class="history-play" type="button" data-act="play" aria-label="${escapeHtml(t(playing ? 'Pause {title}' : 'Play {title}', { title: item.title }))}">
          ${icon(playing ? 'pause' : 'play', 18)}
        </button>
        <div class="history-main">
          <h3 class="history-title" title="${escapeHtml(item.title)}" lang="${lang.code}">${escapeHtml(item.title)}</h3>
          <div class="history-meta">
            <span class="chip"><span class="chip-code">${lang.short}</span>${escapeHtml(t(lang.name))}</span>
            <span class="meta-text">${escapeHtml(item.voiceName || '')}</span>
            ${item.revision > 1 ? `<span class="chip">${escapeHtml(t('Version {n}', { n: item.revision }))}</span>` : ''}
            <span class="meta-text" title="${escapeHtml(formatDate(item.createdAt))}">${icon('calendar', 13)}<span data-when>${escapeHtml(whenText(item))}</span></span>
            <span class="meta-text">${icon('clock', 13)}<span data-length>${lengthText(item)}</span></span>
          </div>
          <div class="history-progress"><span></span></div>
        </div>
        <div class="history-actions">
          <button class="btn-icon is-accent" type="button" data-act="download"
            data-tooltip="${escapeHtml(downloadTip)}" aria-label="${escapeHtml(downloadTip)}">${icon('download', 17)}</button>
          <button class="btn-icon is-accent" type="button" data-act="open" data-tooltip="${escapeHtml(t('Open in studio'))}" aria-label="${escapeHtml(t('Open in studio'))}">${icon('pencil', 17)}</button>
          <button class="btn-icon is-accent" type="button" data-act="more" data-tooltip="${escapeHtml(t('More'))}" aria-label="${escapeHtml(t('More actions for {title}', { title: item.title }))}" aria-haspopup="menu" aria-expanded="false">${icon('menu', 17)}</button>
          <button class="btn-icon is-danger" type="button" data-act="delete" data-tooltip="${escapeHtml(t('Delete'))}" data-tooltip-pos="left" aria-label="${escapeHtml(t('Delete audio'))}">${icon('trash', 17)}</button>
        </div>
      </article>`;
  }

  /** Refreshes the details of a row that's already on screen, without redrawing it. */
  function updateRow(row, item) {
    const set = (selector, text) => {
      const el = row.querySelector(selector);
      if (el.textContent !== text) el.textContent = text;
    };
    set('[data-when]', whenText(item));
    set('[data-length]', lengthText(item));
  }

  /** What's drawn: changes to any of this redraw the list; anything else updates rows in place. */
  const signature = (groups) => JSON.stringify(groups.map((g) => [g.name, g.items.map((i) => [i.id, i.title, i.project || '', i.voiceName])]));

  function renderToolbar(root) {
    const projects = App.History.projects();
    const select = $('[data-filter-project]', root);
    if (state.filter.project !== ALL && state.filter.project !== NONE && !projects.includes(state.filter.project)) state.filter.project = ALL;
    const options = [
      `<option value="${ALL}">${escapeHtml(t('All projects'))}</option>`,
      ...projects.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`),
      projects.length ? `<option value="${NONE}">${escapeHtml(t('No project'))}</option>` : '',
    ].join('');
    if (select.dataset.options !== options) {
      select.innerHTML = options;
      select.dataset.options = options;
    }
    select.value = state.filter.project;
    select.closest('.history-filter-project').hidden = !projects.length;
  }

  function renderList(root) {
    const items = sorted();
    root.hidden = !items.length; // nothing generated yet: no history section at all
    renderToolbar(root);
    const groups = groupsOf(items);
    const visible = groups.reduce((sum, g) => sum + g.items.length, 0);
    const filtered = visible !== items.length;
    $('[data-count]', root).textContent = filtered
      ? t('{shown} of {total} items', { shown: formatNumber(visible), total: formatNumber(items.length) })
      : t(items.length === 1 ? '{n} item' : '{n} items', { n: formatNumber(items.length) });

    const list = $('[data-list]', root);
    const sig = signature(groups);
    if (list.dataset.signature === sig) {
      // The same items in the same order (a length was measured, an MP3 was made…): nothing is
      // redrawn, so a row that's playing isn't disturbed.
      items.forEach((item) => {
        const row = rowFor(root, item.id);
        if (row) updateRow(row, item);
      });
      return;
    }
    list.dataset.signature = sig;

    // Items were added or removed. The playing item's line carries on from where it is drawn right
    // now (it trails its target a little while gliding), and only rows that are new slide in.
    const line = () => state.activeId && rowFor(root, state.activeId) && rowFor(root, state.activeId).querySelector('.history-progress span');
    const old = line();
    const track = old ? old.parentElement.getBoundingClientRect().width : 0;
    const drawn = track ? `${((old.getBoundingClientRect().width / track) * 100).toFixed(2)}%` : '';
    let fresh = 0;
    const rows = (group) => group.items.map((item) => (shown.has(item.id) ? itemHtml(item, 0, false) : itemHtml(item, fresh++, true))).join('');
    list.innerHTML = !visible
      ? `<p class="history-empty">${icon('search', 18)} ${escapeHtml(t('No audio matches. Try other words or filters.'))}</p>`
      : groups.map((group) => (group.name === null
        ? `<div class="history-group-items">${rows(group)}</div>`
        : `<section class="history-group" aria-label="${escapeHtml(group.name || t('No project'))}">
            <h3 class="history-group-title">${icon('folder', 15)} ${escapeHtml(group.name || t('No project'))} <span>${formatNumber(group.items.length)}</span></h3>
            <div class="history-group-items">${rows(group)}</div>
          </section>`)).join('');
    shown.clear();
    items.forEach((item) => shown.add(item.id));
    if (drawn && line()) {
      line().style.setProperty('--p', drawn);
      void line().offsetWidth;
    }
    paintActive(root);
  }

  function rowFor(root, id) {
    return root.querySelector(`.history-item[data-id="${id}"]`);
  }

  function paintActive(root, snapshot) {
    if (!state.activeId) return;
    const row = rowFor(root, state.activeId);
    if (!row) return;
    const snap = snapshot || (state.playback ? state.playback.snapshot() : null);
    if (!snap) return;
    const fill = row.querySelector('.history-progress span');
    const next = snap.progress * 100;
    // Going back (playing again from the start) lands at once; only forward movement glides.
    const back = next < (parseFloat(fill.style.getPropertyValue('--p')) || 0) - 0.5;
    if (back) fill.style.transition = 'none';
    fill.style.setProperty('--p', `${next.toFixed(2)}%`);
    if (back) {
      void fill.offsetWidth;
      fill.style.transition = '';
    }
  }

  function setRowState(root, id, playing) {
    const row = rowFor(root, id);
    if (!row) return;
    const item = App.History.get(id);
    row.classList.add('is-active');
    row.classList.toggle('is-playing', playing);
    const btn = row.querySelector('[data-act="play"]');
    btn.innerHTML = icon(playing ? 'pause' : 'play', 18);
    btn.setAttribute('aria-label', t(playing ? 'Pause {title}' : 'Play {title}', { title: item ? item.title : '' }));
  }

  function stopPlayback(root) {
    if (state.playback) state.playback.destroy();
    if (state.activeId) {
      const row = rowFor(root, state.activeId);
      if (row) {
        row.classList.remove('is-active', 'is-playing');
        row.querySelector('[data-act="play"]').innerHTML = icon('play', 18);
      }
    }
    state.playback = null;
    state.activeId = null;
  }

  async function togglePlay(root, item, button) {
    if (state.activeId === item.id && state.playback) {
      state.playback.toggle();
      return;
    }
    stopPlayback(root);
    state.activeId = item.id;
    button.classList.add('is-loading');
    try {
      const playback = await App.TTS.openPlayback(item);
      if (state.activeId !== item.id) {
        playback.destroy();
        return;
      }
      state.playback = playback;
      playback.on('state', (s) => setRowState(root, item.id, s === 'playing'));
      playback.on('progress', (snap) => paintActive(root, snap));
      playback.on('error', (err) => App.toast.error(t('Playback problem'), err.message));
      // The real length, and (for live speech) the real pace, which the next play keeps to.
      playback.on('measured', (seconds) => App.History.update(item.id, { duration: seconds, isEstimate: false, ...(playback.cps ? { cps: playback.cps } : {}) }));
      setRowState(root, item.id, false);
      playback.play();
    } catch (err) {
      state.activeId = null;
      App.toast.error(t('Can’t play this audio'), err.message);
    } finally {
      button.classList.remove('is-loading');
    }
  }

  async function removeItem(root, item) {
    const confirmed = await App.modal.confirm({
      title: t('Delete this audio?'),
      message: t('“{title}” will be removed from your history.', { title: item.title }),
      confirmText: t('Delete'),
      danger: true,
      icon: 'trash',
    });
    if (!confirmed || !App.History.get(item.id)) return;
    if (state.activeId === item.id) stopPlayback(root);
    const row = rowFor(root, item.id);
    if (row) row.classList.add('is-removing');
    const removed = await App.History.remove(item.id);
    if (!removed) return;
    App.toast.success(t('Audio deleted'), item.title, {
      stack: true, // every deleted item keeps its own Undo, even two with the same title
      action: {
        label: t('Undo'),
        onClick: async () => {
          await App.History.restore(removed);
          App.toast.info(t('Audio restored'));
        },
      },
    });
  }

  async function rename(item) {
    const title = await App.modal.prompt({ title: t('Rename audio'), label: t('Name'), value: item.title, maxLength: 120 });
    if (title === null) return;
    try {
      App.History.rename(item.id, title);
      App.toast.success(t('Renamed'), App.History.get(item.id).title);
    } catch (err) {
      App.toast.error(t('Couldn’t rename'), err.message);
    }
  }

  function openMenu(item, button) {
    App.menu.open(button, [
      { label: t('Rename'), icon: 'pencil', onSelect: () => rename(item) },
      { separator: true },
      { label: t('Download MP3'), icon: 'download', onSelect: () => App.AudioUtils.exportAudio(item, button, 'mp3') },
    ]);
  }

  /**
   * @param {HTMLElement} root
   * @param {{onOpen?: (item: object) => void}} options  onOpen: "Open in studio" was pressed on an item
   */
  function mount(root, { onOpen } = {}) {
    const saved = App.storage.session.get(FILTER_KEY, {}) || {};
    state.filter = { query: saved.query || '', project: saved.project || ALL }; // the filters picked earlier this session
    root.innerHTML = `
      <div class="history-head">
        <h2 class="history-heading">${icon('history', 18)} ${escapeHtml(t('History'))}</h2>
        <p class="history-count" data-count></p>
      </div>
      <div class="history-toolbar" role="search">
        <div class="input-wrap history-search">
          ${icon('search', 16)}
          <input class="input input-sm" type="search" data-filter-query placeholder="${escapeHtml(t('Search titles and text'))}" aria-label="${escapeHtml(t('Search history'))}" value="${escapeHtml(state.filter.query)}" />
        </div>
        <label class="select-wrap history-filter-project">
          <span class="sr-only">${escapeHtml(t('Project'))}</span>
          <select class="select input-sm" data-filter-project></select>
        </label>
      </div>
      <div class="history-list" data-list></div>`;
    shown.clear(); // a fresh list: every row slides in once

    const saveFilter = () => App.storage.session.set(FILTER_KEY, state.filter);
    const onQuery = debounce((value) => {
      state.filter.query = value.trim();
      saveFilter();
      renderList(root);
    }, 150);
    $('[data-filter-query]', root).addEventListener('input', (event) => onQuery(event.target.value));
    $('[data-filter-project]', root).addEventListener('change', (event) => {
      state.filter.project = event.target.value;
      saveFilter();
      renderList(root);
    });

    $('[data-list]', root).addEventListener('click', (event) => {
      const action = event.target.closest('[data-act]');
      if (!action) return;
      const row = action.closest('.history-item');
      const item = row && App.History.get(row.dataset.id);
      if (!item) return;
      switch (action.dataset.act) {
        case 'play':
          togglePlay(root, item, action);
          break;
        case 'download':
          App.AudioUtils.exportAudio(item, action, 'mp3');
          break;
        case 'more':
          openMenu(item, action);
          break;
        case 'delete':
          removeItem(root, item);
          break;
        case 'open':
          if (onOpen) onOpen(item);
          break;
        default:
          break;
      }
    });

    const off = App.bus.on('history:change', () => {
      if (state.activeId && !App.History.get(state.activeId)) stopPlayback(root);
      renderList(root);
      if (state.activeId && state.playback) setRowState(root, state.activeId, state.playback.state === 'playing');
    });
    renderList(root);

    return {
      destroy() {
        off();
        onQuery.cancel();
        App.menu.close();
        if (state.playback) state.playback.destroy();
        state.playback = null;
        state.activeId = null;
      },
    };
  }

  App.components.HistoryList = { mount };
})(window.VoiceAI = window.VoiceAI || {});
