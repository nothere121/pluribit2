/**
 * @fileoverview This file acts as a bridge between the Rust/Wasm module and the Node.js LevelDB database.
 * It manages singleton database instances to prevent connection errors when called from different contexts (JS worker vs. Wasm).
 * All database operations, including wallet encryption and chain state management, are defined and exported here.
 */

const { Level } = require('level');
const path = require('path');
const { webcrypto: crypto, randomBytes, scryptSync, createCipheriv, createDecipheriv } = require('crypto');
const fs = require('fs');

// --- DATABASE SINGLETON MANAGEMENT ---

// These variables will hold the single instances and their initialization promises.
let chainDbInstance = null;
let walletDbInstance = null;
let metaDbInstance = null;
let deferredDbInstance = null;

let chainDbPromise = null;
let walletDbPromise = null;
let metaDbPromise = null;
let deferredDbPromise = null;

// UTXO DB singleton
let utxoDbInstance = null;
let utxoDbPromise = null;
const DB_PATH = path.resolve(process.cwd(), 'pluribit-data');

// Use synchronous functions for one-time setup to avoid top-level await.
try {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });
  }
} catch (e) {
  console.warn(`Could not create database directory: ${e.message}`);
}

/**
 * Lazily initializes and opens the chain database instance.
 * @private
 * @returns {Promise<Level>} A promise that resolves with the open chain DB instance.
 */
async function getChainDb() {
  // If the instance exists and is open, return it immediately.
  if (chainDbInstance && chainDbInstance.status === 'open') {
    return chainDbInstance;
  }
  
  // If an initialization promise is already in flight, return it to avoid duplicate initializations.
  if (chainDbPromise) {
    return chainDbPromise;
  }
  
  // Create and store the promise. This IIFE will now only run once.
  chainDbPromise = (async () => {
    const db = new Level(path.join(DB_PATH, 'chain'), { valueEncoding: 'utf8' });
    
    // This is all that's needed. If open() fails, it throws an error.
    // If it succeeds, the DB is guaranteed to be ready.
    await db.open();
    
    chainDbInstance = db;
    console.log('[DB] Chain database opened successfully');
    return db;
  })();
  
  return chainDbPromise;
}

/**
 * Lazily initializes and opens the wallet database instance.
 * @private
 * @returns {Promise<Level>} A promise that resolves with the open wallet DB instance.
 */
async function getWalletDb() {
  if (walletDbInstance && walletDbInstance.status === 'open') {
    return walletDbInstance;
  }
  
  if (walletDbPromise) {
    return walletDbPromise;
  }
  
  walletDbPromise = (async () => {
    const db = new Level(path.join(DB_PATH, 'wallets'), { valueEncoding: 'utf8' });
    await db.open();
    walletDbInstance = db;
    // console.log('[DB] Wallet database opened successfully'); // Optional: Add log if desired
    return db;
  })();

  return walletDbPromise;
}

/**
 * Lazily initializes and opens the metadata database instance.
 * @private
 * @returns {Promise<Level>} A promise that resolves with the open meta DB instance.
 */
async function getMetaDb() {
  if (metaDbInstance && metaDbInstance.status === 'open') {
    return metaDbInstance;
  }

  if (metaDbPromise) {
    return metaDbPromise;
  }
  
  metaDbPromise = (async () => {
    const db = new Level(path.join(DB_PATH, 'meta'), { valueEncoding: 'json' });
    await db.open();
    metaDbInstance = db;
    // console.log('[DB] Meta database opened successfully'); // Optional: Add log if desired
    return db;
  })();
  
  return metaDbPromise;
}


/**
 * Lazily initializes and opens the deferred blocks database instance.
 * @private
 * @returns {Promise<Level>} A promise that resolves with the open deferred DB instance.
 */
async function getDeferredDb() {
  if (deferredDbInstance && deferredDbInstance.status === 'open') {
    return deferredDbInstance;
  }
  if (deferredDbPromise) {
    return deferredDbPromise;
  }
  deferredDbPromise = (async () => {
    const db = new Level(path.join(DB_PATH, 'deferred'), { keyEncoding: 'utf8', valueEncoding: 'utf8' });
    await db.open();
    deferredDbInstance = db;
    return db;
  })();
  return deferredDbPromise;
}




// --- UTXO DATABASE SINGLETON ---

async function getUtxoDb() {
  if (utxoDbInstance && utxoDbInstance.status === 'open') {
    return utxoDbInstance;
  }
  if (utxoDbPromise) {
    return utxoDbPromise;
  }
  utxoDbPromise = (async () => {
    const db = new Level(path.join(DB_PATH, 'utxo'), { valueEncoding: 'json' });
    await db.open();
    utxoDbInstance = db;
    return db;
  })();
  return utxoDbPromise;
}


/**
 * Initializes all database connections. This function should be called once when the worker starts.
 * It's safe to call multiple times; it will only perform the initialization once per database.
 * @returns {Promise<void>} A promise that resolves when all databases are open and ready.
 */
async function initializeDatabase() {
  await Promise.all([getChainDb(), getWalletDb(), getMetaDb(), getDeferredDb()]);
}



/**
 * (For Testing) Overwrites the database instances with mock/test versions.
 * @private
 */
function __setDbs(testChainDb, testWalletDb, testMetaDb) {
  chainDbInstance = testChainDb;
  walletDbInstance = testWalletDb;
  metaDbInstance = testMetaDb || metaDbInstance;
  // Mark promises as resolved to prevent re-initialization
  chainDbPromise = Promise.resolve(testChainDb);
  walletDbPromise = Promise.resolve(testWalletDb);
  if (testMetaDb) metaDbPromise = Promise.resolve(testMetaDb);
}


// --- SERIALIZATION HELPERS ---

const replacer = (_, v) => {
  if (typeof v === 'bigint') return v.toString();
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v); // Uint8Array -> number[]
  return v;
};
const stringify = (x) => JSON.stringify(x, replacer);
const parse = (s) => JSONParseWithBigInt(s);


// --- WALLET ENCRYPTION HELPERS ---
const PASS_ENV = 'PLURIBIT_WALLET_PASSPHRASE';
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, dkLen: 32 };

function getPassphrase() {
  const s = process.env[PASS_ENV];
  return (typeof s === 'string' && s.length >= 8) ? s : null;
}

function isEncryptedEnvelope(str) {
  if (typeof str !== 'string') return false;
  try {
    const obj = JSON.parse(str);
    return obj && obj.enc === true && obj.alg === 'aes-256-gcm' && obj.kdf === 'scrypt';
  } catch { return false; }
}

function encryptWallet(plaintext, passphrase) {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, SCRYPT_PARAMS.dkLen, { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p });
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    enc: true,
    v: 1,
    alg: 'aes-256-gcm',
    kdf: 'scrypt',
    scrypt: SCRYPT_PARAMS,
    s: salt.toString('base64'),
    n: nonce.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64')
  });
}

function decryptWallet(envelopeStr, passphrase) {
  const env = JSON.parse(envelopeStr);
  const { s, n, ct, tag, scrypt } = env || {};
  const key = scryptSync(passphrase, Buffer.from(s, 'base64'), scrypt.dkLen, { N: scrypt.N, r: scrypt.r, p: scrypt.p });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(n, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}


// --- BLOCK FUNCTIONS ---

/**
 * Saves a block to the database. Also updates the chain tip if the block is the new highest.
 * @pre The `block` object must have a valid `height` property.
 * @post The block is stored in the database, keyed by its height. The 'tip_height' in the meta DB is updated if necessary.
 * @param {object} block - The block object to save.
 * @returns {Promise<void>} A promise that resolves when the save operation is complete.
 */
async function saveBlock(block) {
  const h = Number(block.height);
  console.log(`[DB] Saving block #${h} to database`);
  const [chainDb, metaDb] = await Promise.all([getChainDb(), getMetaDb()]);
  await chainDb.put(h.toString(), stringify(block));
  const currentTip = await getTipHeight();
  if (h >= currentTip) {
    await metaDb.put('tip_height', h);
  }
}

/**
 * Loads a block from the database by its height.
 * @pre `height` must be a non-negative integer.
 * @post Returns the parsed block object if found, otherwise returns null.
 * @param {number} height - The height of the block to load.
 * @returns {Promise<object|null>} A promise resolving to the block object or null.
 */
async function loadBlock(height) {
  const chainDb = await getChainDb();
  try {
    const raw = await chainDb.get(height.toString());
    return parse(raw);
  } catch (error) {
    if (error.code === 'LEVEL_NOT_FOUND') return null;
    throw error;
  }
}

/**
 * Retrieves the height of the most recent block (the chain tip).
 * @pre Database must be available.
 * @post Returns the current tip height as a number. Returns 0 if no tip is set.
 * @returns {Promise<number>} A promise resolving to the tip height.
 */
async function getTipHeight() {
  const metaDb = await getMetaDb();
  try {
    const h = await metaDb.get('tip_height');
    return Number.isFinite(h) ? h : 0;
  } catch (error) {
    if (error.code === 'LEVEL_NOT_FOUND') return 0;
    throw error;
  }
}

/**
 * Retrieves the full block object at the chain tip.
 * @pre Database must be available.
 * @post Returns the full block object of the highest block, or null if the chain is empty.
 * @returns {Promise<object|null>} A promise resolving to the tip block object.
 */
async function getChainTip() {
  const tipHeight = await getTipHeight();
  return await loadBlock(tipHeight);
}

/**
 * Retrieves a batch of blocks from the database by height range.
 * @param {number} startHeight - The starting height of the range (inclusive).
 * @param {number} endHeight - The ending height of the range (inclusive).
 * @returns {Promise<Array<object>>} A promise resolving to an array of block objects.
 */
async function loadBlocks(startHeight, endHeight) {
  const blocks = [];
  // Convert BigInt arguments to standard Numbers before use
  const start = Number(startHeight);
  
  // Ensure we don't try to read an invalid range
  const end = Math.max(start, Number(endHeight));
  for (let i = startHeight; i <= end; i++) {
    const block = await loadBlock(i);
    if (block) blocks.push(block);
  }
  return blocks;
}


/**
 * Retrieves all blocks from genesis to the current tip.
 * @pre Database must be available.
 * @post Returns an array of all block objects in order of height.
 * @returns {Promise<Array<object>>} A promise resolving to an array of blocks.
 */
async function getAllBlocks() {
  const blocks = [];
  const tipHeight = await getTipHeight();
  for (let i = 0; i <= tipHeight; i++) {
    const block = await loadBlock(i);
    if (block) blocks.push(block);
  }
  return blocks;
}

// --- DEFERRED BLOCK FUNCTIONS ---

/**
 * Saves a deferred block to the database, keyed by its height for sequential processing.
 * @param {object} block The block object to save.
 * @returns {Promise<void>}
 */
async function saveDeferredBlock(block) {
    const db = await getDeferredDb();
    // Pad the height to ensure lexicographical sorting by height.
    const key = block.height.toString().padStart(16, '0');
    await db.put(key, stringify(block));
}

/**
 * Loads and parses all deferred blocks from the database in order.
 * @returns {Promise<Array<object>>}
 */
async function loadAllDeferredBlocks() {
    const db = await getDeferredDb();
    const entries = await db.iterator().all();
    return entries.map(([key, value]) => parse(value));
}

async function clearDeferredBlocks() {
    const db = await getDeferredDb();
    await db.clear();
}


// --- WALLET FUNCTIONS ---

/**
 * Saves a wallet's state. Encrypts the wallet data if PLURIBIT_WALLET_PASSPHRASE is set.
 * @pre `walletId` is a string; `walletJsonString` is a valid JSON string representing the wallet.
 * @post The wallet data (either plaintext or an encrypted envelope) is persisted in the wallet database.
 * @param {string} walletId - The identifier for the wallet.
 * @param {string} walletJsonString - The wallet data as a JSON string.
 * @returns {Promise<void>} A promise that resolves when the wallet is saved.
 */
async function saveWallet(walletId, walletJsonString) {
  const walletDb = await getWalletDb();
  const pass = getPassphrase();
  const clear = (typeof walletJsonString === 'string') ? walletJsonString : JSON.stringify(walletJsonString);
  const toStore = pass ? encryptWallet(clear, pass) : clear;
  await walletDb.put(walletId, toStore);
}

/**
 * Loads a wallet's state. Decrypts it if necessary and possible.
 * @pre `walletId` is a string identifying the wallet to load.
 * @post Returns the wallet data as a plaintext JSON string. Throws an error if the wallet is encrypted and no passphrase is provided.
 * @param {string} walletId - The identifier for the wallet.
 * @returns {Promise<string|null>} A promise resolving to the plaintext wallet JSON string or null if not found.
 * @throws {Error} Throws an error with code `WALLET_PASSPHRASE_REQUIRED` if decryption is needed but no passphrase is set.
 */
async function loadWallet(walletId) {
  const walletDb = await getWalletDb();
  try {
    const raw = await walletDb.get(walletId);
    if (isEncryptedEnvelope(raw)) {
      const pass = getPassphrase();
      if (!pass) {
        const e = new Error('Wallet is encrypted; set PLURIBIT_WALLET_PASSPHRASE to decrypt.');
        e.code = 'WALLET_PASSPHRASE_REQUIRED';
        throw e;
      }
      const clear = decryptWallet(raw, pass);
      if (process.env.PLURIBIT_WALLET_ENCRYPT_MIGRATE === '1') {
        const fresh = encryptWallet(clear, pass);
        if (fresh !== raw) await walletDb.put(walletId, fresh);
      }
      return clear;
    }
    if (getPassphrase() && process.env.PLURIBIT_WALLET_ENCRYPT_MIGRATE === '1') {
      await saveWallet(walletId, raw);
    }
    return raw;
  } catch (error) {
    if (error.code === 'LEVEL_NOT_FOUND') return null;
    throw error;
  }
}

/**
 * Checks if a stored wallet blob is encrypted.
 * @pre `walletId` is a string.
 * @post Returns true if the wallet exists and is stored in an encrypted format.
 * @param {string} walletId - The identifier for the wallet.
 * @returns {Promise<boolean>} A promise resolving to true if encrypted, false otherwise.
 */
async function isWalletEncrypted(walletId) {
  const walletDb = await getWalletDb();
  const raw = await walletDb.get(walletId).catch(() => null);
  return raw != null && isEncryptedEnvelope(raw);
}

/**
 * Checks if a wallet with the given ID exists.
 * @pre `walletId` must be a non-empty string.
 * @post Returns true if the wallet exists (can be loaded), false otherwise.
 * @param {string} walletId The identifier for the wallet.
 * @returns {Promise<boolean>} A promise resolving to true or false.
 */
async function walletExists(walletId) {
  // This reuses loadWallet's logic, which correctly handles not-found errors.
  const walletData = await loadWallet(walletId).catch(err => {
    // Suppress passphrase errors for a simple existence check.
    if (err.code === 'WALLET_PASSPHRASE_REQUIRED') return true;
    throw err;
  });
  return walletData !== null;
}


// --- TOTAL WORK FUNCTIONS ---

/**
 * Saves the total accumulated chain work.
 * @pre `work` is a number or BigInt.
 * @post The total work is persisted as a string in the meta database.
 * @param {number|BigInt} work - The total work to save.
 * @returns {Promise<void>} A promise that resolves when saved.
 */
async function saveTotalWork(work) {
  const metaDb = await getMetaDb();
  await metaDb.put('total_work', work.toString());
}

/**
 * Loads the total accumulated chain work.
 * @pre Database must be available.
 * @post Returns the total work as a string. Returns '0' if not found.
 * @returns {Promise<string>} A promise resolving to the total work as a string.
 */
async function loadTotalWork() {
  const metaDb = await getMetaDb();
  try {
    const w = await metaDb.get('total_work');
    return w;
  } catch (error) {
    if (error.code === 'LEVEL_NOT_FOUND') return '0';
    throw error;
  }
}


// --- UTILITY FUNCTIONS ---

const generateId = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
};

const JSONStringifyWithBigInt = (obj) => {
  function replacer(key, value) {
    if (typeof value === 'bigint') {
      return { __type: 'BigInt', value: value.toString() };
    }
    if (value instanceof Uint8Array) {
      return { __type: 'Uint8Array', value: Buffer.from(value).toString('base64') };
    }
    if (Array.isArray(value) && value.length > 0 &&
      value.every(v => typeof v === 'number' && v >= 0 && v <= 255)) {
      const uint8 = new Uint8Array(value);
      return { __type: 'Uint8Array', value: Buffer.from(uint8).toString('base64') };
    }
    return value;
  }
  return JSON.stringify(obj, replacer);
};

const JSONParseWithBigInt = (str) => {
  function reviver(key, value) {
    if (value && typeof value === 'object' && value.__type) {
      if (value.__type === 'BigInt') {
        return BigInt(value.value);
      }
      if (value.__type === 'Uint8Array') {
        return new Uint8Array(Buffer.from(value.value, 'base64'));
      }
    }
    return value;
  }
  return JSON.parse(str, reviver);
};


// --- RUST <-> JAVASCRIPT BRIDGE FUNCTIONS ---
// These are the functions directly exposed to the Wasm module.
// They simply wrap the main JS functions to provide a stable API for Rust.

/**
 * Loads a block by its height. Exported for the Rust/Wasm module.
 * @param {number} height - The height of the block to load.
 * @returns {Promise<object|null>} The block object or null if not found.
 */
async function load_block_from_db(height) {
  return await loadBlock(height);
}

/**
 * Gets the height of the current chain tip. Exported for the Rust/Wasm module.
 * @returns {Promise<number>} The height of the latest block.
 */
async function get_tip_height_from_db() {
  return await getTipHeight();
}

/**
 * Saves the total chain work. Exported for the Rust/Wasm module.
 * @param {string} work - The total work as a string, parsable to a u64 in Rust.
 * @returns {Promise<void>}
 */
async function save_total_work_to_db(work) {
  // The 'work' from Rust is a u64, which becomes a JS number.
  // saveTotalWork already stringifies it.
  await saveTotalWork(work);
}

/**
 * Loads the total chain work. Exported for the Rust/Wasm module.
 * @returns {Promise<string>} The total work as a string, which Rust will parse.
 */
async function get_total_work_from_db() {
  return await loadTotalWork();
}


// --- MODULE EXPORTS ---



// --- UTXO OPERATIONS ---
async function save_utxo(commitment_hex, output) {
  const db = await getUtxoDb();
  await db.put(commitment_hex, output);
}

async function load_utxo(commitment_hex) {
  const db = await getUtxoDb();
  try {
    return await db.get(commitment_hex);
  } catch (err) {
    if (err && err.code === 'LEVEL_NOT_FOUND') return null;
    throw err;
  }
}

async function delete_utxo(commitment_hex) {
  const db = await getUtxoDb();
  try {
    await db.del(commitment_hex);
  } catch (err) {
    if (err && err.code === 'LEVEL_NOT_FOUND') return;
    throw err;
  }
}

async function clear_all_utxos() {
  const db = await getUtxoDb();
  await db.clear();
  console.log('[DB] UTXO database cleared.');
}


/**
 * Saves a block indexed by both height AND hash
 */
async function saveBlockWithHash(block) {
  const h = Number(block.height);
  const [chainDb, metaDb] = await Promise.all([getChainDb(), getMetaDb()]);
  
  // Save by height (for canonical chain)
  await chainDb.put(h.toString(), stringify(block));
  
  // ALSO save by hash (for forks/side chains) 
  await chainDb.put(`hash:${block.hash}`, stringify(block));
  
  // Update tip if needed
  const currentTip = await getTipHeight();
  if (h >= currentTip) {
    await metaDb.put('tip_height', h);
  }
}

/**
 * Loads a block by its hash
 */
async function loadBlockByHash(hash) {
  const chainDb = await getChainDb();
  try {
    const raw = await chainDb.get(`hash:${hash}`);
    return parse(raw);
  } catch (error) {
    if (error.code === 'LEVEL_NOT_FOUND') return null;
    throw error;
  }
}

/**
 * Delete a block from the canonical chain at a specific height
 */
async function deleteCanonicalBlock(height) {
  const chainDb = await getChainDb();
  try {
    await chainDb.del(height.toString());
  } catch (error) {
    if (error.code === 'LEVEL_NOT_FOUND') return;
    throw error;
  }
}


/**
 * Save a reorg marker for crash recovery
 */
async function save_reorg_marker(marker) {
  const metaDb = await getMetaDb();
  await metaDb.put('reorg_in_progress', marker);
}

/**
 * Clear the reorg marker after successful completion
 */
async function clear_reorg_marker() {
  const metaDb = await getMetaDb();
  try {
    await metaDb.del('reorg_in_progress');
  } catch (e) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
  }
}

/**
 * Check for incomplete reorg on startup
 */
async function check_incomplete_reorg() {
  const metaDb = await getMetaDb();
  try {
    return await metaDb.get('reorg_in_progress');
  } catch (e) {
    if (e.code === 'LEVEL_NOT_FOUND') return null;
    throw e;
  }
}


/**
 * Set the chain tip metadata atomically
 */
async function setTipMetadata(height, hash) {
  const metaDb = await getMetaDb();
  await metaDb.put('tip_height', height);
  await metaDb.put('tip_hash', hash);
}

/**
 * Save a block to staging area for atomic reorg
 */
async function save_block_to_staging(block) {
  const chainDb = await getChainDb();
  const stagingKey = `staging:${block.height}`;
  // FIX: Use JSONStringifyWithBigInt instead of stringify
  await chainDb.put(stagingKey, JSONStringifyWithBigInt(block));
}

/**
 * Atomically commit a staged reorg
 * This uses a batch operation to ensure atomicity
 */
async function commit_staged_reorg(blocks, oldHeights, newTipHeight, newTipHash) {
  const chainDb = await getChainDb();
  const metaDb = await getMetaDb();
  
  // Use leveldb batch for atomic multi-key operations
  const batch = chainDb.batch();
  const metaBatch = metaDb.batch();
  
  // Move staged blocks to canonical locations
  for (const block of blocks) {
    const stagingKey = `staging:${block.height}`;
    const canonicalKey = block.height.toString();
    const hashKey = `hash:${block.hash}`;

    // FIX: Use JSONStringifyWithBigInt instead of stringify
    const blockStr = JSONStringifyWithBigInt(block);

    // Add canonical entries
    batch.put(canonicalKey, blockStr);
    batch.put(hashKey, blockStr);
    
    // Remove staging entry
    batch.del(stagingKey);
  }
  
  // Delete old canonical blocks
  for (const height of oldHeights) {
    batch.del(height.toString());
    // Note: We keep hash: entries for historical queries
  }
  
    // Update metadata
    metaBatch.put('tip_height', Number(newTipHeight));  // Convert BigInt to Number
    metaBatch.put('tip_hash', newTipHash);
  
  // Execute both batches (atomic within each DB)
  await batch.write();
  await metaBatch.write();
  
  console.log('[DB] Atomic reorg commit completed');
}

// Reorg marker functions

module.exports = {
  // Management
  initializeDatabase,

  // Functions for Rust
  load_block_from_db,
  get_tip_height_from_db,
  save_total_work_to_db,
  get_total_work_from_db,

  // Functions for JS Worker (db.cjs)
  saveBlock,
  loadBlock,
  getTipHeight,
  getChainTip,
  getAllBlocks,
  loadBlocks,
    saveBlockWithHash,
  loadBlockByHash,
  
  // Deferred blocks
  saveDeferredBlock,
  loadAllDeferredBlocks,
  clearDeferredBlocks,
  
  // Wallet functions
  walletExists,
  loadWallet,
  saveWallet,
  isWalletEncrypted,
  saveTotalWork,
  loadTotalWork,

  // UTXO functions
  save_utxo,
  load_utxo,
  delete_utxo,
  clear_all_utxos,


  // Functions for JS Worker (utils.cjs)
  JSONStringifyWithBigInt,
  JSONParseWithBigInt,
  generateId,
  deleteCanonicalBlock,
  setTipMetadata,
  // For testing
  __setDbs,
  save_block_to_staging,
  commit_staged_reorg,
  save_reorg_marker,
  clear_reorg_marker,
  check_incomplete_reorg,
};
