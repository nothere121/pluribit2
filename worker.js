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
    init_wallet,
    create_wallet_transaction,
    get_wallet_balance,
    get_tx_pool,
    mine_block_with_txs,
    add_transaction_to_pool,
    verify_transaction,
    clear_transaction_pool,
    get_transaction_hash,
    update_utxo_set_from_block,
    get_utxo_set_size,
    get_wallet_data,
    restore_wallet,
    get_current_difficulty,
    compute_block_vdf_proof
} from './pkg/plurabit_core.js';

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
    miningInProgress: false
};


// Initialize WASM on worker start
(async () => {
    try {
        console.log('[WORKER] Starting initialization...');

        // **THE FIX IS HERE**: We now pass the exact URL of the wasm file to init().
        await init(new URL('./pkg/plurabit_core_bg.wasm', import.meta.url));

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
            
            case 'getTxPool':
                await handleGetTxPool();
                break;
            case 'loadWallet':
                await handleLoadWallet(params);
                break;
            case 'checkDoubleVotes':
                try {
                    const slashedCount = await pluribit.check_and_report_double_votes(data.reporterId);
                    self.postMessage({
                        type: 'doubleVotesChecked',
                        success: true,
                        payload: { slashedCount }
                    });
                } catch (error) {
                    self.postMessage({
                        type: 'log',
                        payload: { message: `Double vote check failed: ${error}`, level: 'error' }
                    });
                }
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

async function handlePruneChain({ keepRecentBlocks }) {
    try {
        const keepBlocks = keepRecentBlocks || 144; // Default to 48 hours
        
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
        
        const pool = await get_tx_pool();
        self.postMessage({ type: 'txPoolUpdate', payload: pool });
        
    } catch (e) {
        console.error('[WORKER] Failed to process remote transaction:', e);
    }
}


// Handle consensus tick
async function handleConsensusTick() {
    try {
        const consensusResult = await consensus_tick();
        const { current_phase, phase_timer, best_candidate_block, block_added } = consensusResult;
     
        
        if (current_phase !== workerState.consensusPhase) {
            workerState.consensusPhase = current_phase;
            console.log(`[WORKER] Phase changed to: ${current_phase}`);
            
            if (current_phase === 'Mining') {
                workerState.miningInProgress = false;
                if (workerState.minerActive && !workerState.currentlyMining) {
                    startMining();
                }
            }
            
            if (current_phase === 'Validation' && best_candidate_block && workerState.p2p) {
                // Broadcast candidate to network
                await workerState.p2p.broadcast({
                    type: 'CANDIDATE',
                    block: best_candidate_block,
                    from: workerState.minerId
                });
            }
            
            if (current_phase === 'Validation' && best_candidate_block && workerState.validatorActive && workerState.validatorId) {
                setTimeout(async () => {
                    try {
                        await handleVoteForBlock({ validatorId: workerState.validatorId });
                    } catch (e) {
                        console.error('[WORKER] Vote failed:', e);
                    }
                }, 100);
            }
        }
        
        if (block_added) {
            const chainWithHashes = await get_blockchain_with_hashes();
            const latestBlock = chainWithHashes.blocks[chainWithHashes.blocks.length - 1];
            
            await update_utxo_set_from_block(latestBlock);
            
            // CRITICAL: Seed the new finalized block to WebTorrent network
            if (workerState.p2p) {
                console.log(`[WORKER] Seeding newly finalized block #${latestBlock.height}`);
                const fullChain = await get_blockchain_state();
                const fullLatestBlock = fullChain.blocks[fullChain.blocks.length - 1];
                
                // Seed block as torrent
                await workerState.p2p.seedBlock(fullLatestBlock);
                
                self.postMessage({
                    type: 'log',
                    payload: { 
                        message: `Block ${fullLatestBlock.height} finalized and seeding to network`,
                        level: 'success'
                    }
                });
            }
            
            await clear_transaction_pool();
            
            self.postMessage({
                type: 'blockAddedToChain',
                success: true,
                payload: { chainState: chainWithHashes }
            });
            
                        // Check if we should create a snapshot
            const chain = await get_blockchain_state();
            if (chain.current_height % 144 === 0) { // Every 48 hours
                console.log('[WORKER] Creating periodic UTXO snapshot');
                setTimeout(() => handleCreateAndSeedSnapshot(), 5000); // Delay to let network stabilize
            }
            
        }
        
        self.postMessage({
            type: 'consensusUpdate',
            success: true,
            payload: { 
                state: {
                    current_phase: consensusResult.current_phase,
                    phase_timer: consensusResult.phase_timer,
                    best_candidate_block: consensusResult.best_candidate_block,
                    block_added: consensusResult.block_added
                }
            }
        });
        
    } catch (e) {
        console.error('[WORKER] Consensus tick error:', e);
    }
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
        
        // Compute VDF proof for this block
        const vdf_proof = await compute_block_vdf_proof(latestHash);
        
        const pool = await get_tx_pool();
        console.log(`[WORKER] Mining block ${nextHeight} with ${pool.pending_count} transactions (${pool.fee_total} fees)`);
        
        const minedBlock = await mine_block_with_txs(
            BigInt(nextHeight),
            latestHash,
            workerState.minerId,
            difficulty,
            BigInt(1000000),
            vdf_proof  // Pass the VDF proof
        );
        
        console.log('[WORKER] Successfully mined block:', minedBlock);
        
        await submit_pow_candidate(minedBlock);
        
        // Broadcast candidate with WebTorrent
        if (workerState.p2p && workerState.networkStarted) {
            const peerCount = workerState.p2p.getPeerCount();
            console.log(`[WORKER] Broadcasting candidate to ${peerCount} peers`);
            
            await workerState.p2p.broadcast({
                type: 'CANDIDATE',
                block: minedBlock,
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
                block: minedBlock,
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
        const stakeTx = await create_stake_lock(validatorId, BigInt(stakeAmount), BigInt(lockDuration));
        self.postMessage({
            type: 'stakeLockCreated',
            success: true,
            payload: stakeTx
        });
    } catch (e) {
        self.postMessage({ type: 'error', error: `Failed to create stake lock: ${e.toString()}` });
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
        await activate_stake_with_vdf(validatorId, vdfResult);
        workerState.validatorActive = true;
        workerState.validatorId = validatorId;
        self.postMessage({ type: 'stakeActivated', success: true, payload: { validatorId } });
    } catch (e) {
        self.postMessage({ type: 'error', error: `Failed to activate stake: ${e.toString()}` });
    }
}

async function handleVoteForBlock({ validatorId }) {
    try {
        const voteResult = await vote_for_block(validatorId);
        
        // Broadcast vote with new simplified format
        if (workerState.p2p) {
            workerState.p2p.broadcast({
                type: 'VOTE',
                voteData: voteResult
            });
        }
        
        self.postMessage({
            type: 'blockVoteCast',
            success: true,
            payload: voteResult
        });
    } catch (e) {
        self.postMessage({ type: 'error', error: `Failed to vote: ${e.toString()}` });
    }
}

async function handleInitWallet({ walletId, balance }) {
    try {
        await init_wallet(walletId, BigInt(balance));
        const walletData = await get_wallet_data(walletId);
        
        // The wallet data now includes identity keys
        self.postMessage({
            type: 'downloadWalletFile',
            payload: {
                fileName: `pluribit-wallet-${walletId}.json`,
                data: walletData
            }
        });
        await handleGetWalletBalance({ walletId });
    } catch (e) {
        self.postMessage({ type: 'error', error: `Failed to initialize wallet: ${e.toString()}` });
    }
}

async function handleCreateTransaction({ from, to, amount, fee }) {
    try {
        const tx = await create_wallet_transaction(from, to, BigInt(amount), BigInt(fee));
        
        // Broadcast transaction with new simplified format
        if (workerState.p2p) {
            workerState.p2p.broadcast({
                type: 'TRANSACTION',
                tx: tx
            });
        }
        await add_transaction_to_pool(tx);
        await handleGetTxPool();
        await handleGetWalletBalance({ walletId: from });
        
        self.postMessage({ type: 'transactionCreated', success: true });
    } catch (e) {
        self.postMessage({ type: 'error', error: `Failed to create transaction: ${e.toString()}` });
    }
}

async function handleGetWalletBalance({ walletId }) {
    try {
        const balance = await get_wallet_balance(walletId);
        self.postMessage({
            type: 'walletBalance',
            success: true,
            payload: balance
        });
    } catch (e) { /* Fail silently */ }
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
        await restore_wallet(walletId, walletData);
        await handleGetWalletBalance({ walletId });
        self.postMessage({ type: 'log', payload: { message: `Wallet ${walletId} restored.`, level: 'success' } });
    } catch (e) {
        self.postMessage({ type: 'error', error: `Failed to restore wallet: ${e.toString()}` });
    }
}

console.log('[WORKER] Pluribit worker initialized and ready');
