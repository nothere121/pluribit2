// worker.js
if (typeof CustomEvent === 'undefined') {
  class CustomEvent extends Event {
    constructor(type, options) {
      super(type, options);
      this.detail = options?.detail || null;
    }
  }
  global.CustomEvent = CustomEvent;
}
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
import bridge from './js_bridge.cjs';
const { JSONStringifyWithBigInt, JSONParseWithBigInt } = bridge;
import { pipe } from 'it-pipe';

import { parentPort, Worker as ThreadWorker } from 'worker_threads';
import crypto from 'crypto';    
import path from 'path';
import { fileURLToPath } from 'url';
import { multiaddr } from '@multiformats/multiaddr';
import { CONFIG } from './config.js';
let blockRequestCleanupTimer = null;

// --- MODULE IMPORTS ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Manually expose DB functions to the global scope for Wasm
import * as db from './js_bridge.cjs';
global.load_block_from_db = db.load_block_from_db;
global.get_tip_height_from_db = db.get_tip_height_from_db;
global.save_total_work_to_db = db.save_total_work_to_db;
global.get_total_work_from_db = db.get_total_work_from_db;
global.loadBlocks = db.loadBlocks;
global.saveBlock = db.saveBlock;
global.save_utxo = db.save_utxo;
global.load_utxo = db.load_utxo;
global.delete_utxo = db.delete_utxo;
global.clear_all_utxos = db.clear_all_utxos;
global.saveBlockWithHash = db.saveBlockWithHash;
global.loadBlockByHash = db.loadBlockByHash;
global.save_reorg_marker = db.save_reorg_marker;
global.clear_reorg_marker = db.clear_reorg_marker;
global.check_incomplete_reorg = db.check_incomplete_reorg;
global.save_block_to_staging = db.save_block_to_staging;
global.commit_staged_reorg = db.commit_staged_reorg;


const wasmPath = path.join(__dirname, './pkg-node/pluribit_core.js');
const { default: init, ...pluribit } = await import(wasmPath);


import { PluribitP2P, TOPICS } from './libp2p-node.js';

const walletOperationQueues = new Map(); // walletId -> Promise chain



process.on('uncaughtException', (err) => {
  const msg = err?.stack || err?.message || String(err);
  if (parentPort) parentPort.postMessage({ type: 'log', payload: { level: 'error', message: `uncaughtException: ${msg}` } });
});

process.on('unhandledRejection', (reason) => {
  const name = reason?.name || '';
  const msg  = reason?.message || '';
  const isAbort = name === 'AbortError' || /aborted/i.test(msg);

  const text = isAbort
    ? `unhandledRejection (Abort): ${msg || String(reason)}`
    : (reason?.stack || msg || String(reason));

  if (parentPort) {
    parentPort.postMessage({
      type: 'log',
      payload: { level: isAbort ? 'debug' : 'error', message: text }
    });
  }
});

// helper to avoid crashing on timer callbacks
const safe = (fn) => (...args) => {
  try { return fn(...args); }
  catch (e) {
    const msg = e?.stack || e?.message || String(e);
    if (parentPort) parentPort.postMessage({ type: 'log', payload: { level: 'error', message: `Fatal in ${fn.name}: ${msg}` } });
  }
};

// --- MUTEX IMPLEMENTATION ---
class Mutex {
    constructor() {
        this._promise = Promise.resolve();
    }
    
    async acquire() {
        let releaseFunction;
        const newPromise = new Promise(resolve => {
            releaseFunction = resolve;
        });
        
        const currentPromise = this._promise;
        this._promise = currentPromise.then(() => newPromise);
        
        await currentPromise;
        return releaseFunction;
    }
    
    async run(fn) {
        const release = await this.acquire();
        try {
            return await fn();
        } finally {
            release();
        }
    }
}
const globalMutex = new Mutex();

// --- REORG STATE ---
const reorgState = {
    pendingForks: new Map(),
    requestedBlocks: new Set(),   // hashes currently requested
    requestedAt: new Map(),       // hash -> timestamp (ms)
};

// De-dupe & auto-GC stuck requests
const REQUEST_TTL_MS = 15000;
function trackRequest(hash) {
  reorgState.requestedBlocks.add(hash);
  reorgState.requestedAt.set(hash, Date.now());
  setTimeout(() => {
    const t0 = reorgState.requestedAt.get(hash);
    if (t0 && Date.now() - t0 >= REQUEST_TTL_MS) {
      reorgState.requestedBlocks.delete(hash);
      reorgState.requestedAt.delete(hash);
    }
  }, REQUEST_TTL_MS + 50);
}



// --- SYNC STATE (best tip seen from peers) ---
const syncState = {
  // State for accumulating hash chunks
  hashRequestState: new Map(), // requestId -> { hashes: [], resolve, reject }
  // : track sync progress
  syncProgress: {
    currentHeight: 0,
    targetHeight: 0,
    // RATIONALE (Hardening): Adds a simple state machine to prevent invalid or concurrent syncs.
    // This stops a new sync from starting while another is already in the sensitive download phase.
    status: 'IDLE', // IDLE | CONSENSUS | DOWNLOADING
  },
  // RATIONALE (Fix #6): Rate limiting for peers requesting hashes *from us*.
  // This prevents a single peer from spamming our node with expensive DB lookups.
  peerHashRequestTimes: new Map(), // peerId -> lastRequestTimestamp
  // RATIONALE (Circuit Breaker): Tracks failures to halt sync if the network is unreliable or under attack.
  consecutiveFailures: 0,
  // RATIONALE (Fix #5): A dedicated mutex for the hash request state.
  hashRequestMutex: new Mutex()
};

const blockRequestState = {
    // --- State for reassembling chunked blocks ---
    blockChunkAssembler: new Map(), // chunkId -> { hash, total_chunks, chunks: [], received_chunks, timer }
    peerRequests: new Map(), // peer -> Map(blockHash -> lastRequestTime)
    globalRequests: new Map(), // blockHash -> Set(peerIds)
    MAX_PEERS_PER_BLOCK: 3,
    MIN_REQUEST_INTERVAL: 1000, // 1 second between same block requests
    CLEANUP_INTERVAL: 60000 // Clean up old entries every minute
};
// --- WORKER STATE  ---
export const workerState = {
    initialized: false,
    minerActive: false,
    minerId: null,
    p2p: null,
    wallets: new Map(),
    miningWorker: null,
    currentJobId: 0,    
    isReorging: false,
    wasMinerActiveBeforeReorg: false,
    isSyncing: false, 
    isDownloadingChain: false, 
    // RATIONALE (Peer Scoring): A graduated penalty system is better than an immediate ban.
    // Peers start with a score of 100 and lose points for bad behavior.
    peerScores: new Map(), // peerId -> score
};


// --- MINER CONTROL HELPERS ---
let minerIdleWaiters = [];
function waitForMiningIdle(timeoutMs = 2000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        minerIdleWaiters.push(() => { clearTimeout(timer); resolve(true); });
    });
}

function attachMiningWorkerHandlers(worker) {
    worker.on('message', async (msg) => {
        if (msg.type === 'CANDIDATE_FOUND') {
            await handleMiningCandidate(msg.candidate, msg.jobId);
        } else if (msg.type === 'STATUS') {
            log(msg.message, 'debug');
            if (/Mining (stopped|loop ended)/i.test(msg.message)) {
                const waiters = minerIdleWaiters.splice(0);
                waiters.forEach(fn => fn());
            }
        }
    });
}

async function abortCurrentMiningJob(timeoutMs = 2000) {
    if (!workerState.miningWorker) return;
    const done = waitForMiningIdle(timeoutMs);
    try {
        workerState.miningWorker.postMessage({ type: 'STOP' });
    } catch {}
    await done;
}

// --- LOGGING ---
function log(message, level = 'info') {
    if (parentPort) {
        parentPort.postMessage({ type: 'log', payload: { message, level } });
    } else {
        console.log(`[WORKER LOG - ${level.toUpperCase()}]: ${message}`);
    }
}




// --- MAIN EXECUTION ---
export async function main() {
    log('Worker starting initialization...');
    parentPort.on('message', async (event) => {
        const { action, ...params } = event;
        try {
            switch (action) {
                case 'initializeNetwork': await initializeNetwork(); break;
                case 'initWallet': await handleInitWallet(params); break;
                case 'inspectBlock':
                    try {
                        const height = parseInt(params.height);
                        const block = await load_block_from_db(height);
                        if (block) {
                            const coinbase = block.transactions[0];
                            log(`Block ${height} coinbase has ${coinbase.outputs.length} output(s)`);
                            log(`Kernel fee: ${coinbase.kernels[0].fee}`);
                            log(`Total transaction count: ${block.transactions.length}`);
                            
                            // Show who each output goes to
                            for (let i = 0; i < coinbase.outputs.length; i++) {
                                const out = coinbase.outputs[i];
                                log(`  Output ${i}: commitment=${out.commitment.slice(0, 16)}...`);
                                log(`    has ephemeral_key: ${!!out.ephemeral_key}`);
                                log(`    has stealth_payload: ${!!out.stealth_payload}`);
                            }
                        } else {
                            log(`Block ${height} not found`);
                        }
                    } catch(e) {
                        log(`Error inspecting block: ${e.message}`, 'error');
                    }
                    break;
                case 'loadWallet': 
                    await handleLoadWallet(params);
                    
                    // DEBUG: Check for duplicate commitments
                    const walletId = params.walletId; // ✅ Extract from params
                    const walletJson = await pluribit.wallet_session_export(walletId);
                    const wallet = JSON.parse(walletJson);
                    
                    const commitments = new Set();
                    const duplicates = [];
                    
                    for (const utxo of wallet.owned_utxos || []) {
                        const key = Buffer.from(utxo.commitment).toString('hex');
                        if (commitments.has(key)) {
                            duplicates.push(key);
                        }
                        commitments.add(key);
                    }
                    
                    if (duplicates.length > 0) {
                        log(`⚠️  Wallet ${walletId} has ${duplicates.length} duplicate UTXOs!`);
                        duplicates.forEach(d => log(`  Duplicate: ${d.slice(0, 16)}...`));
                    } else {
                        log(`✅ Wallet ${walletId} has no duplicates (${commitments.size} unique UTXOs)`);
                    }
                    break;
                case 'createTransaction': await handleCreateTransaction(params); break;
                case 'setMinerActive':
                    if (!params.active) {
                        await stopMining();
                    } else {
                        workerState.minerActive = true;
                        workerState.minerId = params.minerId;
                        await startPoSTMining(); // Use the worker-based mining
                    }
                    parentPort.postMessage({ type: 'minerStatus', payload: { active: params.active } });
                    break;
                case 'getBalance':
                    try {
                        // Call the session-based balance function directly.
                        if (!workerState.wallets.has(params.walletId)) {
                           throw new Error("Wallet session not active. Please load the wallet.");
                        }
                        const balance = await pluribit.wallet_session_get_balance(params.walletId);
                        parentPort.postMessage({ type: 'walletBalance', payload: { wallet_id: params.walletId, balance: balance }});
                    } catch(e) {
                        log(`Could not get balance: ${e}`, 'error');
                    }
                    break;
                case 'getMiningParams':
                    try {
                        const params = await pluribit.get_current_mining_params();
                        log(`[STATUS] Height: ${params.current_height}, Work: ${params.total_work}, VDF Iters: ${params.vdf_iterations}`);
                    } catch (e) {
                        log(`Could not get params: ${e}`, 'error');
                    }
                    break;
                case 'getPeers':
                    if (workerState.p2p) {
                        const peers = workerState.p2p.getConnectedPeers().map(p => ({ id: p.id.toString() }));
                        parentPort.postMessage({ type: 'peerList', payload: peers });
                    }
                    break;
                case 'connectPeer':
                    if (workerState.p2p) {
                        try {
                            const addrStr = String(params.address || '');
                            const allowPrivate = process.env.PLURIBIT_ALLOW_PRIVATE_DIALS === '1';
                            // More comprehensive private IP check
                            const privatePatterns = [
                                /^\/ip4\/127\./,
                                /^\/ip4\/0\.0\.0\.0/,
                                /^\/ip4\/10\./,
                                /^\/ip4\/192\.168\./,
                                /^\/ip4\/172\.(1[6-9]|2[0-9]|3[01])\./,
                                /^\/ip6\/::1/,
                                /^\/ip6\/fe80::/
                            ];
                            
                            if (!allowPrivate && privatePatterns.some(p => p.test(addrStr))) {
                                throw new Error('Refusing to dial private/loopback address (set PLURIBIT_ALLOW_PRIVATE_DIALS=1 to override)');
                            }
                            
                            const addr = multiaddr(addrStr);
                            await workerState.p2p.node.dial(addr);
                            log(`Manually connected to ${params.address}`, 'success');
                            setTimeout(() => bootstrapSync(), 400);
                        } catch (e) {
                            log(`Failed to connect: ${e.message}`, 'error');
                        }
                    }
                    break;

                case 'auditDetailed':
                    try {
                        const tip = await db.getTipHeight();
                        console.log(`Tip height: ${tip}`);
                        for (let h = 0; h <= Math.min(tip, 5); h++) {
                            const block = await db.loadBlock(h);
                            const coinbase = block.transactions.find(tx => tx.inputs.length === 0);
                            console.log(`Block ${h}: ${coinbase ? coinbase.outputs.length + ' coinbase outputs' : 'no coinbase'}`);
                        }
                    } catch(e) {
                        log(`Audit failed: ${e}`, 'error');
                    }
                    break;

                case 'verifySupply':
                    try {
                        const tip = await db.getTipHeight();
                        let totalCoinbaseOutputs = 0;
                        let uniqueCommitments = new Set();
                        
                        for (let h = 1; h <= tip; h++) {
                            const block = await db.loadBlock(h);
                            for (const tx of block.transactions) {
                                if (tx.inputs.length === 0) { // Coinbase
                                    for (const output of tx.outputs) {
                                        totalCoinbaseOutputs++;
                                        uniqueCommitments.add(output.commitment.toString());
                                    }
                                }
                            }
                        }
                        
                        log(`Total coinbase outputs created: ${totalCoinbaseOutputs}`, 'info');
                        log(`Unique commitments: ${uniqueCommitments.size}`, 'info');
                        log(`Expected: 50 (one per block)`, 'info');
                        
                        // Check current UTXO set size
                        const utxoSetSize = await pluribit.get_utxo_set_size();
                        log(`Current UTXO set size: ${utxoSetSize}`, 'info');
                        
                    } catch(e) {
                        log(`Verify failed: ${e}`, 'error');
                    }
                    break;

                case 'checkMiners':
                    try {
                        const tip = await db.getTipHeight();
                        const aliceAddr = 'pb1kpytpt9plch2dmd34wv3sq0md3zsd9nwrk9ucxmaqtcvz5skqy5q4j583s';
                        const bobAddr = 'pb1rz4dsfzuxsr9lcvlwy3e7mqxslpk55s8luhv4ry0dg64l0tl6frqk2tvnv';
                        
                        let aliceBlocks = 0;
                        let bobBlocks = 0;
                        let unknownBlocks = 0;
                        
                        for (let h = 1; h <= tip; h++) {
                            const block = await db.loadBlock(h);
                            const coinbase = block.transactions[0];
                            // Check which wallet can see this output
                            // This requires checking the stealth keys
                            console.log(`Block ${h}: miner_pubkey = ${block.miner_pubkey ? '...' + Buffer.from(block.miner_pubkey).toString('hex').slice(-8) : 'none'}`);
                        }
                        
                        log(`Blocks mined by Alice: ${aliceBlocks}`, 'info');
                        log(`Blocks mined by Bob: ${bobBlocks}`, 'info');
                        log(`Unknown: ${unknownBlocks}`, 'info');
                    } catch(e) {
                        log(`Check failed: ${e}`, 'error');
                    }
                    break;

                //audit total supply
                case 'getSupply':
                    try {
                        // Debug: check both sources
                        const dbTip = await db.getTipHeight();
                        const rustTip = await pluribit.get_blockchain_state();
                        log(`DB tip: ${dbTip}, Rust chain state tip: ${rustTip.current_height}`, 'info');
                        
                        const supplyString = await pluribit.audit_total_supply();
                        parentPort.postMessage({ type: 'totalSupply', payload: { supply: supplyString } });
                    } catch (e) {
                        const msg = e?.message || String(e);
                        log(`Could not get supply: ${msg}`, 'error');
                        parentPort.postMessage({ type: 'error', error: `Supply audit failed: ${msg}` });
                    }
                    break;
                    
                case 'shutdown':
                  await gracefulShutdown(0); // the worker’s gracefulShutdown closes libp2p & miner, then process.exit(0)
                  break;
            }
        } catch (error) {
            const msg = (error && error.message) ? error.message : String(error);
            log(`Error handling action '${action}': ${msg}`, 'error');
            parentPort.postMessage({ type: 'error', error: msg });
        }
    });
}


async function fetchBlockDirectly(peerId, hash) {
    const NET = process.env.PLURIBIT_NET || 'mainnet';
    const BLOCK_TRANSFER_PROTOCOL = `/pluribit/${NET}/block-transfer/1.0.0`;

    // 1. First, attempt a direct, high-performance stream connection.
    try {
        const connection = workerState.p2p.node.getConnections(peerId)[0];
        if (!connection) {
            // This is a common, non-fatal error if a peer disconnects during sync.
            throw new Error(`No stable connection to peer ${peerId}`);
        }

        const stream = await connection.newStream(BLOCK_TRANSFER_PROTOCOL);
        const request = JSON.stringify({ type: 'GET_BLOCK', hash: hash });
        await pipe([new TextEncoder().encode(request)], stream.sink);

        const chunks = [];
        for await (const chunk of stream.source) {
            chunks.push(chunk.subarray());
        }
        const response = JSONParseWithBigInt(new TextDecoder().decode(Buffer.concat(chunks)));

        if (response.type === 'BLOCK_DATA' && response.payload) {
            reorgState.requestedBlocks.delete(hash);
            reorgState.requestedAt.delete(hash);
            return response.payload;
        }
        return null;
    } catch (e) {
        log(`Direct fetch for ${hash.substring(0, 12)} failed: ${e.message}. Falling back to pubsub.`, 'debug');

        // 2. FALLBACK: If the direct stream fails, broadcast a general request.
        try {
            // This promise will be resolved by the general TOPICS.BLOCKS handler when the block arrives.
            const { promise, resolve } = Promise.withResolvers();
            const timeout = setTimeout(() => resolve(null), 7000); // 7-second timeout for the fallback.

            const temporaryHandler = (message) => {
                if (message.payload && message.payload.hash === hash) {
                    clearTimeout(timeout);
                    // IMPORTANT: We must remove this temporary listener once the block is found.
                    const handlers = workerState.p2p.handlers.get(TOPICS.BLOCKS) || [];
                    const index = handlers.indexOf(temporaryHandler);
                    if (index > -1) {
                        handlers.splice(index, 1);
                    }
                    resolve(message.payload);
                }
            };
            
            // Temporarily add our specific resolver to the list of general block handlers.
            if (!workerState.p2p.handlers.has(TOPICS.BLOCKS)) {
                 workerState.p2p.handlers.set(TOPICS.BLOCKS, []);
            }
            workerState.p2p.handlers.get(TOPICS.BLOCKS).push(temporaryHandler);
            
            // Publish the request to the general topic that all nodes listen to.
            await workerState.p2p.publish(TOPICS.BLOCK_REQUEST, { hash });

            return await promise;
        } catch (fallbackError) {
            log(`Pubsub fallback failed for ${hash.substring(0, 12)}: ${fallbackError.message}`, 'warn');
            return null;
        }
    }
}

// RATIONALE: Parallel block fetcher to download from multiple peers, increasing
// resilience against a single peer failing or being slow.
async function fetchBlocksParallel(blockHashes, peerIds) {
    // --- RATIONALE (Fix #7): Limit concurrent requests per peer ---
    // Previously, a malicious peer could provide a long list of hashes, forcing our node
    // to amplify its network traffic by making many parallel requests to honest peers.
    // We now limit concurrent requests *per peer* to prevent this amplification.

    const results = new Map(); 
    const pending = new Set(blockHashes);
    const inFlight = new Map(); 
    const peerInFlightCounts = new Map(peerIds.map(p => [p, 0]));
    const MAX_IN_FLIGHT_PER_PEER = 2;
    
    // Round-robin peer selection
    let peerIndex = 0;
    const getNextPeer = () => {
        const peer = peerIds[peerIndex % peerIds.length];
        peerIndex++;
        return peer;
    };
    
    while (pending.size > 0 || inFlight.size > 0) {
        const { PARALLEL_DOWNLOADS, MAX_FETCH_ATTEMPTS } = CONFIG.SYNC;

        // Start new downloads up to limit
        while (inFlight.size < PARALLEL_DOWNLOADS && pending.size > 0) {
            const hash = pending.values().next().value;

            // Find a peer that is not at its concurrent request limit
            let peer = null;
            for (let i = 0; i < peerIds.length; i++) {
                const candidate = getNextPeer();
                if ((peerInFlightCounts.get(candidate) || 0) < MAX_IN_FLIGHT_PER_PEER) {
                    peer = candidate;
                    break;
                }
            }
            if (!peer) break; // All available peers are busy, wait for a slot.

            pending.delete(hash);
            peerInFlightCounts.set(peer, (peerInFlightCounts.get(peer) || 0) + 1);


            const fetchPromise = (async () => {
                for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
                    const block = await fetchBlockDirectly(peer, hash);
                    if (block) {
                        results.set(hash, block);
                        return { hash, success: true, peer };
                    }
                    if (attempt < MAX_FETCH_ATTEMPTS) {
                        await new Promise(r => setTimeout(r, 100 * attempt)); // Exponential backoff
                    }
                }
                return { hash, success: false, peer };
            })();
            
            inFlight.set(hash, fetchPromise);
        }
        
        // Wait for at least one to complete
        if (inFlight.size > 0) {
            const completed = await Promise.race(inFlight.values());

            // Decrement the counter for the peer that just finished
            peerInFlightCounts.set(completed.peer, (peerInFlightCounts.get(completed.peer) || 1) - 1);
            
            inFlight.delete(completed.hash);

            if (!completed.success) {
                log(`[SYNC] Failed to fetch block ${completed.hash.substring(0, 12)} after ${MAX_FETCH_ATTEMPTS} attempts`, 'warn');
            }
        }
    }
    
    return results;
    }
    
    // Forward sync implementation
async function syncForward(targetHeight, targetHash, trustedPeers) {
    // RATIONALE (State Machine): Prevent multiple syncs from running concurrently.
    if (syncState.syncProgress.status !== 'IDLE') {
        log('[SYNC] Sync process already running. Skipping new request.', 'warn');
        return;
    }
    // RATIONALE (Circuit Breaker): Halt sync if there are too many consecutive failures.
    if (syncState.consecutiveFailures >= CONFIG.SYNC.MAX_CONSECUTIVE_SYNC_FAILURES) {
        log(`[SYNC] Halting sync due to ${syncState.consecutiveFailures} consecutive failures. Requires manual restart or cooldown.`, 'error');
        return;
    }

    syncState.syncProgress.status = 'DOWNLOADING';

    const { TIMEOUT_MS, BATCH_SIZE, CHECKPOINT_INTERVAL, MAX_HASHES_PER_SYNC } = CONFIG.SYNC;

    const startTime = Date.now();
    try {
        let currentHeight = await db.getTipHeight();
        let previousBlock = await db.loadBlock(currentHeight);
        syncState.syncProgress.currentHeight = currentHeight;
        syncState.syncProgress.targetHeight = targetHeight;

        if (!trustedPeers || trustedPeers.length === 0) {
            log('[SYNC] No verified Pluribit peers available for sync. Waiting for connections...', 'warn');
            return;
        }
        
        // --- RATIONALE: Cross-validate hashes with multiple peers ---
        // Previously, we trusted the first peer for the entire hash list. Now, we fetch
        // the list from up to 3 peers and ensure they agree. This prevents a single
        // malicious peer from feeding us a bogus chain structure.
        const peersToQuery = trustedPeers.slice(0, 3);
        const hashLists = await Promise.all(
            peersToQuery.map(peer => requestAllHashes(peer, currentHeight))
        );

        if (hashLists.some(list => list.length > MAX_HASHES_PER_SYNC)) {
            throw new Error(`Peer provided hash list larger than limit of ${MAX_HASHES_PER_SYNC}`);
        }

        // Validate that the lists are identical.
        const firstList = hashLists[0];
        for (let i = 1; i < hashLists.length; i++) {
            if (hashLists[i].length !== firstList.length || 
                (firstList.length > 0 && hashLists[i][hashLists[i].length - 1] !== firstList[firstList.length - 1])) {
                throw new Error('Peer hash lists do not match. Aborting sync.');
            }
        }

        const allHashes = firstList;

        if (allHashes.length === 0) {
            log(`[SYNC] Already at target height`, 'info');
            return;
        }
        
        log(`[SYNC] Need to download ${allHashes.length} blocks from height ${currentHeight + 1} to ${targetHeight}`, 'info');
        

        // --- RATIONALE (Fix #3, #8, Timestamp/Sequence Validation): Stream-validate blocks ---
        // The old logic downloaded an entire batch of blocks before validating any.
        // This new logic fetches and validates blocks sequentially within a batch. If any block is
        // invalid or out of sequence, the process aborts immediately.

        for (let i = 0; i < allHashes.length; i += BATCH_SIZE) {
            if (Date.now() - startTime > TIMEOUT_MS) {
                throw new Error(`SYNC: Timeout after ${i} blocks`);
            }

            const batchHashes = allHashes.slice(i, i + BATCH_SIZE);
            log(`[SYNC] Processing batch of ${batchHashes.length} blocks (height ${currentHeight + 1}...)`, 'info');

            // RATIONALE (Peer Scoring): Filter out peers with low scores.
            const availablePeers = trustedPeers.filter(p => (workerState.peerScores.get(p) || 100) > 0);
            if (availablePeers.length === 0) {
                throw new Error("No trustworthy peers available for block download.");
            }

            const blockResults = await fetchBlocksParallel(batchHashes, availablePeers);

            // Process this small batch sequentially to ensure chain continuity.
            for (const hash of batchHashes) {
                const block = blockResults.get(hash);
                if (!block) throw new Error(`Failed to fetch required block ${hash}`);
                if (block.hash !== hash) throw new Error(`Fetched block hash mismatch for ${hash}`);

                // RATIONALE (Vulnerability #2 - Block Sequence): Verify blocks chain together.
                if (previousBlock && block.prev_hash !== previousBlock.hash) {
                    throw new Error(`Block sequence broken at height ${block.height}. Expected prev_hash ${previousBlock.hash}`);
                }
                // RATIONALE (Vulnerability #6 - Timestamps): Ensure time is monotonic.
                if (previousBlock && block.timestamp <= previousBlock.timestamp) {
                    throw new Error(`Block at height ${block.height} has a non-monotonic timestamp.`);
                }
                const result = await pluribit.ingest_block(block);
                
                if (result.type === 'invalid') {
                    // RATIONALE (Peer Scoring): If we get an invalid block, penalize all peers
                    // who claimed to have this chain tip, as one of them is lying.
                    const PENALTY = 25; // Score penalty for providing an invalid block.
                    log(`[SYNC] Invalid block ${hash} received. Penalizing ${trustedPeers.length} peers.`, 'warn');
                    for (const peer of trustedPeers) {
                        const currentScore = workerState.peerScores.get(peer) || 100;
                        const newScore = Math.max(0, currentScore - PENALTY);
                        workerState.peerScores.set(peer, newScore);
                        log(`[SYNC] Peer ${peer.slice(-6)} score: ${currentScore} -> ${newScore}`, 'debug');
                        if (newScore === 0) {
                            log(`[SYNC] Peer ${peer.slice(-6)} score reached 0. Disconnecting.`, 'warn');
                            try { workerState.p2p.node.hangUp(peer); } catch(e) {}
                        }
                    }
                    throw new Error(`Invalid block ${hash}: ${result.reason}`);
                } else if (result.type === 'needParent') {
                    throw new Error(`Sync process integrity failure: received needParent for sequential block ${hash}`);
                }
                
                syncState.syncProgress.currentHeight = block.height;
                
                if (block.height % CHECKPOINT_INTERVAL === 0) {
                    const chainState = await pluribit.get_blockchain_state();
                    await db.saveTotalWork(chainState.total_work); // Persist work progress
                    log(`[SYNC] Checkpoint saved at height ${block.height}`, 'info');
                }
                
                // Update wallets periodically
                if (block.height % 100 === 0) {
                    for (const walletId of workerState.wallets.keys()) {
                        await pluribit.wallet_session_scan_block(walletId, block);
                    }
                }
                // Update previousBlock for the next iteration.
                previousBlock = block;
                currentHeight = block.height;
            }

        }
        
        log(`[SYNC] Completed sync to height ${targetHeight}`, 'success');        
        
    
        // RATIONALE (Circuit Breaker): Reset failure count on a successful sync.
        syncState.consecutiveFailures = 0;
    } catch (e) {
        log(`[SYNC] Sync failed: ${e.message}`, 'error');
        // RATIONALE (Circuit Breaker): Increment failure count.
        syncState.consecutiveFailures++;
    } finally {
        syncState.syncProgress.status = 'IDLE'; // Always reset state
    }
}




async function startPoSTMining() {
    if (!workerState.minerActive) return;
    
    // Ensure mining worker exists
    if (!workerState.miningWorker) {
        workerState.miningWorker = new ThreadWorker(new URL('./mining-worker.js', import.meta.url));
        attachMiningWorkerHandlers(workerState.miningWorker);
    }
    
    // Get current chain state
    const chain = await pluribit.get_blockchain_state();
    
    // Get the miner's secret key
    const minerSecretKey = await pluribit.wallet_session_get_spend_privkey(workerState.minerId);

    // Abort any in-flight job, then send a fresh mining job
    await abortCurrentMiningJob();    
    
    // Send mining job to worker
    workerState.currentJobId++;
    workerState.miningWorker.postMessage({
        type: 'MINE_BLOCK',
        jobId: workerState.currentJobId,
        height: BigInt(chain.current_height) + 1n,
        minerPubkey: await pluribit.wallet_session_get_spend_pubkey(workerState.minerId),
        minerSecretKey: minerSecretKey,  // Add the secret key
        prevHash: await pluribit.get_latest_block_hash(),
        vrfThreshold: Array.from(chain.current_vrf_threshold),
        vdfIterations: chain.current_vdf_iterations
    });
}

async function stopMining() {
    workerState.minerActive = false;
    // If using the separate mining worker thread
    if (workerState.miningWorker) {
        // Simply send the stop signal, don't terminate the thread.
        workerState.miningWorker.postMessage({ type: 'STOP' });
    }
}

async function handleMiningCandidate(candidate, jobId) {
    // Invalidate candidates from stale jobs
    if (jobId !== workerState.currentJobId) {
        log(`[MINING] Ignoring stale candidate from old job #${jobId}`, 'debug');
        return;
    }

    // The candidate already won the lottery in the worker!
    log(`[MINING] ✨ Received winning block candidate from worker!`, 'success');

    // Assemble the full block
    const block = await pluribit.complete_block_with_transactions(
        BigInt(candidate.height),
        candidate.prevHash,
        BigInt(candidate.nonce),
        candidate.miner_pubkey,
        await pluribit.wallet_session_get_scan_pubkey(workerState.minerId),
        candidate.vrf_proof,  // VRF proof already computed in worker
        candidate.vdf_proof,
        candidate.vrfThreshold,
        BigInt(candidate.vdfIterations),
        null
    );

    // Process the new block
    await handleRemoteBlockDownloaded({ block });
}



async function handleRemoteBlockDownloaded({ block }) {
  // If we're in the middle of a major sync, don't process new blocks.
  // Instead, queue them up to be processed once the sync is complete.
  if (workerState.isSyncing) {
    await db.saveDeferredBlock(block);
    return;
  }
  
    // NEW: Skip duplicate requests during chain download
  if (workerState.isDownloadingChain) {
    log(`[DEBUG] Skipping request handling during chain download for block ${block.height}`);
    return;
  }
  
  log(`[DEBUG] Processing block #${block.height} hash: ${block.hash.substring(0,12)}...`);
  try {
    await globalMutex.run(async () => {
    // Guard: ignore unsolicited genesis blocks
    if (Number(block.height) === 0 && !reorgState.requestedBlocks.has(block.hash)) {
      log(`Ignoring unsolicited genesis block broadcast`);
      return;
    }

    // 1) Let Rust decide what this block means.
    const result = await pluribit.ingest_block(block);
    const t = String(result?.type || '').toLowerCase();
    const reason = String(result?.reason || '').toLowerCase();
    log(`[DEBUG] ingest_block returned type: ${result?.type}, full result: ${JSON.stringify(result)}`);

    if (t === 'needparent'){
      const h = result.hash;
      if (!reorgState.requestedBlocks.has(h)) {
        trackRequest(h);
        const requestId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
        log(`Requesting missing parent ${h.substring(0,12)}...`, 'info');
        await workerState.p2p.publish(TOPICS.BLOCK_REQUEST, { type: 'BLOCK_REQUEST', hash: h, requestId });
      }
      return; // wait for parent
    }

    if (t === 'acceptedandextended') {
            console.log(`[MINING DEBUG] Broadcasting new block ${block.hash} to network`);

      // Announce by hash only after canonicalization
      try {
        await workerState.p2p.publish(TOPICS.BLOCK_ANNOUNCEMENTS, {
          type: 'BLOCK_SEEN',
          payload: { hash: block.hash, height: block.height }
        });
                console.log(`[MINING DEBUG] Block announcement sent`);

      } catch(e) {
                  console.error(`[MINING DEBUG] Failed to announce block:`, e);

          }
    
      // Also broadcast the full block so peers can ingest immediately
      try {
        await workerState.p2p.publish(TOPICS.BLOCKS, {
          type: 'BLOCK_DATA',
          payload: block
        });
        log(`[MINING DEBUG] Full block broadcast on ${TOPICS.BLOCKS}`, 'debug');
      } catch (e) {
        log(`[MINING DEBUG] Failed to publish full block: ${e?.message || e}`, 'warn');
      }
    

    

    log(`[DEBUG] Active wallets in workerState: ${Array.from(workerState.wallets.keys()).join(', ')}`);


      // Instead of passing wallet data back and forth, use the Rust session.
      for (const walletId of workerState.wallets.keys()) {
        try {
          // 1. Scan the block using the active Rust session. This returns nothing.
          await pluribit.wallet_session_scan_block(walletId, block);

          // 2. After scanning, export the new state from the Rust session.
          const updatedJson = await pluribit.wallet_session_export(walletId);

          // 3. Persist the updated wallet state to the database.
          await db.saveWallet(walletId, updatedJson);

          // RATIONALE: Proactively notify the UI of a balance change after a new
          // block is accepted, so the user sees updates in real-time.
          const newBalance = await pluribit.wallet_session_get_balance(walletId);
          parentPort.postMessage({ type: 'walletBalance', payload: { wallet_id: walletId, balance: newBalance }});
          log(`Balance updated for ${walletId} after new block.`, 'debug');

        } catch (e) {
          log(`Wallet scan/save failed for ${walletId}: ${e?.message || e}`, 'warn');
        }
      }
      
      // RATIONALE: When the chain extends, we must stop the current mining job
      // and start a new one with the updated height and previous block hash.
        // After block acceptance, restart the miner if it was active
        if (workerState.minerActive) {
            log('[MINING] New block accepted. Restarting miner for next block...', 'info');
            // Give it a moment before starting the new job
            (async () => { await abortCurrentMiningJob(); await startPoSTMining(); })();
        }
        return;
    }

    if (t === 'storedonside') {
        // CRITICAL: Wrap in guarded IIFE to prevent unhandled rejection
        (async () => {
            try {
                log(`[REORG] Block ${block.hash.substring(0,12)} is a fork tip. Planning reorg...`, 'warn');
                const plan = await pluribit.plan_reorg_for_tip(block.hash);

                if (plan.requests && plan.requests.length > 0) {
                    log(`[REORG] Plan requires missing parents. Requesting ${plan.requests.length} block(s)...`, 'info');
                    for (const hash of plan.requests) {
                        if (!reorgState.requestedBlocks.has(hash)) {
                            trackRequest(hash);
                            await workerState.p2p.publish(TOPICS.BLOCK_REQUEST, {
                                type: 'BLOCK_REQUEST',
                                hash: hash
                            });
                        }
                    }
                    return;
                }

                if (plan.should_switch) {
                    log(`[REORG] Fork is heavier. Applying reorg: -${plan.detach?.length||0} +${plan.attach?.length||0}`, 'warn');
                    workerState.wasMinerActiveBeforeReorg = workerState.minerActive;
                    const __resumeMining = workerState.minerActive;
                    await abortCurrentMiningJob();
                    workerState.isReorging = true;
                    await pluribit.atomic_reorg(plan);
                    workerState.isReorging = false;
                    if (__resumeMining) {
                      workerState.minerActive = true;
                      await startPoSTMining();
                    }
                    workerState.wasMinerActiveBeforeReorg = false;
                } else {
                    log(`No switch needed; staying on current canonical chain.`, 'info');
                }
            } catch (e) {
                // MORE ROBUST LOGGING
                const util = await import('node:util');
                const errorDetails = util.inspect(e, { depth: 5 });
                log(`[REORG] Failed to plan/execute reorg for ${block.hash}: ${errorDetails}`, 'error');
            }
        }
         )(); // Fire and forget with error handling
        return;
    }

    if (t === 'invalid') {
      log(`Invalid block rejected: ${result.reason ?? ''}`, 'warn');
      return;
    }

    log(`Unhandled ingest result: ${JSON.stringify(result)}`, 'debug');
    });
  } catch (e) {
    log(`Failed to process downloaded block: ${e.message || e}`, 'error');
    console.error(e);

  }
}



function cleanupForkCache(keepAboveHeight) {
    for (const height of reorgState.pendingForks.keys()) {
        if (height <= keepAboveHeight) {
            reorgState.pendingForks.delete(height);
        }
    }
    reorgState.requestedBlocks.clear();
    reorgState.requestedAt.clear();
}

// SIMPLIFIED Network Initialization
async function initializeNetwork() {

    log('Initializing Pluribit network...');

    
    // --- CRITICAL FIX #3: Verify genesis BEFORE touching database ---
    const CANONICAL_GENESIS_HASH = "cdc1fdcff58412076bbe011ddfde6071d9bcb74f54c088eecf6e15e771047b93";
    const generatedHash = await pluribit.get_genesis_block_hash();
    
    if (generatedHash !== CANONICAL_GENESIS_HASH) {
        const errorMsg = `CRITICAL: Genesis hash mismatch! Expected ${CANONICAL_GENESIS_HASH}, but got ${generatedHash}. Exiting to prevent network fork.`;
        log(errorMsg, 'error');
        return process.exit(1);
    }
    log('Genesis block hash verified successfully.', 'success');
    
    // Now it's safe to initialize database
    await db.initializeDatabase();

    // CRITICAL: Check for incomplete reorg before doing anything else
    const incompleteReorg = await db.check_incomplete_reorg();
    if (incompleteReorg) {
        log('[RECOVERY] Found incomplete reorg marker. Attempting to complete...', 'warn');
        try {
            // Reconstruct the reorg plan and complete it
            const plan = {
                attach: incompleteReorg.blocks_to_attach,
                new_tip_hash: incompleteReorg.new_tip_hash,
                new_height: incompleteReorg.new_tip_height,
                requests: [], // Already have all blocks
            };
            await pluribit.atomic_reorg(serde_wasm_bindgen.to_value(plan));
            log('[RECOVERY] Incomplete reorg completed successfully', 'success');
        } catch (e) {
            log(`[RECOVERY] Failed to complete reorg: ${e.message}`, 'error');
            return process.exit(1); // Cannot continue with inconsistent state
        }
    }


    // --- DATABASE AND RUST STATE INITIALIZATION ---
    // REMOVED: The old logic that loaded all blocks into an array.

    // Ensure genesis block exists in DB for new chains.
    const tipHeight = await db.getTipHeight();
    if (tipHeight === 0 && !(await db.loadBlock(0))) {
        log('Creating and saving new genesis block to DB.', 'info');
        // We get the genesis block from Rust and save it to the DB at height 0.
        const genesisBlock = await pluribit.create_genesis_block();
        await db.saveBlock(genesisBlock);
    }

    // NEW: Call the async Rust function to initialize its state from our DB.
    try {
        await pluribit.init_blockchain_from_db();
    } catch (e) {
        log(`Fatal error during Rust state initialization: ${e?.message ?? e}`, 'error');
        throw e;
    }
    
    log('Initializing P2P stack...');
    const tcpPort = process.env.PLURIBIT_TCP_PORT || CONFIG.P2P.TCP_PORT;
    const wsPort = process.env.PLURIBIT_WS_PORT || CONFIG.P2P.WS_PORT;

    log(`Attempting to start P2P node on TCP:${tcpPort} and WS:${wsPort} (use PLURIBIT_TCP_PORT/PLURIBIT_WS_PORT to override)`);

    workerState.p2p = new PluribitP2P(log, { 
      tcpPort: parseInt(tcpPort, 10), 
      wsPort: parseInt(wsPort, 10) 
    });

    await workerState.p2p.initialize();

    await setupMessageHandlers();

     // --- START: RATIONALE ---
     // Previously, this code would load and process ALL deferred blocks from the database
     // without a limit. An attacker could fill this database with junk, causing the node
    // to waste a huge amount of time or crash on startup. We now enforce a limit.
    const MAX_DEFERRED_BLOCKS_ON_STARTUP = 1000;
    try {
        let leftoverBlocks = await db.loadAllDeferredBlocks();
        if (leftoverBlocks.length > 0) {
            log(`[RECOVERY] Found ${leftoverBlocks.length} leftover deferred blocks. Processing now...`, 'warn');
            if (leftoverBlocks.length > MAX_DEFERRED_BLOCKS_ON_STARTUP) {
                log(`[RECOVERY] Capping processing to first ${MAX_DEFERRED_BLOCKS_ON_STARTUP} blocks.`, 'warn');
                leftoverBlocks = leftoverBlocks.slice(0, MAX_DEFERRED_BLOCKS_ON_STARTUP);
            }
            for (const block of leftoverBlocks) {
                await handleRemoteBlockDownloaded({ block });
            }
            await db.clearDeferredBlocks();
            log(`[RECOVERY] Finished processing leftover blocks.`, 'success');
        }
    } catch (e) {
        log(`Error during deferred block recovery: ${e.message}`, 'error');
    }

    // Kick off an initial attempt (will no-op if no peers yet)
    // Start the sync process after a brief pause for initial connections.
    // The bootstrapSync function itself will handle retries with backoff.
    const BASE_DELAY_MS = 2000;
    setTimeout(safe(bootstrapSync), BASE_DELAY_MS);

// RATIONALE: Prevent memory leaks from accumulating request history
blockRequestCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [peer, requests] of blockRequestState.peerRequests) {
        for (const [hash, time] of requests) {
            if (now - time > blockRequestState.CLEANUP_INTERVAL) {
                requests.delete(hash);
            }
        }
        if (requests.size === 0) {
            blockRequestState.peerRequests.delete(peer);
        }
    }
    
    // RATIONALE ( Memory Leak): Periodically clean up the hash request
    // rate-limiting map to prevent it from growing indefinitely with stale peer entries.
    const PEER_HASH_REQUEST_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
    const PEER_HASH_REQUEST_ENTRY_TTL = 15 * 60 * 1000; // 15 minutes
    setInterval(() => {
        const now = Date.now();
        for (const [peerId, timestamp] of syncState.peerHashRequestTimes.entries()) {
            if (now - timestamp > PEER_HASH_REQUEST_ENTRY_TTL) {
                syncState.peerHashRequestTimes.delete(peerId);
            }
        }
    }, PEER_HASH_REQUEST_CLEANUP_INTERVAL);
 }, blockRequestState.CLEANUP_INTERVAL);

async function gracefulShutdown(code = 0) {
  try {
    log('Shutting down...');
    workerState.minerActive = false;

    if (blockRequestCleanupTimer) clearInterval(blockRequestCleanupTimer);
    // give the mining loop a tick to exit
    await new Promise(r => setTimeout(r, 5));
    if (workerState.p2p) {
      await workerState.p2p.stop(); // closes mdns/ping/etc cleanly
    }
  } catch (e) {
    log(`Shutdown error: ${e?.message || e}`, 'warn');
  } finally {
    process.exit(code);
  }
}

process.on('SIGINT', () => gracefulShutdown(0));
process.on('SIGTERM', () => gracefulShutdown(0));



try {
  workerState.p2p.node.services.pubsub.addEventListener('subscription-change', (evt) => {
    const { subscriptions } = evt.detail || {};
    const peerSubbedSync = subscriptions?.some(s => s.topic === TOPICS.SYNC && s.subscribe);
    if (peerSubbedSync) {
      log('Peer subscribed to SYNC; bootstrapping…', 'info');
      setTimeout(safe(bootstrapSync), 200); // small grace period
    }
  });
} catch {}


    log('P2P stack online.', 'success');
    parentPort.postMessage({ type: 'networkInitialized' });
    log('Network initialization complete.', 'success');
}


// Ask peers for their tip, but only when someone is there to hear us.
// Retries with a short backoff if nobody is subscribed yet.
async function bootstrapSync(attempt = 1) {
  const MAX_ATTEMPTS = 5;
  const BASE_DELAY_MS = 2000; // Start with a 2-second delay

  const scheduleRetry = () => {
    if (attempt >= MAX_ATTEMPTS) {
        log(`[SYNC] Initial sync failed after ${MAX_ATTEMPTS} attempts. Will rely on new peer connections to trigger sync.`, 'warn');
        return;
    }
    // Exponential backoff: 2s, 4s, 8s, 16s
    const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
    log(`[SYNC] No verified peers responded. Retrying sync in ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`, 'info');
    setTimeout(() => bootstrapSync(attempt + 1), delay);
  };

  try {
    // RATIONALE (State Machine): Don't start a new consensus round if a sync is already in progress.
    if (syncState.syncProgress.status !== 'IDLE') {
        log('[SYNC] Bootstrap skipped: a sync is already in progress.', 'debug');
        return;
    }
    const { p2p } = workerState;
    if (!p2p || !p2p.node) return;

    const peers = p2p.getConnectedPeers?.() ?? [];
    if (peers.length === 0) {
      // Instead of just logging, schedule a retry.
      scheduleRetry();
      return;
    }

    
    // --- IBD CONSENSUS LOGIC ---
    const tipResponses = new Map(); // from -> { hash, height, totalWork }

    const tipHandler = (event) => {
        try {
            // --- Correctly parse event and verify peer ---
            const { from, data } = event.detail; // FIX 1: The data is on `event.detail`.
            const fromStr = from.toString();

            //Only accept responses from peers that have completed the challenge.
            if (!workerState.p2p.isPeerVerified(fromStr)) {
                return; 
            }

            const msgData = JSONParseWithBigInt(new TextDecoder().decode(data));

            if (msgData.type === 'TIP_RESPONSE') {
                tipResponses.set(fromStr, { // Use the string representation of the peer ID
                    hash: msgData.tipHash,
                    height: msgData.height,
                    totalWork: BigInt(msgData.totalWork)
                });
            }
           
        } catch (e) {
          // It's better to log this during debugging instead of failing silently.
          log(`[SYNC] Error in tipHandler: ${e?.message || e}`, 'warn');
      }
    };

    p2p.node.services.pubsub.addEventListener('message', tipHandler);
    syncState.syncProgress.status = 'CONSENSUS';
    await p2p.publish(TOPICS.SYNC, { type: 'TIP_REQUEST' });

    setTimeout(async () => {
        p2p.node.services.pubsub.removeEventListener('message', tipHandler);

        if (syncState.syncProgress.status !== 'CONSENSUS') return; // Aborted by another process
        syncState.syncProgress.status = 'IDLE'; // Reset state before exiting or proceeding


        if (tipResponses.size < 1) { // Min peers from user input
            scheduleRetry();
            return;
        }

        // Tally responses by tip hash
        const tallies = new Map();
        for (const [peer, tip] of tipResponses) {
            const key = tip.hash;
            if (!tallies.has(key)) tallies.set(key, { ...tip, peers: [] });
            tallies.get(key).peers.push(peer);
        }

        // Find the tip with the most agreement
        const consensusTip = [...tallies.values()].sort((a,b) => b.peers.length - a.peers.length)[0];

        // RATIONALE (Fix #4): Use stricter consensus rules.
        const { CONSENSUS_THRESHOLD, MIN_AGREEING_PEERS } = CONFIG.SYNC;
        const agreement = consensusTip.peers.length / tipResponses.size;
        
        if (agreement < CONSENSUS_THRESHOLD || consensusTip.peers.length < MIN_AGREEING_PEERS) {
            log(`[SYNC] No consensus on chain tip. Best candidate had ${Math.round(agreement*100)}% agreement.`, 'warn');
            return;
        }

        // Check if the consensus tip is better than our own
        const myState = await pluribit.get_blockchain_state();
        if (consensusTip.totalWork > BigInt(myState.total_work)) {
            log(`[SYNC] Consensus reached on better chain. Planning reorg...`);
            
            // Let Rust figure out what needs to happen
            const plan = await pluribit.plan_reorg_for_tip(consensusTip.hash);
            
            // If plan requests the tip block, fetch it first for work evaluation
            if (plan.requests && plan.requests.length === 1 && plan.requests[0] === consensusTip.hash) {
                log(`[SYNC] Fetching candidate tip block for work evaluation...`);
                let tipBlock = null;
                
                for (const peer of consensusTip.peers) {
                    tipBlock = await fetchBlockDirectly(peer, consensusTip.hash);
                    if (tipBlock) break;
                }
                
                if (!tipBlock) {
                    log(`[SYNC] Failed to fetch candidate tip. Will retry on next consensus.`, 'warn');
                    return;
                }
                
                // Ingest the tip block
                const ingestResult = await pluribit.ingest_block(tipBlock);
                log(`[SYNC] Ingested candidate tip: ${ingestResult.type}`);
                
                // Now retry the reorg plan with the tip available
                const newPlan = await pluribit.plan_reorg_for_tip(consensusTip.hash);
                
                if (newPlan.requests && newPlan.requests.length > 0) {
                    log(`[SYNC] Still need ${newPlan.requests.length} blocks. Requesting...`);
                    for (const hash of newPlan.requests) {
                        await workerState.p2p.publish(TOPICS.BLOCK_REQUEST, { hash });
                    }
                    return;
                }
                
                if (newPlan.should_switch) {
                    await pluribit.atomic_reorg(newPlan);
                }
                return;
            }
            
            
            
            if (plan.requests && plan.requests.length > 0) {
                // Missing blocks - request them
                for (const hash of plan.requests) {
                    await workerState.p2p.publish(TOPICS.BLOCK_REQUEST, { hash });
                }
            } else if (plan.should_switch) {
                // Have all blocks - execute reorg
                await pluribit.atomic_reorg(plan);
            }
        } else {
            log('[SYNC] Already synced to the best known chain.', 'info');
        }
    }, 2000); // Timeout from user input


  } catch (e) {
    const msg = String(e?.message || e);
    // Use the same retry logic for the specific pubsub error.
    if (msg.includes('NoPeersSubscribedToTopic')) {
      scheduleRetry();
      return;
    }
    log(`SYNC: unexpected error: ${msg}`, 'warn');
  }
}

async function requestAllHashes(peerId, startHeight) {
    // RATIONALE: This function has been refactored to prevent a deadlock.
    // The mutex is now acquired only to write to the shared state map, and
    // then released *before* awaiting the network response.

    const requestId = crypto.randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers();

    // 1. Acquire mutex ONLY to safely add the request to the shared map.
    const release = await syncState.hashRequestMutex.acquire();
    try {
        syncState.hashRequestState.set(requestId, { hashes: [], resolve, reject, peerId });
    } finally {
        release();
    }

    // 2. Set a timeout to prevent waiting forever. The cleanup is wrapped in a
    //    mutex operation to prevent race conditions.
    const timeout = setTimeout(() => {
        syncState.hashRequestMutex.run(async () => {
            if (syncState.hashRequestState.has(requestId)) {
                reject(new Error(`Hash request to peer ${peerId} timed out`));
                syncState.hashRequestState.delete(requestId);
            }
        }).catch(err => log(`[SYNC] Error during timeout cleanup: ${err.message}`, 'error'));
    }, 30000);

    try {
        // 3. Publish the request *after* releasing the lock.
        await workerState.p2p.publish(TOPICS.GET_HASHES_REQUEST, {
            start_height: startHeight,
            request_id: requestId
        });

        // 4. Await the promise. The response handler can now acquire the lock to resolve it.
        const fullHashes = await promise;
        clearTimeout(timeout);
        return fullHashes;
    } catch (error) {
        // 5. If any part of the process fails, ensure the timeout is cleared.
        clearTimeout(timeout);
        // Rethrow the error to be handled by the caller (syncForward).
        throw error;
    }
}




async function setupMessageHandlers() {
    const { p2p } = workerState;

    await p2p.subscribe(TOPICS.BLOCKS, async (message) => {
        const { type, payload } = message;

        switch (type) {
            case 'BLOCK_DATA':
                if (payload && payload.height !== undefined) {
                    log(`Received full block #${payload.height} from network`, 'info');
                    await handleRemoteBlockDownloaded({ block: payload });
                }
                break;

            case 'BLOCK_CHUNK_START':
                blockRequestState.blockChunkAssembler.set(payload.chunk_id, {
                    hash: payload.hash,
                    total_chunks: payload.total_chunks,
                    chunks: new Array(payload.total_chunks),
                    received_chunks: 0,
                    timer: setTimeout(() => {
                        blockRequestState.blockChunkAssembler.delete(payload.chunk_id);
                        log(`Chunked block assembly timed out for ${payload.hash.substring(0,12)}...`, 'warn');
                    }, 30000) // 30-second timeout
                });
                break;

            case 'BLOCK_CHUNK_DATA':
                const assembly = blockRequestState.blockChunkAssembler.get(payload.chunk_id);
                if (assembly && assembly.chunks[payload.index] === undefined) {
                    assembly.chunks[payload.index] = Buffer.from(payload.data, 'base64');
                    assembly.received_chunks++;
                }
                break;

            case 'BLOCK_CHUNK_END':
                const finalAssembly = blockRequestState.blockChunkAssembler.get(payload.chunk_id);
                if (finalAssembly && finalAssembly.received_chunks === finalAssembly.total_chunks) {
                    clearTimeout(finalAssembly.timer);
                    try {
                        const fullData = Buffer.concat(finalAssembly.chunks);
                        const block = JSONParseWithBigInt(new TextDecoder().decode(fullData));

                        if (block.hash === finalAssembly.hash) {
                            log(`Successfully reassembled chunked block #${block.height}`, 'success');
                            await handleRemoteBlockDownloaded({ block });
                        }
                    } finally {
                        blockRequestState.blockChunkAssembler.delete(payload.chunk_id);
                    }
                }
                break;
        }
    });

    // Handle incoming transactions (no change)
    await p2p.subscribe(TOPICS.TRANSACTIONS, async (message) => {
        if (message.payload) {
            try {
                log(`Received transaction from network`);
                await pluribit.add_transaction_to_pool(message.payload);
                log(`Added network transaction to pool.`);
            } catch (e) {
                log(`Failed to add network transaction: ${e}`, 'warn');
            }
        }
    });
    
    await p2p.subscribe(TOPICS.BLOCK_REQUEST, async (message, { from }) => {
        const { hash } = message;
        if (!hash) return;
        
        try {
            const block = await pluribit.get_block_by_hash(hash);
            if (block) {
                const blockString = JSONStringifyWithBigInt(block);
                const bytes = new TextEncoder().encode(blockString);

                if (bytes.byteLength <= CONFIG.MAX_MESSAGE_SIZE) {
                    // Block is small enough, send as a single message
                    await p2p.publish(TOPICS.BLOCKS, {
                        type: 'BLOCK_DATA',
                        payload: block
                    });
                } else {
                    // Block is too large, send it in chunks
                    log(`Block ${hash.substring(0,12)} is too large (${bytes.byteLength} bytes), sending in chunks...`, 'info');
                    const chunkId = crypto.randomUUID();
                    const chunkSize = CONFIG.MAX_MESSAGE_SIZE - 1024; // Use a safe chunk size with 1KB overhead
                    const totalChunks = Math.ceil(bytes.byteLength / chunkSize);

                    // 1. Send the start message
                    await p2p.publish(TOPICS.BLOCKS, {
                        type: 'BLOCK_CHUNK_START',
                        payload: {
                            chunk_id: chunkId,
                            total_chunks: totalChunks,
                            hash: block.hash
                        }
                    });

                    // 2. Send all the data chunks
                    for (let i = 0; i < totalChunks; i++) {
                        const start = i * chunkSize;
                        const end = start + chunkSize;
                        const chunkData = Buffer.from(bytes.subarray(start, end)).toString('base64');

                        await p2p.publish(TOPICS.BLOCKS, {
                            type: 'BLOCK_CHUNK_DATA',
                            payload: { chunk_id: chunkId, index: i, data: chunkData }
                        });
                    }

                    // 3. Send the end message
                    await p2p.publish(TOPICS.BLOCKS, {
                        type: 'BLOCK_CHUNK_END',
                        payload: { chunk_id: chunkId }
                    });
                }
            }
        } catch (e) {
            log(`Failed to serve block request: ${e.message}`, 'warn');
        }
    });
    

    // Handle lightweight block announcements (no change)
    await p2p.subscribe(TOPICS.BLOCK_ANNOUNCEMENTS, async (message, { from }) => {
        const { payload } = message || {};
        const h = payload?.hash;
        if (!h) return;
        try {
            const have = await pluribit.get_block_by_hash(h);
            if (have) return; // already have it
            if (reorgState.requestedBlocks.has(h)) return; // already requested

            trackRequest(h);
            log(`ANN: missing block ${h.substring(0,12)} from ${String(from).slice(-6)}; fetching directly…`, 'info');

            // Try direct stream fetch from the announcing peer first
            const direct = await fetchBlockDirectly(from, h);
            if (direct) {
              await handleRemoteBlockDownloaded({ block: direct });
              return;
            }

            // Fallback: broadcast a network request (pubsub)
            await p2p.publish(TOPICS.BLOCK_REQUEST, { type: 'BLOCK_REQUEST', hash: h });
        } catch (e) {
            log(`ANN handler error: ${e.message || e}`, 'warn');
        }
    });

    // Register block-transfer responder via P2P wrapper (libp2p-node will proxy to this)
    const NET = process.env.PLURIBIT_NET || 'mainnet';
    const BLOCK_TRANSFER_PROTOCOL = `/pluribit/${NET}/block-transfer/1.0.0`;
    await p2p.subscribe(BLOCK_TRANSFER_PROTOCOL, async (hash) => {
      try { return await pluribit.get_block_by_hash(hash); }
      catch { return null; }
    });


    // New handler to respond to hash requests from other peers
    await p2p.subscribe(TOPICS.GET_HASHES_REQUEST, async (message, { from }) => {

        // A node should not respond to its own requests.
        if (from.toString() === workerState.p2p.node.peerId.toString()) {
            return;
        }

        try {
            const { start_height, request_id } = message;
            // RATIONALE (Fix #6): Add rate limiting for this expensive request.
            const now = Date.now();
            const peerIdStr = from.toString();
            if ((now - (syncState.peerHashRequestTimes.get(peerIdStr) || 0)) < CONFIG.SYNC.MIN_HASH_REQUEST_INTERVAL_MS) {
                log(`[SYNC] Rate-limited hash request from ${peerIdStr}`, 'warn');
                return;
            }
            syncState.peerHashRequestTimes.set(peerIdStr, now);

            // RATIONALE (Fix #10): Validate the requested start height to prevent abuse.
            const tipHeight = await db.getTipHeight();
            if (start_height < tipHeight - CONFIG.SYNC.MAX_HASH_REQUEST_RANGE) {
                log(`[SYNC] Ignoring hash request for start height ${start_height} (too far behind tip ${tipHeight})`, 'warn');
                return;
            }

            const hashes = await pluribit.get_canonical_hashes_after(BigInt(start_height));

            const HASH_CHUNK_SIZE = 1000; // Send 1000 hashes per message

            if (hashes.length === 0) {
                await p2p.publish(TOPICS.HASHES_RESPONSE, { 
                    hashes: [], 
                    request_id, 
                    final_chunk: true 
                });
            } else {
                for (let i = 0; i < hashes.length; i += HASH_CHUNK_SIZE) {
                    const chunk = hashes.slice(i, i + HASH_CHUNK_SIZE);
                    const isFinal = (i + HASH_CHUNK_SIZE) >= hashes.length;
                    
                    await p2p.publish(TOPICS.HASHES_RESPONSE, { 
                        hashes: chunk, 
                        request_id, 
                        final_chunk: isFinal 
                    });
                }
            }
            log(`SYNC: Sent ${hashes.length} hashes to peer ${String(from).slice(-6)} in chunks`, 'info');
        } catch (e) {
            log(`SYNC: Failed to serve hashes to peer: ${e.message}`, 'warn');
        }
    });

    // New handler to receive the list of hashes
    await p2p.subscribe(TOPICS.HASHES_RESPONSE, async (message, { from }) => {
        const { hashes, request_id, final_chunk } = message;
        
        // RATIONALE: Use mutex to prevent race conditions on shared state.
        const release = await syncState.hashRequestMutex.acquire();
        try {
            const request = syncState.hashRequestState.get(request_id);
            if (!request) {
                return; // Ignore stale or unknown responses
            }
        
            // --- RATIONALE: Enforce a hard limit on total hashes received ---
            // This is the core fix for the memory exhaustion (OOM) attack. We check the
            // size *before* appending to memory.
            if (request.hashes.length + (hashes || []).length > CONFIG.SYNC.MAX_HASHES_PER_SYNC) {
                const error = new Error(`Peer ${request.peerId} exceeded max hash limit of ${CONFIG.SYNC.MAX_HASHES_PER_SYNC}`);
                request.reject(error);
                syncState.hashRequestState.delete(request_id);
                // Penalize the peer for this behavior.
                const PENALTY = 50; // A large penalty for a severe infraction.
                const currentScore = workerState.peerScores.get(request.peerId) || 100;
                const newScore = Math.max(0, currentScore - PENALTY);
                workerState.peerScores.set(request.peerId, newScore);
                if (newScore === 0) {
                    try { workerState.p2p.node.hangUp(request.peerId); } catch(e) {}
                }
                return;
            }

            // Append the received chunk of hashes
            request.hashes.push(...(hashes || []));

            // --- START: Explicitly check the final_chunk flag ---
            // RATIONALE: The sync promise will time out if it's never resolved. This
            // guard ensures we only resolve when we receive a message that explicitly
            // marks the end of the hash stream.
            if (final_chunk === true) {
                request.resolve(request.hashes);
                syncState.hashRequestState.delete(request_id);
            }
        } finally {
            release();
        }
    });
 

    await p2p.subscribe(TOPICS.SYNC, async (message, { from }) => {
        try {
            if (message.type === 'TIP_REQUEST') {
                const st = await pluribit.get_blockchain_state();
                await p2p.publish(TOPICS.SYNC, {
                   type: 'TIP_RESPONSE',
                   height: st.current_height,
                   totalWork: String(st.total_work),
                   tipHash: st.tip_hash,
                });
            } else if (message.type === 'TIP_RESPONSE') { // This is now handled by the temporary handler in bootstrapSync
                // No-op in the main handler
            }
        } catch (e) {
            log(`SYNC handler error: ${e.message || e}`, 'warn');
        }
    });
}

// Helper function to update wallets after reorg
async function updateWalletsAfterReorg() {
    log(`[REORG] Persisting updated wallet states...`);
    for (const walletId of workerState.wallets.keys()) {
        try {
            const updatedJson = await pluribit.wallet_session_export(walletId);
            await db.saveWallet(walletId, updatedJson);
            log(`[REORG] Wallet '${walletId}' state saved successfully.`);
            const newBalance = await pluribit.wallet_session_get_balance(walletId);
            parentPort.postMessage({ type: 'walletBalance', payload: { wallet_id: walletId, balance: newBalance }});
        } catch (e) {
            log(`[REORG] Failed to save wallet '${walletId}' post-reorg: ${e.message}`, 'error');
        }
    }
}

async function handleInitWallet({ walletId }) {
    if (!walletId) return log('Wallet ID cannot be empty.', 'error');
    if (await db.walletExists(walletId)) {
        return log(`Wallet '${walletId}' already exists. Use 'load'.`, 'error');
    }
      // Create a brand-new wallet session fully in Rust
      await pluribit.wallet_session_create(walletId);
      // Export once so it’s persisted (plaintext for now; can encrypt later)
      const blob = await pluribit.wallet_session_export(walletId);
      await db.saveWallet(walletId, blob);
    log(`New wallet '${walletId}' created and saved.`, 'success');
    await handleLoadWallet({ walletId });
}

async function handleLoadWallet({ walletId }) {
      let walletRecord;
      try {
        walletRecord = await db.loadWallet(walletId);
      } catch (e) {
        if (e?.code === 'WALLET_PASSPHRASE_REQUIRED') {
          return log(`Wallet '${walletId}' is encrypted. Set PLURIBIT_WALLET_PASSPHRASE and retry.`, 'error');
        }
        return log(`Failed to load wallet '${walletId}': ${e?.message || e}`, 'error');
      }
      if (walletRecord == null) {
        return log(`Wallet '${walletId}' not found.`, 'error');
      }

    // Load JSON blob straight into Rust session (JS never parses keys)
    const walletJson = (typeof walletRecord === 'string') ? walletRecord : JSON.stringify(walletRecord);
    await pluribit.wallet_session_open(walletId, walletJson);

    log(`Scanning blockchain for wallet '${walletId}'...`, 'info');
    await pluribit.wallet_session_scan_chain(walletId);

    // Persist updated state (from Rust session) and report summary
    const persisted = await pluribit.wallet_session_export(walletId);
    await db.saveWallet(walletId, persisted);
    const balance = await pluribit.wallet_session_get_balance(walletId);
    const address = await pluribit.wallet_session_get_address(walletId);

    // Instead of storing the full wallet data, just mark the session as active.
    workerState.wallets.set(walletId, true); 

    parentPort.postMessage({
        type: 'walletLoaded',
        payload: { walletId, balance, address }
    });
}

async function handleCreateTransaction({ from, to, amount, fee }) {
  // RATIONALE: This function is now atomic.
  // Wallet state is only persisted AFTER
  // the transaction has been successfully validated and broadcast to the network.
  // A broadcast failure will now correctly revert the in-memory wallet changes.
  // Keep a copy of the pre-transaction state in case we need to revert
  const originalWalletState = await pluribit.wallet_session_export(from);
  const release = await globalMutex.acquire();
  try {
    // 1. Create the transaction. This mutates the in-memory Rust wallet session.
    const result = await pluribit.wallet_session_send_to_stealth(
      from, BigInt(amount), BigInt(fee), to
    );
    // 2. Add to our own mempool first. This also serves as a final validation.
        try {
            await pluribit.add_transaction_to_pool(result.transaction);
        } catch (e) {
            // FIX #6: Transaction validation failed - clear pending marks
            const commitments = result.transaction.inputs.map(inp => inp.commitment);
            await pluribit.wallet_clear_pending_utxos(commitments);
            throw e;
        }
       
    // 3. Attempt to broadcast the transaction to the network.
    try {
      await workerState.p2p.publish(TOPICS.TRANSACTIONS, {
        type: 'new_transaction',
        payload: result.transaction
      });
        } catch (e) {
            // FIX #6: Broadcast failed - clear pending marks
            const commitments = result.transaction.inputs.map(inp => inp.commitment);
            await pluribit.wallet_clear_pending_utxos(commitments);
            log(`[RUST] Transaction broadcast failed, UTXOs unmarked: ${e?.message || e}`, 'warn');
            throw e;
       }

    // 4. ONLY if broadcast succeeds, persist the new wallet state.
    const persisted = await pluribit.wallet_session_export(from);
    await db.saveWallet(from, persisted);

    // 5. Notify the UI of success.
    const excessHex = result.transaction.kernels[0].excess.map(b => b.toString(16).padStart(2, '0')).join('');
    log(`Transaction created and broadcast. Hash: ${excessHex.substring(0,16)}...`, 'success');

    const newBalance = await pluribit.wallet_session_get_balance(from);
    parentPort.postMessage({ type: 'walletBalance', payload: { wallet_id: from, balance: newBalance }});
  } catch (e) {
    const msg = e?.stack || e?.message || String(e);
    log(`Transaction failed: ${msg}`, 'error');
    // RATIONALE: If any step failed, revert the in-memory wallet session
    // to its state before this transaction was attempted.
    log(`Reverting wallet state for '${from}'...`, 'warn');
    await pluribit.wallet_session_open(from, originalWalletState);
    parentPort.postMessage({ type: 'error', error: `Transaction failed: ${msg}` });
  } finally {
     release();
   }
}


if (parentPort) {
    main();
}
