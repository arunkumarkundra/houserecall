/**
 * HouseRecall — js/search.js
 * Live search engine with debouncing, accent-insensitive matching,
 * highlight segments, keyboard navigation, and result rendering.
 *
 * Architecture:
 *  - SearchEngine class: pure search logic, no DOM
 *  - SearchUI class: wires the engine to the DOM, handles keyboard nav
 *  - init() factory: creates and wires both, returns a controller
 */

'use strict';

import { searchItems } from './storage.js';
import {
  byId,
  show,
  hide,
  clearChildren,
  createElement,
  debounce,
  highlightSegments,
  setTextSafe,
} from './utils.js';


/* ═══════════════════════════════════════════════════════════════
   1. CONSTANTS
   ═══════════════════════════════════════════════════════════════ */

const MIN_QUERY_LENGTH  = 1;    // start searching after 1 char
const MAX_RESULTS       = 12;   // max results shown in dropdown
const DEBOUNCE_MS       = 220;  // wait after typing before firing
const RESULT_ITEM_CLASS = 'search-result-item';


/* ═══════════════════════════════════════════════════════════════
   2. SEARCH ENGINE (pure logic, no DOM)
   ═══════════════════════════════════════════════════════════════ */

export class SearchEngine {
  constructor() {
    /** @type {string} */
    this._lastQuery = '';
    /** @type {SearchResult[]} */
    this._lastResults = [];
  }

  /**
   * Run a search and return enriched results.
   * Skips the database if query is identical to last (cache).
   *
   * @param {string} query
   * @returns {Promise<SearchResult[]>}
   */
  async search(query) {
    const q = (query ?? '').trim();

    if (q.length < MIN_QUERY_LENGTH) {
      this._lastQuery   = '';
      this._lastResults = [];
      return [];
    }

    // Simple cache — avoids redundant IDB calls for same query
    if (q === this._lastQuery) {
      return this._lastResults;
    }

    const raw     = await searchItems(q);
    const results = raw.slice(0, MAX_RESULTS);

    this._lastQuery   = q;
    this._lastResults = results;

    return results;
  }

  /** Clear the result cache (call after any data mutation). */
  invalidate() {
    this._lastQuery   = '';
    this._lastResults = [];
  }

  /** Get the last query string. */
  get lastQuery() { return this._lastQuery; }
}


/* ═══════════════════════════════════════════════════════════════
   3. RESULT ROW BUILDER (DOM — no innerHTML)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Build a single search result <li> element.
 * All text is set via textContent — never innerHTML.
 *
 * @param {SearchResult} result
 * @param {string}       query   — original query for highlight
 * @param {number}       index   — for aria-setsize / aria-posinset
 * @param {number}       total
 * @returns {HTMLLIElement}
 */
function buildResultRow(result, query, index, total) {
  const { item, path, matchInNote } = result;

  const li = createElement('li', {
    className:      RESULT_ITEM_CLASS,
    role:           'option',
    tabindex:       '-1',
    'data-item-id': item.id,
    'aria-selected': 'false',
    'aria-posinset': String(index + 1),
    'aria-setsize':  String(total),
  });

  // ── Icon (star or box) ──────────────────────────────────────
  const icon = createElement('span', {
    className:    'search-result-icon',
    'aria-hidden': 'true',
    textContent:  item.starred ? '⭐' : '📦',
  });

  // ── Text column ─────────────────────────────────────────────
  const textCol = createElement('div', { className: 'search-result-text' });

  // Name with highlight
  const nameEl = createElement('div', { className: 'search-result-name' });
  _appendHighlighted(nameEl, item.name, query);
  textCol.appendChild(nameEl);

  // Location path
  const pathEl = createElement('div', {
    className:   'search-result-path',
    textContent: path,
  });
  textCol.appendChild(pathEl);

  // Note snippet (if match was in note)
  if (matchInNote && item.note) {
    const noteEl = createElement('div', { className: 'search-result-note' });
    const preview = _noteSnippet(item.note, query, 80);
    _appendHighlighted(noteEl, preview, query);
    textCol.appendChild(noteEl);
  }

  // ── Arrow hint ───────────────────────────────────────────────
  const arrow = createElement('span', {
    className:    'search-result-arrow',
    'aria-hidden': 'true',
    textContent:  '›',
  });

  li.appendChild(icon);
  li.appendChild(textCol);
  li.appendChild(arrow);

  return li;
}

/**
 * Append highlighted text segments to a parent element.
 * Uses only textContent / createTextNode — no innerHTML.
 *
 * @param {HTMLElement} parent
 * @param {string}      text
 * @param {string}      query
 */
function _appendHighlighted(parent, text, query) {
  const segments = highlightSegments(text, query);
  for (const seg of segments) {
    if (seg.highlight) {
      const mark = document.createElement('mark');
      mark.textContent = seg.text;
      parent.appendChild(mark);
    } else {
      parent.appendChild(document.createTextNode(seg.text));
    }
  }
}

/**
 * Extract a short snippet of a note centred around the query match.
 *
 * @param {string} note
 * @param {string} query
 * @param {number} maxLen
 * @returns {string}
 */
function _noteSnippet(note, query, maxLen = 80) {
  const lower = note.toLowerCase();
  const idx   = lower.indexOf(query.toLowerCase());
  if (idx === -1) return note.slice(0, maxLen) + (note.length > maxLen ? '…' : '');

  const half  = Math.floor(maxLen / 2);
  const start = Math.max(0, idx - half);
  const end   = Math.min(note.length, start + maxLen);
  const snippet = note.slice(start, end);
  return (start > 0 ? '…' : '') + snippet + (end < note.length ? '…' : '');
}

/**
 * Build the "no results" element.
 * @param {string} query
 * @returns {HTMLDivElement}
 */
function buildNoResults(query) {
  const div = createElement('div', { className: 'search-no-results' });

  const emoji = createElement('div', {
    className:    'no-results-emoji',
    'aria-hidden': 'true',
    textContent:  '🔎',
  });

  const msg = createElement('p');
  msg.appendChild(document.createTextNode('Nothing found for "'));
  const strong = createElement('strong');
  setTextSafe(strong, query);
  msg.appendChild(strong);
  msg.appendChild(document.createTextNode('"'));
  div.appendChild(emoji);
  div.appendChild(msg);

  const hint = createElement('p', {
    textContent: 'Try a different word, or check the spelling 🤔',
  });
  div.appendChild(hint);

  return div;
}


/* ═══════════════════════════════════════════════════════════════
   4. SEARCH UI (DOM wiring + keyboard navigation)
   ═══════════════════════════════════════════════════════════════ */

export class SearchUI {
  /**
   * @param {{
   *   engine:     SearchEngine,
   *   inputEl:    HTMLInputElement,
   *   resultsEl:  HTMLElement,
   *   clearBtnEl: HTMLButtonElement,
   *   onSelect:   function(SearchResult): void,
   *   onClear?:   function(): void,
   * }} opts
   */
  constructor({ engine, inputEl, resultsEl, clearBtnEl, onSelect, onClear }) {
    this._engine     = engine;
    this._inputEl    = inputEl;
    this._resultsEl  = resultsEl;
    this._clearBtnEl = clearBtnEl;
    this._onSelect   = onSelect;
    this._onClear    = onClear ?? (() => {});

    /** @type {SearchResult[]} */
    this._results    = [];
    /** @type {number} -1 = none */
    this._activeIdx  = -1;

    this._debouncedSearch = debounce(this._runSearch.bind(this), DEBOUNCE_MS);
    this._bind();
  }

  /* ── Event binding ─────────────────────────────────────────── */

  _bind() {
    // Input: typing
    this._inputEl.addEventListener('input', (e) => {
      const q = e.target.value;
      this._toggleClear(q.length > 0);
      if (q.trim().length < MIN_QUERY_LENGTH) {
        this._closeResults();
        return;
      }
      this._debouncedSearch(q);
    });

    // Input: keyboard navigation
    this._inputEl.addEventListener('keydown', (e) => {
      this._handleInputKeydown(e);
    });

    // Clear button
    this._clearBtnEl.addEventListener('click', () => {
      this.clear();
      this._onClear();
    });

    // Click on result rows (delegated)
    this._resultsEl.addEventListener('click', (e) => {
      const row = e.target.closest(`.${RESULT_ITEM_CLASS}`);
      if (row) {
        const idx = this._getRowIndex(row);
        if (idx !== -1) this._select(idx);
      }
    });

    // Keyboard on result rows
    this._resultsEl.addEventListener('keydown', (e) => {
      this._handleResultsKeydown(e);
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (
        !this._inputEl.contains(e.target) &&
        !this._resultsEl.contains(e.target)
      ) {
        this._closeResults();
      }
    });

    // Close on Escape (handled in _handleInputKeydown too)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this._resultsEl.hasAttribute('hidden')) {
        this._closeResults();
        this._inputEl.focus();
      }
    });
  }

  /* ── Input keyboard handler ────────────────────────────────── */

  _handleInputKeydown(e) {
    if (this._resultsEl.hasAttribute('hidden')) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this._moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this._moveActive(-1);
        break;
      case 'Enter':
        if (this._activeIdx >= 0) {
          e.preventDefault();
          this._select(this._activeIdx);
        }
        break;
      case 'Escape':
        this._closeResults();
        break;
      case 'Tab':
        this._closeResults();
        break;
    }
  }

  /* ── Results keyboard handler ──────────────────────────────── */

  _handleResultsKeydown(e) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this._moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (this._activeIdx <= 0) {
          // Move focus back to input
          this._setActive(-1);
          this._inputEl.focus();
        } else {
          this._moveActive(-1);
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (this._activeIdx >= 0) this._select(this._activeIdx);
        break;
      case 'Escape':
        this._closeResults();
        this._inputEl.focus();
        break;
      case 'Tab':
        this._closeResults();
        break;
    }
  }

  /* ── Core search runner ────────────────────────────────────── */

  async _runSearch(query) {
    // Show loading state
    this._showLoading();

    try {
      const results = await this._engine.search(query);
      this._results   = results;
      this._activeIdx = -1;
      this._renderResults(query);
    } catch (err) {
      console.error('[HouseRecall Search]', err);
      this._showError();
    }
  }

  /* ── Render ────────────────────────────────────────────────── */

  _renderResults(query) {
    clearChildren(this._resultsEl);
    this._activeIdx = -1;

    if (this._results.length === 0) {
      this._resultsEl.appendChild(buildNoResults(query));
      this._openResults();
      return;
    }

    const frag = document.createDocumentFragment();
    this._results.forEach((result, i) => {
      frag.appendChild(buildResultRow(result, query, i, this._results.length));
    });
    this._resultsEl.appendChild(frag);
    this._openResults();
  }

  _showLoading() {
    clearChildren(this._resultsEl);
    const div = createElement('div', {
      className:   'search-no-results',
      textContent: '🔍 Searching your house…',
    });
    this._resultsEl.appendChild(div);
    this._openResults();
  }

  _showError() {
    clearChildren(this._resultsEl);
    const div = createElement('div', {
      className:   'search-no-results',
      textContent: '😬 Search hit a snag — try again?',
    });
    this._resultsEl.appendChild(div);
    this._openResults();
  }

  /* ── Active item management ────────────────────────────────── */

  _moveActive(delta) {
    const max = this._results.length - 1;
    if (max < 0) return;
    const next = Math.max(0, Math.min(max, this._activeIdx + delta));
    this._setActive(next);
    this._focusRow(next);
  }

  _setActive(idx) {
    // Clear previous
    const rows = this._getRows();
    rows.forEach(row => {
      row.setAttribute('aria-selected', 'false');
      row.classList.remove('is-active');
    });

    this._activeIdx = idx;

    if (idx >= 0 && rows[idx]) {
      rows[idx].setAttribute('aria-selected', 'true');
      rows[idx].classList.add('is-active');
    }

    // Update input aria-activedescendant
    if (idx >= 0 && rows[idx]?.id) {
      this._inputEl.setAttribute('aria-activedescendant', rows[idx].id);
    } else {
      this._inputEl.removeAttribute('aria-activedescendant');
    }
  }

  _focusRow(idx) {
    const rows = this._getRows();
    if (rows[idx]) {
      rows[idx].focus();
    }
  }

  _getRows() {
    return Array.from(this._resultsEl.querySelectorAll(`.${RESULT_ITEM_CLASS}`));
  }

  _getRowIndex(rowEl) {
    return this._getRows().indexOf(rowEl);
  }

  /* ── Selection ─────────────────────────────────────────────── */

  _select(idx) {
    const result = this._results[idx];
    if (!result) return;
    this.clear();
    this._onSelect(result);
  }

  /* ── Open / close dropdown ─────────────────────────────────── */

  _openResults() {
    show(this._resultsEl);
    this._inputEl.setAttribute('aria-expanded', 'true');
  }

  _closeResults() {
    hide(this._resultsEl);
    this._inputEl.setAttribute('aria-expanded', 'false');
    this._inputEl.removeAttribute('aria-activedescendant');
    this._activeIdx = -1;
  }

  /* ── Clear ─────────────────────────────────────────────────── */

  _toggleClear(visible) {
    if (visible) {
      show(this._clearBtnEl);
    } else {
      hide(this._clearBtnEl);
    }
  }

  /**
   * Clear the search input and close results.
   * Public — called externally after navigation.
   */
  clear() {
    this._inputEl.value = '';
    this._toggleClear(false);
    this._closeResults();
    clearChildren(this._resultsEl);
    this._results   = [];
    this._activeIdx = -1;
    this._engine.invalidate();
  }

  /**
   * Invalidate the search cache — call after any data mutation.
   * Public.
   */
  invalidate() {
    this._engine.invalidate();
  }

  /**
   * Re-focus the search input.
   * Public.
   */
  focus() {
    this._inputEl.focus();
  }
}


/* ═══════════════════════════════════════════════════════════════
   5. FACTORY — init()
   ═══════════════════════════════════════════════════════════════ */

/**
 * Initialise the search system and wire it to the DOM.
 *
 * @param {{
 *   onSelect:  function(SearchResult): void,
 *   onClear?:  function(): void,
 * }} callbacks
 * @returns {{ engine: SearchEngine, ui: SearchUI } | null}
 *   Returns null if required DOM elements are missing.
 */
export function initSearch({ onSelect, onClear }) {
  const inputEl    = byId('search-input');
  const resultsEl  = byId('search-results');
  const clearBtnEl = byId('btn-search-clear');

  if (!inputEl || !resultsEl || !clearBtnEl) {
    console.warn('[HouseRecall] Search DOM elements not found — skipping search init.');
    return null;
  }

  const engine = new SearchEngine();
  const ui     = new SearchUI({
    engine,
    inputEl,
    resultsEl,
    clearBtnEl,
    onSelect,
    onClear,
  });

  return { engine, ui };
}
