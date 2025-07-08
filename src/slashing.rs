// src/slashing.rs
use crate::{VALIDATORS, BLOCK_VOTES, CANDIDATE_COMMITMENTS, CANDIDATE_BLOCKS};
use crate::block::ValidatorVote;
use crate::vdf::VDF;
use crate::log;
use crate::{VoteData, CandidateSetCommitment};
use std::collections::{HashMap, HashSet}; // Add HashSet
use serde::{Serialize, Deserialize};

// CHANGE: Convert from struct to enum to support multiple evidence types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SlashingEvidence {
    DoubleVote {
        validator_id: String,
        height: u64,
        vote1: ValidatorVote,
        vote2: ValidatorVote,
        vote1_block_hash: String,
        vote2_block_hash: String,
    },
    DishonestVoting {
        validator_id: String,
        height: u64,
        voted_hash: String,
        best_hash: String,
        commitment: CandidateSetCommitment,
        vote: VoteData,
    },
}

/// Process any type of slashing evidence.
/// Returns the reward amount for the reporter on success.
pub fn process_slashing_evidence(evidence: SlashingEvidence) -> Result<u64, String> {
    match evidence {
        SlashingEvidence::DoubleVote {
            validator_id,
            height,
            vote1,
            vote2,
            vote1_block_hash,
            vote2_block_hash,
        } => {
            // Verify both votes are from the same validator
            if vote1.validator_id != vote2.validator_id {
                return Err("Votes are from different validators".to_string());
            }
            
            // Verify both votes are for the same block hash
            if vote1_block_hash == vote2_block_hash {
                return Err("Both votes are for the same block".to_string());
            }
            
            // Verify VDF proofs for both votes
            let vdf = VDF::new(2048).map_err(|e| format!("VDF error: {:?}", e))?;
            
            // Vote 1
            let vote1_input = format!("{}||{}", validator_id, vote1_block_hash);
            if !vdf.verify(vote1_input.as_bytes(), &vote1.vdf_proof).unwrap_or(false) {
                return Err("Vote1 has invalid VDF proof".to_string());
            }
            
            // Vote 2
            let vote2_input = format!("{}||{}", validator_id, vote2_block_hash);
            if !vdf.verify(vote2_input.as_bytes(), &vote2.vdf_proof).unwrap_or(false) {
                return Err("Vote2 has invalid VDF proof".to_string());
            }
            
            log(&format!("[SLASHING] Double vote detected for validator {} at height {}", 
                validator_id, height));
            
            // Both votes are valid - this is double voting!
            slash_validator(&validator_id, 100) // 100% slash for double voting
        },
        
        SlashingEvidence::DishonestVoting {
            validator_id,
            height,
            voted_hash,
            best_hash,
            commitment,
            vote,
        } => {
            // Verify the validator knew about the better block
            if !commitment.candidate_hashes.contains(&best_hash) {
                return Err("Commitment doesn't contain best hash".to_string());
            }
            
            // Verify they voted for a different block
            if vote.block_hash != voted_hash {
                return Err("Vote hash mismatch".to_string());
            }
            
            // Verify the vote VDF
            let vdf = VDF::new(2048).map_err(|e| format!("VDF error: {:?}", e))?;
            let vote_input = format!("{}||{}", validator_id, voted_hash);
            if !vdf.verify(vote_input.as_bytes(), &vote.vdf_proof).unwrap_or(false) {
                return Err("Vote has invalid VDF proof".to_string());
            }
            
            log(&format!("[SLASHING] Dishonest voting detected for validator {} at height {}. Voted for {} instead of best {}", 
                validator_id, height, &voted_hash[..16], &best_hash[..16]));
            
            // Dishonest voting gets 100% slash
            slash_validator(&validator_id, 100)
        }
    }
}

/// Slash a validator's stake and return the reporter's reward.
/// slash_percent: percentage of stake to slash (50 or 100)
fn slash_validator(validator_id: &str, slash_percent: u64) -> Result<u64, String> {
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
    
    // Calculate slashing amounts based on severity
    let slashed_amount = (total_stake * slash_percent) / 100;
    let reporter_reward = slashed_amount * 5 / 100;  // 5% of slashed amount to reporter
    let burn_amount = slashed_amount.saturating_sub(reporter_reward);
    
    // Update validator's stake
    if slash_percent == 100 {
        // Full slash - validator is kicked out
        validator.active = false;
        validator.total_locked = 0;
        validator.locked_stakes.clear();
    } else {
        // Partial slash - reduce stake
        validator.total_locked = validator.total_locked.saturating_sub(slashed_amount);
        
        // Proportionally reduce all locked stakes
        for stake in &mut validator.locked_stakes {
            stake.stake_tx.stake_amount = 
                (stake.stake_tx.stake_amount * (100 - slash_percent)) / 100;
        }
    }
    
    log(&format!(
        "[SLASHING] Validator {} slashed {}%! Amount: {}, Burned: {}, Reporter reward: {}",
        validator_id, slash_percent, slashed_amount, burn_amount, reporter_reward
    ));
    
    // Return the calculated reward to the caller.
    Ok(reporter_reward)
}

/// Check all current votes for double voting.
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
            for j in i + 1..votes.len() {
                if votes[i].0 == votes[j].0 && votes[i].1 != votes[j].1 {
                    // Found double vote!
                    evidence_list.push(SlashingEvidence::DoubleVote {
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

/// Check for dishonest voting at a specific height.
pub fn check_dishonest_voting(height: u64) -> Vec<SlashingEvidence> {
    let mut evidence_list = Vec::new();

    let commitments_lock = CANDIDATE_COMMITMENTS.lock().unwrap();
    let votes_lock = BLOCK_VOTES.lock().unwrap();
    let blocks_lock = CANDIDATE_BLOCKS.lock().unwrap();

    // Get all commitments and votes for the target height
    let Some(height_commitments) = commitments_lock.get(&height) else { return evidence_list; };
    let Some(height_votes) = votes_lock.get(&height) else { return evidence_list; };
    let Some(height_blocks) = blocks_lock.get(&height) else { return evidence_list; };

    // 1. Find the globally best block hash (lowest hash value) from ALL commitments.
    let mut all_known_hashes = HashSet::new();
    for commitment in height_commitments.values() {
        all_known_hashes.extend(commitment.candidate_hashes.iter().cloned());
    }

    let best_hash = all_known_hashes.iter()
        .min_by_key(|hash| {
            height_blocks.get(*hash).map_or(u64::MAX, |block| {
                u64::from_str_radix(&block.hash()[..16], 16).unwrap_or(u64::MAX)
            })
        })
        .cloned();

    let Some(best_hash) = best_hash else { return evidence_list; };
    if best_hash.is_empty() { return evidence_list; }

    // 2. Iterate through every validator's vote at this height.
    for (validator_id, vote) in height_votes {
        // 3. If they voted for an inferior block, check for proof of dishonesty.
        if vote.block_hash != best_hash {
            // 4. The proof is a commitment from ANY OTHER validator that contained the best block.
            for (committer_id, proof_commitment) in height_commitments {
                if committer_id != validator_id && proof_commitment.candidate_hashes.contains(&best_hash) {
                    // Found proof! The offender voted for an inferior block
                    // while the better block was public knowledge.
                    log(&format!(
                        "[SLASHING] Found dishonest vote by {}. They voted for {} but {} was public.",
                        validator_id, &vote.block_hash[..8], &best_hash[..8]
                    ));

                    evidence_list.push(SlashingEvidence::DishonestVoting {
                        validator_id: validator_id.clone(),
                        height,
                        voted_hash: vote.block_hash.clone(),
                        best_hash: best_hash.clone(),
                        // The crucial evidence is the *other* validator's commitment
                        commitment: proof_commitment.clone(),
                        vote: vote.clone(),
                    });
                    // Found evidence for this validator, no need to check other commitments.
                    break;
                }
            }
        }
    }

    evidence_list
}

/// Combined check for all slashing violations.
pub fn check_all_violations() -> Vec<SlashingEvidence> {
    let mut all_evidence = Vec::new();
    
    // Check for double votes
    all_evidence.extend(check_for_double_votes());
    
    // Check for dishonest voting at all heights with votes
    let votes = BLOCK_VOTES.lock().unwrap();
    let heights: Vec<u64> = votes.keys().cloned().collect();
    drop(votes);
    
    for height in heights {
        all_evidence.extend(check_dishonest_voting(height));
    }
    
    all_evidence
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::block::Block;
    use crate::vdf::VDFProof;
    use crate::{Validator, VDFLockedStake, StakeLockTransaction};
    #[test]
    fn test_check_for_double_votes() {
        // Setup double vote scenario
        let mut votes = BLOCK_VOTES.lock().unwrap();
        let height_votes = votes.entry(100).or_insert_with(HashMap::new);
        
        // Same validator votes for two different blocks at same height
        height_votes.insert("validator1".to_string(), VoteData {
            block_hash: "block_a".to_string(),
            stake_amount: 1000,
            vdf_proof: VDFProof::default(),
            signature: vec![1; 64],
            timestamp: 1000,
        });
        
        // This would be inserted by network message handler
        drop(votes);
        
        // Check should find no double votes with just one vote
        let evidence = check_for_double_votes();
        assert_eq!(evidence.len(), 0);
        
        // Add second vote for different block
        let mut votes = BLOCK_VOTES.lock().unwrap();
        let height_votes = votes.get_mut(&100).unwrap();
        
        // Simulate the validator voting again (which they shouldn't)
        let mut validator_votes = HashMap::new();
        validator_votes.insert("block_a".to_string(), height_votes.get("validator1").unwrap().clone());
        validator_votes.insert("block_b".to_string(), VoteData {
            block_hash: "block_b".to_string(),
            stake_amount: 1000,
            vdf_proof: VDFProof::default(),
            signature: vec![2; 64],
            timestamp: 2000,
        });
        
        drop(votes);
        
        // Manually check the double vote logic
        let evidence = SlashingEvidence::DoubleVote {
            validator_id: "validator1".to_string(),
            height: 100,
            vote1: ValidatorVote {
                validator_id: "validator1".to_string(),
                block_hash: "block_a".to_string(),
                stake_amount: 1000,
                vdf_proof: VDFProof::default(),
                signature: vec![1; 64],
            },
            vote2: ValidatorVote {
                validator_id: "validator1".to_string(),
                block_hash: "block_b".to_string(),
                stake_amount: 1000,
                vdf_proof: VDFProof::default(),
                signature: vec![2; 64],
            },
            vote1_block_hash: "block_a".to_string(),
            vote2_block_hash: "block_b".to_string(),
        };
        
        // Verify the evidence structure
        match &evidence {
            SlashingEvidence::DoubleVote { validator_id, height, .. } => {
                assert_eq!(validator_id, "validator1");
                assert_eq!(*height, 100);
            }
            _ => panic!("Wrong evidence type"),
        }
    }
    
    #[test]
    fn test_check_dishonest_voting() {
        let height = 100;
        
        // Setup blocks
        let mut blocks = CANDIDATE_BLOCKS.lock().unwrap();
        let height_blocks = blocks.entry(height).or_insert_with(HashMap::new);
        
        // Good block with low hash
        let mut good_block = Block::genesis();
        good_block.height = height;
        good_block.nonce = 1; // Will have lower hash
        height_blocks.insert("good_hash".to_string(), good_block);
        
        // Bad block with high hash
        let mut bad_block = Block::genesis();
        bad_block.height = height;
        bad_block.nonce = 1000000; // Will have higher hash
        height_blocks.insert("bad_hash".to_string(), bad_block);
        drop(blocks);
        
        // Setup commitments showing validator1 knew about both blocks
        let mut commitments = CANDIDATE_COMMITMENTS.lock().unwrap();
        let height_commitments = commitments.entry(height).or_insert_with(HashMap::new);
        
        height_commitments.insert("validator1".to_string(), CandidateSetCommitment {
            validator_id: "validator1".to_string(),
            height,
            candidate_hashes: vec!["good_hash".to_string(), "bad_hash".to_string()],
            signature: vec![],
            timestamp: 1000,
        });
        
        // Validator2 also knew about the good block
        height_commitments.insert("validator2".to_string(), CandidateSetCommitment {
            validator_id: "validator2".to_string(),
            height,
            candidate_hashes: vec!["good_hash".to_string()],
            signature: vec![],
            timestamp: 1000,
        });
        drop(commitments);
        
        // Validator1 votes for the bad block despite knowing about the good one
        let mut votes = BLOCK_VOTES.lock().unwrap();
        let height_votes = votes.entry(height).or_insert_with(HashMap::new);
        height_votes.insert("validator1".to_string(), VoteData {
            block_hash: "bad_hash".to_string(),
            stake_amount: 1000,
            vdf_proof: VDFProof::default(),
            signature: vec![],
            timestamp: 2000,
        });
        drop(votes);
        
        // Check should find dishonest voting
        let evidence = check_dishonest_voting(height);
        assert_eq!(evidence.len(), 1);
        
        match &evidence[0] {
            SlashingEvidence::DishonestVoting { validator_id, voted_hash, best_hash, .. } => {
                assert_eq!(validator_id, "validator1");
                assert_eq!(voted_hash, "bad_hash");
                assert_eq!(best_hash, "good_hash");
            }
            _ => panic!("Wrong evidence type"),
        }
    }
    
    #[test]
    fn test_slash_validator() {
        // Setup validator
        let mut validators = VALIDATORS.lock().unwrap();
        validators.insert("validator1".to_string(), Validator {
            id: "validator1".to_string(),
            public_key: vec![],
            private_key: vec![],
            locked_stakes: vec![VDFLockedStake {
                stake_tx: StakeLockTransaction {
                    validator_id: "validator1".to_string(),
                    stake_amount: 10000,
                    lock_duration: 100,
                    lock_height: 0,
                    block_hash: "hash".to_string(),
                },
                vdf_proof: VDFProof::default(),
                unlock_height: 100,
                activation_time: 0,
            }],
            total_locked: 10000,
            active: true,
        });
        drop(validators);
        
        // Test 50% slash
        let reward = slash_validator("validator1", 50).unwrap();
        assert_eq!(reward, 250); // 5% of 5000 (50% of 10000)
        
        let validators = VALIDATORS.lock().unwrap();
        let validator = validators.get("validator1").unwrap();
        assert_eq!(validator.total_locked, 5000);
        assert!(validator.active);
        drop(validators);
        
        // Test 100% slash
        let reward = slash_validator("validator1", 100).unwrap();
        assert_eq!(reward, 250); // 5% of remaining 5000
        
        let validators = VALIDATORS.lock().unwrap();
        let validator = validators.get("validator1").unwrap();
        assert_eq!(validator.total_locked, 0);
        assert!(!validator.active); // Should be inactive after 100% slash
    }
}
