// src/utils.rs

use num_bigint::{BigUint, RandBigInt};
use num_integer::Integer;
use num_traits::One;
use rand::thread_rng;

/// Safely calculate 2^t for large t values using binary exponentiation.
pub fn calculate_power_safely(iterations: u64) -> Result<BigUint, String> {
    if iterations == 0 {
        return Ok(BigUint::one());
    }
    let base = BigUint::from(2u32);
    let mut exp_val = iterations;
    let mut result = BigUint::one();
    let mut current_power = base;

    while exp_val > 0 {
        if exp_val % 2 == 1 {
            result *= &current_power;
        }
        current_power = &current_power * &current_power;
        exp_val /= 2;
    }
    Ok(result)
}

/// Helper function to generate a random BigUint of a specific bit length.
pub fn gen_rand_biguint(bit_length: u64) -> BigUint {
    let mut rng = rand::thread_rng();
    rng.gen_biguint(bit_length)
}

/// A cryptographically secure probabilistic primality test using Miller-Rabin.
pub fn is_prime(n: &BigUint) -> bool {
    // Number of rounds for the Miller-Rabin test. 40 is a common choice for good security.
    const K: usize = 40;

    // Handle base cases for primality.
    if n <= &BigUint::one() {
        return false;
    }
    if n == &BigUint::from(2u32) || n == &BigUint::from(3u32) {
        return true;
    }
    if n.is_even() {
        return false;
    }

    // Decompose n-1 into 2^r * d where d is odd.
    let one = BigUint::one();
    let two = BigUint::from(2u32);
    let n_minus_1 = n - &one;

    let mut r: u64 = 0;
    let mut d = n_minus_1.clone();

    while d.is_even() {
        d >>= 1;
        r += 1;
    }

    let mut rng = thread_rng();

    // Perform the witness loop K times.
    'witness: for _ in 0..K {
        let a = rng.gen_biguint_range(&two, &(n - &one));
        let mut x = a.modpow(&d, n);

        if x == one || x == n_minus_1 {
            // This witness passes, try the next one.
            continue 'witness;
        }

        // Loop for squaring, from 1 to r-1.
        for _ in 0..r - 1 {
            x = x.modpow(&two, n);
            if x == n_minus_1 {
                // This witness passes. Break from squaring loop and try next witness.
                continue 'witness;
            }
        }

        // If we finished squaring and never found n-1, it's a composite.
        return false;
    }

    // If all witnesses fail to prove n is composite, it is probably prime.
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use num_bigint::BigUint;
    use std::str::FromStr;
    use num_traits::Zero;
    #[test]
    fn test_calculate_power_safely() {
        // Test small powers of 2.
        assert_eq!(calculate_power_safely(0).unwrap(), BigUint::from(1u32));
        assert_eq!(calculate_power_safely(1).unwrap(), BigUint::from(2u32));
        assert_eq!(calculate_power_safely(10).unwrap(), BigUint::from(1024u32));

        // Test a larger power of 2.
        let result = calculate_power_safely(100).unwrap();
        let expected = BigUint::from(2u32).pow(100);
        assert_eq!(result, expected);
    }

    #[test]
    fn test_gen_rand_biguint() {
        // Test generation for various bit lengths.
        for bit_length in [8, 64, 256] {
            let num = gen_rand_biguint(bit_length);
            assert!(num.bits() <= bit_length);
            assert!(num > BigUint::zero());
        }

        // Ensure two generated numbers are different.
        let num1 = gen_rand_biguint(128);
        let num2 = gen_rand_biguint(128);
        assert_ne!(num1, num2);
    }

    #[test]
    fn test_is_prime_small_numbers() {
        // Test known small primes and composites.
        assert!(!is_prime(&BigUint::from(0u32)));
        assert!(!is_prime(&BigUint::from(1u32)));
        assert!(is_prime(&BigUint::from(2u32)));
        assert!(is_prime(&BigUint::from(3u32)));
        assert!(!is_prime(&BigUint::from(4u32)));
        assert!(is_prime(&BigUint::from(5u32)));
        assert!(!is_prime(&BigUint::from(9u32)));
        assert!(is_prime(&BigUint::from(13u32)));
    }

    #[test]
    fn test_is_prime_composites() {
        // Test various non-prime numbers.
        assert!(!is_prime(&BigUint::from(100u32)));
        assert!(!is_prime(&BigUint::from(121u32))); // 11*11
        assert!(!is_prime(&BigUint::from(513535u32))); // 5 * 102707
    }

    #[test]
    fn test_is_prime_large_prime() {
        // 2^127 − 1 is the Mersenne prime for p = 127.
        let large_prime_str = "170141183460469231731687303715884105727";
        let large_prime = BigUint::from_str(large_prime_str).unwrap();
        assert!(is_prime(&large_prime));
    }

    #[test]
    fn test_binary_exponentiation() {
        // Test the binary exponentiation algorithm with various exponents.
        let test_cases = vec![
            (3, 8),       // 2^3 = 8
            (5, 32),      // 2^5 = 32
            (15, 32768),  // 2^15
            (20, 1048576), // 2^20
        ];
        for (exp, expected) in test_cases {
            let result = calculate_power_safely(exp).unwrap();
            assert_eq!(result, BigUint::from(expected as u32));
        }
    }
}
