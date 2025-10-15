// mining-worker.js
import { parentPort } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Module loading with native/WASM fallback
let pluribit;
let wasmModule; // Keep WASM module for VRF
let isNative = false;

async function loadModule() {
    // Always load WASM for VRF functions
    try {
        const wasmPath = path.join(__dirname, './pkg-node/pluribit_core.js');
        const { default: _, ...wasm } = await import(wasmPath);
        wasmModule = wasm;
    } catch (wasmError) {
        parentPort.postMessage({ 
            type: 'STATUS', 
            message: `Failed to load WASM module: ${wasmError.message}` 
        });
        throw wasmError;
    }

    // Try to load native module for VDF
    try {
        const nativePath = path.join(__dirname, 'native', 'index.node');
        pluribit = require(nativePath);
        isNative = true;
        parentPort.postMessage({ 
            type: 'STATUS', 
            message: 'Using native VDF implementation (10-50x faster)' 
        });
    } catch (e) {
        // Fall back to WASM for VDF too
        pluribit = wasmModule;
        isNative = false;
        parentPort.postMessage({ 
            type: 'STATUS', 
            message: 'Using WASM VDF implementation' 
        });
    }
}

let currentJobId = null; // Use a job ID to manage state and prevent race conditions


async function findMiningCandidate(params) {
  const { jobId, height, minerPubkey, minerSecretKey, prevHash, vrfThreshold, vdfIterations } = params;
  let nonce = 0n;
    
    parentPort.postMessage({ 
        type: 'STATUS', 
        message: `Starting mining job #${jobId} for block #${height}` 
    });
  // Loop only as long as this is the active job
  while (currentJobId === jobId) {
        try {
            // Construct the VDF input
            const vdf_input = `${height}${prevHash}${Buffer.from(minerPubkey).toString('hex')}${nonce}`;
            // Perform VDF computation
            let vdf_proof;
            if (isNative) {
                // The native addon now accepts BigInt directly, so no conversion is needed.
                const result = pluribit.performVdfComputation(vdf_input, vdfIterations);
                vdf_proof = {
                    y: Buffer.from(result.y, 'hex'),
                    pi: Buffer.from(result.pi, 'hex'),
                    l: Buffer.from(result.l, 'hex'),
                    r: Buffer.from(result.r, 'hex'),
                    iterations: BigInt(result.iterations) // The native module returns a Number, so we cast it up to BigInt
                };
            } else {
                // The WASM module expects a BigInt, which vdfIterations already is.
                vdf_proof = await wasmModule.perform_vdf_computation(
                    vdf_input,
                    vdfIterations
                );
            }
            
            // Always use WASM for VRF (native doesn't have it)
            const vrf_proof = await wasmModule.create_vrf_proof(minerSecretKey, vdf_proof.y);
            
            // Check if VRF output meets threshold
            const vrfOutputHex = Buffer.from(vrf_proof.output).toString('hex');
            const thresholdHex = Buffer.from(vrfThreshold).toString('hex');
            
            if (vrfOutputHex < thresholdHex) {
                // Won the lottery!
                parentPort.postMessage({
                    type: 'CANDIDATE_FOUND',
                    jobId,
                    candidate: {
                        nonce: nonce.toString(),
                        vdf_proof,
                        vrf_proof,  // Include the VRF proof
                        height,
                        prevHash,
                        miner_pubkey: minerPubkey,
                        vrfThreshold,
                        vdfIterations
                    }
                });
                
                parentPort.postMessage({ 
                    type: 'STATUS', 
                    message: `Won lottery at nonce ${nonce}! VRF: ${vrfOutputHex.substring(0,12)}...` 
                });
                return; // Stop mining this block
            }
            
            // Didn't win, increment nonce
            nonce += 1n;
            
            // Periodic status update
            if (nonce % 1000n === 0n) {
                parentPort.postMessage({
                    type: 'STATUS',
                    message: `Mining block #${height}: Tried ${nonce} nonces...`
                });
            }
            
        } catch (e) {
            parentPort.postMessage({ 
                type: 'STATUS',
                message: `Error at nonce ${nonce}: ${e?.message || e}`
            });
            nonce += 1n;
        }
    }
    
  // Announce that this specific job has stopped.
  if (currentJobId !== jobId) {
    parentPort.postMessage({
      type: 'STATUS',
      message: `Mining job #${jobId} stopped.`
    });
  }
}

// This ensures the module is loaded *before* we start listening for messages.
async function main() {
    await loadModule();

  parentPort.on('message', async (msg) => {
    if (msg.type === 'STOP') {
      currentJobId = null; // Atomically stop any running job.
    } else if (msg.type === 'MINE_BLOCK') {
      currentJobId = msg.jobId; // Atomically set the new active job.
      findMiningCandidate(msg).catch(e => {
                parentPort.postMessage({ 
                    type: 'STATUS', 
                    message: `Uncaught error in mining task: ${e?.message || e}` 
                });
            });
        }
    });
}

// Run the main function and catch any initialization errors.
main().catch(err => {
    parentPort.postMessage({ 
        type: 'STATUS', 
        message: `Module initialization failed: ${err.message}` 
    });
    process.exit(1);
});
