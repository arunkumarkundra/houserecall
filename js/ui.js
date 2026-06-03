/**
 * HouseRecall — js/ui.js
 * All render functions, drag-and-drop, star animations,
 * note reveal, breadcrumb, empty-state, and confetti.
 *
 * This module owns the DOM. It reads from the business-logic
 * layer (locations.js / items.js) and writes to the DOM.
 * It fires callbacks for mutations — never calls storage directly.
 */

'use strict';

import {
  byId, qs, qsa, createElement, clearChildren,
  show, hide, toggle, setTextSafe, delegate,
  pluralise, truncate, isActivationKey,
} from './utils.js';

import { getEnrichedChildren, getLocationBreadcrumb } from './locations.js';
import { getItemsForLocation, getStarredEnrichedItems } from './items.js';
import { getStats } from './storage.js';


/* ═══════════════════════════════════════════════════════════════
   1. STATE
   ═══════════════════════════════════════════════════════════════ */

/** Currently viewed location ID (null = root). */
let _currentLocationId = null;

/**
 * Callbacks registered by app.js.
 * @type {UICallbacks}
 */
let _cb = {};

/** Drag-and-drop state. */
const _dnd = {
  dragging:    null,   // location card element being dragged
  draggingId:  null,   // its location ID
  overId:      null,   // location ID of card being dragged over
};


/* ═══════════════════════════════════════════════════════════════
   2. INIT
   ═══════════════════════════════════════════════════════════════ */

/**
 * Initialise the UI layer.
 * Wires all delegated event listeners on static containers.
 *
 * @param {UICallbacks} callbacks
 */
export function initUI(callbacks) {
  _cb = callbacks;
  _bindStaticListeners();
}

/**
 * Full re-render of the current view.
 * Call this after any data mutation.
 */
export async function renderAll() {
  await Promise.all([
    renderLocationGrid(),
    renderItemsList(),
    renderStarredSection(),
    renderBreadcrumb(),
    renderTotalCount(),
  ]);
}


/* ═══════════════════════════════════════════════════════════════
   3. LOCATION GRID
   ═══════════════════════════════════════════════════════════════ */

/**
 * Render the location cards grid for the current parent.
 */
export async function renderLocationGrid() {
  const grid = byId('locations-grid');
  if (!grid) return;

  const children = await getEnrichedChildren(_currentLocationId);
  clearChildren(grid);

  if (children.length === 0 && _currentLocationId === null) {
    _showEmptyState(true);
    return;
  }
  _showEmptyState(false);

  const frag = document.createDocumentFragment();
  children.forEach((loc, idx) => {
    frag.appendChild(_buildLocationCard(loc, idx));
  });
  grid.appendChild(frag);

  // Re-bind drag-and-drop after render
  _bindDragAndDrop(grid);
}

/**
 * Build a single location card element.
 * @param {EnrichedLocation} loc
 * @param {number} idx
 * @returns {HTMLElement}
 */
function _buildLocationCard(loc, idx) {
  const card = createElement('div', {
    className:       'location-card',
    role:            'listitem',
    draggable:       'true',
    'data-loc-id':   loc.id,
    'data-order':    String(loc.order),
    tabindex:        '0',
    'aria-label':    `${loc.emoji} ${loc.name}, ${pluralise(loc.totalItems, 'item')}`,
    style:           `animation-delay: ${idx * 40}ms`,
  });

  // Drag handle
  const handle = createElement('span', {
    className:    'drag-handle',
    'aria-hidden': 'true',
    textContent:  '⠿',
    title:        'Drag to reorder',
  });
  card.appendChild(handle);

  // Action buttons (edit / delete) — top-right
  const actions = createElement('div', { className: 'location-actions' });

  const editBtn = createElement('button', {
    className:    'icon-btn',
    type:         'button',
    'aria-label': `Edit ${loc.name}`,
    title:        'Edit',
    textContent:  '✏️',
    'data-action': 'edit-location',
    'data-loc-id': loc.id,
  });

  const deleteBtn = createElement('button', {
    className:    'icon-btn icon-btn--danger',
    type:         'button',
    'aria-label': `Delete ${loc.name}`,
    title:        'Delete',
    textContent:  '🗑️',
    'data-action': 'delete-location',
    'data-loc-id': loc.id,
  });

  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);
  card.appendChild(actions);

  // Emoji
  card.appendChild(createElement('span', {
    className:    'location-emoji',
    'aria-hidden': 'true',
    textContent:  loc.emoji ?? '📍',
  }));

  // Name
  const nameEl = createElement('div', { className: 'location-name' });
  setTextSafe(nameEl, loc.name);
  card.appendChild(nameEl);

  // Meta row — item count badge + child count
  const meta = createElement('div', { className: 'location-meta' });

  if (loc.totalItems > 0) {
    const badge = createElement('span', {
      className: 'location-badge',
      textContent: pluralise(loc.totalItems, 'item'),
    });
    meta.appendChild(badge);
  }

  if (loc.hasChildren) {
    const childBadge = createElement('span', {
      className:   'location-badge',
      textContent: pluralise(loc.childCount, 'sub-room'),
    });
    meta.appendChild(childBadge);
  }

  card.appendChild(meta);

  // Click to navigate into this location
  card.addEventListener('click', (e) => {
    // Don't navigate if clicking action buttons
    if (e.target.closest('[data-action]')) return;
    navigateTo(loc.id);
  });

  // Keyboard: Enter/Space to navigate
  card.addEventListener('keydown', (e) => {
    if (e.target.closest('[data-action]')) return;
    if (isActivationKey(e)) {
      e.preventDefault();
      navigateTo(loc.id);
    }
  });

  return card;
}


/* ═══════════════════════════════════════════════════════════════
   4. ITEMS LIST
   ═══════════════════════════════════════════════════════════════ */

/**
 * Render items for the currently viewed location.
 * Only shown when viewing a specific location (not root).
 */
export async function renderItemsList() {
  const list = byId('items-list');
  if (!list) return;

  if (_currentLocationId === null) {
    clearChildren(list);
    return;
  }

  const items = await getItemsForLocation(_currentLocationId);
  clearChildren(list);

  if (items.length === 0) return;

  const frag = document.createDocumentFragment();
  items.forEach((item, idx) => {
    frag.appendChild(_buildItemCard(item, idx));
  });
  list.appendChild(frag);
}

/**
 * Build a single item card element.
 * @param {EnrichedItem} item
 * @param {number} idx
 * @returns {HTMLElement}
 */
function _buildItemCard(item, idx) {
  const card = createElement('div', {
    className:        'item-card',
    role:             'listitem',
    'data-item-id':   item.id,
    style:            `animation-delay: ${idx * 30}ms`,
  });

  // ── Star button ─────────────────────────────────────────────
  const starBtn = createElement('button', {
    className:    'item-star-btn',
    type:         'button',
    'aria-label': item.starred ? `Unstar ${item.name}` : `Star ${item.name}`,
    'aria-pressed': String(item.starred),
    'data-action':  'toggle-star',
    'data-item-id': item.id,
    textContent:    item.starred ? '⭐' : '☆',
    title:          item.starred ? 'Remove from favourites' : 'Add to favourites',
  });
  card.appendChild(starBtn);

  // ── Content ─────────────────────────────────────────────────
  const content = createElement('div', { className: 'item-content' });

  const nameEl = createElement('div', { className: 'item-name' });
  setTextSafe(nameEl, item.name);
  content.appendChild(nameEl);

  // Note reveal
  if (item.hasNote) {
    const noteWrap = createElement('div', { className: 'item-note-wrap' });

    const noteBtn = createElement('button', {
      className:     'item-note-btn',
      type:          'button',
      'aria-label':  `Show details for ${item.name}`,
      'aria-expanded': 'false',
      'data-action': 'toggle-note',
      'data-item-id': item.id,
    });
    noteBtn.appendChild(createElement('span', { 'aria-hidden': 'true', textContent: 'ℹ️' }));
    noteBtn.appendChild(document.createTextNode(' Details'));
    noteWrap.appendChild(noteBtn);

    // Hidden note text (revealed on click)
    const noteText = createElement('span', {
      className: 'item-note-text',
      id:        `note-${item.id}`,
    });
    noteText.setAttribute('hidden', '');
    setTextSafe(noteText, item.note);
    noteWrap.appendChild(noteText);

    content.appendChild(noteWrap);
  }

  card.appendChild(content);

  // ── Action buttons ───────────────────────────────────────────
  const actions = createElement('div', { className: 'item-actions' });

  const editBtn = createElement('button', {
    className:    'icon-btn',
    type:         'button',
    'aria-label': `Edit ${item.name}`,
    title:        'Edit item',
    textContent:  '✏️',
    'data-action': 'edit-item',
    'data-item-id': item.id,
  });

  const deleteBtn = createElement('button', {
    className:    'icon-btn icon-btn--danger',
    type:         'button',
    'aria-label': `Delete ${item.name}`,
    title:        'Delete item',
    textContent:  '🗑️',
    'data-action': 'delete-item',
    'data-item-id': item.id,
  });

  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);
  card.appendChild(actions);

  return card;
}


/* ═══════════════════════════════════════════════════════════════
   5. STARRED SECTION
   ═══════════════════════════════════════════════════════════════ */

/**
 * Render the starred items section.
 * Shows/hides the whole section based on whether there are starred items.
 */
export async function renderStarredSection() {
  const section = byId('starred-section');
  const list    = byId('starred-list');
  if (!section || !list) return;

  const starred = await getStarredEnrichedItems();
  clearChildren(list);

  if (starred.length === 0) {
    hide(section);
    return;
  }

  show(section);

  const frag = document.createDocumentFragment();
  starred.forEach((item, idx) => {
    frag.appendChild(_buildStarredRow(item, idx));
  });
  list.appendChild(frag);
}

/**
 * Build a starred item row.
 * @param {EnrichedItem} item
 * @param {number} idx
 * @returns {HTMLElement}
 */
function _buildStarredRow(item, idx) {
  const row = createElement('div', {
    className:      'starred-item',
    role:           'listitem',
    tabindex:       '0',
    'data-item-id': item.id,
    'aria-label':   `${item.name}, stored in ${item.pathStr}`,
    style:          `animation-delay: ${idx * 30}ms`,
  });

  // Star icon
  row.appendChild(createElement('span', {
    className:    'starred-item-icon',
    'aria-hidden': 'true',
    textContent:  '⭐',
  }));

  // Item name
  const nameEl = createElement('span', { className: 'starred-item-name' });
  setTextSafe(nameEl, item.name);
  row.appendChild(nameEl);

  // Location path
  const pathEl = createElement('span', { className: 'starred-item-path' });
  setTextSafe(pathEl, item.pathStr);
  row.appendChild(pathEl);

  // Click: navigate to the item's location
  row.addEventListener('click', () => {
    if (item.locationId) navigateTo(item.locationId);
  });
  row.addEventListener('keydown', (e) => {
    if (isActivationKey(e)) {
      e.preventDefault();
      if (item.locationId) navigateTo(item.locationId);
    }
  });

  return row;
}


/* ═══════════════════════════════════════════════════════════════
   6. BREADCRUMB
   ═══════════════════════════════════════════════════════════════ */

/**
 * Render the breadcrumb trail for the current location.
 */
export async function renderBreadcrumb() {
  const nav  = byId('breadcrumb');
  const list = byId('breadcrumb-list');
  if (!nav || !list) return;

  if (_currentLocationId === null) {
    hide(nav);
    clearChildren(list);
    return;
  }

  const path = await getLocationBreadcrumb(_currentLocationId);
  clearChildren(list);
  show(nav);

  // Home crumb
  const homeLi = createElement('li');
  const homeBtn = createElement('button', {
    className:    'breadcrumb-btn',
    type:         'button',
    'aria-label': 'Go to home (all rooms)',
    textContent:  '🏠 Home',
    'data-nav':   'root',
  });
  homeBtn.addEventListener('click', () => navigateTo(null));
  homeLi.appendChild(homeBtn);
  list.appendChild(homeLi);

  // Path crumbs
  path.forEach((crumb, i) => {
    const li  = createElement('li');
    const btn = createElement('button', {
      className: 'breadcrumb-btn',
      type:      'button',
    });

    if (crumb.emoji) {
      btn.appendChild(createElement('span', {
        'aria-hidden': 'true',
        textContent:   crumb.emoji + ' ',
      }));
    }
    btn.appendChild(document.createTextNode(crumb.name));

    const isLast = i === path.length - 1;
    if (isLast) {
      btn.setAttribute('aria-current', 'page');
    } else {
      btn.addEventListener('click', () => navigateTo(crumb.id));
    }

    li.appendChild(btn);
    list.appendChild(li);
  });
}


/* ═══════════════════════════════════════════════════════════════
   7. TOTAL COUNT
   ═══════════════════════════════════════════════════════════════ */

/**
 * Update the item count badge in the section header.
 */
export async function renderTotalCount() {
  const el = byId('total-count');
  if (!el) return;
  const stats = await getStats();
  if (stats.items === 0) {
    el.textContent = '';
  } else {
    el.textContent = `${pluralise(stats.items, 'item')} across ${pluralise(stats.locations, 'room')}`;
  }
}


/* ═══════════════════════════════════════════════════════════════
   8. NAVIGATION
   ═══════════════════════════════════════════════════════════════ */

/**
 * Navigate into a location (or back to root).
 * Updates state and re-renders grid + breadcrumb + items.
 *
 * @param {string|null} locationId
 */
export async function navigateTo(locationId) {
  _currentLocationId = locationId ?? null;
  await Promise.all([
    renderLocationGrid(),
    renderItemsList(),
    renderBreadcrumb(),
    renderTotalCount(),
  ]);
  // Scroll to top of browse section
  const browseSection = qs('.browse-section');
  if (browseSection) {
    browseSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/**
 * Get the currently viewed location ID.
 * @returns {string|null}
 */
export function getCurrentLocationId() {
  return _currentLocationId;
}


/* ═══════════════════════════════════════════════════════════════
   9. EMPTY STATE
   ═══════════════════════════════════════════════════════════════ */

function _showEmptyState(visible) {
  const emptyState    = byId('empty-state');
  const locationsGrid = byId('locations-grid');
  const itemsList     = byId('items-list');
  toggle(emptyState,    visible);
  toggle(locationsGrid, !visible);
  toggle(itemsList,     !visible);
}


/* ═══════════════════════════════════════════════════════════════
   10. DRAG AND DROP
   ═══════════════════════════════════════════════════════════════ */

/**
 * Bind drag-and-drop listeners to location cards in the grid.
 * Reorders siblings visually; persists via callback.
 * @param {HTMLElement} grid
 */
function _bindDragAndDrop(grid) {
  // Use event delegation on the grid
  grid.addEventListener('dragstart', _onDragStart);
  grid.addEventListener('dragover',  _onDragOver);
  grid.addEventListener('dragleave', _onDragLeave);
  grid.addEventListener('drop',      _onDrop);
  grid.addEventListener('dragend',   _onDragEnd);
}

function _onDragStart(e) {
  const card = e.target.closest('.location-card');
  if (!card) return;
  _dnd.dragging   = card;
  _dnd.draggingId = card.getAttribute('data-loc-id');
  card.classList.add('location-card--dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', _dnd.draggingId);
}

function _onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const card = e.target.closest('.location-card');
  if (!card || card === _dnd.dragging) return;

  const overId = card.getAttribute('data-loc-id');
  if (overId === _dnd.overId) return;

  // Clear previous highlight
  _clearDragOver();
  _dnd.overId = overId;
  card.classList.add('location-card--drag-over');
}

function _onDragLeave(e) {
  // Only clear if leaving the grid entirely
  const card = e.target.closest('.location-card');
  if (!card) _clearDragOver();
}

function _onDrop(e) {
  e.preventDefault();
  const target = e.target.closest('.location-card');
  if (!target || !_dnd.dragging || target === _dnd.dragging) {
    _onDragEnd();
    return;
  }

  const grid  = target.closest('.locations-grid');
  if (!grid) { _onDragEnd(); return; }

  const fromId = _dnd.draggingId;
  const toId   = target.getAttribute('data-loc-id');

  // Re-order in the DOM
  const cards  = Array.from(grid.querySelectorAll('.location-card'));
  const fromEl = _dnd.dragging;
  const toEl   = target;

  const fromIdx = cards.indexOf(fromEl);
  const toIdx   = cards.indexOf(toEl);

  if (fromIdx < toIdx) {
    toEl.after(fromEl);
  } else {
    toEl.before(fromEl);
  }

  // Build new ordered IDs
  const newOrder = Array.from(grid.querySelectorAll('.location-card'))
    .map(c => c.getAttribute('data-loc-id'));

  // Persist via callback
  if (_cb.onReorderLocations) {
    _cb.onReorderLocations(newOrder);
  }

  _onDragEnd();
}

function _onDragEnd() {
  if (_dnd.dragging) {
    _dnd.dragging.classList.remove('location-card--dragging');
  }
  _clearDragOver();
  _dnd.dragging   = null;
  _dnd.draggingId = null;
}

function _clearDragOver() {
  qsa('.location-card--drag-over').forEach(el => {
    el.classList.remove('location-card--drag-over');
  });
  _dnd.overId = null;
}


/* ═══════════════════════════════════════════════════════════════
   11. STATIC EVENT DELEGATION
   ═══════════════════════════════════════════════════════════════ */

/**
 * Wire delegated listeners on static containers.
 * Called once from initUI().
 */
function _bindStaticListeners() {
  // ── Location grid actions ──────────────────────────────────
  delegate(document, 'click', '[data-action="edit-location"]', (e, btn) => {
    e.stopPropagation();
    const id = btn.getAttribute('data-loc-id');
    if (id && _cb.onEditLocation) _cb.onEditLocation(id, btn);
  });

  delegate(document, 'click', '[data-action="delete-location"]', (e, btn) => {
    e.stopPropagation();
    const id = btn.getAttribute('data-loc-id');
    if (id && _cb.onDeleteLocation) _cb.onDeleteLocation(id, btn);
  });

  // ── Item list actions ──────────────────────────────────────
  delegate(document, 'click', '[data-action="toggle-star"]', (e, btn) => {
    const id = btn.getAttribute('data-item-id');
    if (id && _cb.onToggleStar) {
      _animateStar(btn);
      _cb.onToggleStar(id, btn);
    }
  });

  delegate(document, 'click', '[data-action="toggle-note"]', (e, btn) => {
    const id      = btn.getAttribute('data-item-id');
    const noteEl  = byId(`note-${id}`);
    if (!noteEl) return;

    const isOpen = !noteEl.hasAttribute('hidden');
    if (isOpen) {
      noteEl.setAttribute('hidden', '');
      btn.setAttribute('aria-expanded', 'false');
    } else {
      noteEl.removeAttribute('hidden');
      btn.setAttribute('aria-expanded', 'true');
    }
  });

  delegate(document, 'click', '[data-action="edit-item"]', (e, btn) => {
    const id = btn.getAttribute('data-item-id');
    if (id && _cb.onEditItem) _cb.onEditItem(id, btn);
  });

  delegate(document, 'click', '[data-action="delete-item"]', (e, btn) => {
    const id = btn.getAttribute('data-item-id');
    if (id && _cb.onDeleteItem) _cb.onDeleteItem(id, btn);
  });
}


/* ═══════════════════════════════════════════════════════════════
   12. STAR ANIMATION
   ═══════════════════════════════════════════════════════════════ */

/**
 * Play the star-pop animation on a star button.
 * Updates the visual state immediately (optimistic UI).
 * @param {HTMLElement} btn
 */
function _animateStar(btn) {
  btn.classList.remove('star-animate');
  // Force reflow to restart animation
  void btn.offsetWidth;
  btn.classList.add('star-animate');
  btn.addEventListener('animationend', () => {
    btn.classList.remove('star-animate');
  }, { once: true });
}

/**
 * Update a single star button's visual state after toggle.
 * Called by app.js after the storage mutation resolves.
 *
 * @param {string}  itemId
 * @param {boolean} starred
 */
export function updateStarButton(itemId, starred) {
  const btn = qs(`[data-action="toggle-star"][data-item-id="${CSS.escape(itemId)}"]`);
  if (!btn) return;
  btn.textContent            = starred ? '⭐' : '☆';
  btn.setAttribute('aria-pressed',  String(starred));
  btn.setAttribute('aria-label',
    starred
      ? `Unstar this item`
      : `Star this item`
  );
}


/* ═══════════════════════════════════════════════════════════════
   13. EMOJI PICKER (location modal)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Initialise the emoji picker in the location modal.
 * Wires button clicks → hidden input + preview span.
 */
export function initEmojiPicker() {
  const picker     = byId('emoji-picker');
  const hiddenInput = byId('location-emoji');
  const preview    = byId('modal-location-emoji-display');
  if (!picker || !hiddenInput) return;

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('.emoji-btn');
    if (!btn) return;

    // Deselect all
    qsa('.emoji-btn', picker).forEach(b => b.classList.remove('selected'));

    // Select clicked
    btn.classList.add('selected');
    const emoji = btn.getAttribute('data-emoji') ?? '📍';
    hiddenInput.value = emoji;
    if (preview) setTextSafe(preview, emoji);
  });
}

/**
 * Set the active emoji in the picker (for edit mode).
 * @param {string} emoji
 */
export function setPickerEmoji(emoji) {
  const picker      = byId('emoji-picker');
  const hiddenInput = byId('location-emoji');
  const preview     = byId('modal-location-emoji-display');
  if (!picker) return;

  qsa('.emoji-btn', picker).forEach(btn => {
    const match = btn.getAttribute('data-emoji') === emoji;
    btn.classList.toggle('selected', match);
  });

  if (hiddenInput) hiddenInput.value = emoji;
  if (preview)     setTextSafe(preview, emoji);
}


/* ═══════════════════════════════════════════════════════════════
   14. POPULATE LOCATION SELECTS (item / location modals)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Populate a <select> element with location options.
 *
 * @param {string} selectId
 * @param {Array<{ value: string, label: string }>} options
 * @param {string} [selectedValue]
 * @param {string} [placeholder]
 */
export function populateLocationSelect(selectId, options, selectedValue = '', placeholder = 'Pick a spot…') {
  const select = byId(selectId);
  if (!select) return;
  clearChildren(select);

  const placeholderOpt = createElement('option', {
    value:     '',
    textContent: placeholder,
  });
  select.appendChild(placeholderOpt);

  options.forEach(opt => {
    const el = createElement('option', {
      value:       opt.value,
      textContent: opt.label,
    });
    if (opt.value === selectedValue) el.selected = true;
    select.appendChild(el);
  });
}


/* ═══════════════════════════════════════════════════════════════
   15. FILE DROP ZONE
   ═══════════════════════════════════════════════════════════════ */

/**
 * Wire drag-and-drop for the import file drop zone.
 * @param {function(File): void} onFileDrop
 */
export function initFileDropZone(onFileDrop) {
  const zone = byId('file-drop-zone');
  if (!zone) return;

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    zone.classList.add('drag-active');
  });

  zone.addEventListener('dragleave', () => {
    zone.classList.remove('drag-active');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-active');
    const file = e.dataTransfer.files?.[0];
    if (file) onFileDrop(file);
  });

  // Keyboard activation for the zone
  zone.addEventListener('keydown', (e) => {
    if (isActivationKey(e)) {
      const input = zone.querySelector('input[type="file"]');
      if (input) input.click();
    }
  });
}


/* ═══════════════════════════════════════════════════════════════
   16. CONFETTI (first item delight)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Fire a confetti burst on the canvas.
 * Lightweight canvas-based confetti — no external library.
 */
export function fireConfetti() {
  const canvas = byId('confetti-canvas');
  if (!canvas) return;

  // Skip if user prefers reduced motion
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const ctx    = canvas.getContext('2d');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;

  const COLORS  = ['#c9613a', '#d4a843', '#7a9e7e', '#6b8cae', '#b89880', '#f0cc7a'];
  const PIECES  = 90;
  const GRAVITY = 0.35;
  const pieces  = [];

  for (let i = 0; i < PIECES; i++) {
    pieces.push({
      x:     Math.random() * canvas.width,
      y:     Math.random() * canvas.height * 0.4 - canvas.height * 0.2,
      w:     6 + Math.random() * 8,
      h:     10 + Math.random() * 6,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      vx:    (Math.random() - 0.5) * 6,
      vy:    Math.random() * -8 - 3,
      angle: Math.random() * Math.PI * 2,
      spin:  (Math.random() - 0.5) * 0.2,
      alpha: 1,
    });
  }

  let frame;
  let ticks = 0;
  const MAX_TICKS = 140;

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ticks++;

    for (const p of pieces) {
      p.vy    += GRAVITY;
      p.x     += p.vx;
      p.y     += p.vy;
      p.angle += p.spin;
      p.alpha  = Math.max(0, 1 - ticks / MAX_TICKS);

      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.translate(p.x + p.w / 2, p.y + p.h / 2);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }

    if (ticks < MAX_TICKS) {
      frame = requestAnimationFrame(draw);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      cancelAnimationFrame(frame);
    }
  }

  frame = requestAnimationFrame(draw);
}


/* ═══════════════════════════════════════════════════════════════
   17. BUTTON LOADING STATE
   ═══════════════════════════════════════════════════════════════ */

/**
 * Set a button into a loading state (spinner + disabled).
 * @param {string}  btnId
 * @param {string}  [loadingText]
 */
export function setBtnLoading(btnId, loadingText = 'Saving…') {
  const btn = byId(btnId);
  if (!btn) return;
  btn.setAttribute('disabled', '');
  btn.setAttribute('aria-busy', 'true');
  btn._originalHTML = btn.innerHTML;
  btn.innerHTML = '';
  const spinner = createElement('span', { className: 'spinner', 'aria-hidden': 'true' });
  btn.appendChild(spinner);
  btn.appendChild(document.createTextNode(' ' + loadingText));
}

/**
 * Restore a button from loading state.
 * @param {string} btnId
 */
export function clearBtnLoading(btnId) {
  const btn = byId(btnId);
  if (!btn) return;
  btn.removeAttribute('disabled');
  btn.removeAttribute('aria-busy');
  if (btn._originalHTML !== undefined) {
    btn.innerHTML = btn._originalHTML;
    delete btn._originalHTML;
  }
}


/* ═══════════════════════════════════════════════════════════════
   18. TYPE DEFINITIONS (JSDoc)
   ═══════════════════════════════════════════════════════════════ */

/**
 * @typedef {Object} UICallbacks
 * @property {function(string, HTMLElement): void}   onEditLocation
 * @property {function(string, HTMLElement): void}   onDeleteLocation
 * @property {function(string[]): void}              onReorderLocations
 * @property {function(string, HTMLElement): void}   onToggleStar
 * @property {function(string, HTMLElement): void}   onEditItem
 * @property {function(string, HTMLElement): void}   onDeleteItem
 */
