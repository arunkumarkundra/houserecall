/**
 * HouseRecall — js/modal.js
 * Modal system with:
 *  - Focus trap (Tab / Shift-Tab cycle within modal)
 *  - ESC to close
 *  - Click-outside (overlay) to close
 *  - Return focus to trigger element on close
 *  - Open / close animation via hidden attribute + CSS
 *  - Scroll-lock on <body> while any modal is open
 *  - Stacked modal support (only top-most is interactive)
 *  - Confirm dialog builder (async, Promise-based)
 *  - Named modal registry for open/close by ID
 */

'use strict';

import { byId, qs, trapFocus, setTextSafe } from './utils.js';


/* ═══════════════════════════════════════════════════════════════
   1. MODAL REGISTRY
   ═══════════════════════════════════════════════════════════════ */

/**
 * Map of modalId → { overlayEl, innerEl, cleanupFn, triggerEl }
 * @type {Map<string, ModalEntry>}
 */
const _registry = new Map();

/**
 * Stack of currently open modal IDs (last = topmost).
 * @type {string[]}
 */
const _stack = [];


/* ═══════════════════════════════════════════════════════════════
   2. REGISTER ALL MODALS ON INIT
   ═══════════════════════════════════════════════════════════════ */

/**
 * Register all modal overlays found in the document.
 * Call once after DOMContentLoaded.
 *
 * Modals are identified by [role="dialog"] or [role="alertdialog"]
 * that have the class "modal-overlay".
 *
 * Close buttons: any element with [data-modal="<id>"] inside or
 * outside the modal will close it when clicked.
 */
export function initModals() {
  // Register every .modal-overlay
  document.querySelectorAll('.modal-overlay').forEach(overlayEl => {
    const id      = overlayEl.id;
    const innerEl = overlayEl.querySelector('.modal');
    if (!id || !innerEl) return;

    _registry.set(id, {
      overlayEl,
      innerEl,
      cleanupFn:  null,   // focus-trap cleanup — set on open
      triggerEl:  null,   // element that opened the modal
    });
  });

  // Global close-button handler (data-modal="<id>")
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-modal]');
    if (btn) {
      const id = btn.getAttribute('data-modal');
      if (id) closeModal(id);
    }
  });

  // ESC key closes the topmost modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _stack.length > 0) {
      e.preventDefault();
      closeModal(_stack[_stack.length - 1]);
    }
  });

  // Click outside (on overlay itself) closes topmost
  document.addEventListener('click', (e) => {
    if (_stack.length === 0) return;
    const topId    = _stack[_stack.length - 1];
    const entry    = _registry.get(topId);
    if (!entry) return;
    // Only close if click was directly on the overlay (not the inner modal)
    if (e.target === entry.overlayEl) {
      closeModal(topId);
    }
  });
}


/* ═══════════════════════════════════════════════════════════════
   3. OPEN MODAL
   ═══════════════════════════════════════════════════════════════ */

/**
 * Open a modal by its element ID.
 *
 * @param {string}      id         — the modal overlay's id attribute
 * @param {HTMLElement} [triggerEl] — element that triggered the open
 *                                    (focus returns here on close)
 */
export function openModal(id, triggerEl = null) {
  const entry = _registry.get(id);
  if (!entry) {
    console.warn(`[HouseRecall] Modal "${id}" not found in registry.`);
    return;
  }

  // If already open, don't re-open
  if (_stack.includes(id)) return;

  // Record trigger element for focus-return
  entry.triggerEl = triggerEl ?? document.activeElement;

  // Show overlay
  entry.overlayEl.removeAttribute('hidden');

  // Push to stack
  _stack.push(id);

  // Lock body scroll
  _lockScroll();

  // Trap focus inside the inner modal element
  entry.cleanupFn = trapFocus(entry.innerEl);

  // Focus the first focusable element (or the modal itself)
  requestAnimationFrame(() => {
    const firstFocusable = _getFirstFocusable(entry.innerEl);
    if (firstFocusable) {
      firstFocusable.focus();
    } else {
      entry.innerEl.focus();
    }
  });
}


/* ═══════════════════════════════════════════════════════════════
   4. CLOSE MODAL
   ═══════════════════════════════════════════════════════════════ */

/**
 * Close a modal by its element ID.
 *
 * @param {string} id
 */
export function closeModal(id) {
  const entry = _registry.get(id);
  if (!entry) return;

  // Remove from stack
  const idx = _stack.indexOf(id);
  if (idx !== -1) _stack.splice(idx, 1);

  // Hide overlay
  entry.overlayEl.setAttribute('hidden', '');

  // Clean up focus trap
  if (entry.cleanupFn) {
    entry.cleanupFn();
    entry.cleanupFn = null;
  }

  // Unlock scroll if no more modals open
  if (_stack.length === 0) _unlockScroll();

  // Return focus to trigger element
  requestAnimationFrame(() => {
    if (entry.triggerEl && typeof entry.triggerEl.focus === 'function') {
      entry.triggerEl.focus();
    }
    entry.triggerEl = null;
  });
}

/**
 * Close all open modals.
 */
export function closeAllModals() {
  [..._stack].reverse().forEach(id => closeModal(id));
}

/**
 * Check if a modal is currently open.
 * @param {string} id
 * @returns {boolean}
 */
export function isModalOpen(id) {
  return _stack.includes(id);
}


/* ═══════════════════════════════════════════════════════════════
   5. CONFIRM DIALOG (Promise-based)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Show the confirm dialog and return a Promise that resolves to
 * true (confirmed) or false (cancelled / dismissed).
 *
 * @param {{
 *   title?:   string,
 *   message:  string,
 *   confirmLabel?: string,
 *   cancelLabel?:  string,
 *   danger?:  boolean,
 * }} opts
 * @returns {Promise<boolean>}
 */
export function showConfirm(opts = {}) {
  return new Promise((resolve) => {
    const {
      title        = 'Are you sure?',
      message,
      confirmLabel = 'Yes, do it',
      cancelLabel  = 'Nope, keep it',
      danger       = true,
    } = opts;

    const titleEl   = byId('modal-confirm-title');
    const msgEl     = byId('modal-confirm-msg');
    const okBtn     = byId('btn-confirm-ok');
    const cancelBtn = byId('btn-confirm-cancel');

    if (!titleEl || !msgEl || !okBtn || !cancelBtn) {
      console.warn('[HouseRecall] Confirm modal elements not found.');
      resolve(false);
      return;
    }

    // Populate content safely
    setTextSafe(titleEl,   title);
    setTextSafe(msgEl,     message ?? '');
    setTextSafe(okBtn,     confirmLabel);
    setTextSafe(cancelBtn, cancelLabel);

    // Style confirm button
    okBtn.className = danger ? 'btn btn--danger' : 'btn btn--primary';

    // One-shot listeners — remove themselves after firing
    function onConfirm() {
      cleanup();
      closeModal('modal-confirm');
      resolve(true);
    }

    function onCancel() {
      cleanup();
      closeModal('modal-confirm');
      resolve(false);
    }

    function cleanup() {
      okBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
    }

    okBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);

    // Open — focus will land on the cancel button (safer default)
    openModal('modal-confirm', document.activeElement);

    // Focus cancel button by default (safer: less destructive)
    requestAnimationFrame(() => {
      cancelBtn.focus();
    });
  });
}


/* ═══════════════════════════════════════════════════════════════
   6. MODAL CONTENT HELPERS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Update the title and subtitle of a modal.
 * @param {string} modalId
 * @param {{ emoji?: string, title?: string, subtitle?: string }} opts
 */
export function setModalHeader(modalId, { emoji, title, subtitle } = {}) {
  const entry = _registry.get(modalId);
  if (!entry) return;

  const { innerEl } = entry;

  if (emoji !== undefined) {
    const emojiEl = innerEl.querySelector('.modal-emoji');
    if (emojiEl) setTextSafe(emojiEl, emoji);
  }
  if (title !== undefined) {
    const titleEl = innerEl.querySelector('.modal-title');
    if (titleEl) setTextSafe(titleEl, title);
  }
  if (subtitle !== undefined) {
    const subtitleEl = innerEl.querySelector('.modal-subtitle');
    if (subtitleEl) setTextSafe(subtitleEl, subtitle);
  }
}

/**
 * Reset all form inputs inside a modal to their default values.
 * @param {string} modalId
 */
export function resetModalForm(modalId) {
  const entry = _registry.get(modalId);
  if (!entry) return;

  // Reset standard inputs
  entry.innerEl.querySelectorAll('input, select, textarea').forEach(el => {
    if (el.type === 'checkbox' || el.type === 'radio') {
      el.checked = el.defaultChecked;
    } else {
      el.value = el.defaultValue ?? '';
    }
  });

  // Clear validation states
  entry.innerEl.querySelectorAll('.form-error').forEach(el => {
    el.textContent = '';
  });
  entry.innerEl.querySelectorAll('.is-invalid').forEach(el => {
    el.classList.remove('is-invalid');
  });
}

/**
 * Show a field-level validation error inside a modal.
 * @param {string} fieldId   — the input element's ID
 * @param {string} errorId   — the error span's ID
 * @param {string} message
 */
export function showFieldError(fieldId, errorId, message) {
  const field = byId(fieldId);
  const error = byId(errorId);
  if (field) field.classList.add('is-invalid');
  if (error) setTextSafe(error, message);
}

/**
 * Clear a field-level validation error.
 * @param {string} fieldId
 * @param {string} errorId
 */
export function clearFieldError(fieldId, errorId) {
  const field = byId(fieldId);
  const error = byId(errorId);
  if (field) field.classList.remove('is-invalid');
  if (error) error.textContent = '';
}

/**
 * Clear ALL field errors inside a modal.
 * @param {string} modalId
 */
export function clearAllFieldErrors(modalId) {
  const entry = _registry.get(modalId);
  if (!entry) return;
  entry.innerEl.querySelectorAll('.form-error').forEach(el => {
    el.textContent = '';
  });
  entry.innerEl.querySelectorAll('.is-invalid').forEach(el => {
    el.classList.remove('is-invalid');
  });
}


/* ═══════════════════════════════════════════════════════════════
   7. PASSWORD VISIBILITY TOGGLE (shared across modals)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Wire all [data-target] toggle-password buttons in the document.
 * Call once after DOMContentLoaded.
 */
export function initPasswordToggles() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-password');
    if (!btn) return;

    const targetId = btn.getAttribute('data-target');
    if (!targetId) return;

    const input = byId(targetId);
    if (!input) return;

    const isHidden = input.type === 'password';
    input.type     = isHidden ? 'text' : 'password';
    btn.textContent = isHidden ? '🙈' : '👁️';
    btn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');

    // Return focus to input so user can keep typing
    input.focus();
  });
}


/* ═══════════════════════════════════════════════════════════════
   8. SCROLL LOCK
   ═══════════════════════════════════════════════════════════════ */

let _scrollY = 0;

function _lockScroll() {
  if (document.body.style.overflow === 'hidden') return; // already locked
  _scrollY = window.scrollY;
  document.body.style.overflow   = 'hidden';
  document.body.style.position   = 'fixed';
  document.body.style.top        = `-${_scrollY}px`;
  document.body.style.width      = '100%';
}

function _unlockScroll() {
  document.body.style.overflow = '';
  document.body.style.position = '';
  document.body.style.top      = '';
  document.body.style.width    = '';
  window.scrollTo(0, _scrollY);
}


/* ═══════════════════════════════════════════════════════════════
   9. FOCUS HELPERS (internal)
   ═══════════════════════════════════════════════════════════════ */

const FOCUSABLE_SELECTORS = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Get the first focusable element inside a container.
 * Skips hidden elements.
 * @param {HTMLElement} container
 * @returns {HTMLElement|null}
 */
function _getFirstFocusable(container) {
  const candidates = Array.from(container.querySelectorAll(FOCUSABLE_SELECTORS));
  return candidates.find(el =>
    !el.closest('[hidden]') &&
    getComputedStyle(el).display !== 'none' &&
    getComputedStyle(el).visibility !== 'hidden'
  ) ?? null;
}


/* ═══════════════════════════════════════════════════════════════
   10. TYPE DEFINITIONS (JSDoc)
   ═══════════════════════════════════════════════════════════════ */

/**
 * @typedef {Object} ModalEntry
 * @property {HTMLElement}       overlayEl   — the .modal-overlay element
 * @property {HTMLElement}       innerEl     — the .modal element inside
 * @property {Function|null}     cleanupFn   — focus-trap cleanup
 * @property {HTMLElement|null}  triggerEl   — element that opened the modal
 */
