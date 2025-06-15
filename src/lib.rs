use wasm_bindgen::prelude::*;
use serde_wasm_bindgen;
use lazy_static::lazy_static;
use std::sync::Mutex;
use std::collections::HashMap;
use serde_json;
use sha2::{Sha256, Digest};
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::Identity;  
use bulletproofs::RangeProof;
use serde::Serialize;
use serde::Deserialize;

use crate::consensus_manager::{ConsensusManager, ConsensusPhase};
use crate::vdf::{VDF, VDFProof, compute_vdf_proof};
use crate::transaction::{Transaction, TransactionInput, TransactionOutput, TransactionKernel};
use crate::block::Block; 


pub mod constants;
pub mod error;
pub mod utils;
pub mod vdf;
pub mod mimblewimble;
pub mod transaction;
pub mod block;
pub mod blockchain;
pub mod vdf_clock;
pub mod consensus_manager;
pub mod slashing;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StakeLockTransaction {
    pub validator_id: String,
    pub stake_amount: u64,
    pub lock_duration: u64,
    pub lock_height: u64,
    pub block_hash: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VDFLockedStake {
    pub stake_tx: StakeLockTransaction,
    pub vdf_proof: VDFProof,
    pub unlock_height: u64,
    pub activation_time: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Validator {
    pub id: String,
    pub public_key: Vec<u8>, 
    pub locked_stakes: Vec<VDFLockedStake>,
    pub total_locked: u64,
    pub active: bool,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UTXO {
    pub commitment: Vec<u8>,
    pub range_proof: Vec<u8>,
    pub block_height: u64,
    pub index: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TransactionPool {
    pub pending: Vec<transaction::Transaction>,
    pub fee_total: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WalletOutput {
    pub value: u64,
    pub blinding_factor: Vec<u8>,
    pub commitment: Vec<u8>,
    pub spent: bool,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WalletIdentity {
    pub private_key: Vec<u8>,  // 32 bytes - Scalar
    pub public_key: Vec<u8>,   // 32 bytes - Compressed RistrettoPoint
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WalletData {
    pub version: u32,
    pub identity: WalletIdentity,
    pub outputs: Vec<WalletOutput>,
    pub created_at: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VoteData {
    pub block_hash: String,
    pub stake_amount: u64,
    pub vdf_proof: VDFProof,
    pub signature: Vec<u8>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UTXOSnapshot {
    pub height: u64,
    pub prev_block_hash: String,
    pub utxos: Vec<(Vec<u8>, TransactionOutput)>,
    pub timestamp: u64,
    pub merkle_root: [u8; 32],
    pub total_kernels: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactBlockData {
    pub height: u64,
    pub hash: String,
    pub prev_hash: String,
    pub timestamp: u64,
    pub aggregated_kernel: TransactionKernel,
    pub spent_commitments: Vec<Vec<u8>>,
    pub new_outputs: Vec<TransactionOutput>,
}

lazy_static! {
    static ref BLOCKCHAIN: Mutex<blockchain::Blockchain> = Mutex::new(blockchain::Blockchain::new());
    static ref VDF_CLOCK: Mutex<vdf_clock::VDFClock> = Mutex::new(vdf_clock::VDFClock::new(10));
    static ref CONSENSUS_MANAGER: Mutex<ConsensusManager> = Mutex::new(ConsensusManager::new());
    static ref VALIDATORS: Mutex<HashMap<String, Validator>> = Mutex::new(HashMap::new());
    static ref PENDING_STAKES: Mutex<HashMap<String, StakeLockTransaction>> = Mutex::new(HashMap::new());
    static ref BLOCK_VOTES: Mutex<HashMap<u64, HashMap<String, VoteData>>> = Mutex::new(HashMap::new());
    static ref UTXO_SET: Mutex<HashMap<Vec<u8>, UTXO>> = Mutex::new(HashMap::new());
    static ref TX_POOL: Mutex<TransactionPool> = Mutex::new(TransactionPool {
        pending: Vec::new(),
        fee_total: 0,
    });
    static ref WALLET_OUTPUTS: Mutex<HashMap<String, Vec<WalletOutput>>> = Mutex::new(HashMap::new());
    static ref WALLET_IDENTITIES: Mutex<HashMap<String, WalletIdentity>> = Mutex::new(HashMap::new());
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}



#[wasm_bindgen]
pub fn greet(name: &str) -> String {
    log(&format!("RUST: Hello from Rust, {}!", name));
    format!("Hello, {}! This is Rust speaking from Wasm.", name)
}

/// Computes a VDF proof.
/// Takes an input string (which will be hashed) and the number of iterations.
/// Returns the VDFProof struct serialized as a JsValue, or a JsValue error.
#[wasm_bindgen]
pub fn perform_vdf_computation(input_str: String, iterations: u64) -> Result<JsValue, JsValue> {
    log(&format!("[RUST] Starting VDF computation. Input: '{}', Iterations: {}", input_str, iterations));

    // 1. Create a VDF instance.
    //    Your VDF::new() takes a dummy _bit_length.
    //    It returns BitQuillResult<VDF>.
    let vdf_instance = match VDF::new(2048) {
        Ok(instance) => instance,
        Err(e) => {
            let err_msg = format!("[RUST_ERROR] Failed to initialize VDF: {:?}", e);
            log(&err_msg);
            return Err(JsValue::from_str(&err_msg));
        }
    };
    log("[RUST] VDF instance created.");

    // 2. Prepare input bytes
    let input_bytes = input_str.as_bytes();

    // 3. Call compute_with_proof
    //    This is a method on your VDF struct.
    log(&format!("[RUST] Calling vdf_instance.compute_with_proof for {} iterations...", iterations));
    match vdf_instance.compute_with_proof(input_bytes, iterations) {
        Ok(proof_data) => {
            log("[RUST] VDF computation successful. Serializing proof...");
            // Serialize the VDFProof struct to JsValue
            match serde_wasm_bindgen::to_value(&proof_data) {
                Ok(js_proof) => {
                    log("[RUST] Proof serialized to JsValue successfully.");
                    Ok(js_proof)
                }
                Err(e_serde) => {
                    let err_msg = format!("[RUST_ERROR] Failed to serialize VDFProof to JsValue: {}", e_serde);
                    log(&err_msg);
                    Err(JsValue::from_str(&err_msg))
                }
            }
        }
        Err(e_vdf) => {
            let err_msg = format!("[RUST_ERROR] VDF computation failed: {:?}", e_vdf);
            log(&err_msg);
            Err(JsValue::from_str(&err_msg))
        }
    }
}

/// Verifies a VDF proof.
/// Takes an input string, the VDFProof (as JsValue),
/// Returns true if valid, false otherwise, or a JsValue error.
#[wasm_bindgen]
pub fn verify_vdf_proof(input_str: String, proof_js: JsValue) -> Result<bool, JsValue> {
    log(&format!("[RUST] Starting VDF verification. Input: '{}'", input_str));

    // 1. Create a VDF instance
    let vdf_instance = match VDF::new(2048) {
        Ok(instance) => instance,
        Err(e) => {
            let err_msg = format!("[RUST_ERROR] Failed to initialize VDF for verification: {:?}", e);
            log(&err_msg);
            return Err(JsValue::from_str(&err_msg));
        }
    };
    log("[RUST] VDF instance for verification created.");

    // 2. Deserialize VDFProof from JsValue
    let proof_data: VDFProof = match serde_wasm_bindgen::from_value(proof_js) {
        Ok(data) => data,
        Err(e_serde) => {
            let err_msg = format!("[RUST_ERROR] Failed to deserialize VDFProof from JsValue: {}", e_serde);
            log(&err_msg);
            return Err(JsValue::from_str(&err_msg));
        }
    };
    log("[RUST] VDFProof deserialized from JsValue successfully.");

    // 3. Prepare input bytes
    let input_bytes = input_str.as_bytes();

    // 4. Call verify
    log("[RUST] Calling vdf_instance.verify...");
    match vdf_instance.verify(input_bytes, &proof_data) {
        Ok(is_valid) => {
            log(&format!("[RUST] VDF verification result: {}", is_valid));
            Ok(is_valid)
        }
        Err(e_vdf) => {
            let err_msg = format!("[RUST_ERROR] VDF verification failed: {:?}", e_vdf);
            log(&err_msg);
            Err(JsValue::from_str(&err_msg))
        }
    }
}




#[wasm_bindgen]
pub fn create_genesis_block() -> Result<JsValue, JsValue> {
    let genesis = block::Block::genesis();
    log(&format!("[RUST] Genesis block created with hash: {}", genesis.hash()));
    serde_wasm_bindgen::to_value(&genesis)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}





#[wasm_bindgen]
pub fn init_vdf_clock(ticks_per_block: u64) -> Result<JsValue, JsValue> {
    let mut clock = VDF_CLOCK.lock().unwrap();
    *clock = vdf_clock::VDFClock::new(ticks_per_block);
    log(&format!("[RUST] VDF clock initialized with {} ticks per block", ticks_per_block));

    serde_wasm_bindgen::to_value(&*clock)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn tick_vdf_clock() -> Result<JsValue, JsValue> {
    let mut clock = VDF_CLOCK.lock().unwrap();
    let vdf = VDF::new(2048)
        .map_err(|e| JsValue::from_str(&format!("Failed to create VDF: {:?}", e)))?;

    clock.tick(&vdf)
        .map_err(|e| JsValue::from_str(&format!("Failed to tick clock: {:?}", e)))?;
    log(&format!("[RUST] VDF clock ticked to {}", clock.current_tick));

    serde_wasm_bindgen::to_value(&*clock)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn get_vdf_clock_state() -> Result<JsValue, JsValue> {
    let clock = VDF_CLOCK.lock().unwrap();
    serde_wasm_bindgen::to_value(&*clock)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn check_block_submission(block_height: u64) -> Result<JsValue, JsValue> {
    let clock = VDF_CLOCK.lock().unwrap();
    let can_submit = clock.can_submit_block(block_height);
    let required_tick = block_height * clock.ticks_per_block;

    log(&format!(
        "[RUST] Block {} submission check: {} (current tick: {}, required: {})",
        block_height, can_submit, clock.current_tick, required_tick
    ));

    #[derive(serde::Serialize)]
    struct SubmissionStatus {
        can_submit: bool,
        current_tick: u64,
        required_tick: u64,
        ticks_remaining: i64,
    }

    let status = SubmissionStatus {
        can_submit,
        current_tick: clock.current_tick,
        required_tick,
        ticks_remaining: (required_tick as i64 - clock.current_tick as i64),
    };

    serde_wasm_bindgen::to_value(&status)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}



#[wasm_bindgen]
pub fn compute_block_hash(block_json: JsValue) -> Result<String, JsValue> {
    let block: block::Block = serde_wasm_bindgen::from_value(block_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize block: {}", e)))?;

    Ok(block.hash())
}
#[wasm_bindgen]
pub fn init_blockchain() -> Result<JsValue, JsValue> {
    let mut chain = BLOCKCHAIN.lock().unwrap();
    *chain = blockchain::Blockchain::new();
    log("[RUST] Blockchain initialized with genesis block");

    serde_wasm_bindgen::to_value(&*chain)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn add_block_to_chain(block_json: JsValue) -> Result<JsValue, JsValue> {
    let block: block::Block = serde_wasm_bindgen::from_value(block_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize block: {}", e)))?;

    let mut chain = BLOCKCHAIN.lock().unwrap();
    chain.add_block(block.clone())
        .map_err(|e| JsValue::from_str(&format!("Failed to add block: {}", e)))?;

    log(&format!("[RUST] Block added to chain. New height: {}", chain.current_height));

    serde_wasm_bindgen::to_value(&*chain)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn get_blockchain_state() -> Result<JsValue, JsValue> {
    let chain = BLOCKCHAIN.lock().unwrap();
    serde_wasm_bindgen::to_value(&*chain)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn get_latest_block_hash() -> Result<String, JsValue> {
    let chain = BLOCKCHAIN.lock().unwrap();
    Ok(chain.get_latest_block().hash())
}

#[wasm_bindgen]
pub fn consensus_tick() -> Result<JsValue, JsValue> {
    let mut manager = CONSENSUS_MANAGER.lock().unwrap();
    let result = manager.tick();
    
    serde_wasm_bindgen::to_value(&result)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn submit_pow_candidate(block_js: JsValue) -> Result<(), JsValue> {
    let block: Block = serde_wasm_bindgen::from_value(block_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize block: {}", e)))?;

    let mut manager = CONSENSUS_MANAGER.lock().unwrap();

    match manager.current_phase {
        ConsensusPhase::Mining => {
            // Check VDF timing
            let clock = VDF_CLOCK.lock().unwrap();
            if !clock.can_submit_block(block.height) {
                let required_tick = block.height * clock.ticks_per_block;
                return Err(JsValue::from_str(&format!(
                    "Cannot submit block yet. Current tick: {}, Required: {}",
                    clock.current_tick, required_tick
                )));
            }

            // Check if this block is better than current candidate
            if let Some(ref current_best) = manager.best_candidate_block {
                // For PoW: Lower hash = more work done = better block
                let block_hash = block.hash();
                let current_best_hash = current_best.hash();
                
                // Compare hashes lexicographically (as hex strings)
                // Lower hash value = more leading zeros = more work
                if block_hash > current_best_hash {
                    log(&format!("[RUST] Rejected candidate block - higher hash {} > {} (less work) than current best", 
                        &block_hash[..8], &current_best_hash[..8]));
                    return Ok(());
                }
                
                // If hashes are somehow equal (extremely unlikely), use timestamp as tiebreaker
                if block_hash == current_best_hash && block.timestamp > current_best.timestamp {
                    log("[RUST] Rejected candidate block - same hash but later timestamp");
                    return Ok(());
                }
            }

            // Log acceptance
            log(&format!("[RUST] Accepted new candidate block with hash {}", &block.hash()[..8]));

            manager.best_candidate_block = Some(block);
            log("[RUST] Accepted new candidate block.");
        }
        ConsensusPhase::Validation => {
            return Err(JsValue::from_str("Cannot submit block during validation phase"));
        }
    }

    Ok(())
}

#[wasm_bindgen]
pub fn get_block_with_hash(block_json: JsValue) -> Result<JsValue, JsValue> {
    let block: block::Block = serde_wasm_bindgen::from_value(block_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize block: {}", e)))?;

    // Create a struct that includes the hash
    #[derive(serde::Serialize)]
    struct BlockWithHash {
        #[serde(flatten)]
        block: block::Block,
        hash: String,
    }

    let block_with_hash = BlockWithHash {
        hash: block.hash(),
        block,
    };

    serde_wasm_bindgen::to_value(&block_with_hash)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn get_blockchain_with_hashes() -> Result<JsValue, JsValue> {
    let chain = BLOCKCHAIN.lock().unwrap();

    #[derive(serde::Serialize)]
    struct BlockWithHash {
        height: u64,
        prev_hash: String,
        timestamp: u64,
        nonce: u64,
        miner_id: String,
        difficulty: u8,
        hash: String,
    }

    let blocks_with_hashes: Vec<BlockWithHash> = chain.blocks.iter().map(|block| {
        BlockWithHash {
            height: block.height,
            prev_hash: block.prev_hash.clone(),
            timestamp: block.timestamp,
            nonce: block.nonce,
            miner_id: block.miner_id.clone(),
            difficulty: block.difficulty,
            hash: block.hash(),
        }
    }).collect();

    #[derive(serde::Serialize)]
    struct ChainWithHashes {
        blocks: Vec<BlockWithHash>,
        current_height: u64,
    }

    let result = ChainWithHashes {
        blocks: blocks_with_hashes,
        current_height: chain.current_height,
    };

    serde_wasm_bindgen::to_value(&result)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

// Create stake lock transaction
#[wasm_bindgen]
pub fn create_stake_lock(validator_id: String, stake_amount: u64, lock_duration: u64) -> Result<JsValue, JsValue> {
    if stake_amount < 100 {
        return Err(JsValue::from_str("Minimum stake is 100"));
    }

    if lock_duration < 1 || lock_duration > 365 {
        return Err(JsValue::from_str("Lock duration must be between 1 and 365 blocks"));
    }

    let chain = BLOCKCHAIN.lock().unwrap();
    let current_height = chain.current_height;
    let current_block_hash = chain.blocks.last()
        .map(|b| b.hash())
        .unwrap_or_else(|| "genesis".to_string());

    let stake_tx = StakeLockTransaction {
        validator_id: validator_id.clone(),
        stake_amount,
        lock_duration,
        lock_height: current_height,
        block_hash: current_block_hash,
    };

    // Store pending stake
    let mut pending = PENDING_STAKES.lock().unwrap();
    pending.insert(validator_id.clone(), stake_tx.clone());

    log(&format!("[RUST] Created stake lock for {} - amount: {}, duration: {} blocks",
        validator_id, stake_amount, lock_duration));

    serde_wasm_bindgen::to_value(&stake_tx)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

// Compute VDF for stake lock
#[wasm_bindgen]
pub fn compute_stake_vdf(validator_id: String) -> Result<JsValue, JsValue> {
    let pending = PENDING_STAKES.lock().unwrap();
    let stake_tx = pending.get(&validator_id)
        .ok_or_else(|| JsValue::from_str("No pending stake found"))?;

    // VDF input includes the stake transaction and block hash (chain-specific!)
    let vdf_input = format!("{}:{}:{}:{}",
        stake_tx.validator_id,
        stake_tx.stake_amount,
        stake_tx.lock_duration,
        stake_tx.block_hash  // This makes it chain-specific!
    );

    // Calculate required VDF iterations based on lock duration
    // T = lock_duration * ticks_per_block * squarings_per_tick
    let clock = VDF_CLOCK.lock().unwrap();
    let iterations = stake_tx.lock_duration * clock.ticks_per_block * 10; //1000; // 1000 squarings per tick

    log(&format!("[RUST] Computing VDF for stake lock: {} iterations", iterations));

    // Use your existing VDF implementation
    let vdf = VDF::new(2048).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let vdf_proof = compute_vdf_proof(vdf_input.as_bytes(), iterations, &vdf.modulus)
        .map_err(|e| JsValue::from_str(&e))?;

    #[derive(serde::Serialize)]
    struct VDFComputeResult {
        stake_tx: StakeLockTransaction,
        vdf_proof: VDFProof,
        iterations: u64,
    }

    let result = VDFComputeResult {
        stake_tx: stake_tx.clone(),
        vdf_proof,
        iterations,
    };

    serde_wasm_bindgen::to_value(&result)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

// Activate stake with VDF proof
#[wasm_bindgen]
pub fn activate_stake_with_vdf(validator_id: String, vdf_proof_js: JsValue) -> Result<(), JsValue> {
    let vdf_result: serde_json::Value = serde_wasm_bindgen::from_value(vdf_proof_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse VDF result: {}", e)))?;

    // Extract components
    let stake_tx: StakeLockTransaction = serde_json::from_value(vdf_result["stake_tx"].clone())
        .map_err(|e| JsValue::from_str(&format!("Invalid stake_tx: {}", e)))?;
    let vdf_proof: VDFProof = serde_json::from_value(vdf_result["vdf_proof"].clone())
        .map_err(|e| JsValue::from_str(&format!("Invalid vdf_proof: {}", e)))?;

    // Verify the VDF proof
    let vdf_input = format!("{}:{}:{}:{}",
        stake_tx.validator_id,
        stake_tx.stake_amount,
        stake_tx.lock_duration,
        stake_tx.block_hash
    );

    let vdf = VDF::new(2048).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let is_valid = vdf.verify(vdf_input.as_bytes(), &vdf_proof)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    if !is_valid {
        return Err(JsValue::from_str("Invalid VDF proof"));
    }
    
    // Get validator's public key from identity store
    let identities = WALLET_IDENTITIES.lock().unwrap();
    let identity = identities.get(&validator_id)
        .ok_or_else(|| JsValue::from_str("Validator identity not found"))?;
    let public_key = identity.public_key.clone();
    drop(identities);

    // Create locked stake
    let locked_stake = VDFLockedStake {
        stake_tx: stake_tx.clone(),
        vdf_proof,
        unlock_height: stake_tx.lock_height + stake_tx.lock_duration,
        activation_time: js_sys::Date::now() as u64,
    };

    // Add to validators with public key
    let mut validators = VALIDATORS.lock().unwrap();
    let validator = validators.entry(validator_id.clone()).or_insert(Validator {
        id: validator_id.clone(),
        public_key,  // Use the identity public key
        locked_stakes: Vec::new(),
        total_locked: 0,
        active: true,
    });

    validator.locked_stakes.push(locked_stake);
    validator.total_locked += stake_tx.stake_amount;

    // Remove from pending
    let mut pending = PENDING_STAKES.lock().unwrap();
    pending.remove(&validator_id);

    log(&format!("[RUST] Activated VDF-locked stake for {} - amount: {}",
        validator_id, stake_tx.stake_amount));

    Ok(())
}

// Vote for a block (only with active VDF-locked stake)
#[wasm_bindgen]
pub fn vote_for_block(validator_id: String) -> Result<JsValue, JsValue> {
    use curve25519_dalek::scalar::Scalar;
    
    let validators = VALIDATORS.lock().unwrap();
    let chain = BLOCKCHAIN.lock().unwrap();
    let manager = CONSENSUS_MANAGER.lock().unwrap();

    // Check if validator exists and has active stake
    let validator = validators.get(&validator_id)
        .ok_or_else(|| JsValue::from_str("Validator not found"))?;

    if !validator.active || validator.total_locked == 0 {
        return Err(JsValue::from_str("Validator has no active locked stake"));
    }

    // Check current height and remove expired stakes
    let current_height = chain.current_height;
    let active_stake: u64 = validator.locked_stakes.iter()
        .filter(|stake| current_height <= stake.unlock_height)
        .map(|stake| stake.stake_tx.stake_amount)
        .sum();

    if active_stake == 0 {
        return Err(JsValue::from_str("All stakes have expired"));
    }
    
    log(&format!("[RUST] Validator {} attempting to vote in phase: {:?}", 
        validator_id, manager.current_phase));
    
    // Check if we're in validation phase
    match manager.current_phase {
        ConsensusPhase::Validation => {
            if let Some(ref candidate) = manager.best_candidate_block {
                log(&format!("[RUST] Found candidate block {} to vote for", candidate.height));

                // Drop locks before VDF computation
                let candidate_hash = candidate.hash();
                let candidate_height = candidate.height;
                drop(validators);
                drop(chain);
                drop(manager);
                
                // Get validator's private key
                let identities = WALLET_IDENTITIES.lock().unwrap();
                let identity = identities.get(&validator_id)
                    .ok_or_else(|| JsValue::from_str("Validator identity not found"))?;
                let private_key_bytes = identity.private_key.clone();
                drop(identities);
                
                // Convert private key bytes to Scalar
                let mut key_array = [0u8; 32];
                key_array.copy_from_slice(&private_key_bytes);
                let private_key = Scalar::from_bytes_mod_order(key_array);
                
                // Compute voting VDF (calibrated for ~4 minutes)
                log(&format!("[RUST] Computing voting VDF for validator {}", validator_id));
                let vote_input = format!("{}||{}", validator_id, candidate_hash);
                let vote_iterations = 10_000; //240 * 100_000; // 24,000,000 iterations for ~4 minutes
                
                let vdf = VDF::new(2048).map_err(|e| JsValue::from_str(&e.to_string()))?;
                let start_time = js_sys::Date::now();
                let vote_vdf_proof = compute_vdf_proof(vote_input.as_bytes(), vote_iterations, &vdf.modulus)
                    .map_err(|e| JsValue::from_str(&e))?;
                let compute_time = js_sys::Date::now() - start_time;
                log(&format!("[RUST] VDF computation took {}ms", compute_time));
                
                // Create vote message
                let vote_message = format!("vote:{}:{}:{}", 
                    candidate_height, 
                    candidate_hash, 
                    active_stake
                );
                
                // Create proper Schnorr signature
                let message_hash = Sha256::digest(vote_message.as_bytes());
                let mut hash_array = [0u8; 32];
                hash_array.copy_from_slice(&message_hash);
                
                let (challenge, s) = mimblewimble::create_schnorr_signature(hash_array, &private_key)
                    .map_err(|e| JsValue::from_str(&format!("Failed to create signature: {:?}", e)))?;
                
                // Serialize signature
                let mut signature = Vec::with_capacity(64);
                signature.extend_from_slice(&challenge.to_bytes());
                signature.extend_from_slice(&s.to_bytes());
                
                // Record vote with VDF proof
                let mut votes = BLOCK_VOTES.lock().unwrap();
                let height_votes = votes.entry(candidate_height).or_insert_with(HashMap::new);
                
                let vote_data = VoteData {
                    block_hash: candidate_hash.clone(),
                    stake_amount: active_stake,
                    vdf_proof: vote_vdf_proof.clone(),
                    signature,
                    timestamp: js_sys::Date::now() as u64,
                };
                
                height_votes.insert(validator_id.clone(), vote_data);
                
                log(&format!("[RUST] Validator {} voted for block {} with {} stake",
                    validator_id, candidate_height, active_stake));

                #[derive(serde::Serialize)]
                struct VoteResult {
                    validator_id: String,
                    block_height: u64,
                    block_hash: String,
                    stake_amount: u64,
                    vdf_proof: VDFProof,
                    compute_time_ms: f64,
                }

                let result = VoteResult {
                    validator_id,
                    block_height: candidate_height,
                    block_hash: candidate_hash,
                    stake_amount: active_stake,
                    vdf_proof: vote_vdf_proof,
                    compute_time_ms: compute_time,
                };

                serde_wasm_bindgen::to_value(&result)
                    .map_err(|e| JsValue::from_str(&e.to_string()))
            } else {
                Err(JsValue::from_str("No candidate block to vote for"))
            }
        },
        _ => Err(JsValue::from_str("Can only vote during validation phase"))
    }
}

#[wasm_bindgen]
pub fn verify_validator_vote(
    validator_id: String,
    block_height: u64,
    block_hash: String,
    stake_amount: u64,
    signature_bytes: Vec<u8>,
) -> Result<bool, JsValue> {
    use curve25519_dalek::scalar::Scalar;
    use curve25519_dalek::ristretto::CompressedRistretto;
    
    // Get validator's public key
    let validators = VALIDATORS.lock().unwrap();
    let validator = validators.get(&validator_id)
        .ok_or_else(|| JsValue::from_str("Validator not found"))?;
    let public_key_bytes = validator.public_key.clone();
    drop(validators);
    
    // Parse public key
    let public_key_compressed = CompressedRistretto::from_slice(&public_key_bytes)
        .map_err(|_| JsValue::from_str("Invalid public key format"))?;
    let public_key = public_key_compressed.decompress()
        .ok_or_else(|| JsValue::from_str("Failed to decompress public key"))?;
    
    // Parse signature
    if signature_bytes.len() != 64 {
        return Err(JsValue::from_str("Invalid signature length"));
    }
    
    let mut challenge_bytes = [0u8; 32];
    challenge_bytes.copy_from_slice(&signature_bytes[0..32]);
    let challenge = Scalar::from_bytes_mod_order(challenge_bytes);
    
    let mut s_bytes = [0u8; 32];
    s_bytes.copy_from_slice(&signature_bytes[32..64]);
    let s = Scalar::from_bytes_mod_order(s_bytes);
    
    // Recreate vote message
    let vote_message = format!("vote:{}:{}:{}", block_height, block_hash, stake_amount);
    let message_hash = Sha256::digest(vote_message.as_bytes());
    let mut hash_array = [0u8; 32];
    hash_array.copy_from_slice(&message_hash);
    
    // Verify signature
    let is_valid = mimblewimble::verify_schnorr_signature(&(challenge, s), hash_array, &public_key);
    
    Ok(is_valid)
}

// Get validator info
#[wasm_bindgen]
pub fn get_validators() -> Result<JsValue, JsValue> {
    let validators = VALIDATORS.lock().unwrap();
    let chain = BLOCKCHAIN.lock().unwrap();
    let current_height = chain.current_height;

    #[derive(serde::Serialize)]
    struct ValidatorInfo {
        id: String,
        total_locked: u64,
        active_stake: u64,
        num_locks: usize,
    }

    let validator_list: Vec<ValidatorInfo> = validators.values().map(|v| {
        let active_stake: u64 = v.locked_stakes.iter()
            .filter(|stake| current_height <= stake.unlock_height)
            .map(|stake| stake.stake_tx.stake_amount)
            .sum();

        ValidatorInfo {
            id: v.id.clone(),
            total_locked: v.total_locked,
            active_stake,
            num_locks: v.locked_stakes.len(),
        }
    }).collect();

    // CORRECTED TYPO HERE
    serde_wasm_bindgen::to_value(&validator_list)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
// Create a wallet transaction
#[wasm_bindgen]
pub fn create_wallet_transaction(
    from_wallet_id: String,
    to_wallet_id: String,
    amount: u64,
    fee: u64,
) -> Result<JsValue, JsValue> {
    use curve25519_dalek::scalar::Scalar;
    use curve25519_dalek::constants::RISTRETTO_BASEPOINT_TABLE;
    
    log(&format!("[RUST] Creating MW tx: {} -> {} for {} (fee: {})", from_wallet_id, to_wallet_id, amount, fee));
    
    let mut wallets = WALLET_OUTPUTS.lock().unwrap();

    // First, collect all the data we need from sender_outputs
    let (selected_indices, inputs_for_tx, input_blinding_factors, total_available) = {
        let sender_outputs = wallets.get(&from_wallet_id)
            .ok_or_else(|| JsValue::from_str("Sender wallet not found"))?;

        let total_needed = amount + fee;
        let mut selected_indices = Vec::new();
        let mut inputs_for_tx = Vec::new();
        let mut input_blinding_factors: Vec<Scalar> = Vec::new();
        let mut total_available = 0;

        for (index, output) in sender_outputs.iter().enumerate() {
            if !output.spent && total_available < total_needed {
                total_available += output.value;
                let blinding = Scalar::from_bytes_mod_order(
                    output.blinding_factor.as_slice().try_into()
                        .map_err(|_| JsValue::from_str("Invalid blinding factor length"))?
                );
                input_blinding_factors.push(blinding);
                inputs_for_tx.push(TransactionInput { commitment: output.commitment.clone() });
                selected_indices.push(index);
            }
        }

        if total_available < total_needed {
            return Err(JsValue::from_str("Insufficient funds."));
        }

        (selected_indices, inputs_for_tx, input_blinding_factors, total_available)
    };

    let mut outputs_for_tx = Vec::new();
    let mut output_blinding_factors: Vec<Scalar> = Vec::new();

    // Create recipient output
    let recipient_blinding = mimblewimble::generate_secret_key();
    let _recipient_commit = mimblewimble::commit(amount, &recipient_blinding)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let (recipient_proof, recipient_commit_compressed) = mimblewimble::create_range_proof(amount, &recipient_blinding)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    outputs_for_tx.push(TransactionOutput {
        commitment: recipient_commit_compressed.to_bytes().to_vec(),
        range_proof: recipient_proof.to_bytes(),
    });
    output_blinding_factors.push(recipient_blinding);
    
    let recipient_wallet_output = WalletOutput {
        value: amount,
        blinding_factor: recipient_blinding.to_bytes().to_vec(),
        commitment: recipient_commit_compressed.to_bytes().to_vec(),
        spent: false,
    };

    // Handle change
    let change_amount = total_available - (amount + fee);
    let mut change_wallet_output: Option<WalletOutput> = None;
    if change_amount > 0 {
        let change_blinding = mimblewimble::generate_secret_key();
        let _change_commit = mimblewimble::commit(change_amount, &change_blinding)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let (change_proof, change_commit_compressed) = mimblewimble::create_range_proof(change_amount, &change_blinding)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        outputs_for_tx.push(TransactionOutput {
            commitment: change_commit_compressed.to_bytes().to_vec(),
            range_proof: change_proof.to_bytes(),
        });
        output_blinding_factors.push(change_blinding);
        
        change_wallet_output = Some(WalletOutput {
            value: change_amount,
            blinding_factor: change_blinding.to_bytes().to_vec(),
            commitment: change_commit_compressed.to_bytes().to_vec(),
            spent: false,
        });
    }

    // Calculate kernel blinding (much simpler with Scalar arithmetic!)
    let sum_outputs: Scalar = output_blinding_factors.iter().sum();
    let sum_inputs: Scalar = input_blinding_factors.iter().sum();
    let kernel_blinding = sum_outputs - sum_inputs;

    // Create kernel
    let excess_pubkey = &kernel_blinding * RISTRETTO_BASEPOINT_TABLE;
    let kernel_message_hash: [u8; 32] = Sha256::digest(format!("fee:{}", fee)).into();
    let (challenge, signature_s) = mimblewimble::create_schnorr_signature(kernel_message_hash, &kernel_blinding)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    // Serialize signature
    let mut signature_bytes = Vec::new();
    signature_bytes.extend_from_slice(&challenge.to_bytes());
    signature_bytes.extend_from_slice(&signature_s.to_bytes());

    let kernel = TransactionKernel {
        excess: excess_pubkey.compress().to_bytes().to_vec(),
        signature: signature_bytes,
        fee,
    };

    let final_tx = Transaction {
        inputs: inputs_for_tx,
        outputs: outputs_for_tx,
        kernel,
    };

    // Now update wallet states
    // Mark selected outputs as spent
    if let Some(sender_outputs) = wallets.get_mut(&from_wallet_id) {
        for &index in &selected_indices {
            sender_outputs[index].spent = true;
        }
        
        // Add change output to sender's wallet
        if let Some(change) = change_wallet_output {
            sender_outputs.push(change);
        }
    }
    
    // Add recipient output
    wallets.entry(to_wallet_id).or_default().push(recipient_wallet_output);
    
    // Add to transaction pool
    let mut pool = TX_POOL.lock().unwrap();
    pool.pending.push(final_tx.clone());
    pool.fee_total += fee;

    log("[RUST] Transaction created and added to pool successfully.");
    serde_wasm_bindgen::to_value(&final_tx).map_err(|e| JsValue::from_str(&e.to_string()))
}


// Initialize wallet with some coins (for testing)
#[wasm_bindgen]
pub fn init_wallet(wallet_id: String, initial_balance: u64) -> Result<(), JsValue> {
    use curve25519_dalek::constants::RISTRETTO_BASEPOINT_TABLE;
    
    // Generate identity key pair
    let identity_private = mimblewimble::generate_secret_key();
    let identity_public = &identity_private * RISTRETTO_BASEPOINT_TABLE;
    
    let wallet_identity = WalletIdentity {
        private_key: identity_private.to_bytes().to_vec(),
        public_key: identity_public.compress().to_bytes().to_vec(),
    };
    
    // Store identity in global map
    let mut identities = WALLET_IDENTITIES.lock().unwrap();
    identities.insert(wallet_id.clone(), wallet_identity.clone());
    drop(identities);
    
    // Create initial UTXO
    let mut wallets = WALLET_OUTPUTS.lock().unwrap();
    let blinding = mimblewimble::generate_secret_key();
    let commitment = mimblewimble::commit(initial_balance, &blinding)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let output = WalletOutput {
        value: initial_balance,
        blinding_factor: blinding.to_bytes().to_vec(),
        commitment: commitment.compress().to_bytes().to_vec(),
        spent: false,
    };

    wallets.insert(wallet_id.clone(), vec![output.clone()]);
    drop(wallets);

    log(&format!("[RUST] Initialized wallet {} with {} coins and identity key", wallet_id, initial_balance));
    Ok(())
}

// Get wallet balance
#[wasm_bindgen]
pub fn get_wallet_balance(wallet_id: String) -> Result<JsValue, JsValue> {
    let wallets = WALLET_OUTPUTS.lock().unwrap();

    let outputs = wallets.get(&wallet_id)
        .ok_or_else(|| JsValue::from_str("Wallet not found"))?;

    let balance: u64 = outputs.iter()
        .filter(|o| !o.spent)
        .map(|o| o.value)
        .sum();

    let spent: u64 = outputs.iter()
        .filter(|o| o.spent)
        .map(|o| o.value)
        .sum();

    #[derive(serde::Serialize)]
    struct WalletInfo {
        wallet_id: String,
        balance: u64,
        spent: u64,
        num_outputs: usize,
    }

    let info = WalletInfo {
        wallet_id,
        balance,
        spent,
        num_outputs: outputs.len(),
    };

    serde_wasm_bindgen::to_value(&info)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

// Get transaction pool
#[wasm_bindgen]
pub fn get_tx_pool() -> Result<JsValue, JsValue> {
    let pool = TX_POOL.lock().unwrap();

    #[derive(serde::Serialize)]
    struct PoolInfo {
        pending_count: usize,
        fee_total: u64,
        transactions: Vec<transaction::Transaction>,
    }

    let info = PoolInfo {
        pending_count: pool.pending.len(),
        fee_total: pool.fee_total,
        transactions: pool.pending.clone(),
    };

    serde_wasm_bindgen::to_value(&info)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn mine_block_with_txs(
    height: u64,
    prev_hash: String,
    miner_id: String,
    difficulty: u8,
    max_attempts: u64,
    vdf_proof_js: JsValue,  // Add this parameter
) -> Result<JsValue, JsValue> {
    log(&format!("[RUST] Starting PoW mining with transactions. Height: {}, Difficulty: {}", height, difficulty));

    // Deserialize the VDF proof
    let vdf_proof: VDFProof = serde_wasm_bindgen::from_value(vdf_proof_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize VDF proof: {}", e)))?;
    
    // Get transactions from pool
    let mut pool = TX_POOL.lock().unwrap();
    let transactions = pool.pending.clone();
    let fee_total = pool.fee_total;

    // Calculate dynamic rewards
    let chain = BLOCKCHAIN.lock().unwrap();
    let last_block = chain.get_latest_block();
    let participation_rate = if let Some(ref finalization) = last_block.finalization_data {
        finalization.total_stake_voted as f64 / finalization.total_stake_active.max(1) as f64
    } else {
        1.0
    };
    drop(chain);

    let total_block_reward = calculate_dynamic_block_reward(difficulty, participation_rate);
    let bonus_portion = if total_block_reward > 50 { total_block_reward - 50 } else { 0 };
    let staker_reward = 50 / 3 + bonus_portion;
    let miner_reward = total_block_reward - staker_reward + fee_total;

    let mut block = Block {
        height,
        prev_hash,
        transactions: transactions.clone(),
        vdf_proof,  // Use the passed VDF proof
        timestamp: js_sys::Date::now() as u64,
        nonce: 0,
        miner_id: miner_id.clone(),
        difficulty,
        finalization_data: None,
    };

    // Apply cut-through before mining
    block.apply_cut_through()
        .map_err(|e| JsValue::from_str(&format!("Cut-through failed: {}", e)))?;
    
    log(&format!("[RUST] After cut-through: {} transactions", block.transactions.len()));

    // Mine the block
    for attempt in 0..max_attempts {
        block.nonce = attempt;
        if block.is_valid_pow() {
            log(&format!("[RUST] Found valid PoW! Nonce: {}, Hash: {}", attempt, block.hash()));

            // Clear transactions from pool
            if !transactions.is_empty() {
                pool.pending.clear();
                pool.fee_total = 0;
            }

            // Create miner reward
            let mut wallets = WALLET_OUTPUTS.lock().unwrap();
            let miner_blinding = mimblewimble::generate_secret_key();
            let miner_commitment = mimblewimble::commit(miner_reward, &miner_blinding)
                .map_err(|e| JsValue::from_str(&e.to_string()))?;

            let miner_coinbase_output = WalletOutput {
                value: miner_reward,
                blinding_factor: miner_blinding.to_bytes().to_vec(),
                commitment: miner_commitment.compress().to_bytes().to_vec(),
                spent: false,
            };

            wallets.entry(miner_id.clone()).or_default().push(miner_coinbase_output);
            
            log(&format!("[RUST] Miner {} earned {} coins", miner_id, miner_reward));

            return serde_wasm_bindgen::to_value(&block)
                .map_err(|e| JsValue::from_str(&e.to_string()));
        }

        if attempt % 10000 == 0 {
            log(&format!("[RUST] Mining attempt {}...", attempt));
        }
    }

    Err(JsValue::from_str("Failed to find valid PoW within attempt limit"))
}


// Helper function to distribute staker rewards
fn calculate_dynamic_block_reward(difficulty: u8, participation_rate: f64) -> u64 {
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

fn distribute_staker_rewards(block_height: u64, total_reward: u64) -> Result<(), JsValue> {
    let _validators = VALIDATORS.lock().unwrap(); // Added underscore to fix warning
    let chain = BLOCKCHAIN.lock().unwrap();
    let _current_height = chain.current_height; // Added underscore to fix warning
    
    // Find the block we're distributing rewards for
    let block = chain.blocks.iter()
        .find(|b| b.height == block_height)
        .ok_or_else(|| JsValue::from_str("Block not found"))?;
    
    if let Some(ref finalization_data) = block.finalization_data {
        let mut wallets = WALLET_OUTPUTS.lock().unwrap();
        
        // Distribute rewards proportionally to voting stake
        for vote in &finalization_data.votes {
            let validator_reward = (total_reward * vote.stake_amount) / finalization_data.total_stake_voted;
            
            if validator_reward > 0 {
                // Create reward output for validator
                let reward_blinding = mimblewimble::generate_secret_key();
                let reward_commitment = mimblewimble::commit(validator_reward, &reward_blinding)
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
                
                let reward_output = WalletOutput {
                    value: validator_reward,
                    blinding_factor: reward_blinding.to_bytes().to_vec(),
                    commitment: reward_commitment.compress().to_bytes().to_vec(),
                    spent: false,
                };
                
                wallets.entry(vote.validator_id.clone()).or_default().push(reward_output);
                
                log(&format!("[RUST] Validator {} earned {} coins for staking {} tokens", 
                    vote.validator_id, validator_reward, vote.stake_amount));
            }
        }
    }
    
    Ok(())
}

#[wasm_bindgen]
pub fn add_transaction_to_pool(tx_json: JsValue) -> Result<(), JsValue> {
    let tx: Transaction = serde_wasm_bindgen::from_value(tx_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize transaction: {}", e)))?;
    
    // Verify transaction signature
    if !tx.verify_signature().unwrap_or(false) {
        return Err(JsValue::from_str("Invalid transaction signature"));
    }
    
    // Verify all range proofs
    for output in &tx.outputs {
        let commitment = CompressedRistretto::from_slice(&output.commitment)
            .map_err(|_| JsValue::from_str("Invalid output commitment"))?;
        
        let proof = RangeProof::from_bytes(&output.range_proof)
            .map_err(|_| JsValue::from_str("Invalid range proof format"))?;
        
        if !mimblewimble::verify_range_proof(&proof, &commitment) {
            return Err(JsValue::from_str("Range proof verification failed"));
        }
    }
    
    // Verify kernel signature
    let excess_point = CompressedRistretto::from_slice(&tx.kernel.excess)
        .map_err(|_| JsValue::from_str("Invalid kernel excess"))?
        .decompress()
        .ok_or_else(|| JsValue::from_str("Failed to decompress kernel excess"))?;
    
    // Parse signature (challenge, s)
    if tx.kernel.signature.len() != 64 {
        return Err(JsValue::from_str("Invalid signature length"));
    }
    
    let challenge = Scalar::from_bytes_mod_order(
        tx.kernel.signature[0..32].try_into()
            .map_err(|_| JsValue::from_str("Invalid challenge bytes"))?
    );
    
    let signature_s = Scalar::from_bytes_mod_order(
        tx.kernel.signature[32..64].try_into()
            .map_err(|_| JsValue::from_str("Invalid signature bytes"))?
    );
    
    let kernel_message_hash: [u8; 32] = Sha256::digest(format!("fee:{}", tx.kernel.fee)).into();
    
    if !mimblewimble::verify_schnorr_signature(&(challenge, signature_s), kernel_message_hash, &excess_point) {
        return Err(JsValue::from_str("Kernel signature verification failed"));
    }
    
    // Verify balance (sum of inputs = sum of outputs + kernel excess)
    let mut input_sum = RistrettoPoint::identity();
    let mut output_sum = RistrettoPoint::identity();
    
    // Sum all input commitments
    for input in &tx.inputs {
        let input_commitment = CompressedRistretto::from_slice(&input.commitment)
            .map_err(|_| JsValue::from_str("Invalid input commitment"))?
            .decompress()
            .ok_or_else(|| JsValue::from_str("Failed to decompress input commitment"))?;
        input_sum += input_commitment;
    }
    
    // Sum all output commitments
    for output in &tx.outputs {
        let output_commitment = CompressedRistretto::from_slice(&output.commitment)
            .map_err(|_| JsValue::from_str("Invalid output commitment"))?
            .decompress()
            .ok_or_else(|| JsValue::from_str("Failed to decompress output commitment"))?;
        output_sum += output_commitment;
    }
    
    // Add kernel excess to output sum
    output_sum += excess_point;
    
    // Verify balance
    if input_sum != output_sum {
        return Err(JsValue::from_str("Transaction doesn't balance"));
    }
    
    // Check UTXO set to ensure inputs exist and aren't double-spent
    let utxo_set = UTXO_SET.lock().unwrap();
    for input in &tx.inputs {
        if !utxo_set.contains_key(&input.commitment) {
            return Err(JsValue::from_str("Input not found in UTXO set"));
        }
    }
    drop(utxo_set);
    
    // Add to pool
    let mut pool = TX_POOL.lock().unwrap();
    
    // Check if transaction already exists (by comparing kernel excess)
    for existing_tx in &pool.pending {
        if existing_tx.kernel.excess == tx.kernel.excess {
            return Err(JsValue::from_str("Transaction already in pool"));
        }
    }
    
    pool.fee_total += tx.kernel.fee;
    pool.pending.push(tx);
    
    log(&format!("[RUST] Added network transaction to pool. Total: {}", pool.pending.len()));
    
    Ok(())
}

#[wasm_bindgen]
pub fn verify_transaction(tx_json: JsValue) -> Result<bool, JsValue> {
    // Use add_transaction_to_pool logic but return bool instead of error
    match add_transaction_to_pool(tx_json) {
        Ok(_) => {
            // Remove from pool since we're just verifying
            let mut pool = TX_POOL.lock().unwrap();
            pool.pending.pop();
            pool.fee_total -= pool.pending.last().map(|tx| tx.kernel.fee).unwrap_or(0);
            Ok(true)
        },
        Err(_) => Ok(false)
    }
}

#[wasm_bindgen]
pub fn clear_transaction_pool() -> Result<(), JsValue> {
    let mut pool = TX_POOL.lock().unwrap();
    pool.pending.clear();
    pool.fee_total = 0;
    log("[RUST] Transaction pool cleared");
    Ok(())
}

#[wasm_bindgen]
pub fn get_transaction_hash(tx_json: JsValue) -> Result<String, JsValue> {
    let tx: Transaction = serde_wasm_bindgen::from_value(tx_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize transaction: {}", e)))?;
    
    // Hash based on kernel excess and signature (unique per transaction)
    let mut hasher = Sha256::new();
    hasher.update(&tx.kernel.excess);
    hasher.update(&tx.kernel.signature);
    hasher.update(&tx.kernel.fee.to_le_bytes());
    Ok(hex::encode(hasher.finalize()))
}

#[wasm_bindgen]
pub fn update_utxo_set_from_block(block_json: JsValue) -> Result<(), JsValue> {
    let block: Block = serde_wasm_bindgen::from_value(block_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize block: {}", e)))?;
    
    let mut utxo_set = UTXO_SET.lock().unwrap();
    
    // Remove spent outputs (inputs reference spent outputs)
    for tx in &block.transactions {
        for input in &tx.inputs {
            utxo_set.remove(&input.commitment);
        }
    }
    
    // Add new outputs
    for (tx_index, tx) in block.transactions.iter().enumerate() {
        for (output_index, output) in tx.outputs.iter().enumerate() {
            let utxo = UTXO {
                commitment: output.commitment.clone(),
                range_proof: output.range_proof.clone(),
                block_height: block.height,
                index: (tx_index * 1000 + output_index) as u32, // Simple indexing scheme
            };
            utxo_set.insert(output.commitment.clone(), utxo);
        }
    }
    
    log(&format!("[RUST] Updated UTXO set. Total UTXOs: {}", utxo_set.len()));
    Ok(())
}

#[wasm_bindgen]
pub fn get_utxo_set_size() -> usize {
    UTXO_SET.lock().unwrap().len()
}
#[wasm_bindgen]
pub fn sync_blockchain(blocks_json: JsValue) -> Result<JsValue, JsValue> {
    let blocks: Vec<Block> = serde_wasm_bindgen::from_value(blocks_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize blocks: {}", e)))?;
    
    let mut chain = BLOCKCHAIN.lock().unwrap();
    let mut synced_count = 0;
    
    for block in blocks {
        if block.height == chain.current_height + 1 {
            match chain.add_block(block) {
                Ok(_) => synced_count += 1,
                Err(e) => {
                    log(&format!("[RUST] Failed to sync block: {:?}", e));
                    break;
                }
            }
        }
    }
    
    log(&format!("[RUST] Synced {} blocks", synced_count));
    
    serde_wasm_bindgen::to_value(&*chain)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen]
pub fn validate_and_sync_chain(chain_json: JsValue) -> Result<JsValue, JsValue> {
    let remote_chain: blockchain::Blockchain = serde_wasm_bindgen::from_value(chain_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize chain: {}", e)))?;
    
    let mut local_chain = BLOCKCHAIN.lock().unwrap();
    
    // Don't sync if remote chain is shorter
    if remote_chain.current_height <= local_chain.current_height {
        return Ok(JsValue::from_bool(false));
    }
    
    log(&format!("[RUST] Validating remote chain from height {} to {}", 
        local_chain.current_height + 1, remote_chain.current_height));
    
    // Validate each block we don't have
    for i in (local_chain.current_height + 1)..=remote_chain.current_height {
        let block = remote_chain.blocks.iter()
            .find(|b| b.height == i)
            .ok_or_else(|| JsValue::from_str(&format!("Missing block {}", i)))?;
        
        // Validate PoW
        if !block.is_valid_pow() {
            return Err(JsValue::from_str(&format!("Block {} has invalid PoW", i)));
        }
        
        // Validate finalization for non-genesis blocks
        if block.height > 0 {
            if let Some(ref finalization) = block.finalization_data {
                // Verify stake threshold
                if finalization.total_stake_voted <= finalization.total_stake_active / 2 {
                    return Err(JsValue::from_str(&format!(
                        "Block {} has insufficient stake votes: {} of {} required", 
                        i, finalization.total_stake_voted, finalization.total_stake_active / 2 + 1
                    )));
                }
                
                // Verify each vote VDF
                for vote in &finalization.votes {
                    let vote_input = format!("{}||{}", vote.validator_id, vote.block_hash);
                    let vdf = VDF::new(2048).map_err(|e| JsValue::from_str(&e.to_string()))?;
                    
                    let is_valid = vdf.verify(vote_input.as_bytes(), &vote.vdf_proof)
                        .map_err(|e| JsValue::from_str(&format!("VDF verify error: {}", e)))?;
                    
                    if !is_valid {
                        return Err(JsValue::from_str(&format!(
                            "Block {} has invalid vote VDF from validator {}", 
                            i, vote.validator_id
                        )));
                    }
                }
            } else {
                return Err(JsValue::from_str(&format!("Block {} missing finalization data", i)));
            }
        }
        
        // Add block to local chain
        local_chain.add_block(block.clone())
            .map_err(|e| JsValue::from_str(&format!("Failed to add block {}: {:?}", i, e)))?;
        
        // Distribute staker rewards for this block
        if let Some(ref finalization) = block.finalization_data {
            // Calculate participation rate from finalization data
            let participation_rate = finalization.total_stake_voted as f64 / finalization.total_stake_active.max(1) as f64;
            
            // Now pass both parameters
            let total_reward = calculate_dynamic_block_reward(block.difficulty, participation_rate);
            let staker_portion = total_reward / 3 + (total_reward - 50).max(0);
            distribute_staker_rewards(block.height, staker_portion)?;
        }
    }
    
    log(&format!("[RUST] Successfully synced and validated {} blocks", 
        remote_chain.current_height - local_chain.current_height));
    
    Ok(JsValue::from_bool(true))
}
#[wasm_bindgen]
pub fn get_wallet_data(wallet_id: String) -> Result<JsValue, JsValue> {
    let wallets = WALLET_OUTPUTS.lock().unwrap();
    let wallet_outputs = wallets.get(&wallet_id)
        .ok_or_else(|| JsValue::from_str("Wallet not found"))?
        .clone();
    drop(wallets);
    
    let identities = WALLET_IDENTITIES.lock().unwrap();
    let identity = identities.get(&wallet_id)
        .ok_or_else(|| JsValue::from_str("Wallet identity not found"))?
        .clone();
    drop(identities);
    
    let wallet_data = WalletData {
        version: 2,
        identity,
        outputs: wallet_outputs,
        created_at: js_sys::Date::now() as u64,
    };

    serde_wasm_bindgen::to_value(&wallet_data)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn restore_wallet(wallet_id: String, wallet_data_js: JsValue) -> Result<(), JsValue> {
    let wallet_data: WalletData = serde_wasm_bindgen::from_value(wallet_data_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize wallet data: {}", e)))?;
    
    // Validate version
    if wallet_data.version != 2 {
        return Err(JsValue::from_str(&format!("Unsupported wallet version: {}", wallet_data.version)));
    }
    
    // Validate identity key lengths
    if wallet_data.identity.private_key.len() != 32 || wallet_data.identity.public_key.len() != 32 {
        return Err(JsValue::from_str("Invalid identity key lengths"));
    }
    
    // Restore identity
    let mut identities = WALLET_IDENTITIES.lock().unwrap();
    identities.insert(wallet_id.clone(), wallet_data.identity);
    drop(identities);
    
    // Restore outputs
    let mut wallets = WALLET_OUTPUTS.lock().unwrap();
    wallets.insert(wallet_id, wallet_data.outputs);
    drop(wallets);

    Ok(())
}
#[wasm_bindgen]
pub fn get_current_difficulty() -> Result<u8, JsValue> {
    let chain = BLOCKCHAIN.lock().unwrap();
    Ok(chain.calculate_next_difficulty())
}
#[wasm_bindgen]
pub fn check_and_report_double_votes(reporter_id: String) -> Result<JsValue, JsValue> {
    let evidence_list = slashing::check_for_double_votes();
    
    if evidence_list.is_empty() {
        log("[SLASHING] No double votes detected"); // Removed second parameter
        return Ok(JsValue::from_str("No double votes found"));
    }
    
    let mut slashed_count = 0;
    
    for evidence in evidence_list {
        match slashing::process_slashing_evidence(evidence.clone(), &reporter_id) {
            Ok(_) => {
                log(&format!("[SLASHING] Successfully slashed validator {}", evidence.validator_id)); // Removed second parameter
                slashed_count += 1;
            }
            Err(e) => {
                log(&format!("[SLASHING] Failed to slash {}: {}", evidence.validator_id, e)); // Removed second parameter
            }
        }
    }
    
    Ok(JsValue::from_f64(slashed_count as f64))
}

#[wasm_bindgen]
pub fn report_double_vote(
    validator_id: String,
    height: u64,
    block_hash1: String,
    block_hash2: String,
    reporter_id: String
) -> Result<(), JsValue> {
    let votes = BLOCK_VOTES.lock().unwrap();
    
    // Get the votes for this height
    let height_votes = votes.get(&height)
        .ok_or_else(|| JsValue::from_str("No votes found for this height"))?;
    
    // Get the validator's vote data
    let vote_data = height_votes.get(&validator_id)
        .ok_or_else(|| JsValue::from_str("Validator has not voted at this height"))?;
    
    // Create evidence
    let evidence = slashing::SlashingEvidence {
        validator_id: validator_id.clone(),
        height,
        vote1: block::ValidatorVote {
            validator_id: validator_id.clone(),
            block_hash: block_hash1.clone(),
            stake_amount: vote_data.stake_amount,
            vdf_proof: vote_data.vdf_proof.clone(),
            signature: vote_data.signature.clone(),
        },
        vote2: block::ValidatorVote {
            validator_id: validator_id.clone(),
            block_hash: block_hash2.clone(),
            stake_amount: vote_data.stake_amount,
            vdf_proof: vote_data.vdf_proof.clone(),
            signature: vote_data.signature.clone(),
        },
        vote1_block_hash: block_hash1,
        vote2_block_hash: block_hash2,
    };
    
    drop(votes);
    
    slashing::process_slashing_evidence(evidence, &reporter_id)
        .map_err(|e| JsValue::from_str(&e))?;
    
    Ok(())
}


#[wasm_bindgen]
pub fn create_utxo_snapshot() -> Result<JsValue, JsValue> {
    let chain = BLOCKCHAIN.lock().unwrap();
    let snapshot = chain.create_utxo_snapshot()
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    log(&format!("[RUST] Created UTXO snapshot at height {} with {} UTXOs", 
        snapshot.height, snapshot.utxos.len()));
    
    serde_wasm_bindgen::to_value(&snapshot)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn restore_from_utxo_snapshot(snapshot_js: JsValue) -> Result<(), JsValue> {
    let snapshot: UTXOSnapshot = serde_wasm_bindgen::from_value(snapshot_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize snapshot: {}", e)))?;
    
    let height = snapshot.height;
    
    let mut chain = BLOCKCHAIN.lock().unwrap();
    chain.restore_from_snapshot(snapshot)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    log(&format!("[RUST] Restored chain from UTXO snapshot at height {}", height));
    Ok(())
}

#[wasm_bindgen]
pub fn apply_block_cut_through(block_js: JsValue) -> Result<JsValue, JsValue> {
    let mut block: Block = serde_wasm_bindgen::from_value(block_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize block: {}", e)))?;
    
    let original_tx_count = block.transactions.len();
    block.apply_cut_through()
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    log(&format!("[RUST] Applied cut-through: {} txs -> {} tx", 
        original_tx_count, block.transactions.len()));
    
    serde_wasm_bindgen::to_value(&block)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn prune_blockchain(keep_recent_blocks: u64) -> Result<(), JsValue> {
    let mut chain = BLOCKCHAIN.lock().unwrap();
    let original_length = chain.blocks.len();
    
    chain.prune_to_horizon(keep_recent_blocks)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    log(&format!("[RUST] Pruned blockchain: {} blocks -> {} blocks", 
        original_length, chain.blocks.len()));
    
    Ok(())
}

#[wasm_bindgen]
pub fn get_chain_storage_size() -> Result<JsValue, JsValue> {
    let chain = BLOCKCHAIN.lock().unwrap();
    let utxo_set = UTXO_SET.lock().unwrap();
    
    // Calculate approximate storage size
    let blocks_size: usize = chain.blocks.iter()
        .map(|b| {
            // Rough estimate of block size
            let tx_size: usize = b.transactions.iter()
                .map(|tx| {
                    tx.inputs.len() * 32 + 
                    tx.outputs.iter().map(|o| o.commitment.len() + o.range_proof.len()).sum::<usize>() +
                    96 // kernel size
                })
                .sum();
            tx_size + 200 // header overhead
        })
        .sum();
    
    let utxo_size = utxo_set.len() * (32 + 700); // commitment + range proof average
    
    #[derive(Serialize)]
    struct StorageInfo {
        blocks_count: usize,
        blocks_size_bytes: usize,
        utxo_count: usize,
        utxo_size_bytes: usize,
        total_size_bytes: usize,
        total_size_mb: f64,
    }
    
    let info = StorageInfo {
        blocks_count: chain.blocks.len(),
        blocks_size_bytes: blocks_size,
        utxo_count: utxo_set.len(),
        utxo_size_bytes: utxo_size,
        total_size_bytes: blocks_size + utxo_size,
        total_size_mb: (blocks_size + utxo_size) as f64 / 1_048_576.0,
    };
    
    serde_wasm_bindgen::to_value(&info)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn compute_block_vdf_proof(prev_hash: String) -> Result<JsValue, JsValue> {
    let vdf = VDF::new(2048)
        .map_err(|e| JsValue::from_str(&format!("Failed to create VDF: {:?}", e)))?;
    
    // For testing, use minimal iterations
    let vdf_iterations = 100;
    let vdf_proof = vdf.compute_with_proof(prev_hash.as_bytes(), vdf_iterations)
        .map_err(|e| JsValue::from_str(&format!("Failed to compute VDF: {:?}", e)))?;
    
    serde_wasm_bindgen::to_value(&vdf_proof)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
