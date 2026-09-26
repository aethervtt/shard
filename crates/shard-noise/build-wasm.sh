#!/bin/sh
# Builds the noise kernel twice (scalar and simd128) and copies both into packages/noise/wasm,
# where they're committed so the TypeScript packages keep no build step.
set -e
cd "$(dirname "$0")/../.."
cargo build -p shard-noise --release --target wasm32-unknown-unknown --target-dir target/wasm
RUSTFLAGS="-C target-feature=+simd128" cargo build -p shard-noise --release \
  --target wasm32-unknown-unknown --target-dir target/wasm-simd
mkdir -p packages/noise/wasm
cp target/wasm/wasm32-unknown-unknown/release/shard_noise.wasm packages/noise/wasm/shard_noise.wasm
cp target/wasm-simd/wasm32-unknown-unknown/release/shard_noise.wasm packages/noise/wasm/shard_noise_simd.wasm
ls -l packages/noise/wasm
