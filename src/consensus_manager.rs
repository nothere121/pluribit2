// src/consensus_manager.rs

use crate::block::Block;
use crate::{BLOCKCHAIN, BLOCK_VOTES, VDF_CLOCK, VALIDATORS};
use crate::constants::{MINING_PHASE_DURATION, VALIDATION_PHASE_DURATION};
use serde::{Serialize, Deserialize};
use crate::log;
use crate::vdf::VDF;
//use crate::{WALLET_OUTPUTS, WalletOutput};
//use crate::mimblewimble;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ConsensusPhase {
    Mining,
    Validation,
}

#[derive(Debug, Clone)]
pub struct ConsensusManager {
    pub current_phase: ConsensusPhase,
    pub phase_timer: u64,
    pub best_candidate_block: Option<Block>,
    pub phase_start_time: u64, // Track when the phase started
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ValidationSubPhase {
    ProvisionalCommitment,  // 0-60 seconds into validation
    Reconciliation,         // 60-90 seconds
    VDFVoting,              // 90-300 seconds
}

impl ConsensusManager {
    pub fn new() -> Self {
        ConsensusManager {
            current_phase: ConsensusPhase::Mining,
            phase_timer: MINING_PHASE_DURATION,
            best_candidate_block: None,
            phase_start_time: js_sys::Date::now() as u64, // Initialize with current time
        }
    }

    pub fn tick(&mut self) -> ConsensusResult {
        // Decrement timer
        if self.phase_timer > 0 {
            self.phase_timer -= 1;
        }

        let mut block_added = false;

        // Check if phase should transition
        if self.phase_timer == 0 {
            match self.current_phase {
                ConsensusPhase::Mining => {
                    log("[CONSENSUS] Mining phase complete, starting validation");
                    self.current_phase = ConsensusPhase::Validation;
                    self.phase_timer = VALIDATION_PHASE_DURATION; 
                    self.phase_start_time = js_sys::Date::now() as u64;
                }
                ConsensusPhase::Validation => {
                    log("[CONSENSUS] Validation phase complete");
                    
                    // Process the best candidate if we have one
                    if let Some(block) = self.best_candidate_block.take() {
                        block_added = self.finalize_block(block);
                    }
                    
                    // Return to mining
                    self.current_phase = ConsensusPhase::Mining;
                    self.phase_timer = MINING_PHASE_DURATION;
                    self.phase_start_time = js_sys::Date::now() as u64;
                    self.best_candidate_block = None;
                }
            }
        }

        ConsensusResult {
            current_phase: self.current_phase.clone(),
            phase_timer: self.phase_timer,
            phase_start_time: self.phase_start_time,
            // Clone and ensure we have a complete block structure
            best_candidate_block: self.best_candidate_block.as_ref().map(|block| Block {
                height: block.height,
                prev_hash: block.prev_hash.clone(),
                transactions: block.transactions.clone(), // Ensure transactions field exists
                vdf_proof: block.vdf_proof.clone(),
                timestamp: block.timestamp,
                nonce: block.nonce,
                miner_id: block.miner_id.clone(),
                difficulty: block.difficulty,
                finalization_data: block.finalization_data.clone(),
            }),
            block_added,
        }
    }
    pub fn get_validation_subphase(&self) -> Option<ValidationSubPhase> {
        if self.current_phase != ConsensusPhase::Validation {
            return None;
        }
        
        // Calculate time into validation phase
        let elapsed = js_sys::Date::now() as u64 - self.phase_start_time;
        let elapsed_secs = elapsed / 1000;
        
        match elapsed_secs {
            0..=60 => Some(ValidationSubPhase::ProvisionalCommitment),
            61..=90 => Some(ValidationSubPhase::Reconciliation),
            91..=300 => Some(ValidationSubPhase::VDFVoting),
            _ => None,
        }
    }
    pub fn submit_pow_candidate(&mut self, candidate: Block) -> Result<(), String> {
        // Only accept during mining phase
        if self.current_phase != ConsensusPhase::Mining {
            return Err("Not in mining phase".to_string());
        }

        // Verify the block has valid PoW
        if !candidate.is_valid_pow() {
            return Err("Invalid PoW".to_string());
        }

        // Verify VDF timing
        let clock = VDF_CLOCK.lock().unwrap();
        if !clock.can_submit_block(candidate.height) {
            return Err(format!(
                "VDF clock not ready. Current: {}, Required: {}",
                clock.current_tick,
                candidate.height * clock.ticks_per_block
            ));
        }
        drop(clock);

        // Check if this is better than current best
        if let Some(ref current_best) = self.best_candidate_block {
            // Lower hash = more work = better
            if candidate.hash() >= current_best.hash() {
                return Ok(()); // Not better, silently ignore
            }
        }

        log(&format!("[CONSENSUS] New best candidate block at height {}", candidate.height));
        self.best_candidate_block = Some(candidate);
        Ok(())
    }


    pub fn calculate_dynamic_block_reward(difficulty: u8, participation_rate: f64) -> u64 {
        let base_reward = 50u64;
        
        // Difficulty bonus: log2(difficulty)
        let difficulty_bonus = if difficulty > 1 {
            (difficulty as f64).log2() as u64
        } else {
            0
        };
        
        // Participation penalty: reduce rewards if participation is low
        let participation_multiplier = if participation_rate > 0.8 {
            1.0 // Full rewards above 80% participation
        } else {
            participation_rate // Linear reduction below 80%
        };
        
        let total_reward = base_reward + difficulty_bonus;
        (total_reward as f64 * participation_multiplier) as u64
    }

    fn finalize_block(&self, mut block: Block) -> bool {
        use crate::constants::BOOTSTRAP_BLOCKS;
        
        // During bootstrap, only require PoW
        if block.height <= BOOTSTRAP_BLOCKS {
            log(&format!("[CONSENSUS] Block {} in bootstrap period - PoW only", block.height));
            
            // The only check during bootstrap is a valid Proof-of-Work
            if !block.is_valid_pow() {
                log(&format!("[CONSENSUS] Bootstrap block {} has invalid PoW", block.height));
                return false;
            }
            
            // Create minimal finalization data to show it was a bootstrap block
            block.finalization_data = Some(crate::block::BlockFinalization {
                votes: vec![],
                total_stake_voted: 0,
                total_stake_active: 0,
            });
            
            // Add the block to the chain
            let mut chain = BLOCKCHAIN.lock().unwrap();
            match chain.add_block(block.clone()) {
                Ok(_) => {
                    // If this is the *last* bootstrap block, log a special message
                    if block.height == BOOTSTRAP_BLOCKS {
                        log!("[CONSENSUS] Bootstrap complete! Full stake validation is now required for the next block.");
                    }
                    true
                }
                Err(e) => {
                    log(&format!("[CONSENSUS] Failed to add bootstrap block: {:?}", e));
                    false
                }
            }
        } else {
            // After the bootstrap period, use the full stake validation logic
            self.finalize_with_stake_validation(block)
        }
    }
    
    fn finalize_with_stake_validation(&self, mut block: Block) -> bool {

        use crate::transaction::Transaction; // Ensure Transaction is in scope for .hash()
        use curve25519_dalek::scalar::Scalar;
        use curve25519_dalek::ristretto::CompressedRistretto;
        use sha2::{Sha256, Digest};
        use std::collections::HashSet; // Ensure HashSet is in scope
        
        let chain = BLOCKCHAIN.lock().unwrap();
        let votes = BLOCK_VOTES.lock().unwrap();
        let validators = VALIDATORS.lock().unwrap();
        
        // Get votes for this block
        let height_votes = match votes.get(&block.height) {
            Some(votes) => votes,
            None => {
                log(&format!("No votes found for block {}", block.height));
                return false;
            }
        };
        
        // Calculate total stake that voted for this block
        let mut total_voted_stake = 0u64;
        let mut total_active_stake = 0u64;
        let mut valid_votes = Vec::new();
        
        // Calculate total active stake
        for validator in validators.values() {
            if validator.active {
                total_active_stake += validator.total_locked;
            }
        }
        
        // Verify each vote
        for (validator_id, vote) in height_votes.iter() {
            if vote.block_hash != block.hash() {
                continue;
            }
            
            let validator = match validators.get(validator_id) {
                Some(v) => v,
                None => {
                    log(&format!("Validator {} not found, skipping vote", validator_id));
                    continue;
                }
            };
            
            let vote_message = format!("vote:{}:{}:{}", 
                block.height, 
                vote.block_hash, 
                vote.stake_amount
            );
            
            let message_hash: [u8; 32] = Sha256::digest(vote_message.as_bytes()).into();
            
            let public_key_compressed = match CompressedRistretto::from_slice(&validator.public_key) {
                Ok(pk) => pk,
                Err(_) => {
                    log(&format!("Invalid public key for validator {}", validator_id));
                    continue;
                }
            };
            
            let public_key = match public_key_compressed.decompress() {
                Some(pk) => pk,
                None => {
                    log(&format!("Failed to decompress public key for validator {}", validator_id));
                    continue;
                }
            };
            
            if vote.signature.len() != 64 {
                log(&format!("Invalid signature length from validator {}", validator_id));
                continue;
            }
            
            let mut challenge_bytes = [0u8; 32];
            challenge_bytes.copy_from_slice(&vote.signature[0..32]);
            let challenge = Scalar::from_bytes_mod_order(challenge_bytes);
            
            let mut s_bytes = [0u8; 32];
            s_bytes.copy_from_slice(&vote.signature[32..64]);
            let s = Scalar::from_bytes_mod_order(s_bytes);
            
            if !crate::mimblewimble::verify_schnorr_signature(&(challenge, s), message_hash, &public_key) {
                log(&format!("Invalid signature from validator {}", validator_id));
                continue;
            }
            
            let vote_input = format!("{}||{}", validator_id, vote.block_hash);
            let vdf = match VDF::new(2048) {
                Ok(v) => v,
                Err(e) => {
                    log(&format!("Failed to create VDF: {}", e));
                    continue;
                }
            };
            
            match vdf.verify(vote_input.as_bytes(), &vote.vdf_proof) {
                Ok(true) => {
                    total_voted_stake += vote.stake_amount;
                    valid_votes.push(crate::block::ValidatorVote {
                        validator_id: validator_id.clone(),
                        block_hash: vote.block_hash.clone(),
                        stake_amount: vote.stake_amount,
                        vdf_proof: vote.vdf_proof.clone(),
                        signature: vote.signature.clone(),
                    });
                    log(&format!("Valid vote from {} with stake {}", validator_id, vote.stake_amount));
                }
                _ => {
                    log(&format!("Invalid VDF proof from validator {}", validator_id));
                    continue;
                }
            }
        }
        
        let required_stake = if total_active_stake == 0 { 1 } else { total_active_stake / 2 + 1 };
        
        if total_voted_stake < required_stake {
            log(&format!(
                "Insufficient stake for finalization: {} < {} (need >50% of {})",
                total_voted_stake, required_stake, total_active_stake
            ));
            return false;
        }
        
        block.finalization_data = Some(crate::block::BlockFinalization {
            votes: valid_votes.clone(),
            total_stake_voted: total_voted_stake, 
            total_stake_active: total_active_stake, 
        });
        
        let consensus_quality = if total_active_stake > 0 {
            (total_voted_stake as f64) / (total_active_stake as f64)
        } else {
            1.0
        };
        
        log(&format!(
            "Block {} finalized with {:.1}% consensus ({}/{} stake)",
            block.height,
            consensus_quality * 100.0,
            total_voted_stake,
            total_active_stake
        ));
        
        let participation_rate = consensus_quality;
        let total_block_reward = Self::calculate_dynamic_block_reward(block.difficulty, participation_rate);
        let staker_reward_pool = total_block_reward / 2; // Example 50/50 split
        
        let block_height = block.height;
        let reward_votes = valid_votes.clone();
        
        // --- MODIFICATION START ---
        // Keep a copy of the transactions that are about to be finalized.
        let finalized_transactions = block.transactions.clone();
        // --- MODIFICATION END ---
        
        drop(validators);
        drop(chain);
        let mut chain = BLOCKCHAIN.lock().unwrap();

        match chain.add_block(block) {
            Ok(_) => {
                // --- MODIFICATION START ---
                // On successful block addition, clear its transactions from the global mempool.
                let mut pool = crate::TX_POOL.lock().unwrap();
                if !finalized_transactions.is_empty() {
                    let hashes_to_remove: HashSet<String> = finalized_transactions.iter().map(|tx| tx.hash()).collect();
                    
                    let initial_pool_size = pool.pending.len();
                    pool.pending.retain(|tx| !hashes_to_remove.contains(&tx.hash()));
                    let final_pool_size = pool.pending.len();

                    // Recalculate total fees in the pool
                    pool.fee_total = pool.pending.iter().map(|tx| tx.kernel.fee).sum();
                    
                    log(&format!(
                        "[TX_POOL] Cleared {} finalized txs from mempool ({} -> {}).",
                        initial_pool_size - final_pool_size, initial_pool_size, final_pool_size
                    ));
                }
                // --- MODIFICATION END ---

                // Clear votes for this height from the global vote map
                drop(votes);
                let mut votes = BLOCK_VOTES.lock().unwrap();
                votes.remove(&block_height);
                drop(votes);
                
                // Distribute staking rewards
                if staker_reward_pool > 0 && !reward_votes.is_empty() && total_voted_stake > 0 {
                    let mut pending_rewards = crate::PENDING_REWARDS.lock().unwrap();
                    
                    for vote in &reward_votes {
                        let validator_reward = (staker_reward_pool as u128 * vote.stake_amount as u128 / total_voted_stake as u128) as u64;
                        
                        if validator_reward > 0 {
                            pending_rewards.push((vote.validator_id.clone(), validator_reward));
                            log(&format!("[CONSENSUS] Queued {} coins reward for validator {}", 
                                validator_reward, vote.validator_id));
                        }
                    }
                }
                
                true
            }
            Err(e) => {
                log(&format!("Failed to add finalized block to chain: {:?}", e));
                false
            }
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct ConsensusResult {
    pub current_phase: ConsensusPhase,
    pub phase_timer: u64,
    pub phase_start_time: u64,
    pub best_candidate_block: Option<Block>,
    pub block_added: bool,
}
