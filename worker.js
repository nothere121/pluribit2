// worker.js - Pluribit Browser Node Worker

import init, { 
    create_genesis_block,
    init_vdf_clock,        
    tick_vdf_clock,
    get_vdf_clock_state,
    check_block_submission,
    init_blockchain,
    add_block_to_chain,
    get_blockchain_state,
    get_blockchain_with_hashes,  
    get_latest_block_hash,
    consensus_tick,
    submit_pow_candidate,
    create_stake_lock,
    compute_stake_vdf,
    activate_stake_with_vdf,
    vote_for_block,
    get_validators,
    wallet_create, 
    wallet_create_transaction,
    wallet_get_balance, 
    get_tx_pool,
    mine_block_with_txs,
    add_transaction_to_pool,
    verify_transaction,
    clear_transaction_pool,
    get_transaction_hash,
    update_utxo_set_from_block,
    get_utxo_set_size,
    wallet_get_data, 
    get_current_difficulty,
    compute_block_vdf_proof,
    create_utxo_snapshot,
    restore_from_utxo_snapshot,
    prune_blockchain,
    get_chain_storage_size,
    check_and_report_violations,
    wallet_scan_blockchain, 
    scan_pending_transactions,
        wallet_get_address,
    validate_address,
    get_genesis_timestamp,
        run_vdf_benchmark,          
    set_calibrated_vdf_speed,   
    wallet_get_stealth_address,
    create_transaction_to_stealth_address,
    sign_message,
        create_final_selection,
    store_candidate_commitment,
    store_final_selection,
    get_candidate_blocks_at_height,
    create_candidate_commitment,
    get_all_known_blocks_from_commitments,
    select_best_block
} from './pkg/pluribit_core.js';

import PluribitP2P from './dist/wt-p2p.dist.js';

const workerState = {
    initialized: false,
    minerActive: false,
    minerId: 'browser_miner_001',
    currentlyMining: false,
    consensusPhase: null,
    validatorActive: false,
    validatorId: null,
    computingVDF: false,
    p2p: null,
    networkStarted: false,
    remoteVotes: new Map(), // blockHeight -> Map(validatorId -> vote)
    processedTxHashes: new Set(), // Prevent duplicate tx processing
    miningInProgress: false,
    wallets: new Map(), // Store wallet JSON by ID
    currentWalletData: null, 
    candidateBlocks: [], 
};

let GENESIS_TIMESTAMP = 0; 




const validationState = {
    commitmentSent: false,
    reconciled: false,
    selectedBlock: null,
    vdfStarted: false,
    voted: false
};

// Initialize WASM on worker start
(async () => {
    try {
        console.log('[WORKER] Starting initialization...');

        // **THE FIX IS HERE**: We now pass the exact URL of the wasm file to init().
        await init(new URL('./pkg/pluribit_core_bg.wasm', import.meta.url));

        GENESIS_TIMESTAMP = await get_genesis_timestamp();
        console.log(`[WORKER] Genesis timestamp set to: ${GENESIS_TIMESTAMP}`);


        console.log('[WORKER] WASM initialized successfully');
        workerState.initialized = true;
        
        self.postMessage({ 
            type: 'workerReady',
            success: true
        });
    } catch (e) {
        console.error('[WORKER] Failed to initialize:', e);
        self.postMessage({ 
            type: 'error', 
            error: 'Failed to initialize WASM: ' + e.toString() 
        });
    }
})();




// Message handler
self.onmessage = async (event) => {
    if (!workerState.initialized) {
        self.postMessage({ 
            type: 'error', 
            error: 'Worker not yet initialized' 
        });
        return;
    }

    const { action, ...params } = event.data;
    
    try {
        switch(action) {
            case 'initializeNetwork':
                await initializeNetwork();
                break;
            
            case 'consensusTick':
                await handleConsensusTick();
                break;
            
            case 'tickVDFClock':
                await handleVDFTick();
                break;
            
            case 'setMinerActive':
                workerState.minerActive = params.active;
                workerState.minerId = params.minerId || workerState.minerId;
                console.log(`[WORKER] Miner ${params.active ? 'activated' : 'deactivated'}`);
                break;
            
            case 'getBlockchainState':
                await sendBlockchainState();
                break;
            case 'createStakeLock':
                await handleCreateStakeLock(params);
                break;
            
            case 'computeStakeVDF':
                await handleComputeStakeVDF(params);
                break;
            
            case 'activateStake':
                await handleActivateStake(params);
                break;
            
            case 'setValidatorActive':
                workerState.validatorActive = params.active;
                workerState.validatorId = params.validatorId;
                break;
            case 'createAndSeedSnapshot':
                await handleCreateAndSeedSnapshot();
                break;

            case 'syncFromSnapshot':
                await handleSyncFromSnapshot(params);
                break;
            case 'getStorageInfo':
                await handleGetStorageInfo();
                break;
            case 'pruneChain':
                await handlePruneChain(params);
                break;
            case 'voteForBlock':
                await handleVoteForBlock(params);
                break;
            case 'initWallet':
                await handleInitWallet(params);
                break;
            
            case 'createTransaction':
                await handleCreateTransaction(params);
                break;
            
            case 'getWalletBalance':
                await handleGetWalletBalance(params);
                break;
            case 'getWalletAddress':
                await handleGetWalletAddress(params);
                break;
            case 'getTxPool':
                await handleGetTxPool();
                break;
            case 'loadWallet':
                await handleLoadWallet(params);
                break;
           case 'checkViolations':
               await handleCheckViolations(params);
               break;
    
            default:
                console.warn('[WORKER] Unknown action:', action);
        }
    } catch (error) {
        console.error(`[WORKER] Error handling ${action}:`, error);
        self.postMessage({ 
            type: 'error', 
            error: `${action} failed: ${error.toString()}` 
        });
    }
};


async function handleCheckViolations({ reporterId }) {
    try {
        const slashedCount = await check_and_report_violations(reporterId);
        
        self.postMessage({
            type: 'violationsChecked',
            success: true,
            payload: { slashedCount }
        });

    } catch (error) {
        self.postMessage({
            type: 'log',
            payload: { message: `Violation check failed: ${error}`, level: 'error' }
        });
    }
}


async function handleCreateAndSeedSnapshot() {
    try {
        // Create snapshot
        const snapshot = await create_utxo_snapshot();
        
        // Seed via P2P
        if (workerState.p2p) {
            const magnetURI = await workerState.p2p.seedUTXOSnapshot(snapshot);
            
            self.postMessage({
                type: 'snapshotCreated',
                success: true,
                payload: {
                    height: snapshot.height,
                    utxo_count: snapshot.utxos.length,
                    magnetURI
                }
            });
        }
    } catch (e) {
        console.error('[WORKER] Failed to create snapshot:', e);
        self.postMessage({
            type: 'error',
            error: `Snapshot creation failed: ${e.toString()}`
        });
    }
}

async function handleSyncFromSnapshot({ height }) {
    try {
        let targetHeight = height;
        
        // If no height specified, get latest
        if (!targetHeight && workerState.p2p) {
            targetHeight = await workerState.p2p.getLatestSnapshotHeight();
        }
        
        if (!targetHeight) {
            throw new Error('No snapshot height available');
        }
        
        console.log(`[WORKER] Syncing from UTXO snapshot at height ${targetHeight}`);
        
        // Download snapshot
        const snapshot = await workerState.p2p.downloadUTXOSnapshot(targetHeight);
        
        // Restore chain state
        await restore_from_utxo_snapshot(snapshot);
        
        // Download recent blocks
        const currentHeight = snapshot.height;
        const chainState = await get_blockchain_state();
        const latestNetworkHeight = await workerState.p2p.getLatestBlockHeight();
        
        console.log(`[WORKER] Catching up from ${currentHeight} to ${latestNetworkHeight}`);
        
        // Download blocks since snapshot
        for (let h = currentHeight + 1; h <= latestNetworkHeight; h++) {
            const blockInfo = await workerState.p2p.downloadBlock(h);
            if (blockInfo) {
                await add_block_to_chain(blockInfo.block);
            }
        }
        
        self.postMessage({
            type: 'syncComplete',
            success: true,
            payload: {
                snapshotHeight: targetHeight,
                currentHeight: latestNetworkHeight
            }
        });
        
    } catch (e) {
        console.error('[WORKER] Sync from snapshot failed:', e);
        self.postMessage({
            type: 'error',
            error: `Snapshot sync failed: ${e.toString()}`
        });
    }
}


async function handleGetStorageInfo() {
    try {
        const info = await get_chain_storage_size();
        self.postMessage({
            type: 'storageInfo',
            success: true,
            payload: info
        });
    } catch (e) {
        console.error('[WORKER] Failed to get storage info:', e);
        self.postMessage({
            type: 'error',
            error: `Failed to get storage info: ${e.toString()}`
        });
    }
}

async function handlePruneChain({ keepRecentBlocks }) {
    try {
        //const keepBlocks = keepRecentBlocks || 144; // Default to 48 hours
        const keepBlocks = keepRecentBlocks ? BigInt(keepRecentBlocks) : 144n; // Default to 144 as a BigInt

        // Get storage info before pruning
        const beforeInfo = await get_chain_storage_size();
        
        // Prune chain
        await prune_blockchain(keepBlocks);
        
        // Get storage info after pruning
        const afterInfo = await get_chain_storage_size();
        
        self.postMessage({
            type: 'chainPruned',
            success: true,
            payload: {
                before: beforeInfo,
                after: afterInfo,
                saved_mb: beforeInfo.total_size_mb - afterInfo.total_size_mb
            }
        });
        
    } catch (e) {
        console.error('[WORKER] Chain pruning failed:', e);
        self.postMessage({
            type: 'error',
            error: `Pruning failed: ${e.toString()}`
        });
    }
}

// Initialize the network (blockchain + VDF clock)
async function initializeNetwork() {
    try {
        console.log('[WORKER] Step 1: Initializing blockchain...');
        const chainState = await init_blockchain();
        
        // Run calibration *before* initializing the VDF clock.
        console.log('[WORKER] Calibrating VDF clock...');
        await calibrateVDF();
        
        console.log('[WORKER] Step 2: Initializing VDF clock...');
        const vdfState = await init_vdf_clock(10n);
        
        console.log('[WORKER] Step 3: Starting P2P network...');
        await startP2PNetwork();
        
        console.log('[WORKER] Step 4: Getting blockchain with hashes...');
        const chainWithHashes = await get_blockchain_with_hashes();
        
        console.log('[WORKER] Sending success message...');
        self.postMessage({
            type: 'networkInitialized',
            success: true,
            payload: { chainState: chainWithHashes, vdfState }
        });
        console.log('[WORKER] Network initialization complete');
        
    } catch (e) {
        console.error('[WORKER] Network initialization failed:', e);
        self.postMessage({
            type: 'error',
            error: `Network init failed: ${e.toString()}`
        });
    }
}

async function startP2PNetwork() {
    if (workerState.networkStarted) return;
    
    try {
        workerState.p2p = new PluribitP2P();
        const peerId = await workerState.p2p.start();
        
        // Setup message handlers for WebTorrent approach
        workerState.p2p.onMessage('BLOCK_DOWNLOADED', handleRemoteBlock);
        workerState.p2p.onMessage('CANDIDATE', handleRemoteCandidate);
        workerState.p2p.onMessage('VOTE', handleRemoteVote);
        workerState.p2p.onMessage('TRANSACTION', handleRemoteTransaction);
        
        // NEW: Handle known block heights for syncing
        workerState.p2p.onMessage('BLOCK_HEIGHTS_KNOWN', async (heights) => {
            console.log('[WORKER] Network knows about blocks:', heights);
            const localChain = await get_blockchain_state();
            
            // Download any missing blocks
            for (const height of heights) {
                if (height > localChain.current_height) {
                    console.log('[WORKER] Network has block', height, 'that we don\'t have');
                }
            }
        });


        workerState.p2p.onMessage('CANDIDATE_COMMITMENT', async (message) => {
            const { commitment, from } = message;
            await store_candidate_commitment(
                commitment.height,
                from,
                commitment
            );
            console.log(`[WORKER] Received commitment from ${from}`);
        });
        
        workerState.p2p.onMessage('FINAL_SELECTION', async (message) => {
            const { selection, from } = message;
            await store_final_selection(
                selection.height,
                from,
                selection
            );
            console.log(`[WORKER] ${from} selected block ${selection.selected_block_hash.substring(0, 16)}...`);
        });
        
        workerState.p2p.onMessage('BLOCK_REQUEST_BY_HASH', async (message) => {
            const { hash, from } = message;
            const currentHeight = (await get_blockchain_state()).current_height + 1;
            const candidates = await get_candidate_blocks_at_height(currentHeight);
            const block = candidates.find(b => b.hash === hash);
            
            if (block) {
                workerState.p2p.sendTo(from, {
                    type: 'BLOCK_RESPONSE',
                    block: block,
                    hash: hash
                });
            }
        });


        workerState.networkStarted = true;
        
                
        // Seed genesis block if we have it
        const chain = await get_blockchain_state();
        if (chain.blocks && chain.blocks.length > 0) {
            console.log('[WORKER] Seeding our existing blocks to network');
            for (const block of chain.blocks) {
                await workerState.p2p.seedBlock(block);
            }
        }
        
        self.postMessage({
            type: 'p2pStarted',
            success: true,
            payload: { peerId }
        });
        
        // Start peer count updates
        setInterval(() => {
            const peerCount = workerState.p2p.getPeerCount();
            self.postMessage({
                type: 'peerCountUpdate',
                payload: { count: peerCount }
            });
        }, 5000);
        
    } catch (e) {
        console.error('[WORKER] Failed to start P2P:', e);
        self.postMessage({
            type: 'error',
            error: 'Failed to start P2P network: ' + e.toString()
        });
    }
}

//  P2P message handlers
async function handleRemoteBlock({ block }) {
    console.log('[WORKER] Downloaded block from network:', block.height);
    
    try {
        const currentChain = await get_blockchain_state();
        
        // Validate block height sequence
        if (block.height !== currentChain.current_height + 1) {
            console.log('[WORKER] Block height mismatch, expected:', currentChain.current_height + 1, 'got:', block.height);
            return;
        }
        
        // Add block to chain
        await add_block_to_chain(block);
        
        // Clear votes for this height
        workerState.remoteVotes.delete(block.height);
        
        // Update UTXO set
        await update_utxo_set_from_block(block);
        
        // Scan all loaded wallets for new transactions in this block
        for (const [walletId, walletJson] of workerState.wallets) {
            try {
                // Create a temporary scan by re-scanning the blockchain
                // This is necessary because scan_block is not exposed directly
                const updatedWalletJson = await wallet_scan_blockchain(walletJson);
                
                // Check if balance changed
                const oldBalance = await wallet_get_balance(walletJson);
                const newBalance = await wallet_get_balance(updatedWalletJson);
                
                if (oldBalance !== newBalance) {
                    // Update stored wallet
                    workerState.wallets.set(walletId, updatedWalletJson);
                    
                    // Notify UI of balance change
                    self.postMessage({
                        type: 'walletBalance',
                        success: true,
                        payload: { 
                            wallet_id: walletId, 
                            balance: newBalance 
                        }
                    });
                    
                    self.postMessage({
                        type: 'log',
                        payload: { 
                            message: `Wallet ${walletId} balance updated from block ${block.height}`,
                            level: 'info'
                        }
                    });
                }
            } catch (e) {
                console.error(`[WORKER] Failed to scan wallet ${walletId} for block ${block.height}:`, e);
            }
        }
        
        const chainWithHashes = await get_blockchain_with_hashes();
        self.postMessage({
            type: 'blockAddedToChain',
            success: true,
            payload: { chainState: chainWithHashes, fromNetwork: true }
        });
        
        // Continue seeding this block
        console.log('[WORKER] Block validated, continuing to seed');
        
    } catch (e) {
        console.log('[WORKER] Invalid remote block:', e.toString());
        self.postMessage({
            type: 'log',
            payload: { 
                message: `Rejected invalid block ${block.height}: ${e.toString()}`,
                level: 'error'
            }
        });
    }
}

async function handleRemoteCandidate({ block }) {
    if (workerState.consensusPhase === 'Mining') {
        try {
            const chainState = await get_blockchain_state();
            const expectedHeight = chainState.current_height + 1;
            
            if (block.height !== expectedHeight) {
                return;
            }
            
            await submit_pow_candidate(block);
            if (!workerState.candidateBlocks.find(b => b.hash === block.hash)) {
                workerState.candidateBlocks.push(block);
            }
            
            console.log('[WORKER] Accepted remote candidate block.');
            
            self.postMessage({
                type: 'remoteCandidateReceived',
                payload: { block }
            });
        } catch (e) {
            console.log('[WORKER] Rejected remote candidate:', e.toString());
        }
    }
}

async function handleRemoteVote({ voteData }) {
    console.log('[WORKER] Received vote from network:', voteData.validatorId);
    // This logic can be expanded to update UI with vote tallies
}

async function handleRemoteTransaction({ tx }) {
    try {
        const txHash = await get_transaction_hash(tx);
        if (workerState.processedTxHashes.has(txHash)) {
            return; // Already processed
        }
        
        await add_transaction_to_pool(tx);
        workerState.processedTxHashes.add(txHash);
        
        // Scan all loaded wallets to see if they are recipients
        for (const [walletId, walletJson] of workerState.wallets) {
            try {
                const foundOutputs = await scan_pending_transactions(walletJson);
                if (foundOutputs && foundOutputs.length > 0) {
                    // Calculate total pending amount
                    const pendingAmount = foundOutputs.reduce((sum, value) => sum + BigInt(value), 0n);
                    
                    self.postMessage({
                        type: 'log',
                        payload: { 
                            message: `Wallet ${walletId} has ${foundOutputs.length} pending outputs (${pendingAmount} total) in mempool`,
                            level: 'info'
                        }
                    });
                    
                    // Optionally send a pending balance update
                    self.postMessage({
                        type: 'pendingBalanceUpdate',
                        payload: {
                            wallet_id: walletId,
                            pending_outputs: foundOutputs.length,
                            pending_amount: pendingAmount.toString()
                        }
                    });
                }
            } catch (e) {
                console.error(`[WORKER] Failed to scan pending transactions for wallet ${walletId}:`, e);
            }
        }
        
        const pool = await get_tx_pool();
        self.postMessage({ type: 'txPoolUpdate', payload: pool });
        
    } catch (e) {
        console.error('[WORKER] Failed to process remote transaction:', e);
    }
}


// Handle consensus tick
async function handleConsensusTick() {
    try {
        // Check if we're before genesis
        const now = Date.now();
        if (now < GENESIS_TIMESTAMP) {
            const daysUntil = Math.floor((GENESIS_TIMESTAMP - now) / (1000 * 60 * 60 * 24));
            console.log(`[WORKER] Pluribit launches in ${daysUntil} days`);
            return;
        }
        
        // Calculate current phase
        const timeSinceGenesis = now - GENESIS_TIMESTAMP;
        const cycleTime = timeSinceGenesis % (20 * 60 * 1000); // 20 min cycle
        const cycleNumber = Math.floor(timeSinceGenesis / (20 * 60 * 1000));
        
        let currentPhase, phaseTimer, subPhase;
        
        if (cycleTime < 600000) { // 0-10 minutes
            currentPhase = 'Mining';
            phaseTimer = Math.floor((600000 - cycleTime) / 1000);
            resetValidationState();
        } else if (cycleTime < 900000) { // 10-15 minutes
            currentPhase = 'Validation';
            phaseTimer = Math.floor((900000 - cycleTime) / 1000);
            
            // Determine sub-phase
            const validationTime = cycleTime - 600000;
            if (validationTime < 60000) {
                subPhase = 'ProvisionalCommitment';
                await handleProvisionalCommitment();
            } else if (validationTime < 90000) {
                subPhase = 'Reconciliation';
                await handleReconciliation();
            } else {
                subPhase = 'VDFVoting';
                await handleVDFVoting();
            }
        } else { // 15-20 minutes
            currentPhase = 'Propagation';
            phaseTimer = Math.floor((1200000 - cycleTime) / 1000);
        }
        workerState.consensusPhase = currentPhase;
        // Update consensus state
        const consensusResult = await consensus_tick();
        
        self.postMessage({
            type: 'consensusUpdate',
            success: true,
            payload: {
                state: {
                    current_phase: currentPhase,
                    phase_timer: phaseTimer,
                    sub_phase: subPhase,
                    cycle_number: cycleNumber,
                    ...consensusResult
                }
            }
        });
        
    } catch (e) {
        console.error('[WORKER] Consensus error:', e);
    }
}

async function handleProvisionalCommitment() {
    if (!workerState.validatorActive || validationState.commitmentSent) return;
    
    try {
        // Get all candidate blocks we've seen
        const chain = await get_blockchain_state();
        const targetHeight = chain.current_height + 1;
        
        // Get hashes of all candidates at this height
        const candidateHashes = workerState.candidateBlocks
            .filter(b => b.height === targetHeight)
            .map(b => b.hash)
            .sort(); // Deterministic ordering
        
        if (candidateHashes.length === 0) {
            console.log('[WORKER] No candidate blocks to commit to');
            return;
        }
        
        // Create and broadcast commitment
        const commitment = await create_candidate_commitment(
            workerState.validatorId,
            targetHeight,
            candidateHashes
        );
        
        // Broadcast via P2P
        if (workerState.p2p) {
            await workerState.p2p.broadcast({
                type: 'CANDIDATE_COMMITMENT',
                commitment: commitment,
                from: workerState.validatorId
            });
        }
        
        validationState.commitmentSent = true;
        console.log(`[WORKER] Sent commitment for ${candidateHashes.length} candidates`);
        
    } catch (e) {
        console.error('[WORKER] Commitment failed:', e);
    }
}

async function handleReconciliation() {
    if (!workerState.validatorActive || validationState.reconciled) return;
    
    try {
        const chain = await get_blockchain_state();
        const targetHeight = chain.current_height + 1;
        
        // Get all block hashes from all commitments
        const allKnownHashes = await get_all_known_blocks_from_commitments(targetHeight);
        
        console.log(`[WORKER] Network knows about ${allKnownHashes.length} blocks`);
        
        // Request any blocks we don't have
        for (const hash of allKnownHashes) {
            if (!workerState.candidateBlocks.find(b => b.hash === hash)) {
                console.log(`[WORKER] Requesting unknown block ${hash}`);
                await workerState.p2p.requestBlockByHash(hash);
            }
        }
        
        // Wait a bit for blocks to arrive
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Select globally best block (lowest hash)
        const bestHash = await select_best_block(targetHeight);
        validationState.selectedBlock = bestHash;
        
        // Create final selection message
        await create_final_selection(workerState.validatorId, targetHeight, bestHash);
        
        validationState.reconciled = true;
        console.log(`[WORKER] Selected best block: ${bestHash.substring(0, 16)}...`);
        
    } catch (e) {
        console.error('[WORKER] Reconciliation failed:', e);
    }
}

async function handleVDFVoting() {
    if (!workerState.validatorActive || !validationState.selectedBlock || validationState.voted) {
        return;
    }
    
    if (!validationState.vdfStarted) {
        validationState.vdfStarted = true;
        console.log('[WORKER] Starting 4-minute VDF computation...');
        
        try {
            // This should take ~4 minutes
            await handleVoteForBlock({
                validatorId: workerState.validatorId,
                blockHash: validationState.selectedBlock
            });
            
            validationState.voted = true;
            console.log('[WORKER] Vote broadcast complete');
            
        } catch (e) {
            console.error('[WORKER] VDF voting failed:', e);
            validationState.vdfStarted = false;
        }
    }
}

function resetValidationState() {
    validationState.commitmentSent = false;
    validationState.reconciled = false;
    validationState.selectedBlock = null;
    validationState.vdfStarted = false;
    validationState.voted = false;
    workerState.candidateBlocks = []; // Clear candidates for new cycle
}


// Handle VDF clock tick
async function handleVDFTick() {
    try {
        const clockState = await tick_vdf_clock();
        
        self.postMessage({
            type: 'vdfClockTicked',
            success: true,
            payload: { clockState }
        });
    } catch (e) {
        console.error('[WORKER] VDF tick error:', e);
    }
}
async function sendBlockchainState() {
    try {
        const chainState = await get_blockchain_with_hashes();
        self.postMessage({
            type: 'blockchainState',
            success: true,
            payload: chainState
        });
    } catch (e) {
        console.error('[WORKER] Error getting blockchain state:', e);
        self.postMessage({
            type: 'error',
            error: `Failed to get blockchain state: ${e.toString()}`
        });
    }
}

async function syncBlockchainFromNetwork() {
    if (!workerState.p2p) return;
    
    console.log('[WORKER] Checking for blockchain updates from network...');
    
    // This will be triggered by BLOCK_HEIGHTS_KNOWN message
    // The P2P layer will automatically download any missing blocks
}
// Start mining (called when entering mining phase)
async function startMining() {
    if (workerState.currentlyMining || workerState.miningInProgress) {
        return;
    }
    
    workerState.currentlyMining = true;
    workerState.miningInProgress = true;
    console.log('[WORKER] Starting PoW mining with transactions...');
    
    try {
        const chainState = await get_blockchain_state();
        const nextHeight = chainState.current_height + 1;
        
        const submissionCheck = await check_block_submission(BigInt(nextHeight));
        if (!submissionCheck.can_submit) {
            console.log(`[WORKER] Cannot mine yet - VDF clock at ${submissionCheck.current_tick}, need ${submissionCheck.required_tick}`);
            workerState.currentlyMining = false;
            workerState.miningInProgress = false;
            
            setTimeout(() => {
                if (workerState.consensusPhase === 'Mining' && workerState.minerActive) {
                    startMining();
                }
            }, submissionCheck.ticks_remaining * 1000);
            
            return;
        }
        
        const latestHash = await get_latest_block_hash();
        const difficulty = await get_current_difficulty();
        
        // Get miner's scan public key
        let minerPubKeyBytes = new Uint8Array(32); // Default zero key
        const minerWalletJson = workerState.wallets.get(workerState.minerId);
        if (minerWalletJson) {
            const walletData = await wallet_get_data(minerWalletJson);
            // Use SCAN public key for mining rewards (stealth outputs)
            const scanPubKeyHex = walletData.scan_pub_key_hex;
            const pubKeyArray = new Uint8Array(scanPubKeyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
            minerPubKeyBytes = pubKeyArray;
        } else {
            console.warn('[WORKER] No wallet found for miner, using zero key for rewards');
        }
        
        // Compute VDF proof for this block
        const vdf_proof = await compute_block_vdf_proof(latestHash);
        
        const pool = await get_tx_pool();
        console.log(`[WORKER] Mining block ${nextHeight} with ${pool.pending_count} transactions (${pool.fee_total} fees)`);
        
        const miningResult = await mine_block_with_txs(
            BigInt(nextHeight),
            latestHash,
            workerState.minerId,
            minerPubKeyBytes,
            difficulty,
            BigInt(1000000),
            vdf_proof
        );
        
        console.log('[WORKER] Successfully mined block:', miningResult.block);
        
        await submit_pow_candidate(miningResult.block);
        
        // Store our own mined block
        if (!workerState.candidateBlocks.find(b => b.hash === miningResult.block.hash)) {
            workerState.candidateBlocks.push(miningResult.block);
        }
        
        // Broadcast candidate with WebTorrent
        if (workerState.p2p && workerState.networkStarted) {
            const peerCount = workerState.p2p.getPeerCount();
            console.log(`[WORKER] Broadcasting candidate to ${peerCount} peers`);
            
            await workerState.p2p.broadcast({
                type: 'CANDIDATE',
                block: miningResult.block,
                from: workerState.minerId,
                timestamp: Date.now()
            });
            
            self.postMessage({
                type: 'log',
                payload: { 
                    message: `Block candidate broadcast to ${peerCount} peer${peerCount !== 1 ? 's' : ''}`,
                    level: 'success'
                }
            });
        }
        
        self.postMessage({
            type: 'powMiningResult',
            success: true,
            payload: { 
                block: miningResult.block,
                txCount: pool.pending_count,
                fees: pool.fee_total,
                peerCount: workerState.p2p ? workerState.p2p.getPeerCount() : 0
            }
        });
        
        workerState.currentlyMining = false;
        workerState.miningInProgress = false;
        
    } catch (e) {
        console.error('[WORKER] Mining error:', e);
        self.postMessage({
            type: 'error',
            error: `Mining failed: ${e.toString()}`
        });
        workerState.currentlyMining = false;
        workerState.miningInProgress = false;
    }
}

// Handler functions
async function handleCreateStakeLock({ validatorId, stakeAmount, lockDuration }) {
    try {
        const validatorWalletJson = workerState.wallets.get(validatorId);
        if (!validatorWalletJson) {
            throw new Error(`Validator wallet ${validatorId} not found`);
        }
        
        // Get wallet data to access public keys
        const walletData = await wallet_get_data(validatorWalletJson);
        
        // The stake lock needs the validator's spend public key
        const spendPubKeyHex = walletData.spend_pub_key_hex;
        const pubKeyArray = new Uint8Array(
            spendPubKeyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16))
        );
        
        // Create stake lock transaction
        const stakeTx = await create_stake_lock(
            validatorId, 
            BigInt(stakeAmount), 
            BigInt(lockDuration),
            pubKeyArray  // Pass the validator's public key
        );
        
        // Add to transaction pool
        await add_transaction_to_pool(stakeTx);
        
        // Broadcast to network
        if (workerState.p2p && workerState.networkStarted) {
            workerState.p2p.broadcast({
                type: 'TRANSACTION',
                tx: stakeTx,
                from: validatorId,
                timestamp: Date.now()
            });
        }
        
        self.postMessage({
            type: 'stakeLockCreated',
            success: true,
            payload: stakeTx
        });
        
        self.postMessage({
            type: 'log',
            payload: { 
                message: `Stake lock created for ${validatorId}: ${stakeAmount} coins locked for ${lockDuration} blocks`,
                level: 'success'
            }
        });
        
    } catch (e) {
        self.postMessage({ 
            type: 'error', 
            error: `Failed to create stake lock: ${e.toString()}` 
        });
    }
}

async function handleComputeStakeVDF({ validatorId }) {
    if (workerState.computingVDF) {
        return;
    }
    workerState.computingVDF = true;
    
    try {
        self.postMessage({ type: 'vdfComputationStarted' });
        const vdfResult = await compute_stake_vdf(validatorId);
        self.postMessage({
            type: 'vdfComputationComplete',
            success: true,
            payload: vdfResult
        });
    } catch (e) {
        self.postMessage({ type: 'error', error: `VDF computation failed: ${e.toString()}` });
    } finally {
        workerState.computingVDF = false;
    }
}

async function handleActivateStake({ validatorId, vdfResult }) {
    try {
        const validatorWalletJson = workerState.wallets.get(validatorId);
        if (!validatorWalletJson) {
            throw new Error(`Validator wallet ${validatorId} not found`);
        }
        
        // Get wallet data including public AND private keys
        const walletData = await wallet_get_data(validatorWalletJson);
        
        // Also need the raw wallet data for private key
        const walletObj = JSON.parse(validatorWalletJson);
        
        // Use SPEND public key for validator identity
        const spendPubKeyHex = walletData.spend_pub_key_hex;
        if (!spendPubKeyHex) {
            throw new Error('Wallet missing spend public key');
        }
        
        // Convert hex to Uint8Array
        const pubKeyArray = new Uint8Array(
            spendPubKeyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16))
        );
        
        // Get SPEND private key from wallet
        if (!walletObj.spend_priv || !Array.isArray(walletObj.spend_priv)) {
            throw new Error('Wallet missing spend private key');
        }
        const privKeyArray = new Uint8Array(walletObj.spend_priv);
        
        console.log(`[WORKER] Activating stake for validator ${validatorId}...`);
        
        // Pass BOTH public and private keys
        await activate_stake_with_vdf(
            validatorId, 
            vdfResult, 
            pubKeyArray,
            privKeyArray  // ADD THIS
        );
        
        workerState.validatorActive = true;
        workerState.validatorId = validatorId;
        
        self.postMessage({ 
            type: 'stakeActivated', 
            success: true, 
            payload: { validatorId } 
        });
        
        self.postMessage({
            type: 'log',
            payload: { 
                message: `Stake activated for validator ${validatorId}`,
                level: 'success'
            }
        });
        
    } catch (e) {
        console.error('[WORKER] Stake activation failed:', e);
        self.postMessage({ 
            type: 'error', 
            error: `Failed to activate stake: ${e.toString()}` 
        });
    }
}

async function handleVoteForBlock({ validatorId }) {
    try {
        const validatorWalletJson = workerState.wallets.get(validatorId);
        if (!validatorWalletJson) {
            throw new Error(`Validator wallet ${validatorId} not found`);
        }
        
        const walletData = JSON.parse(validatorWalletJson);
        
        // Get spend private key for voting (it's stored as an array of bytes in the JSON)
        if (!walletData.spend_priv || !Array.isArray(walletData.spend_priv)) {
            throw new Error('Wallet missing spend private key');
        }
        
        // Convert the array to Uint8Array
        const spendPrivKeyArray = new Uint8Array(walletData.spend_priv);
        
        console.log(`[WORKER] Validator ${validatorId} computing VDF and voting...`);
        
        const voteResult = await vote_for_block(validatorId, spendPrivKeyArray);
        
        // Broadcast vote with new simplified format
        if (workerState.p2p) {
            await workerState.p2p.broadcast({
                type: 'VOTE',
                voteData: voteResult,
                from: validatorId,
                timestamp: Date.now()
            });
            
            self.postMessage({
                type: 'log',
                payload: { 
                    message: `Vote broadcast to network`,
                    level: 'info'
                }
            });
        }
        
        self.postMessage({
            type: 'blockVoteCast',
            success: true,
            payload: voteResult
        });
        
    } catch (e) {
        console.error('[WORKER] Vote failed:', e);
        self.postMessage({ 
            type: 'error', 
            error: `Failed to vote: ${e.toString()}` 
        });
    }
}

async function handleInitWallet({ walletId, balance }) {
    try {
        // Create new wallet - returns JSON string
        let walletJson = await wallet_create();
        const walletData = JSON.parse(walletJson);

        // Store the wallet JSON
        workerState.wallets.set(walletId, walletJson);
        workerState.currentWalletId = walletId; 

        // Scan the blockchain for any existing UTXOs
        // (in case this wallet was restored from a seed phrase)
        self.postMessage({ 
            type: 'log', 
            payload: { message: `Scanning blockchain for wallet ${walletId}...`, level: 'info' } 
        });
        
        const updatedWalletJson = await wallet_scan_blockchain(walletJson);
        workerState.wallets.set(walletId, updatedWalletJson);
        walletJson = updatedWalletJson;
        
        // Also scan pending transactions
        const foundPendingOutputs = await scan_pending_transactions(walletJson);
        if (foundPendingOutputs && foundPendingOutputs.length > 0) {
            self.postMessage({ 
                type: 'log', 
                payload: { 
                    message: `Found ${foundPendingOutputs.length} pending outputs for new wallet ${walletId}`, 
                    level: 'info' 
                } 
            });
        }
        
        // Get the public keys from wallet data
        const walletInfo = await wallet_get_data(walletJson);
        
        self.postMessage({
            type: 'downloadWalletFile',
            payload: {
                fileName: `pluribit-wallet-${walletId}.json`,
                data: JSON.parse(walletJson) // Use the updated wallet data
            }
        });
        
        // Update balance display
        await handleGetWalletBalance({ walletId });
        
        self.postMessage({ 
            type: 'log', 
            payload: { message: `Wallet ${walletId} created and scanned.`, level: 'success' } 
        });
        
    } catch (e) {
        self.postMessage({ type: 'error', error: `Failed to initialize wallet: ${e.toString()}` });
    }
}

async function handleCreateTransaction({ from, to, amount, fee }) {
    try {
        // Get the sender's wallet
        const fromWalletJson = workerState.wallets.get(from);
        if (!fromWalletJson) {
            throw new Error(`Wallet ${from} not found`);
        }
        
        // Validate the recipient address
        const isValidAddress = await validate_address(to);
        if (!isValidAddress) {
            throw new Error(`Invalid recipient address: ${to}`);
        }
        
        // Create transaction - this returns both the transaction and updated wallet JSON
        const result = await wallet_create_transaction(
            fromWalletJson,
            BigInt(amount),
            BigInt(fee),
            to  // 'to' is expected to be a hex address
        );
        
        // Update stored wallet with new state (spent UTXOs removed, change added)
        workerState.wallets.set(from, result.updated_wallet_json);
        
        // Add transaction to pool
        await add_transaction_to_pool(result.transaction);
        
        // Broadcast transaction to network
        if (workerState.p2p && workerState.networkStarted) {
            workerState.p2p.broadcast({
                type: 'TRANSACTION',
                tx: result.transaction,
                from: from,
                timestamp: Date.now()
            });
            
            self.postMessage({
                type: 'log',
                payload: { 
                    message: `Transaction broadcast to network`,
                    level: 'info'
                }
            });
        }
        
        // Update transaction pool display
        await handleGetTxPool();
        
        // Update sender's balance display
        await handleGetWalletBalance({ walletId: from });
        
        self.postMessage({ 
            type: 'transactionCreated', 
            success: true,
            payload: {
                from: from,
                to: to,
                amount: amount,
                fee: fee,
                txHash: await get_transaction_hash(result.transaction)
            }
        });
        
    } catch (e) {
        self.postMessage({ 
            type: 'error', 
            error: `Failed to create transaction: ${e.toString()}` 
        });
    }
}

async function handleGetWalletBalance({ walletId }) {
    try {
        const walletJson = workerState.wallets.get(walletId);
        if (!walletJson) {
            // Wallet not found - fail silently as per original
            return;
        }
        
        const balance = await wallet_get_balance(walletJson);
        
        self.postMessage({
            type: 'walletBalance',
            success: true,
            payload: { 
                wallet_id: walletId, 
                balance: balance 
            }
        });
    } catch (e) {
        // Fail silently as per original implementation
        console.error(`[WORKER] Failed to get balance for wallet ${walletId}:`, e);
    }
}
async function handleGetWalletAddress({ walletId }) {
    try {
        const walletJson = workerState.wallets.get(walletId);
        if (!walletJson) {
            throw new Error(`Wallet ${walletId} not found`);
        }
        
        // Get stealth address instead of raw hex
        const address = await wallet_get_stealth_address(walletJson);
        
        self.postMessage({
            type: 'walletAddress',
            success: true,
            payload: {
                walletId: walletId,
                address: address
            }
        });
    } catch (e) {
        self.postMessage({ 
            type: 'error', 
            error: `Failed to get wallet address: ${e.toString()}` 
        });
    }
}

async function handleGetTxPool() {
    try {
        const pool = await get_tx_pool();
        self.postMessage({
            type: 'txPoolUpdate',
            success: true,
            payload: pool
        });
    } catch (e) {
        self.postMessage({ type: 'error', error: `Failed to get tx pool: ${e.toString()}` });
    }
}

async function handleLoadWallet({ walletId, walletData }) {
    try {
        // Store the loaded wallet JSON
        let walletJson = JSON.stringify(walletData);
        workerState.wallets.set(walletId, walletJson);
        workerState.currentWalletId = walletId; 

        // Scan the full blockchain
        self.postMessage({ 
            type: 'log', 
            payload: { message: `Scanning blockchain for wallet ${walletId}...`, level: 'info' } 
        });
        
        // Scan all blocks in the blockchain
        const updatedWalletJson = await wallet_scan_blockchain(walletJson);
        
        // Update stored wallet with scan results
        workerState.wallets.set(walletId, updatedWalletJson);
        walletJson = updatedWalletJson;
        
        // Also scan pending transactions in the pool
        const foundPendingOutputs = await scan_pending_transactions(walletJson);
        if (foundPendingOutputs && foundPendingOutputs.length > 0) {
            self.postMessage({ 
                type: 'log', 
                payload: { 
                    message: `Found ${foundPendingOutputs.length} pending outputs for wallet ${walletId}`, 
                    level: 'info' 
                } 
            });
        }
        
        // Get and display the updated balance
        await handleGetWalletBalance({ walletId });
        
        self.postMessage({ 
            type: 'log', 
            payload: { message: `Wallet ${walletId} loaded and scanned.`, level: 'success' } 
        });
        
    } catch (e) {
        self.postMessage({ type: 'error', error: `Failed to load wallet: ${e.toString()}` });
    }
}

async function calibrateVDF() {
    console.log('[WORKER] Starting VDF calibration...');
    self.postMessage({ type: 'log', payload: { message: 'Calibrating VDF speed for your device... (approx. 5-10 seconds)', level: 'info' } });

    const benchmark_iterations = 10_000_000; // A large number of iterations to run
    const time_taken_ms = await run_vdf_benchmark(BigInt(benchmark_iterations));

    if (time_taken_ms === 0) {
        // Avoid division by zero, use a safe default
        await set_calibrated_vdf_speed(BigInt(5000));
        console.warn('[WORKER] VDF calibration too fast, using default speed.');
        return;
    }

    // Calculate how many iterations can be done in one second (1000 ms)
    const iterations_per_second = Math.floor((benchmark_iterations / time_taken_ms) * 1000);
    
    // Set the calibrated value in the Rust backend
    await set_calibrated_vdf_speed(BigInt(iterations_per_second));

    const log_message = `VDF calibrated to ${iterations_per_second.toLocaleString()} iterations/sec.`;
    console.log(`[WORKER] ${log_message}`);
    self.postMessage({ type: 'log', payload: { message: log_message, level: 'success' } });
}



//begin autoslashing
setInterval(async () => {
    if (workerState.networkStarted && workerState.currentWalletId) {

        const chain = await get_blockchain_state();
        if (chain.current_height % 5 === 0) {
            console.log('[WORKER] Automatic slashing check...');
            worker.postMessage({
                action: 'checkViolations',
                reporterId: state.currentWalletId
            });
        }
    }
}, 60000);

console.log('[WORKER] Pluribit worker initialized and ready');
