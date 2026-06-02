/**
 * HouseRecall — js/items.js
 * Business-logic layer for items.
 * Sits between UI and storage — validates, enriches, enforces rules.
 *
 * Responsibilities:
 *  - Validate & sanitise all inputs
 *  - Enforce business rules (max items, location must exist, etc.)
 *  - Enrich raw items with their location path string + breadcrumb
 *  - Expose a clean, friendly API to the rest of the app
 */

'use strict';

import {
  getAllItems,
  getItem          as _getItem,
  getItemsByLocation as _getItemsByLocation,
  getStarredItems  as _getStarredItems,
  createItem       as _createItem,
  updateItem       as _updateItem,
  toggleStarItem   as _toggleStarItem,
  deleteItem       as _deleteItem,
  getAllLocations,
} from './storage.js';

import {
  isValidId,
  sanitiseAndTrim,
  isNonEmpty,
  truncate,
} from './utils.js';

import { getLocation } from './storage.js';

/* ═══════════════════════════════════════════════════════════════
   1. CONSTANTS
   ═══════════════════════════════════════════════════════════════ */

/** Maximum items allowed in the entire house. */
export const MAX_ITEMS = 10_000;

/** Maximum items per location (soft warning, not hard block). */
export const ITEMS_PER_LOCATION_WARN = 200;


/* ═══════════════════════════════════════════════════════════════
   2. ADD ITEM
   ═══════════════════════════════════════════════════════════════ */

/**
 * Store a new item after full validation.
 *
 * @param {{
 *   name:        string,
 *   locationId:  string,
 *   note?:       string,
 *   starred?:    boolean,
 * }} data
 * @returns {Promise<{ ok: true, item: EnrichedItem, isFirst: boolean }
 *                 | { ok: false, error: string }>}
 */
export async function addItem(data) {
  // ── name ──────────────────────────────────────────────────────
  const name = sanitiseAndTrim(data.name ?? '', 200);
  if (!isNonEmpty(name)) {
    return { ok: false, error: "What are we storing? Give it a name! 📦" };
  }

  // ── location ──────────────────────────────────────────────────
  if (!isValidId(data.locationId)) {
    return { ok: false, error: 'Please pick a location — where did you put it? 📍' };
  }

  const location = await getLocation(data.locationId);
  if (!location) {
    return { ok: false, error: "That location doesn't exist anymore — maybe it was deleted? 🗑️" };
  }

  // ── global count guard ────────────────────────────────────────
  const allItems = await getAllItems();
  if (allItems.length >= MAX_ITEMS) {
    return {
      ok: false,
      error: `Wow, ${MAX_ITEMS.toLocaleString()} items! You've hit the limit 🏆 Time for a declutter?`,
    };
  }

  const isFirst = allItems.length === 0;

  // ── duplicate name in same location (warning only — not blocked) ──
  // We allow duplicates but could surface a warning here in future.

  // ── note ──────────────────────────────────────────────────────
  const note = sanitiseAndTrim(data.note ?? '', 500);

  // ── starred ───────────────────────────────────────────────────
  const starred = data.starred === true;

  try {
    const raw  = await _createItem({ name, locationId: data.locationId, note, starred });
    const item = await _enrichItem(raw);
    return { ok: true, item, isFirst };
  } catch (err) {
    return { ok: false, error: err.message ?? 'Something went wrong saving that item 😬' };
  }
}


/* ═══════════════════════════════════════════════════════════════
   3. EDIT ITEM
   ═══════════════════════════════════════════════════════════════ */

/**
 * Edit an existing item.
 *
 * @param {string} id
 * @param {{
 *   name?:       string,
 *   locationId?: string,
 *   note?:       string,
 *   starred?:    boolean,
 * }} updates
 * @returns {Promise<{ ok: true, item: EnrichedItem } | { ok: false, error: string }>}
 */
export async function editItem(id, updates) {
  if (!isValidId(id)) {
    return { ok: false, error: "Invalid item ID — that's odd 🤔" };
  }

  const existing = await _getItem(id);
  if (!existing) {
    return { ok: false, error: 'Item not found — maybe it was already deleted? 🗑️' };
  }

  const patch = {};

  // ── name ──────────────────────────────────────────────────────
  if (updates.name !== undefined) {
    const name = sanitiseAndTrim(updates.name, 200);
    if (!isNonEmpty(name)) {
      return { ok: false, error: "Name can't be empty — everything needs a label! 🏷️" };
    }
    patch.name = name;
  }

  // ── location ──────────────────────────────────────────────────
  if (updates.locationId !== undefined) {
    if (!isValidId(updates.locationId)) {
      return { ok: false, error: 'Please pick a valid location 📍' };
    }
    const location = await getLocation(updates.locationId);
    if (!location) {
      return { ok: false, error: "That location doesn't exist — maybe it was deleted? 🗑️" };
    }
    patch.locationId = updates.locationId;
  }

  // ── note ──────────────────────────────────────────────────────
  if (updates.note !== undefined) {
    patch.note = sanitiseAndTrim(updates.note, 500);
  }

  // ── starred ───────────────────────────────────────────────────
  if (updates.starred !== undefined) {
    patch.starred = Boolean(updates.starred);
  }

  try {
    const raw  = await _updateItem(id, patch);
    const item = await _enrichItem(raw);
    return { ok: true, item };
  } catch (err) {
    return { ok: false, error: err.message ?? 'Something went wrong updating that item 😬' };
  }
}


/* ═══════════════════════════════════════════════════════════════
   4. DELETE ITEM
   ═══════════════════════════════════════════════════════════════ */

/**
 * Delete a single item by ID.
 *
 * @param {string} id
 * @returns {Promise<{ ok: true, name: string } | { ok: false, error: string }>}
 */
export async function removeItem(id) {
  if (!isValidId(id)) {
    return { ok: false, error: 'Invalid item ID 🤔' };
  }

  const existing = await _getItem(id);
  if (!existing) {
    return { ok: false, error: "Item not found — maybe it's already gone? 👻" };
  }

  const name = existing.name; // capture before delete

  try {
    await _deleteItem(id);
    return { ok: true, name };
  } catch (err) {
    return { ok: false, error: err.message ?? "Couldn't delete that item 😬" };
  }
}


/* ═══════════════════════════════════════════════════════════════
   5. STAR / UNSTAR
   ═══════════════════════════════════════════════════════════════ */

/**
 * Toggle the starred status of an item.
 *
 * @param {string} id
 * @returns {Promise<{ ok: true, item: EnrichedItem, starred: boolean }
 *                 | { ok: false, error: string }>}
 */
export async function toggleStar(id) {
  if (!isValidId(id)) {
    return { ok: false, error: 'Invalid item ID 🤔' };
  }

  try {
    const raw     = await _toggleStarItem(id);
    const item    = await _enrichItem(raw);
    return { ok: true, item, starred: item.starred };
  } catch (err) {
    return { ok: false, error: err.message ?? "Couldn't update star status 😬" };
  }
}


/* ═══════════════════════════════════════════════════════════════
   6. MOVE ITEM (convenience wrapper)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Move an item to a different location.
 *
 * @param {string} itemId
 * @param {string} newLocationId
 * @returns {Promise<{ ok: true, item: EnrichedItem } | { ok: false, error: string }>}
 */
export async function moveItem(itemId, newLocationId) {
  return editItem(itemId, { locationId: newLocationId });
}


/* ═══════════════════════════════════════════════════════════════
   7. FETCH HELPERS (enriched)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Get all items, enriched with location path.
 * @returns {Promise<EnrichedItem[]>}
 */
export async function getAllEnrichedItems() {
  const [items, locations] = await Promise.all([getAllItems(), getAllLocations()]);
  const locMap = new Map(locations.map(l => [l.id, l]));
  return items.map(item => _enrichItemSync(item, locMap));
}

/**
 * Get all items for a specific location, enriched.
 * @param {string} locationId
 * @returns {Promise<EnrichedItem[]>}
 */
export async function getItemsForLocation(locationId) {
  if (!isValidId(locationId)) return [];
  const [items, locations] = await Promise.all([
    _getItemsByLocation(locationId),
    getAllLocations(),
  ]);
  const locMap = new Map(locations.map(l => [l.id, l]));
  return items
    .map(item => _enrichItemSync(item, locMap))
    .sort((a, b) => {
      // Starred first, then alphabetical
      if (a.starred && !b.starred) return -1;
      if (!a.starred && b.starred) return  1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Get all starred items, enriched with location paths.
 * @returns {Promise<EnrichedItem[]>}
 */
export async function getStarredEnrichedItems() {
  const [items, locations] = await Promise.all([
    _getStarredItems(),
    getAllLocations(),
  ]);
  const locMap = new Map(locations.map(l => [l.id, l]));
  return items
    .map(item => _enrichItemSync(item, locMap))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get a single enriched item by ID.
 * @param {string} id
 * @returns {Promise<EnrichedItem | null>}
 */
export async function getEnrichedItem(id) {
  if (!isValidId(id)) return null;
  const raw = await _getItem(id);
  if (!raw) return null;
  return _enrichItem(raw);
}


/* ═══════════════════════════════════════════════════════════════
   8. ENRICHMENT HELPERS (internal)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Enrich one item — async version (loads all locations itself).
 * Used after mutations when we don't have the locMap handy.
 * @param {Item} item
 * @returns {Promise<EnrichedItem>}
 */
async function _enrichItem(item) {
  const locations = await getAllLocations();
  const locMap    = new Map(locations.map(l => [l.id, l]));
  return _enrichItemSync(item, locMap);
}

/**
 * Enrich one item synchronously given a pre-built location map.
 * @param {Item}                   item
 * @param {Map<string, Location>}  locMap
 * @returns {EnrichedItem}
 */
function _enrichItemSync(item, locMap) {
  const location = locMap.get(item.locationId) ?? null;

  // Build path array from root to location
  const pathArr  = _buildPathArray(item.locationId, locMap);
  const pathStr  = pathArr.map(p => p.name).join(' › ') || 'Unknown location';
  const pathFull = pathArr.map(p => `${p.emoji} ${p.name}`).join(' › ') || '🤔 Unknown';

  return {
    ...item,
    starred:       item.starred === 1 || item.starred === true,
    locationName:  location?.name  ?? 'Unknown location',
    locationEmoji: location?.emoji ?? '📍',
    pathStr,        // plain text path e.g. "Bedroom › Wardrobe"
    pathFull,       // emoji path e.g. "🛏️ Bedroom › 👔 Wardrobe"
    pathArr,        // array of { id, name, emoji }
    hasNote:        Boolean(item.note && item.note.trim().length > 0),
    notePreview:    truncate(item.note ?? '', 80),
  };
}

/**
 * Build the path array for a locationId.
 * @param {string|null}            locationId
 * @param {Map<string, Location>}  locMap
 * @returns {Array<{id:string, name:string, emoji:string}>}
 */
function _buildPathArray(locationId, locMap) {
  const path    = [];
  let current   = locationId ? locMap.get(locationId) : null;
  const visited = new Set();

  while (current) {
    if (visited.has(current.id)) break; // cycle guard
    visited.add(current.id);
    path.unshift({ id: current.id, name: current.name, emoji: current.emoji ?? '📍' });
    current = current.parentId ? locMap.get(current.parentId) : null;
  }

  return path;
}


/* ═══════════════════════════════════════════════════════════════
   9. SUMMARY / STATS HELPERS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Get a summary of items per location — useful for the location
 * card badges showing "5 items".
 *
 * @returns {Promise<Map<string, number>>} locationId → item count
 */
export async function getItemCountsByLocation() {
  const items  = await getAllItems();
  const counts = new Map();
  for (const item of items) {
    counts.set(item.locationId, (counts.get(item.locationId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Check whether adding one more item would exceed the per-location
 * soft warning threshold.
 *
 * @param {string} locationId
 * @returns {Promise<boolean>}
 */
export async function isLocationNearCapacity(locationId) {
  if (!isValidId(locationId)) return false;
  const items = await _getItemsByLocation(locationId);
  return items.length >= ITEMS_PER_LOCATION_WARN;
}


/* ═══════════════════════════════════════════════════════════════
   10. TYPE DEFINITIONS (JSDoc)
   ═══════════════════════════════════════════════════════════════ */

/**
 * @typedef {Object} EnrichedItem
 * @property {string}  id
 * @property {string}  name
 * @property {string}  locationId
 * @property {string}  note
 * @property {boolean} starred
 * @property {number}  createdAt
 * @property {number}  updatedAt
 * @property {string}  locationName   — display name of the location
 * @property {string}  locationEmoji  — emoji of the location
 * @property {string}  pathStr        — "Bedroom › Wardrobe › Top Shelf"
 * @property {string}  pathFull       — "🛏️ Bedroom › 👔 Wardrobe"
 * @property {Array<{id:string, name:string, emoji:string}>} pathArr
 * @property {boolean} hasNote        — true if note is non-empty
 * @property {string}  notePreview    — truncated note (80 chars)
 */
