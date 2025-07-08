// vdf-worker.js - Dedicated worker for long VDF computations

import { parentPort } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';

// --- MODULE IMPORTS ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const wasmPath = path.join(__dirname, './pkg-node/pluribit_core.js');
const pluribit = await import(wasmPath);

// The WASM module is ready after the import, no separate init() call is needed.

parentPort.on('message', async (event) => {
    const { validatorId, spendPrivKey, selectedBlockHash } = event;

    try {
        // This will take a long time to run (approx. 4 minutes by design)
        const voteResult = await pluribit.vote_for_block(
            validatorId,
            spendPrivKey,
            selectedBlockHash
        );
        
        // Send the result back to the main worker when done
        parentPort.postMessage({ success: true, payload: voteResult });

    } catch (error) {
        parentPort.postMessage({ success: false, error: error.toString() });
    }
});
