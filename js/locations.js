/**
 * HouseRecall — js/locations.js
 * Business-logic layer for locations.
 * Sits between the UI (ui.js / app.js) and the storage layer (storage.js).
 *
 * Responsibilities:
 *  - Validate & sanitise inputs before they reach storage
 *  - Enforce business rules (no circular parents, no duplicate sibling names,
 *    max nesting depth, etc.)
 *  - Enrich raw location records with computed fields (childCount,
 *    itemCount, path, depth, hasChildren)
 *  - Expose a clean API the UI can call without worrying about IDB details
 */

'use strict';

import {
  getAllLocations,
  getLocation,
  getChildLocations,
  createLocation   as _createLocation,
  updateLocation   as _updateLocation,
  deleteLocation   as _deleteLocation,
  reorderLocations as _reorderLocations,
  getLocationPath  as _getLocationPath,
  getAllItems,
} from './storage.js';

import {
  isValidId,
  sanitiseAndTrim,
  isNonEmpty,
  sortByOrder,
} from './utils.js';

/* ═══════════════════════════════════════════════════════════════
   1. CONSTANTS
   ═══════════════════════════════════════════════════════════════ */

/** Maximum nesting depth (root = 0, child = 1, …). */
export const MAX_DEPTH = 5;

/** Maximum locations allowed in the entire house. */
export const MAX_LOCATIONS = 500;


/* ═══════════════════════════════════════════════════════════════
   2. ADD LOCATION
   ═══════════════════════════════════════════════════════════════ */

/**
 * Add a new location after validation.
 *
 * @param {{
 *   name:      string,
 *   parentId?: string | null,
 *   emoji?:    string,
 * }} data
 * @returns {Promise<{ ok: true, location: Location } | { ok: false, error: string }>}
 */
export async function addLocation(data) {
  // name
  const name = sanitiseAndTrim(data.name ?? '', 100);
  if (!isNonEmpty(name)) {
    return { ok: false, error: 'Every spot needs a name — even "That Drawer" works! 😄' };
  }

  // parent
  const parentId = (data.parentId && isValidId(data.parentId)) ? data.parentId : null;

  if (parentId) {
    const parent = await getLocation(parentId);
    if (!parent) {
      return { ok: false, error: 'Parent location not found — did it get deleted? 🤔' };
    }
  }

  // depth guard
  const depth = await getLocationDepth(parentId);
  if (depth >= MAX_DEPTH) {
    return {
      ok: false,
      error: `Whoa, that's nested ${MAX_DEPTH} levels deep! Time to simplify 😅`,
    };
  }

  // total count guard
  const all = await getAllLocations();
  if (all.length >= MAX_LOCATIONS) {
    return {
      ok: false,
      error: `You've hit the ${MAX_LOCATIONS}-location limit — you must have a big house! 🏰`,
    };
  }

  // duplicate sibling name
  const siblings = await getChildLocations(parentId);
  const duplicate = siblings.find(
    s => s.name.toLowerCase().trim() === name.toLowerCase()
  );
  if (duplicate) {
    return {
      ok: false,
      error: `There's already a "${duplicate.name}" here — maybe try a more specific name? 🏷️`,
    };
  }

  // emoji
  const emoji = sanitiseAndTrim(data.emoji ?? '📍', 8) || '📍';

  try {
    const location = await _createLocation({ name, parentId, emoji });
    return { ok: true, location };
  } catch (err) {
    return { ok: false, error: err.message ?? 'Something went wrong saving that location 😬' };
  }
}


/* ═══════════════════════════════════════════════════════════════
   3. EDIT LOCATION
   ═══════════════════════════════════════════════════════════════ */

/**
 * Edit an existing location.
 *
 * @param {string} id
 * @param {{
 *   name?:     string,
 *   parentId?: string | null,
 *   emoji?:    string,
 * }} updates
 * @returns {Promise<{ ok: true, location: Location } | { ok: false, error: string }>}
 */
export async function editLocation(id, updates) {
  if (!isValidId(id)) {
    return { ok: false, error: "Invalid location ID — that's odd 🤔" };
  }

  const existing = await getLocation(id);
  if (!existing) {
    return { ok: false, error: 'Location not found — maybe it was already deleted? 🗑️' };
  }

  const patch = {};

  // name
  if (updates.name !== undefined) {
    const name = sanitiseAndTrim(updates.name, 100);
    if (!isNonEmpty(name)) {
      return { ok: false, error: "Name can't be empty — give it something! 😄" };
    }

    const parentId = 'parentId' in updates
      ? (updates.parentId ?? null)
      : existing.parentId;

    const siblings = await getChildLocations(parentId);
    const duplicate = siblings.find(
      s => s.id !== id && s.name.toLowerCase().trim() === name.toLowerCase()
    );
    if (duplicate) {
      return {
        ok: false,
        error: `A "${duplicate.name}" already lives here — try a different name 🏷️`,
      };
    }

    patch.name = name;
  }

  // emoji
  if (updates.emoji !== undefined) {
    patch.emoji = sanitiseAndTrim(updates.emoji, 8) || '📍';
  }

  // parent (move location)
  if ('parentId' in updates) {
    const newParentId = (updates.parentId && isValidId(updates.parentId))
      ? updates.parentId
      : null;

    if (newParentId === id) {
      return { ok: false, error: "A location can't be inside itself — that's a paradox! 🌀" };
    }

    if (newParentId) {
      const isCircular = await isDescendant(id, newParentId);
      if (isCircular) {
        return {
          ok: false,
          error: 'Moving there would create a loop — like a room inside itself! 🌀',
        };
      }
    }

    const newDepth = await getLocationDepth(newParentId);
    if (newDepth >= MAX_DEPTH) {
      return {
        ok: false,
        error: `Too deep! HouseRecall supports up to ${MAX_DEPTH} nesting levels 📦`,
      };
    }

    patch.parentId = newParentId;
  }

  try {
    const location = await _updateLocation(id, patch);
    return { ok: true, location };
  } catch (err) {
    return { ok: false, error: err.message ?? 'Something went wrong updating that location 😬' };
  }
}


/* ═══════════════════════════════════════════════════════════════
   4. DELETE LOCATION
   ═══════════════════════════════════════════════════════════════ */

/**
 * Delete a location (and all descendants + their items).
 *
 * @param {string} id
 * @returns {Promise<{
 *   ok: true,
 *   deletedLocations: number,
 *   deletedItems: number,
 * } | { ok: false, error: string }>}
 */
export async function removeLocation(id) {
  if (!isValidId(id)) {
    return { ok: false, error: 'Invalid location ID 🤔' };
  }

  const existing = await getLocation(id);
  if (!existing) {
    return { ok: false, error: "Location not found — maybe it's already gone? 👻" };
  }

  try {
    const result = await _deleteLocation(id);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message ?? "Couldn't delete that location 😬" };
  }
}


/* ═══════════════════════════════════════════════════════════════
   5. REORDER LOCATIONS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Persist a new drag-and-drop order for sibling locations.
 *
 * @param {string[]} orderedIds
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function reorderSiblings(orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.some(id => !isValidId(id))) {
    return { ok: false, error: 'Invalid location order data 🤔' };
  }
  try {
    await _reorderLocations(orderedIds);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message ?? "Couldn't save the new order 😬" };
  }
}


/* ═══════════════════════════════════════════════════════════════
   6. ENRICHED LOCATION TREE
   ═══════════════════════════════════════════════════════════════ */

/**
 * Get all locations enriched with computed fields:
 *   depth, childCount, itemCount, totalItems, hasChildren, path
 *
 * @returns {Promise<EnrichedLocation[]>}
 */
export async function getEnrichedLocations() {
  const [rawLocations, allItems] = await Promise.all([
    getAllLocations(),
    getAllItems(),
  ]);

  const locMap     = new Map(rawLocations.map(l => [l.id, l]));
  const childMap   = new Map();
  const itemCounts = new Map();

  for (const loc of rawLocations) {
    const pid = loc.parentId ?? '__root__';
    if (!childMap.has(pid)) childMap.set(pid, []);
    childMap.get(pid).push(loc);
  }

  for (const item of allItems) {
    const lid = item.locationId;
    itemCounts.set(lid, (itemCounts.get(lid) ?? 0) + 1);
  }

  function totalItemsUnder(locId) {
    const direct   = itemCounts.get(locId) ?? 0;
    const children = childMap.get(locId) ?? [];
    return direct + children.reduce((sum, c) => sum + totalItemsUnder(c.id), 0);
  }

  function buildPath(parentId) {
    const path = [];
    let current = parentId ? locMap.get(parentId) : null;
    while (current) {
      path.unshift({ id: current.id, name: current.name, emoji: current.emoji ?? '📍' });
      current = current.parentId ? locMap.get(current.parentId) : null;
    }
    return path;
  }

  function computeDepth(parentId) {
    let depth = 0;
    let current = parentId ? locMap.get(parentId) : null;
    while (current) {
      depth++;
      current = current.parentId ? locMap.get(current.parentId) : null;
    }
    return depth;
  }

  return rawLocations.map(loc => ({
    ...loc,
    depth:       computeDepth(loc.parentId),
    childCount:  (childMap.get(loc.id) ?? []).length,
    itemCount:   itemCounts.get(loc.id) ?? 0,
    totalItems:  totalItemsUnder(loc.id),
    hasChildren: (childMap.get(loc.id) ?? []).length > 0,
    path:        buildPath(loc.parentId),
  }));
}

/**
 * Get enriched children of a specific parent (or top-level).
 *
 * @param {string|null} parentId
 * @returns {Promise<EnrichedLocation[]>}
 */
export async function getEnrichedChildren(parentId = null) {
  const all = await getEnrichedLocations();
  return sortByOrder(all.filter(l => l.parentId === parentId));
}

/**
 * Get a single enriched location by ID.
 *
 * @param {string} id
 * @returns {Promise<EnrichedLocation | null>}
 */
export async function getEnrichedLocation(id) {
  if (!isValidId(id)) return null;
  const all = await getEnrichedLocations();
  return all.find(l => l.id === id) ?? null;
}


/* ═══════════════════════════════════════════════════════════════
   7. LOCATIONS FOR SELECT DROPDOWNS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Build a flat list of locations suitable for select options,
 * indented by depth to show hierarchy.
 * Optionally exclude a subtree (used when editing a location).
 *
 * @param {string|null} [excludeSubtreeId]
 * @returns {Promise<Array<{ value: string, label: string, depth: number }>>}
 */
export async function getLocationsForSelect(excludeSubtreeId = null) {
  const all    = await getAllLocations();

  const excluded = new Set();
  if (excludeSubtreeId && isValidId(excludeSubtreeId)) {
    _collectSubtree(all, excludeSubtreeId, excluded);
    excluded.add(excludeSubtreeId);
  }

  const result = [];

  function visit(parentId, depth) {
    const children = sortByOrder(all.filter(l => l.parentId === parentId));
    for (const loc of children) {
      if (excluded.has(loc.id)) continue;
      const indent = '\u3000'.repeat(depth);
      result.push({
        value: loc.id,
        label: `${indent}${loc.emoji ?? '📍'} ${loc.name}`,
        depth,
      });
      visit(loc.id, depth + 1);
    }
  }

  visit(null, 0);
  return result;
}


/* ═══════════════════════════════════════════════════════════════
   8. UTILITY / GUARD FUNCTIONS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Compute the depth of a location (0 = root level).
 * @param {string|null} parentId
 * @returns {Promise<number>}
 */
export async function getLocationDepth(parentId) {
  if (!parentId) return 0;
  const all    = await getAllLocations();
  const locMap = new Map(all.map(l => [l.id, l]));
  let depth    = 0;
  let current  = locMap.get(parentId);
  while (current) {
    depth++;
    current = current.parentId ? locMap.get(current.parentId) : null;
    if (depth > MAX_DEPTH + 2) break;
  }
  return depth;
}

/**
 * Check whether candidateId is a descendant of ancestorId.
 *
 * @param {string} ancestorId
 * @param {string} candidateId
 * @returns {Promise<boolean>}
 */
export async function isDescendant(ancestorId, candidateId) {
  if (!isValidId(ancestorId) || !isValidId(candidateId)) return false;
  if (ancestorId === candidateId) return true;

  const all    = await getAllLocations();
  const locMap = new Map(all.map(l => [l.id, l]));

  let current = locMap.get(candidateId);
  const visited = new Set();

  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    if (current.parentId === ancestorId) return true;
    current = current.parentId ? locMap.get(current.parentId) : null;
  }

  return false;
}

/**
 * Get the breadcrumb path for a location.
 *
 * @param {string} locationId
 * @returns {Promise<Array<{id:string, name:string, emoji:string}>>}
 */
export async function getLocationBreadcrumb(locationId) {
  if (!isValidId(locationId)) return [];
  return _getLocationPath(locationId);
}

/**
 * Collect all descendant IDs into a Set.
 * @param {Location[]} all
 * @param {string}     rootId
 * @param {Set<string>} into
 */
function _collectSubtree(all, rootId, into) {
  const children = all.filter(l => l.parentId === rootId);
  for (const child of children) {
    if (!into.has(child.id)) {
      into.add(child.id);
      _collectSubtree(all, child.id, into);
    }
  }
}

/**
 * Count total items and locations in a subtree.
 * Useful for delete-confirmation messages.
 *
 * @param {string} locationId
 * @returns {Promise<{ locations: number, items: number }>}
 */
export async function getSubtreeCounts(locationId) {
  if (!isValidId(locationId)) return { locations: 0, items: 0 };

  const all        = await getAllLocations();
  const subtreeIds = new Set([locationId]);
  _collectSubtree(all, locationId, subtreeIds);

  const allItems = await getAllItems();
  const items    = allItems.filter(i => subtreeIds.has(i.locationId)).length;

  return { locations: subtreeIds.size, items };
}


/* ═══════════════════════════════════════════════════════════════
   9. TYPE DEFINITIONS (JSDoc)
   ═══════════════════════════════════════════════════════════════ */

/**
 * @typedef {Object} EnrichedLocation
 * @property {string}   id
 * @property {string}   name
 * @property {string|null} parentId
 * @property {string}   emoji
 * @property {number}   order
 * @property {number}   createdAt
 * @property {number}   updatedAt
 * @property {number}   depth
 * @property {number}   childCount
 * @property {number}   itemCount
 * @property {number}   totalItems
 * @property {boolean}  hasChildren
 * @property {Array<{id:string, name:string, emoji:string}>} path
 */
