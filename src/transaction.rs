// src/transaction.rs

use serde::{Serialize, Deserialize};
use crate::error::{BitQuillResult, BitQuillError};
use bulletproofs::RangeProof;
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use sha2::{Digest, Sha256};
use crate::mimblewimble;
use crate::blockchain::UTXO_SET;
use curve25519_dalek::traits::Identity;
use curve25519_dalek::constants::RISTRETTO_BASEPOINT_TABLE;


#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct TransactionInput {
    pub commitment: Vec<u8>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct TransactionOutput {
    pub commitment: Vec<u8>,
    pub range_proof: Vec<u8>,
    pub ephemeral_key: Option<Vec<u8>>, // Stores the sender's ephemeral public key R
    pub stealth_payload: Option<Vec<u8>>, // Stores the encrypted nonce || cipher
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct TransactionKernel {
    pub excess: Vec<u8>,       // Compressed Ristretto public key
    pub signature: Vec<u8>,    // Schnorr signature bytes (challenge || s)
    pub fee: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Transaction {
    pub inputs: Vec<TransactionInput>,
    pub outputs: Vec<TransactionOutput>,
    pub kernel: TransactionKernel,
}


impl TransactionKernel {
    
    pub fn new(blinding: Scalar, fee: u64) -> Result<Self, String> {
        let excess = mimblewimble::derive_public_key(&blinding);
        let message_hash: [u8; 32] = Sha256::digest(format!("fee:{}", fee).as_bytes()).into();

        let (challenge, s) = mimblewimble::create_schnorr_signature(message_hash, &blinding)
            .map_err(|e| e.to_string())?;

        let mut signature = Vec::with_capacity(64);
        signature.extend_from_slice(&challenge.to_bytes());
        signature.extend_from_slice(&s.to_bytes());

        Ok(TransactionKernel {
            excess: excess.compress().to_bytes().to_vec(),
            signature,
            fee,
        })
    }
    
    /// Properly aggregate multiple kernels with signature aggregation
    pub fn aggregate(kernels: &[TransactionKernel]) -> BitQuillResult<TransactionKernel> {
        
        
        if kernels.is_empty() {
            return Err(BitQuillError::InvalidInput("No kernels to aggregate".to_string()));
        }
        
        if kernels.len() == 1 {
            return Ok(kernels[0].clone());
        }
        
        let mut total_fee = 0u64;
        let mut signatures = Vec::new();
        let mut public_keys = Vec::new();
        
        // Collect all signatures and public keys
        for kernel in kernels {
            total_fee += kernel.fee;
            
            // Extract public key from excess
            let pubkey = mimblewimble::kernel_excess_to_pubkey(&kernel.excess)?;
            public_keys.push(pubkey);
            
            // Parse signature
            if kernel.signature.len() != 64 {
                return Err(BitQuillError::InvalidKernelSignature);
            }
            
            let challenge = Scalar::from_bytes_mod_order(
                kernel.signature[0..32].try_into()
                    .map_err(|_| BitQuillError::InvalidKernelSignature)?
            );
            let s = Scalar::from_bytes_mod_order(
                kernel.signature[32..64].try_into()
                    .map_err(|_| BitQuillError::InvalidKernelSignature)?
            );
            
            signatures.push((challenge, s));
        }
        
        // Aggregate public keys (sum of all excesses)
        let aggregate_pubkey: RistrettoPoint = public_keys.iter().sum();
        
        // Create message hash for aggregated kernel
        let mut hasher = Sha256::new();
        hasher.update(&total_fee.to_le_bytes());
        let message_hash: [u8; 32] = hasher.finalize().into();
        
        // Aggregate signatures
        let (agg_challenge, agg_s) = mimblewimble::aggregate_schnorr_signatures(
            &signatures,
            &public_keys,
            message_hash
        )?;
        
        // Serialize aggregated signature
        let mut signature_bytes = Vec::with_capacity(64);
        signature_bytes.extend_from_slice(&agg_challenge.to_bytes());
        signature_bytes.extend_from_slice(&agg_s.to_bytes());
        
        Ok(TransactionKernel {
            excess: aggregate_pubkey.compress().to_bytes().to_vec(),
            signature: signature_bytes,
            fee: total_fee,
        })
    }
}

impl Transaction {
    /// Verify this transaction end-to-end:
    /// 1) All range proofs validate
    /// 2) Kernel Schnorr signature is correct
    /// 3) Sum(inputs) == Sum(outputs) + excess
    /// 4) All inputs exist in the UTXO set
    #[allow(non_snake_case)]
    pub fn verify(&self) -> BitQuillResult<bool> {
        // 1) Range proofs
        for output in &self.outputs {
            let C = CompressedRistretto::from_slice(&output.commitment)
                .map_err(|_| BitQuillError::InvalidOutputCommitment)?;
            let proof = RangeProof::from_bytes(&output.range_proof)
                .map_err(|_| BitQuillError::InvalidRangeProof)?;
            if !mimblewimble::verify_range_proof(&proof, &C) {
                return Err(BitQuillError::InvalidRangeProof);
            }
        }

        // 2) Schnorr kernel signature
        let excess_compressed = CompressedRistretto::from_slice(&self.kernel.excess)
            .map_err(|_| BitQuillError::InvalidKernelExcess)?;
        let P = excess_compressed.decompress()
            .ok_or(BitQuillError::InvalidKernelExcess)?;
        if self.kernel.signature.len() != 64 {
            return Err(BitQuillError::InvalidKernelSignature);
        }
        let mut challenge_bytes = [0u8; 32];
        challenge_bytes.copy_from_slice(&self.kernel.signature[0..32]);
        let mut s_bytes = [0u8; 32];
        s_bytes.copy_from_slice(&self.kernel.signature[32..64]);
        let challenge = Scalar::from_bytes_mod_order(challenge_bytes);
        let s = Scalar::from_bytes_mod_order(s_bytes);

        // Recompute message hash (fee || lock_height || …)
        let mut hasher = Sha256::new();
        hasher.update(&self.kernel.fee.to_le_bytes());
        let msg_hash: [u8; 32] = hasher.finalize().into();

        if !mimblewimble::verify_schnorr_signature(&(challenge, s), msg_hash, &P) {
            return Err(BitQuillError::InvalidKernelSignature);
        }

        // 3) Balance check
        let mut sum_in = RistrettoPoint::identity();
        for inp in &self.inputs {
            let C = CompressedRistretto::from_slice(&inp.commitment)
                .map_err(|_| BitQuillError::InvalidInputCommitment)?
                .decompress()
                .ok_or(BitQuillError::InvalidInputCommitment)?;
            sum_in += C;
        }
        let mut sum_out = RistrettoPoint::identity();
        for out in &self.outputs {
            let C = CompressedRistretto::from_slice(&out.commitment)
                .map_err(|_| BitQuillError::InvalidOutputCommitment)?
                .decompress()
                .ok_or(BitQuillError::InvalidOutputCommitment)?;
            sum_out += C;
        }
        sum_out += P; // add kernel excess
        if sum_in != sum_out {
            return Err(BitQuillError::Imbalance);
        }

        // 4) UTXO existence
        let utxos = UTXO_SET.lock().unwrap();
        for inp in &self.inputs {
            if !utxos.contains_key(&inp.commitment) {
                return Err(BitQuillError::UnknownInput);
            }
        }

        Ok(true)
    }

    /// Create a coinbase transaction (no inputs, only outputs)
    pub fn create_coinbase(rewards: Vec<(Vec<u8>, u64)>) -> BitQuillResult<Self> {
        use crate::stealth;
        use rand::rngs::OsRng;
        
        let mut outputs = Vec::new();
        //let mut total_reward = 0u64;
        let mut blinding_sum = Scalar::default();
        
        // Create stealth output for each recipient
        for (recipient_pub_key_bytes, amount) in rewards {
            
            // Parse the public key bytes that were passed in
            let scan_pub_compressed = CompressedRistretto::from_slice(&recipient_pub_key_bytes)
                .map_err(|_| BitQuillError::ValidationError("Invalid public key".to_string()))?;

            let scan_pub = scan_pub_compressed.decompress()
                .ok_or_else(|| BitQuillError::ValidationError("Failed to decompress public key".to_string()))?;
            
            
            // Create stealth output
            let r = Scalar::random(&mut OsRng);
            let blinding = Scalar::random(&mut OsRng);
            let (ephemeral_key, payload) = stealth::encrypt_stealth_out(&r, &scan_pub, amount, &blinding);
            
            let (proof, commitment) = mimblewimble::create_range_proof(amount, &blinding)?;
            
            outputs.push(TransactionOutput {
                commitment: commitment.to_bytes().to_vec(),
                range_proof: proof.to_bytes(),
                ephemeral_key: Some(ephemeral_key.compress().to_bytes().to_vec()),
                stealth_payload: Some(payload),
            });
            
           // total_reward += amount;
            blinding_sum += blinding;
        }
        
        // Create kernel with the sum of all blindings
        let excess = &blinding_sum * RISTRETTO_BASEPOINT_TABLE;
        let kernel_message_hash: [u8; 32] = Sha256::digest(b"coinbase").into();
        let (challenge, s) = mimblewimble::create_schnorr_signature(kernel_message_hash, &blinding_sum)?;
        
        let mut signature_bytes = Vec::new();
        signature_bytes.extend_from_slice(&challenge.to_bytes());
        signature_bytes.extend_from_slice(&s.to_bytes());
        
        Ok(Transaction {
            inputs: vec![],
            outputs,
            kernel: TransactionKernel {
                excess: excess.compress().to_bytes().to_vec(),
                signature: signature_bytes,
                fee: 0,
            },
        })
    }
    
    #[allow(non_snake_case)]
    pub fn verify_signature(&self) -> BitQuillResult<bool> {
        // This is already done in verify(), but we'll add it as a separate method
        let excess_compressed = CompressedRistretto::from_slice(&self.kernel.excess)
            .map_err(|_| BitQuillError::InvalidKernelExcess)?;
        let P = excess_compressed.decompress()
            .ok_or(BitQuillError::InvalidKernelExcess)?;
        
        if self.kernel.signature.len() != 64 {
            return Ok(false);
        }
        
        let mut challenge_bytes = [0u8; 32];
        challenge_bytes.copy_from_slice(&self.kernel.signature[0..32]);
        let mut s_bytes = [0u8; 32];
        s_bytes.copy_from_slice(&self.kernel.signature[32..64]);
        let challenge = Scalar::from_bytes_mod_order(challenge_bytes);
        let s = Scalar::from_bytes_mod_order(s_bytes);

        let mut hasher = Sha256::new();
        hasher.update(&self.kernel.fee.to_le_bytes());
        let msg_hash: [u8; 32] = hasher.finalize().into();

        Ok(mimblewimble::verify_schnorr_signature(&(challenge, s), msg_hash, &P))
    }
    /// Get a unique hash for this transaction based on kernel
    pub fn hash(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(&self.kernel.excess);
        hasher.update(&self.kernel.signature);
        hasher.update(&self.kernel.fee.to_le_bytes());
        hex::encode(hasher.finalize())
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::generate_random_utxo_set;
    use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT;

    #[test]
    fn test_transaction_roundtrip() {
        // Build a simple tx and verify it succeeds
        let input_commit = (5u64, &Scalar::from(5u64));
        let (C_in, _) = mimblewimble::create_range_proof(input_commit.0, input_commit.1).unwrap();
        let inp = TransactionInput { commitment: C_in.compress().to_bytes().to_vec() };
        // ... similarly build outputs, kernel, etc., and then:
        let tx = Transaction { inputs: vec![inp], outputs: vec![], kernel: TransactionKernel { excess: vec![], signature: vec![], fee: 0 } };
        // Inject into UTXO set
        let mut utxos = UTXO_SET.lock().unwrap();
        utxos.insert(inp.commitment.clone(), ());
        drop(utxos);
        assert!(tx.verify().unwrap());
    }
}
