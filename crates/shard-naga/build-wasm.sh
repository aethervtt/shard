#!/bin/sh
# Builds naga (WGSL in, GLSL ES 3.00 out) for the WebGL2 backend and copies it into
# packages/gpu-webgl2/wasm, where it's committed so the TypeScript packages keep no build step.
set -e
cd "$(dirname "$0")/../.."
cargo build -p shard-naga --release --target wasm32-unknown-unknown --target-dir target/wasm
mkdir -p packages/gpu-webgl2/wasm
cp target/wasm/wasm32-unknown-unknown/release/shard_naga.wasm packages/gpu-webgl2/wasm/shard_naga.wasm
ls -l packages/gpu-webgl2/wasm
