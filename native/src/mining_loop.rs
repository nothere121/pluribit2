// native/src/mining_loop.rs
use neon::prelude::*;
use neon::types::buffer::TypedArray;
use neon::types::{JsBigInt, JsString};
use neon_serde4::to_value; // To return a complex struct
use std::str::FromStr;

// Import the core logic from your Rust crate
use pluribit_core::{
    vdf::VDF,
    vrf::{create_vrf, VrfProof},
    vdf::VDFProof,
    wasm_types::WasmU64,
};
use curve25519_dalek::scalar::Scalar;

/// This is the struct we will serialize and return to JS
/// if a candidate is found.
#[derive(serde::Serialize)]
struct MiningCandidate {
    // Use String for u64 to be safe with JS (matches original `nonce.toString()`)
    nonce: String,
    vrf_proof: VrfProof,
    vdf_proof: VDFProof,
}

/// Safely converts a JsValue (BigInt, Number, or String) to u64.
fn js_value_to_u64(cx: &mut FunctionContext, val: Handle<JsValue>) -> NeonResult<u64> {
    if let Ok(js_bigint) = val.downcast::<JsBigInt, _>(cx) {
        match js_bigint.to_u64(cx) {
            Ok(v) => Ok(v),
            Err(_) => cx.throw_error("Failed to convert BigInt to u64. Out of range."),
        }
    } else if let Ok(js_number) = val.downcast::<JsNumber, _>(cx) {
        Ok(js_number.value(cx) as u64)
    } else if let Ok(js_string) = val.downcast::<JsString, _>(cx) {
        match u64::from_str(&js_string.value(cx)) {
            Ok(v) => Ok(v),
            Err(_) => cx.throw_error("Failed to parse u64 from string."),
        }
    } else {
        cx.throw_error("Argument must be a Number, BigInt, or string-serialized u64.")
    }
}

/// The new native mining loop.
/// This will block the worker thread, but that's what the worker is for.
/// JS Args:
/// 0: height (u64)
/// 1: minerPubkey (Vec<u8>)
/// 2: minerSecretKey (Vec<u8>)
/// 3: prevHash (String)
/// 4: vrfThreshold (Vec<u8>)
/// 5: vdfIterations (u64)
/// 6: startNonce (u64)
/// 7: batchSize (u64)
///
/// Returns: MiningCandidate (object) or null
pub fn find_mining_candidate_batch(mut cx: FunctionContext) -> JsResult<JsValue> {
    // --- 1. Parse Arguments (Corrected) ---
    
    // Get the handle first (immutable borrow)
    let height_handle = cx.argument::<JsValue>(0)?;
    // Then pass it to the helper (mutable borrow)
    let height = js_value_to_u64(&mut cx, height_handle)?;

    let miner_pubkey = cx.argument::<JsTypedArray<u8>>(1)?.as_slice(&cx).to_vec();
    let miner_secret_key_bytes = cx.argument::<JsTypedArray<u8>>(2)?.as_slice(&cx).to_vec();
    let prev_hash = cx.argument::<JsString>(3)?.value(&mut cx);
    let vrf_threshold = cx.argument::<JsTypedArray<u8>>(4)?.as_slice(&cx).to_vec();
    
    // Get the handle first
    let vdf_iterations_handle = cx.argument::<JsValue>(5)?;
    // Then pass it to the helper
    let vdf_iterations = js_value_to_u64(&mut cx, vdf_iterations_handle)?;
    
    // Get the handle first
    let start_nonce_handle = cx.argument::<JsValue>(6)?;
    // Then pass it to the helper
    let start_nonce = js_value_to_u64(&mut cx, start_nonce_handle)?;
    
    // Get the handle first
    let batch_size_handle = cx.argument::<JsValue>(7)?;
    // Then pass it to the helper
    let batch_size = js_value_to_u64(&mut cx, batch_size_handle)?;


    // --- 2. Setup Rust Types ---
    let vdf_instance = match VDF::new_with_default_modulus() {
        Ok(instance) => instance,
        Err(e) => return cx.throw_error(e.to_string()),
    };

    let mut sk_bytes = [0u8; 32];
    sk_bytes.copy_from_slice(&miner_secret_key_bytes);
    let secret_key = Scalar::from_bytes_mod_order(sk_bytes);

    let miner_pubkey_hex = hex::encode(&miner_pubkey);
    let vdf_iter_wasm = WasmU64::from(vdf_iterations);

    let end_nonce = start_nonce.saturating_add(batch_size);

    // --- 3. The Hot Loop (in Rust) ---
    for nonce in start_nonce..end_nonce {
        // 1. VDF
        let vdf_input = format!(
            "{}{}{}{}",
            height, prev_hash, miner_pubkey_hex, nonce
        );
        
        let vdf_proof = match vdf_instance.compute_with_proof(vdf_input.as_bytes(), vdf_iter_wasm) {
            Ok(p) => p,
            Err(_) => continue, // VDF error, try next nonce
        };

        // 2. VRF
        let vrf_proof = create_vrf(&secret_key, &vdf_proof.y);

        // 3. Check
        if vrf_proof.output.as_slice() < vrf_threshold.as_slice() {
            // We won!
            let candidate = MiningCandidate {
                nonce: nonce.to_string(),
                vrf_proof,
                vdf_proof,
            };
            
            // Serialize and return the winning candidate object
            let js_candidate = to_value(&mut cx, &candidate)
                .or_else(|e| cx.throw_error(e.to_string()))?;
            
            return Ok(js_candidate);
        }
    }

    // --- 4. No candidate found in batch ---
    Ok(cx.null().upcast())
}
