import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));

interface Backend {
  backendName: string;
  packedSize(n: number): number;
  validateAscii(input: Uint8Array | Buffer, inputOffset?: number, inputLength?: number): boolean;
  pack7(input: Uint8Array | Buffer): Uint8Array;
  pack7Safe(input: Uint8Array | Buffer): Uint8Array | undefined;
  unpack7(input: Uint8Array, originalLength: number): Uint8Array;
  unpack7Safe(input: Uint8Array, originalLength: number): Uint8Array | undefined;
  packInto(src: Uint8Array, srcOff: number, srcLen: number, dst: Uint8Array, dstOff: number): number;
  packIntoSafe(
    src: Uint8Array,
    srcOff: number,
    srcLen: number,
    dst: Uint8Array,
    dstOff: number,
  ): number | undefined;
  unpackInto(src: Uint8Array, srcOff: number, dst: Uint8Array, dstOff: number, origLen: number): void;
  unpackIntoSafe(
    src: Uint8Array,
    srcOff: number,
    dst: Uint8Array,
    dstOff: number,
    origLen: number,
  ): number | undefined;
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
      const written: number = w.pack7(inPtr, srcLen, outPtr);
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
      w.unpack7(inPtr, origLen, outPtr);
      dst.set(new Uint8Array(w.memory.buffer, outPtr, origLen), dstOff);
    } finally {
      w.wasm_free(inPtr, packedLen);
      w.wasm_free(outPtr, origLen);
    }
  }

  function wasmPackIntoSafe(src: Uint8Array, srcOff: number, srcLen: number, dst: Uint8Array, dstOff: number): number | undefined {
    if (!validRange(src.length, srcOff, srcLen) || !validateAscii(src, srcOff, srcLen)) {
      return undefined;
    }
    const outLen = (w.packed_size(srcLen)) >>> 0;
    if (!validRange(dst.length, dstOff, outLen)) {
      return undefined;
    }
    return wasmPackInto(src, srcOff, srcLen, dst, dstOff);
  }

  function wasmUnpackIntoSafe(src: Uint8Array, srcOff: number, dst: Uint8Array, dstOff: number, origLen: number): number | undefined {
    if (
      !Number.isInteger(origLen)
      || origLen < 0
    ) {
      return undefined;
    }
    const packedLen = (w.packed_size(origLen)) >>> 0;
    if (!validRange(src.length, srcOff, packedLen) || !validRange(dst.length, dstOff, origLen)) {
      return undefined;
    }
    wasmUnpackInto(src, srcOff, dst, dstOff, origLen);
    return origLen;
  }

  return {
    backendName: "wasm",
    packedSize(n) { return (w.packed_size(n)) >>> 0; },
    validateAscii,
    pack7(input) {
      const out = new Uint8Array((w.packed_size(input.length)) >>> 0);
      wasmPackInto(input, 0, input.length, out, 0);
      return out;
    },
    pack7Safe(input) {
      if (!validateAscii(input)) {
        return undefined;
      }
      const out = new Uint8Array((w.packed_size(input.length)) >>> 0);
      wasmPackInto(input, 0, input.length, out, 0);
      return out;
    },
    unpack7(input, origLen) {
      const out = new Uint8Array(origLen);
      wasmUnpackInto(input, 0, out, 0, origLen);
      return out;
    },
    unpack7Safe(input, origLen) {
      if (
        !Number.isInteger(origLen)
        || origLen < 0
        || !validRange(input.length, 0, (w.packed_size(origLen)) >>> 0)
      ) {
        return undefined;
      }
      const out = new Uint8Array(origLen);
      wasmUnpackInto(input, 0, out, 0, origLen);
      return out;
    },
    packInto: wasmPackInto,
    packIntoSafe: wasmPackIntoSafe,
    unpackInto: wasmUnpackInto,
    unpackIntoSafe: wasmUnpackIntoSafe,
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
      let freed = false;
      return {
        get inputBuffer() { return new Uint8Array(w.memory.buffer, inPtr, maxSize); },
        get outputBuffer() { return new Uint8Array(w.memory.buffer, outPtr, packedMax); },
        pack(length) {
          if (length > maxSize) {
            throw new RangeError(`length ${length} exceeds packer maxSize ${maxSize}`);
          }
          return (w.pack7(inPtr, length, outPtr)) >>> 0;
        },
        unpack(packedLength, originalLength) {
          if (originalLength > maxSize) {
            throw new RangeError(`originalLength ${originalLength} exceeds packer maxSize ${maxSize}`);
          }
          const expected = (w.packed_size(originalLength)) >>> 0;
          if (packedLength < expected) {
            throw new RangeError(`packed length ${packedLength} too short for ${originalLength} bytes (need ${expected})`);
          }
          w.unpack7(outPtr, originalLength, inPtr);
        },
        free() {
          if (freed) { return; }
          freed = true;
          w.wasm_free(inPtr, maxSize);
          w.wasm_free(outPtr, packedMax);
        },
      };
    },
  };
}

function packedSize(n: number): number {
  return Math.ceil(n * 7 / 8);
}

function validRange(length: number, offset: number, rangeLength: number): boolean {
  return Number.isInteger(offset)
    && Number.isInteger(rangeLength)
    && offset >= 0
    && rangeLength >= 0
    && offset + rangeLength <= length;
}

function validateAscii(input: Uint8Array, inputOffset = 0, inputLength = input.length - inputOffset): boolean {
  if (!validRange(input.length, inputOffset, inputLength)) {
    return false;
  }
  for (let i = 0; i < inputLength; i++) {
    if (input[inputOffset + i]! > 0x7f) {
      return false;
    }
  }
  return true;
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

  test("raw pack accepts non-ASCII by contract", () => {
    const input = new Uint8Array([0x80]);
    expect(() => b.pack7(input)).not.toThrow();
    expect(b.pack7(input).length).toBe(packedSize(input.length));
    expect(b.validateAscii(input)).toBe(false);
    expect(b.pack7Safe(input)).toBeUndefined();
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

  test("packInto works with same ArrayBuffer when ranges do not overlap", () => {
    const input = Buffer.from("same backing store without overlap");
    const len = input.length;
    const outLen = packedSize(len);
    const buf = new Uint8Array(len + outLen + len + 32);
    buf.set(input, 0);
    const packedOffset = len + 8;
    const unpackedOffset = packedOffset + outLen + 8;
    expect(b.packInto(buf, 0, len, buf, packedOffset)).toBe(outLen);
    b.unpackInto(buf, packedOffset, buf, unpackedOffset, len);
    expect(Buffer.from(buf.subarray(unpackedOffset, unpackedOffset + len)).toString()).toBe(input.toString());
  });

  test("packIntoSafe validates ASCII and ranges without throwing", () => {
    expect(b.packIntoSafe(new Uint8Array([0x80]), 0, 1, new Uint8Array(1), 0)).toBeUndefined();
    expect(b.packIntoSafe(new Uint8Array([0x41]), 0, 1, new Uint8Array(0), 0)).toBeUndefined();
    expect(b.unpackIntoSafe(new Uint8Array(0), 0, new Uint8Array(1), 0, 1)).toBeUndefined();
    expect(b.unpack7Safe(new Uint8Array(0), 1)).toBeUndefined();
  });

  test("packIntoSafe handles overlapping same ArrayBuffer", () => {
    const input = Buffer.from("overlapping packIntoSafe payload");
    const len = input.length;
    const outLen = packedSize(len);
    const buf = new Uint8Array(len + outLen + 16);
    buf.set(input, 0);
    expect(b.packIntoSafe(buf, 0, len, buf, 4)).toBe(outLen);
    expect(Buffer.from(b.unpack7(buf.subarray(4, 4 + outLen), len)).toString()).toBe(input.toString());
  });

  test("unpackIntoSafe handles overlapping same ArrayBuffer", () => {
    const input = Buffer.from("overlapping unpackIntoSafe payload");
    const len = input.length;
    const packed = b.pack7(input);
    const buf = new Uint8Array(packed.length + len + 16);
    buf.set(packed, 0);
    expect(b.unpackIntoSafe(buf, 0, buf, 3, len)).toBe(len);
    expect(Buffer.from(buf.subarray(3, 3 + len)).toString()).toBe(input.toString());
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

  test("packSAB handles overlapping regions", () => {
    const input = Buffer.from("SAB overlapping pack payload");
    const len = input.length;
    const outLen = packedSize(len);
    const sab = new SharedArrayBuffer(len + outLen + 16);
    const view = new Uint8Array(sab);
    view.set(input, 0);
    expect(b.packSAB(sab, 0, len, 4)).toBe(outLen);
    expect(Buffer.from(b.unpack7(view.subarray(4, 4 + outLen), len)).toString()).toBe(input.toString());
  });

  test("unpackSAB handles overlapping regions", () => {
    const input = Buffer.from("SAB overlapping unpack payload");
    const len = input.length;
    const packed = b.pack7(input);
    const sab = new SharedArrayBuffer(packed.length + len + 16);
    const view = new Uint8Array(sab);
    view.set(packed, 0);
    b.unpackSAB(sab, 0, 3, len);
    expect(Buffer.from(view.subarray(3, 3 + len)).toString()).toBe(input.toString());
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

  test("createPacker.pack rejects length > maxSize", () => {
    const packer = b.createPacker(8);
    expect(() => packer.pack(9)).toThrow();
    packer.free();
  });

  test("createPacker.unpack rejects originalLength > maxSize", () => {
    const packer = b.createPacker(8);
    expect(() => packer.unpack(packedSize(9), 9)).toThrow();
    packer.free();
  });

  test("createPacker.unpack rejects packedLength shorter than required", () => {
    const packer = b.createPacker(64);
    const input = Buffer.from("roundtrip guard payload");
    packer.inputBuffer.set(input);
    const packed = packer.pack(input.length);
    expect(() => packer.unpack(packed - 1, input.length)).toThrow();
    packer.free();
  });

  test("createPacker(0) roundtrips and survives zero-size alloc", () => {
    const packer = b.createPacker(0);
    expect(packer.pack(0)).toBe(0);
    expect(() => packer.unpack(0, 0)).not.toThrow();
    packer.free();
  });

  test("createPacker.free is idempotent", () => {
    const packer = b.createPacker(16);
    packer.free();
    expect(() => packer.free()).not.toThrow();
  });
});
