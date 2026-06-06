import { performance } from "node:perf_hooks";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));

const SIZES = [8, 64, 512, 4096];
const INNER = 2000;
const SAMPLES = 400;
const WARMUP_SAMPLES = 120;

let sink = 0;

function makePayload(size) {
  const chars = '{"key":value,01234567890abcdefghijklmnopqrstuvwxyz}';
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    buf[i] = chars.charCodeAt(i % chars.length);
  }
  return buf;
}

function median(sorted) {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function stddev(arr, mean) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) { const d = arr[i] - mean; s += d * d; }
  return Math.sqrt(s / arr.length);
}

function timePerCall(loopFn) {
  for (let s = 0; s < WARMUP_SAMPLES; s++) { loopFn(); }
  const perCall = new Float64Array(SAMPLES);
  for (let s = 0; s < SAMPLES; s++) {
    const t0 = performance.now();
    loopFn();
    perCall[s] = ((performance.now() - t0) * 1e6) / INNER;
  }
  const sorted = Float64Array.from(perCall).sort();
  const med = median(sorted);
  return { med, min: sorted[0], sd: stddev(perCall, perCall.reduce((a, b) => a + b, 0) / SAMPLES) };
}

// pack() already carries the bound guard internally, so the public API has no
// unguarded path. This isolates the marginal cost of one guard comparison by
// measuring pack() against pack() with one extra comparison in front.
function buildWrappers(packer, length) {
  const withExtraGuard = (len) => {
    if (len > packer.maxSize) { throw new RangeError("exceeds maxSize"); }
    return packer.pack(len);
  };
  const baseline = (len) => packer.pack(len);
  return {
    extraGuardLoop() { let acc = 0; for (let i = 0; i < INNER; i++) { acc += withExtraGuard(length); } sink += acc; },
    baselineLoop() { let acc = 0; for (let i = 0; i < INNER; i++) { acc += baseline(length); } sink += acc; },
  };
}

function bareGuardFloor(maxSize) {
  const lens = new Int32Array(8);
  for (let i = 0; i < 8; i++) { lens[i] = maxSize - (i & 3); }
  return {
    guardLoop() {
      let acc = 0;
      for (let i = 0; i < INNER; i++) {
        const len = lens[i & 7];
        if (len > maxSize) { throw new RangeError("x"); }
        acc += len;
      }
      sink += acc;
    },
    nopLoop() {
      let acc = 0;
      for (let i = 0; i < INNER; i++) { acc += lens[i & 7]; }
      sink += acc;
    },
  };
}

function fmtNs(ns) { return `${ns.toFixed(3)} ns`; }

function reportPair(label, base, withGuard) {
  const delta = withGuard.med - base.med;
  const pct = base.med > 0 ? (delta / base.med) * 100 : 0;
  const noise = Math.max(base.sd, withGuard.sd);
  const verdict = Math.abs(delta) <= noise ? "within noise" : "above noise";
  console.log(
    `  ${label.padEnd(18)} baseline=${fmtNs(base.med).padStart(11)}  +guard=${fmtNs(withGuard.med).padStart(11)}  ` +
    `delta=${(delta >= 0 ? "+" : "") + delta.toFixed(3)} ns (${(pct >= 0 ? "+" : "") + pct.toFixed(2)}%)  ` +
    `[sd~${noise.toFixed(3)} ns, ${verdict}]`,
  );
}

async function loadJs() {
  const mod = await import(pathToFileURL(resolve(thisDir, "../dist/pack7-js.js")).href);
  return { name: "js", makePacker: (max) => ({ ...mod.createPacker(max), maxSize: max }) };
}

async function loadNative() {
  const { getBackend } = await import(pathToFileURL(resolve(thisDir, "../dist/platform.js")).href);
  const b = getBackend();
  if (b.backendName !== "native") { return null; }
  return { name: "native", makePacker: (max) => ({ ...b.createPacker(max), maxSize: max }) };
}

async function main() {
  console.log(`\nguard microbench - Node ${process.version}, ${process.platform}-${process.arch}`);
  console.log(`INNER=${INNER} SAMPLES=${SAMPLES} (median ns/call)\n`);

  const backends = [await loadJs(), await loadNative()].filter(Boolean);

  console.log("Bare guard floor (single `if (len > maxSize)` per iteration, no packing):");
  {
    const { guardLoop, nopLoop } = bareGuardFloor(4096);
    const nop = timePerCall(nopLoop);
    const grd = timePerCall(guardLoop);
    reportPair("loop body", nop, grd);
  }
  console.log("");

  for (const backend of backends) {
    console.log(`${backend.name} createPacker.pack() marginal cost of one guard comparison:`);
    for (const size of SIZES) {
      const packer = backend.makePacker(size);
      packer.inputBuffer.set(makePayload(size));
      const { extraGuardLoop, baselineLoop } = buildWrappers(packer, size);
      const base = timePerCall(baselineLoop);
      const grd = timePerCall(extraGuardLoop);
      reportPair(`${size}B`, base, grd);
      if (packer.free) { packer.free(); }
    }
    console.log("");
  }

  if (sink === 42) { console.log("(sink)"); }
}

main();
