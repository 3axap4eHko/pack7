import { performance } from "node:perf_hooks";
import { writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));

const WARMUP = 500;
const ITERS = 5000;
const SIZES = [64, 512, 4096, 65536, 1048576];

function makePayload(size) {
  const chars = '{"key":value,01234567890abcdefghijklmnopqrstuvwxyz}';
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    buf[i] = chars.charCodeAt(i % chars.length);
  }
  return buf;
}

function percentile(sorted, p) {
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, idx)];
}

function measure(fn, warmup, iters) {
  for (let i = 0; i < warmup; i++) { fn(); }
  const times = new Float64Array(iters);
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    times[i] = (performance.now() - t0) * 1000;
  }
  times.sort();
  return times;
}

function throughputMBs(bytes, medianUs) {
  if (medianUs === 0) { return Infinity; }
  return bytes / (medianUs / 1e6) / (1024 * 1024);
}

function fmtUs(us) {
  if (us >= 1000) { return `${(us / 1000).toFixed(1)} ms`; }
  return `${us.toFixed(1)} us`;
}

function fmtMBs(mbs) {
  if (mbs >= 1000) { return `${(mbs / 1000).toFixed(1)} GB/s`; }
  return `${mbs.toFixed(0)} MB/s`;
}

function fmtSize(bytes) {
  if (bytes >= 1048576) { return `${(bytes / 1048576).toFixed(0)}MB`; }
  if (bytes >= 1024) { return `${(bytes / 1024).toFixed(0)}KB`; }
  return `${bytes}B`;
}

async function loadBackends() {
  const js = await import(pathToFileURL(resolve(thisDir, "../dist/pack7-js.js")).href);
  const { getBackend } = await import(pathToFileURL(resolve(thisDir, "../dist/platform.js")).href);
  const best = getBackend();

  const backends = [{ name: "js", mod: js }];

  if (best.backendName === "native") {
    backends.push({ name: "native", mod: best });
  }

  // Try wasm via createPacker/alloc only (packInto delegates to JS, so skip "into" row)
  try {
    const wasmPath = resolve(thisDir, "../wasm/pack7_wasm_bg.wasm");
    const bytes = readFileSync(wasmPath);
    const wasmMod = new WebAssembly.Module(bytes);
    let instance;
    const imports = {
      "./pack7_wasm_bg.js": {
        __wbindgen_init_externref_table() {
          const table = instance.exports.__wbindgen_externrefs;
          const offset = table.grow(4);
          table.set(0, undefined);
          table.set(offset + 0, undefined);
          table.set(offset + 1, null);
          table.set(offset + 2, true);
          table.set(offset + 3, false);
        },
      },
    };
    instance = new WebAssembly.Instance(wasmMod, imports);
    const w = instance.exports;
    w.__wbindgen_start();

    backends.push({
      name: "wasm",
      mod: {
        packedSize(n) { return w.packed_size(n) >>> 0; },
        pack7(input) {
          const outLen = w.packed_size(input.length) >>> 0;
          const inPtr = w.wasm_alloc(input.length) >>> 0;
          const outPtr = w.wasm_alloc(outLen) >>> 0;
          try {
            new Uint8Array(w.memory.buffer, inPtr, input.length).set(input);
            const written = w.pack7(inPtr, input.length, outPtr, outLen);
            return new Uint8Array(new Uint8Array(w.memory.buffer, outPtr, written));
          } finally {
            w.wasm_free(inPtr, input.length);
            w.wasm_free(outPtr, outLen);
          }
        },
        unpack7(input, origLen) {
          const inPtr = w.wasm_alloc(input.length) >>> 0;
          const outPtr = w.wasm_alloc(origLen) >>> 0;
          try {
            new Uint8Array(w.memory.buffer, inPtr, input.length).set(input);
            w.unpack7(inPtr, input.length, origLen, outPtr, origLen);
            return new Uint8Array(new Uint8Array(w.memory.buffer, outPtr, origLen));
          } finally {
            w.wasm_free(inPtr, input.length);
            w.wasm_free(outPtr, origLen);
          }
        },
        // No packInto — wasm zero-copy path is createPacker only
        createPacker(maxSize) {
          const packedMax = w.packed_size(maxSize) >>> 0;
          const inPtr = w.wasm_alloc(maxSize) >>> 0;
          const outPtr = w.wasm_alloc(packedMax) >>> 0;
          return {
            get inputBuffer() { return new Uint8Array(w.memory.buffer, inPtr, maxSize); },
            get outputBuffer() { return new Uint8Array(w.memory.buffer, outPtr, packedMax); },
            pack(length) {
              const ret = w.pack7(inPtr, length, outPtr, packedMax);
              if (ret < 0) { throw new Error("non-ASCII"); }
              return ret;
            },
            unpack(packedLength, originalLength) {
              w.unpack7(outPtr, packedLength, originalLength, inPtr, maxSize);
            },
            free() { w.wasm_free(inPtr, maxSize); w.wasm_free(outPtr, packedMax); },
          };
        },
      },
    });
  } catch {}

  return backends;
}

function printTable(title, header, rows) {
  console.log(`${title}:`);
  console.log(header);
  console.log(header.replace(/[^|]/g, "-"));
  for (const row of rows) { console.log(row); }
  console.log();
}

async function main() {
  const backends = await loadBackends();
  const results = [];

  console.log(`\n@9x/pack7 benchmark - Node ${process.version}, ${process.platform}-${process.arch}\n`);

  const header = ["".padEnd(14), ...SIZES.map(s => fmtSize(s).padStart(10))].join(" |");
  const encRows = [];
  const decRows = [];
  const tputRows = [];

  for (const { name, mod } of backends) {
    // pack7 (allocating)
    const allocEnc = [`${name} alloc`.padEnd(14)];
    const allocDec = [`${name} alloc`.padEnd(14)];
    const allocTput = [`${name} alloc`.padEnd(14)];
    for (const size of SIZES) {
      const payload = makePayload(size);
      const encTimes = measure(() => mod.pack7(payload), WARMUP, ITERS);
      const packed = mod.pack7(payload);
      const decTimes = measure(() => mod.unpack7(packed, size), WARMUP, ITERS);
      const encMedian = percentile(encTimes, 0.5);
      const decMedian = percentile(decTimes, 0.5);
      results.push({
        backend: name, api: "alloc", payloadBytes: size,
        encodeMedianUs: encMedian, encodeP99Us: percentile(encTimes, 0.99),
        encodeThroughputMBs: throughputMBs(size, encMedian),
        decodeMedianUs: decMedian, decodeP99Us: percentile(decTimes, 0.99),
        decodeThroughputMBs: throughputMBs(size, decMedian),
      });
      allocEnc.push(fmtUs(encMedian).padStart(10));
      allocDec.push(fmtUs(decMedian).padStart(10));
      allocTput.push(fmtMBs(throughputMBs(size, encMedian)).padStart(10));
    }
    encRows.push(allocEnc.join(" |"));
    decRows.push(allocDec.join(" |"));
    tputRows.push(allocTput.join(" |"));

    // packInto (pre-alloc) -- only for backends that implement it natively
    if (mod.packInto) {
      const intoEnc = [`${name} into`.padEnd(14)];
      const intoDec = [`${name} into`.padEnd(14)];
      const intoTput = [`${name} into`.padEnd(14)];
      for (const size of SIZES) {
        const payload = makePayload(size);
        const outLen = mod.packedSize(size);
        const packed = new Uint8Array(outLen);
        const unpacked = new Uint8Array(size);
        const encTimes = measure(() => mod.packInto(payload, 0, size, packed, 0), WARMUP, ITERS);
        mod.packInto(payload, 0, size, packed, 0);
        const decTimes = measure(() => mod.unpackInto(packed, 0, unpacked, 0, size), WARMUP, ITERS);
        const encMedian = percentile(encTimes, 0.5);
        const decMedian = percentile(decTimes, 0.5);
        results.push({
          backend: name, api: "into", payloadBytes: size,
          encodeMedianUs: encMedian, encodeP99Us: percentile(encTimes, 0.99),
          encodeThroughputMBs: throughputMBs(size, encMedian),
          decodeMedianUs: decMedian, decodeP99Us: percentile(decTimes, 0.99),
          decodeThroughputMBs: throughputMBs(size, decMedian),
        });
        intoEnc.push(fmtUs(encMedian).padStart(10));
        intoDec.push(fmtUs(decMedian).padStart(10));
        intoTput.push(fmtMBs(throughputMBs(size, encMedian)).padStart(10));
      }
      encRows.push(intoEnc.join(" |"));
      decRows.push(intoDec.join(" |"));
      tputRows.push(intoTput.join(" |"));
    }

    // createPacker (zero-copy)
    if (mod.createPacker) {
      const packerEnc = [`${name} packer`.padEnd(14)];
      const packerDec = [`${name} packer`.padEnd(14)];
      const packerTput = [`${name} packer`.padEnd(14)];
      for (const size of SIZES) {
        const payload = makePayload(size);
        const packer = mod.createPacker(size);
        packer.inputBuffer.set(payload);
        const encTimes = measure(() => packer.pack(size), WARMUP, ITERS);
        const packedLen = packer.pack(size);
        const decTimes = measure(() => packer.unpack(packedLen, size), WARMUP, ITERS);
        const encMedian = percentile(encTimes, 0.5);
        const decMedian = percentile(decTimes, 0.5);
        results.push({
          backend: name, api: "packer", payloadBytes: size,
          encodeMedianUs: encMedian, encodeP99Us: percentile(encTimes, 0.99),
          encodeThroughputMBs: throughputMBs(size, encMedian),
          decodeMedianUs: decMedian, decodeP99Us: percentile(decTimes, 0.99),
          decodeThroughputMBs: throughputMBs(size, decMedian),
        });
        packerEnc.push(fmtUs(encMedian).padStart(10));
        packerDec.push(fmtUs(decMedian).padStart(10));
        packerTput.push(fmtMBs(throughputMBs(size, encMedian)).padStart(10));
        packer.free();
      }
      encRows.push(packerEnc.join(" |"));
      decRows.push(packerDec.join(" |"));
      tputRows.push(packerTput.join(" |"));
    }
  }

  printTable("Encode median latency", header, encRows);
  printTable("Decode median latency", header, decRows);
  printTable("Encode throughput", header, tputRows);

  // FIX message latency test
  console.log("FIX message roundtrip (200B):");
  const fixMsg = Buffer.from(
    "8=FIX.4.4\x019=148\x0135=D\x0149=SENDER\x0156=TARGET\x0134=1\x0152=20240101-12:00:00.000\x0111=order123\x0121=1\x0155=AAPL\x0154=1\x0160=20240101-12:00:00.000\x0138=100\x0140=2\x0144=150.50\x0110=128\x01",
    "ascii",
  );
  const fixIters = 50000;
  for (const { name, mod } of backends) {
    if (!mod.createPacker) { continue; }
    const packer = mod.createPacker(fixMsg.length);
    packer.inputBuffer.set(fixMsg);
    const times = new Float64Array(fixIters);
    for (let i = 0; i < WARMUP; i++) {
      const pl = packer.pack(fixMsg.length);
      packer.unpack(pl, fixMsg.length);
    }
    for (let i = 0; i < fixIters; i++) {
      const t0 = performance.now();
      const pl = packer.pack(fixMsg.length);
      packer.unpack(pl, fixMsg.length);
      times[i] = (performance.now() - t0) * 1000;
    }
    times.sort();
    console.log(`  ${name}: p50=${fmtUs(percentile(times, 0.5))} p99=${fmtUs(percentile(times, 0.99))} p999=${fmtUs(percentile(times, 0.999))}`);
    packer.free();
  }

  // GC pressure test
  if (global.gc) {
    console.log("\nGC pressure (10K iterations, 4KB payload):");
    const payload4k = makePayload(4096);
    for (const { name, mod } of backends) {
      global.gc();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 10000; i++) {
        const p = mod.pack7(payload4k);
        mod.unpack7(p, 4096);
      }
      global.gc();
      const after = process.memoryUsage().heapUsed;
      console.log(`  ${name} alloc: heap delta = ${((after - before) / 1024).toFixed(1)} KB`);

      if (mod.createPacker) {
        const packer = mod.createPacker(4096);
        packer.inputBuffer.set(payload4k);
        global.gc();
        const before2 = process.memoryUsage().heapUsed;
        for (let i = 0; i < 10000; i++) {
          const pl = packer.pack(4096);
          packer.unpack(pl, 4096);
        }
        global.gc();
        const after2 = process.memoryUsage().heapUsed;
        console.log(`  ${name} packer: heap delta = ${((after2 - before2) / 1024).toFixed(1)} KB`);
        packer.free();
      }
    }
  } else {
    console.log("\nSkipping GC pressure test (run with --expose-gc)");
  }

  writeFileSync(resolve(thisDir, "bench-results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`\nResults written to bench-results.json`);
}

main().catch(console.error);
