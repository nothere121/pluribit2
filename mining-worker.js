import { parentPort } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const wasmPath = path.join(__dirname, './pkg-node/pluribit_core.js');
const { default: _, ...pluribit } = await import(wasmPath);

let shouldStop = false;

parentPort.on('message', async (msg) => {
    if (msg.type === 'MINE_BLOCK') {
        shouldStop = false;
        mineBlock(msg);
    } else if (msg.type === 'STOP') {
        shouldStop = true;
    }
});

async function mineBlock(params) {
    const { jobId, height, minerSecretKey, prevHash,
            powDifficulty, vrfThreshold, vdfIterations } = params;




    let nonce = 0n;
    const BATCH_SIZE = 10_000_000n; // 10M nonces per batch
    
    while (!shouldStop) {
        // Try to find valid header
        const solution = await pluribit.mine_block_header(
            BigInt(height),
            minerSecretKey,
            prevHash,
            BigInt(vdfIterations),
            vrfThreshold,
            BigInt(nonce),
            BigInt(nonce + BATCH_SIZE)
        );
        
        if (solution && solution !== null) {
            // Report header only; main worker will assemble the full block.
            parentPort.postMessage({
                type: 'HEADER_FOUND',
                jobId,
                solution,
                height,
                prevHash,
                powDifficulty,
                vrfThreshold,
                vdfIterations
            });
            return;
        }
        
        nonce += BATCH_SIZE;
        
        // Status update every 100M nonces
        if (nonce % 100_000_000 === 0) {
            parentPort.postMessage({
                type: 'STATUS',
                message: `Tried ${nonce} nonces...`
            });
        }
    }
}
