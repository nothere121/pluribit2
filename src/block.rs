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
   
   //  PoW + PoST fields
   pub pow_nonce: u64,
   pub vrf_proof: VrfProof,
   pub vdf_proof: VDFProof,
   pub miner_pubkey: [u8; 32],
   
   // Merkle root
   pub tx_merkle_root: [u8; 32],
   
   //  hash as a computed field during serialization
   #[serde(skip_deserializing)]
   pub hash: String,
}

impl Block {
   pub fn genesis() -> Self {
       // Hash the Bitcoin block anchor to create our genesis `prev_hash`
       let mut hasher = Sha256::new();
       hasher.update(b"pluribit_genesis_anchor_v1"); // Domain separator
       hasher.update(GENESIS_BITCOIN_HASH.as_bytes());
       let genesis_prev_hash = hex::encode(hasher.finalize());

       let mut block = Block {
           height: 0,
           prev_hash: genesis_prev_hash,
           timestamp: GENESIS_TIMESTAMP_MS, 
           transactions: vec![],
           pow_nonce: 0,
           vrf_proof: VrfProof::default(),
           vdf_proof: VDFProof::default(),
           miner_pubkey: [0u8; 32],
           tx_merkle_root: Sha256::digest(&[]).into(),
           hash: String::new(), // Will be computed below
       };
       block.hash = block.compute_hash();
       block
   }
   
   /// Calculates the hash of the block header.
   pub fn compute_hash(&self) -> String {
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
   /// just returns the stored hash - i.e. not recomputing
   pub fn hash(&self) -> String {
       if self.hash.is_empty() {
           self.compute_hash()
       } else {
           self.hash.clone()
       }
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
    if self.transactions.len() <= 1 {
        return Ok(());
    }
    
    // Collect all inputs, outputs, and kernels
    let mut all_inputs: Vec<TransactionInput> = Vec::new();
    let mut all_outputs: Vec<TransactionOutput> = Vec::new();
    let mut all_kernels: Vec<TransactionKernel> = Vec::new();
    
    for tx in &self.transactions {
        all_inputs.extend(tx.inputs.clone());
        all_outputs.extend(tx.outputs.clone());
        all_kernels.push(tx.kernel.clone());
    }
    
    // Create output lookup map for this block
    let block_outputs: HashSet<Vec<u8>> = all_outputs.iter()
        .map(|o| o.commitment.clone())
        .collect();
        
    // Find which inputs spend outputs from this same block (internal spends)
    let internal_spends: HashSet<Vec<u8>> = all_inputs.iter()
        .filter(|input| block_outputs.contains(&input.commitment))
        .map(|input| input.commitment.clone())
        .collect();
        
    // Keep only external inputs (spending from previous blocks)
    let external_inputs: Vec<TransactionInput> = all_inputs.into_iter()
        .filter(|input| !block_outputs.contains(&input.commitment))
        .collect();
        
    // Keep only unspent outputs (not spent within this block)
    let unspent_outputs: Vec<TransactionOutput> = all_outputs.into_iter()
        .filter(|output| !internal_spends.contains(&output.commitment))
        .collect();
    
    // Create new transaction list with cut-through applied to inputs/outputs
    // but keeping all kernels separate to preserve their signatures
    let mut new_transactions = Vec::new();
    
    // First transaction gets all the inputs and outputs with the coinbase kernel
    new_transactions.push(Transaction {
        inputs: external_inputs,
        outputs: unspent_outputs,
        kernel: all_kernels[0].clone(), // Coinbase kernel
    });
    
    // Additional transactions for other kernels (with empty inputs/outputs)
    for kernel in all_kernels.into_iter().skip(1) {
        new_transactions.push(Transaction {
            inputs: vec![],
            outputs: vec![],
            kernel,
        });
    }
    
    self.transactions = new_transactions;
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
#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet::Wallet;
    use crate::mimblewimble;
    use curve25519_dalek::scalar::Scalar;

#[test]
fn test_apply_cut_through() {
    // Create some test wallets
    let alice = Wallet::new();
    let _bob = Wallet::new();
    let _charlie = Wallet::new();

    // Create an external UTXO that Alice already owns (from a previous block)
    let alice_external_blinding = Scalar::from(999u64);
    let alice_external_commitment = mimblewimble::commit(50_000_000, &alice_external_blinding)
        .unwrap().compress().to_bytes().to_vec();
    
    // Transaction 1: Alice (50 external) -> Bob (20) + Alice_change (29) + fee (1)
    let tx1_bob_blinding = Scalar::from(456u64);
    let tx1_change_blinding = Scalar::from(789u64);
    let tx1_kernel_blinding = alice_external_blinding - tx1_bob_blinding - tx1_change_blinding;
    
    let bob_commitment = mimblewimble::commit(20_000_000, &tx1_bob_blinding).unwrap();
    let alice_change_commitment = mimblewimble::commit(29_000_000, &tx1_change_blinding).unwrap();
    
    let (bob_range_proof, _) = mimblewimble::create_range_proof(20_000_000, &tx1_bob_blinding).unwrap();
    let (change_range_proof, _) = mimblewimble::create_range_proof(29_000_000, &tx1_change_blinding).unwrap();
    
    let tx1 = Transaction {
        inputs: vec![TransactionInput {
            commitment: alice_external_commitment.clone(),
            merkle_proof: None,
            source_height: 0,
        }],
        outputs: vec![
            TransactionOutput {
                commitment: bob_commitment.compress().to_bytes().to_vec(),
                range_proof: bob_range_proof.to_bytes(),
                ephemeral_key: None,
                stealth_payload: None,
            },
            TransactionOutput {
                commitment: alice_change_commitment.compress().to_bytes().to_vec(),
                range_proof: change_range_proof.to_bytes(),
                ephemeral_key: None,
                stealth_payload: None,
            },
        ],
        kernel: TransactionKernel::new(tx1_kernel_blinding, 1_000_000, 0).unwrap(),
    };
    
    // Transaction 2: Alice_change (29) -> Charlie (28) + fee (1)
    let tx2_charlie_blinding = Scalar::from(321u64);
    let tx2_kernel_blinding = tx1_change_blinding - tx2_charlie_blinding;
    
    let charlie_commitment = mimblewimble::commit(28_000_000, &tx2_charlie_blinding).unwrap();
    let (charlie_range_proof, _) = mimblewimble::create_range_proof(28_000_000, &tx2_charlie_blinding).unwrap();
    
    let tx2 = Transaction {
        inputs: vec![TransactionInput {
            commitment: alice_change_commitment.compress().to_bytes().to_vec(),
            merkle_proof: None,
            source_height: 0,
        }],
        outputs: vec![
            TransactionOutput {
                commitment: charlie_commitment.compress().to_bytes().to_vec(),
                range_proof: charlie_range_proof.to_bytes(),
                ephemeral_key: None,
                stealth_payload: None,
            },
        ],
        kernel: TransactionKernel::new(tx2_kernel_blinding, 1_000_000, 1).unwrap(),
    };

    // Create coinbase transaction
    let coinbase_tx = Transaction::create_coinbase(vec![
        (alice.scan_pub.compress().to_bytes().to_vec(), 50_000_000)
    ]).unwrap();

    // Create a block with coinbase and the two transactions
    let mut block = Block::genesis();
    block.height = 1;
    block.transactions = vec![coinbase_tx, tx1, tx2];
    
    // Store original kernel count
    let original_kernel_count = block.transactions.len();
    
    // Apply cut-through
    block.apply_cut_through().unwrap();
    
    // Verify results:
    
    // 1. Should still have 3 transactions (one per kernel)
    assert_eq!(block.transactions.len(), original_kernel_count, 
        "Should preserve one transaction per kernel");
    
    // 2. First transaction should have the external input and unspent outputs
    let first_tx = &block.transactions[0];
    assert_eq!(first_tx.inputs.len(), 1, "Should have one external input (Alice's from previous block)");
    assert_eq!(first_tx.inputs[0].commitment, alice_external_commitment, 
        "External input should be Alice's external UTXO");
    
    // Should have 3 outputs: coinbase + Bob's + Charlie's (Alice's change was cut through)
    assert_eq!(first_tx.outputs.len(), 3, "Should have three unspent outputs");
    
    // Verify the outputs contain Bob's and Charlie's
    let output_commitments: HashSet<Vec<u8>> = first_tx.outputs.iter()
        .map(|o| o.commitment.clone())
        .collect();
    assert!(output_commitments.contains(&bob_commitment.compress().to_bytes().to_vec()),
        "Should contain Bob's output");
    assert!(output_commitments.contains(&charlie_commitment.compress().to_bytes().to_vec()),
        "Should contain Charlie's output");
    
    // 3. Other transactions should be kernel-only
    for i in 1..block.transactions.len() {
        assert_eq!(block.transactions[i].inputs.len(), 0, 
            "Transaction {} should have no inputs", i);
        assert_eq!(block.transactions[i].outputs.len(), 0, 
            "Transaction {} should have no outputs", i);
    }
    
    // 4. All kernels should be preserved with correct fees
    assert_eq!(block.transactions[0].kernel.fee, 0, "Coinbase kernel fee");
    assert_eq!(block.transactions[1].kernel.fee, 1_000_000, "Tx1 kernel fee");
    assert_eq!(block.transactions[2].kernel.fee, 1_000_000, "Tx2 kernel fee");
    
    // 5. Verify total fees are preserved
    let total_fees: u64 = block.transactions.iter()
        .map(|tx| tx.kernel.fee)
        .sum();
    assert_eq!(total_fees, 2_000_000, "Total fees should be preserved");
}

    #[test]
    fn test_cut_through_with_no_internal_spends() {
        // Test that cut-through works correctly when there are no internal spends
        let alice = Wallet::new();
        let _bob = Wallet::new();
        
        let coinbase_tx = Transaction::create_coinbase(vec![
            (alice.scan_pub.compress().to_bytes().to_vec(), 50_000_000)
        ]).unwrap();
        
        // Create a transaction spending external UTXO (not from this block)
        let external_commitment = mimblewimble::commit(30_000_000, &Scalar::from(999u64))
            .unwrap().compress().to_bytes().to_vec();
        
        let bob_blinding = Scalar::from(111u64);
        let bob_commitment = mimblewimble::commit(29_000_000, &bob_blinding).unwrap();
        let (bob_range_proof, _) = mimblewimble::create_range_proof(29_000_000, &bob_blinding).unwrap();
        
        let tx = Transaction {
            inputs: vec![TransactionInput {
                commitment: external_commitment.clone(),
                merkle_proof: None,
                source_height: 0,
            }],
            outputs: vec![TransactionOutput {
                commitment: bob_commitment.compress().to_bytes().to_vec(),
                range_proof: bob_range_proof.to_bytes(),
                ephemeral_key: None,
                stealth_payload: None,
            }],
            kernel: TransactionKernel::new(Scalar::from(888u64), 1_000_000, 0).unwrap(),
        };
        
        let mut block = Block::genesis();
        block.height = 1;
        block.transactions = vec![coinbase_tx, tx];
        
        let original_inputs = block.transactions.iter()
            .flat_map(|tx| tx.inputs.clone())
            .collect::<Vec<_>>();
        let original_outputs = block.transactions.iter()
            .flat_map(|tx| tx.outputs.clone())
            .collect::<Vec<_>>();
        
        block.apply_cut_through().unwrap();
        
        // With no internal spends, inputs and outputs should be unchanged
        let new_inputs = block.transactions[0].inputs.clone();
        let new_outputs: Vec<_> = block.transactions[0].outputs.clone();
        
        assert_eq!(new_inputs, original_inputs, "Inputs should be unchanged");
        assert_eq!(new_outputs.len(), original_outputs.len(), 
            "Output count should be unchanged");
    }
}
