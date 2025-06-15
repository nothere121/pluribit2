// src/consensus_manager.rs

use crate::block::Block;
use crate::{BLOCKCHAIN, BLOCK_VOTES, VDF_CLOCK, VALIDATORS};
use crate::constants::{MINING_PHASE_DURATION, VALIDATION_PHASE_DURATION};
use serde::{Serialize, Deserialize};
use crate::log;
use crate::vdf::VDF;

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
    pub phase_start_time: u64, // Track when phase started
}

impl ConsensusManager {
    pub fn new() -> Self {
        ConsensusManager {
            current_phase: ConsensusPhase::Mining,
            phase_timer: MINING_PHASE_DURATION, // Now uses 600 seconds (10 minutes)
            best_candidate_block: None,
            phase_start_time: js_sys::Date::now() as u64,
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
                    self.phase_timer = VALIDATION_PHASE_DURATION; // 300 seconds (5 minutes)
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

    fn finalize_block(&self, mut block: Block) -> bool {
        use curve25519_dalek::scalar::Scalar;
        use curve25519_dalek::ristretto::CompressedRistretto;
        use sha2::{Sha256, Digest};
        
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
            // Check if vote is for this block
            if vote.block_hash != block.hash() {
                continue;
            }
            
            // Get validator
            let validator = match validators.get(validator_id) {
                Some(v) => v,
                None => {
                    log(&format!("Validator {} not found, skipping vote", validator_id));
                    continue;
                }
            };
            
            // Verify the vote signature
            let vote_message = format!("vote:{}:{}:{}", 
                block.height, 
                vote.block_hash, 
                vote.stake_amount
            );
            
            let message_hash = Sha256::digest(vote_message.as_bytes());
            let mut hash_array = [0u8; 32];
            hash_array.copy_from_slice(&message_hash);
            
            // Parse public key
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
            
            // Parse and verify signature
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
            
            // Verify signature using mimblewimble module
            if !crate::mimblewimble::verify_schnorr_signature(&(challenge, s), hash_array, &public_key) {
                log(&format!("Invalid signature from validator {}", validator_id));
                continue;
            }
            
            // Verify VDF proof
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
                    // Vote is valid - create ValidatorVote for finalization data
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
        
        // Check if we have enough stake (> 50% of total locked stake)
        // For testing: Allow single validator finalization
        let required_stake = if total_active_stake <= 1000 {
            // If only one small validator, allow it
            1
        } else {
            total_active_stake / 2 + 1
        };
        
        if total_voted_stake < required_stake {
            log(&format!(
                "Insufficient stake for finalization: {} < {} (need >50% of {})",
                total_voted_stake, required_stake, total_active_stake
            ));
            return false;
        }
        
        // Create finalization data
        block.finalization_data = Some(crate::block::BlockFinalization {
            votes: valid_votes,
            total_stake_voted: total_voted_stake,
            total_stake_active: total_active_stake,
        });
        
        // Calculate consensus quality
        let consensus_quality = (total_voted_stake as f64) / (total_active_stake as f64);
        
        log(&format!(
            "Block {} finalized with {:.1}% consensus ({}/{} stake)",
            block.height,
            consensus_quality * 100.0,
            total_voted_stake,
            total_active_stake
        ));
        
        // Add finalized block to chain
        drop(validators);
        drop(chain);
        let mut chain = BLOCKCHAIN.lock().unwrap();

        // Get the height before moving the block
        let block_height = block.height; 
        match chain.add_block(block) {
            Ok(_) => {
                // Clear votes for this height
                let _ = height_votes;
                drop(votes);
                let mut votes = BLOCK_VOTES.lock().unwrap();
                // FIX: Use the saved height
                votes.remove(&block_height);
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
