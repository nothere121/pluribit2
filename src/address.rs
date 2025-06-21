// src/address.rs
use bech32::{self, ToBase32, FromBase32, Variant};
use crate::error::{BitQuillResult, BitQuillError};

const STEALTH_ADDRESS_PREFIX: &str = "pb";

pub fn encode_stealth_address(scan_pubkey: &[u8; 32]) -> BitQuillResult<String> {
    bech32::encode(STEALTH_ADDRESS_PREFIX, scan_pubkey.to_base32(), Variant::Bech32)
        .map_err(|e| BitQuillError::ValidationError(format!("Bech32 encoding failed: {}", e)))
}

pub fn decode_stealth_address(address: &str) -> BitQuillResult<[u8; 32]> {
    let (hrp, data, _) = bech32::decode(address)
        .map_err(|e| BitQuillError::ValidationError(format!("Invalid address: {}", e)))?;
    
    if hrp != STEALTH_ADDRESS_PREFIX {
        return Err(BitQuillError::ValidationError("Address must start with 'pb'".to_string()));
    }
    
    let bytes = Vec::<u8>::from_base32(&data)
        .map_err(|_| BitQuillError::ValidationError("Invalid address data".to_string()))?;
    
    if bytes.len() != 32 {
        return Err(BitQuillError::ValidationError("Invalid address length".to_string()));
    }
    
    let mut pubkey = [0u8; 32];
    pubkey.copy_from_slice(&bytes);
    Ok(pubkey)
}
