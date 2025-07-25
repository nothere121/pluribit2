// worker.js - Pluribit Node.js Worker

import { parentPort, Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { webcrypto as crypto } from 'crypto';

// --- MODULE IMPORTS ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const wasmPath = path.join(__dirname, './pkg-node/pluribit_core.js');
const { default: _, ...pluribit } = await import(wasmPath);
import { MixingNode } from './p2p/mixing-node.js';
import { KademliaDHT } from './p2p/dht.js';
import { HyParView } from './p2p/hyparview.js';
import { Scribe } from './p2p/scribe.js';
import { initP2P, broadcast } from './p2p/network-manager.js';
import { messageBus } from './p2p/message-bus.js';
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

const reorgState = {
    pendingForks: new Map(), // height -> Map(hash -> block)
    requestedBlocks: new Set(), // hashes we've requested
};

// --- STATE ---
export const workerState = {
    initialized: false,
    minerActive: false,
    minerId: null,
    currentlyMining: false,
    consensusPhase: 'Mining', // Start in Mining phase
    validatorActive: false,
    validatorId: null,
    dht: null,
    hyparview: null,
    scribe: null,
    mixingNode: null, 
    wallets: new Map(),
};

const validationState = {
    // This state is now mostly managed in Rust, but JS needs to track candidates.
    candidateBlocks: [],
    // JS needs to know the selected block to initiate the VDF vote.
    selectedBlock: null, 
};

// --- CONSTANTS ---
const BOOTSTRAP_BLOCKS = 2;
const TICKS_PER_CYCLE = 120;

// --- LOGGING ---
function log(message, level = 'info') {
    if (parentPort) {
        parentPort.postMessage({ type: 'log', payload: { message, level } });
    } else {
        console.log(`[WORKER LOG - ${level.toUpperCase()}]: ${message}`);
    }
}

// --- MAIN EXECUTION WRAPPER ---
export async function main() {
    log('Worker starting initialization...');
    log('WASM initialized successfully.', 'success');
    workerState.initialized = true;
    parentPort.postMessage({ type: 'workerReady' });

    parentPort.on('message', async (event) => {
        if (!workerState.initialized) {
            log('Worker not yet initialized.', 'error');
            return;
        }
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
                    log(`Miner ${params.active ? `activated for ${params.minerId}` : 'deactivated'}.`, 'info');
                    parentPort.postMessage({ type: 'minerStatus', payload: { active: params.active } });
                    break;
                case 'createStake': await handleCreateStake(params); break;
                case 'activateStake': await handleActivateStake(params); break;
                case 'getValidators':
                    try {
                        const validators = await pluribit.get_validators();
                        log('Current Active Validators:', 'success');
                        console.table(validators);
                    } catch (e) {
                        log(`Could not get validators: ${e}`, 'error');
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
                case 'setValidatorActive':
                    workerState.validatorActive = params.active;
                    workerState.validatorId = params.active ? params.validatorId : null;
                    log(`Validator mode ${params.active ? `activated for ${params.validatorId}` : 'deactivated'}.`, 'info');
                    parentPort.postMessage({ type: 'validatorStatus', payload: { active: params.active } });
                    break;
            }
        } catch (error) {
            log(`Error handling action '${action}': ${error.message}`, 'error');
            parentPort.postMessage({ type: 'error', error: error.message });
        }
    });
}

// --- CORE FUNCTIONS ---
async function initializeNetwork() {
    log('Initializing network...');
    
    const blocks = await db.getAllBlocks();
    
    if (blocks.length > 0) {
        log(`Loading ${blocks.length} blocks from database...`, 'success');
        blocks.sort((a, b) => a.height - b.height);
        await pluribit.init_blockchain();
        for (let i = 1; i < blocks.length; i++) {
            await pluribit.add_block_to_chain(blocks[i]);
        }
        log(`Restored blockchain to height ${blocks[blocks.length - 1].height}`, 'success');
    } else {
        log('No existing blockchain found. Creating new genesis block.', 'info');
        await pluribit.init_blockchain();
        const chainState = await pluribit.get_blockchain_state();
        if (chainState.blocks && chainState.blocks.length > 0) {
            await db.saveBlock(chainState.blocks[0]);
        }
    }
    
    log('Loading validator state from database...', 'info');
    try {
        const savedValidators = await db.loadValidators();
        if (savedValidators && savedValidators.length > 0) {
            await pluribit.restore_validators_from_persistence(savedValidators);
            log(`Restored ${savedValidators.length} active validators.`, 'success');
        } else {
            log('No saved validators found. Starting with empty validator set.', 'info');
        }
    } catch (error) {
        log(`Failed to load validator state: ${error.message}`, 'error');
    }
    
    await pluribit.calibrateVDF();
    await pluribit.init_vdf_clock(BigInt(TICKS_PER_CYCLE));

    log('Initializing new P2P stack...', 'info');
    const nodeId = new Uint8Array(20);
    crypto.getRandomValues(nodeId);

    workerState.dht = new KademliaDHT(nodeId);
    workerState.hyparview = new HyParView(nodeId, workerState.dht);
    workerState.scribe = new Scribe(nodeId, workerState.dht);
    workerState.mixingNode = new MixingNode(); 

    messageBus.registerHandler('scribe:new_transaction', ({ message }) => {
        if (message && message.payload) {
            pluribit.add_transaction_to_pool(message.payload)
                .then(() => log(`Added network transaction to pool.`))
                .catch(e => log(`Failed to add network transaction: ${e}`, 'warn'));
        }
    });

    messageBus.registerHandler('scribe:new_block', ({ message }) => {
        if (message && message.payload) {
            handleRemoteBlockDownloaded({ block: message.payload });
        }
    });
    
    messageBus.registerHandler('CANDIDATE', ({ block }) => handleRemoteCandidate({ block }));
    messageBus.registerHandler('CANDIDATE_COMMITMENT', ({ commitment }) => handleRemoteCommitment({ commitment }));
    messageBus.registerHandler('VOTE', ({ voteData }) => handleRemoteVote({ voteData }));

    initP2P(workerState.dht, workerState.hyparview);

    await workerState.dht.bootstrap();
    await workerState.hyparview.bootstrap();

    workerState.scribe.subscribe('pluribit/transactions');
    workerState.scribe.subscribe('pluribit/blocks');
    workerState.scribe.startMaintenance();

    log('New P2P stack is online.', 'success');

    setInterval(handleConsensusTick, 1000);
    setInterval(handleVDFTick, 1000);

    parentPort.postMessage({ type: 'networkInitialized' });
    log('Network initialization complete.', 'success');
}

// --- REFACTORED CONSENSUS TICK ---
async function handleConsensusTick() {
    try {
        // All complex logic is now in Rust. We just call the single entry point.
        const result = await pluribit.consensus_tick();

        // The Rust module tells us what to do.
        if (result) {
            if (result.new_phase) {
                log(`Entering new phase: ${result.new_phase}`, 'info');
                workerState.consensusPhase = result.new_phase;
            }

            // Dispatch actions requested by the Rust consensus manager
            if (result.action_required) {
                switch (result.action_required) {
                    case 'START_MINING':
                        if (workerState.minerActive && !workerState.currentlyMining) {
                            startMining();
                        }
                        break;
                    case 'CREATE_COMMITMENT':
                        handleProvisionalCommitment();
                        break;
                    case 'RECONCILE_AND_SELECT':
                        handleReconciliation();
                        break;
                    case 'INITIATE_VDF_VOTE':
                        handleVDFVoting();
                        break;
                }
            }

            if (result.block_finalized) {
                log('A new block was successfully finalized and added to the chain!', 'success');
            }
        }
    } catch (e) {
        log(`Consensus tick error: ${e.message}`, 'error');
    }
}

async function handleVDFTick() {
    if (isLocked) return;
    try {
        await acquireLock();
        await pluribit.tick_vdf_clock();
    } catch (e) {
        log(`VDF tick error: ${e.message}`, 'error');
    } finally {
        releaseLock();
    }
}

async function startMining() {
    if (workerState.currentlyMining || !workerState.minerActive) return;
    workerState.currentlyMining = true;
    log(`Starting PoW mining for wallet: ${workerState.minerId}...`, 'info');

    try {
        const nextHeight = Number((await pluribit.get_blockchain_state()).current_height) + 1;
        const submissionCheck = await pluribit.check_block_submission(BigInt(nextHeight));
        
        if (!submissionCheck.can_submit) {
            log(`Cannot mine yet - VDF clock not ready. Ticks remaining: ${submissionCheck.ticks_remaining}`, 'warn');
            setTimeout(() => {
                workerState.currentlyMining = false;
            }, Number(submissionCheck.ticks_remaining) * 1000);
            return;
        }

        const minerWalletJson = workerState.wallets.get(workerState.minerId);
        if (!minerWalletJson) throw new Error(`Miner wallet '${workerState.minerId}' is not loaded.`);

        const walletData = await pluribit.wallet_get_data(minerWalletJson);
        const minerPubKeyBytes = new Uint8Array(walletData.scan_pub_key_hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        const latestHash = await pluribit.get_latest_block_hash();
        const difficulty = await pluribit.get_current_difficulty();
        const vdf_proof = await pluribit.compute_block_vdf_proof(latestHash);

        log(`Mining block #${nextHeight} at difficulty ${difficulty}...`, 'info');

        const miningResult = await pluribit.mine_block_with_txs(
            BigInt(nextHeight), latestHash, workerState.minerId, minerPubKeyBytes,
            difficulty, BigInt(10000000), vdf_proof
        );

        if (miningResult && miningResult.block) {
            log(`Block #${miningResult.block.height} MINED! Nonce: ${miningResult.block.nonce}`, 'success');
            
            // Broadcast the candidate block. The pipeline will handle adding it.
            broadcast({ type: 'CANDIDATE', block: miningResult.block });

        } else {
            log('Mining attempt did not produce a block.', 'warn');
        }
    } catch (e) {
        log(`Mining error: ${e.message}`, 'error');
    } finally {
        workerState.currentlyMining = false;
    }
}

async function handleProvisionalCommitment() {
    if (!workerState.validatorActive) return;
    
    try {
        const chainState = await pluribit.get_blockchain_state();
        const targetHeight = Number(chainState.current_height) + 1;
        
        const candidateHashes = validationState.candidateBlocks
            .filter(b => b.height === targetHeight)
            .map(b => b.hash);

        if (candidateHashes.length === 0) {
            log('No candidate blocks to commit to yet.', 'info');
            return;
        }

        log(`Creating commitment for ${candidateHashes.length} candidate blocks...`, 'info');
        const commitment = await pluribit.create_candidate_commitment(
            workerState.validatorId,
            BigInt(targetHeight),
            candidateHashes
        );

        broadcast({ type: 'CANDIDATE_COMMITMENT', commitment });
        log('Commitment broadcast to network.', 'success');
    } catch(e) {
        log(`Error creating commitment: ${e}`, 'error');
    }
}

async function handleReconciliation() {
    if (!workerState.validatorActive) return;

    try {
        const chainState = await pluribit.get_blockchain_state();
        const targetHeight = Number(chainState.current_height) + 1;

        const bestBlockHash = await pluribit.select_best_block(BigInt(targetHeight));
        
        if (bestBlockHash) {
            validationState.selectedBlock = bestBlockHash;
            log(`Reconciliation complete. Selected best global candidate: ${bestBlockHash.substring(0, 16)}...`, 'success');
        } else {
            log(`Reconciliation: No best block could be selected for height ${targetHeight}.`, 'warn');
            validationState.selectedBlock = null;
        }
    } catch(e) {
        log(`Error during reconciliation: ${e}`, 'error');
    }
}

async function handleVDFVoting() {
    if (!workerState.validatorActive || !validationState.selectedBlock) {
        log('VDF Voting: Skipping, no block was selected during reconciliation.', 'info');
        return;
    }
    
    log(`Offloading VDF vote computation for block ${validationState.selectedBlock.substring(0, 16)}...`, 'info');

    try {
        const validatorWalletJson = workerState.wallets.get(workerState.validatorId);
        if (!validatorWalletJson) throw new Error("Validator wallet not loaded");

        const walletData = JSON.parse(validatorWalletJson);
        const spendPrivKey = new Uint8Array(Object.values(walletData.spend_priv));

        const vdfWorker = new Worker(path.join(__dirname, 'vdf-worker.js'));

        vdfWorker.on('message', (event) => {
            if (event.success) {
                log('VDF vote computation complete!', 'success');
                broadcast({ type: 'VOTE', voteData: event.payload });
            } else {
                log(`VDF vote computation failed: ${event.error}`, 'error');
            }
            vdfWorker.terminate();
        });

        vdfWorker.postMessage({
            validatorId: workerState.validatorId,
            spendPrivKey: spendPrivKey,
            selectedBlockHash: validationState.selectedBlock,
        });
    } catch (e) {
        log(`Failed to start VDF voting worker: ${e}`, 'error');
    }
}

async function handleRemoteBlockDownloaded({ block }) {
    try {
        await acquireLock();
        await pluribit.submit_pow_candidate(block);
        
        await handlePotentialReorg(block);
        
        const chainState = await pluribit.get_blockchain_state();
        
        if (block.height === chainState.current_height + 1 && 
            block.prev_hash === chainState.blocks[chainState.current_height].hash) {
            
            log(`Processing block #${block.height} from network.`, 'info');
            const newChainState = await pluribit.add_block_to_chain(block);
            await db.saveBlock(block);
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

async function handleRemoteCandidate({ block }) {
    try {
        await acquireLock();
        const chainState = await pluribit.get_blockchain_state();
        const expectedHeight = chainState.current_height + 1;

        if (block && block.height === expectedHeight) {
            // Store in Rust's candidate map
            await pluribit.store_candidate_block(block.height, block.hash, block);
            // Also store in JS for local commitment creation
            if (!validationState.candidateBlocks.some(b => b.hash === block.hash)) {
                validationState.candidateBlocks.push(block);
            }
        }
    } catch (e) {
        log(`Rejected remote candidate: ${e}`, 'warn');
    } finally {
        releaseLock();
    }
}

async function handleRemoteCommitment({ commitment }) {
     try {
        await acquireLock();
        if (commitment) {
            await pluribit.store_candidate_commitment(
                commitment.height,
                commitment.validator_id,
                commitment
            );
        }
    } catch (e) {
        log(`Failed to store remote commitment: ${e}`, 'warn');
    } finally {
        releaseLock();
    }
}

async function handleRemoteVote({ voteData }) {
    try {
        await acquireLock();
        if (voteData) {
            await pluribit.store_network_vote(
                voteData.validator_id,
                voteData.block_height,
                voteData.block_hash,
                voteData.stake_amount,
                voteData.vdf_proof,
                voteData.signature
            );
        }
    } catch (e) {
        log(`Failed to process remote vote: ${e}`, 'warn');
    } finally {
        releaseLock();
    }
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

async function handlePotentialReorg(newBlock) {
    try {
        const chainState = await pluribit.get_blockchain_state();
        const currentTip = chainState.blocks[chainState.blocks.length - 1];
        
        if (newBlock.height <= chainState.current_height && 
            newBlock.hash !== chainState.blocks[newBlock.height].hash) {
            
            log(`Fork detected at height ${newBlock.height}. Block hash: ${newBlock.hash.substring(0, 16)}...`, 'warn');
            
            if (!reorgState.pendingForks.has(newBlock.height)) {
                reorgState.pendingForks.set(newBlock.height, new Map());
            }
            reorgState.pendingForks.get(newBlock.height).set(newBlock.hash, newBlock);
            
            await requestForkChain(newBlock);

        } else if (newBlock.prev_hash !== currentTip.hash && newBlock.height === currentTip.height + 1) {
            log(`Competing block received at height ${newBlock.height}`, 'info');
            
            if (!reorgState.pendingForks.has(newBlock.height)) {
                reorgState.pendingForks.set(newBlock.height, new Map());
            }
            reorgState.pendingForks.get(newBlock.height).set(newBlock.hash, newBlock);
            
            await requestForkChain(newBlock);
        }
    } catch (e) {
        log(`Error in handlePotentialReorg: ${e}`, 'error');
    }
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
            broadcast({
                type: 'BLOCK_REQUEST',
                hash: currentBlock.prev_hash,
                height: currentBlock.height - 1
            });
            return; 
        }
        
        const parentBlocks = reorgState.pendingForks.get(currentBlock.height - 1);
        if (parentBlocks && parentBlocks.has(currentBlock.prev_hash)) {
            currentBlock = parentBlocks.get(currentBlock.prev_hash);
        } else {
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
            log(`Fork has more work (${forkWork} > ${ourWork}). Initiating reorganization...`, 'warn');
            await performReorganization(commonAncestorHeight, forkChain);
        } else {
            log(`Our chain has more work. Keeping current chain.`, 'info');
            cleanupForkCache(commonAncestorHeight);
        }
    } catch (e) {
        log(`Error evaluating fork: ${e}`, 'error');
    }
}

async function performReorganization(commonAncestorHeight, newChain) {
    try {
        log(`Starting reorganization from height ${commonAncestorHeight}`, 'warn');
        
        const chainState = await pluribit.get_blockchain_state();
        const blocksToRewind = [];
        
        for (let height = chainState.current_height; height > commonAncestorHeight; height--) {
            const block = chainState.blocks[height];
            if (block) {
                blocksToRewind.push(block);
            }
        }
        
        log(`Rewinding ${blocksToRewind.length} blocks...`, 'info');
        for (const block of blocksToRewind) {
            await pluribit.rewind_block(block);
            
            for (const [walletId, walletJson] of workerState.wallets.entries()) {
                const updatedWallet = await pluribit.wallet_unscan_block(walletJson, block);
                if (updatedWallet !== walletJson) {
                    workerState.wallets.set(walletId, updatedWallet);
                    const newBalance = await pluribit.wallet_get_balance(updatedWallet);
                    parentPort.postMessage({ 
                        type: 'walletBalance', 
                        payload: { wallet_id: walletId, balance: newBalance }
                    });
                }
            }
        }
        
        log(`Applying ${newChain.length} blocks from fork...`, 'info');
        for (const block of newChain) {
            await pluribit.add_block_to_chain(block);
            await db.saveBlock(block);
            
            for (const [walletId, walletJson] of workerState.wallets.entries()) {
                const updatedWallet = await pluribit.wallet_scan_block(walletJson, block);
                if (updatedWallet !== walletJson) {
                    workerState.wallets.set(walletId, updatedWallet);
                    const newBalance = await pluribit.wallet_get_balance(updatedWallet);
                    parentPort.postMessage({ 
                        type: 'walletBalance', 
                        payload: { wallet_id: walletId, balance: newBalance }
                    });
                }
            }
            
            log(`Applied block #${block.height} from fork`, 'success');
        }
        
        cleanupForkCache(newChain[newChain.length - 1].height);
        
        const newTip = newChain[newChain.length - 1];
        broadcast({
            type: 'BLOCK_ANNOUNCEMENT',
            height: newTip.height,
            hash: newTip.hash
        });
        
        log(`Reorganization complete. New chain tip at height ${newTip.height}`, 'success');
        
    } catch (e) {
        log(`Critical error during reorganization: ${e}`, 'error');
    }
}

function cleanupForkCache(keepAboveHeight) {
    const heights = Array.from(reorgState.pendingForks.keys());
    for (const height of heights) {
        if (height <= keepAboveHeight) {
            reorgState.pendingForks.delete(height);
        }
    }
    reorgState.requestedBlocks.clear();
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
        
        if (workerState.scribe) {
            const txPayload = {
                type: 'new_transaction',
                payload: result.transaction
            };
            workerState.scribe.multicast('pluribit/transactions', txPayload);
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
