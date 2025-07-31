import { parentPort, workerData } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const wasmPath = path.join(__dirname, './pkg-node/pluribit_core.js');
const { default: _, ...pluribit } = await import(wasmPath);

// Mining worker - receives mining jobs and returns results
parentPort.on('message', async (msg) => {
    if (msg.type === 'MINE_BLOCK') {

        const { height, minerSecretKey, minerScanPubkey, prevHash, transactions } = msg;
        
        try {
            const blockResult = await pluribit.mine_post_block(
                BigInt(height),
                minerSecretKey,
                minerScanPubkey,
                prevHash,
                transactions
            );
            
            parentPort.postMessage({
                type: 'BLOCK_MINED',
                block: blockResult
            });
        } catch (e) {
            parentPort.postMessage({
                type: 'MINING_ERROR',
                error: e.message
            });
        }
    }
});
