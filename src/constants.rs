// constants.rs
use lazy_static::lazy_static; 
use std::sync::Mutex;        

lazy_static! {
    /// The calibrated number of VDF squarings (iterations) per second.
    /// This is determined by a benchmark on startup and stored here.
    /// Default is set to a reasonable starting value.
    pub static ref VDF_ITERATIONS_PER_SECOND: Mutex<u64> = Mutex::new(5000);
}

// Maximum number of recent files to remember
pub const MAX_RECENT_FILES: usize = 10;

// Auto-save interval in seconds
pub const AUTO_SAVE_INTERVAL: u64 = 60;

// File extension for BitQuill documents
pub const BITQUILL_FILE_EXT: &str = "bq";

// File extension for BitQuill chain data
pub const BITQUILL_CHAIN_EXT: &str = "bqc";

// Target time for VDF ticks (1 second)
pub const TARGET_TICK_SECONDS: f64 = 1.0;

// Initial VDF difficulty (iterations)
pub const INITIAL_VDF_ITERATIONS: u64 = 100_000;

// Minimum VDF difficulty
pub const MIN_VDF_ITERATIONS: u64 = 250_000;

// Maximum VDF difficulty
pub const MAX_VDF_ITERATIONS: u64 = 1_000_000_000;

// Merkle leaf created every N ticks
pub const LEAF_TICK_INTERVAL: u64 = 1_000;

// Minimum ticks between leaves when pending changes exist
pub const MIN_TICKS_FOR_PENDING_LEAF: u64 = 1_000;

// Number of ticks to store for difficulty adjustment
pub const DIFFICULTY_WINDOW_SIZE: usize = 1_000;

// (Keep or remove these as needed; they’re BitQuill-specific)
pub const ABSOLUTE_MIN_ITERATIONS: u64 = 100_000;
pub const MAX_BUFFER_SIZE: usize       = 10_000_000; // 10 MB
pub const MAX_ALLOWED_LEAVES: usize     = 50_000;
pub const MAX_CONTENT_SIZE: usize       = 1_000_000;  // 1 MB per paragraph


// —————— Pluribit Consensus Settings ——————

/// Phase durations (in seconds)
pub const MINING_PHASE_DURATION: u64 = 600;      // 10 minutes
pub const VALIDATION_PHASE_DURATION: u64 = 300;   // 5 minutes
pub const PROPAGATION_PHASE_DURATION: u64 = 300;  // 5 minutes
pub const CYCLE_DURATION: u64 = 1200;             // 20 minutes total

/// Target total block time (in seconds)
pub const TARGET_BLOCK_TIME: u64 = 1200;           // 20 minutes

/// How many blocks between each difficulty adjustment
pub const DIFFICULTY_ADJUSTMENT_INTERVAL: u64 = 144;  // ≈48 hours at 20 min/blk

// Genesis anchor details from the plan
pub const GENESIS_TIMESTAMP_MS: u64 = 1750000658000; // 2025-06-15 14:57:38 UTC
pub const GENESIS_BITCOIN_HASH: &str = "00000000000000000000656b995c9fec9ff94b554dc4aad46c06b71f94088c3c";

// Bootstrap period
pub const BOOTSTRAP_BLOCKS: u64 = 720; // 10 days worth of blocks
