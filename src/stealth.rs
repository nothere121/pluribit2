// src/stealth.rs
// Wallet-layer stealth subaddress primitives for Pluriƀit
use curve25519_dalek::constants::RISTRETTO_BASEPOINT_TABLE;

use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;
use sha2::{Sha256, Digest};
use chacha20poly1305::{
    aead::{Aead, KeyInit}, // Replace NewAead with KeyInit
    XChaCha20Poly1305, Key, XNonce
};
use rand_core::{OsRng, RngCore}; // RngCore is needed for the fill_bytes method

/// Hash-to-scalar function: H_s(label || data) -> Scalar
pub fn hash_to_scalar(label: &[u8], data: &[u8]) -> Scalar {
    let mut hasher = Sha256::new();
    hasher.update(label);
    hasher.update(data);
    let hash = hasher.finalize();
    Scalar::from_bytes_mod_order(hash.into())
}

/// Derive a stealth subaddress public key D_i = Hs("SubAddr"||Ps||i)*G + Pv
pub fn derive_subaddress(scan_pub: &RistrettoPoint, spend_pub: &RistrettoPoint, index: u32) -> RistrettoPoint {
    // Compress scan_pub to bytes
    let ps_bytes = scan_pub.compress().to_bytes();
    // i as big-endian
    let idx_bytes = index.to_be_bytes();
    // Compute Hs
    let tweak = hash_to_scalar(b"SubAddr", &[&ps_bytes[..], &idx_bytes[..]].concat());
    
    // CORRECTED: D_i = tweak*G + Pv
    // Use the RISTRETTO_BASEPOINT_TABLE for multiplication by G
    let tweak_g = &tweak * &*RISTRETTO_BASEPOINT_TABLE;
    tweak_g + spend_pub
}

/// Encrypt a stealth output: returns (R, ciphertext)
/// - r: ephemeral secret scalar
/// - scan_pub: recipient's public scan key
/// - value: u64 amount
/// - blinding: blinding factor scalar
pub fn encrypt_stealth_out(
    r: &Scalar,
    scan_pub: &RistrettoPoint,
    value: u64,
    blinding: &Scalar,
) -> (RistrettoPoint, Vec<u8>) {
    // CORRECTED: R = r*G
    let r_point = r * &*RISTRETTO_BASEPOINT_TABLE;

    // Shared secret S = Hs(r * Ps)
    let rps = (scan_pub * r).compress().to_bytes();
    let s = hash_to_scalar(b"Stealth", &rps);

    // Derive symmetric key from shared secret
    let key = Key::from_slice(s.as_bytes());
    let cipher = XChaCha20Poly1305::new(key);

    // Random nonce
    let mut nonce_bytes = [0u8; 24];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);

    // Serialize plaintext: 8 bytes value || 32 bytes blinding
    let mut pt = Vec::with_capacity(40);
    pt.extend_from_slice(&value.to_be_bytes());
    pt.extend_from_slice(blinding.as_bytes());

    // Encrypt
    let ct = cipher.encrypt(nonce, pt.as_ref())
        .expect("encryption failure");

    // Output: nonce || ciphertext
    let mut out = Vec::with_capacity(24 + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);

    (r_point, out)
}

/// Try to decrypt a stealth output. Returns Some((value, blinding)) on success.
#[allow(non_snake_case)]
pub fn decrypt_stealth_output(
    scan_priv: &Scalar,
    R: &RistrettoPoint,
    data: &[u8],
) -> Option<(u64, Scalar)> {
    if data.len() < 24 { return None; }
    let (nonce_bytes, ct) = data.split_at(24);

    // Compute shared secret S' = Hs(a_s * R)
    let apr = (R * scan_priv).compress().to_bytes();
    let s = hash_to_scalar(b"Stealth", &apr);

    // Derive key
    let key = Key::from_slice(s.as_bytes());
    let cipher = XChaCha20Poly1305::new(key);
    let nonce = XNonce::from_slice(nonce_bytes);

    // Decrypt
    let pt = cipher.decrypt(nonce, ct).ok()?;
    if pt.len() != 40 { return None; }

    // Parse
    let mut amt_bytes = [0u8; 8];
    amt_bytes.copy_from_slice(&pt[..8]);
    let value = u64::from_be_bytes(amt_bytes);
    
    let mut blind_bytes = [0u8; 32];
    blind_bytes.copy_from_slice(&pt[8..40]);

    // Use from_bytes_mod_order for consistency, as canonical checks can be strict
    let blinding = Scalar::from_bytes_mod_order(blind_bytes);

    // Verification that the reconstructed commitment matches the on-chain one
    // must be performed by the calling function.
    Some((value, blinding))
}
