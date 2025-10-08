// native/src/lib.rs
use neon::prelude::*;
use pluribit_core::vdf::VDF;

fn perform_vdf_computation(mut cx: FunctionContext) -> JsResult<JsObject> {
    // 1. Get arguments
    let input_str = cx.argument::<JsString>(0)?.value(&mut cx);
    let iterations = cx.argument::<JsNumber>(1)?.value(&mut cx) as u64;

    // 2. Explicitly match the Result to handle errors clearly
    let vdf = match VDF::new_with_default_modulus() {
        Ok(instance) => instance,
        Err(e) => return cx.throw_error(e.to_string()),
    };

    let proof = match vdf.compute_with_proof(input_str.as_bytes(), iterations) {
        Ok(p) => p,
        Err(e) => return cx.throw_error(e.to_string()),
    };

    // 3. Create the JS object to return
    let obj = cx.empty_object();
    let y = cx.string(hex::encode(&proof.y));
    let pi = cx.string(hex::encode(&proof.pi));
    let l = cx.string(hex::encode(&proof.l));
    let r = cx.string(hex::encode(&proof.r));
    let iter = cx.number(proof.iterations as f64);

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
