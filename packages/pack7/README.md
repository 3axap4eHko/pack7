# pack7

7-bit ASCII packing for binary transports. Every ASCII byte wastes its MSB — pack7 strips it, fitting 8 bytes into 7. Fixed 12.5% bandwidth reduction, zero-alloc encode/decode, sub-microsecond latency.

Built for FIX gateways, game networking, and SharedArrayBuffer worker pipelines.

## Install

```bash
npm install @9x/pack7
```

Native addon is installed automatically via `optionalDependencies` for supported platforms (linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64). Falls back to WASM, then pure JS.

## How it works

ASCII bytes are `0XXXXXXX` — the top bit is always zero. Stack 8 values at 7-bit offsets and the zeros vanish:

```
c0 | (c1 << 7) | (c2 << 14) | ... | (c7 << 49)  →  56 bits  →  7 bytes
```

No masking, no compression tables, no dictionary state. One pass in, one pass out.

## API

```ts
import { pack7, unpack7, backendName } from '@9x/pack7';

console.log(backendName); // 'native' | 'wasm' | 'js'

// Simple — allocates output
const packed = pack7(Buffer.from('8=FIX.4.4\x019=148\x0135=D'));
const original = unpack7(packed, 23);
```

### Zero-alloc: `packInto` / `unpackInto`

Caller provides the buffers. No allocation in the hot path.

```ts
import { packInto, unpackInto, packedSize } from '@9x/pack7';

const src = Buffer.from(message);
const dst = new Uint8Array(packedSize(src.length));

packInto(src, 0, src.length, dst, 0);
unpackInto(dst, 0, output, 0, src.length);
```

### Zero-copy: `createPacker`

Pre-allocated encoder/decoder. Write into `inputBuffer`, call `pack()`, read from `outputBuffer`. With the WASM backend, both buffers live in WASM linear memory — no copies cross the boundary.

```ts
import { createPacker } from '@9x/pack7';

const packer = createPacker(4096);

// encode
packer.inputBuffer.set(messageBytes);
const packedLen = packer.pack(messageBytes.length);
socket.write(packer.outputBuffer.subarray(0, packedLen));

// decode
packer.outputBuffer.set(incomingPacked);
packer.unpack(incomingPacked.length, originalLength);
const decoded = packer.inputBuffer.subarray(0, originalLength);

packer.free(); // release when done
```

### SharedArrayBuffer

Operate directly on shared memory across workers. No `postMessage` transfer, no serialization.

```ts
import { packSAB, unpackSAB } from '@9x/pack7';

const sab = new SharedArrayBuffer(8192);
// worker A writes ASCII into sab[0..len), then:
const packedLen = packSAB(sab, 0, len, 4096);
// worker B reads packed data from sab[4096..4096+packedLen), then:
unpackSAB(sab, 4096, 0, len);
```

## Benchmarks

Node v24, linux-x64:

### Encode latency

| | 64B | 512B | 4KB | 64KB | 1MB |
|---|---|---|---|---|---|
| js alloc | 0.3 µs | 0.5 µs | 3.3 µs | 38.4 µs | 616 µs |
| js into | 0.1 µs | 0.3 µs | 2.2 µs | 34.9 µs | 567 µs |
| native packer | 0.1 µs | 0.3 µs | 1.7 µs | 25.0 µs | 404 µs |
| wasm packer | 0.1 µs | 0.3 µs | 2.4 µs | 37.2 µs | 605 µs |

### Decode latency

| | 64B | 512B | 4KB | 64KB | 1MB |
|---|---|---|---|---|---|
| js into | 0.1 µs | 0.3 µs | 1.7 µs | 25.3 µs | 410 µs |
| native packer | 0.1 µs | 0.2 µs | 0.7 µs | 9.8 µs | 155 µs |
| wasm packer | 0.0 µs | 0.1 µs | 1.0 µs | 15.5 µs | 248 µs |

### FIX message roundtrip (200B, p50 / p99 / p999)

| Backend | p50 | p99 | p999 |
|---|---|---|---|
| js | 0.3 µs | 0.4 µs | 2.4 µs |
| native | 0.3 µs | 0.5 µs | 1.0 µs |
| wasm | 0.2 µs | 0.3 µs | 0.4 µs |

### Throughput

Native packer peaks at **2.5 GB/s** encode, **6.5 GB/s** decode at 1MB payload. JS pure reaches 1.8 GB/s encode.

Run benchmarks yourself:

```bash
node packages/pack7/bench/index.mjs
node --expose-gc packages/pack7/bench/index.mjs  # includes GC pressure test
```

## When to use this

**Yes:**
- FIX protocol — ASCII tag=value over raw TCP, small messages, gzip latency unacceptable
- Game networking — per-tick ASCII payloads in binary frames at 60+ Hz
- SharedArrayBuffer workers — zero-copy cross-thread ASCII encoding
- Any binary transport carrying ASCII where you want bandwidth savings without compression overhead

**No:**
- Data inside JSON strings — output is binary (0x00–0xFF), not text-safe
- Large payloads where latency budget allows it — gzip saves 80%+, pack7 saves 12.5%
- Non-ASCII data — input must be 0x00–0x7F, throws on anything above

## Backend selection

Auto-detected at import time:

1. **Native** (napi-rs) — fastest for large payloads, Rust `u64` ops, zero-copy `Buffer` access
2. **WASM** — lowest latency for small messages (<4KB), runs in V8 isolate, near-zero call overhead
3. **JS** — always available, DataView-based u32 split, no dependencies

```ts
import { backendName } from '@9x/pack7';
// 'native' | 'wasm' | 'js'
```

## Protocol note

`originalLength` is required for `unpack7` — the packed stream doesn't encode its own length. Transmit it separately, e.g., as a 4-byte LE prefix:

```ts
const hdr = Buffer.alloc(4);
hdr.writeUInt32LE(originalLength);
socket.write(Buffer.concat([hdr, packedData]));
```

See [WIRE.md](./WIRE.md) for the full wire format reference.

## License

MIT
