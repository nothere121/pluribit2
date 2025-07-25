// src/consensus_manager.rs

use crate::block::{Block, BlockFinalization, ValidatorVote};
use crate::{BLOCKCHAIN, BLOCK_VOTES, VDF_CLOCK, VALIDATORS, TX_POOL};
use crate::constants::{TICKS_PER_CYCLE, MINING_PHASE_END_TICK, VALIDATION_PHASE_END_TICK, COMMITMENT_END_TICK, RECONCILIATION_END_TICK, BOOTSTRAP_BLOCKS};
use serde::{Serialize, Deserialize};
use crate::log;
use crate::vdf::VDF;
use std::collections::{HashSet, HashMap};
// Add necessary imports for verification
use crate::mimblewimble;
use curve25519_dalek::ristretto::CompressedRistretto;
use curve25519_dalek::scalar::Scalar;
use sha2::{Sha256, Digest};


#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ConsensusPhase {
    Mining,
    Validation,
    Propagation,
}

#[derive(Debug, Clone)]
pub struct ConsensusManager {
    pub current_phase: ConsensusPhase,
    pub best_candidate_block: Option<Block>,
    // Tracks state for the current validation cycle to prevent redundant actions
    commitment_sent_this_cycle: bool,
    reconciliation_complete_this_cycle: bool,
    voting_initiated_this_cycle: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ValidationSubPhase {
    ProvisionalCommitment,
    Reconciliation,
    VDFVoting,
}

#[derive(Serialize, Deserialize)]
pub struct ConsensusResult {
    pub new_phase: Option<ConsensusPhase>,
    pub block_finalized: bool,
    pub action_required: Option<String>,
}

impl ConsensusManager {
    pub fn new() -> Self {
        ConsensusManager {
            current_phase: ConsensusPhase::Mining,
            best_candidate_block: None,
            commitment_sent_this_cycle: false,
            reconciliation_complete_this_cycle: false,
            voting_initiated_this_cycle: false,
        }
    }

    pub fn tick(&mut self) -> ConsensusResult {
        let vdf_clock = VDF_CLOCK.lock().unwrap();
        let current_tick = vdf_clock.current_tick;
        let tick_in_cycle = current_tick % TICKS_PER_CYCLE;
        
        let previous_phase = self.current_phase.clone();
        let mut new_phase: Option<ConsensusPhase> = None;
        let mut block_finalized = false;
        let mut action_required: Option<String> = None;

        let determined_phase = if tick_in_cycle < MINING_PHASE_END_TICK {
            ConsensusPhase::Mining
        } else if tick_in_cycle < VALIDATION_PHASE_END_TICK {
            ConsensusPhase::Validation
        } else {
            ConsensusPhase::Propagation
        };

        if self.current_phase != determined_phase {
            log(&format!("[CONSENSUS] Phase transition: {:?} -> {:?}", self.current_phase, determined_phase));
            self.current_phase = determined_phase;
            new_phase = Some(self.current_phase.clone());

            if self.current_phase == ConsensusPhase::Mining {
                self.best_candidate_block = None;
                // Reset cycle state trackers
                self.commitment_sent_this_cycle = false;
                self.reconciliation_complete_this_cycle = false;
                self.voting_initiated_this_cycle = false;
            }
        }

        match self.current_phase {
            ConsensusPhase::Mining => {
                if previous_phase != ConsensusPhase::Mining {
                     action_required = Some("START_MINING".to_string());
                }
            },
            ConsensusPhase::Validation => {
                let validation_tick = tick_in_cycle - MINING_PHASE_END_TICK;
                if validation_tick < COMMITMENT_END_TICK {
                    if !self.commitment_sent_this_cycle {
                        action_required = Some("CREATE_COMMITMENT".to_string());
                        self.commitment_sent_this_cycle = true;
                    }
                } else if validation_tick < RECONCILIATION_END_TICK {
                    if !self.reconciliation_complete_this_cycle {
                        action_required = Some("RECONCILE_AND_SELECT".to_string());
                        self.reconciliation_complete_this_cycle = true;
                    }
                } else {
                    if !self.voting_initiated_this_cycle {
                        action_required = Some("INITIATE_VDF_VOTE".to_string());
                        self.voting_initiated_this_cycle = true;
                    }
                }
            },
            ConsensusPhase::Propagation => {
                if previous_phase == ConsensusPhase::Validation {
                    if let Some(block) = self.best_candidate_block.take() {
                        block_finalized = self.finalize_block(block);
                    } else {
                        log("[CONSENSUS] Propagation phase started, but no candidate block was selected.");
                    }
                }
            }
        }

        ConsensusResult {
            new_phase,
            block_finalized,
            action_required,
        }
    }
    
    pub fn submit_pow_candidate(&mut self, candidate: Block) -> Result<(), String> {
        if self.current_phase != ConsensusPhase::Mining {
            return Err("Not in mining phase".to_string());
        }

        if !candidate.is_valid_pow() {
            return Err("Invalid PoW".to_string());
        }

        let clock = VDF_CLOCK.lock().unwrap();
        if !clock.can_submit_block(candidate.height) {
            return Err(format!(
                "VDF clock not ready. Current: {}, Required: {}",
                clock.current_tick,
                candidate.height * clock.ticks_per_block
            ));
        }
        drop(clock);

        if let Some(ref current_best) = self.best_candidate_block {
            if candidate.hash() >= current_best.hash() {
                return Ok(());
            }
        }

        log(&format!("[CONSENSUS] New best candidate block at height {}", candidate.height));
        self.best_candidate_block = Some(candidate);
        Ok(())
    }

    fn finalize_block(&self, mut block: Block) -> bool {
        if block.height <= BOOTSTRAP_BLOCKS {
            log(&format!("[CONSENSUS] Finalizing bootstrap block {}", block.height));
            if !block.is_valid_pow() {
                log(&format!("[CONSENSUS] Bootstrap block {} has invalid PoW", block.height));
                return false;
            }
            block.finalization_data = Some(BlockFinalization {
                votes: vec![],
                total_stake_voted: 0,
                total_stake_active: 0,
            });
            
            let mut chain = BLOCKCHAIN.lock().unwrap();
            match chain.add_block(block.clone()) {
                Ok(_) => {
                    log(&format!("[CONSENSUS] Bootstrap block {} added to chain.", block.height));
                    true
                }
                Err(e) => {
                    log(&format!("[CONSENSUS] Failed to add bootstrap block: {:?}", e));
                    false
                }
            }
        } else {
            self.finalize_with_stake_validation(block)
        }
    }
    
    fn finalize_with_stake_validation(&self, mut block: Block) -> bool {
        log(&format!("[CONSENSUS] Attempting to finalize block {} with stake validation.", block.height));
        
        let votes = BLOCK_VOTES.lock().unwrap();
        let validators = VALIDATORS.lock().unwrap();
        
        let height_votes = match votes.get(&block.height) {
            Some(v) => v,
            None => {
                log(&format!("[CONSENSUS] Finalization failed: No votes found for block height {}", block.height));
                return false;
            }
        };

        let total_stake_active: u64 = validators.values().filter(|v| v.active).map(|v| v.total_locked).sum();
        if total_stake_active == 0 {
             log("[CONSENSUS] Finalization failed: No active stake in the network.");
             return false;
        }
        let required_stake = (total_stake_active / 2) + 1;

        let mut valid_votes_for_block = Vec::new();
        let mut total_voted_stake_for_block = 0;

        for (validator_id, vote_data) in height_votes {
            if vote_data.block_hash == block.hash() {
                // --- START: FULL VOTE VERIFICATION ---
                let validator = match validators.get(validator_id) {
                    Some(v) => v,
                    None => {
                        log(&format!("[CONSENSUS_WARN] Vote from unknown validator {}, skipping.", validator_id));
                        continue;
                    }
                };

                if !validator.active {
                    log(&format!("[CONSENSUS_WARN] Vote from inactive validator {}, skipping.", validator_id));
                    continue;
                }

                // 1. Verify VDF Proof
                let vdf_input = format!("{}||{}", validator_id, vote_data.block_hash);
                let vdf = match VDF::new(2048) {
                    Ok(v) => v,
                    Err(_) => {
                        log("[CONSENSUS_ERROR] Could not initialize VDF for verification.");
                        continue;
                    }
                };
                if !vdf.verify(vdf_input.as_bytes(), &vote_data.vdf_proof).unwrap_or(false) {
                    log(&format!("[CONSENSUS_WARN] Invalid VDF proof for validator {}, skipping vote.", validator_id));
                    continue;
                }

                // 2. Verify Schnorr Signature
                let public_key = match CompressedRistretto::from_slice(&validator.public_key)
                    .map_err(|_|())
                    .and_then(|p| p.decompress().ok_or(())) {
                        Ok(pk) => pk,
                        Err(_) => {
                            log(&format!("[CONSENSUS_WARN] Invalid public key for validator {}, skipping vote.", validator_id));
                            continue;
                        }
                    };

                let message_to_verify = format!("vote:{}:{}:{}", block.height, vote_data.block_hash, vote_data.stake_amount);
                let message_hash: [u8; 32] = Sha256::digest(message_to_verify.as_bytes()).into();

                let signature = &vote_data.signature;
                if signature.len() != 64 {
                    log(&format!("[CONSENSUS_WARN] Invalid signature length for validator {}, skipping vote.", validator_id));
                    continue;
                }
                let mut challenge_bytes = [0u8; 32];
                challenge_bytes.copy_from_slice(&signature[0..32]);
                let challenge = Scalar::from_bytes_mod_order(challenge_bytes);

                let mut s_bytes = [0u8; 32];
                s_bytes.copy_from_slice(&signature[32..64]);
                let s = Scalar::from_bytes_mod_order(s_bytes);

                if !mimblewimble::verify_schnorr_signature(&(challenge, s), message_hash, &public_key) {
                    log(&format!("[CONSENSUS_WARN] Invalid signature for validator {}, skipping vote.", validator_id));
                    continue;
                }

                // --- END: FULL VOTE VERIFICATION ---

                // If all checks pass, the vote is valid.
                total_voted_stake_for_block += vote_data.stake_amount;
                valid_votes_for_block.push(ValidatorVote {
                    validator_id: validator_id.clone(),
                    block_hash: vote_data.block_hash.clone(),
                    stake_amount: vote_data.stake_amount,
                    vdf_proof: vote_data.vdf_proof.clone(),
                    signature: vote_data.signature.clone(),
                });
            }
        }

        if total_voted_stake_for_block < required_stake {
            log(&format!(
                "[CONSENSUS] Finalization failed for block {}: Insufficient stake. Got {}, needed {}.",
                block.height, total_voted_stake_for_block, required_stake
            ));
            return false;
        }
        
        block.finalization_data = Some(BlockFinalization {
            votes: valid_votes_for_block,
            total_stake_voted: total_voted_stake_for_block,
            total_stake_active,
        });

        log(&format!("[CONSENSUS] Block {} finalized with sufficient stake.", block.height));

        // Drop read-only locks before acquiring write lock for the chain
        drop(votes);
        drop(validators);

        let mut chain = BLOCKCHAIN.lock().unwrap();
        match chain.add_block(block.clone()) {
            Ok(_) => {
                // Clean up the transaction pool
                let mut pool = TX_POOL.lock().unwrap();
                let finalized_tx_hashes: HashSet<String> = block.transactions.iter().map(|tx| tx.hash()).collect();
                pool.pending.retain(|tx| !finalized_tx_hashes.contains(&tx.hash()));
                pool.fee_total = pool.pending.iter().map(|tx| tx.kernel.fee).sum();
                true
            }
            Err(e) => {
                log(&format!("Failed to add finalized block to chain: {:?}", e));
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blockchain::Blockchain;
    use crate::vdf_clock::VDFClock;
    use crate::{Validator, VoteData, VDFLockedStake, StakeLockTransaction};
    use crate::vdf::VDFProof;
    use lazy_static::lazy_static;
    use std::sync::Mutex;

    lazy_static! {
        static ref TEST_MUTEX: Mutex<()> = Mutex::new(());
    }

    // Helper to reset global state for tests
    fn setup() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_MUTEX.lock().unwrap();
        *BLOCKCHAIN.lock().unwrap() = Blockchain::new();
        *VDF_CLOCK.lock().unwrap() = VDFClock::new(TICKS_PER_CYCLE);
        VALIDATORS.lock().unwrap().clear();
        BLOCK_VOTES.lock().unwrap().clear();
        TX_POOL.lock().unwrap().pending.clear();
        TX_POOL.lock().unwrap().fee_total = 0;
        guard  // Return the guard to keep the mutex locked
    }

    #[test]
    fn test_initial_state() {
        let _guard = setup();  // Hold the guard for the entire test
        let manager = ConsensusManager::new();
        assert_eq!(manager.current_phase, ConsensusPhase::Mining);
        assert!(manager.best_candidate_block.is_none());
    }

    #[test]
    fn test_phase_transitions() {
        setup();
        let mut manager = ConsensusManager::new();

        // --- Mining Phase ---
        {
            let mut clock = VDF_CLOCK.lock().unwrap();
            clock.current_tick = 0;
        }
        let result = manager.tick();
        assert_eq!(manager.current_phase, ConsensusPhase::Mining);
        assert!(result.new_phase.is_none());
        assert!(result.action_required.is_none());

        // --- Transition to Validation ---
        {
            let mut clock = VDF_CLOCK.lock().unwrap();
            clock.current_tick = MINING_PHASE_END_TICK;
        }
        let result = manager.tick();
        assert_eq!(manager.current_phase, ConsensusPhase::Validation);
        assert_eq!(result.new_phase, Some(ConsensusPhase::Validation));
        assert_eq!(result.action_required, Some("CREATE_COMMITMENT".to_string()));

        // --- Inside Validation (Reconciliation) ---
        {
            let mut clock = VDF_CLOCK.lock().unwrap();
            clock.current_tick = MINING_PHASE_END_TICK + COMMITMENT_END_TICK;
        }
        let result = manager.tick();
        assert_eq!(manager.current_phase, ConsensusPhase::Validation);
        assert!(result.new_phase.is_none());
        assert_eq!(result.action_required, Some("RECONCILE_AND_SELECT".to_string()));
        
        // --- Inside Validation (Voting) ---
        {
            let mut clock = VDF_CLOCK.lock().unwrap();
            clock.current_tick = MINING_PHASE_END_TICK + RECONCILIATION_END_TICK;
        }
        let result = manager.tick();
        assert_eq!(manager.current_phase, ConsensusPhase::Validation);
        assert!(result.new_phase.is_none());
        assert_eq!(result.action_required, Some("INITIATE_VDF_VOTE".to_string()));

        // --- Transition to Propagation ---
        {
            let mut clock = VDF_CLOCK.lock().unwrap();
            clock.current_tick = VALIDATION_PHASE_END_TICK;
        }
        let result = manager.tick();
        assert_eq!(manager.current_phase, ConsensusPhase::Propagation);
        assert_eq!(result.new_phase, Some(ConsensusPhase::Propagation));
        assert!(!result.block_finalized);

        // --- Transition back to Mining ---
        {
            let mut clock = VDF_CLOCK.lock().unwrap();
            clock.current_tick = TICKS_PER_CYCLE;
        }
        let result = manager.tick();
        assert_eq!(manager.current_phase, ConsensusPhase::Mining);
        assert_eq!(result.new_phase, Some(ConsensusPhase::Mining));
        assert_eq!(result.action_required, Some("START_MINING".to_string()));
    }

    #[test]
    fn test_submit_pow_candidate_success() {
        setup();
        let mut manager = ConsensusManager::new();
        let mut block = Block::genesis();
        block.height = 1;
        block.difficulty = 1; // Low difficulty for testing
        // Find a valid nonce
        while !block.is_valid_pow() {
            block.nonce += 1;
        }

        // VDF clock must be ready
        VDF_CLOCK.lock().unwrap().current_tick = 1 * TICKS_PER_CYCLE;

        let result = manager.submit_pow_candidate(block.clone());
        assert!(result.is_ok());
        assert!(manager.best_candidate_block.is_some());
        assert_eq!(manager.best_candidate_block.unwrap().hash(), block.hash());
    }

    #[test]
    fn test_submit_pow_candidate_failure_wrong_phase() {
        setup();
        let mut manager = ConsensusManager::new();
        manager.current_phase = ConsensusPhase::Validation; // Not in mining phase

        let block = Block::genesis();
        let result = manager.submit_pow_candidate(block);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Not in mining phase");
    }

    #[test]
    fn test_submit_pow_candidate_failure_invalid_pow() {
        setup();
        let mut manager = ConsensusManager::new();
        let mut block = Block::genesis();
        block.difficulty = 20; // High difficulty, will fail PoW check
        
        VDF_CLOCK.lock().unwrap().current_tick = 1 * TICKS_PER_CYCLE;

        let result = manager.submit_pow_candidate(block);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Invalid PoW");
    }

    #[test]
    fn test_finalize_bootstrap_block() {
        let _guard = setup();
        let manager = ConsensusManager::new();
        
        // Start fresh - the blockchain should only have genesis
        assert_eq!(BLOCKCHAIN.lock().unwrap().current_height, 0);
        
        // Now test finalizing a bootstrap block at height 1
        let mut block1 = Block::genesis();
        block1.height = 1;
        block1.prev_hash = BLOCKCHAIN.lock().unwrap().get_latest_block().hash();
        block1.difficulty = 1;
        while !block1.is_valid_pow() {
            block1.nonce += 1;
        }

        let finalized = manager.finalize_block(block1);
        assert!(finalized, "Bootstrap block 1 should be finalized successfully");
        
        // Then test block at height 2 (BOOTSTRAP_BLOCKS)
        let mut block2 = Block::genesis();
        block2.height = BOOTSTRAP_BLOCKS;
        block2.prev_hash = BLOCKCHAIN.lock().unwrap().get_latest_block().hash();
        block2.difficulty = 1;
        while !block2.is_valid_pow() {
            block2.nonce += 1;
        }

        let finalized = manager.finalize_block(block2);
        assert!(finalized, "Bootstrap block 2 should be finalized successfully");
        assert_eq!(BLOCKCHAIN.lock().unwrap().current_height, BOOTSTRAP_BLOCKS);
    }

    #[test]
    fn test_finalize_with_stake_validation_success() {
        let _guard = setup();
        let manager = ConsensusManager::new();
        
        // Bring chain up to the required height
        {
            let mut chain = BLOCKCHAIN.lock().unwrap();
            for i in 1..=BOOTSTRAP_BLOCKS {
                let mut block = Block::genesis();
                block.height = i;
                block.prev_hash = chain.get_latest_block().hash();
                block.difficulty = 1;
                while !block.is_valid_pow() {
                    block.nonce += 1;
                }
                chain.add_block(block).unwrap();
            }
        }
        
        let height = BOOTSTRAP_BLOCKS + 1;

        // Create a candidate block
        let mut block = Block::genesis();
        block.height = height;
        block.prev_hash = BLOCKCHAIN.lock().unwrap().get_latest_block().hash();
        block.difficulty = 1;
        
        // Add VDF proof for the block (required for non-bootstrap blocks)
        let vdf = VDF::new(2048).unwrap();
        let vdf_proof = vdf.compute_with_proof(block.prev_hash.as_bytes(), 100).unwrap();
        block.vdf_proof = vdf_proof;
        
        while !block.is_valid_pow() {
            block.nonce += 1;
        }
        let block_hash = block.hash();

        // --- Setup a validator with a REAL keypair ---
        let priv_key = mimblewimble::generate_secret_key();
        let pub_key = mimblewimble::derive_public_key(&priv_key);
        
        let mut validators = VALIDATORS.lock().unwrap();
        validators.insert("validator1".to_string(), Validator {
            id: "validator1".to_string(), 
            public_key: pub_key.compress().to_bytes().to_vec(), 
            private_key: priv_key.to_bytes().to_vec(),
            locked_stakes: vec![VDFLockedStake {
                stake_tx: StakeLockTransaction {
                    validator_id: "validator1".to_string(),
                    stake_amount: 2000,
                    lock_duration: 100,
                    lock_height: 0,
                    block_hash: "test".to_string(),
                },
                vdf_proof: VDFProof::default(),
                unlock_height: 100,
                activation_time: 0,
            }], 
            total_locked: 2000, 
            active: true,
        });
        drop(validators);
        
        // --- Create a VALID vote signature ---
        let stake_amount = 2000;
        let message_to_sign = format!("vote:{}:{}:{}", height, block_hash, stake_amount);
        let message_hash: [u8; 32] = Sha256::digest(message_to_sign.as_bytes()).into();
        let (challenge, s) = mimblewimble::create_schnorr_signature(message_hash, &priv_key).unwrap();
        let mut signature = Vec::with_capacity(64);
        signature.extend_from_slice(&challenge.to_bytes());
        signature.extend_from_slice(&s.to_bytes());
        
        // --- Create a valid VDF proof for the vote ---
        let vdf = VDF::new(2048).unwrap();
        let vdf_input = format!("{}||{}", "validator1", block_hash);
        let vote_vdf_proof = vdf.compute_with_proof(vdf_input.as_bytes(), 10).unwrap();

        // --- Setup vote with valid signature and VDF proof ---
        let mut votes = BLOCK_VOTES.lock().unwrap();
        let height_votes = votes.entry(height).or_insert_with(HashMap::new);
        height_votes.insert("validator1".to_string(), VoteData {
            block_hash: block_hash.clone(), 
            stake_amount,
            vdf_proof: vote_vdf_proof,
            signature,
            timestamp: 0,
        });
        drop(votes);
        
        // Finalization should now succeed
        let finalized = manager.finalize_with_stake_validation(block);
        assert!(finalized, "Finalization should succeed with a valid vote");
        assert_eq!(BLOCKCHAIN.lock().unwrap().current_height, height);
    }

    #[test]
    fn test_finalize_with_stake_validation_failure_insufficient_stake() {
        setup();
        let manager = ConsensusManager::new();
        let height = BOOTSTRAP_BLOCKS + 1;

        let mut block = Block::genesis();
        block.height = height;
        block.prev_hash = BLOCKCHAIN.lock().unwrap().get_latest_block().hash();
        let block_hash = block.hash();

        // Setup validators (total stake 2000, required 1001)
        let mut validators = VALIDATORS.lock().unwrap();
        validators.insert("validator1".to_string(), Validator {
            id: "validator1".to_string(), public_key: vec![], private_key: vec![],
            locked_stakes: vec![], total_locked: 1000, active: true,
        });
        validators.insert("validator2".to_string(), Validator {
            id: "validator2".to_string(), public_key: vec![], private_key: vec![],
            locked_stakes: vec![], total_locked: 1000, active: true,
        });
        drop(validators);

        // Setup votes (only 500 stake, not enough)
        let mut votes = BLOCK_VOTES.lock().unwrap();
        let height_votes = votes.entry(height).or_insert_with(HashMap::new);
        height_votes.insert("validator1".to_string(), VoteData {
            block_hash: block_hash.clone(), stake_amount: 500, // Not their full stake
            vdf_proof: VDFProof::default(), signature: vec![], timestamp: 0,
        });
        drop(votes);

        let finalized = manager.finalize_with_stake_validation(block);
        assert!(!finalized);
    }
}
