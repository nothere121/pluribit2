// src/wasm_types.rs
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde::de::{self, Visitor};
use std::fmt;
use std::ops::{Add, Sub, Rem, SubAssign};
use num_bigint::BigUint;

/// A u64 wrapper that correctly handles JavaScript's number limitations.
/// JavaScript's Number type can only safely represent integers up to 2^53-1.
/// For larger values, we need to use BigInt or string representation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WasmU64(pub u64);

impl WasmU64 {
    pub fn new(value: u64) -> Self {
        WasmU64(value)
    }
    
    pub fn get(&self) -> u64 {
        self.0
    }
}

// Implement Deref so it acts like a u64
impl std::ops::Deref for WasmU64 {
    type Target = u64;
    
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for WasmU64 {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

// Implement Display for easy formatting in logs
impl fmt::Display for WasmU64 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

// Implement From<WasmU64> for BigUint
impl From<WasmU64> for BigUint {
    fn from(value: WasmU64) -> Self {
        BigUint::from(value.0)
    }
}

// --- Trait Implementations for Ergonomics ---

impl From<u64> for WasmU64 {
    fn from(value: u64) -> Self {
        WasmU64(value)
    }
}

impl From<WasmU64> for u64 {
    fn from(value: WasmU64) -> Self {
        value.0
    }
}

// Implement PartialEq<u64> to allow direct comparison like `my_wasm_u64 == 10`
impl PartialEq<u64> for WasmU64 {
    fn eq(&self, other: &u64) -> bool {
        self.0 == *other
    }
}

// Implement PartialOrd<u64> to allow direct comparison like `my_wasm_u64 > 10`
impl PartialOrd<u64> for WasmU64 {
    fn partial_cmp(&self, other: &u64) -> Option<std::cmp::Ordering> {
        self.0.partial_cmp(other)
    }
}

// Implement math operators
impl Add<u64> for WasmU64 {
    type Output = u64;
    fn add(self, rhs: u64) -> Self::Output {
        self.0 + rhs
    }
}

impl Sub<u64> for WasmU64 {
    type Output = u64;
    fn sub(self, rhs: u64) -> Self::Output {
        self.0 - rhs
    }
}

impl Rem<u64> for WasmU64 {
    type Output = u64;
    fn rem(self, rhs: u64) -> Self::Output {
        self.0 % rhs
    }
}

impl SubAssign<u64> for WasmU64 {
    fn sub_assign(&mut self, rhs: u64) {
        self.0 -= rhs;
    }
}


impl Serialize for WasmU64 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        // Serialize as a number - serde-wasm-bindgen will convert to BigInt automatically
        self.0.serialize(serializer)
    }
}

struct WasmU64Visitor;
impl<'de> Visitor<'de> for WasmU64Visitor {
    type Value = WasmU64;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a u64 as number, string, BigInt, or Long.js object")
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(WasmU64(value))
    }
    
    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        if value < 0 {
            Err(E::custom("u64 cannot be negative"))
        } else {
            Ok(WasmU64(value as u64))
        }
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        value.parse::<u64>()
            .map(WasmU64)
            .map_err(|_| E::custom("invalid u64 string"))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: de::MapAccess<'de>,
    {
        // Handle Long.js format: { low: number, high: number, unsigned: boolean }
        let mut low: Option<u64> = None;
        let mut high: Option<u64> = None;
        
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "low" => {
                    let val: i64 = map.next_value()?;
                    low = Some((val as u32) as u64); // Treat as unsigned 32-bit
                }
                "high" => {
                    high = Some(map.next_value()?);
                }
                "unsigned" => {
                    let _: bool = map.next_value()?; // Ignore, we always treat as unsigned
                }
                _ => {
                    let _: serde::de::IgnoredAny = map.next_value()?;
                }
            }
        }
        
        match (low, high) {
            (Some(l), Some(h)) => {
                let value = (h << 32) | l;
                Ok(WasmU64(value))
            }
            _ => Err(de::Error::custom("Long.js object missing low or high field"))
        }
    }
}

impl<'de> Deserialize<'de> for WasmU64 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(WasmU64Visitor)
    }
}
