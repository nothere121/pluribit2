// src/block.rs
use serde::{Serialize, Deserialize};
use crate::transaction::Transaction;
use crate::vdf::VDFProof;
use crate::vrf::VrfProof;
use sha2::{Sha256, Digest};
use num_bigint::BigUint;
use num_traits::One;
use crate::constants::{GENESIS_TIMESTAMP_MS, GENESIS_BITCOIN_HASH}; 
use crate::error::PluribitResult;
use std::collections::HashSet;
use crate::transaction::{TransactionInput, TransactionOutput, TransactionKernel};



#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Block {
   pub height: u64,
   pub prev_hash: String,
   pub timestamp: u64,
   pub transactions: Vec<Transaction>,
   
   // NEW PoW + PoST fields
   pub pow_nonce: u64,
   pub vrf_proof: VrfProof,
   pub vdf_proof: VDFProof,
   pub miner_pubkey: [u8; 32],
   
   // Merkle root
   pub tx_merkle_root: [u8; 32],
}

impl Block {
   pub fn genesis() -> Self {
       // Hash the Bitcoin block anchor to create our genesis `prev_hash`
       let mut hasher = Sha256::new();
       hasher.update(b"pluribit_genesis_anchor_v1"); // Domain separator
       hasher.update(GENESIS_BITCOIN_HASH.as_bytes());
       let genesis_prev_hash = hex::encode(hasher.finalize());

       Block {
           height: 0,
           prev_hash: genesis_prev_hash, // <-- Use the hash of the anchor
           timestamp: GENESIS_TIMESTAMP_MS, 
           transactions: vec![],
           pow_nonce: 0,
           vrf_proof: VrfProof::default(),
          
           vdf_proof: VDFProof::default(),
           miner_pubkey: [0u8; 32],
           tx_merkle_root: Sha256::digest(&[]).into(),
       }
   }
   
   /// Calculates the hash of the block header.
   pub fn hash(&self) -> String {
       let mut hasher = Sha256::new();
       hasher.update(b"pluribit_block_v2");
       hasher.update(&self.height.to_le_bytes());
       hasher.update(self.prev_hash.as_bytes());
       hasher.update(&self.timestamp.to_le_bytes());
       hasher.update(&self.tx_merkle_root);
       hasher.update(&self.vrf_proof.output);
       hasher.update(&self.vdf_proof.y);
       hasher.update(&self.miner_pubkey);
       hex::encode(hasher.finalize())
   }

   /// Calculates the hash for the PoW ticket lottery.
   pub fn pow_ticket_hash(&self) -> [u8; 32] {
       let mut hasher = Sha256::new();
       hasher.update(b"pluribit_pow_ticket_v1");
       hasher.update(self.prev_hash.as_bytes());
       hasher.update(&self.miner_pubkey);
       hasher.update(&self.pow_nonce.to_le_bytes());
       hasher.finalize().into()
   }

   /// Verifies if the PoW ticket hash meets the required difficulty.
   pub fn is_valid_pow_ticket(&self, difficulty: u8) -> bool {
       let hash_bytes = self.pow_ticket_hash();
       let value = BigUint::from_bytes_be(&hash_bytes);
       let target = BigUint::one() << (256 - difficulty as usize);
       value < target
   }
   
   /// Calculates the Merkle root of the block's transactions.
   pub fn calculate_tx_merkle_root(&self) -> [u8; 32] {
       if self.transactions.is_empty() {
           return Sha256::digest(&[]).into();
       }

       let mut leaves: Vec<[u8; 32]> = self.transactions.iter()
           .map(|tx| Sha256::digest(tx.hash().as_bytes()).into())
           .collect();
       while leaves.len() > 1 {
           if leaves.len() % 2 == 1 {
               leaves.push(*leaves.last().unwrap());
           }
           leaves = leaves.chunks(2)
               .map(|pair| {
                   let mut h = Sha256::new();
                   h.update(&pair[0]);
                   h.update(&pair[1]);
                   h.finalize().into()
               })
               .collect();
       }
       leaves[0]
   }

   /// Apply cut-through to remove intermediate transactions
    pub fn apply_cut_through(&mut self) -> PluribitResult<()> {
        if self.transactions.is_empty() {
            return Ok(());
        }
        
        // Collect all inputs and outputs
        let mut all_inputs: Vec<TransactionInput> = Vec::new();
        let mut all_outputs: Vec<TransactionOutput> = Vec::new();
        let mut all_kernels: Vec<TransactionKernel> = Vec::new();
        for tx in &self.transactions {
            all_inputs.extend(tx.inputs.clone());
            all_outputs.extend(tx.outputs.clone());
            all_kernels.push(tx.kernel.clone());
        }
        
        // Create output lookup map
        let output_set: HashSet<Vec<u8>> = all_outputs.iter()
            .map(|o| o.commitment.clone())
            .collect();
        // Filter inputs - only keep those that reference outputs from previous blocks
        let external_inputs: Vec<TransactionInput> = all_inputs.into_iter()
            .filter(|input| !output_set.contains(&input.commitment))
            .collect();
        // Filter outputs - only keep those not spent in this block
        let spent_set: HashSet<Vec<u8>> = external_inputs.iter()
            .map(|i| i.commitment.clone())
            .collect();
        // Also need to check internal spends
        let internal_spent: HashSet<Vec<u8>> = self.transactions.iter()
            .flat_map(|tx| tx.inputs.iter())
            .filter(|input| output_set.contains(&input.commitment))
            .map(|input| input.commitment.clone())
            .collect();
        let unspent_outputs: Vec<TransactionOutput> = all_outputs.into_iter()
            .filter(|output| !spent_set.contains(&output.commitment) && 
                           !internal_spent.contains(&output.commitment))
            .collect();
        // Aggregate all kernels
        let aggregated_kernel = TransactionKernel::aggregate(&all_kernels)?;
        // Replace all transactions with single aggregated transaction
        self.transactions = vec![Transaction {
            inputs: external_inputs,
            outputs: unspent_outputs,
            kernel: aggregated_kernel,
        }];
        Ok(())
    }
    pub fn calculate_utxo_merkle_root(utxos: &[(Vec<u8>, TransactionOutput)]) -> [u8; 32] {
        if utxos.is_empty() {
            return Sha256::digest(&[]).into();
        }

        let leaves: Vec<[u8; 32]> = utxos.iter()
            .map(|(commitment, output)| {
                let mut hasher = Sha256::new();
                hasher.update(commitment);
                hasher.update(&output.range_proof);
                hasher.finalize().into()
            })
            .collect();

        let (_proofs, root) = crate::merkle::build_merkle_tree_with_proofs(&leaves);

        root
    }
}
