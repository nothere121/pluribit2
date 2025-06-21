// src/wallet.rs
// Manages user keys, UTXOs, transaction creation, and blockchain scanning.

use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::ristretto::{RistrettoPoint, CompressedRistretto};
use rand::rngs::OsRng;
use serde::{Serialize, Deserialize};

use crate::{
    block::Block,
    mimblewimble, // For commit() and create_range_proof()
    stealth,      // For stealth address primitives
    transaction::{Transaction, TransactionInput, TransactionOutput, TransactionKernel},
};

/// Represents a UTXO that the wallet owns and can spend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletUtxo {
    pub value: u64,
    pub blinding: Scalar,
    pub commitment: CompressedRistretto,
}

/// The main Wallet struct, holding keys and owned funds.
#[derive(Debug, Clone, Serialize, Deserialize)] 
pub struct Wallet {
    pub scan_priv: Scalar,
    pub spend_priv: Scalar,
    pub scan_pub: RistrettoPoint,
    pub spend_pub: RistrettoPoint,
    pub owned_utxos: Vec<WalletUtxo>,
}

impl Wallet {
    /// Creates a new wallet with randomly generated scan and spend keys.
    pub fn new() -> Self {
        let scan_priv = mimblewimble::generate_secret_key();
        let spend_priv = mimblewimble::generate_secret_key();
        let scan_pub = mimblewimble::derive_public_key(&scan_priv);
        let spend_pub = mimblewimble::derive_public_key(&spend_priv);

        Wallet {
            scan_priv,
            spend_priv,
            scan_pub,
            spend_pub,
            owned_utxos: Vec::new(),
        }
    }

    /// Calculates the wallet's total balance from its owned UTXOs.
    pub fn balance(&self) -> u64 {
        self.owned_utxos.iter().map(|utxo| utxo.value).sum()
    }

    /// Scans a block for outputs belonging to this wallet using the stealth protocol.
    pub fn scan_block(&mut self, block: &Block) {
        for tx in &block.transactions {
            for output in &tx.outputs {
                // Check if the output has the necessary data for a stealth payment.
                if let (Some(r_bytes), Some(payload)) = (&output.ephemeral_key, &output.stealth_payload) {
                    if let Ok(compressed_point) = CompressedRistretto::from_slice(r_bytes) {
                        if let Some(r_point) = compressed_point.decompress() {
                        
                            // 1. Attempt to decrypt the payload with our private scan key.
                            if let Some((value, blinding)) = stealth::decrypt_stealth_output(&self.scan_priv, &r_point, payload) {
                                
                                // 2. If successful, verify the commitment matches the on-chain one.
                                let commitment = mimblewimble::commit(value, &blinding).unwrap();
                                if commitment.compress().to_bytes().to_vec() == output.commitment {
                                    
                                    // 3. We own this output. Add it to our UTXO set.
                                    println!("[WALLET] Found incoming UTXO! Value: {}", value);
                                    self.owned_utxos.push(WalletUtxo {
                                        value,
                                        blinding,
                                        commitment: commitment.compress(),
                                    });
                                }
                            }
                        }
                    }/////
                }
            }
        }
    }

    /// Creates a transaction to send a specified amount to a recipient.
    pub fn create_transaction(
        &mut self,
        amount: u64,
        fee: u64,
        recipient_scan_pub: &RistrettoPoint,
    ) -> Result<Transaction, String> {
        let total_needed = amount + fee;

        // 1. Coin Selection: Find UTXOs to fund the transaction.
        let mut inputs_to_spend = Vec::new();
        let mut input_utxos = Vec::new();
        let mut total_available = 0;
        let mut blinding_sum_in = Scalar::default();

        // Simple greedy selection
        self.owned_utxos.retain(|utxo| {
            if total_available < total_needed {
                total_available += utxo.value;
                blinding_sum_in += utxo.blinding;
                inputs_to_spend.push(TransactionInput { commitment: utxo.commitment.to_bytes().to_vec() });
                input_utxos.push(utxo.clone());
                false // Remove from available UTXOs
            } else {
                true // Keep in available UTXOs
            }
        });

        if total_available < total_needed {
            // If funds are insufficient, return the selected UTXOs to the wallet
            self.owned_utxos.extend(input_utxos);
            return Err("Insufficient funds".to_string());
        }

        // 2. Create Outputs
        let mut outputs = Vec::new();
        let mut blinding_sum_out = Scalar::default();

        // a. Create the recipient's stealth output
        let (recipient_output, recipient_blinding) = create_stealth_output(amount, recipient_scan_pub)?;
        outputs.push(recipient_output);
        blinding_sum_out += recipient_blinding;

        // b. Create change output back to ourselves, if necessary
        let change = total_available - total_needed;
        if change > 0 {
            // Send change back to our own stealth address
            let (change_output, change_blinding) = create_stealth_output(change, &self.scan_pub)?;
            let change_utxo = WalletUtxo {
                value: change,
                blinding: change_blinding,
                commitment: CompressedRistretto::from_slice(&change_output.commitment).unwrap(),
            };
            outputs.push(change_output);
            blinding_sum_out += change_blinding;
            // Immediately add change UTXO back to our owned set
            self.owned_utxos.push(change_utxo); 
        }

        // 3. Create the Transaction Kernel
        // The kernel excess is the difference between output and input blinding factors
        let kernel_blinding = blinding_sum_out - blinding_sum_in;
        let kernel = TransactionKernel::new(kernel_blinding, fee)?;

        // 4. Assemble the final transaction
        Ok(Transaction {
            inputs: inputs_to_spend,
            outputs,
            kernel,
        })
    }
}

/// A private helper function to create a single stealth output.
/// Returns the transaction output and the blinding factor used.
fn create_stealth_output(
    value: u64,
    scan_pub: &RistrettoPoint,
) -> Result<(TransactionOutput, Scalar), String> {
    let r = Scalar::random(&mut OsRng);
    let blinding = Scalar::random(&mut OsRng);

    let (ephemeral_key, payload) = stealth::encrypt_stealth_out(&r, scan_pub, value, &blinding);

    let (range_proof, commitment) = mimblewimble::create_range_proof(value, &blinding)
        .map_err(|e| e.to_string())?;

    Ok((
        TransactionOutput {
            commitment: commitment.to_bytes().to_vec(),
            range_proof: range_proof.to_bytes(),
            ephemeral_key: Some(ephemeral_key.compress().to_bytes().to_vec()),
            stealth_payload: Some(payload),
        },
        blinding,
    ))
}


