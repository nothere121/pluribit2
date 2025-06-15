use num_bigint::{BigUint, RandBigInt}; 

use num_traits::One;

// remove: use sha2::{Digest, Sha256}; // Only if calculate_hash is removed
// remove: use std::path::PathBuf;
// remove: use tui::layout::Rect;

// Safely calculate 2^t for large t values
pub fn calculate_power_safely(iterations: u64) -> Result<BigUint, String> {
    if iterations == 0 {
        return Ok(BigUint::one()); // 2^0 = 1
    }
    // Your binary exponentiation algorithm (Russian peasant algorithm)
    // This is good.
    let base = BigUint::from(2u32);
    let mut exp_val = iterations; // Use a mutable copy
    let mut result = BigUint::one();
    let mut current_power = base;

    while exp_val > 0 {
        if exp_val % 2 == 1 {
            result *= &current_power;
        }
        current_power = &current_power * &current_power; // Multiplying references is fine and often efficient

        exp_val /= 2;
    }
    Ok(result)
}
// Helper function to generate a random BigUint of a specific bit length
pub fn gen_rand_biguint(bit_length: u64) -> BigUint {
    let mut rng = rand::thread_rng();
    rng.gen_biguint(bit_length)
}

// A simple primality test (not cryptographically secure for large numbers)
pub fn is_prime(n: &BigUint) -> bool {
    if *n <= BigUint::one() {
        return false;
    }
    // This is a basic and slow primality test.
    // For a real implementation, Miller-Rabin would be required.
    let mut i = BigUint::from(2u32);
    while &i * &i <= *n {
        if n % &i == BigUint::from(0u32) {
            return false;
        }
        i += BigUint::one();
    }
    true
}
/*
// If you decide to keep calculate_hash and add `hex` to Cargo.toml:
use sha2::{Digest, Sha256};
pub fn calculate_hash(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data).to_vec())
}
*/
