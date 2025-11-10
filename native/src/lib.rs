// native/src/lib.rs
use neon::prelude::*;
use neon::types::JsBigInt;
use pluribit_core::vdf::VDF;
use pluribit_core::wasm_types::WasmU64;

use pluribit_core::vrf::{self, VrfProof};
use pluribit_core::block::Block; // We need this for the VDF input format
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::constants::RISTRETTO_BASEPOINT_TABLE;
use neon::event::{Task, Channel};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use serde::Serialize;

mod db;

// This struct holds all the parameters for our mining task
struct MiningTask {
    height: u64,
    miner_secret_key: [u8; 32],
    prev_hash: String,
    vrf_threshold: [u8; 32],
    vdf_iterations: u64,
    // This allows the main thread to stop the task
    cancelled: Arc<AtomicBool>, 
    channel: Channel,
}

// This is the struct we'll return when we find a solution
#[derive(Serialize, Clone)]
struct MiningSolution {
    nonce: String, // Use String for WasmU64/BigInt safety
    vrf_proof: VrfProof,
    vdf_proof: pluribit_core::vdf::VDFProof,
    miner_pubkey: Vec<u8>,
    vrf_threshold: Vec<u8>,
    vdf_iterations: String, // Use String for WaSsU64/BigInt safety
}

// This is the logic that runs on the background thread
impl Task for MiningTask {
    type Output = Option<MiningSolution>;
    type Error = String;
    type JsEvent = JsValue; // We'll send status updates (JsString)

    fn compute(self) -> Result<Self::Output, Self::Error> {
        let vdf = VDF::new_with_default_modulus().map_err(|e| e.to_string())?;
        let secret_key = Scalar::from_bytes_mod_order(self.miner_secret_key);
        let public_key = &secret_key * &*RISTRETTO_BASEPOINT_TABLE;
        let miner_pubkey = public_key.compress().to_bytes();

        for nonce in 0..u64::MAX {
            // 1. Check for cancellation from the main thread
            if self.cancelled.load(Ordering::SeqCst) {
                return Ok(None); // Job was cancelled
            }

            // 2. Perform VDF (the slow part)
            let vdf_input = format!("{}{}{}{}", self.height, self.prev_hash, hex::encode(miner_pubkey), nonce);
            let vdf_proof = vdf.compute_with_proof(vdf_input.as_bytes(), WasmU64::from(self.vdf_iterations))
                .map_err(|e| e.to_string())?;

            // 3. Perform VRF
            let vrf_proof = vrf::create_vrf(&secret_key, &vdf_proof.y);

            // 4. Check for a win
            if vrf_proof.output < self.vrf_threshold {
                // Found a solution!
                let solution = MiningSolution {
                    nonce: nonce.to_string(),
                    vrf_proof,
                    vdf_proof,
                    miner_pubkey: miner_pubkey.to_vec(),
                    vrf_threshold: self.vrf_threshold.to_vec(),
                    vdf_iterations: self.vdf_iterations.to_string(),
                };
                return Ok(Some(solution));
            }
            
            // 5. Send a status update every 1000 nonces
            if nonce % 1000 == 0 && nonce > 0 {
                let status_msg = format!("Mining block #{}: Tried {} nonces...", self.height, nonce);
                self.channel.send(move |mut cx| {
                    Ok(cx.string(status_msg))
                });
            }
        }
        Ok(None) // Loop finished without finding anything (unlikely)
    }

    // This runs on the main event loop when compute() finishes
    fn resolve(self, mut cx: TaskContext, result: Result<Self::Output, Self::Error>) -> JsResult<JsValue> {
        match result {
            Ok(Some(solution)) => {
                // We found a solution, serialize it to a JS object
                neon_serde4::to_value(&mut cx, &solution)
                    .or_else(|e| cx.throw_error(format!("Failed to serialize solution: {}", e)))
            },
            Ok(None) => {
                // Task was cancelled or finished, return null
                Ok(cx.null().upcast())
            },
            Err(e) => {
                // An error occurred
                cx.throw_error(e)
            }
        }
    }

    // This handles the status update messages from compute()
    fn_poll(self, mut cx: TaskContext) -> JsResult<JsValue> {
        Ok(cx.undefined().upcast())
    }
}

// This is the new function we'll export to JavaScript
fn find_mining_solution(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let height = cx.argument::<JsBigInt>(0)?.to_u64(&mut cx).unwrap();
    let miner_secret_key: Handle<JsBuffer> = cx.argument(1)?;
    let prev_hash = cx.argument::<JsString>(2)?.value(&mut cx);
    let vrf_threshold: Handle<JsBuffer> = cx.argument(3)?;
    let vdf_iterations = cx.argument::<JsBigInt>(4)?.to_u64(&mut cx).unwrap();
    
    // Copy data from JS
    let secret_key_bytes = miner_secret_key.as_slice(&cx).to_vec();
    let vrf_threshold_bytes = vrf_threshold.as_slice(&cx).to_vec();

    if secret_key_bytes.len() != 32 { return cx.throw_error("minerSecretKey must be 32 bytes"); }
    if vrf_threshold_bytes.len() != 32 { return cx.throw_error("vrfThreshold must be 32 bytes"); }

    let mut sk = [0u8; 32];
    sk.copy_from_slice(&secret_key_bytes);
    
    let mut vrf_thresh = [0u8; 32];
    vrf_thresh.copy_from_slice(&vrf_threshold_bytes);

    let channel = cx.channel();
    let cancelled = Arc::new(AtomicBool::new(false));

    let task = MiningTask {
        height,
        miner_secret_key: sk,
        prev_hash,
        vrf_threshold: vrf_thresh,
        vdf_iterations,
        cancelled: Arc::clone(&cancelled),
        channel,
    };

    // Schedule the task and get its promise
    let (promise, resolver) = cx.promise();
    task.schedule_with(&mut cx, resolver);

    // Create a new object that holds the promise and the cancellation flag
    let obj = cx.empty_object();
    obj.set(&mut cx, "promise", promise)?;
    
    // Create a function for JS to call to abort the task
    let abort_fn = JsFunction::new(&mut cx, move |mut cx| {
        cancelled.store(true, Ordering::SeqCst);
        Ok(cx.undefined())
    })?;
    obj.set(&mut cx, "abort", abort_fn)?;

    Ok(obj.upcast())
}

fn perform_vdf_computation(mut cx: FunctionContext) -> JsResult<JsObject> {
    // 1. Get arguments
    let input_str = cx.argument::<JsString>(0)?.value(&mut cx);
    let iterations_handle = cx.argument::<JsValue>(1)?;

    let iterations: u64 = if let Ok(js_bigint) = iterations_handle.downcast::<JsBigInt, _>(&mut cx) {
        match js_bigint.to_u64(&mut cx) {
            Ok(val) => {
                // If Ok(), the conversion was successful and lossless.
                val
            },
            Err(_) => return cx.throw_error("Failed to convert BigInt to u64. It may be out of range (e.g., negative or too large)."),
        }
    } else if let Ok(js_number) = iterations_handle.downcast::<JsNumber, _>(&mut cx) {
        js_number.value(&mut cx) as u64
    } else {
        return cx.throw_error("Second argument 'iterations' must be a Number or a BigInt.");
    };

    // 2. Explicitly match the Result to handle errors clearly
    let vdf = match VDF::new_with_default_modulus() {
        Ok(instance) => instance,
        Err(e) => return cx.throw_error(e.to_string()),
    };

    let proof = match vdf.compute_with_proof(input_str.as_bytes(), WasmU64::from(iterations)) {
        Ok(p) => p,
        Err(e) => return cx.throw_error(e.to_string()),
    };

    // 3. Create the JS object to return
    let obj = cx.empty_object();
    let y = cx.string(hex::encode(&proof.y));
    let pi = cx.string(hex::encode(&proof.pi));
    let l = cx.string(hex::encode(&proof.l));
    let r = cx.string(hex::encode(&proof.r));
    let iter = cx.number(*proof.iterations as f64);

    obj.set(&mut cx, "y", y)?;
    obj.set(&mut cx, "pi", pi)?;
    obj.set(&mut cx, "l", l)?;
    obj.set(&mut cx, "r", r)?;
    obj.set(&mut cx, "iterations", iter)?;

    Ok(obj)
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    // VDF function (for mining-worker.js)
    cx.export_function("performVdfComputation", perform_vdf_computation)?;
    cx.export_function("findMiningSolution", find_mining_solution)?;
    
    // Database functions
    cx.export_function("initializeDatabase", db::initialize_database)?;

    // --- Functions for WASM (src/lib.rs) ---
    cx.export_function("load_block_from_db", db::load_block)?;
    cx.export_function("get_tip_height_from_db", db::get_tip_height)?;
    cx.export_function("save_total_work_to_db", db::save_total_work)?;
    cx.export_function("get_total_work_from_db", db::load_total_work)?;
    cx.export_function("save_utxo", db::save_utxo)?;
    cx.export_function("load_utxo", db::load_utxo)?;
    cx.export_function("delete_utxo", db::delete_utxo)?;
    cx.export_function("clear_all_utxos", db::clear_all_utxos)?;
    cx.export_function("loadAllUtxos", db::load_all_utxos)?; // Also used by worker.js
    cx.export_function("save_coinbase_index", db::save_coinbase_index)?;
    cx.export_function("delete_coinbase_index", db::delete_coinbase_index)?;
    cx.export_function("loadAllCoinbaseIndexes", db::load_all_coinbase_indexes)?; // Also used by worker.js
    cx.export_function("save_reorg_marker", db::save_reorg_marker)?;
    cx.export_function("clear_reorg_marker", db::clear_reorg_marker)?;
    cx.export_function("check_incomplete_reorg", db::check_incomplete_reorg)?;
    cx.export_function("save_block_to_staging", db::save_block_to_staging)?;
    cx.export_function("commit_staged_reorg", db::commit_staged_reorg)?;
    cx.export_function("saveBlockWithHash", db::save_block_with_hash)?; // Also used by worker.js
    cx.export_function("loadBlockByHash", db::load_block_by_hash)?; // Also used by worker.js

    // --- Functions for JS (worker.js) ---
    // Note: Some of these are duplicates of the above, just with the
    // camelCase names that worker.js expects.
    cx.export_function("saveBlock", db::save_block)?;
    cx.export_function("loadBlock", db::load_block)?;
    cx.export_function("getTipHeight", db::get_tip_height)?;
    cx.export_function("getChainTip", db::get_chain_tip)?;
    cx.export_function("getAllBlocks", db::get_all_blocks)?;
    cx.export_function("loadBlocks", db::load_blocks)?;
    cx.export_function("saveDeferredBlock", db::save_deferred_block)?;
    cx.export_function("loadAllDeferredBlocks", db::load_all_deferred_blocks)?;
    cx.export_function("clearDeferredBlocks", db::clear_deferred_blocks)?;
    cx.export_function("walletExists", db::wallet_exists)?;
    cx.export_function("loadWallet", db::load_wallet)?;
    cx.export_function("saveWallet", db::save_wallet)?;
    cx.export_function("isWalletEncrypted", db::is_wallet_encrypted)?;
    cx.export_function("saveTotalWork", db::save_total_work)?;
    cx.export_function("loadTotalWork", db::load_total_work)?;
    cx.export_function("deleteCanonicalBlock", db::delete_canonical_block)?;
    cx.export_function("setTipMetadata", db::set_tip_metadata)?;

    Ok(())
}
