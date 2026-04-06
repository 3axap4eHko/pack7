# @9x/pack7

Ultra-low-latency 7-bit ASCII packing for binary transports. Saves 12.5% bandwidth with zero-alloc encode/decode. Built for FIX gateways, game networking, and SharedArrayBuffer worker pipelines.

See [packages/pack7](./packages/pack7) for API documentation and benchmarks.

## Monorepo structure

```
crates/
  pack7-core/     Pure Rust core algorithm
  pack7-napi/     napi-rs v3 native addon
  pack7-wasm/     wasm-bindgen WASM target
packages/
  pack7/          @9x/pack7 npm package
```

## Build

```bash
pnpm install
pnpm -w run build:napi
pnpm -w run build:wasm
pnpm -r run build
```

## Test

```bash
cargo test --workspace
bun test packages/pack7/test/
```

## Bench

```bash
node --expose-gc packages/pack7/bench/index.mjs
```

## License

MIT
