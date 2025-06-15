// constants.rs

// —————— BitQuill Settings ——————

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
pub const MINING_PHASE_DURATION: u64      = 30; //10 * 60;  // 10 minutes
pub const VALIDATION_PHASE_DURATION: u64  =  20; //5 * 60;  //  5 minutes
pub const PROPAGATION_PHASE_DURATION: u64 =  10; // 5 * 60;  //  5 minutes

/// Target total block time (in seconds)
pub const TARGET_BLOCK_TIME: u64 = 60; //20 * 60;           // 20 minutes

/// How many blocks between each difficulty adjustment
pub const DIFFICULTY_ADJUSTMENT_INTERVAL: u64 = 144;  // ≈48 hours at 20 min/blk
