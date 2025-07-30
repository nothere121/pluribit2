// src/blockchain.rs
use crate::block::Block;
use crate::transaction::TransactionOutput;
use crate::error::{PluribitError, PluribitResult};
use crate::vrf;
use crate::constants;
use crate::vdf::VDFProof;
use crate::vrf::VrfProof;

use crate::log;
use curve25519_dalek::ristretto::CompressedRistretto;
use std::collections::HashMap;
use num_bigint::BigUint;
use std::sync::Mutex;
use lazy_static::lazy_static;
use serde::{Serialize, Deserialize};


// Globals for UTXO set remain
lazy_static! {
    pub static ref UTXO_SET: Mutex<HashMap<Vec<u8>, TransactionOutput>> =
        Mutex::new(HashMap::new());
    pub static ref UTXO_ROOTS: Mutex<HashMap<u64, [u8; 32]>> = 
        Mutex::new(HashMap::new());
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Blockchain {
    pub blocks: Vec<Block>,
    #[serde(skip)]
    pub block_by_hash: HashMap<String, Block>,
    pub current_height: u64,
    
    // NEW difficulty and work tracking
    pub total_work: u64,
    pub current_pow_difficulty: u8,
    pub current_vrf_threshold: [u8; 32],
    pub current_vdf_iterations: u64,
}

impl Blockchain {
    pub fn new() -> Self {
        let genesis = Block::genesis();
        let genesis_hash = genesis.hash();
        let mut block_by_hash = HashMap::new();
        block_by_hash.insert(genesis_hash.clone(), genesis.clone());
        
        Blockchain {
            blocks: vec![genesis],
            block_by_hash,
            current_height: 0,
            total_work: 0,
            current_pow_difficulty: 10,
            current_vrf_threshold: [0x0F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF],
            current_vdf_iterations: 1_000_000,
        }
    }
    
    pub fn get_chain_work(blocks: &[Block]) -> u64 {
        blocks.iter().map(|block| block.vdf_proof.iterations).sum()
    }

    pub fn get_total_work(&self) -> u64 {
        self.total_work
    }
    
    pub fn get_latest_block(&self) -> &Block {
        self.blocks.last().expect("blockchain always has genesis")
    }

    pub fn add_block(&mut self, block: Block) -> PluribitResult<()> {
        // === 1. Basic Validation ===
        if block.height != self.current_height + 1 {
            return Err(PluribitError::InvalidBlock(format!("Expected height {}, got {}", self.current_height + 1, block.height)));
        }
        if block.prev_hash != self.get_latest_block().hash() {
            return Err(PluribitError::InvalidBlock("Parent hash mismatch".into()));
        }

        // === 2. PoW + PoST Consensus Validation ===
        // a. Verify the PoW ticket
        if !block.is_valid_pow_ticket(self.current_pow_difficulty) {
            return Err(PluribitError::InvalidBlock("Invalid PoW ticket".into()));
        }

        // b. Verify the VRF proof
        let miner_pubkey = CompressedRistretto::from_slice(&block.miner_pubkey)
            .map_err(|_| PluribitError::InvalidBlock("Invalid miner public key format".into()))?
            .decompress()
            .ok_or_else(|| PluribitError::InvalidBlock("Invalid miner public key".into()))?;
        let vrf_input = block.prev_hash.as_bytes();
        if !vrf::verify_vrf(&miner_pubkey, vrf_input, &block.vrf_proof) {
            return Err(PluribitError::InvalidBlock("Invalid VRF proof".into()));
        }

        // c. Verify the VRF output meets the lottery threshold
        if block.vrf_proof.output >= self.current_vrf_threshold {
            return Err(PluribitError::InvalidBlock("VRF output does not meet threshold".into()));
        }

        // d. Verify the VDF proof
        let vdf = crate::vdf::VDF::new(2048)?;
        let vdf_input = format!("{}{}", block.prev_hash, hex::encode(&block.vrf_proof.output));
        if !vdf.verify(vdf_input.as_bytes(), &block.vdf_proof)? {
            return Err(PluribitError::InvalidBlock("Invalid VDF proof".into()));
        }
        
        // === 3. Transaction and State Validation ===
        {
            let mut utxos = UTXO_SET.lock().unwrap();
            let total_fees = block.transactions.iter().skip(1).map(|tx| tx.kernel.fee).sum::<u64>();
            let coinbase_reward = self.calculate_block_reward(block.height, self.current_pow_difficulty) + total_fees;

            for (i, tx) in block.transactions.iter().enumerate() {
                if i == 0 {
                    tx.verify(Some(coinbase_reward), None)?;
                } else {
                    tx.verify(None, Some(&utxos))?;
                }
            }

            // Apply UTXO changes
            for tx in &block.transactions {
                for inp in &tx.inputs {
                    if utxos.remove(&inp.commitment).is_none() {
                        return Err(PluribitError::UnknownInput);
                    }
                }
                for out in &tx.outputs {
                    utxos.insert(out.commitment.clone(), out.clone());
                }
            }
        }

        // === 4. Update Chain State ===
        self.total_work += block.vdf_proof.iterations;
        self.blocks.push(block.clone());
        self.block_by_hash.insert(block.hash(), block.clone());
        self.current_height += 1;

        // === 5. Difficulty Adjustment ===
        if self.current_height > 0 && self.current_height % constants::DIFFICULTY_ADJUSTMENT_INTERVAL == 0 {
            self.adjust_difficulty();
        }
        // === 6. Store UTXO Root ===
        // After a block is successfully added, we compute the Merkle root of the *entire*
        // resulting UTXO set and store it, keyed by the block's height.
        // This is crucial for later verifying spending proofs.
        {
            let utxo_set = UTXO_SET.lock().unwrap();
            let mut utxo_vec: Vec<(Vec<u8>, TransactionOutput)> = utxo_set.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            utxo_vec.sort_by(|a, b| a.0.cmp(&b.0)); // Sort for deterministic root
            let utxo_root = Block::calculate_utxo_merkle_root(&utxo_vec);
            UTXO_ROOTS.lock().unwrap().insert(block.height, utxo_root);
        }
        Ok(())
    }
    
    fn adjust_difficulty(&mut self) {
        let window = constants::DIFFICULTY_ADJUSTMENT_INTERVAL as usize;
        if self.blocks.len() < window + 1 {
            return;
        }
    
        let end_block = self.get_latest_block();
        let start_block = &self.blocks[self.blocks.len() - window];
    
        let actual_time_ms = end_block.timestamp.saturating_sub(start_block.timestamp);
        let expected_time_ms = constants::DIFFICULTY_ADJUSTMENT_INTERVAL * constants::TARGET_BLOCK_TIME * 1000;
    
        if actual_time_ms == 0 {
            return;
        }
    
        let mut ratio = actual_time_ms as f64 / expected_time_ms as f64;
        ratio = ratio.max(0.25).min(4.0);
    
        let new_vdf_iterations = ((self.current_vdf_iterations as f64) / ratio).round() as u64;
        let new_vdf_iterations = new_vdf_iterations.max(constants::MIN_VDF_ITERATIONS).min(constants::MAX_VDF_ITERATIONS);
    
        let new_pow_difficulty_f64 = (self.current_pow_difficulty as f64) / ratio;
        let new_pow_difficulty = (new_pow_difficulty_f64.round() as u8).max(1).min(64);
    
        let mut threshold_bigint = BigUint::from_bytes_be(&self.current_vrf_threshold);
        let ratio_numerator = (ratio * 1_000_000.0).round() as u128;
        let ratio_denominator = 1_000_000u128;
        threshold_bigint = (threshold_bigint * ratio_numerator) / ratio_denominator;
        
        let max_threshold = BigUint::from_bytes_be(&[0xFF; 32]);
        if threshold_bigint > max_threshold {
            threshold_bigint = max_threshold;
        }
        
        let min_threshold = BigUint::from_bytes_be(&[0x00, 0x28, 0xF5, 0xC2, 0x8F, 0x5C, 0x28, 0xF5, 0xC2, 0x8F, 0x5C, 0x28, 0xF5, 0xC2, 0x8F, 0x5C, 0x28, 0xF5, 0xC2, 0x8F, 0x5C, 0x28, 0xF5, 0xC2, 0x8F, 0x5C, 0x28, 0xF5, 0xC2, 0x8F, 0x5C, 0x29]);

        if threshold_bigint < min_threshold {
            threshold_bigint = min_threshold;
        }
        
        let new_vrf_threshold_bytes = threshold_bigint.to_bytes_be();
        let mut new_vrf_threshold = [0u8; 32];
        let pad_len = 32_usize.saturating_sub(new_vrf_threshold_bytes.len());
        new_vrf_threshold[pad_len..].copy_from_slice(&new_vrf_threshold_bytes);
    
        log(&format!(
            "[DIFFICULTY] Adjustment at height {}: Actual Time: {:.2}s, Expected: {:.2}s, Ratio: {:.2}",
            self.current_height,
            actual_time_ms as f64 / 1000.0,
            expected_time_ms as f64 / 1000.0,
            ratio
        ));
        log(&format!(
            "[DIFFICULTY] VDF Iterations: {} -> {}",
            self.current_vdf_iterations, new_vdf_iterations
        ));
        log(&format!(
            "[DIFFICULTY] PoW Difficulty: {} -> {}",
            self.current_pow_difficulty, new_pow_difficulty
        ));
        log(&format!(
            "[DIFFICULTY] VRF Threshold: {}... -> {}...",
            hex::encode(&self.current_vrf_threshold[..4]), hex::encode(&new_vrf_threshold[..4])
        ));
    
        self.current_vdf_iterations = new_vdf_iterations;
        self.current_pow_difficulty = new_pow_difficulty;
        self.current_vrf_threshold = new_vrf_threshold;
    }

    pub fn calculate_block_reward(&self, height: u64, pow_difficulty: u8) -> u64 {
        let base_reward = get_current_base_reward(height);
        
        let pow_bonus = if pow_difficulty > 10 {
            (pow_difficulty as u64 - 10) * 100_000
        } else { 0 };
        
        base_reward + pow_bonus
    }
    
    // Keep these existing helper methods
    pub fn can_accept_block(&self, block: &Block) -> Result<(), PluribitError> {
        if block.height != self.current_height + 1 {
            return Err(PluribitError::InvalidBlock(format!(
                "Expected height {}, got {}",
                self.current_height + 1,
                block.height
            )));
        }
        
        if block.prev_hash != self.get_latest_block().hash() {
            return Err(PluribitError::InvalidBlock(
                "Block does not extend current chain tip".to_string()
            ));
        }
        
        Ok(())
    }
    
    pub fn create_utxo_snapshot(&self) -> PluribitResult<crate::UTXOSnapshot> {
        let mut current_utxos: HashMap<Vec<u8>, TransactionOutput> = HashMap::new();
        let mut total_kernels = 0u64;
        
        for block in &self.blocks {
            for tx in &block.transactions {
                for input in &tx.inputs {
                    current_utxos.remove(&input.commitment);
                }
                for output in &tx.outputs {
                    current_utxos.insert(output.commitment.clone(), output.clone());
                }
                total_kernels += 1;
            }
        }
        
        let mut utxo_vec: Vec<(Vec<u8>, TransactionOutput)> = current_utxos.into_iter().collect();
        utxo_vec.sort_by(|a, b| a.0.cmp(&b.0));
        
        let merkle_root = Block::calculate_utxo_merkle_root(&utxo_vec);
        
        Ok(crate::UTXOSnapshot {
            height: self.current_height,
            prev_block_hash: self.get_latest_block().hash(),
            utxos: utxo_vec,
            timestamp: js_sys::Date::now() as u64,
            merkle_root,
            total_kernels,
        })
    }
    
    pub fn restore_from_snapshot(&mut self, snapshot: crate::UTXOSnapshot) -> PluribitResult<()> {
        let calculated_root = Block::calculate_utxo_merkle_root(&snapshot.utxos);
        if calculated_root != snapshot.merkle_root {
            return Err(PluribitError::InvalidBlock("UTXO snapshot merkle root mismatch".to_string()));
        }
        
        let mut utxo_set = UTXO_SET.lock().unwrap();
        utxo_set.clear();
        
        for (commitment, output) in &snapshot.utxos {
            utxo_set.insert(commitment.clone(), output.clone());
        }
        
        let snapshot_block = Block {
            height: snapshot.height,
            prev_hash: snapshot.prev_block_hash.clone(),
            transactions: vec![],
            timestamp: snapshot.timestamp,
            pow_nonce: 0,
            vrf_proof: VrfProof::default(),
            vdf_proof: VDFProof::default(),
            miner_pubkey: [0u8; 32],
            tx_merkle_root: [0u8; 32],
        };
        
        self.blocks = vec![self.blocks[0].clone(), snapshot_block];
        self.current_height = snapshot.height;
        
        Ok(())
    }
    
    pub fn prune_to_horizon(&mut self, keep_recent: u64) -> PluribitResult<()> {
        if self.current_height <= keep_recent {
            return Ok(());
        }
        
        let horizon_height = self.current_height - keep_recent;
        
        let mut horizon_utxos: HashMap<Vec<u8>, TransactionOutput> = HashMap::new();
        
        for i in 0..=horizon_height as usize {
            if i >= self.blocks.len() {
                break;
            }
            
            let block = &self.blocks[i];
            for tx in &block.transactions {
                for input in &tx.inputs {
                    horizon_utxos.remove(&input.commitment);
                }
                for output in &tx.outputs {
                    horizon_utxos.insert(output.commitment.clone(), output.clone());
                }
            }
        }
        
        let mut pruned_chain = vec![self.blocks[0].clone()];
        pruned_chain.extend_from_slice(&self.blocks[(horizon_height as usize + 1)..]);
        
        self.blocks = pruned_chain;
        
        self.block_by_hash.clear();
        for block in &self.blocks {
            self.block_by_hash.insert(block.hash(), block.clone());
        }
        
        Ok(())
    }
}

pub fn get_current_base_reward(height: u64) -> u64 {
    let height_in_era = height % crate::constants::REWARD_RESET_INTERVAL;
    let num_halvings = height_in_era / crate::constants::HALVING_INTERVAL;
    if num_halvings >= 64 { 0 } else { crate::constants::INITIAL_BASE_REWARD >> num_halvings }
}
