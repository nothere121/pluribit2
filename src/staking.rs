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
