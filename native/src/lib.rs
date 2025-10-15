// native/src/lib.rs
use neon::prelude::*;
use neon::types::JsBigInt;
use pluribit_core::vdf::VDF;
use pluribit_core::wasm_types::WasmU64;

fn perform_vdf_computation(mut cx: FunctionContext) -> JsResult<JsObject> {
    // 1. Get arguments
    let input_str = cx.argument::<JsString>(0)?.value(&mut cx);
    let iterations_handle = cx.argument::<JsValue>(1)?;

    let iterations: u64 = if let Ok(js_bigint) = iterations_handle.downcast::<JsBigInt, _>(&mut cx) {
        // --- START: CORRECTED BigInt HANDLING ---
        match js_bigint.to_u64(&mut cx) {
            Ok(val) => {
                // If Ok(), the conversion was successful and lossless.
                val
            },
            Err(_) => return cx.throw_error("Failed to convert BigInt to u64. It may be out of range (e.g., negative or too large)."),
        }
        // --- END: CORRECTED BigInt HANDLING ---
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
    cx.export_function("performVdfComputation", perform_vdf_computation)?;
    Ok(())
}
