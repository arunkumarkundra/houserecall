/**
 * HouseRecall — js/app.js
 * Main application orchestrator.
 * Boots the app, wires all modals, handles all mutations,
 * and connects every module together.
 */

'use strict';

import { openDB }                            from './storage.js';
import { initToast, toastSuccess, toastError, toastWarning, toastInfo } from './toast.js';
import { initModals, initPasswordToggles, openModal, closeModal,
         showConfirm, setModalHeader, resetModalForm,
         showFieldError, clearAllFieldErrors }                           from './modal.js';
import { initSearch }                        from './search.js';
import { initUI, renderAll, navigateTo, getCurrentLocationId,
         initEmojiPicker, setPickerEmoji, populateLocationSelect,
         initFileDropZone, fireConfetti, setBtnLoading, clearBtnLoading,
         updateStarButton, renderStarredSection, renderTotalCount }      from './ui.js';
import { addLocation, editLocation, removeLocation,
         reorderSiblings, getSubtreeCounts,
         getLocationsForSelect }                                         from './locations.js';
import { addItem, editItem, removeItem,
         toggleStar, getEnrichedItem }                                   from './items.js';
import { encryptHouseData, decryptHouseFile,
         downloadHouseFile, readFileAsArrayBuffer,
         isEncryptionSupported, CRYPTO_INFO }                            from './encryption.js';
import { exportData, importData }            from './storage.js';
import { byId, show, hide, setTextSafe, scorePassword,
         buildExportFilename, sanitiseAndTrim, isNonEmpty }              from './utils.js';


/* ═══════════════════════════════════════════════════════════════
   1. BOOT
   ═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await _boot();
  } catch (err) {
    console.error('[HouseRecall] Boot failed:', err);
    _showFatalError(err);
  }
});

async function _boot() {
  // 1. Open IndexedDB
  await openDB();

  // 2. Init subsystems
  initToast();
  initModals();
  initPasswordToggles();
  initEmojiPicker();

  // 3. Init UI layer with mutation callbacks
  initUI({
    onEditLocation:     _handleEditLocationOpen,
    onDeleteLocation:   _handleDeleteLocation,
    onReorderLocations: _handleReorderLocations,
    onToggleStar:       _handleToggleStar,
    onEditItem:         _handleEditItemOpen,
    onDeleteItem:       _handleDeleteItem,
  });

  // 4. Wire static buttons
  _wireHeaderButtons();
  _wireItemModal();
  _wireLocationModal();
  _wireExportModal();
  _wireImportModal();

  // 5. Init search
  _initSearchSystem();

  // 6. Init file drop zone (import modal)
  initFileDropZone(_handleFileDrop);

  // 7. Initial render
  await renderAll();

  // 8. Check encryption support
  if (!isEncryptionSupported()) {
    toastWarning(
      'Your browser may not support encryption — export/import might not work.',
      { duration: 8000 }
    );
  }

  console.info('[HouseRecall] Ready 🏠', CRYPTO_INFO);
}


/* ═══════════════════════════════════════════════════════════════
   2. HEADER BUTTON WIRING
   ═══════════════════════════════════════════════════════════════ */

function _wireHeaderButtons() {
  // How It Works
  byId('btn-how-it-works')?.addEventListener('click', (e) => {
    openModal('modal-how-it-works', e.currentTarget);
  });

  // Export
  byId('btn-export')?.addEventListener('click', (e) => {
    _openExportModal(e.currentTarget);
  });

  // Import
  byId('btn-import')?.addEventListener('click', (e) => {
    _openImportModal(e.currentTarget);
  });

  // Quick action: Store Something
  byId('btn-add-item')?.addEventListener('click', (e) => {
    _openAddItemModal(e.currentTarget);
  });

  // Quick action: Add a Room
  byId('btn-add-location')?.addEventListener('click', (e) => {
    _openAddLocationModal(e.currentTarget);
  });
}


/* ═══════════════════════════════════════════════════════════════
   3. ITEM MODAL
   ═══════════════════════════════════════════════════════════════ */

function _wireItemModal() {
  byId('btn-save-item')?.addEventListener('click', _handleSaveItem);

  // Clear errors on input
  byId('item-name')?.addEventListener('input', () => {
    clearAllFieldErrors('modal-item');
  });
}

/**
 * Open the Add Item modal.
 * Pre-selects the current location if browsing one.
 * @param {HTMLElement} [triggerEl]
 */
async function _openAddItemModal(triggerEl) {
  resetModalForm('modal-item');
  clearAllFieldErrors('modal-item');

  setModalHeader('modal-item', {
    emoji:    '📦',
    title:    'Store Something',
    subtitle: 'Where did you squirrel it away?',
  });

  byId('item-id').value      = '';
  byId('btn-save-item').textContent = 'Save it! 📦';

  // Populate location select
  const options = await getLocationsForSelect();
  populateLocationSelect(
    'item-location',
    options,
    getCurrentLocationId() ?? '',
    'Pick a spot…'
  );

  openModal('modal-item', triggerEl);
  byId('item-name')?.focus();
}

/**
 * Open the Edit Item modal pre-filled with item data.
 * @param {string}      itemId
 * @param {HTMLElement} [triggerEl]
 */
async function _handleEditItemOpen(itemId, triggerEl) {
  const item = await getEnrichedItem(itemId);
  if (!item) { toastError('Couldn\'t find that item 🤔'); return; }

  resetModalForm('modal-item');
  clearAllFieldErrors('modal-item');

  setModalHeader('modal-item', {
    emoji:    '✏️',
    title:    'Edit Item',
    subtitle: 'Update the details below.',
  });

  byId('item-id').value              = item.id;
  byId('item-name').value            = item.name;
  byId('item-note').value            = item.note ?? '';
  byId('item-starred').checked       = item.starred;
  byId('btn-save-item').textContent  = 'Save changes ✏️';

  const options = await getLocationsForSelect();
  populateLocationSelect('item-location', options, item.locationId, 'Pick a spot…');

  openModal('modal-item', triggerEl);
  byId('item-name')?.focus();
}

/**
 * Save (create or update) an item.
 */
async function _handleSaveItem() {
  clearAllFieldErrors('modal-item');

  const id         = byId('item-id').value.trim();
  const name       = byId('item-name').value.trim();
  const locationId = byId('item-location').value;
  const note       = byId('item-note').value.trim();
  const starred    = byId('item-starred').checked;

  // Validate
  let hasError = false;
  if (!isNonEmpty(name)) {
    showFieldError('item-name', 'item-name-error', 'What are we storing? Give it a name! 📦');
    hasError = true;
  }
  if (!locationId) {
    showFieldError('item-location', 'item-location-error', 'Where did you put it? Pick a spot! 📍');
    hasError = true;
  }
  if (hasError) return;

  setBtnLoading('btn-save-item', 'Saving…');

  let result;
  if (id) {
    result = await editItem(id, { name, locationId, note, starred });
  } else {
    result = await addItem({ name, locationId, note, starred });
  }

  clearBtnLoading('btn-save-item');

  if (!result.ok) {
    toastError(result.error);
    return;
  }

  closeModal('modal-item');

  if (id) {
    toastSuccess(`"${sanitiseAndTrim(name, 40)}" updated! ✏️`);
  } else {
    toastSuccess(`"${sanitiseAndTrim(name, 40)}" stored! 📦`);
    // First-ever item → confetti!
    if (result.isFirst) {
      setTimeout(fireConfetti, 200);
    }
  }

  // Invalidate search cache
  _search?.ui?.invalidate();

  await renderAll();
}


/* ═══════════════════════════════════════════════════════════════
   4. LOCATION MODAL
   ═══════════════════════════════════════════════════════════════ */

function _wireLocationModal() {
  byId('btn-save-location')?.addEventListener('click', _handleSaveLocation);

  byId('location-name')?.addEventListener('input', () => {
    clearAllFieldErrors('modal-location');
  });
}

/**
 * Open the Add Location modal.
 * @param {HTMLElement} [triggerEl]
 */
async function _openAddLocationModal(triggerEl) {
  resetModalForm('modal-location');
  clearAllFieldErrors('modal-location');

  setModalHeader('modal-location', {
    emoji:    '📍',
    title:    'Add a Room or Spot',
    subtitle: 'Give it a name your future self will understand.',
  });

  byId('location-id').value                = '';
  byId('btn-save-location').textContent    = 'Add this spot! 📍';
  setPickerEmoji('📍');

  // Populate parent select — exclude nothing
  const options = await getLocationsForSelect();
  populateLocationSelect(
    'location-parent',
    options,
    getCurrentLocationId() ?? '',
    'Top level (it\'s a main room)'
  );

  openModal('modal-location', triggerEl);
  byId('location-name')?.focus();
}

/**
 * Open the Edit Location modal pre-filled.
 * @param {string}      locationId
 * @param {HTMLElement} [triggerEl]
 */
async function _handleEditLocationOpen(locationId, triggerEl) {
  const { getEnrichedLocation } = await import('./locations.js');
  const loc = await getEnrichedLocation(locationId);
  if (!loc) { toastError('Couldn\'t find that location 🤔'); return; }

  resetModalForm('modal-location');
  clearAllFieldErrors('modal-location');

  setModalHeader('modal-location', {
    emoji:    '✏️',
    title:    'Edit Location',
    subtitle: 'Rename or reorganise this spot.',
  });

  byId('location-id').value             = loc.id;
  byId('location-name').value           = loc.name;
  byId('btn-save-location').textContent = 'Save changes ✏️';
  setPickerEmoji(loc.emoji ?? '📍');

  // Exclude this location's own subtree from parent options
  const options = await getLocationsForSelect(locationId);
  populateLocationSelect(
    'location-parent',
    options,
    loc.parentId ?? '',
    'Top level (it\'s a main room)'
  );

  openModal('modal-location', triggerEl);
  byId('location-name')?.focus();
}

/**
 * Save (create or update) a location.
 */
async function _handleSaveLocation() {
  clearAllFieldErrors('modal-location');

  const id       = byId('location-id').value.trim();
  const name     = byId('location-name').value.trim();
  const parentId = byId('location-parent').value || null;
  const emoji    = byId('location-emoji').value || '📍';

  if (!isNonEmpty(name)) {
    showFieldError('location-name', 'location-name-error',
      'Every spot needs a name — even "That Drawer" works! 😄');
    return;
  }

  setBtnLoading('btn-save-location', 'Saving…');

  let result;
  if (id) {
    result = await editLocation(id, { name, parentId, emoji });
  } else {
    result = await addLocation({ name, parentId, emoji });
  }

  clearBtnLoading('btn-save-location');

  if (!result.ok) {
    showFieldError('location-name', 'location-name-error', result.error);
    return;
  }

  closeModal('modal-location');

  if (id) {
    toastSuccess(`"${sanitiseAndTrim(name, 40)}" updated! ✏️`);
  } else {
    toastSuccess(`"${sanitiseAndTrim(name, 40)}" added! 📍`);
  }

  _search?.ui?.invalidate();
  await renderAll();
}

/**
 * Handle delete-location request (with confirmation).
 * @param {string}      locationId
 * @param {HTMLElement} [triggerEl]
 */
async function _handleDeleteLocation(locationId, triggerEl) {
  const counts = await getSubtreeCounts(locationId);

  let message = 'This will permanently delete this room.';
  if (counts.locations > 1 || counts.items > 0) {
    const parts = [];
    if (counts.locations > 1) parts.push(`${counts.locations - 1} sub-room(s)`);
    if (counts.items > 0)     parts.push(`${counts.items} item(s)`);
    message = `This will permanently delete this room and everything inside it: ${parts.join(' and ')}. There's no undo!`;
  }

  const confirmed = await showConfirm({
    title:        'Delete this room? 🗑️',
    message,
    confirmLabel: 'Yes, delete it all',
    cancelLabel:  'Nope, keep it',
    danger:       true,
  });

  if (!confirmed) return;

  const result = await removeLocation(locationId);
  if (!result.ok) {
    toastError(result.error);
    return;
  }

  let msg = 'Room deleted 🗑️';
  if (result.deletedItems > 0) {
    msg = `Room and ${result.deletedItems} item(s) deleted 🗑️`;
  }
  toastSuccess(msg);

  _search?.ui?.invalidate();

  // If we were inside the deleted location, go home
  if (getCurrentLocationId() === locationId) {
    await navigateTo(null);
  } else {
    await renderAll();
  }
}

/**
 * Persist a new drag-and-drop order for location siblings.
 * @param {string[]} orderedIds
 */
async function _handleReorderLocations(orderedIds) {
  const result = await reorderSiblings(orderedIds);
  if (!result.ok) {
    toastError(result.error ?? 'Couldn\'t save the new order 😬');
  }
  // No full re-render needed — DOM already updated by drag-and-drop
}


/* ═══════════════════════════════════════════════════════════════
   5. ITEM ACTIONS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Toggle starred status of an item.
 * @param {string}      itemId
 * @param {HTMLElement} btnEl
 */
async function _handleToggleStar(itemId, btnEl) {
  const result = await toggleStar(itemId);
  if (!result.ok) {
    toastError(result.error);
    return;
  }
  // Update button immediately (optimistic)
  updateStarButton(itemId, result.starred);

  // Refresh starred section
  await renderStarredSection();
  await renderTotalCount();

  const label = result.starred ? '⭐ Starred!' : '☆ Unstarred';
  toastInfo(label, { duration: 1800 });
}

/**
 * Handle delete-item request (with confirmation).
 * @param {string}      itemId
 * @param {HTMLElement} [triggerEl]
 */
async function _handleDeleteItem(itemId) {
  const confirmed = await showConfirm({
    title:        'Delete this item? 🗑️',
    message:      'This item will be gone for good. No undo!',
    confirmLabel: 'Yes, delete it',
    cancelLabel:  'Nope, keep it',
    danger:       true,
  });

  if (!confirmed) return;

  const result = await removeItem(itemId);
  if (!result.ok) {
    toastError(result.error);
    return;
  }

  toastSuccess(`"${sanitiseAndTrim(result.name, 40)}" deleted 🗑️`);
  _search?.ui?.invalidate();
  await renderAll();
}


/* ═══════════════════════════════════════════════════════════════
   6. EXPORT MODAL
   ═══════════════════════════════════════════════════════════════ */

function _wireExportModal() {
  byId('btn-do-export')?.addEventListener('click', _handleExport);

  // Password strength meter
  byId('export-password')?.addEventListener('input', (e) => {
    _updatePasswordStrength(e.target.value, 'password-strength');
    clearAllFieldErrors('modal-export');
  });

  byId('export-password-confirm')?.addEventListener('input', () => {
    clearAllFieldErrors('modal-export');
  });
}

/**
 * Open the export modal.
 * @param {HTMLElement} [triggerEl]
 */
function _openExportModal(triggerEl) {
  resetModalForm('modal-export');
  clearAllFieldErrors('modal-export');

  // Reset strength meter
  const strengthEl = byId('password-strength');
  if (strengthEl) {
    strengthEl.textContent = '';
    strengthEl.className   = 'password-strength';
  }

  openModal('modal-export', triggerEl);
  byId('export-password')?.focus();
}

/**
 * Handle the export flow: validate → encrypt → download.
 */
async function _handleExport() {
  clearAllFieldErrors('modal-export');

  const password = byId('export-password')?.value ?? '';
  const confirm  = byId('export-password-confirm')?.value ?? '';

  let hasError = false;

  if (!password) {
    showFieldError('export-password', 'export-password-error',
      'Please set a password to protect your data 🔑');
    hasError = true;
  } else {
    const strength = scorePassword(password);
    if (strength.score === 0) {
      showFieldError('export-password', 'export-password-error',
        'Your password is too weak — try something longer or more varied 🔑');
      hasError = true;
    }
  }

  if (password && confirm !== password) {
    showFieldError('export-password-confirm', 'export-confirm-error',
      'Passwords don\'t match — double-check and try again 🤔');
    hasError = true;
  }

  if (hasError) return;

  setBtnLoading('btn-do-export', 'Encrypting…');

  try {
    const data     = await exportData();
    const buffer   = await encryptHouseData(data, password);
    const filename = buildExportFilename('MyHome');
    downloadHouseFile(buffer, filename);

    clearBtnLoading('btn-do-export');
    closeModal('modal-export');

    toastSuccess(`📦 Exported as "${filename}" — keep it safe!`);
  } catch (err) {
    clearBtnLoading('btn-do-export');
    toastError(`Export failed: ${err.message ?? 'Unknown error'} 😬`);
    console.error('[HouseRecall] Export error:', err);
  }
}

/**
 * Update the password strength indicator.
 * @param {string} password
 * @param {string} strengthElId
 */
function _updatePasswordStrength(password, strengthElId) {
  const el = byId(strengthElId);
  if (!el) return;

  if (!password) {
    el.textContent = '';
    el.className   = 'password-strength';
    return;
  }

  const { label, cssClass } = scorePassword(password);
  el.textContent = label;
  el.className   = `password-strength ${cssClass}`;
}


/* ═══════════════════════════════════════════════════════════════
   7. IMPORT MODAL
   ═══════════════════════════════════════════════════════════════ */

/** @type {File|null} */
let _pendingImportFile = null;

function _wireImportModal() {
  byId('btn-do-import')?.addEventListener('click', _handleImport);

  // File input change
  byId('import-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) _setImportFile(file);
  });

  byId('import-password')?.addEventListener('input', () => {
    clearAllFieldErrors('modal-import');
  });
}

/**
 * Open the import modal.
 * @param {HTMLElement} [triggerEl]
 */
function _openImportModal(triggerEl) {
  resetModalForm('modal-import');
  clearAllFieldErrors('modal-import');
  _pendingImportFile = null;
  setTextSafe(byId('file-chosen'), '');
  openModal('modal-import', triggerEl);
}

/**
 * Called when a file is selected or dropped.
 * @param {File} file
 */
function _setImportFile(file) {
  _pendingImportFile = file;
  const chosenEl = byId('file-chosen');
  if (chosenEl) setTextSafe(chosenEl, `✅ ${file.name}`);
}

/**
 * Handle the import flow: validate → read → decrypt → import.
 */
async function _handleImport() {
  clearAllFieldErrors('modal-import');

  if (!_pendingImportFile) {
    toastWarning('Please select a .house file first 📂');
    return;
  }

  const password = byId('import-password')?.value ?? '';
  if (!password) {
    showFieldError('import-password', 'import-password-error',
      'Enter the password you used when exporting 🔑');
    return;
  }

  setBtnLoading('btn-do-import', 'Decrypting…');

  try {
    const buffer = await readFileAsArrayBuffer(_pendingImportFile);
    const data   = await decryptHouseFile(buffer, password);
    const result = await importData(data);

    clearBtnLoading('btn-do-import');
    closeModal('modal-import');
    _pendingImportFile = null;

    toastSuccess(
      `🏠 Imported! ${result.locations} room(s) and ${result.items} item(s) loaded.`
    );

    _search?.ui?.invalidate();
    await navigateTo(null);
  } catch (err) {
    clearBtnLoading('btn-do-import');
    showFieldError('import-password', 'import-password-error', err.message);
    console.error('[HouseRecall] Import error:', err);
  }
}

/**
 * Handle file dropped onto the import file drop zone.
 * @param {File} file
 */
function _handleFileDrop(file) {
  _setImportFile(file);
  byId('import-password')?.focus();
}


/* ═══════════════════════════════════════════════════════════════
   8. SEARCH
   ═══════════════════════════════════════════════════════════════ */

/** @type {{ engine: import('./search.js').SearchEngine, ui: import('./search.js').SearchUI }|null} */
let _search = null;

function _initSearchSystem() {
  _search = initSearch({
    onSelect: async (result) => {
      // Navigate to the item's location
      await navigateTo(result.item.locationId);
      // Briefly highlight the item card (scroll it into view)
      _highlightItem(result.item.id);
    },
    onClear: () => {
      // nothing extra needed
    },
  });
}

/**
 * Scroll an item card into view and briefly pulse it.
 * @param {string} itemId
 */
function _highlightItem(itemId) {
  requestAnimationFrame(() => {
    const card = document.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('pulse-ring');
    card.addEventListener('animationend', () => {
      card.classList.remove('pulse-ring');
    }, { once: true });
  });
}


/* ═══════════════════════════════════════════════════════════════
   9. FATAL ERROR
   ═══════════════════════════════════════════════════════════════ */

/**
 * Show a fatal error overlay if the app can't boot.
 * @param {Error} err
 */
function _showFatalError(err) {
  const body = document.body;
  body.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.style.cssText = [
    'display:flex', 'flex-direction:column', 'align-items:center',
    'justify-content:center', 'min-height:100dvh', 'padding:2rem',
    'font-family:system-ui,sans-serif', 'text-align:center',
    'background:#fdf6ec', 'color:#2d1f14',
  ].join(';');

  const emoji = document.createElement('p');
  emoji.textContent = '😬';
  emoji.style.fontSize = '4rem';

  const title = document.createElement('h1');
  title.textContent = 'Something went wrong';
  title.style.cssText = 'font-size:1.5rem;margin:1rem 0 0.5rem';

  const msg = document.createElement('p');
  msg.textContent = err?.message ?? 'HouseRecall couldn\'t start. Try refreshing the page.';
  msg.style.cssText = 'color:#8a7060;max-width:400px;margin:0 auto 1.5rem';

  const btn = document.createElement('button');
  btn.textContent = 'Refresh the page';
  btn.style.cssText = [
    'padding:0.75rem 1.5rem', 'background:#c9613a', 'color:#fff',
    'border:none', 'border-radius:9999px', 'font-size:1rem',
    'cursor:pointer', 'font-weight:600',
  ].join(';');
  btn.addEventListener('click', () => location.reload());

  wrap.append(emoji, title, msg, btn);
  body.appendChild(wrap);
}
