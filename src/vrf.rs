// src/vrf.rs
use curve25519_dalek::constants::RISTRETTO_BASEPOINT_TABLE;
use curve25519_dalek::ristretto::{RistrettoPoint, CompressedRistretto};
use curve25519_dalek::scalar::Scalar;
use sha2::{Sha256, Digest};
use serde::{Serialize, Deserialize};
use rand::thread_rng;


/// VRF proof data structure
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VrfProof {
    pub gamma: [u8; 32],
    pub c: [u8; 32],
    pub s: [u8; 32],
    pub output: [u8; 32],
}

impl Default for VrfProof {
    fn default() -> Self {
        VrfProof {
            gamma: [0u8; 32],
            c: [0u8; 32],
            s: [0u8; 32],
            output: [0u8; 32],
        }
    }
}

/// Hash arbitrary input to a curve point
fn hash_to_point(input: &[u8]) -> RistrettoPoint {
    let mut hasher = Sha256::new();
    hasher.update(b"pluribit_vrf_h2p_v1");
    hasher.update(input);
    let hash_bytes: [u8; 32] = hasher.finalize().into();
    let hash_scalar = Scalar::from_bytes_mod_order(hash_bytes);
    &hash_scalar * &*RISTRETTO_BASEPOINT_TABLE
}

/// Create a VRF proof
pub fn create_vrf(secret_key: &Scalar, input: &[u8]) -> VrfProof {
    println!("=== CREATE_VRF DEBUG ===");
    println!("Input: {:?}", hex::encode(input));
    println!("Secret key: {}", hex::encode(secret_key.to_bytes()));
    
    // Hash input to curve point
    let h = hash_to_point(input);
    println!("H point: {}", hex::encode(h.compress().to_bytes()));
    
    // Compute gamma = x*H
    let gamma = secret_key * &h;
    println!("Gamma: {}", hex::encode(gamma.compress().to_bytes()));
    
    // Generate random nonce
    let mut rng = thread_rng();
    let k = Scalar::random(&mut rng);
    println!("Nonce k: {}", hex::encode(k.to_bytes()));
    
    // Compute k*G and k*H
    let k_g = &k * &*RISTRETTO_BASEPOINT_TABLE;
    let k_h = &k * &h;
    println!("k*G: {}", hex::encode(k_g.compress().to_bytes()));
    println!("k*H: {}", hex::encode(k_h.compress().to_bytes()));
    
    // Compute challenge c = H(h, gamma, k*G, k*H)
    let mut hasher = Sha256::new();
    hasher.update(b"pluribit_vrf_challenge_v1");
    hasher.update(&h.compress().to_bytes());
    hasher.update(&gamma.compress().to_bytes());
    hasher.update(&k_g.compress().to_bytes());
    hasher.update(&k_h.compress().to_bytes());
    let c_bytes: [u8; 32] = hasher.finalize().into();
    println!("Challenge bytes (raw): {}", hex::encode(&c_bytes));
    
    let c_scalar = Scalar::from_bytes_mod_order(c_bytes);
    println!("Challenge scalar: {}", hex::encode(c_scalar.to_bytes()));
    
    // Compute s = k + c*x
    let s_scalar = k + (c_scalar * secret_key);
    println!("s = k + c*x: {}", hex::encode(s_scalar.to_bytes()));
    
    // Compute VRF output
    let mut output_hasher = Sha256::new();
    output_hasher.update(b"pluribit_vrf_output_v1");
    output_hasher.update(&gamma.compress().to_bytes());
    let output: [u8; 32] = output_hasher.finalize().into();
    println!("VRF output: {}", hex::encode(&output));
    
    VrfProof {
        gamma: gamma.compress().to_bytes(),
        c: c_bytes,  // Store the raw hash bytes, not the scalar bytes!
        s: s_scalar.to_bytes(),
        output,
    }
}

/// Verify a VRF proof
pub fn verify_vrf(public_key: &RistrettoPoint, input: &[u8], proof: &VrfProof) -> bool {
    println!("\n=== VERIFY_VRF DEBUG ===");
    println!("Input: {:?}", hex::encode(input));
    println!("Public key: {}", hex::encode(public_key.compress().to_bytes()));
    println!("Proof gamma: {}", hex::encode(&proof.gamma));
    println!("Proof c: {}", hex::encode(&proof.c));
    println!("Proof s: {}", hex::encode(&proof.s));
    
    // Recompute h = H(input)
    let h = hash_to_point(input);
    println!("H point: {}", hex::encode(h.compress().to_bytes()));
    
    // Parse scalars from proof
    let c_scalar = Scalar::from_bytes_mod_order(proof.c);
    let s_scalar = Scalar::from_bytes_mod_order(proof.s);
    println!("Parsed c_scalar: {}", hex::encode(c_scalar.to_bytes()));
    println!("Parsed s_scalar: {}", hex::encode(s_scalar.to_bytes()));

    // Parse gamma point
    let gamma_compressed = match CompressedRistretto::from_slice(&proof.gamma) {
        Ok(p) => p,
        Err(_) => {
            eprintln!("Failed to parse gamma point from bytes");
            return false;
        }
    };
    
    let gamma_point = match gamma_compressed.decompress() {
        Some(p) => p,
        None => {
            eprintln!("Failed to decompress gamma point");
            return false;
        }
    };
    println!("Gamma point decompressed successfully");

    // Compute u = s*G - c*PK (should equal k*G)
    let s_g = &s_scalar * &*RISTRETTO_BASEPOINT_TABLE;
    let c_pk = &c_scalar * public_key;
    let u_check = s_g - c_pk;
    println!("s*G: {}", hex::encode(s_g.compress().to_bytes()));
    println!("c*PK: {}", hex::encode(c_pk.compress().to_bytes()));
    println!("u_check (s*G - c*PK): {}", hex::encode(u_check.compress().to_bytes()));

    // Compute v = s*H - c*Gamma (should equal k*H)
    let s_h = &s_scalar * &h;
    let c_gamma = &c_scalar * &gamma_point;
    let v_check = s_h - c_gamma;
    println!("s*H: {}", hex::encode(s_h.compress().to_bytes()));
    println!("c*Gamma: {}", hex::encode(c_gamma.compress().to_bytes()));
    println!("v_check (s*H - c*Gamma): {}", hex::encode(v_check.compress().to_bytes()));

    // Recompute challenge
    let mut hasher = Sha256::new();
    hasher.update(b"pluribit_vrf_challenge_v1");
    hasher.update(&h.compress().to_bytes());
    hasher.update(&gamma_point.compress().to_bytes());
    hasher.update(&u_check.compress().to_bytes());
    hasher.update(&v_check.compress().to_bytes());
    let c_recomputed: [u8; 32] = hasher.finalize().into();
    
    println!("\nChallenge computation:");
    println!("  Domain: pluribit_vrf_challenge_v1");
    println!("  H: {}", hex::encode(&h.compress().to_bytes()));
    println!("  Gamma: {}", hex::encode(&gamma_point.compress().to_bytes()));
    println!("  u_check: {}", hex::encode(&u_check.compress().to_bytes()));
    println!("  v_check: {}", hex::encode(&v_check.compress().to_bytes()));
    
    // Check challenge matches
    if c_recomputed != proof.c {
        eprintln!("Challenge mismatch!");
        eprintln!("Expected: {}", hex::encode(&proof.c));
        eprintln!("Got: {}", hex::encode(&c_recomputed));
        return false;
    }
    println!("Challenge verified!");

    // Verify output
    let mut output_hasher = Sha256::new();
    output_hasher.update(b"pluribit_vrf_output_v1");
    output_hasher.update(&proof.gamma);
    let expected_output: [u8; 32] = output_hasher.finalize().into();
    
    if expected_output != proof.output {
        eprintln!("Output mismatch!");
        return false;
    }
    println!("Output verified!");
    
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use curve25519_dalek::constants::RISTRETTO_BASEPOINT_TABLE;
    use crate::mimblewimble;

    #[test]
    fn test_vrf_roundtrip() {
        let secret_key = mimblewimble::generate_secret_key();
        let public_key = &secret_key * &*RISTRETTO_BASEPOINT_TABLE;
        let input = b"test input";
        
        let proof = create_vrf(&secret_key, input);
        let is_valid = verify_vrf(&public_key, input, &proof);
        
        assert!(is_valid, "VRF proof should be valid");
    }

    #[test]
    fn test_vrf_wrong_key_fails() {
        let secret_key1 = mimblewimble::generate_secret_key();
        let secret_key2 = mimblewimble::generate_secret_key();
        let public_key2 = &secret_key2 * &*RISTRETTO_BASEPOINT_TABLE;
        let input = b"test input";
        
        let proof = create_vrf(&secret_key1, input);
        let is_valid = verify_vrf(&public_key2, input, &proof);
        
        assert!(!is_valid, "VRF proof should fail with wrong key");
    }
}
