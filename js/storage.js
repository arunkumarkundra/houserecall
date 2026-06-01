/**
 * HouseRecall — js/storage.js
 * IndexedDB wrapper. All persistence lives here.
 * Auto-saves after every change. No manual save button needed.
 *
 * Database: "houserecall"
 * Version:  1
 * Stores:
 *   - locations  (keyPath: "id")
 *   - items      (keyPath: "id")
 */

'use strict';

import {
  generateId,
  sanitiseAndTrim,
  isValidId,
  isValidItem,
  isValidLocation,
  validateImportPayload,
  deepClone,
  sortByOrder,
} from './utils.js';

/* ═══════════════════════════════════════════════════════════════
   1. DATABASE SETUP
   ═══════════════════════════════════════════════════════════════ */

const DB_NAME    = 'houserecall';
const DB_VERSION = 1;
const STORE_LOCATIONS = 'locations';
const STORE_ITEMS     = 'items';

/** @type {IDBDatabase|null} */
let _db = null;

/**
 * Open (or upgrade) the IndexedDB database.
 * Resolves with the IDBDatabase instance.
 * Safe to call multiple times — returns cached instance.
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Create locations store
      if (!db.objectStoreNames.contains(STORE_LOCATIONS)) {
        const locStore = db.createObjectStore(STORE_LOCATIONS, { keyPath: 'id' });
        locStore.createIndex('parentId', 'parentId', { unique: false });
        locStore.createIndex('order',    'order',    { unique: false });
      }

      // Create items store
      if (!db.objectStoreNames.contains(STORE_ITEMS)) {
        const itemStore = db.createObjectStore(STORE_ITEMS, { keyPath: 'id' });
        itemStore.createIndex('locationId', 'locationId', { unique: false });
        itemStore.createIndex('starred',    'starred',    { unique: false });
        itemStore.createIndex('name',       'name',       { unique: false });
      }
    };

    req.onsuccess = (event) => {
      _db = event.target.result;

      // Handle unexpected version change / connection close
      _db.onversionchange = () => {
        _db.close();
        _db = null;
      };

      resolve(_db);
    };

    req.onerror = () => {
      reject(new Error(`Could not open HouseRecall database: ${req.error?.message}`));
    };

    req.onblocked = () => {
      reject(new Error('Database upgrade blocked — please close other HouseRecall tabs.'));
    };
  });
}

/**
 * Low-level helper: run a transaction and return a promise.
 * @param {string[]} storeNames
 * @param {'readonly'|'readwrite'} mode
 * @param {function(IDBTransaction): Promise<any>} work
 * @returns {Promise<any>}
 */
async function withTransaction(storeNames, mode, work) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(new Error('Transaction aborted'));
    work(tx).then(resolve).catch(err => { tx.abort(); reject(err); });
  });
}

/**
 * Wrap an IDBRequest in a Promise.
 * @param {IDBRequest} req
 * @returns {Promise<any>}
 */
function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}


/* ═══════════════════════════════════════════════════════════════
   2. LOCATION CRUD
   ═══════════════════════════════════════════════════════════════ */

/**
 * Get all locations, sorted by their order field.
 * @returns {Promise<Location[]>}
 */
export async function getAllLocations() {
  return withTransaction([STORE_LOCATIONS], 'readonly', async (tx) => {
    const store = tx.objectStore(STORE_LOCATIONS);
    const all = await promisifyRequest(store.getAll());
    return sortByOrder(all);
  });
}

/**
 * Get a single location by ID.
 * @param {string} id
 * @returns {Promise<Location|undefined>}
 */
export async function getLocation(id) {
  if (!isValidId(id)) return undefined;
  return withTransaction([STORE_LOCATIONS], 'readonly', async (tx) => {
    return promisifyRequest(tx.objectStore(STORE_LOCATIONS).get(id));
  });
}

/**
 * Get all direct children of a location (or top-level if parentId is null).
 * @param {string|null} parentId
 * @returns {Promise<Location[]>}
 */
export async function getChildLocations(parentId = null) {
  return withTransaction([STORE_LOCATIONS], 'readonly', async (tx) => {
    const store = tx.objectStore(STORE_LOCATIONS);
    const index = store.index('parentId');
    const key   = parentId ?? null;
    const all   = await promisifyRequest(index.getAll(key));
    return sortByOrder(all);
  });
}

/**
 * Create a new location.
 * @param {{ name: string, parentId?: string|null, emoji?: string }} data
 * @returns {Promise<Location>}
 */
export async function createLocation(data) {
  const name = sanitiseAndTrim(data.name, 100);
  if (!name) throw new Error('Location name cannot be empty 🤔');

  // Calculate next order value among siblings
  const siblings = await getChildLocations(data.parentId ?? null);
  const maxOrder = siblings.reduce((m, s) => Math.max(m, s.order ?? 0), -1);

  /** @type {Location} */
  const location = {
    id:        generateId(),
    name,
    parentId:  (data.parentId && isValidId(data.parentId)) ? data.parentId : null,
    emoji:     sanitiseAndTrim(data.emoji ?? '📍', 8),
    order:     maxOrder + 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await withTransaction([STORE_LOCATIONS], 'readwrite', async (tx) => {
    return promisifyRequest(tx.objectStore(STORE_LOCATIONS).add(location));
  });

  return location;
}

/**
 * Update an existing location.
 * @param {string} id
 * @param {{ name?: string, parentId?: string|null, emoji?: string, order?: number }} updates
 * @returns {Promise<Location>}
 */
export async function updateLocation(id, updates) {
  if (!isValidId(id)) throw new Error('Invalid location ID');

  return withTransaction([STORE_LOCATIONS], 'readwrite', async (tx) => {
    const store    = tx.objectStore(STORE_LOCATIONS);
    const existing = await promisifyRequest(store.get(id));
    if (!existing) throw new Error('Location not found — it may have already been deleted.');

    const updated = {
      ...existing,
      updatedAt: Date.now(),
    };

    if (updates.name !== undefined) {
      const name = sanitiseAndTrim(updates.name, 100);
      if (!name) throw new Error('Location name cannot be empty 🤔');
      updated.name = name;
    }
    if (updates.emoji !== undefined) {
      updated.emoji = sanitiseAndTrim(updates.emoji, 8);
    }
    if ('parentId' in updates) {
      updated.parentId = (updates.parentId && isValidId(updates.parentId))
        ? updates.parentId
        : null;
    }
    if (updates.order !== undefined) {
      updated.order = Number(updates.order);
    }

    await promisifyRequest(store.put(updated));
    return updated;
  });
}

/**
 * Delete a location and ALL its descendants (recursive),
 * and all items stored in any of those locations.
 * @param {string} id
 * @returns {Promise<{ deletedLocations: number, deletedItems: number }>}
 */
export async function deleteLocation(id) {
  if (!isValidId(id)) throw new Error('Invalid location ID');

  // Collect all descendant IDs (breadth-first)
  const allLocations  = await getAllLocations();
  const toDelete      = collectDescendants(allLocations, id);
  toDelete.add(id);

  let deletedItems = 0;

  await withTransaction([STORE_LOCATIONS, STORE_ITEMS], 'readwrite', async (tx) => {
    const locStore  = tx.objectStore(STORE_LOCATIONS);
    const itemStore = tx.objectStore(STORE_ITEMS);
    const locIndex  = itemStore.index('locationId');

    // Delete items in each affected location
    for (const locId of toDelete) {
      const items = await promisifyRequest(locIndex.getAll(locId));
      for (const item of items) {
        await promisifyRequest(itemStore.delete(item.id));
        deletedItems++;
      }
      await promisifyRequest(locStore.delete(locId));
    }
  });

  return { deletedLocations: toDelete.size, deletedItems };
}

/**
 * Reorder locations within the same parent.
 * @param {string[]} orderedIds — array of location IDs in the new order
 * @returns {Promise<void>}
 */
export async function reorderLocations(orderedIds) {
  await withTransaction([STORE_LOCATIONS], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_LOCATIONS);
    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      if (!isValidId(id)) continue;
      const loc = await promisifyRequest(store.get(id));
      if (loc) {
        loc.order     = i;
        loc.updatedAt = Date.now();
        await promisifyRequest(store.put(loc));
      }
    }
  });
}

/**
 * Build a breadcrumb path array for a location.
 * Returns [ { id, name, emoji }, ... ] from root → location.
 * @param {string} locationId
 * @returns {Promise<Array<{id:string, name:string, emoji:string}>>}
 */
export async function getLocationPath(locationId) {
  const allLocations = await getAllLocations();
  const map          = new Map(allLocations.map(l => [l.id, l]));
  const path         = [];
  let   current      = map.get(locationId);

  while (current) {
    path.unshift({ id: current.id, name: current.name, emoji: current.emoji ?? '📍' });
    current = current.parentId ? map.get(current.parentId) : null;
  }

  return path;
}

/**
 * Collect all descendant location IDs (recursive BFS).
 * @param {Location[]} allLocations
 * @param {string} rootId
 * @returns {Set<string>}
 */
function collectDescendants(allLocations, rootId) {
  const result  = new Set();
  const queue   = [rootId];
  const byParent = new Map();

  for (const loc of allLocations) {
    const pid = loc.parentId ?? '__root__';
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(loc.id);
  }

  while (queue.length) {
    const current  = queue.shift();
    const children = byParent.get(current) ?? [];
    for (const childId of children) {
      if (!result.has(childId)) {
        result.add(childId);
        queue.push(childId);
      }
    }
  }

  return result;
}


/* ═══════════════════════════════════════════════════════════════
   3. ITEM CRUD
   ═══════════════════════════════════════════════════════════════ */

/**
 * Get all items.
 * @returns {Promise<Item[]>}
 */
export async function getAllItems() {
  return withTransaction([STORE_ITEMS], 'readonly', async (tx) => {
    return promisifyRequest(tx.objectStore(STORE_ITEMS).getAll());
  });
}

/**
 * Get a single item by ID.
 * @param {string} id
 * @returns {Promise<Item|undefined>}
 */
export async function getItem(id) {
  if (!isValidId(id)) return undefined;
  return withTransaction([STORE_ITEMS], 'readonly', async (tx) => {
    return promisifyRequest(tx.objectStore(STORE_ITEMS).get(id));
  });
}

/**
 * Get all items stored in a specific location.
 * @param {string} locationId
 * @returns {Promise<Item[]>}
 */
export async function getItemsByLocation(locationId) {
  if (!isValidId(locationId)) return [];
  return withTransaction([STORE_ITEMS], 'readonly', async (tx) => {
    const index = tx.objectStore(STORE_ITEMS).index('locationId');
    return promisifyRequest(index.getAll(locationId));
  });
}

/**
 * Get all starred items.
 * @returns {Promise<Item[]>}
 */
export async function getStarredItems() {
  return withTransaction([STORE_ITEMS], 'readonly', async (tx) => {
    const index = tx.objectStore(STORE_ITEMS).index('starred');
    return promisifyRequest(index.getAll(1)); // IDBIndex stores booleans as 0/1
  });
}

/**
 * Create a new item.
 * @param {{ name: string, locationId: string, note?: string, starred?: boolean }} data
 * @returns {Promise<Item>}
 */
export async function createItem(data) {
  const name = sanitiseAndTrim(data.name, 200);
  if (!name) throw new Error('Item name cannot be empty 🤔');
  if (!isValidId(data.locationId)) throw new Error('Please choose a valid location 📍');

  /** @type {Item} */
  const item = {
    id:         generateId(),
    name,
    locationId: data.locationId,
    note:       sanitiseAndTrim(data.note ?? '', 500),
    starred:    data.starred === true ? 1 : 0, // stored as 0/1 for IDB index
    createdAt:  Date.now(),
    updatedAt:  Date.now(),
  };

  await withTransaction([STORE_ITEMS], 'readwrite', async (tx) => {
    return promisifyRequest(tx.objectStore(STORE_ITEMS).add(item));
  });

  // Return with boolean starred for app consumption
  return { ...item, starred: item.starred === 1 };
}

/**
 * Update an existing item.
 * @param {string} id
 * @param {{ name?: string, locationId?: string, note?: string, starred?: boolean }} updates
 * @returns {Promise<Item>}
 */
export async function updateItem(id, updates) {
  if (!isValidId(id)) throw new Error('Invalid item ID');

  return withTransaction([STORE_ITEMS], 'readwrite', async (tx) => {
    const store    = tx.objectStore(STORE_ITEMS);
    const existing = await promisifyRequest(store.get(id));
    if (!existing) throw new Error('Item not found — it may have already been deleted.');

    const updated = {
      ...existing,
      updatedAt: Date.now(),
    };

    if (updates.name !== undefined) {
      const name = sanitiseAndTrim(updates.name, 200);
      if (!name) throw new Error('Item name cannot be empty 🤔');
      updated.name = name;
    }
    if (updates.locationId !== undefined) {
      if (!isValidId(updates.locationId)) throw new Error('Please choose a valid location 📍');
      updated.locationId = updates.locationId;
    }
    if (updates.note !== undefined) {
      updated.note = sanitiseAndTrim(updates.note, 500);
    }
    if (updates.starred !== undefined) {
      updated.starred = updates.starred ? 1 : 0;
    }

    await promisifyRequest(store.put(updated));
    return { ...updated, starred: updated.starred === 1 };
  });
}

/**
 * Toggle the starred status of an item.
 * @param {string} id
 * @returns {Promise<Item>}
 */
export async function toggleStarItem(id) {
  const item = await getItem(id);
  if (!item) throw new Error('Item not found 🤷');
  return updateItem(id, { starred: !item.starred });
}

/**
 * Delete a single item.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteItem(id) {
  if (!isValidId(id)) throw new Error('Invalid item ID');
  await withTransaction([STORE_ITEMS], 'readwrite', async (tx) => {
    return promisifyRequest(tx.objectStore(STORE_ITEMS).delete(id));
  });
}


/* ═══════════════════════════════════════════════════════════════
   4. SEARCH
   ═══════════════════════════════════════════════════════════════ */

/**
 * Search items by name (and optionally note).
 * Returns results enriched with their location path string.
 * @param {string} query
 * @returns {Promise<SearchResult[]>}
 */
export async function searchItems(query) {
  if (!query || !query.trim()) return [];

  const [items, locations] = await Promise.all([getAllItems(), getAllLocations()]);
  const locMap = new Map(locations.map(l => [l.id, l]));

  const q      = query.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const results = [];

  for (const item of items) {
    const nameNorm = item.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const noteNorm = (item.note ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (!nameNorm.includes(q) && !noteNorm.includes(q)) continue;

    // Build readable path
    const path = buildLocationPath(item.locationId, locMap);

    results.push({
      item: { ...item, starred: item.starred === 1 },
      path,
      matchInName: nameNorm.includes(q),
      matchInNote: noteNorm.includes(q),
    });
  }

  // Sort: name matches first, then alphabetical
  results.sort((a, b) => {
    if (a.matchInName && !b.matchInName) return -1;
    if (!a.matchInName && b.matchInName)  return  1;
    return a.item.name.localeCompare(b.item.name);
  });

  return results;
}

/**
 * Build a human-readable path string for a location.
 * e.g. "Bedroom › Wardrobe › Top Shelf"
 * @param {string|null} locationId
 * @param {Map<string, Location>} locMap
 * @returns {string}
 */
function buildLocationPath(locationId, locMap) {
  if (!locationId) return 'Somewhere in the house 🤔';
  const parts = [];
  let current = locMap.get(locationId);
  while (current) {
    parts.unshift(current.name);
    current = current.parentId ? locMap.get(current.parentId) : null;
  }
  return parts.join(' › ') || 'Unknown location';
}


/* ═══════════════════════════════════════════════════════════════
   5. BULK EXPORT / IMPORT
   ═══════════════════════════════════════════════════════════════ */

/**
 * Export all data as a plain JS object (ready for encryption).
 * @returns {Promise<HouseData>}
 */
export async function exportData() {
  const [locations, items] = await Promise.all([getAllLocations(), getAllItems()]);
  return {
    version:   1,
    exportedAt: Date.now(),
    locations:  locations.map(deepClone),
    items:      items.map(deepClone),
  };
}

/**
 * Import data — completely replaces all existing data.
 * Validates the payload before writing.
 * @param {HouseData} data
 * @returns {Promise<{ locations: number, items: number }>}
 */
export async function importData(data) {
  const validation = validateImportPayload(data);
  if (!validation.ok) throw new Error(validation.error);

  // Normalise starred field (handle both boolean and 0/1 from different export versions)
  const locations = data.locations.map(l => ({
    ...deepClone(l),
    updatedAt: l.updatedAt ?? Date.now(),
    createdAt: l.createdAt ?? Date.now(),
    emoji:     l.emoji ?? '📍',
    order:     l.order ?? 0,
  }));

  const items = data.items.map(i => ({
    ...deepClone(i),
    updatedAt: i.updatedAt ?? Date.now(),
    createdAt: i.createdAt ?? Date.now(),
    note:      i.note ?? '',
    starred:   i.starred ? 1 : 0,
  }));

  await withTransaction([STORE_LOCATIONS, STORE_ITEMS], 'readwrite', async (tx) => {
    const locStore  = tx.objectStore(STORE_LOCATIONS);
    const itemStore = tx.objectStore(STORE_ITEMS);

    // Clear existing data
    await promisifyRequest(locStore.clear());
    await promisifyRequest(itemStore.clear());

    // Write new data
    for (const loc of locations) {
      await promisifyRequest(locStore.put(loc));
    }
    for (const item of items) {
      await promisifyRequest(itemStore.put(item));
    }
  });

  return { locations: locations.length, items: items.length };
}

/**
 * Clear ALL data from the database (nuclear option — used carefully).
 * @returns {Promise<void>}
 */
export async function clearAllData() {
  await withTransaction([STORE_LOCATIONS, STORE_ITEMS], 'readwrite', async (tx) => {
    await promisifyRequest(tx.objectStore(STORE_LOCATIONS).clear());
    await promisifyRequest(tx.objectStore(STORE_ITEMS).clear());
  });
}


/* ═══════════════════════════════════════════════════════════════
   6. STATS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Get a quick summary count of locations and items.
 * @returns {Promise<{ locations: number, items: number, starred: number }>}
 */
export async function getStats() {
  const [locations, items] = await Promise.all([getAllLocations(), getAllItems()]);
  const starred = items.filter(i => i.starred === 1 || i.starred === true).length;
  return { locations: locations.length, items: items.length, starred };
}


/* ═══════════════════════════════════════════════════════════════
   7. TYPE DEFINITIONS (JSDoc)
   ═══════════════════════════════════════════════════════════════ */

/**
 * @typedef {Object} Location
 * @property {string}      id
 * @property {string}      name
 * @property {string|null} parentId
 * @property {string}      emoji
 * @property {number}      order
 * @property {number}      createdAt
 * @property {number}      updatedAt
 */

/**
 * @typedef {Object} Item
 * @property {string}       id
 * @property {string}       name
 * @property {string}       locationId
 * @property {string}       note
 * @property {boolean|0|1}  starred
 * @property {number}       createdAt
 * @property {number}       updatedAt
 */

/**
 * @typedef {Object} HouseData
 * @property {number}     version
 * @property {number}     exportedAt
 * @property {Location[]} locations
 * @property {Item[]}     items
 */

/**
 * @typedef {Object} SearchResult
 * @property {Item}    item
 * @property {string}  path
 * @property {boolean} matchInName
 * @property {boolean} matchInNote
 */
