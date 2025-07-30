// worker.js

import { parentPort, Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { base64ToArrayBuffer } from './utils.js'; 

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

// --- WORKER STATE (simplified) ---
export const workerState = {
    initialized: false,
    minerActive: false,
    minerId: null,
    p2p: null,
    wallets: new Map(),
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
                    log(`PoW+PoST Miner ${params.active ? `activated for ${params.minerId}` : 'deactivated'}.`);
                    parentPort.postMessage({ type: 'minerStatus', payload: { active: params.active } });
                    
                    if (workerState.minerActive) {
                        startPoSTMining();
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
            }
        } catch (error) {
            log(`Error handling action '${action}': ${error.message}`, 'error');
            parentPort.postMessage({ type: 'error', error: error.message });
        }
    });
}

// NEW Mining Loop
async function startPoSTMining() {
    if (!workerState.minerActive || !workerState.minerId) {
        log('Mining stopped.');
        return;
    }

    log(`[MINING] Starting PoW+PoST mining for wallet: ${workerState.minerId}...`);

    const minerWalletJson = workerState.wallets.get(workerState.minerId);
    if (!minerWalletJson) {
        log('Miner wallet not loaded, stopping.', 'error');
        return;
    }
    const walletData = JSON.parse(minerWalletJson);
    const minerSecretKey = new Uint8Array(Object.values(walletData.spend_priv));

    // Continuous mining loop
    while (workerState.minerActive) {
        try {
            const chainState = await pluribit.get_blockchain_state();
            const nextHeight = Number(chainState.current_height) + 1;
            const prevHash = await pluribit.get_latest_block_hash();
            
            const poolInfo = await pluribit.get_tx_pool();
            let transactionsToMine = [];

            if (poolInfo && poolInfo.transactions && poolInfo.transactions.length > 0) {
                const sortedTxs = poolInfo.transactions.sort((a, b) => {
                    const feeA = BigInt(a.kernel.fee);
                    const feeB = BigInt(b.kernel.fee);
                    if (feeA > feeB) return -1;
                    if (feeA < feeB) return 1;
                    return 0;
                });

                const MAX_BLOCK_SIZE = 4 * 1024 * 1024;
                let currentBlockSize = 0;
                const selectedTxs = [];

                for (const tx of sortedTxs) {
                    const estimatedTxSize = JSON.stringify(tx).length;
                    
                    if (currentBlockSize + estimatedTxSize <= MAX_BLOCK_SIZE) {
                        selectedTxs.push(tx);
                        currentBlockSize += estimatedTxSize;
                    } else {
                        break;
                    }
                }
                
                if (selectedTxs.length > 0) {
                    log(`[MINING] Selected ${selectedTxs.length} of ${poolInfo.transactions.length} available transactions.`);
                }
                transactionsToMine = selectedTxs;
            }
            
            const blockResult = await pluribit.mine_post_block(
                BigInt(nextHeight),
                minerSecretKey,
                prevHash,
                transactionsToMine
            );

            if (blockResult) {
                log(`[MINING] Block #${blockResult.height} MINED! Including ${blockResult.transactions.length - 1} transactions.`, 'success');
                await workerState.p2p.publish(TOPICS.BLOCKS, {
                    type: 'NEW_BLOCK',
                    payload: blockResult
                });
            }
            await new Promise(r => setTimeout(r, 100));

        } catch (e) {
            log(`Mining error: ${e.message}`, 'error');
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    log('Mining loop has exited.');
}

// FULLY REPLACED Block Handler with Fork Logic
async function handleRemoteBlockDownloaded({ block }) {
    try {
        await acquireLock();
        const chainState = await pluribit.get_blockchain_state();

        const currentTip = chainState.blocks[chainState.blocks.length - 1];
        const isFork = block.height > 0 && block.prev_hash !== currentTip.hash;

        if (isFork) {
            await handlePotentialReorg(block);
        } else {
            log(`Processing block #${block.height} from network.`);
            await pluribit.add_block_to_chain(block);
            await db.saveBlock(block);

            const newChainState = await pluribit.get_blockchain_state();
            log(`Block #${block.height} added to chain. New height: ${newChainState.current_height}`, 'success');

            for (const [walletId, walletJson] of workerState.wallets.entries()) {
                const updatedWalletJson = await pluribit.wallet_scan_block(walletJson, block);
                if (updatedWalletJson !== walletJson) {
                    workerState.wallets.set(walletId, updatedWalletJson);
                    const newBalance = await pluribit.wallet_get_balance(updatedWalletJson);
                    parentPort.postMessage({ type: 'walletBalance', payload: { wallet_id: walletId, balance: newBalance }});
                }
            }
        }
    } catch (e) {
        log(`Failed to process downloaded block: ${e}`, 'error');
    } finally {
        releaseLock();
    }
}

async function handlePotentialReorg(newBlock) {
    const chainState = await pluribit.get_blockchain_state();
    log(`Fork detected at height ${newBlock.height}. Our height: ${chainState.current_height}.`, 'warn');

    if (!reorgState.pendingForks.has(newBlock.height)) {
        reorgState.pendingForks.set(newBlock.height, new Map());
    }
    reorgState.pendingForks.get(newBlock.height).set(newBlock.hash, newBlock);

    await requestForkChain(newBlock);
}

async function requestForkChain(tipBlock) {
    let currentBlock = tipBlock;
    const chainState = await pluribit.get_blockchain_state();

    while (currentBlock.height > 0) {
        if (currentBlock.height <= chainState.current_height) {
            const ourBlock = chainState.blocks[currentBlock.height];
            if (ourBlock && ourBlock.hash === currentBlock.hash) {
                log(`Found common ancestor at height ${currentBlock.height}`, 'info');
                await evaluateFork(currentBlock.height, tipBlock);
                return;
            }
        }

        if (!reorgState.requestedBlocks.has(currentBlock.prev_hash)) {
            reorgState.requestedBlocks.add(currentBlock.prev_hash);
            log(`Requesting parent block ${currentBlock.prev_hash.substring(0, 16)}...`);
            await workerState.p2p.publish(TOPICS.BLOCK_REQUEST, {
                type: 'BLOCK_REQUEST',
                hash: currentBlock.prev_hash,
            });
            return;
        }

        const parentBlocks = reorgState.pendingForks.get(currentBlock.height - 1);
        if (parentBlocks && parentBlocks.has(currentBlock.prev_hash)) {
            currentBlock = parentBlocks.get(currentBlock.prev_hash);
        } else {
            log(`Fork chain is incomplete, missing parent for block at height ${currentBlock.height}.`, 'warn');
            return;
        }
    }
}

async function evaluateFork(commonAncestorHeight, forkTip) {
    try {
        const chainState = await pluribit.get_blockchain_state();
        const forkChain = [];
        let currentBlock = forkTip;

        while (currentBlock.height > commonAncestorHeight) {
            forkChain.unshift(currentBlock);
            const parentBlocks = reorgState.pendingForks.get(currentBlock.height - 1);
            if (!parentBlocks || !parentBlocks.has(currentBlock.prev_hash)) {
                log(`Fork chain incomplete, missing block at height ${currentBlock.height - 1}`, 'error');
                return;
            }
            currentBlock = parentBlocks.get(currentBlock.prev_hash);
        }

        const ourChainSegment = chainState.blocks.slice(commonAncestorHeight + 1);
        const ourWork = await pluribit.get_chain_work(ourChainSegment);
        const forkWork = await pluribit.get_chain_work(forkChain);

        log(`Chain work comparison - Our chain: ${ourWork}, Fork: ${forkWork}`, 'info');

        if (forkWork > ourWork) {
            log(`Fork has more work. Initiating reorganization...`, 'warn');
            await performReorganization(commonAncestorHeight, forkChain);
        } else {
            log(`Our chain has more or equal work. Keeping current chain.`, 'info');
            cleanupForkCache(commonAncestorHeight);
        }
    } catch (e) {
        log(`Error evaluating fork: ${e}`, 'error');
    }
}

async function performReorganization(commonAncestorHeight, newChain) {
    try {
        log(`Reorganizing from height ${commonAncestorHeight}...`);
        const chainState = await pluribit.get_blockchain_state();
        
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
        cleanupForkCache(newTip.height);

    } catch (e) {
        log(`Critical error during reorganization: ${e}`, 'error');
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
    log('Initializing PoW+PoST network...');
    
    const blocks = await db.getAllBlocks();
    if (blocks.length > 0) {
        blocks.sort((a, b) => a.height - b.height);
        await pluribit.init_blockchain();
        for (let i = 1; i < blocks.length; i++) {
            await pluribit.add_block_to_chain(blocks[i]);
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
    workerState.p2p = new PluribitP2P(log);
    await workerState.p2p.initialize();

    await setupMessageHandlers();

    log('P2P stack online.', 'success');
    parentPort.postMessage({ type: 'networkInitialized' });
    log('Network initialization complete.', 'success');
}

async function setupMessageHandlers() {
    const { p2p } = workerState;
    
    await p2p.subscribe(TOPICS.TRANSACTIONS, async (message) => {
        if (message.payload) {
            try {
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
            const block = await pluribit.get_block_by_hash(message.hash);
            if (block) {
                await p2p.publish(TOPICS.BLOCKS, {
                    type: 'BLOCK_RESPONSE',
                    payload: block,
                    requestId: message.requestId
                });
            }
        }
    });
}

async function handleInitWallet({ walletId }) {
    if (!walletId) return log('Wallet ID cannot be empty.', 'error');
    if (await db.walletExists(walletId)) {
        return log(`Wallet '${walletId}' already exists. Use 'load'.`, 'error');
    }
    const walletJson = await pluribit.wallet_create();
    const walletData = JSON.parse(walletJson);
    await db.saveWallet(walletId, walletData);
    workerState.wallets.set(walletId, walletJson);
    log(`New wallet '${walletId}' created and saved.`, 'success');
    await handleLoadWallet({ walletId });
}

async function handleLoadWallet({ walletId }) {
    const walletData = await db.loadWallet(walletId);
    if (!walletData) {
        return log(`Wallet '${walletId}' not found.`, 'error');
    }

    let walletJson = JSON.stringify(walletData);

    log(`Scanning blockchain for wallet '${walletId}'...`, 'info');
    const allBlocks = await db.getAllBlocks();
    for (const block of allBlocks) {
        walletJson = await pluribit.wallet_scan_block(walletJson, block);
    }

    const updatedWalletData = JSON.parse(walletJson);
    await db.saveWallet(walletId, updatedWalletData);
    
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
        const updatedWalletData = JSON.parse(result.updated_wallet_json);
        await db.saveWallet(from, updatedWalletData);
        workerState.wallets.set(from, result.updated_wallet_json);
        
        if (workerState.p2p) {
            await workerState.p2p.publish(TOPICS.TRANSACTIONS, {
                type: 'new_transaction',
                payload: result.transaction
            });
        }
        
        log(`Transaction created. Hash: ${result.transaction.kernel.excess.substring(0,16)}...`, 'success');
        const newBalance = await pluribit.wallet_get_balance(result.updated_wallet_json);
        parentPort.postMessage({ type: 'walletBalance', payload: { wallet_id: from, balance: newBalance }});
    } catch (e) {
        log(`Transaction failed: ${e}`, 'error');
    } finally {
        releaseLock();
    }
}

if (parentPort) {
    main();
}
