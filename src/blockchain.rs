// src/blockchain.rs
use crate::vdf::VDFProof;
use crate::block::Block;
use crate::transaction::TransactionKernel;
use crate::transaction::TransactionOutput;
use crate::transaction::Transaction;
use crate::error::{BitQuillError, BitQuillResult};
use std::collections::HashMap;
use std::sync::Mutex;
use lazy_static::lazy_static;
use serde::{Serialize, Deserialize};
use crate::UTXOSnapshot;

lazy_static! {
    /// Global UTXO set: maps compressed commitment bytes to their TransactionOutput
    pub static ref UTXO_SET: Mutex<HashMap<Vec<u8>, TransactionOutput>> =
        Mutex::new(HashMap::new());
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Blockchain {
    pub blocks: Vec<Block>,
    #[serde(skip)]
    pub block_by_hash: HashMap<String, Block>,
    pub current_height: u64,
    pub last_difficulty_adjustment: u64,
    pub current_difficulty: u8,
}

impl Blockchain {
    /// Create a new chain, insert genesis block, seed UTXO set
    pub fn new() -> Self {
        let genesis = Block::genesis();
        let genesis_hash = genesis.hash();
        let mut block_by_hash = HashMap::new();
        block_by_hash.insert(genesis_hash.clone(), genesis.clone());

        // Seed UTXO_SET with all outputs from genesis
        {
            let mut utxos = UTXO_SET.lock().unwrap();
            for tx in &genesis.transactions {
                for out in &tx.outputs {
                    utxos.insert(out.commitment.clone(), out.clone());
                }
            }
        }

        Blockchain {
            blocks: vec![genesis],
            block_by_hash,
            current_height: 0,
            last_difficulty_adjustment: 0,
            current_difficulty: 1, // start at difficulty=1
        }
    }

    /// Get the latest block
    pub fn get_latest_block(&self) -> &Block {
        self.blocks
            .last()
            .expect("blockchain always has at least the genesis block")
    }

    /// Retarget every 144 blocks toward 40s per block
    pub fn calculate_next_difficulty(&self) -> u8 {
        const ADJUSTMENT_INTERVAL: u64 = 144;
        const TARGET_BLOCK_TIME_MS: u64 = 40_000; // Change from u128 to u64

        if self.current_height == 0
            || (self.current_height + 1) % ADJUSTMENT_INTERVAL != 0
        {
            return self.current_difficulty;
        }

        let start_height = self.current_height.saturating_sub(ADJUSTMENT_INTERVAL - 1);
        let start_block = &self.blocks[start_height as usize];
        let end_block = &self.blocks[self.current_height as usize];

        let actual_time = end_block.timestamp - start_block.timestamp;
        let expected_time = ADJUSTMENT_INTERVAL * TARGET_BLOCK_TIME_MS; // Now both are u64

        let mut new_diff = self.current_difficulty;
        if actual_time < expected_time / 2 {
            new_diff = (self.current_difficulty + 1).min(8);
        } else if actual_time > expected_time * 2 {
            new_diff = self.current_difficulty.saturating_sub(1).max(1);
        }
        new_diff
    }

    /// Validate and append a block:
    /// 1) height & parent  
    /// 2) PoW  
    /// 3) VDF proof  
    /// 4) every tx via `Transaction::verify()`  
    /// 5) UTXO-set updates  
    /// 6) difficulty retarget  
    pub fn add_block(&mut self, block: Block) -> BitQuillResult<()> {
        // 1. Height continuity
        if block.height != self.current_height + 1 {
            return Err(BitQuillError::InvalidBlock(format!(
                "Expected height {}, got {}",
                self.current_height + 1,
                block.height
            )));
        }
        // 2. Parent hash
        if block.prev_hash != self.get_latest_block().hash() {
            return Err(BitQuillError::InvalidBlock(
                "Parent hash mismatch".into(),
            ));
        }
        // 3. Proof-of‐Work
        if !block.is_valid_pow() {
            return Err(BitQuillError::InvalidBlock("Invalid PoW".into()));
        }
        // 4. VDF proof
        if !block.has_valid_vdf_proof() {
            return Err(BitQuillError::InvalidBlock(
                "Invalid or missing VDF proof".into(),
            ));
        }

        // 5. Verify all transactions (range proofs, Schnorrs, balances, UTXO existence)
        for tx in &block.transactions {
            tx.verify()?; // returns Err(BitQuillError) on any failure
        }

        // 6. Update UTXO set: spend inputs, add outputs
        {
            let mut utxos = UTXO_SET.lock().unwrap();
            for tx in &block.transactions {
                // spend
                for inp in &tx.inputs {
                    if utxos.remove(&inp.commitment).is_none() {
                        return Err(BitQuillError::UnknownInput);
                    }
                }
                // add new outputs
                for out in &tx.outputs {
                    utxos.insert(out.commitment.clone(), out.clone());
                }
            }
        }

        // 7. Append block & update maps/height
        let h = block.hash();
        self.blocks.push(block.clone());
        self.block_by_hash.insert(h, block);
        self.current_height += 1;

        // 8. Retarget difficulty if needed
        self.current_difficulty = self.calculate_next_difficulty();

        Ok(())
    }
    
    /// Create a UTXO snapshot at current height
    pub fn create_utxo_snapshot(&self) -> BitQuillResult<UTXOSnapshot> {
        let mut current_utxos: HashMap<Vec<u8>, TransactionOutput> = HashMap::new();
        let mut total_kernels = 0u64;
        
        // Process all blocks to build UTXO set
        for block in &self.blocks {
            for tx in &block.transactions {
                // Remove spent outputs
                for input in &tx.inputs {
                    current_utxos.remove(&input.commitment);
                }
                // Add new outputs
                for output in &tx.outputs {
                    current_utxos.insert(output.commitment.clone(), output.clone());
                }
                // Count kernels
                total_kernels += 1;
            }
        }
        
        // Convert to sorted vec for deterministic ordering
        let mut utxo_vec: Vec<(Vec<u8>, TransactionOutput)> = current_utxos.into_iter().collect();
        utxo_vec.sort_by(|a, b| a.0.cmp(&b.0));
        
        // Calculate merkle root
        let merkle_root = Block::calculate_utxo_merkle_root(&utxo_vec);
        
        Ok(UTXOSnapshot {
            height: self.current_height,
            prev_block_hash: self.get_latest_block().hash(),
            utxos: utxo_vec,
            timestamp: js_sys::Date::now() as u64,
            merkle_root,
            total_kernels,
        })
    }
    
    /// Restore chain state from UTXO snapshot
    pub fn restore_from_snapshot(&mut self, snapshot: UTXOSnapshot) -> BitQuillResult<()> {
        // Verify merkle root
        let calculated_root = Block::calculate_utxo_merkle_root(&snapshot.utxos);
        if calculated_root != snapshot.merkle_root {
            return Err(BitQuillError::InvalidBlock("UTXO snapshot merkle root mismatch".to_string()));
        }
        
        // Clear current UTXO set
        let mut utxo_set = UTXO_SET.lock().unwrap();
        utxo_set.clear();
        
        // Restore UTXOs
        for (commitment, output) in &snapshot.utxos {
            utxo_set.insert(commitment.clone(), output.clone());
        }
        
        // Create synthetic block representing the snapshot
        let snapshot_block = Block {
            height: snapshot.height,
            prev_hash: snapshot.prev_block_hash.clone(),
            transactions: vec![Transaction {
                inputs: vec![],
                outputs: snapshot.utxos.iter().map(|(_, o)| o.clone()).collect(),
                kernel: TransactionKernel {
                    excess: vec![0u8; 32],
                    signature: vec![0u8; 64],
                    fee: 0,
                },
            }],
            vdf_proof: VDFProof { y: vec![], pi: vec![], l: vec![], r: vec![] },
            timestamp: snapshot.timestamp,
            nonce: 0,
            miner_id: "snapshot".to_string(),
            difficulty: 1,
            finalization_data: None,
        };
        
        // Reset chain to snapshot
        self.blocks = vec![self.blocks[0].clone(), snapshot_block]; // Keep genesis
        self.current_height = snapshot.height;
        
        Ok(())
    }
    
    /// Apply aggressive pruning for browser storage
    pub fn prune_to_horizon(&mut self, keep_recent: u64) -> BitQuillResult<()> {
        if self.current_height <= keep_recent {
            return Ok(());
        }
        
        let horizon_height = self.current_height - keep_recent;
        
        // Create UTXO snapshot at horizon
        let mut horizon_utxos: HashMap<Vec<u8>, TransactionOutput> = HashMap::new();
        
        // Process blocks up to horizon
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
        
        // Create horizon block
        let horizon_block = Block {
            height: horizon_height,
            prev_hash: self.blocks[horizon_height as usize].hash(),
            transactions: vec![Transaction {
                inputs: vec![],
                outputs: horizon_utxos.into_values().collect(),
                kernel: TransactionKernel {
                    excess: vec![0u8; 32],
                    signature: vec![0u8; 64],
                    fee: 0,
                },
            }],
            vdf_proof: VDFProof { y: vec![], pi: vec![], l: vec![], r: vec![] },
            timestamp: self.blocks[horizon_height as usize].timestamp,
            nonce: 0,
            miner_id: "horizon".to_string(),
            difficulty: 1,
            finalization_data: None,
        };
        
        // Keep genesis, horizon, and recent blocks
        let mut pruned_chain = vec![self.blocks[0].clone(), horizon_block];
        pruned_chain.extend_from_slice(&self.blocks[(horizon_height as usize + 1)..]);
        
        self.blocks = pruned_chain;
        
        // Update block_by_hash
        self.block_by_hash.clear();
        for block in &self.blocks {
            self.block_by_hash.insert(block.hash(), block.clone());
        }
        
        Ok(())
    }
    
    
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transaction::TransactionBuilder;
    use crate::block::BlockBuilder;

    #[test]
    fn chain_accepts_a_valid_block_and_updates_utxos() {
        let mut chain = Blockchain::new();

        // Build a spend TX: 100 → (60, 40)
        let tx = TransactionBuilder::new()
            .add_input(100)
            .add_output(60)
            .add_output(40)
            .with_fee(0)
            .build()
            .unwrap();

        // Create a block on top of tip
        let mut block = BlockBuilder::new()
            .with_parent(chain.get_latest_block().hash())
            .with_transactions(vec![tx.clone()])
            .with_difficulty(chain.current_difficulty)
            .build();

        block.mine().unwrap();      // solve PoW
        block.compute_vdf().unwrap(); // generate VDF proof

        chain.add_block(block.clone()).unwrap();

        // Now UTXO set should contain the two new outputs
        let utxos = UTXO_SET.lock().unwrap();
        assert!(utxos.contains_key(&tx.outputs[0].commitment));
        assert!(utxos.contains_key(&tx.outputs[1].commitment));
    }
}
