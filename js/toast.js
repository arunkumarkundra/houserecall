/**
 * HouseRecall — js/toast.js
 * Toast notification system.
 *
 * Features:
 *  - 4 variants: success, error, warning, info
 *  - Auto-dismiss with configurable duration
 *  - Manual dismiss (✕ button)
 *  - Pause auto-dismiss on hover / focus
 *  - Accessible aria-live region (polite + assertive modes)
 *  - Queue management — max 4 visible at once, rest queued
 *  - Smooth slide-in / slide-out animations via CSS classes
 *  - No dependencies beyond utils.js
 */

'use strict';

import { byId, createElement, setTextSafe } from './utils.js';


/* ═══════════════════════════════════════════════════════════════
   1. CONSTANTS
   ═══════════════════════════════════════════════════════════════ */

const DURATIONS = {
  success: 3500,
  info:    4000,
  warning: 5000,
  error:   6000,
};

const ICONS = {
  success: '✅',
  info:    'ℹ️',
  warning: '⚠️',
  error:   '❌',
};

const MAX_VISIBLE   = 4;
const ANIM_OUT_MS   = 250;   // must match CSS toast--out duration


/* ═══════════════════════════════════════════════════════════════
   2. TOAST MANAGER (singleton)
   ═══════════════════════════════════════════════════════════════ */

class ToastManager {
  constructor() {
    /** @type {HTMLElement|null} */
    this._region = null;

    /** @type {Array<ToastOptions>} pending queue */
    this._queue  = [];

    /** @type {Set<string>} IDs of currently visible toasts */
    this._visible = new Set();

    /** @type {Map<string, { timerId: number, remaining: number, start: number }>} */
    this._timers = new Map();

    this._counter = 0;
  }

  /* ── Init ──────────────────────────────────────────────────── */

  /**
   * Bind to the toast region element.
   * Must be called once after DOM is ready.
   */
  init() {
    this._region = byId('toast-region');
    if (!this._region) {
      console.warn('[HouseRecall] Toast region element not found.');
    }
  }

  /* ── Public API ─────────────────────────────────────────────── */

  /**
   * Show a toast notification.
   *
   * @param {string} message
   * @param {ToastVariant} [variant='info']
   * @param {{ duration?: number, id?: string }} [opts]
   * @returns {string} toast ID
   */
  show(message, variant = 'info', opts = {}) {
    const id       = opts.id ?? `toast-${++this._counter}`;
    const duration = opts.duration ?? DURATIONS[variant] ?? DURATIONS.info;

    const options = { id, message, variant, duration };

    // Deduplicate: if a toast with the same ID is already visible, skip
    if (opts.id && this._visible.has(opts.id)) return id;

    if (this._visible.size >= MAX_VISIBLE) {
      this._queue.push(options);
    } else {
      this._render(options);
    }

    return id;
  }

  /** Convenience: success toast */
  success(message, opts = {}) {
    return this.show(message, 'success', opts);
  }

  /** Convenience: error toast */
  error(message, opts = {}) {
    return this.show(message, 'error', opts);
  }

  /** Convenience: warning toast */
  warning(message, opts = {}) {
    return this.show(message, 'warning', opts);
  }

  /** Convenience: info toast */
  info(message, opts = {}) {
    return this.show(message, 'info', opts);
  }

  /**
   * Dismiss a specific toast by ID.
   * @param {string} id
   */
  dismiss(id) {
    this._startDismiss(id);
  }

  /** Dismiss all visible toasts immediately. */
  dismissAll() {
    for (const id of [...this._visible]) {
      this._startDismiss(id);
    }
    this._queue = [];
  }

  /* ── Rendering ──────────────────────────────────────────────── */

  /**
   * Create and insert a toast element.
   * @param {ToastOptions} opts
   */
  _render(opts) {
    if (!this._region) return;

    const { id, message, variant, duration } = opts;

    // ── Build element ─────────────────────────────────────────
    const toast = createElement('div', {
      className: `toast toast--${variant}`,
      role:      variant === 'error' ? 'alert' : 'status',
      'aria-live': variant === 'error' ? 'assertive' : 'polite',
      'aria-atomic': 'true',
      id,
    });

    // Icon
    toast.appendChild(createElement('span', {
      className:    'toast-icon',
      'aria-hidden': 'true',
      textContent:  ICONS[variant] ?? 'ℹ️',
    }));

    // Message
    const msgEl = createElement('span', { className: 'toast-msg' });
    setTextSafe(msgEl, message);
    toast.appendChild(msgEl);

    // Dismiss button
    const btn = createElement('button', {
      className:   'toast-dismiss',
      'aria-label': 'Dismiss notification',
      textContent: '✕',
      type:        'button',
    });
    btn.addEventListener('click', () => this._startDismiss(id));
    toast.appendChild(btn);

    // ── Hover / focus: pause auto-dismiss ─────────────────────
    toast.addEventListener('mouseenter', () => this._pauseTimer(id));
    toast.addEventListener('mouseleave', () => this._resumeTimer(id));
    toast.addEventListener('focusin',    () => this._pauseTimer(id));
    toast.addEventListener('focusout',   () => this._resumeTimer(id));

    // ── Insert (newest at bottom in column-reverse region) ────
    this._region.appendChild(toast);
    this._visible.add(id);

    // ── Start auto-dismiss timer ──────────────────────────────
    if (duration > 0) {
      const timerId = setTimeout(() => this._startDismiss(id), duration);
      this._timers.set(id, {
        timerId,
        remaining: duration,
        start:     Date.now(),
      });
    }
  }

  /* ── Dismiss animation ──────────────────────────────────────── */

  /**
   * Start the dismiss animation, then remove the element.
   * @param {string} id
   */
  _startDismiss(id) {
    const el = document.getElementById(id);
    if (!el) {
      this._cleanup(id);
      return;
    }

    // Clear any pending timer
    const timerInfo = this._timers.get(id);
    if (timerInfo) {
      clearTimeout(timerInfo.timerId);
      this._timers.delete(id);
    }

    // Apply out animation
    el.classList.add('toast--out');

    setTimeout(() => {
      el.remove();
      this._cleanup(id);
      this._drainQueue();
    }, ANIM_OUT_MS);
  }

  /**
   * Remove tracking data for a toast.
   * @param {string} id
   */
  _cleanup(id) {
    this._visible.delete(id);
    this._timers.delete(id);
  }

  /* ── Timer pause / resume ───────────────────────────────────── */

  /**
   * Pause auto-dismiss when user hovers or focuses.
   * @param {string} id
   */
  _pauseTimer(id) {
    const info = this._timers.get(id);
    if (!info) return;
    clearTimeout(info.timerId);
    info.remaining -= Date.now() - info.start;
    info.timerId    = -1;
  }

  /**
   * Resume auto-dismiss after hover/focus ends.
   * @param {string} id
   */
  _resumeTimer(id) {
    const info = this._timers.get(id);
    if (!info || info.timerId !== -1) return;
    if (info.remaining <= 0) {
      this._startDismiss(id);
      return;
    }
    info.start   = Date.now();
    info.timerId = setTimeout(() => this._startDismiss(id), info.remaining);
  }

  /* ── Queue drain ─────────────────────────────────────────────── */

  /**
   * Show the next queued toast if we're below MAX_VISIBLE.
   */
  _drainQueue() {
    while (this._queue.length > 0 && this._visible.size < MAX_VISIBLE) {
      const next = this._queue.shift();
      this._render(next);
    }
  }
}


/* ═══════════════════════════════════════════════════════════════
   3. SINGLETON EXPORT
   ═══════════════════════════════════════════════════════════════ */

/** The single shared toast manager instance. */
export const toast = new ToastManager();

/**
 * Initialise the toast system.
 * Call once after DOMContentLoaded.
 */
export function initToast() {
  toast.init();
}


/* ═══════════════════════════════════════════════════════════════
   4. SHORTHAND EXPORTS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Show a success toast.
 * @param {string} message
 * @param {object} [opts]
 */
export function toastSuccess(message, opts) {
  return toast.success(message, opts);
}

/**
 * Show an error toast.
 * @param {string} message
 * @param {object} [opts]
 */
export function toastError(message, opts) {
  return toast.error(message, opts);
}

/**
 * Show a warning toast.
 * @param {string} message
 * @param {object} [opts]
 */
export function toastWarning(message, opts) {
  return toast.warning(message, opts);
}

/**
 * Show an info toast.
 * @param {string} message
 * @param {object} [opts]
 */
export function toastInfo(message, opts) {
  return toast.info(message, opts);
}


/* ═══════════════════════════════════════════════════════════════
   5. TYPE DEFINITIONS (JSDoc)
   ═══════════════════════════════════════════════════════════════ */

/**
 * @typedef {'success'|'info'|'warning'|'error'} ToastVariant
 */

/**
 * @typedef {Object} ToastOptions
 * @property {string}       id
 * @property {string}       message
 * @property {ToastVariant} variant
 * @property {number}       duration  ms before auto-dismiss (0 = manual only)
 */
