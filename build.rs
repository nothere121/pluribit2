fn main() -> std::io::Result<()> {
    // Rationale: prost-build needs an explicit flag to handle the 'optional'
    // keyword in proto3 schemas. This configures the underlying protoc compiler
    // to enable that experimental feature.
    let mut config = prost_build::Config::new();
    config.protoc_arg("--experimental_allow_proto3_optional");
    config.compile_protos(&["src/p2p.proto"], &["src/"])?;
    Ok(())
}
