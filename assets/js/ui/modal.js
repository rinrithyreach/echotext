/**
 * EchoText — Modal dialogs
 *
 * App.modal.confirm({ title, message, confirmText, cancelText, danger, icon }) → Promise<boolean>
 *   details        extra (trusted) HTML under the message
 *   confirmText    null hides the confirm button
 *   onOpen(close, dialog)  runs once shown; close(value) settles the dialog with any value.
 *                  May return a cleanup function.
 *   wide           a wider dialog (import preview, Models & storage)
 *   initialFocus   selector of the element focused first
 *   beforeConfirm(dialog) → value to resolve with, or throw to keep the dialog open
 *
 * App.modal.prompt({ title, label, value, placeholder, confirmText, suggestions, maxLength })
 *   → Promise<string | null>   (null when cancelled)
 */
(function (App) {
  'use strict';

  const { escapeHtml } = App.utils;
  const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
  let counter = 0;
  const stack = []; // open dialogs, top last: only the top one answers keys

  function confirm({
    title, message = '', details = '', confirmText, cancelText, danger = false, icon, onOpen,
    wide = false, initialFocus = null, beforeConfirm = null,
  } = {}) {
    const okText = confirmText === undefined ? App.t('Confirm') : confirmText;
    const closeText = cancelText === undefined ? App.t('Cancel') : cancelText;
    return new Promise((resolve) => {
      const id = `modal-title-${++counter}`;
      const previousFocus = document.activeElement;
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal${wide ? ' modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${id}">
          ${icon !== null ? `<div class="modal-icon${danger ? ' is-danger' : ''}">${App.icon(icon || (danger ? 'alert-triangle' : 'info'), 22)}</div>` : ''}
          <h2 class="modal-title" id="${id}">${escapeHtml(title)}</h2>
          ${message ? `<p class="modal-body">${escapeHtml(message)}</p>` : ''}
          ${details}
          <p class="modal-error" data-modal-error role="alert" hidden></p>
          <div class="modal-actions">
            ${closeText ? `<button type="button" class="btn btn-ghost" data-modal="cancel">${escapeHtml(closeText)}</button>` : ''}
            ${okText ? `<button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-modal="confirm">${escapeHtml(okText)}</button>` : ''}
          </div>
        </div>`;
      const dialog = backdrop.querySelector('.modal');

      let cleanup = null;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (cleanup) cleanup();
        document.removeEventListener('keydown', onKey, true);
        stack.splice(stack.indexOf(backdrop), 1);
        if (!stack.length) document.body.classList.remove('is-locked');
        backdrop.classList.add('is-leaving');
        setTimeout(() => backdrop.remove(), 200);
        if (previousFocus && previousFocus.focus && document.contains(previousFocus)) previousFocus.focus({ preventScroll: true });
        resolve(value);
      };

      const error = backdrop.querySelector('[data-modal-error]');
      async function accept() {
        if (!beforeConfirm) {
          finish(true);
          return;
        }
        try {
          error.hidden = true;
          finish(await beforeConfirm(dialog));
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      }

      const focusables = () => [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden]'));
      function onKey(event) {
        if (stack[stack.length - 1] !== backdrop) return; // a dialog on top handles keys
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(beforeConfirm ? null : false);
        } else if (event.key === 'Tab') {
          // Keep focus inside the dialog.
          const list = focusables();
          if (!list.length) return;
          const [first, last] = [list[0], list[list.length - 1]];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        } else if (event.key === 'Enter' && event.target.matches('input[data-modal-enter]')) {
          event.preventDefault();
          accept();
        }
      }

      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) {
          finish(beforeConfirm ? null : false);
          return;
        }
        const action = event.target.closest('[data-modal]');
        if (!action) return;
        if (action.dataset.modal === 'confirm') accept();
        else finish(beforeConfirm ? null : false);
      });
      document.addEventListener('keydown', onKey, true);

      (document.getElementById('modal-root') || document.body).appendChild(backdrop);
      stack.push(backdrop);
      document.body.classList.add('is-locked');
      // A dialog that deletes something starts on Cancel, so a stray Enter doesn't confirm it.
      const first = (initialFocus && dialog.querySelector(initialFocus))
        || (!danger && dialog.querySelector('[data-modal="confirm"]'))
        || dialog.querySelector('[data-modal="cancel"]')
        || focusables()[0];
      if (first) first.focus();
      if (first && first.select && first.tagName === 'INPUT') first.select();
      if (onOpen) cleanup = onOpen(finish, dialog) || null;
    });
  }

  function prompt({ title, label = '', value = '', placeholder = '', confirmText, suggestions = [], maxLength = 120, icon = 'pencil', message = '' } = {}) {
    const listId = `modal-list-${counter + 1}`;
    const details = `
      <div class="field modal-field">
        ${label ? `<label class="field-label" for="modal-input-${counter + 1}">${escapeHtml(label)}</label>` : ''}
        <input class="input" type="text" id="modal-input-${counter + 1}" data-modal-input data-modal-enter
          value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" maxlength="${maxLength}" autocomplete="off"
          ${suggestions.length ? `list="${listId}"` : ''} />
        ${suggestions.length ? `<datalist id="${listId}">${suggestions.map((s) => `<option value="${escapeHtml(s)}"></option>`).join('')}</datalist>` : ''}
      </div>`;
    return confirm({
      title, message, details, icon, confirmText: confirmText || App.t('Save'),
      initialFocus: '[data-modal-input]',
      beforeConfirm: (dialog) => dialog.querySelector('[data-modal-input]').value,
    });
  }

  App.modal = { confirm, prompt };
})(window.VoiceAI = window.VoiceAI || {});
