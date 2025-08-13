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

import { parentPort, Worker } from 'worker_threads';
import { Worker as ThreadWorker } from 'worker_threads';
import crypto from 'crypto';    
import path from 'path';
import { fileURLToPath } from 'url';
import { base64ToArrayBuffer, JSONParseWithBigInt } from './utils.js'; 
import { multiaddr } from '@multiformats/multiaddr';


// --- MODULE IMPORTS ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const wasmPath = path.join(__dirname, './pkg-node/pluribit_core.js');
const { default: _, ...pluribit } = await import(wasmPath);
import { PluribitP2P, TOPICS } from './libp2p-node.js';
import * as db from './db.js';

// --- MUTEX FOR RESOURCE LOCKING ---
let isLocked = false;
const acquireLock = async () => {
    while (isLocked) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    isLocked = true;
};
const releaseLock = () => {
    isLocked = false;
};

// --- REORG STATE ---
const reorgState = {
    pendingForks: new Map(),
    requestedBlocks: new Set(),
};

// --- SYNC STATE (best tip seen from peers) ---
const syncState = {
  outstandingTipRequests: new Set(),  // hashes we already asked for
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
};

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
                case 'loadWallet': await handleLoadWallet(params); break;
                case 'createTransaction': await handleCreateTransaction(params); break;
                case 'setMinerActive':
                    workerState.minerActive = params.active;
                    workerState.minerId = params.active ? params.minerId : null;
                    log(`PoWrPoST Miner ${params.active ? `activated for ${params.minerId}` : 'deactivated'}.`);
                    parentPort.postMessage({ type: 'minerStatus', payload: { active: params.active } });
                    
                    if (workerState.minerActive) {
                        startPoSTMining();
                    } else if (workerState.miningWorker) {
                        // Stop mining worker
                        workerState.miningWorker.terminate();
                        workerState.miningWorker = null;
                    }
                    break;
                case 'getBalance':
                    try {
                        const walletJson = workerState.wallets.get(params.walletId);
                        if (!walletJson) throw new Error("Wallet not loaded");
                        const balance = await pluribit.wallet_get_balance(walletJson);
                        parentPort.postMessage({ type: 'walletBalance', payload: { wallet_id: params.walletId, balance: balance }});
                    } catch(e) {
                        log(`Could not get balance: ${e}`, 'error');
                    }
                    break;
                case 'getMiningParams':
                    try {
                        const params = await pluribit.get_current_mining_params();
                        log(`[STATUS] Height: ${params.current_height}, Work: ${params.total_work}, PoW Diff: ${params.pow_difficulty}, VDF Iters: ${params.vdf_iterations}`);
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
                            const addr = multiaddr(params.address);
                            await workerState.p2p.node.dial(addr);
                            log(`Manually connected to ${params.address}`, 'success');
                            setTimeout(() => bootstrapSync(), 400);
                        } catch (e) {
                            log(`Failed to connect: ${e.message}`, 'error');
                        }
                    }
                    break;
            }
        } catch (error) {
            const msg = (error && error.message) ? error.message : String(error);
            log(`Error handling action '${action}': ${msg}`, 'error');
            parentPort.postMessage({ type: 'error', error: msg });
        }
    });
}

//  Mining Loop
async function startPoSTMining() {
    if (!workerState.minerActive || !workerState.minerId) {
        log('Mining stopped.');
        return;
    }

    const minerWalletJson = workerState.wallets.get(workerState.minerId);
    if (!minerWalletJson) {
        log('Miner wallet not loaded, stopping.', 'error');
        return;
    }
    
    const walletData = JSON.parse(minerWalletJson);
    const minerSecretKey = new Uint8Array(Object.values(walletData.spend_priv));
    const minerScanPubkey = new Uint8Array(Object.values(walletData.scan_pub));

    // Create mining worker
    const miningWorkerPath = path.join(__dirname, 'mining-worker.js');
    workerState.miningWorker = new ThreadWorker(miningWorkerPath);
    
    workerState.miningWorker.on('message', async (msg) => {
        if (msg.type === 'HEADER_FOUND') {
            // Stale job? Ignore.
            if (msg.jobId !== workerState.currentJobId) {
                log(`[MINING] Stale header (job ${msg.jobId}) ignored. Current job is ${workerState.currentJobId}.`, 'warn');
                return;
            }

            try {
                // Make sure tip/difficulty didn't change while we were searching.
                const latest = await pluribit.get_latest_block_hash();
                const params = await pluribit.get_current_mining_params();
                if (latest !== msg.prevHash) { // Simplified stale check
                    log('[MINING] Header became stale before assembly; restarting job.', 'warn');
                    return startNextMiningJob();
                }

                // UPDATED: Assemble the full block with new committed parameters
                const block = await pluribit.complete_block_with_transactions(
                    BigInt(msg.height),
                    msg.prevHash,
                    BigInt(msg.solution.nonce),
                    msg.solution.miner_pubkey,
                    minerScanPubkey,
                    msg.solution.vrf_proof,
                    msg.solution.vdf_proof,
                    // NEW PARAMS PASSED HERE:
                    msg.solution.vrf_threshold,
                    BigInt(msg.solution.vdf_iterations),
                    // Original params
                    msg.powDifficulty,
                    null
                );
                
                const txCount = (block.transactions?.length || 1) - 1;
                log(`[MINING] Block #${block.height} assembled with ${txCount} tx(s).`, 'success');
                
                // Process locally
                await handleRemoteBlockDownloaded({ block });
                
                // Broadcast to peers
                await workerState.p2p.publish(TOPICS.BLOCKS, {
                    type: 'NEW_BLOCK',
                    payload: block
                });

                // Start a new job soon
                setTimeout(() => startNextMiningJob(), 1000);
                
            } catch (e) {
                log(`Error assembling/processing mined block: ${e.message}`, 'error');
                setTimeout(() => startNextMiningJob(), 5000);
            }
        } else if (msg.type === 'STATUS') {
            log(`[MINING] ${msg.message}`);
        }
    });

    workerState.miningWorker.on('error', (err) => {
        log(`Mining worker error: ${err.message}`, 'error');
    });

    workerState.miningWorker.on('exit', (code) => {
        if (code !== 0 && workerState.minerActive) {
            log(`Mining worker crashed, restarting...`, 'error');
            setTimeout(() => startPoSTMining(), 1000);
        }
    });

    // Start mining
    startNextMiningJob();
}

async function startNextMiningJob() {
    if (!workerState.minerActive || !workerState.miningWorker) return;
    try {
        // Cancel any in-flight search to avoid wasted cycles.
        workerState.miningWorker.postMessage({ type: 'STOP' });

        const chainState = await pluribit.get_blockchain_state();
        const chain = typeof chainState === 'string' ? JSON.parse(chainState) : chainState;
        const height = Number(chain.current_height) + 1;
        const prevHash = await pluribit.get_latest_block_hash();

        const minerWalletJson = workerState.wallets.get(workerState.minerId);
        const walletData = JSON.parse(minerWalletJson);
        const minerSecretKey = Array.from(new Uint8Array(Object.values(walletData.spend_priv)));

        // For logging only (not sent to worker)
        const poolInfo = await pluribit.get_tx_pool();
        const pool = typeof poolInfo === 'string' ? JSONParseWithBigInt(poolInfo) : poolInfo;
        const mempoolCount = pool.transactions?.length || 0;

        // Increment job id and send header-only job
        workerState.currentJobId += 1;
        const jobId = workerState.currentJobId;

        workerState.miningWorker.postMessage({
            type: 'MINE_BLOCK',
            jobId,
            height,
            minerSecretKey,
            prevHash,
            powDifficulty: chain.current_pow_difficulty,
            vrfThreshold: Array.from(chain.current_vrf_threshold),
            vdfIterations: chain.current_vdf_iterations
        });

        log(`[MINING] Started mining block #${height} (mempool: ${mempoolCount} tx)`);
    } catch (e) {
        log(`Error starting mining job: ${e.message}`, 'error');
        setTimeout(() => startNextMiningJob(), 5000);
    }
}

async function handleRemoteBlockDownloaded({ block }) {
    try {
        await acquireLock();
        // Special handling for genesis block
        // Allow genesis ONLY if it was requested for a reorg.
        if (block.height === 0 && !reorgState.requestedBlocks.has(block.hash)) {
            log(`Ignoring unsolicited genesis block broadcast`);
            releaseLock();
            return;
        }

        // --- START: NEW FORK RESOLUTION LOGIC ---
        // Check if this block was requested to resolve a fork.
        if (reorgState.requestedBlocks.has(block.hash)) {
            log(`Received requested block #${block.height} for fork resolution.`, 'info');

            reorgState.requestedBlocks.delete(block.hash); 
            syncState.outstandingTipRequests.delete(block.hash);

            // Add the block to our map of pending fork blocks.
            if (!reorgState.pendingForks.has(block.height)) {
                reorgState.pendingForks.set(block.height, new Map());
            }
            reorgState.pendingForks.get(block.height).set(block.hash, block);

            // Now that we have the missing piece, find any fork that was waiting for
            // this block and try to continue building its chain history.
            let waitingForkTip = null;
            for (const forksAtHeight of reorgState.pendingForks.values()) {
                for (const forkBlock of forksAtHeight.values()) {
                    if (forkBlock.prev_hash === block.hash) {
                        waitingForkTip = forkBlock;
                        break;
                    }
                }
                if (waitingForkTip) break;
            }
            
            if (waitingForkTip) {
                log(`Continuing fork resolution for tip ${waitingForkTip.hash.substring(0,12)}...`, 'info');
                await requestForkChain(waitingForkTip);
            } else {
                // No child was waiting on this block (e.g., we just fetched the peer's tip).
                // Start/continue the backfill from this block itself.
                log(`Starting fork resolution from received block #${block.height}…`, 'info');
                await requestForkChain(block);
            }

            // End processing for this block here since it's part of a reorg.
            releaseLock();
            return;
        }
        // --- END: NEW FORK RESOLUTION LOGIC ---

        // Get the blockchain state and handle it properly
        const chainStateRaw = await pluribit.get_blockchain_state();
        
        // Parse the chain state if it's a string or ensure it has the right structure
        let chainState;
        try {
            if (typeof chainStateRaw === 'string') {
                chainState = JSON.parse(chainStateRaw);
            } else if (chainStateRaw && typeof chainStateRaw === 'object') {
                // It might be a JsValue that needs to be converted
                chainState = chainStateRaw;
            } else {
                throw new Error('Invalid chain state format');
            }
        } catch (parseError) {
            log(`Failed to parse chain state: ${parseError.message}`, 'error');
            releaseLock();
            return;
        }

        // Validate the chain state structure
        if (!chainState || !chainState.blocks || !Array.isArray(chainState.blocks) || chainState.blocks.length === 0) {
            log('Invalid or empty blockchain state', 'error');
            releaseLock();
            return;
        }

        const currentTip = chainState.blocks[chainState.blocks.length - 1];

        // Check if we already have this block
        const existingBlock = await pluribit.get_block_by_hash(block.hash);
        if (existingBlock) {
            log(`Already have block #${block.height}, ignoring duplicate`);
            releaseLock();
            return;
        }

        const isFork = block.height > 0 && block.prev_hash !== currentTip.hash;
        const isNextBlock = block.prev_hash === currentTip.hash && block.height === currentTip.height + 1;

        if (isFork) {
            await handlePotentialReorg(block);
        } else if (isNextBlock) {
            log(`Processing block #${block.height} from network.`);
            await pluribit.add_block_to_chain(block);

            await db.saveBlock(block);

            const newChainStateRaw = await pluribit.get_blockchain_state();
            let newChainState;
            try {
                if (typeof newChainStateRaw === 'string') {
                    newChainState = JSON.parse(newChainStateRaw);
                } else {
                    newChainState = newChainStateRaw;
                }
            } catch (e) {
                newChainState = { current_height: block.height }; // Fallback
            }
            
            log(`Block #${block.height} added to chain. New height: ${newChainState.current_height}`, 'success');

            // Rescan wallets with the new block
            for (const [walletId, walletJson] of workerState.wallets.entries()) {
                try {
                    const updatedWalletJson = await pluribit.wallet_scan_block(walletJson, block);
                    if (updatedWalletJson !== walletJson) {
                        workerState.wallets.set(walletId, updatedWalletJson);
                        await db.saveWallet(walletId, updatedWalletJson);
                        
                        const newBalance = await pluribit.wallet_get_balance(updatedWalletJson);
                        log(`Wallet ${walletId} balance updated to: ${newBalance}`);
                        parentPort.postMessage({ type: 'walletBalance', payload: { wallet_id: walletId, balance: newBalance }});
                    }
                } catch (e) {
                    log(`Failed to scan block for wallet ${walletId}: ${e.message}`, 'error');
                }
            }
            
            // Tip advanced; refresh the mining job so we don't waste work on a stale prevHash.
            if (workerState.minerActive && workerState.miningWorker) {
                startNextMiningJob();
            }
            
        } else {
            // Added more specific logging for ignored blocks
            if (block.height <= currentTip.height && block.height > 0) {
                 log(`Ignoring stale block #${block.height} (our height is ${currentTip.height}).`, 'warn');
            } else if (block.height > 0) {
                 log(`Ignoring block #${block.height} as it is not the next block and not a fork. Our tip is #${currentTip.height}.`, 'warn');
            }
        }
    } catch (e) {
        log(`Failed to process downloaded block: ${e.message}`, 'error');
        console.error(e); // Add stack trace for debugging
    } finally {
        releaseLock();
    }
}

async function concludeReorgAttempt() {
    log('Concluding reorg attempt.', 'info');
    cleanupForkCache(0); // Clear all pending fork data
    workerState.isReorging = false;

    // Restart the miner if it was active before the reorg
    if (workerState.wasMinerActiveBeforeReorg) {
        log('Resuming mining activities.', 'info');
        workerState.minerActive = true; // Set flag before starting
        if (workerState.minerId) {
            startPoSTMining();
             // Inform the UI
            parentPort.postMessage({ type: 'minerStatus', payload: { active: true } });
        } else {
            log('Cannot resume mining, no miner ID is set.', 'warn');
        }
    }
    // Reset the flag
    workerState.wasMinerActiveBeforeReorg = false;
}

async function handlePotentialReorg(newBlock) {
    try {
        const chainStateRaw = await pluribit.get_blockchain_state();
        let chainState;
        
        if (typeof chainStateRaw === 'string') {
            chainState = JSON.parse(chainStateRaw);
        } else {
            chainState = chainStateRaw;
        }
        
        if (!chainState || typeof chainState.current_height === 'undefined') {
            log('Invalid chain state during reorg handling', 'error');
            return;
        }

        // Only consider forks that are longer than our current chain.
        if (newBlock.height < chainState.current_height) {
            log(`Ignoring fork with lower/equal height (${newBlock.height} < ${chainState.current_height}).`, 'info');
            return; // Do nothing and continue mining
        }

        // If a reorg is already happening, queue this block but don't start a new process.
        if (workerState.isReorging) {
            log(`Reorg in progress, queueing fork at height ${newBlock.height}.`, 'warn');
            if (!reorgState.pendingForks.has(newBlock.height)) {
                reorgState.pendingForks.set(newBlock.height, new Map());
            }
            reorgState.pendingForks.get(newBlock.height).set(newBlock.hash, newBlock);
            return;
        }
        
        log(`Potentially better chain detected at height ${newBlock.height}. Our height: ${chainState.current_height}.`, 'warn');
        
        // --- PAUSE MINER AND BEGIN REORG ---
        workerState.isReorging = true;
        workerState.wasMinerActiveBeforeReorg = workerState.minerActive;

        if (workerState.minerActive) {
            log('Pausing miner to resolve fork...', 'warn');
            workerState.minerActive = false;
            if (workerState.miningWorker) {
                workerState.miningWorker.postMessage({ type: 'STOP' });
                workerState.miningWorker.terminate();
                workerState.miningWorker = null;
            }
            parentPort.postMessage({ type: 'minerStatus', payload: { active: false } });
        }
        // --- END PAUSE MINER ---

        if (!reorgState.pendingForks.has(newBlock.height)) {
            reorgState.pendingForks.set(newBlock.height, new Map());
        }
        reorgState.pendingForks.get(newBlock.height).set(newBlock.hash, newBlock);

        await requestForkChain(newBlock);

    } catch (e) {
        log(`Error in handlePotentialReorg: ${e.message}`, 'error');
        await concludeReorgAttempt();
    }
}

async function requestForkChain(tipBlock) {
  let currentBlock = tipBlock;

  // Parse blockchain state consistently
  const chainStateRaw = await pluribit.get_blockchain_state();
  const chainState = typeof chainStateRaw === 'string' ? JSON.parse(chainStateRaw) : chainStateRaw;

  // Walk as far as possible using what we already have cached,
  // only issuing a network request when we truly need to.
  while (currentBlock.height > 0) {
    // 1) Common-ancestor check
    if (currentBlock.height <= chainState.current_height) {
      const ourBlock = chainState.blocks[currentBlock.height];
      if (ourBlock && ourBlock.hash === currentBlock.hash) {
        log(`Found common ancestor at height ${currentBlock.height}`, 'info');
        await evaluateFork(currentBlock.height, tipBlock);
        return;
      }
    }

    // 2) If we already have the parent in the pending cache, step to it NOW (no network).
    const parentsAtHeight = reorgState.pendingForks.get(currentBlock.height - 1);
    if (parentsAtHeight && parentsAtHeight.has(currentBlock.prev_hash)) {
      currentBlock = parentsAtHeight.get(currentBlock.prev_hash);
      continue; // try to consume more cached parents in this same call
    }

    // 3) Parent not cached yet:
    //    If we've ALREADY asked for it, just wait for it to arrive (do NOT re-request).
    if (reorgState.requestedBlocks.has(currentBlock.prev_hash)) {
      return; // wait for handleRemoteBlockDownloaded to feed it in
    }

    // 4) Otherwise, request it once and return.
    reorgState.requestedBlocks.add(currentBlock.prev_hash);
    const requestId = (typeof crypto?.randomUUID === 'function')
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
    log(`Requesting parent block ${currentBlock.prev_hash.substring(0, 16)}...`);
    await workerState.p2p.publish(TOPICS.BLOCK_REQUEST, {
      type: 'BLOCK_REQUEST',
      hash: currentBlock.prev_hash,
      requestId,
    });
    return; // we'll continue when that parent arrives
  }

  // 5) Reached height 0: check genesis equality
  const ourGenesis = chainState.blocks[0];
  if (ourGenesis && ourGenesis.hash === currentBlock.hash) {
    log(`Found common ancestor at height 0`, 'info');
    await evaluateFork(0, tipBlock);
  } else {
    log(`Reached genesis without finding a common ancestor`, 'warn');
    await concludeReorgAttempt();
  }
}


async function evaluateFork(commonAncestorHeight, forkTip) {
  try {
    // 1) Rebuild the fork chain segment from commonAncestorHeight+1 .. forkTip
    const forkChain = [];
    let currentBlock = forkTip;

    while (currentBlock.height > commonAncestorHeight) {
      // We want ascending order for the segment: [ancestor+1, ..., tip]
      forkChain.unshift(currentBlock);

      const parentBlocks = reorgState.pendingForks.get(currentBlock.height - 1);
      if (!parentBlocks || !parentBlocks.has(currentBlock.prev_hash)) {
        log(`Fork chain incomplete, missing block at height ${currentBlock.height - 1}`, 'error');
        await concludeReorgAttempt();
        return;
      }
      currentBlock = parentBlocks.get(currentBlock.prev_hash);
    }

    // 2) Our chain segment after the common ancestor
    const chainStateRaw = await pluribit.get_blockchain_state();
    const chainState = typeof chainStateRaw === 'string' ? JSON.parse(chainStateRaw) : chainStateRaw;
    const ourChainSegment = chainState.blocks.slice(commonAncestorHeight + 1);

    const ourLen  = ourChainSegment.length;           // == chainState.current_height - commonAncestorHeight
    const forkLen = forkChain.length;                 // == forkTip.height - commonAncestorHeight

    // 3) Compute work (may return number/string/BigInt or even throw if types mismatch)
    const toBig = (x) => {
      try {
        if (typeof x === 'bigint') return x;
        if (typeof x === 'number') return BigInt(x);
        if (typeof x === 'string') return BigInt(x);
      } catch {}
      return 0n;
    };

    let ourWork  = 0n;
    let forkWork = 0n;

    try { ourWork  = toBig(await pluribit.get_chain_work(ourChainSegment)); } catch {}
    try { forkWork = toBig(await pluribit.get_chain_work(forkChain));      } catch {}

    log(`Chain work comparison - Our chain: ${ourWork.toString()}, Fork: ${forkWork.toString()}`, 'info');

    // 4) Decide: prefer higher work; on a tie, prefer longer segment
    if (forkWork > ourWork) {
      log(`Fork has strictly more work. Initiating reorganization...`, 'warn');
      await performReorganization(commonAncestorHeight, forkChain);
      return;
    }
    if (forkWork < ourWork) {
      log(`Our chain has strictly more work. Keeping current chain.`, 'info');
      await concludeReorgAttempt();
      return;
    }

    // 5) Tie-break: if work equal (or zero on both), longer segment wins
    if (forkLen > ourLen) {
      log(`Work tie; longer fork segment wins (${forkLen} > ${ourLen}). Reorganizing...`, 'warn');
      await performReorganization(commonAncestorHeight, forkChain);
    } else {
      log(`Work tie and our segment is not shorter (${ourLen} >= ${forkLen}). Keeping current chain.`, 'info');
      await concludeReorgAttempt();
    }
  } catch (e) {
    log(`Error evaluating fork: ${e?.message || e}`, 'error');
    await concludeReorgAttempt();
  }
}


async function performReorganization(commonAncestorHeight, newChain) {
    try {
        log(`Reorganizing from height ${commonAncestorHeight}...`);
        const rawState = await pluribit.get_blockchain_state();
        const chainState = (typeof rawState === 'string') ? JSON.parse(rawState) : rawState;
        
        for (let height = chainState.current_height; height > commonAncestorHeight; height--) {
            const blockToRewind = chainState.blocks[height];
            await pluribit.rewind_block(blockToRewind);
            for (const [walletId, walletJson] of workerState.wallets.entries()) {
                const updatedWallet = await pluribit.wallet_unscan_block(walletJson, blockToRewind);
                workerState.wallets.set(walletId, updatedWallet);
            }
        }

        for (const block of newChain) {
            await pluribit.add_block_to_chain(block);
            await db.saveBlock(block);
            for (const [walletId, walletJson] of workerState.wallets.entries()) {
                const updatedWallet = await pluribit.wallet_scan_block(walletJson, block);
                workerState.wallets.set(walletId, updatedWallet);
            }
        }
        
        for (const [walletId] of workerState.wallets.entries()) {
            await handleLoadWallet({ walletId });
        }

        const newTip = newChain[newChain.length - 1];
        log(`Reorganization complete. New tip at height ${newTip.height}`, 'success');
        
        // Conclude the reorg process, which will clean up and restart the miner
        await concludeReorgAttempt();

    } catch (e) {
        log(`Critical error during reorganization: ${e}`, 'error');
        // Also conclude on error to restart miner
        await concludeReorgAttempt();
    }
}

function cleanupForkCache(keepAboveHeight) {
    for (const height of reorgState.pendingForks.keys()) {
        if (height <= keepAboveHeight) {
            reorgState.pendingForks.delete(height);
        }
    }
    reorgState.requestedBlocks.clear();
}

// SIMPLIFIED Network Initialization
async function initializeNetwork() {
    log('Initializing PoWrPoST network...');

    // --- START: Genesis Hash Verification ---
    // DO NOT CHANGE!
    const CANONICAL_GENESIS_HASH = "7a69291ed6addb18b819036789e889b3cff75489a71d1fb0b6213621ef18b211";

    // STEP 2: Get the hash from the Wasm module.
    const generatedHash = await pluribit.get_genesis_block_hash();
    // STEP 3: Compare and exit if they don't match.
    if (generatedHash !== CANONICAL_GENESIS_HASH) {
        const errorMsg = `CRITICAL: Genesis hash mismatch! Expected ${CANONICAL_GENESIS_HASH}, but got ${generatedHash}. Exiting to prevent network fork.`;
        log(errorMsg, 'error');
        // A critical error like this should stop the worker immediately.
        return process.exit(1);
    }
    log('Genesis block hash verified successfully.', 'success');
    // --- END: Genesis Hash Verification ---

    const blocks = await db.getAllBlocks();
    if (blocks.length > 0) {
        blocks.sort((a, b) => a.height - b.height);
        await pluribit.init_blockchain();
        for (let i = 1; i < blocks.length; i++) {
          try {
            await pluribit.add_block_to_chain(blocks[i]);
          } catch (e) {
            log(`Failed replay at height ${blocks[i]?.height}: ${e?.message ?? e}`, 'error');
            throw e;
          }
        }
        log(`Restored blockchain to height ${blocks[blocks.length - 1].height}`, 'success');
    } else {
        log('Creating new genesis block.', 'info');
        await pluribit.init_blockchain();
        const chainState = await pluribit.get_blockchain_state();
        if (chainState.blocks && chainState.blocks.length > 0) {
            await db.saveBlock(chainState.blocks[0]);
        }
    }
    
    log('Initializing P2P stack...');
    const tcpPort = process.env.TCP_PORT || 26660;
    const wsPort = process.env.WS_PORT || 26661;

    log(`Attempting to start P2P node on TCP:${tcpPort} and WS:${wsPort}`);

    workerState.p2p = new PluribitP2P(log, { 
      tcpPort: parseInt(tcpPort), 
      wsPort: parseInt(wsPort) 
    });

    await workerState.p2p.initialize();

    await setupMessageHandlers();


    // Kick off an initial attempt (will no-op if no peers yet)
    setTimeout(() => bootstrapSync(), 0);

    // Also trigger sync when a peer connects (gives the remote time to subscribe)
    try {
      workerState.p2p.node.addEventListener('peer:connect', () => {
        log('Peer connected; scheduling sync bootstrap…', 'info');
        setTimeout(() => bootstrapSync(), 400);
      });
    } catch {
      // If your wrapper doesn’t expose addEventListener, you can safely ignore this
    }

    log('P2P stack online.', 'success');
    parentPort.postMessage({ type: 'networkInitialized' });
    log('Network initialization complete.', 'success');
}


// Ask peers for their tip, but only when someone is there to hear us.
// Retries with a short backoff if nobody is subscribed yet.
async function bootstrapSync(attempt = 1) {
  try {
    if (!workerState?.p2p) return;

    // If nobody is connected yet, don't publish—wait for a connection event.
    const peers = workerState.p2p.getConnectedPeers?.() ?? [];
    if (peers.length === 0) {
      log('SYNC: no connected peers yet; will try again when a peer connects.', 'info');
      return;
    }

    const requestId = (await import('crypto')).randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    await workerState.p2p.publish(TOPICS.SYNC, { type: 'TIP_REQUEST', requestId });
    log('SYNC: requested tip from peers', 'info');
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('NoPeersSubscribedToTopic')) {
      // Peers may be connected but haven’t finished subscribing; retry shortly.
      const delay = Math.min(250 * attempt, 2000); // 250ms → 2s
      log(`SYNC: no peers subscribed yet; retrying in ${delay}ms (attempt ${attempt})`, 'info');
      setTimeout(() => bootstrapSync(attempt + 1), delay);
      return;
    }
    log(`SYNC: unexpected publish error: ${msg}`, 'warn');
  }
}

async function setupMessageHandlers() {
    const { p2p } = workerState;
    
    await p2p.subscribe(TOPICS.TRANSACTIONS, async (message) => {
        if (message.payload) {
            try {
                log(`Received transaction from network`);
                
                // The object is already in the correct format after JSONParseWithBigInt.
                // Pass it directly to the Wasm function.
                await pluribit.add_transaction_to_pool(message.payload);
                
                log(`Added network transaction to pool.`);
            } catch (e) {
                log(`Failed to add network transaction: ${e}`, 'warn');
            }
        }
    });
    
    await p2p.subscribe(TOPICS.BLOCKS, async (message) => {
        if (message.payload) {
            handleRemoteBlockDownloaded({ block: message.payload });
        }
    });
    
    await p2p.subscribe(TOPICS.BLOCK_REQUEST, async (message) => {
        if (message.hash) {
            // First try to get from Rust
            const block = await pluribit.get_block_by_hash(message.hash);
            if (block) {
                await p2p.publish(TOPICS.BLOCKS, {
                    type: 'BLOCK_RESPONSE',
                    payload: block,
                    requestId: message.requestId
                });
            } else {
                // If not found, check if it's genesis
                const stRaw = await pluribit.get_blockchain_state();
                const st = (typeof stRaw === 'string') ? JSON.parse(stRaw) : stRaw;
                if (st?.blocks?.length > 0 && st.blocks[0].hash === message.hash) {
                  await p2p.publish(TOPICS.BLOCKS, {
                    type: 'BLOCK_RESPONSE',
                    payload: st.blocks[0],
                    requestId: message.requestId
                  });
                }
            }
        }
    });
    
    await p2p.subscribe(TOPICS.SYNC, async (message) => {
      try {
        if (message.type === 'TIP_REQUEST' && message.requestId) {
          // Reply with our best tip
          const stRaw = await pluribit.get_blockchain_state();
          const st = typeof stRaw === 'string' ? JSON.parse(stRaw) : stRaw;
          const tip = st.blocks[st.blocks.length - 1];
          await p2p.publish(TOPICS.SYNC, {
            type: 'TIP_RESPONSE',
            requestId: message.requestId,
            height: st.current_height,
            totalWork: st.total_work,
            tipHash: tip.hash,
          });
        } else if (message.type === 'TIP_RESPONSE' && message.tipHash) {
          // Ask for the peer's tip block exactly once
          if (!reorgState.requestedBlocks.has(message.tipHash) &&
              !syncState.outstandingTipRequests.has(message.tipHash)) {
            reorgState.requestedBlocks.add(message.tipHash);
            syncState.outstandingTipRequests.add(message.tipHash);
            const requestId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
            log(`SYNC: requesting advertised tip ${message.tipHash.substring(0, 12)}...`, 'info');
            await workerState.p2p.publish(TOPICS.BLOCK_REQUEST, {
              type: 'BLOCK_REQUEST',
              hash: message.tipHash,
              requestId,
            });
          }
        }
      } catch (e) {
        log(`SYNC handler error: ${e.message || e}`, 'warn');
      }
    });    
    
    
    
}



async function handleInitWallet({ walletId }) {
    if (!walletId) return log('Wallet ID cannot be empty.', 'error');
    if (await db.walletExists(walletId)) {
        return log(`Wallet '${walletId}' already exists. Use 'load'.`, 'error');
    }
      const walletJson = await pluribit.wallet_create();
      // Store the raw JSON string—do NOT parse/re-encode it.
      await db.saveWallet(walletId, walletJson);
      workerState.wallets.set(walletId, walletJson);
    log(`New wallet '${walletId}' created and saved.`, 'success');
    await handleLoadWallet({ walletId });
}

async function handleLoadWallet({ walletId }) {
  const walletRecord = await db.loadWallet(walletId);
  if (walletRecord == null) {
        return log(`Wallet '${walletId}' not found.`, 'error');
    }

  // If DB has a string, use it as-is; if it has an old object, stringify it.
  let walletJson = (typeof walletRecord === 'string')
    ? walletRecord
    : JSON.stringify(walletRecord);

    log(`Scanning blockchain for wallet '${walletId}'...`, 'info');
    const allBlocks = await db.getAllBlocks();
    for (const block of allBlocks) {
        walletJson = await pluribit.wallet_scan_block(walletJson, block);
    }

    const updatedWalletData = JSON.parse(walletJson);
    await db.saveWallet(walletId, walletJson); // persist the raw JSON string
    
    workerState.wallets.set(walletId, walletJson);
    const balance = await pluribit.wallet_get_balance(walletJson);
    const address = await pluribit.wallet_get_stealth_address(walletJson);
    
    parentPort.postMessage({
        type: 'walletLoaded',
        payload: { walletId, balance, address }
    });
}

async function handleCreateTransaction({ from, to, amount, fee }) {
  const fromWalletJson = workerState.wallets.get(from);
  if (!fromWalletJson) return log(`Sender wallet '${from}' is not loaded.`, 'error');

  try {
    await acquireLock();

    const result = await pluribit.create_transaction_to_stealth_address(
      fromWalletJson, BigInt(amount), BigInt(fee), to
    );

    // Try to add to mempool first.
    await pluribit.add_transaction_to_pool(result.transaction);

    // Only now that the tx is accepted do we persist wallet changes:
    await db.saveWallet(from, result.updated_wallet_json);  // save the *string*
    workerState.wallets.set(from, result.updated_wallet_json);

    if (workerState.p2p) {
      await workerState.p2p.publish(TOPICS.TRANSACTIONS, {
        type: 'new_transaction',
        payload: result.transaction
      });
    }

    const excessHex = result.transaction.kernel.excess.map(b => b.toString(16).padStart(2, '0')).join('');
    log(`Transaction created. Hash: ${excessHex.substring(0,16)}...`, 'success');

    const newBalance = await pluribit.wallet_get_balance(result.updated_wallet_json);
    parentPort.postMessage({ type: 'walletBalance', payload: { wallet_id: from, balance: newBalance }});
  } catch (e) {
    log(`Transaction failed: ${e}`, 'error');
    // Do NOT persist a failing transaction’s wallet changes.
  } finally {
    releaseLock();
  }
}


if (parentPort) {
    main();
}
