// src/address.rs
use bech32::{self, ToBase32, FromBase32, Variant};
use crate::error::{PluribitResult, PluribitError};

const STEALTH_ADDRESS_PREFIX: &str = "pb";

pub fn encode_stealth_address(scan_pubkey: &[u8; 32]) -> PluribitResult<String> {
    bech32::encode(STEALTH_ADDRESS_PREFIX, scan_pubkey.to_base32(), Variant::Bech32)
        .map_err(|e| PluribitError::ValidationError(format!("Bech32 encoding failed: {}", e)))
}

pub fn decode_stealth_address(address: &str) -> PluribitResult<[u8; 32]> {
    let (hrp, data, _) = bech32::decode(address)
        .map_err(|e| PluribitError::ValidationError(format!("Invalid address: {}", e)))?;
    
    if hrp != STEALTH_ADDRESS_PREFIX {
        return Err(PluribitError::ValidationError("Address must start with 'pb'".to_string()));
    }
    
    let bytes = Vec::<u8>::from_base32(&data)
        .map_err(|_| PluribitError::ValidationError("Invalid address data".to_string()))?;
    
    if bytes.len() != 32 {
        return Err(PluribitError::ValidationError("Invalid address length".to_string()));
    }
    
    let mut pubkey = [0u8; 32];
    pubkey.copy_from_slice(&bytes);
    Ok(pubkey)
}
#[cfg(test)]
mod tests {
    use super::*;

    // New Test for Address Encoding/Decoding
    #[test]
    fn test_stealth_address_roundtrip() {
        let mut pubkey = [0u8; 32];
        pubkey[0] = 1;
        pubkey[31] = 255;
        
        // Encode the public key into a Bech32 address
        let encoded = encode_stealth_address(&pubkey).unwrap();
        assert!(encoded.starts_with(STEALTH_ADDRESS_PREFIX)); // Address should have the correct prefix "pb" [cite: 290]

        // Decode the address back into a public key
        let decoded = decode_stealth_address(&encoded).unwrap();
        
        // Ensure the decoded key matches the original
        assert_eq!(pubkey, decoded);
    }

    // New Test for Invalid Addresses
    #[test]
    fn test_decode_stealth_address_invalid() {
        // Wrong prefix
        let bad_prefix = "xx1qp6qunzv3eun8y5w0n2sxx7rq7g9y5sgkaxr0w3";
        assert!(decode_stealth_address(bad_prefix).is_err(), "Should fail on wrong HRP");

        // Invalid length
        let bad_length = "pb1qp6qunzv3eun8y5w0n2sxx7rq7g9y5sgka";
        assert!(decode_stealth_address(bad_length).is_err(), "Should fail on wrong data length"); // Address must be 32 bytes 

        // Invalid checksum
        let bad_checksum = "pb1qp6qunzv3eun8y5w0n2sxx7rq7g9y5sgkaxr0w4";
        assert!(decode_stealth_address(bad_checksum).is_err(), "Should fail on bad checksum");
    }
}
