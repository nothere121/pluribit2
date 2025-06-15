// src/slashing.rs

use crate::{VALIDATORS, BLOCK_VOTES, WALLET_OUTPUTS};
use crate::block::ValidatorVote;
use crate::vdf::VDF;
use crate::mimblewimble;
use crate::WalletOutput;
use crate::log;
use std::collections::HashMap;
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashingEvidence {
    pub validator_id: String,
    pub height: u64,
    pub vote1: ValidatorVote,
    pub vote2: ValidatorVote,
    pub vote1_block_hash: String,
    pub vote2_block_hash: String,
}

/// Check if a validator has already voted at a specific height
pub fn has_voted_at_height(validator_id: &str, height: u64) -> Option<String> {
    let votes = BLOCK_VOTES.lock().unwrap();
    
    if let Some(height_votes) = votes.get(&height) {
        if let Some(vote_data) = height_votes.get(validator_id) {
            return Some(vote_data.block_hash.clone());
        }
    }
    
    None
}

/// Process slashing evidence for double voting
pub fn process_slashing_evidence(evidence: SlashingEvidence, reporter_id: &str) -> Result<(), String> {
    // Verify both votes are from the same validator
    if evidence.vote1.validator_id != evidence.vote2.validator_id {
        return Err("Votes are from different validators".to_string());
    }
    
    // Verify both votes are for the same height
    if evidence.vote1_block_hash == evidence.vote2_block_hash {
        return Err("Both votes are for the same block".to_string());
    }
    
    // Verify VDF proofs for both votes
    let vdf = VDF::new(2048).map_err(|e| format!("VDF error: {:?}", e))?;
    
    // Vote 1
    let vote1_input = format!("{}||{}", evidence.validator_id, evidence.vote1_block_hash);
    let vote1_valid = vdf.verify(vote1_input.as_bytes(), &evidence.vote1.vdf_proof)
        .map_err(|e| format!("Vote1 VDF verification failed: {:?}", e))?;
    
    if !vote1_valid {
        return Err("Vote1 has invalid VDF proof".to_string());
    }
    
    // Vote 2
    let vote2_input = format!("{}||{}", evidence.validator_id, evidence.vote2_block_hash);
    let vote2_valid = vdf.verify(vote2_input.as_bytes(), &evidence.vote2.vdf_proof)
        .map_err(|e| format!("Vote2 VDF verification failed: {:?}", e))?;
    
    if !vote2_valid {
        return Err("Vote2 has invalid VDF proof".to_string());
    }
    
    // Both votes are valid - this is double voting!
    slash_validator(&evidence.validator_id, reporter_id)?;
    
    Ok(())
}

/// Slash a validator's stake
fn slash_validator(validator_id: &str, reporter_id: &str) -> Result<(), String> {
    let mut validators = VALIDATORS.lock().unwrap();
    
    let validator = validators.get_mut(validator_id)
        .ok_or("Validator not found")?;
    
    if !validator.active {
        return Err("Validator already inactive".to_string());
    }
    
    let total_stake = validator.total_locked;
    if total_stake == 0 {
        return Err("Validator has no stake".to_string());
    }
    
    // Calculate slashing amounts
    let reporter_reward = total_stake * 5 / 100;  // 5% to reporter
    let burn_amount = total_stake * 95 / 100;     // 95% burned
    
    // Mark validator as slashed
    validator.active = false;
    validator.total_locked = 0;
    validator.locked_stakes.clear();
    
    log(&format!(
        "[SLASHING] Validator {} slashed! Total: {}, Burned: {}, Reporter reward: {}",
        validator_id, total_stake, burn_amount, reporter_reward
    ));
    
    // Give reward to reporter
    if reporter_reward > 0 {
        let mut wallets = WALLET_OUTPUTS.lock().unwrap();
        
        // Create reward output for reporter
        let blinding = mimblewimble::generate_secret_key();
        let commitment = mimblewimble::commit(reporter_reward, &blinding)
            .map_err(|e| format!("Failed to create reward commitment: {:?}", e))?;
        
        let reward_output = WalletOutput {
            value: reporter_reward,
            blinding_factor: blinding.to_bytes().to_vec(),
            commitment: commitment.compress().to_bytes().to_vec(),
            spent: false,
        };
        
        wallets.entry(reporter_id.to_string())
            .or_insert_with(Vec::new)
            .push(reward_output);
        
        log(&format!("[SLASHING] Reporter {} received {} coins", reporter_id, reporter_reward));
    }
    
    // Note: The burned amount (95%) is effectively removed from circulation
    // as the validator's stake is cleared but no outputs are created for it
    
    Ok(())
}

/// Check all current votes for double voting
pub fn check_for_double_votes() -> Vec<SlashingEvidence> {
    let mut evidence_list = Vec::new();
    let votes = BLOCK_VOTES.lock().unwrap();
    
    // Group votes by validator
    let mut validator_votes: HashMap<String, Vec<(u64, String, ValidatorVote)>> = HashMap::new();
    
    for (height, height_votes) in votes.iter() {
        for (validator_id, vote_data) in height_votes {
            validator_votes.entry(validator_id.clone())
                .or_insert_with(Vec::new)
                .push((*height, vote_data.block_hash.clone(), ValidatorVote {
                    validator_id: validator_id.clone(),
                    block_hash: vote_data.block_hash.clone(),
                    stake_amount: vote_data.stake_amount,
                    vdf_proof: vote_data.vdf_proof.clone(),
                    signature: vote_data.signature.clone(),
                }));
        }
    }
    
    // Check each validator's votes
    for (validator_id, mut votes) in validator_votes {
        // Sort by height
        votes.sort_by_key(|(h, _, _)| *h);
        
        // Check for multiple votes at same height
        for i in 0..votes.len() {
            for j in i+1..votes.len() {
                if votes[i].0 == votes[j].0 && votes[i].1 != votes[j].1 {
                    // Found double vote!
                    evidence_list.push(SlashingEvidence {
                        validator_id: validator_id.clone(),
                        height: votes[i].0,
                        vote1: votes[i].2.clone(),
                        vote2: votes[j].2.clone(),
                        vote1_block_hash: votes[i].1.clone(),
                        vote2_block_hash: votes[j].1.clone(),
                    });
                }
            }
        }
    }
    
    evidence_list
}
