/**
 * HouseRecall — js/encryption.js
 * AES-256-GCM encryption / decryption via the Web Crypto API.
 * Key derivation: PBKDF2 with SHA-256, 310,000 iterations (OWASP 2023 rec.).
 *
 * .house file format (binary layout):
 * ┌─────────────────────────────────────────────────────┐
 * │ magic      4 bytes  ASCII "HRCL"                    │
 * │ version    1 byte   format version (currently 0x01) │
 * │ iterations 4 bytes  PBKDF2 iterations (Uint32BE)    │
 * │ salt       32 bytes random PBKDF2 salt              │
 * │ iv         12 bytes random AES-GCM nonce            │
 * │ ciphertext N bytes  AES-256-GCM encrypted payload   │
 * │ (authTag is appended by SubtleCrypto automatically) │
 * └─────────────────────────────────────────────────────┘
 * Total header: 4 + 1 + 4 + 32 + 12 = 53 bytes
 *
 * The plaintext payload is a UTF-8 JSON string of HouseData.
 *
 * Security notes:
 * - Salt and IV are freshly randomised on every export.
 * - Auth tag (128-bit) is included by SubtleCrypto's GCM impl.
 * - Wrong password → decryption throws (auth tag mismatch).
 * - No password is ever stored, logged, or transmitted.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   1. CONSTANTS
   ═══════════════════════════════════════════════════════════════ */

/** File magic bytes — "HRCL" (HouseRecaLL) */
const MAGIC           = new Uint8Array([0x48, 0x52, 0x43, 0x4c]);
const FORMAT_VERSION  = 0x01;
const PBKDF2_ALGO     = 'PBKDF2';
const PBKDF2_HASH     = 'SHA-256';
const PBKDF2_ITERS    = 310_000;   // OWASP 2023 recommendation
const AES_ALGO        = 'AES-GCM';
const AES_KEY_BITS    = 256;
const SALT_BYTES      = 32;        // 256-bit salt
const IV_BYTES        = 12;        // 96-bit IV (GCM standard)
const AUTH_TAG_BITS   = 128;       // GCM auth tag length

// Header offsets
const OFFSET_MAGIC    = 0;         // bytes 0-3
const OFFSET_VERSION  = 4;         // byte  4
const OFFSET_ITERS    = 5;         // bytes 5-8
const OFFSET_SALT     = 9;         // bytes 9-40
const OFFSET_IV       = 41;        // bytes 41-52
const OFFSET_CIPHER   = 53;        // bytes 53-end
const HEADER_SIZE     = 53;


/* ═══════════════════════════════════════════════════════════════
   2. RANDOM BYTES
   ═══════════════════════════════════════════════════════════════ */

/**
 * Generate cryptographically secure random bytes.
 * @param {number} byteCount
 * @returns {Uint8Array}
 */
function randomBytes(byteCount) {
  const buf = new Uint8Array(byteCount);
  crypto.getRandomValues(buf);
  return buf;
}


/* ═══════════════════════════════════════════════════════════════
   3. KEY DERIVATION
   ═══════════════════════════════════════════════════════════════ */

/**
 * Derive an AES-256-GCM CryptoKey from a password + salt using PBKDF2.
 * This is the slow step — intentionally. Makes brute-force expensive.
 *
 * @param {string}     password  — user-supplied passphrase
 * @param {Uint8Array} salt      — 32-byte random salt
 * @param {number}     [iters]   — PBKDF2 iterations (default 310,000)
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(password, salt, iters = PBKDF2_ITERS) {
  // Import the raw password as a PBKDF2 key
  const rawKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    PBKDF2_ALGO,
    false,          // not extractable
    ['deriveKey'],
  );

  // Derive the AES key
  return crypto.subtle.deriveKey(
    {
      name:       PBKDF2_ALGO,
      salt,
      iterations: iters,
      hash:       PBKDF2_HASH,
    },
    rawKey,
    {
      name:   AES_ALGO,
      length: AES_KEY_BITS,
    },
    false,          // not extractable — key never leaves SubtleCrypto
    ['encrypt', 'decrypt'],
  );
}


/* ═══════════════════════════════════════════════════════════════
   4. ENCRYPTION
   ═══════════════════════════════════════════════════════════════ */

/**
 * Encrypt a HouseData object into a .house binary ArrayBuffer.
 *
 * @param {object} data       — plain JS object (HouseData)
 * @param {string} password   — user's chosen passphrase
 * @returns {Promise<ArrayBuffer>}
 * @throws {Error} if data or password is invalid
 */
export async function encryptHouseData(data, password) {
  _assertWebCryptoAvailable();
  _assertPassword(password);

  // Serialise to UTF-8 JSON
  const plaintext = new TextEncoder().encode(JSON.stringify(data));

  // Fresh salt + IV every time
  const salt = randomBytes(SALT_BYTES);
  const iv   = randomBytes(IV_BYTES);

  // Derive key
  const key = await deriveKey(password, salt);

  // Encrypt
  const cipherBuffer = await crypto.subtle.encrypt(
    {
      name:     AES_ALGO,
      iv,
      tagLength: AUTH_TAG_BITS,
    },
    key,
    plaintext,
  );

  // Assemble the .house binary file
  return _assembleBinary(salt, iv, new Uint8Array(cipherBuffer));
}


/* ═══════════════════════════════════════════════════════════════
   5. DECRYPTION
   ═══════════════════════════════════════════════════════════════ */

/**
 * Decrypt a .house ArrayBuffer back to a plain JS object.
 *
 * @param {ArrayBuffer} fileBuffer — raw .house file contents
 * @param {string}      password   — passphrase
 * @returns {Promise<object>}      — the original HouseData object
 * @throws {Error} on wrong password, corrupted file, or format mismatch
 */
export async function decryptHouseFile(fileBuffer, password) {
  _assertWebCryptoAvailable();
  _assertPassword(password);

  const bytes = new Uint8Array(fileBuffer);

  // Validate minimum size
  if (bytes.length < HEADER_SIZE + 1) {
    throw new Error('This file is too small to be a valid .house file 🤔');
  }

  // Check magic bytes
  _assertMagic(bytes);

  // Check format version
  const version = bytes[OFFSET_VERSION];
  if (version !== FORMAT_VERSION) {
    throw new Error(
      `Unsupported .house file version (${version}). ` +
      'You may need a newer version of HouseRecall.'
    );
  }

  // Read PBKDF2 iterations (stored so future versions can increase it
  // without breaking older exports)
  const iterView = new DataView(fileBuffer, OFFSET_ITERS, 4);
  const iters    = iterView.getUint32(0, false); // big-endian

  if (iters < 1_000 || iters > 10_000_000) {
    throw new Error('Suspicious iteration count in file — refusing to open 🚫');
  }

  // Extract salt, IV, ciphertext
  const salt       = bytes.slice(OFFSET_SALT, OFFSET_SALT + SALT_BYTES);
  const iv         = bytes.slice(OFFSET_IV,   OFFSET_IV   + IV_BYTES);
  const ciphertext = bytes.slice(OFFSET_CIPHER);

  // Re-derive the key using the stored salt + iterations
  const key = await deriveKey(password, salt, iters);

  // Decrypt (wrong password → OperationError from GCM tag mismatch)
  let plainBuffer;
  try {
    plainBuffer = await crypto.subtle.decrypt(
      { name: AES_ALGO, iv, tagLength: AUTH_TAG_BITS },
      key,
      ciphertext,
    );
  } catch {
    // Don't leak cryptographic details — just friendly message
    throw new Error(
      'Wrong password or corrupted file 🔒 ' +
      'Double-check your password and try again.'
    );
  }

  // Decode UTF-8 → JSON → object
  const jsonStr = new TextDecoder().decode(plainBuffer);
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('File decrypted but contents look corrupted — try a different export.');
  }

  return parsed;
}


/* ═══════════════════════════════════════════════════════════════
   6. FILE DOWNLOAD HELPER
   ═══════════════════════════════════════════════════════════════ */

/**
 * Trigger a browser download of an ArrayBuffer as a .house file.
 *
 * @param {ArrayBuffer} buffer    — encrypted .house data
 * @param {string}      filename  — e.g. "MyHome_20240615-1430.house"
 */
export function downloadHouseFile(buffer, filename) {
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href     = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  // Clean up after a tick so the download has time to start
  setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 1_000);
}


/* ═══════════════════════════════════════════════════════════════
   7. FILE READ HELPER
   ═══════════════════════════════════════════════════════════════ */

/**
 * Read a File object into an ArrayBuffer.
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    if (!(file instanceof File)) {
      reject(new Error('Not a valid file object'));
      return;
    }
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read file: ${reader.error?.message}`));
    reader.readAsArrayBuffer(file);
  });
}


/* ═══════════════════════════════════════════════════════════════
   8. BINARY ASSEMBLY / PARSING (internal)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Assemble the .house binary from its components.
 * @param {Uint8Array} salt
 * @param {Uint8Array} iv
 * @param {Uint8Array} ciphertext
 * @returns {ArrayBuffer}
 */
function _assembleBinary(salt, iv, ciphertext) {
  const totalSize = HEADER_SIZE + ciphertext.length;
  const buf       = new ArrayBuffer(totalSize);
  const view      = new Uint8Array(buf);
  const dataView  = new DataView(buf);

  // Magic: "HRCL"
  view.set(MAGIC, OFFSET_MAGIC);

  // Version
  view[OFFSET_VERSION] = FORMAT_VERSION;

  // PBKDF2 iterations (Uint32 big-endian)
  dataView.setUint32(OFFSET_ITERS, PBKDF2_ITERS, false);

  // Salt (32 bytes)
  view.set(salt, OFFSET_SALT);

  // IV (12 bytes)
  view.set(iv, OFFSET_IV);

  // Ciphertext
  view.set(ciphertext, OFFSET_CIPHER);

  return buf;
}

/**
 * Assert the magic bytes match "HRCL".
 * @param {Uint8Array} bytes
 */
function _assertMagic(bytes) {
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[OFFSET_MAGIC + i] !== MAGIC[i]) {
      throw new Error(
        'This doesn\'t look like a HouseRecall file 🤔 ' +
        'Make sure you\'re opening a .house export file.'
      );
    }
  }
}

/**
 * Assert the Web Crypto API is available.
 */
function _assertWebCryptoAvailable() {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error(
      'Your browser doesn\'t support the Web Crypto API. ' +
      'Please use a modern browser (Chrome 37+, Firefox 34+, Safari 11+).'
    );
  }
}

/**
 * Assert a password is non-empty.
 * @param {string} password
 */
function _assertPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password cannot be empty 🔑');
  }
}


/* ═══════════════════════════════════════════════════════════════
   9. CAPABILITY CHECK (exported for UI use)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Check if encryption is supported in this environment.
 * Returns true if Web Crypto + AES-GCM is available.
 * @returns {boolean}
 */
export function isEncryptionSupported() {
  try {
    return (
      typeof crypto !== 'undefined' &&
      typeof crypto.subtle !== 'undefined' &&
      typeof crypto.subtle.encrypt === 'function' &&
      typeof crypto.getRandomValues === 'function'
    );
  } catch {
    return false;
  }
}


/* ═══════════════════════════════════════════════════════════════
   10. CONSTANTS RE-EXPORT (for tests / diagnostics)
   ═══════════════════════════════════════════════════════════════ */

export const CRYPTO_INFO = Object.freeze({
  algorithm:    AES_ALGO,
  keyBits:      AES_KEY_BITS,
  kdf:          PBKDF2_ALGO,
  kdfHash:      PBKDF2_HASH,
  kdfIters:     PBKDF2_ITERS,
  saltBytes:    SALT_BYTES,
  ivBytes:      IV_BYTES,
  authTagBits:  AUTH_TAG_BITS,
  headerSize:   HEADER_SIZE,
  fileExt:      '.house',
  magic:        'HRCL',
});
