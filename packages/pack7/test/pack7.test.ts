import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));

interface Backend {
  backendName: string;
  packedSize(n: number): number;
  pack7(input: Uint8Array | Buffer): Uint8Array;
  unpack7(input: Uint8Array, originalLength: number): Uint8Array;
  packInto(src: Uint8Array, srcOff: number, srcLen: number, dst: Uint8Array, dstOff: number): number;
  unpackInto(src: Uint8Array, srcOff: number, dst: Uint8Array, dstOff: number, origLen: number): void;
  packSAB(sab: SharedArrayBuffer, srcOff: number, srcLen: number, dstOff: number): number;
  unpackSAB(sab: SharedArrayBuffer, srcOff: number, dstOff: number, origLen: number): void;
  createPacker(maxSize: number): {
    readonly inputBuffer: Uint8Array;
    readonly outputBuffer: Uint8Array;
    pack(length: number): number;
    unpack(packedLength: number, originalLength: number): void;
    free(): void;
  };
}

function loadWasm(): Backend {
  const wasmPath = resolve(thisDir, "../wasm/pack7_wasm_bg.wasm");
  const bytes = readFileSync(wasmPath);
  const mod = new WebAssembly.Module(bytes);
  let instance: WebAssembly.Instance;
  const imports: WebAssembly.Imports = {
    "./pack7_wasm_bg.js": {
      __wbindgen_init_externref_table() {
        const table = (instance.exports as any).__wbindgen_externrefs;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
      },
    },
  };
  instance = new WebAssembly.Instance(mod, imports);
  const w = instance.exports as any;
  w.__wbindgen_start();

  function wasmPackInto(src: Uint8Array, srcOff: number, srcLen: number, dst: Uint8Array, dstOff: number): number {
    const outLen = (w.packed_size(srcLen)) >>> 0;
    const inPtr = (w.wasm_alloc(srcLen)) >>> 0;
    const outPtr = (w.wasm_alloc(outLen)) >>> 0;
    try {
      new Uint8Array(w.memory.buffer, inPtr, srcLen).set(src.subarray(srcOff, srcOff + srcLen));
      const written: number = w.pack7(inPtr, srcLen, outPtr, outLen);
      if (written < 0) { throw new Error("non-ASCII byte in input"); }
      dst.set(new Uint8Array(w.memory.buffer, outPtr, written), dstOff);
      return written;
    } finally {
      w.wasm_free(inPtr, srcLen);
      w.wasm_free(outPtr, outLen);
    }
  }

  function wasmUnpackInto(src: Uint8Array, srcOff: number, dst: Uint8Array, dstOff: number, origLen: number): void {
    const packedLen = (w.packed_size(origLen)) >>> 0;
    const inPtr = (w.wasm_alloc(packedLen)) >>> 0;
    const outPtr = (w.wasm_alloc(origLen)) >>> 0;
    try {
      new Uint8Array(w.memory.buffer, inPtr, packedLen).set(src.subarray(srcOff, srcOff + packedLen));
      w.unpack7(inPtr, packedLen, origLen, outPtr, origLen);
      dst.set(new Uint8Array(w.memory.buffer, outPtr, origLen), dstOff);
    } finally {
      w.wasm_free(inPtr, packedLen);
      w.wasm_free(outPtr, origLen);
    }
  }

  return {
    backendName: "wasm",
    packedSize(n) { return (w.packed_size(n)) >>> 0; },
    pack7(input) {
      const out = new Uint8Array((w.packed_size(input.length)) >>> 0);
      wasmPackInto(input, 0, input.length, out, 0);
      return out;
    },
    unpack7(input, origLen) {
      const out = new Uint8Array(origLen);
      wasmUnpackInto(input, 0, out, 0, origLen);
      return out;
    },
    packInto: wasmPackInto,
    unpackInto: wasmUnpackInto,
    packSAB(sab, srcOff, srcLen, dstOff) {
      const v = new Uint8Array(sab);
      return wasmPackInto(v, srcOff, srcLen, v, dstOff);
    },
    unpackSAB(sab, srcOff, dstOff, origLen) {
      const v = new Uint8Array(sab);
      wasmUnpackInto(v, srcOff, v, dstOff, origLen);
    },
    createPacker(maxSize) {
      const packedMax = (w.packed_size(maxSize)) >>> 0;
      const inPtr = (w.wasm_alloc(maxSize)) >>> 0;
      const outPtr = (w.wasm_alloc(packedMax)) >>> 0;
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
  };
}

function packedSize(n: number): number {
  return Math.ceil(n * 7 / 8);
}

const backends: [string, () => Promise<Backend>][] = [
  ["js", () => import("../dist/pack7-js.js")],
  ["native", async () => {
    const { getBackend } = await import("../dist/platform.js");
    const b = getBackend();
    if (b.backendName !== "native") { throw new Error(`expected native, got ${b.backendName}`); }
    return b;
  }],
  ["wasm", async () => loadWasm()],
];

describe.each(backends)("%s backend", (_name, loader) => {
  let b: Backend;

  beforeAll(async () => { b = await loader(); });

  test("roundtrip: empty input", () => {
    const packed = b.pack7(new Uint8Array(0));
    expect(packed.length).toBe(0);
    expect(b.unpack7(packed, 0).length).toBe(0);
  });

  test("roundtrip: single byte", () => {
    const input = new Uint8Array([0x41]);
    const packed = b.pack7(input);
    expect(packed.length).toBe(1);
    expect(b.unpack7(packed, 1)).toEqual(input);
  });

  test("roundtrip: 7 bytes", () => {
    const input = Buffer.from("abcdefg");
    const packed = b.pack7(input);
    expect(packed.length).toBe(packedSize(7));
    expect(Buffer.from(b.unpack7(packed, 7)).toString()).toBe("abcdefg");
  });

  test("roundtrip: 8 bytes (one full block)", () => {
    const input = Buffer.from("abcdefgh");
    const packed = b.pack7(input);
    expect(packed.length).toBe(7);
    expect(Buffer.from(b.unpack7(packed, 8)).toString()).toBe("abcdefgh");
  });

  test("roundtrip: 9 bytes (block + remainder)", () => {
    const input = Buffer.from("abcdefghi");
    const packed = b.pack7(input);
    expect(packed.length).toBe(packedSize(9));
    expect(Buffer.from(b.unpack7(packed, 9)).toString()).toBe("abcdefghi");
  });

  test("roundtrip: large payload (100KB+)", () => {
    const size = 102400;
    const input = new Uint8Array(size);
    for (let i = 0; i < size; i++) { input[i] = 0x20 + (i % 95); }
    const packed = b.pack7(input);
    expect(packed.length).toBe(packedSize(size));
    expect(b.unpack7(packed, size)).toEqual(input);
  });

  test("all printable ASCII (0x20-0x7E)", () => {
    const input = new Uint8Array(95);
    for (let i = 0; i < 95; i++) { input[i] = 0x20 + i; }
    expect(b.unpack7(b.pack7(input), input.length)).toEqual(input);
  });

  test("control chars (0x00-0x1F)", () => {
    const input = new Uint8Array(32);
    for (let i = 0; i < 32; i++) { input[i] = i; }
    expect(b.unpack7(b.pack7(input), input.length)).toEqual(input);
  });

  test("byte 0x7F (DEL - max valid)", () => {
    const input = new Uint8Array(100).fill(0x7f);
    expect(b.unpack7(b.pack7(input), 100)).toEqual(input);
  });

  test("byte 0x80+ throws", () => {
    expect(() => b.pack7(new Uint8Array([0x80]))).toThrow();
  });

  test("output length is ceil(n * 7 / 8)", () => {
    for (const n of [0, 1, 2, 7, 8, 9, 15, 16, 17, 100, 1000]) {
      expect(b.pack7(new Uint8Array(n).fill(0x41)).length).toBe(packedSize(n));
    }
  });

  test("packInto / unpackInto roundtrip", () => {
    const input = Buffer.from("hello world, pack7 test!");
    const len = input.length;
    const outLen = packedSize(len);
    const packed = new Uint8Array(outLen + 10);
    const written = b.packInto(input, 0, len, packed, 5);
    expect(written).toBe(outLen);
    const unpacked = new Uint8Array(len + 10);
    b.unpackInto(packed, 5, unpacked, 3, len);
    expect(Buffer.from(unpacked.subarray(3, 3 + len)).toString()).toBe("hello world, pack7 test!");
  });

  test("packInto with srcOffset", () => {
    const input = Buffer.from("XXXhello");
    const outLen = packedSize(5);
    const packed = new Uint8Array(outLen);
    b.packInto(input, 3, 5, packed, 0);
    expect(Buffer.from(b.unpack7(packed, 5)).toString()).toBe("hello");
  });

  test("packSAB / unpackSAB roundtrip", () => {
    const input = Buffer.from("SAB test data 1234567890");
    const len = input.length;
    const outLen = packedSize(len);
    const sab = new SharedArrayBuffer(len + outLen + 64);
    const view = new Uint8Array(sab);
    view.set(input, 0);
    const written = b.packSAB(sab, 0, len, len);
    expect(written).toBe(outLen);
    b.unpackSAB(sab, len, len + outLen, len);
    expect(Buffer.from(view.subarray(len + outLen, len + outLen + len)).toString()).toBe("SAB test data 1234567890");
  });

  test("createPacker roundtrip", () => {
    const packer = b.createPacker(1024);
    const input = Buffer.from("packer zero-copy test");
    packer.inputBuffer.set(input);
    const packed = packer.pack(input.length);
    expect(packed).toBe(packedSize(input.length));
    packer.unpack(packed, input.length);
    expect(Buffer.from(packer.inputBuffer.subarray(0, input.length)).toString()).toBe("packer zero-copy test");
    packer.free();
  });

  test("createPacker reuse across calls", () => {
    const packer = b.createPacker(256);
    for (const msg of ["first", "second message", "third!"]) {
      const buf = Buffer.from(msg);
      packer.inputBuffer.set(buf);
      const packed = packer.pack(buf.length);
      packer.unpack(packed, buf.length);
      expect(Buffer.from(packer.inputBuffer.subarray(0, buf.length)).toString()).toBe(msg);
    }
    packer.free();
  });
});
