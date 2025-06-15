// vdf_clock.rs
use crate::vdf::{VDF, VDFProof};
use crate::error::BitQuillResult;
use crate::log; 
use serde::{Serialize, Deserialize};
use sha2::{Digest, Sha256};

// Calibrated for ~1 second per tick on average browser
const VDF_ITERATIONS_PER_TICK: u64 = 10; //change back to 10_000 in prod Much lower for testing


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VDFClock {
    pub current_tick: u64,
    pub current_output: Vec<u8>,
    pub ticks_per_block: u64,
    pub current_proof: VDFProof,
}

impl VDFClock {
    pub fn new(ticks_per_block: u64) -> Self {
        // Start with hash of "genesis"
        let mut hasher = Sha256::new();
        hasher.update(b"genesis_vdf_clock");
        let initial_output = hasher.finalize().to_vec();
        
        VDFClock {
            current_tick: 0,
            current_output: initial_output,
            ticks_per_block,
            current_proof: VDFProof {
                y: vec![],
                pi: vec![],
                l: vec![],
                r: vec![],
            },
        }
    }
    
    pub fn tick(&mut self, vdf: &VDF) -> BitQuillResult<()> {
        // Compute one tick forward with proper iterations
        let proof = vdf.compute_with_proof(&self.current_output, VDF_ITERATIONS_PER_TICK)?;
        self.current_output = proof.y.clone();
        self.current_proof = proof;
        self.current_tick += 1;
        
        log(&format!("[RUST] VDF clock ticked to {} (iterations: {})", 
            self.current_tick, VDF_ITERATIONS_PER_TICK));
        
        Ok(())
    }
    
    pub fn can_submit_block(&self, block_height: u64) -> bool {
        // Can only submit if we've reached the required tick for this height
        self.current_tick >= block_height * self.ticks_per_block
    }
}
