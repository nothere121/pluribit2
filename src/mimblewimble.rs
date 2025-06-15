//! Implements MimbleWimble cryptographic primitives using Ristretto/Curve25519.

use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::constants::RISTRETTO_BASEPOINT_TABLE;
use bulletproofs::{BulletproofGens, PedersenGens, RangeProof};
use merlin::Transcript;
use serde::{Serialize, Deserialize};
use crate::error::{BitQuillResult, BitQuillError};
use rand::thread_rng;

/// A wrapper around a serialized Pedersen Commitment
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Commitment {
    #[serde(with = "serde_bytes")]
    pub point: [u8; 32], // Compressed Ristretto point
}

impl Commitment {
    pub fn from_point(point: &RistrettoPoint) -> Self {
        let compressed = point.compress();
        Commitment {
            point: compressed.to_bytes(),
        }
    }

    pub fn to_point(&self) -> BitQuillResult<RistrettoPoint> {
        let compressed = CompressedRistretto::from_slice(&self.point)
            .map_err(|_| BitQuillError::ValidationError("Invalid commitment point".to_string()))?;
        
        compressed.decompress()
            .ok_or_else(|| BitQuillError::ValidationError("Failed to decompress commitment".to_string()))
    }
}

/// Wrapper for RangeProof to allow serialization
#[derive(Debug, Clone)]  
pub struct SerializableRangeProof {
    pub inner: RangeProof,
}

impl Serialize for SerializableRangeProof {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let bytes = self.inner.to_bytes();
        serde_bytes::serialize(&bytes[..], serializer)
    }
}

impl<'de> Deserialize<'de> for SerializableRangeProof {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let bytes: Vec<u8> = serde_bytes::deserialize(deserializer)?;
        let inner = RangeProof::from_bytes(&bytes).map_err(serde::de::Error::custom)?;
        Ok(SerializableRangeProof { inner })
    }
}

/// Secret key type for Ristretto
pub type SecretKey = Scalar;

/// Public key type for Ristretto  
pub type PublicKey = RistrettoPoint;

/// Create a Pedersen commitment to a value with a blinding factor
pub fn commit(
    value: u64,
    blinding: &Scalar,
) -> BitQuillResult<RistrettoPoint> {
    let pc_gens = PedersenGens::default();
    Ok(pc_gens.commit(Scalar::from(value), *blinding))
}

/// Create a Bulletproof range proof
pub fn create_range_proof(
    value: u64,
    blinding: &Scalar,
) -> BitQuillResult<(RangeProof, CompressedRistretto)> {
    let pc_gens = PedersenGens::default();
    let bp_gens = BulletproofGens::new(64, 1); // 64-bit values, 1 party
    let mut transcript = Transcript::new(b"Pluribit Range Proof");
    
    RangeProof::prove_single(
        &bp_gens,
        &pc_gens,
        &mut transcript,
        value,
        blinding,
        64, // 64-bit range
    ).map_err(|_| BitQuillError::ValidationError("Failed to create range proof".to_string()))
}

/// Verify a Bulletproof range proof
pub fn verify_range_proof(
    proof: &RangeProof,
    commitment: &CompressedRistretto,
) -> bool {
    let pc_gens = PedersenGens::default();
    let bp_gens = BulletproofGens::new(64, 1);
    let mut transcript = Transcript::new(b"Pluribit Range Proof");
    
    proof.verify_single(&bp_gens, &pc_gens, &mut transcript, commitment, 64).is_ok()
}

/// Create a Schnorr signature using Ristretto
pub fn create_schnorr_signature(
    message_hash: [u8; 32],
    private_key: &Scalar,
) -> BitQuillResult<(Scalar, Scalar)> {
    let mut rng = thread_rng();
    let nonce = Scalar::random(&mut rng);
    let nonce_commitment = &nonce * RISTRETTO_BASEPOINT_TABLE;
    
    // Create challenge: H(R || P || m)
    let public_key = private_key * RISTRETTO_BASEPOINT_TABLE;
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest;
    hasher.update(nonce_commitment.compress().as_bytes());
    hasher.update(public_key.compress().as_bytes());
    hasher.update(&message_hash);
    let challenge_bytes = hasher.finalize();
    
    // Convert to scalar - the array is 32 bytes
    let mut challenge_array = [0u8; 32];
    challenge_array.copy_from_slice(&challenge_bytes);
    let challenge = Scalar::from_bytes_mod_order(challenge_array);
    
    // s = r + c * x
    let signature = nonce + challenge * private_key;
    
    Ok((challenge, signature))
}

/// Verify a Schnorr signature using Ristretto
pub fn verify_schnorr_signature(
    signature: &(Scalar, Scalar),
    message_hash: [u8; 32],
    public_key: &RistrettoPoint,
) -> bool {
    let (challenge, s) = signature;
    
    // Compute R' = s*G - c*P
    let r_prime = s * RISTRETTO_BASEPOINT_TABLE - challenge * public_key;
    
    // Recompute challenge
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest;
    hasher.update(r_prime.compress().as_bytes());
    hasher.update(public_key.compress().as_bytes());
    hasher.update(&message_hash);
    let challenge_bytes = hasher.finalize();
    
    // Convert to scalar
    let mut challenge_array = [0u8; 32];
    challenge_array.copy_from_slice(&challenge_bytes);
    let computed_challenge = Scalar::from_bytes_mod_order(challenge_array);
    
    // Verify challenge matches
    challenge == &computed_challenge
}

/// Generate a new secret key
pub fn generate_secret_key() -> SecretKey {
    let mut rng = thread_rng();
    Scalar::random(&mut rng)
}

/// Derive public key from secret key
pub fn derive_public_key(secret_key: &SecretKey) -> PublicKey {
    secret_key * RISTRETTO_BASEPOINT_TABLE
}



/// Aggregate multiple Schnorr signatures
pub fn aggregate_schnorr_signatures(
    signatures: &[(Scalar, Scalar)],
    public_keys: &[RistrettoPoint],
    message_hash: [u8; 32],
) -> BitQuillResult<(Scalar, Scalar)> {
    use curve25519_dalek::traits::Identity;
    
    if signatures.is_empty() || signatures.len() != public_keys.len() {
        return Err(BitQuillError::InvalidInput(
            "Signature and public key count mismatch".to_string()
        ));
    }
    
    // For multiple signatures on the same message, we can aggregate them
    // by summing the s values and using a combined challenge
    
    let mut aggregate_s = Scalar::default();

    let mut aggregate_nonce_point = RistrettoPoint::identity();
    
    // Reconstruct nonce commitments and aggregate
    for (i, (challenge, s)) in signatures.iter().enumerate() {
        // R = s*G - c*P
        let r_point = s * RISTRETTO_BASEPOINT_TABLE - challenge * &public_keys[i];
        aggregate_nonce_point += r_point;
        aggregate_s += s;
    }
    
    // Create new challenge for aggregated signature
    let aggregate_pubkey: RistrettoPoint = public_keys.iter().sum();
    
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest;
    hasher.update(aggregate_nonce_point.compress().as_bytes());
    hasher.update(aggregate_pubkey.compress().as_bytes());
    hasher.update(&message_hash);
    let challenge_bytes = hasher.finalize();
    
    let mut challenge_array = [0u8; 32];
    challenge_array.copy_from_slice(&challenge_bytes);
    let aggregate_challenge = Scalar::from_bytes_mod_order(challenge_array);
    
    Ok((aggregate_challenge, aggregate_s))
}

/// Extract public key from kernel excess
pub fn kernel_excess_to_pubkey(excess: &[u8]) -> BitQuillResult<RistrettoPoint> {
    CompressedRistretto::from_slice(excess)
        .map_err(|_| BitQuillError::InvalidKernelExcess)?
        .decompress()
        .ok_or(BitQuillError::InvalidKernelExcess)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_commitment_and_range_proof() {
        let value = 12345u64;
        let blinding = generate_secret_key();
        
        // Create commitment
        let commitment = commit(value, &blinding).unwrap();
        
        // Create range proof
        let (proof, committed_value) = create_range_proof(value, &blinding).unwrap();
        
        // Verify the proof
        assert!(verify_range_proof(&proof, &committed_value));
    }

    #[test]
    fn test_schnorr_signature() {
        let secret_key = generate_secret_key();
        let public_key = derive_public_key(&secret_key);
        let message = [42u8; 32];
        
        let signature = create_schnorr_signature(message, &secret_key).unwrap();
        assert!(verify_schnorr_signature(&signature, message, &public_key));
        
        // Wrong message should fail
        let wrong_message = [43u8; 32];
        assert!(!verify_schnorr_signature(&signature, wrong_message, &public_key));
    }
}
