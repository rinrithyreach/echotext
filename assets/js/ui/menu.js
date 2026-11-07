/**
 * EchoText — Popover menu
 *
 * App.menu.open(anchorButton, [{ label, icon, onSelect, danger, disabled } | { separator: true }])
 *
 * Opens under (or above, near the bottom of the window) the button that opened it.
 * Arrow keys, Home and End move between items; Escape closes it and returns focus
 * to the button; clicking elsewhere, scrolling or resizing closes it.
 */
(function (App) {
  'use strict';

  const { escapeHtml } = App.utils;
  let current = null;

  function close({ restoreFocus = false } = {}) {
    if (!current) return;
    const { el, anchor, cleanup } = current;
    current = null;
    cleanup();
    el.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (restoreFocus && document.contains(anchor)) anchor.focus({ preventScroll: true });
  }

  function place(el, anchor) {
    const rect = anchor.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const gap = 6;
    let top = rect.bottom + gap;
    if (top + height > window.innerHeight - 8 && rect.top - gap - height > 8) top = rect.top - gap - height;
    let left = rect.right - width;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    el.style.top = `${Math.max(8, top)}px`;
    el.style.left = `${left}px`;
  }

  function open(anchor, items) {
    const wasOpen = current && current.anchor === anchor;
    close();
    if (wasOpen) return; // a second click on the same button closes it
    const el = document.createElement('div');
    el.className = 'menu';
    el.setAttribute('role', 'menu');
    el.innerHTML = items
      .map((item, index) => (item.separator
        ? '<div class="menu-separator" role="separator"></div>'
        : `<button type="button" class="menu-item${item.danger ? ' is-danger' : ''}" role="menuitem" tabindex="-1" data-index="${index}"${item.disabled ? ' disabled' : ''}>
            ${item.icon ? App.icon(item.icon, 16) : '<span class="menu-icon-space"></span>'}<span>${escapeHtml(item.label)}</span>
          </button>`))
      .join('');
    document.body.appendChild(el);
    place(el, anchor);
    anchor.setAttribute('aria-haspopup', 'menu');
    anchor.setAttribute('aria-expanded', 'true');

    const buttons = () => [...el.querySelectorAll('.menu-item:not([disabled])')];
    const focusAt = (i) => {
      const list = buttons();
      if (list.length) list[(i + list.length) % list.length].focus();
    };

    function onKey(event) {
      const list = buttons();
      const at = list.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close({ restoreFocus: true });
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusAt(at + 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusAt(at - 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        focusAt(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        focusAt(list.length - 1);
      } else if (event.key === 'Tab') {
        close({ restoreFocus: true });
      }
    }
    const onPointer = (event) => {
      if (!el.contains(event.target) && !anchor.contains(event.target)) close();
    };
    const onScroll = (event) => {
      if (!el.contains(event.target)) close();
    };
    el.addEventListener('keydown', onKey);
    el.addEventListener('click', (event) => {
      const button = event.target.closest('.menu-item');
      if (!button || button.disabled) return;
      const item = items[Number(button.dataset.index)];
      close({ restoreFocus: true });
      if (item && item.onSelect) item.onSelect();
    });
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    current = {
      el, anchor,
      cleanup() {
        document.removeEventListener('pointerdown', onPointer, true);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onScroll);
      },
    };
    focusAt(0);
  }

  App.menu = { open, close };
})(window.VoiceAI = window.VoiceAI || {});
