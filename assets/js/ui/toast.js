/**
 * EchoText — Toast notifications
 * App.toast.success(title, message?, options?) · .error · .warning · .info
 * options: { duration (ms, 0 = sticky; every message stays 2 seconds unless told otherwise), action: { label, onClick }, stack }
 *
 * A message that is already on screen isn't shown again on top of itself: the
 * repeat is skipped until the first one's time is up. `stack: true` opts out,
 * for messages where every copy matters (each "Audio deleted" has its own Undo).
 */
(function (App) {
  'use strict';

  const { escapeHtml } = App.utils;
  const ICONS = { success: 'check-circle', error: 'x-circle', warning: 'alert-triangle', info: 'info' };
  const MAX_VISIBLE = 3; // a new message past this closes the oldest one
  const DURATION = 2000; // how long a message stays, whatever its type

  // Timed messages on screen right now: key → { handle, setAction }.
  const showing = new Map();
  const keyOf = new WeakMap(); // toast element → its key in `showing`

  function region() {
    return document.getElementById('toast-region');
  }

  function dismiss(el) {
    if (!el || el.classList.contains('is-leaving')) return;
    showing.delete(keyOf.get(el)); // its time is up: the same message may be shown again
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 320);
  }

  function show({ type = 'info', title, message = '', duration = DURATION, action, stack = false } = {}) {
    const root = region();
    if (!root) return { close() {}, update() {} };

    // Sticky messages (progress) are never merged: each belongs to its own task.
    const key = duration && !stack ? [type, title, message, action ? action.label : ''].join('\n') : null;
    const same = key && showing.get(key);
    if (same) {
      same.setAction(action); // its button now does what the newest request asked for
      return same.handle;
    }

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.style.setProperty('--toast-duration', `${duration}ms`);
    el.innerHTML = `
      <span class="toast-icon">${App.icon(ICONS[type] || 'info', 17)}</span>
      <div class="toast-body">
        <p class="toast-title">${escapeHtml(title)}</p>
        ${message ? `<p class="toast-message">${escapeHtml(message)}</p>` : ''}
      </div>
      ${action ? `<button class="toast-action" type="button">${escapeHtml(action.label)}</button>` : ''}
      <button class="toast-close" type="button" aria-label="${escapeHtml(App.t('Dismiss notification'))}">${App.icon('x', 15)}</button>
      ${duration ? '<span class="toast-progress"></span>' : ''}`;

    root.appendChild(el);
    const live = [...root.children].filter((child) => !child.classList.contains('is-leaving'));
    live.slice(0, Math.max(0, live.length - MAX_VISIBLE)).forEach(dismiss);

    let timer = 0;
    let remaining = duration;
    let startedAt = 0;
    const close = () => {
      clearTimeout(timer);
      dismiss(el);
    };
    const start = () => {
      if (!duration) return;
      startedAt = Date.now();
      timer = setTimeout(close, remaining);
      el.classList.remove('is-paused');
    };
    const pause = () => {
      if (!duration) return;
      clearTimeout(timer);
      remaining = Math.max(800, remaining - (Date.now() - startedAt));
      el.classList.add('is-paused');
    };

    el.addEventListener('mouseenter', pause);
    el.addEventListener('mouseleave', start);
    el.querySelector('.toast-close').addEventListener('click', close);
    let onAction = action && action.onClick;
    if (action) {
      el.querySelector('.toast-action').addEventListener('click', () => {
        close();
        if (onAction) onAction();
      });
    }

    /** Updates a live toast in place (used for progress messages). */
    const update = ({ title: nextTitle, message: nextMessage } = {}) => {
      if (nextTitle !== undefined) el.querySelector('.toast-title').textContent = nextTitle;
      if (nextMessage !== undefined) {
        let msg = el.querySelector('.toast-message');
        if (!msg) {
          msg = document.createElement('p');
          msg.className = 'toast-message';
          el.querySelector('.toast-body').appendChild(msg);
        }
        msg.textContent = nextMessage;
      }
    };

    const handle = { close, update };
    if (key) {
      keyOf.set(el, key);
      showing.set(key, {
        handle,
        setAction(next) {
          if (next && next.onClick) onAction = next.onClick;
        },
      });
    }

    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-visible')));
    start();
    return handle;
  }

  App.toast = {
    show,
    success: (title, message, options) => show({ ...options, type: 'success', title, message }),
    error: (title, message, options) => show({ ...options, type: 'error', title, message }),
    warning: (title, message, options) => show({ ...options, type: 'warning', title, message }),
    info: (title, message, options) => show({ ...options, type: 'info', title, message }),
  };
})(window.VoiceAI = window.VoiceAI || {});
