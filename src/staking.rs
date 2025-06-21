// src/staking.rs

use crate::lib::{StakeLockTransaction, VDFLockedStake, Validator};
use crate::lib::{PENDING_STAKES, VALIDATORS};
use crate::vdf::{VDF, VDFProof};
use js_sys::Date;
use std::collections::HashMap;

/// Returns a **cloned** map of all active validators (ID → Validator).
pub fn current_validators() -> HashMap<String, Validator> {
    VALIDATORS
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, v)| v.active)
        .map(|(id, v)| (id.clone(), v.clone()))
        .collect()
}

/// Compute 2/3 +1 quorum threshold of total *active* stake.
pub fn quorum_threshold() -> u64 {
    let total_active: u64 = current_validators()
        .values()
        .map(|v| v.total_locked)
        .sum();
    // ⅔ of total, rounded up:
    (total_active * 2 + 2) / 3
}

/// Lock new stake: moves a pending `StakeLockTransaction` through VDF into an active `Validator`.
pub fn activate_stake(validator_id: &str, iterations: u64) -> Result<(), String> {
    // 1) Pull pending stake
    let stake_tx = {
        let mut pending = PENDING_STAKES.lock().unwrap();
        pending
            .remove(validator_id)
            .ok_or_else(|| "No pending stake for this validator".to_string())?
    };
    // 2) Build VDF input
    let input = format!(
        "{}:{}:{}:{}",
        stake_tx.validator_id,
        stake_tx.stake_amount,
        stake_tx.lock_duration,
        stake_tx.block_hash
    );
    // 3) Run VDF
    let vdf = VDF::new(2048).map_err(|e| format!("VDF init error: {:?}", e))?;
    let proof: VDFProof = vdf
        .compute_with_proof(input.as_bytes(), iterations)
        .map_err(|e| format!("VDF compute error: {:?}", e))?;
    // 4) Create locked stake record
    let now = Date::now() as u64;
    let locked = VDFLockedStake {
        stake_tx: stake_tx.clone(),
        vdf_proof: proof.clone(),
        unlock_height: stake_tx.lock_height + stake_tx.lock_duration,
        activation_time: now,
    };
    // 5) Insert into validators (or new)
    let mut vals = VALIDATORS.lock().unwrap();
    let entry = vals.entry(validator_id.to_string()).or_insert_with(|| Validator {
        id: validator_id.to_string(),
        locked_stakes: vec![],
        total_locked: 0,
        active: true,
    });
    entry.locked_stakes.push(locked);
    entry.total_locked += stake_tx.stake_amount;
    Ok(())
}

/// Prune expired stakes at the current block height.
pub fn prune_expired_stakes(current_height: u64) {
    let mut vals = VALIDATORS.lock().unwrap();
    for (_id, v) in vals.iter_mut() {
        v.locked_stakes
            .retain(|s| s.unlock_height > current_height);
        v.total_locked = v.locked_stakes.iter().map(|s| s.stake_tx.stake_amount).sum();
        if v.total_locked == 0 {
            v.active = false;
        }
    }
}

pub fn calculate_time_weighted_stake(stake: &VDFLockedStake) -> u64 {
    let weight_factor = 1.0 + (stake.stake_tx.lock_duration as f64 / 365.0);
    (stake.stake_tx.stake_amount as f64 * weight_factor) as u64
}


/// Allows a validator to unstake early, burning a portion of their stake.
/// Returns the amount of stake that was burned.
pub fn unstake_early(validator_id: &str, stake_commitment_hash: &str, current_height: u64) -> Result<u64, String> {
    let mut vals = VALIDATORS.lock().unwrap();
    let validator = vals.get_mut(validator_id)
        .ok_or_else(|| "Validator not found".to_string())?;

    // Find the specific stake to remove
    let stake_index = validator.locked_stakes.iter().position(|s| {
        // A unique identifier for a stake would be ideal, here we use a hash of its data
        let mut hasher = sha2::Sha256::new();
        hasher.update(s.stake_tx.block_hash.as_bytes());
        hasher.update(&s.stake_tx.stake_amount.to_le_bytes());
        hex::encode(hasher.finalize()) == stake_commitment_hash
    }).ok_or_else(|| "Specific stake lock not found for this validator".to_string())?;

    let stake = &validator.locked_stakes[stake_index];

    // Ensure it's not already expired
    if current_height >= stake.unlock_height {
        return Err("Cannot early-unstake an expired lock. It should be pruned automatically.".to_string());
    }

    // Calculate penalty based on whitepaper formula (Definition 10)
    let total_duration = stake.stake_tx.lock_duration;
    let served_duration = current_height.saturating_sub(stake.stake_tx.lock_height);
    let max_penalty_rate = 0.50; // 50% max penalty rate from paper

    let time_remaining_ratio = 1.0 - (served_duration as f64 / total_duration as f64);
    let penalty_rate = time_remaining_ratio * max_penalty_rate;

    let staked_amount = stake.stake_tx.stake_amount;
    let burn_penalty = (staked_amount as f64 * penalty_rate) as u64;

    // The amount to be returned to the user (this would require a transaction)
    let return_amount = staked_amount - burn_penalty;

    // Remove the stake and update validator's total
    validator.locked_stakes.remove(stake_index);
    validator.total_locked = validator.total_locked.saturating_sub(staked_amount);

    log(&format!(
        "[STAKING] Early unstake for {}. Original: {}, Returned: {}, Burned: {}",
        validator_id, staked_amount, return_amount, burn_penalty
    ));

    // For now, we just burn the funds. Returning them would require a new transaction type.
    // The burned amount is effectively removed from the total supply.
    Ok(burn_penalty)
}
