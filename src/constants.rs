// constants.rs
use lazy_static::lazy_static; 
use std::sync::Mutex;        

lazy_static! {
    /// The calibrated number of VDF squarings (iterations) per second.
    pub static ref VDF_ITERATIONS_PER_SECOND: Mutex<u64> = Mutex::new(5000);
}

// —————— Pluribit Consensus Settings ——————

/// Phase durations (in seconds)
pub const MINING_PHASE_DURATION: u64 = 60;      // 1 minute
pub const VALIDATION_PHASE_DURATION: u64 = 30;   // 0.5 minutes
pub const PROPAGATION_PHASE_DURATION: u64 = 30;  // 0.5 minutes
pub const CYCLE_DURATION: u64 = 120;             // 2 minutes total

// --- NEW: VDF Tick-based constants derived from durations ---
pub const TICKS_PER_CYCLE: u64 = CYCLE_DURATION;
pub const MINING_PHASE_END_TICK: u64 = MINING_PHASE_DURATION;
pub const VALIDATION_PHASE_END_TICK: u64 = MINING_PHASE_DURATION + VALIDATION_PHASE_DURATION;

// --- NEW: Validation sub-phase timings (in ticks relative to start of validation phase) ---
pub const COMMITMENT_END_TICK: u64 = 10;    // Corresponds to 10 seconds
pub const RECONCILIATION_END_TICK: u64 = 20; // Corresponds to 20 seconds

/// Target total block time (in seconds)
pub const TARGET_BLOCK_TIME: u64 = 120;           // 2 minutes

/// How many blocks between each difficulty adjustment (approx. 13 days at 2 min/blk)
pub const DIFFICULTY_ADJUSTMENT_INTERVAL: u64 = 9360; 

// Genesis anchor details from the plan
pub const GENESIS_TIMESTAMP_MS: u64 = 1750000658000; // 2025-06-15 14:57:38 UTC
pub const GENESIS_BITCOIN_HASH: &str = "00000000000000000000656b995c9fec9ff94b554dc4aad46c06b71f94088c3c";

// Bootstrap period
pub const BOOTSTRAP_BLOCKS: u64 = 2;

/// The base reward for the genesis block period, in bits.
pub const INITIAL_BASE_REWARD: u64 = 50_000_000;

/// The number of blocks between each block reward halving.
pub const HALVING_INTERVAL: u64 = 210_000;

/// The number of blocks after which the halving cycle resets (approx. 100 years).
pub const REWARD_RESET_INTERVAL: u64 = 2_629_000; 

/// The factor to scale the log2(Difficulty) bonus to make it economically significant.
pub const DIFFICULTY_BONUS_FACTOR: u64 = 10_000_000;

/// The maximum size of a block in bytes.
pub const MAX_BLOCK_SIZE_BYTES: usize = 4 * 1024 * 1024; // 4 MB

/// The minimum number of iterations for a VDF proof.
pub const MIN_VDF_ITERATIONS: u64 = 100;

/// The maximum number of iterations for a VDF proof to prevent resource exhaustion.
pub const MAX_VDF_ITERATIONS: u64 = 100_000_000;

/// The default number of iterations for a VDF tick.
pub const INITIAL_VDF_ITERATIONS: u64 = 1000;
