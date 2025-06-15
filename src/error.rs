use std::{fmt, io};
use std::sync::mpsc;

// Error handling types
pub type BitQuillResult<T> = Result<T, BitQuillError>;

#[derive(Debug)]
pub enum BitQuillError {
    IoError(io::Error),
    SerializationError(String),
    DeserializationError(String),
    HashError(String),
    VdfError(String),
    ValidationError(String),
    ResourceExhaustedError(String),
    ThreadError(String),
    StateError(String),
    LockError(String),
    InvalidInput(String),
    ComputationError(String),
    InvalidBlock(String), 
        InvalidOutputCommitment,
    InvalidInputCommitment,
    InvalidRangeProof,
    InvalidKernelExcess,
    InvalidKernelSignature,
    Imbalance,
    UnknownInput,
    DoubleVote(String),
    InsufficientStake,
    InvalidVote(String),
}

impl fmt::Display for BitQuillError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            BitQuillError::IoError(e) => write!(f, "I/O error: {}", e),
            BitQuillError::SerializationError(s) => write!(f, "Serialization error: {}", s),
            BitQuillError::DeserializationError(s) => write!(f, "Deserialization error: {}", s),
            BitQuillError::HashError(s) => write!(f, "Hash error: {}", s),
            BitQuillError::VdfError(s) => write!(f, "VDF error: {}", s),
            BitQuillError::ValidationError(s) => write!(f, "Validation error: {}", s),
            BitQuillError::ResourceExhaustedError(s) => write!(f, "Resource exhausted: {}", s),
            BitQuillError::ThreadError(s) => write!(f, "Thread error: {}", s),
            BitQuillError::StateError(s) => write!(f, "State error: {}", s),
            BitQuillError::LockError(s) => write!(f, "Lock error: {}", s),
            BitQuillError::InvalidInput(msg) => write!(f, "Invalid input: {}", msg),
            BitQuillError::ComputationError(msg) => write!(f, "Computation error: {}", msg),
            BitQuillError::InvalidBlock(msg) => write!(f, "Invalid block: {}", msg),  
                        BitQuillError::InvalidOutputCommitment => write!(f, "Invalid output commitment"),
            BitQuillError::InvalidInputCommitment => write!(f, "Invalid input commitment"),
            BitQuillError::InvalidRangeProof => write!(f, "Invalid range proof"),
            BitQuillError::InvalidKernelExcess => write!(f, "Invalid kernel excess"),
            BitQuillError::InvalidKernelSignature => write!(f, "Invalid kernel signature"),
            BitQuillError::Imbalance => write!(f, "Transaction does not balance"),
            BitQuillError::UnknownInput => write!(f, "Unknown input UTXO"),
            BitQuillError::DoubleVote(msg) => write!(f, "Double vote detected: {}", msg),
            BitQuillError::InsufficientStake => write!(f, "Insufficient stake for operation"),
            BitQuillError::InvalidVote(msg) => write!(f, "Invalid vote: {}", msg),
        
        }
    }
}

impl From<io::Error> for BitQuillError {
    fn from(error: io::Error) -> Self {
        BitQuillError::IoError(error)
    }
}

impl<T> From<std::sync::PoisonError<T>> for BitQuillError {
    fn from(error: std::sync::PoisonError<T>) -> Self {
        BitQuillError::LockError(error.to_string())
    }
}

impl From<mpsc::SendError<u64>> for BitQuillError {
    fn from(error: mpsc::SendError<u64>) -> Self {
        BitQuillError::ThreadError(format!("Channel send error: {}", error))
    }
}

impl From<mpsc::RecvError> for BitQuillError {
    fn from(error: mpsc::RecvError) -> Self {
        BitQuillError::ThreadError(format!("Channel receive error: {}", error))
    }
}

// REMOVED the secp256k1_zkp::Error conversion since we're no longer using that library

// Additional From<SendError<VDFClockTick>> implementation will be in the vdf module
