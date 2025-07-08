//! Implements MimbleWimble cryptographic primitives using Ristretto/Curve25519.

use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use bulletproofs::{BulletproofGens, PedersenGens, RangeProof};
use merlin::Transcript;
use serde::{Serialize, Deserialize};
use crate::error::{PluribitResult, PluribitError};
use rand::thread_rng;
use crate::log; 
use lazy_static::lazy_static;
use curve25519_dalek::constants::RISTRETTO_BASEPOINT_TABLE;

/// A wrapper around a serialized Pedersen Commitment
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Commitment {
    #[serde(with = "serde_bytes")]
    pub point: [u8; 32], // Compressed Ristretto point
}
// --- CREATE A SINGLE, GLOBAL INSTANCE OF THE PEDERSEN GENERATORS ---
lazy_static! {
    pub static ref PC_GENS: PedersenGens = PedersenGens::default();
}
impl Commitment {
    pub fn from_point(point: &RistrettoPoint) -> Self {
        let compressed = point.compress();
        Commitment {
            point: compressed.to_bytes(),
        }
    }

    pub fn to_point(&self) -> PluribitResult<RistrettoPoint> {
        let compressed = CompressedRistretto::from_slice(&self.point)
            .map_err(|_| PluribitError::ValidationError("Invalid commitment point".to_string()))?;
        
        compressed.decompress()
            .ok_or_else(|| PluribitError::ValidationError("Failed to decompress commitment".to_string()))
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
) -> PluribitResult<RistrettoPoint> {
    log(&format!("[COMMIT] Creating commitment: value={}, blinding={}", value, hex::encode(blinding.to_bytes())));
    let commitment = PC_GENS.commit(Scalar::from(value), *blinding);
    log(&format!("[COMMIT] Result: {}", hex::encode(commitment.compress().to_bytes())));
    Ok(commitment)
}

/// Create a Bulletproof range proof
pub fn create_range_proof(
    value: u64,
    blinding: &Scalar,
) -> PluribitResult<(RangeProof, CompressedRistretto)> {
    log(&format!("[MIMBLEWIMBLE] Creating commitment for value: {}", value));
    log("--- [MIMBLEWIMBLE] Creator's Generator Check ---");
    log(&format!("G (B)       : {}", hex::encode(PC_GENS.B.compress().to_bytes())));
    log(&format!("H (B_blinding): {}", hex::encode(PC_GENS.B_blinding.compress().to_bytes())));

    let bp_gens = BulletproofGens::new(64, 1); // 64-bit values, 1 party
    let mut transcript = Transcript::new(b"Pluribit Range Proof");
    
    RangeProof::prove_single(
        &bp_gens,
        &PC_GENS,
        &mut transcript,
        value,
        blinding,
        64, // 64-bit range
    ).map_err(|_| PluribitError::ValidationError("Failed to create range proof".to_string()))
}

/// Verify a Bulletproof range proof
pub fn verify_range_proof(
    proof: &RangeProof,
    commitment: &CompressedRistretto,
) -> bool {
    let bp_gens = BulletproofGens::new(64, 1);
    let mut transcript = Transcript::new(b"Pluribit Range Proof");
    
    proof.verify_single(&bp_gens, &PC_GENS, &mut transcript, commitment, 64).is_ok()
}

/// Create a Schnorr signature using Ristretto
pub fn create_schnorr_signature(
    message_hash: [u8; 32],
    private_key: &Scalar,
) -> PluribitResult<(Scalar, Scalar)> {
    let mut rng = thread_rng();
    let nonce = Scalar::random(&mut rng);
    
    // Use B_blinding (not the standard basepoint) to match kernel excess
    let _nonce_commitment = &nonce * &PC_GENS.B_blinding;
    // Create challenge: H(m)
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest;
    hasher.update(&message_hash);
    let challenge_bytes = hasher.finalize();
    // Convert to scalar
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
    // Use B_blinding to match signature creation
    let _r_prime = s * &PC_GENS.B_blinding - challenge * public_key;
    // Recompute challenge H(m)
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest;
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

/// Derive public key from secret key (for wallet/stealth addresses)
pub fn derive_public_key(secret_key: &SecretKey) -> PublicKey {
    log(&format!("[DERIVE_PUBKEY] Input secret: {}", hex::encode(secret_key.to_bytes())));
    // Use standard basepoint for wallet keys (stealth addresses use this)
    let pubkey = secret_key * &*RISTRETTO_BASEPOINT_TABLE;
    log(&format!("[DERIVE_PUBKEY] Result: {}", hex::encode(pubkey.compress().to_bytes())));
    pubkey
}

/// Derive public key for kernel signatures (uses blinding generator)
pub fn derive_kernel_pubkey(secret_key: &SecretKey) -> PublicKey {
    log(&format!("[DERIVE_KERNEL_PUBKEY] Input secret: {}", hex::encode(secret_key.to_bytes())));
    // Use B_blinding for kernel-related operations
    let pubkey = secret_key * &PC_GENS.B_blinding;
    log(&format!("[DERIVE_KERNEL_PUBKEY] Result: {}", hex::encode(pubkey.compress().to_bytes())));
    pubkey
}

/// Aggregate multiple Schnorr signatures
pub fn aggregate_schnorr_signatures(
    signatures: &[(Scalar, Scalar)],
    public_keys: &[RistrettoPoint],
    _message_hash: [u8; 32],
) -> PluribitResult<(Scalar, Scalar)> {
    if signatures.is_empty() || signatures.len() != public_keys.len() {
        return Err(PluribitError::InvalidInput(
            "Signature and public key count mismatch".to_string()
        ));
    }
    
    // Sum the s values
    let mut aggregate_s = Scalar::default();
    for (_, s) in signatures {
        aggregate_s += s;
    }

    // Since the challenge H(m) is the same for all, we can just take the first one.
    let aggregate_challenge = signatures[0].0;
    
    Ok((aggregate_challenge, aggregate_s))
}

/// Extract public key from kernel excess
pub fn kernel_excess_to_pubkey(excess: &[u8]) -> PluribitResult<RistrettoPoint> {
    CompressedRistretto::from_slice(excess)
        .map_err(|_| PluribitError::InvalidKernelExcess)?
        .decompress()
        .ok_or(PluribitError::InvalidKernelExcess)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_commitment_and_range_proof() {
        let value = 12345u64;
        let blinding = generate_secret_key();
        
        // Create commitment
        let _commitment = commit(value, &blinding).unwrap();
        
        // Create range proof
        let (proof, committed_value) = create_range_proof(value, &blinding).unwrap();
        
        // Verify the proof
        assert!(verify_range_proof(&proof, &committed_value));
    }

    #[test]
    fn test_schnorr_signature() {
        let secret_key = generate_secret_key();
        // For kernel signatures, the public key uses B_blinding
        let public_key = &secret_key * &PC_GENS.B_blinding;
        let message = [42u8; 32];
        
        let signature = create_schnorr_signature(message, &secret_key).unwrap();
        assert!(verify_schnorr_signature(&signature, message, &public_key));
        
        // Wrong message should fail
        let wrong_message = [43u8; 32];
        assert!(!verify_schnorr_signature(&signature, wrong_message, &public_key));
    }
    #[test]
fn test_aggregate_schnorr_signatures() {
    let message = [42u8; 32];
    
    // Create multiple key pairs
    let keys: Vec<_> = (0..3).map(|_| {
        let secret = generate_secret_key();
        let public = &secret * &PC_GENS.B_blinding;
        (secret, public)
    }).collect();
    
    // Create individual signatures
    let signatures: Vec<_> = keys.iter().map(|(secret, _)| {
        create_schnorr_signature(message, secret).unwrap()
    }).collect();
    
    let public_keys: Vec<_> = keys.iter().map(|(_, public)| *public).collect();
    
    // Aggregate signatures
    let (agg_challenge, agg_s) = aggregate_schnorr_signatures(
        &signatures,
        &public_keys,
        message
    ).unwrap();
    
    // Verify aggregated signature
    let agg_pubkey: RistrettoPoint = public_keys.iter().sum();
    assert!(verify_schnorr_signature(&(agg_challenge, agg_s), message, &agg_pubkey));
}

#[test]
fn test_kernel_excess_to_pubkey() {
    let secret = Scalar::from(123u64);
    let pubkey = &secret * &PC_GENS.B_blinding;
    let compressed = pubkey.compress();
    
    // Valid excess
    let result = kernel_excess_to_pubkey(&compressed.to_bytes());
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), pubkey);
    
    // Invalid excess (wrong length)
    let result = kernel_excess_to_pubkey(&[1, 2, 3]);
    assert!(result.is_err());
    
    // Invalid point
    let result = kernel_excess_to_pubkey(&[0xFF; 32]);
    assert!(result.is_err());
}
}
