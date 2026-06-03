/**
 * HouseRecall — js/utils.js
 * Shared utility functions: UUID, sanitisation, timestamps, helpers.
 * No dependencies. Pure ES Module.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   1. UUID
   ═══════════════════════════════════════════════════════════════ */

/**
 * Generate a cryptographically random UUID v4.
 * Uses crypto.randomUUID() where available, falls back to
 * crypto.getRandomValues() for older browsers.
 * @returns {string} UUID v4 string e.g. "a1b2c3d4-e5f6-4abc-8def-..."
 */
export function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: manual v4 UUID via getRandomValues
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Set version 4
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // Set variant bits
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}


/* ═══════════════════════════════════════════════════════════════
   2. INPUT SANITISATION
   Protection against XSS, HTML injection, SVG injection.
   Rule: never inject raw HTML — always use textContent.
   These helpers are for storing clean strings and for cases
   where we must build display strings safely.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Strip all HTML/SVG tags from a string.
 * Safe for storing in IndexedDB and displaying via textContent.
 * @param {string} str
 * @returns {string}
 */
export function sanitiseText(str) {
  if (typeof str !== 'string') return '';
  // Remove null bytes
  let s = str.replace(/\0/g, '');
  // Use a temporary div to strip tags — browser does the heavy lifting
  // This is safe because we only read .textContent, never .innerHTML
  const div = document.createElement('div');
  div.textContent = s;
  s = div.textContent;
  // Trim and collapse whitespace
  return s.trim().replace(/\s+/g, ' ');
}

/**
 * Sanitise and truncate a string to a maximum character length.
 * @param {string} str
 * @param {number} maxLength
 * @returns {string}
 */
export function sanitiseAndTrim(str, maxLength = 500) {
  return sanitiseText(str).slice(0, maxLength);
}

/**
 * Safely set the text content of a DOM element.
 * Never use innerHTML — this is the safe alternative.
 * @param {HTMLElement} el
 * @param {string} text
 */
export function setTextSafe(el, text) {
  if (el) el.textContent = typeof text === 'string' ? text : String(text ?? '');
}

/**
 * Escape a string for safe insertion into HTML attribute values
 * (used only when building attribute strings, not innerHTML).
 * @param {string} str
 * @returns {string}
 */
export function escapeAttr(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Validate that a string is a safe UUID (prevents injection via IDs).
 * @param {string} id
 * @returns {boolean}
 */
export function isValidId(id) {
  if (typeof id !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}


/* ═══════════════════════════════════════════════════════════════
   3. TIMESTAMPS & FILE NAMING
   ═══════════════════════════════════════════════════════════════ */

/**
 * Return a timestamp string formatted as YYYYMMDD-HHMM.
 * Used as a suffix on exported file names.
 * @param {Date} [date] — defaults to now
 * @returns {string} e.g. "20240615-1430"
 */
export function getTimestampSuffix(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm   = pad(date.getMonth() + 1);
  const dd   = pad(date.getDate());
  const hh   = pad(date.getHours());
  const min  = pad(date.getMinutes());
  return `${yyyy}${mm}${dd}-${hh}${min}`;
}

/**
 * Build a safe export filename.
 * e.g. "MyHome_20240615-1430.house"
 * @param {string} [baseName]
 * @returns {string}
 */
export function buildExportFilename(baseName = 'MyHome') {
  // Sanitise the base name: only allow word chars, spaces, hyphens
  const safe = baseName.replace(/[^\w\s\-]/g, '').trim() || 'MyHome';
  return `${safe}_${getTimestampSuffix()}.house`;
}


/* ═══════════════════════════════════════════════════════════════
   4. STRING HELPERS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Case-insensitive, accent-insensitive partial match.
 * Used by the search engine.
 * @param {string} haystack
 * @param {string} needle
 * @returns {boolean}
 */
export function fuzzyMatch(haystack, needle) {
  if (!needle) return true;
  const h = haystack.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const n = needle.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return h.includes(n);
}

/**
 * Highlight occurrences of `query` in `text`.
 * Returns an array of {text, highlight} segments — safe for DOM rendering
 * via textContent (no innerHTML needed).
 * @param {string} text
 * @param {string} query
 * @returns {Array<{text: string, highlight: boolean}>}
 */
export function highlightSegments(text, query) {
  if (!query || !text) return [{ text: text || '', highlight: false }];
  const segments = [];
  const lower = text.toLowerCase();
  const lowerQ = query.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(lowerQ, i);
    if (idx === -1) {
      segments.push({ text: text.slice(i), highlight: false });
      break;
    }
    if (idx > i) segments.push({ text: text.slice(i, idx), highlight: false });
    segments.push({ text: text.slice(idx, idx + query.length), highlight: true });
    i = idx + query.length;
  }
  return segments;
}

/**
 * Pluralise a word simply.
 * @param {number} count
 * @param {string} singular
 * @param {string} [plural]
 * @returns {string} e.g. "1 item" or "3 items"
 */
export function pluralise(count, singular, plural) {
  const word = count === 1 ? singular : (plural ?? singular + 's');
  return `${count} ${word}`;
}

/**
 * Truncate a string to maxLen characters, adding ellipsis if needed.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncate(str, maxLen = 60) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}


/* ═══════════════════════════════════════════════════════════════
   5. DOM HELPERS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Shorthand for document.getElementById.
 * @param {string} id
 * @returns {HTMLElement|null}
 */
export function byId(id) {
  return document.getElementById(id);
}

/**
 * Shorthand for document.querySelector.
 * @param {string} selector
 * @param {Element} [root]
 * @returns {Element|null}
 */
export function qs(selector, root = document) {
  return root.querySelector(selector);
}

/**
 * Shorthand for document.querySelectorAll → Array.
 * @param {string} selector
 * @param {Element} [root]
 * @returns {Element[]}
 */
export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/**
 * Create a DOM element with optional attributes and children.
 * All text content is set via textContent — never innerHTML.
 * @param {string} tag
 * @param {Object} [attrs]
 * @param {Array<string|Node>} [children]
 * @returns {HTMLElement}
 */
export function createElement(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (key === 'className') {
      el.className = val;
    } else if (key === 'textContent') {
      el.textContent = val;
    } else if (key.startsWith('on') && typeof val === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (val === true) {
      el.setAttribute(key, '');
    } else if (val !== false && val !== null && val !== undefined) {
      el.setAttribute(key, val);
    }
  }
  for (const child of children) {
    if (typeof child === 'string') {
      el.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      el.appendChild(child);
    }
  }
  return el;
}

/**
 * Show an element (removes hidden attribute).
 * @param {HTMLElement} el
 */
export function show(el) {
  if (el) el.removeAttribute('hidden');
}

/**
 * Hide an element (adds hidden attribute).
 * @param {HTMLElement} el
 */
export function hide(el) {
  if (el) el.setAttribute('hidden', '');
}

/**
 * Toggle an element's visibility.
 * @param {HTMLElement} el
 * @param {boolean} [visible]
 */
export function toggle(el, visible) {
  if (!el) return;
  if (visible === undefined) {
    visible = el.hasAttribute('hidden');
  }
  visible ? show(el) : hide(el);
}

/**
 * Remove all child nodes from an element.
 * @param {HTMLElement} el
 */
export function clearChildren(el) {
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * Delegate event listener — listens on a parent, fires only for
 * matching selector children. Returns a cleanup function.
 * @param {Element} parent
 * @param {string} event
 * @param {string} selector
 * @param {Function} handler
 * @returns {Function} cleanup
 */
export function delegate(parent, event, selector, handler) {
  function listener(e) {
    const target = e.target.closest(selector);
    if (target && parent.contains(target)) {
      handler(e, target);
    }
  }
  parent.addEventListener(event, listener);
  return () => parent.removeEventListener(event, listener);
}


/* ═══════════════════════════════════════════════════════════════
   6. ASYNC / TIMING HELPERS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Debounce a function — delays execution until `wait` ms after
 * the last call. Used for search input.
 * @param {Function} fn
 * @param {number} wait
 * @returns {Function}
 */
export function debounce(fn, wait = 200) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/**
 * Simple promise-based sleep.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/* ═══════════════════════════════════════════════════════════════
   7. VALIDATION HELPERS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Check if a string is non-empty after trimming.
 * @param {string} str
 * @returns {boolean}
 */
export function isNonEmpty(str) {
  return typeof str === 'string' && str.trim().length > 0;
}

/**
 * Validate an item object has the expected shape.
 * @param {unknown} item
 * @returns {boolean}
 */
export function isValidItem(item) {
  return (
    item !== null &&
    typeof item === 'object' &&
    isValidId(item.id) &&
    typeof item.name === 'string' &&
    isNonEmpty(item.name) &&
    (item.locationId === null || isValidId(item.locationId)) &&
    (item.note === undefined || typeof item.note === 'string') &&
    (item.starred === undefined || typeof item.starred === 'boolean' || item.starred === 0 || item.starred === 1)

  );
}

/**
 * Validate a location object has the expected shape.
 * @param {unknown} loc
 * @returns {boolean}
 */
export function isValidLocation(loc) {
  return (
    loc !== null &&
    typeof loc === 'object' &&
    isValidId(loc.id) &&
    typeof loc.name === 'string' &&
    isNonEmpty(loc.name) &&
    (loc.parentId === null || isValidId(loc.parentId)) &&
    (loc.emoji === undefined || typeof loc.emoji === 'string') &&
    (loc.order === undefined || typeof loc.order === 'number')
  );
}

/**
 * Validate a full data payload (for import).
 * @param {unknown} data
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateImportPayload(data) {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'That doesn\'t look like a valid .house file 🤔' };
  }
  if (!Array.isArray(data.locations)) {
    return { ok: false, error: 'Missing locations data — is this the right file?' };
  }
  if (!Array.isArray(data.items)) {
    return { ok: false, error: 'Missing items data — is this the right file?' };
  }
  for (const loc of data.locations) {
    if (!isValidLocation(loc)) {
      return { ok: false, error: 'One or more locations look corrupted. Try a different export file.' };
    }
  }
  for (const item of data.items) {
    if (!isValidItem(item)) {
      return { ok: false, error: 'One or more items look corrupted. Try a different export file.' };
    }
  }
  return { ok: true };
}


/* ═══════════════════════════════════════════════════════════════
   8. PASSWORD STRENGTH
   ═══════════════════════════════════════════════════════════════ */

/**
 * Score a password's strength.
 * @param {string} password
 * @returns {{ score: 0|1|2, label: string, cssClass: string }}
 *   score 0 = weak, 1 = fair, 2 = strong
 */
export function scorePassword(password) {
  if (!password || password.length < 6) {
    return { score: 0, label: '🙈 Too short — make it at least 8 characters', cssClass: 'strength-weak' };
  }
  let score = 0;
  if (password.length >= 10) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (score <= 1) return { score: 0, label: '😬 Weak — try mixing letters, numbers & symbols', cssClass: 'strength-weak' };
  if (score <= 2) return { score: 1, label: '😐 Fair — a bit stronger would be better', cssClass: 'strength-fair' };
  return { score: 2, label: '💪 Strong — nice work, your stuff is safe!', cssClass: 'strength-strong' };
}


/* ═══════════════════════════════════════════════════════════════
   9. ARRAY / OBJECT HELPERS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Deep-clone a JSON-serialisable value.
 * @template T
 * @param {T} val
 * @returns {T}
 */
export function deepClone(val) {
  return JSON.parse(JSON.stringify(val));
}

/**
 * Move an item in an array from one index to another (immutable).
 * Used for drag-and-drop reordering.
 * @template T
 * @param {T[]} arr
 * @param {number} fromIndex
 * @param {number} toIndex
 * @returns {T[]}
 */
export function moveInArray(arr, fromIndex, toIndex) {
  const result = [...arr];
  const [removed] = result.splice(fromIndex, 1);
  result.splice(toIndex, 0, removed);
  return result;
}

/**
 * Sort an array of objects by a numeric `order` field,
 * falling back to insertion order.
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
export function sortByOrder(arr) {
  return [...arr].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * Group an array of objects by a key.
 * @template T
 * @param {T[]} arr
 * @param {string} key
 * @returns {Object.<string, T[]>}
 */
export function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = item[key] ?? '__null__';
    (acc[k] = acc[k] || []).push(item);
    return acc;
  }, {});
}


/* ═══════════════════════════════════════════════════════════════
   10. KEYBOARD HELPERS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Check if a keyboard event is an "activation" key (Enter or Space).
 * Used to make non-button elements keyboard-accessible.
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
export function isActivationKey(e) {
  return e.key === 'Enter' || e.key === ' ';
}

/**
 * Trap focus within a container element.
 * Returns a cleanup function that removes the listener.
 * @param {HTMLElement} container
 * @returns {Function} cleanup
 */
export function trapFocus(container) {
  const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');

  function getFocusable() {
    return Array.from(container.querySelectorAll(FOCUSABLE)).filter(
      el => !el.closest('[hidden]') && getComputedStyle(el).display !== 'none'
    );
  }

  function handler(e) {
    if (e.key !== 'Tab') return;
    const focusable = getFocusable();
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}
