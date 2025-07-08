// vdf_clock.rs
use crate::{vdf::{VDF, VDFProof}, error::PluribitResult, log, constants};
use serde::{Serialize, Deserialize};
use sha2::{Digest, Sha256};


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
    
    pub fn tick(&mut self, vdf: &VDF) -> PluribitResult<()> {
        // Get the calibrated number of iterations for one second from our global constant.
        let iterations_for_one_tick = *constants::VDF_ITERATIONS_PER_SECOND.lock().unwrap();
        //let iterations_for_one_tick = 1000; 
        // Compute one tick forward with the correctly calibrated number of iterations.
        let proof = vdf.compute_with_proof(&self.current_output, iterations_for_one_tick)
            .map_err(|e| crate::error::PluribitError::VdfError(e.to_string()))?;

        self.current_output = proof.y.clone();
        self.current_proof = proof;
        self.current_tick += 1;

        // Use the correct variable in the log message.
        log(&format!("[RUST] VDF clock ticked to {}. Iterations this tick: {}", 
            self.current_tick, iterations_for_one_tick));

        Ok(())
    }
    
    pub fn can_submit_block(&self, block_height: u64) -> bool {
        // Can only submit if we've reached the required tick for this height
        self.current_tick >= block_height * self.ticks_per_block
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::vdf::VDF;
    
    #[test]
    fn test_vdf_clock_initialization() {
        let clock = VDFClock::new(10);
        assert_eq!(clock.current_tick, 0);
        assert_eq!(clock.ticks_per_block, 10);
        assert!(!clock.current_output.is_empty());
        // Initial output should be hash of "genesis_vdf_clock"
        let mut hasher = Sha256::new();
        hasher.update(b"genesis_vdf_clock");
        let expected = hasher.finalize().to_vec();
        assert_eq!(clock.current_output, expected);
    }
    
    #[test]
    fn test_vdf_clock_tick() {
        let mut clock = VDFClock::new(10);
        let vdf = VDF::new(2048).unwrap();
        
        // Set a fast VDF speed for testing
        *constants::VDF_ITERATIONS_PER_SECOND.lock().unwrap() = 100;
        
        let initial_output = clock.current_output.clone();
        clock.tick(&vdf).unwrap();
        
        assert_eq!(clock.current_tick, 1);
        assert_ne!(clock.current_output, initial_output);
        assert!(!clock.current_proof.y.is_empty());
        assert!(!clock.current_proof.pi.is_empty());
    }
    
    #[test]
    fn test_can_submit_block() {
        let clock = VDFClock {
            current_tick: 25,
            ticks_per_block: 10,
            current_output: vec![1, 2, 3],
            current_proof: VDFProof::default(),
        };
        
        assert!(clock.can_submit_block(0));  // Genesis always allowed
        assert!(clock.can_submit_block(1));  // 1 * 10 = 10 <= 25
        assert!(clock.can_submit_block(2));  // 2 * 10 = 20 <= 25
        assert!(!clock.can_submit_block(3)); // 3 * 10 = 30 > 25
    }
    
    #[test]
    fn test_multiple_ticks() {
        let mut clock = VDFClock::new(5);
        let vdf = VDF::new(2048).unwrap();
        *constants::VDF_ITERATIONS_PER_SECOND.lock().unwrap() = 50;
        
        for i in 1..=10 {
            clock.tick(&vdf).unwrap();
            assert_eq!(clock.current_tick, i);
        }
        
        // After 10 ticks with 5 ticks per block, should be able to submit block 2
        assert!(clock.can_submit_block(2));
        assert!(!clock.can_submit_block(3));
    }
}
