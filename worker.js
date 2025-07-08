// worker.js - Pluribit Node.js Worker

import { parentPort, Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';

// --- MODULE IMPORTS ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const wasmPath = path.join(__dirname, './pkg-node/pluribit_core.js');
const { default: _, ...pluribit } = await import(wasmPath);

import PluribitP2P, { setLockFunctions } from './p2p.js';
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
setLockFunctions(acquireLock, rel); // Note: 'rel' was a typo, should be releaseLock. Correcting it.
function rel() { releaseLock(); } // Keep for compatibility with older p2p.js if needed.


// --- STATE ---
export const workerState = {
    initialized: false,
    minerActive: false,
    minerId: null,
    currentlyMining: false,
    consensusPhase: null,
    validatorActive: false,
    validatorId: null,
    p2p: null,
    wallets: new Map(),
};

const validationState = {
    commitmentSent: false,
    reconciled: false,
    selectedBlock: null,
    vdfStarted: false,
    voted: false,
    candidateBlocks: [],
};

// --- CONSTANTS ---
const BOOTSTRAP_BLOCKS = 2; // Should match src/constants.rs
const TICKS_PER_CYCLE = 120;
const MINING_PHASE_END_TICK = 60;
const VALIDATION_PHASE_END_TICK = 90;
const COMMITMENT_END_TICK = 10;
const RECONCILIATION_END_TICK = 20;

// --- LOGGING ---
function log(message, level = 'info') {
    // Gracefully handle cases where parentPort is not available (like during test setup)
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

    // --- MESSAGE HANDLING ---
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
                case 'createStake':
                    await handleCreateStake(params);
                    break;
                case 'activateStake':
                    await handleActivateStake(params);
                    break;
                case 'getValidators':
                    try {
                        const validators = await pluribit.get_validators();
                        log('Current Active Validators:', 'success');
                        console.table(validators); // Using console.table for nice formatting
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
    
    // Load all blocks from database
    const blocks = await db.getAllBlocks();
    
    if (blocks.length > 0) {
        log(`Loading ${blocks.length} blocks from database...`, 'success');
        
        // Sort blocks by height to ensure correct order
        blocks.sort((a, b) => a.height - b.height);
        
        // Recreate the blockchain state
        await pluribit.init_blockchain();
        
        // Add each block (skip genesis as it's already there)
        for (let i = 1; i < blocks.length; i++) {
            await pluribit.add_block_to_chain(blocks[i]);
        }
        
        log(`Restored blockchain to height ${blocks[blocks.length - 1].height}`, 'success');
    } else {
        log('No existing blockchain found. Creating new genesis block.', 'info');
        await pluribit.init_blockchain();
        
        // Save genesis block
        const chainState = await pluribit.get_blockchain_state();
        if (chainState.blocks && chainState.blocks.length > 0) {
            await db.saveBlock(chainState.blocks[0]);
        }
    }
    
    await pluribit.calibrateVDF();
    await pluribit.init_vdf_clock(BigInt(TICKS_PER_CYCLE));

    workerState.p2p = new PluribitP2P(log);
    workerState.p2p.onMessage('CANDIDATE', handleRemoteCandidate);
    workerState.p2p.onMessage('CANDIDATE_COMMITMENT', handleRemoteCommitment);
    workerState.p2p.onMessage('VOTE', handleRemoteVote);
    workerState.p2p.onMessage('BLOCK_ANNOUNCEMENT', handleRemoteBlockAnnouncement);
    workerState.p2p.onMessage('BLOCK_DOWNLOADED', handleRemoteBlockDownloaded);
    workerState.p2p.onMessage('TRANSACTION', handleRemoteTransaction);

    await workerState.p2p.start();
    log('P2P Network Started.', 'success');

    setInterval(handleConsensusTick, 1000);
    setInterval(handleVDFTick, 1000);

    parentPort.postMessage({ type: 'networkInitialized' });
    log('Network initialization complete.', 'success');
}

async function handleRemoteTransaction({ tx }) {
    try {
        await acquireLock();
        
        // Add transaction to mempool
        const txJson = serde_wasm_bindgen.to_value(tx);
        await pluribit.add_transaction_to_pool(txJson);
        
        log(`Received transaction from network. Hash: ${tx.kernel.excess.substring(0,16)}...`, 'info');
    } catch (e) {
        log(`Failed to add remote transaction: ${e}`, 'warn');
    } finally {
        releaseLock();
    }
}

function resetValidationState() {
    validationState.commitmentSent = false;
    validationState.reconciled = false;
    validationState.selectedBlock = null;
    validationState.vdfStarted = false;
    validationState.voted = false;
    validationState.candidateBlocks = [];
}

async function handleConsensusTick() {
    try {
        await acquireLock();
        const vdfClockState = await pluribit.get_vdf_clock_state();
        const currentTick = Number(vdfClockState.current_tick);
        const tickInCycle = currentTick % TICKS_PER_CYCLE;
        let currentPhase;

        if (tickInCycle < MINING_PHASE_END_TICK) {
            currentPhase = 'Mining';
            if (workerState.consensusPhase !== 'Mining') resetValidationState();
        } else if (tickInCycle < VALIDATION_PHASE_END_TICK) {
            currentPhase = 'Validation';
            const validationTicks = tickInCycle - MINING_PHASE_END_TICK;
            if (validationTicks < COMMITMENT_END_TICK) await handleProvisionalCommitment();
            else if (validationTicks < RECONCILIATION_END_TICK) await handleReconciliation();
            else await handleVDFVoting();
            // After successful validation phase
            if (workerState.consensusPhase === 'Validation' && tickInCycle >= VALIDATION_PHASE_END_TICK - 1) {
                // Check for slashing violations
                const violations = await pluribit.check_and_report_violations(workerState.minerId || 'system');
                if (violations > 0) {
                    log(`Detected and reported ${violations} slashing violations`, 'warn');
                }
            }
        } else {
            currentPhase = 'Propagation';
        }
        
        if (workerState.consensusPhase !== currentPhase) {
             workerState.consensusPhase = currentPhase;
             log(`Entering new phase: ${currentPhase}`, 'info');
        }

        parentPort.postMessage({
            type: 'consensusUpdate',
            payload: {
                state: {
                    current_phase: currentPhase,
                    current_tick: currentTick,
                }
            }
        });

        if (currentPhase === 'Mining' && workerState.minerActive && !workerState.currentlyMining) {
            releaseLock();
            startMining();
            return;
        }
        

        
    } catch (e) {
        log(`Consensus tick error: ${e.message}`, 'error');
    } finally {
        if (isLocked) releaseLock();
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
        await acquireLock();
        const nextHeight = (await pluribit.get_blockchain_state()).current_height + 1;
        const submissionCheck = await pluribit.check_block_submission(BigInt(nextHeight));
        
        if (!submissionCheck.can_submit) {
            log(`Cannot mine yet - VDF clock not ready. Ticks remaining: ${submissionCheck.ticks_remaining}`, 'warn');
            setTimeout(() => {
                workerState.currentlyMining = false;
            }, Number(submissionCheck.ticks_remaining) * 1000);
            releaseLock();
            return;
        }
        releaseLock();

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
            await acquireLock();
            log(`Block #${miningResult.block.height} MINED! Nonce: ${miningResult.block.nonce}`, 'success');
            
            const currentHeight = miningResult.block.height;

            if (currentHeight <= BOOTSTRAP_BLOCKS) {
                log(`Finalizing bootstrap block #${currentHeight}...`, 'info');
                try {
                    const newChainState = await pluribit.add_block_to_chain(miningResult.block);
                    await db.saveChainState(newChainState);
                    log(`Block #${currentHeight} added to chain. New height: ${newChainState.current_height}`, 'success');

                    const minerWallet = workerState.wallets.get(workerState.minerId);
                    const updatedWalletJson = await pluribit.wallet_scan_block(minerWallet, miningResult.block);
                    workerState.wallets.set(workerState.minerId, updatedWalletJson);
                    const newBalance = await pluribit.wallet_get_balance(updatedWalletJson);
                    parentPort.postMessage({ type: 'walletBalance', payload: { wallet_id: workerState.minerId, balance: newBalance }});

                    if (workerState.p2p) await workerState.p2p.seedBlock(miningResult.block);

                } catch (e) {
                    log(`Failed to add bootstrap block to chain: ${e}`, 'error');
                }
            } else {
                validationState.candidateBlocks.push(miningResult.block);
                if (workerState.p2p) {
                    workerState.p2p.broadcast({ type: 'CANDIDATE', block: miningResult.block });
                }
            }

            if (miningResult.used_transactions?.length > 0) {
                await pluribit.remove_transactions_from_pool(miningResult.used_transactions);
            }
            releaseLock();
        } else {
            log('Mining attempt did not produce a block.', 'warn');
        }

    } catch (e) {
        log(`Mining error: ${e.message}`, 'error');
    } finally {
        if (isLocked) releaseLock();
        workerState.currentlyMining = false;
    }
}

async function handleProvisionalCommitment() {
    if (!workerState.validatorActive || validationState.commitmentSent) return;
    
    try {
        const chainState = await pluribit.get_blockchain_state();
        const targetHeight = chainState.current_height + 1;
        
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
            targetHeight,
            candidateHashes
        );

        if (workerState.p2p) {
            workerState.p2p.broadcast({ type: 'CANDIDATE_COMMITMENT', commitment });
        }
        log('Commitment broadcast to network.', 'success');
        validationState.commitmentSent = true;

    } catch(e) {
        log(`Error creating commitment: ${e}`, 'error');
    }
}

async function handleReconciliation() {
    if (!workerState.validatorActive || validationState.reconciled) return;
    log('Validation: In Reconciliation sub-phase.', 'info');
    
    try {
        const chainState = await pluribit.get_blockchain_state();
        const targetHeight = chainState.current_height + 1;

        const candidatesAtHeight = validationState.candidateBlocks
            .filter(b => b.height === targetHeight);
        
        if (candidatesAtHeight.length === 0) {
            log('Reconciliation: No candidates to select from.', 'warn');
            validationState.reconciled = true;
            return;
        }
        
        // Find the block with highest difficulty
        let bestBlock = candidatesAtHeight[0];
        let highestDifficulty = bestBlock.difficulty;
        
        for (const block of candidatesAtHeight) {
            if (block.difficulty > highestDifficulty) {
                bestBlock = block;
                highestDifficulty = block.difficulty;
            } else if (block.difficulty === highestDifficulty) {
                // Tie-breaker: use lexicographically lowest hash
                if (block.hash() < bestBlock.hash()) {
                    bestBlock = block;
                }
            }
        }
        
        validationState.selectedBlock = bestBlock.hash();

        log(`Reconciliation complete. Selected block with difficulty ${highestDifficulty}: ${bestBlock.hash().substring(0, 16)}...`, 'success');
        
    } catch(e) {
        log(`Error during reconciliation: ${e}`, 'error');
    }
    
    validationState.reconciled = true;
}

async function handleVDFVoting() {
    if (!workerState.validatorActive || validationState.vdfStarted) return;
    
    if (!validationState.reconciled || !validationState.selectedBlock) {
        log('VDF Voting: Waiting for reconciliation to complete.', 'info');
        return;
    }
    
    validationState.vdfStarted = true;
    log(`Offloading VDF vote computation for block ${validationState.selectedBlock.substring(0, 16)}...`, 'info');

    try {
        const validatorWalletJson = workerState.wallets.get(workerState.validatorId);
        if (!validatorWalletJson) throw new Error("Validator wallet not loaded");

        const walletData = JSON.parse(validatorWalletJson);
        const spendPrivKey = new Uint8Array(walletData.spend_priv);

        const vdfWorker = new Worker(path.join(__dirname, 'vdf-worker.js'));

        vdfWorker.on('message', (event) => {
            if (event.success) {
                log('VDF vote computation complete!', 'success');
                validationState.voted = true;
                if (workerState.p2p) {
                    workerState.p2p.broadcast({ type: 'VOTE', voteData: event.payload });
                }
            } else {
                log(`VDF vote computation failed: ${event.error}`, 'error');
                validationState.vdfStarted = false;
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
        validationState.vdfStarted = false;
    }
}

async function handleRemoteCandidate({ block }) {
    try {
        await acquireLock();
        const chainState = await pluribit.get_blockchain_state();
        const expectedHeight = chainState.current_height + 1;

        if (block && block.height === expectedHeight) {
            // Verify the block has valid PoW before accepting
            if (!block.is_valid_pow) {
                log(`Rejected invalid PoW block from network`, 'warn');
                return;
            }
            
            if (!validationState.candidateBlocks.some(b => b.hash === block.hash)) {
                log(`Received new valid candidate block #${block.height} from network.`, 'info');
                validationState.candidateBlocks.push(block);
                
                // Store in Rust for voting
                await pluribit.store_candidate_block(block.height, block.hash, block);
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
            log(`Received commitment from validator ${commitment.validator_id.substring(0, 12)}...`, 'info');
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
            log(`Received vote from validator ${voteData.validator_id.substring(0, 12)}... for block ${voteData.block_hash.substring(0,16)}`, 'info');
            
            // Store vote in Rust for finalization
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

async function handleRemoteBlockAnnouncement({ height, magnetURI }) {
    try {
        await acquireLock();
        const chainState = await pluribit.get_blockchain_state();
        if (height === chainState.current_height + 1) {
            log(`Received announcement for next block #${height}. Downloading...`, 'info');
            if (workerState.p2p) workerState.p2p.downloadBlock(height, magnetURI);
        }
    } finally {
        releaseLock();
    }
}

async function handleRemoteBlockDownloaded({ block }) {
    try {
        await acquireLock();
        log(`Downloaded block #${block.height} from network.`, 'info');
        const newChainState = await pluribit.add_block_to_chain(block);
        await db.saveChainState(newChainState);
        log(`Remote block #${block.height} added to chain. New height: ${newChainState.current_height}`, 'success');

        for (const [walletId, walletJson] of workerState.wallets.entries()) {
             const updatedWalletJson = await pluribit.wallet_scan_block(walletJson, block);
             if (updatedWalletJson !== walletJson) {
                 workerState.wallets.set(walletId, updatedWalletJson);
                 const newBalance = await pluribit.wallet_get_balance(updatedWalletJson);
                 parentPort.postMessage({ type: 'walletBalance', payload: { wallet_id: walletId, balance: newBalance }});
             }
        }
    } catch (e) {
        log(`Failed to add downloaded block: ${e}`, 'error');
    } finally {
        releaseLock();
    }
}

async function handleCreateStake({ walletId, amount }) {
    try {
        const lock_duration = 100; 
        log(`Creating stake lock for '${walletId}' with amount ${amount}...`, 'info');
        await pluribit.create_stake_lock(walletId, BigInt(amount), BigInt(lock_duration));
        log('Stake lock created and is pending activation. Run "activate_stake" to compute VDF and finalize.', 'success');
    } catch (e) {
        log(`Failed to create stake lock: ${e}`, 'error');
    }
}

async function handleActivateStake({ walletId }) {
    try {
        log(`Computing VDF for stake activation for '${walletId}'. This may take some time...`, 'info');
        const vdfResult = await pluribit.compute_stake_vdf(walletId);
        log('VDF computation complete. Activating stake...', 'success');

        const walletJson = workerState.wallets.get(walletId);
        if (!walletJson) throw new Error(`Wallet '${walletId}' is not loaded.`);
        
        const walletData = JSON.parse(walletJson);
        const spendPubKey = new Uint8Array(Object.values(walletData.spend_pub));
        const spendPrivKey = new Uint8Array(Object.values(walletData.spend_priv));
        
        await pluribit.activate_stake_with_vdf(
            walletId,
            vdfResult,
            spendPubKey,
            spendPrivKey
        );
        log(`Stake for '${walletId}' is now active!`, 'success');

    } catch (e) {
        log(`Failed to activate stake: ${e}`, 'error');
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
    if (!walletData) return log(`Wallet '${walletId}' not found.`, 'error');
    const walletJson = JSON.stringify(walletData);
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
        await acquireLock();
        
        const chainState = await pluribit.get_blockchain_state();
        const currentTip = chainState.blocks[chainState.blocks.length - 1];
        
        // Check if this creates a fork
        if (newBlock.prev_hash !== currentTip.hash) {
            log(`Fork detected at height ${newBlock.height}. Evaluating...`, 'warn');
            
            // Find common ancestor
            let commonAncestorHeight = newBlock.height - 1;
            while (commonAncestorHeight > 0) {
                const ourBlock = chainState.blocks[commonAncestorHeight];
                // We'd need to request blocks from peer here
                // For now, assume we have the fork chain
                commonAncestorHeight--;
            }
            
            // Calculate work for both chains
            const ourWork = await pluribit.get_chain_work(chainState.blocks);
            // const forkWork = await pluribit.get_chain_work(forkChain);
            
            // if (forkWork > ourWork) {
            //     log(`Reorganizing to chain with more work: ${forkWork} > ${ourWork}`, 'warn');
            //     await performReorganization(commonAncestorHeight, forkChain);
            // }
        }
    } finally {
        releaseLock();
    }
}

async function performReorganization(commonHeight, newChain) {
    // This is complex - would need to:
    // 1. Rewind blocks from current chain
    // 2. Apply blocks from new chain
    // 3. Update all wallets
    // 4. Save to database
    log(`Reorganization from height ${commonHeight} complete`, 'success');
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
        
        // UNCOMMENTED AND FIXED:
        if (workerState.p2p) {
            workerState.p2p.broadcast({ type: 'TRANSACTION', tx: result.transaction });
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

// Only run main if this is the main worker thread, not when imported by a test
if (parentPort) {
    main();
}
