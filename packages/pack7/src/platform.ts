import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendModule, Packer } from "./types.js";
import * as jsFallback from "./pack7-js.js";

const PLATFORM_PACKAGES: Record<string, string> = {
  "linux-x64": "@9x/pack7-linux-x64-gnu",
  "linux-arm64": "@9x/pack7-linux-arm64-gnu",
  "darwin-x64": "@9x/pack7-darwin-x64",
  "darwin-arm64": "@9x/pack7-darwin-arm64",
  "win32-x64": "@9x/pack7-win32-x64-msvc",
};

const require = createRequire(import.meta.url);
const dir = dirname(fileURLToPath(import.meta.url));

function tryNative(): BackendModule | null {
  const key = `${process.platform}-${process.arch}`;
  const pkg = PLATFORM_PACKAGES[key];
  let addon: any;
  if (pkg) {
    try { addon = require(pkg); } catch {}
  }
  if (!addon) {
    try { addon = require(resolve(dir, "../../../crates/pack7-napi/pack7.node")); } catch {}
  }
  if (!addon) {
    return null;
  }

  function nativePackInto(
    src: Uint8Array, srcOffset: number, srcLength: number,
    dst: Uint8Array, dstOffset: number,
  ): number {
    return addon.packInto(
      Buffer.from(src.buffer, src.byteOffset, src.byteLength),
      srcOffset, srcLength,
      Buffer.from(dst.buffer, dst.byteOffset, dst.byteLength),
      dstOffset,
    );
  }

  function nativeUnpackInto(
    src: Uint8Array, srcOffset: number,
    dst: Uint8Array, dstOffset: number,
    originalLength: number,
  ): void {
    addon.unpackInto(
      Buffer.from(src.buffer, src.byteOffset, src.byteLength),
      srcOffset,
      Buffer.from(dst.buffer, dst.byteOffset, dst.byteLength),
      dstOffset,
      originalLength,
    );
  }

  return {
    backendName: "native",
    packedSize: addon.packedSize,
    pack7(input) {
      const outLen = addon.packedSize(input.length);
      const output = Buffer.allocUnsafe(outLen);
      nativePackInto(input, 0, input.length, output, 0);
      return output;
    },
    unpack7(input, originalLength) {
      const output = Buffer.allocUnsafe(originalLength);
      nativeUnpackInto(input, 0, output, 0, originalLength);
      return output;
    },
    packInto: nativePackInto,
    unpackInto: nativeUnpackInto,
    // SAB delegates to JS to avoid Rust aliasing UB when src and dst
    // are views into the same SharedArrayBuffer backing store.
    packSAB: jsFallback.packSAB,
    unpackSAB: jsFallback.unpackSAB,
    createPacker(maxSize: number): Packer {
      const packedMax = addon.packedSize(maxSize);
      const inputBuffer = Buffer.alloc(maxSize);
      const outputBuffer = Buffer.alloc(packedMax);
      return {
        inputBuffer,
        outputBuffer,
        pack(length) {
          return addon.packInto(inputBuffer, 0, length, outputBuffer, 0);
        },
        unpack(packedLength, originalLength) {
          addon.unpackInto(outputBuffer, 0, inputBuffer, 0, originalLength);
        },
        free() {},
      };
    },
  };
}

interface WasmExports {
  memory: WebAssembly.Memory;
  pack7(input_ptr: number, input_len: number, output_ptr: number, output_len: number): number;
  packed_size(input_len: number): number;
  unpack7(input_ptr: number, input_len: number, original_length: number, output_ptr: number, output_len: number): void;
  wasm_alloc(size: number): number;
  wasm_free(ptr: number, size: number): void;
  __wbindgen_externrefs: WebAssembly.Table;
  __wbindgen_start(): void;
}

function loadWasmSync(wasmPath: string): WasmExports | null {
  try {
    const bytes = readFileSync(wasmPath);
    const mod = new WebAssembly.Module(bytes);
    let instance: WebAssembly.Instance;
    const imports: WebAssembly.Imports = {
      "./pack7_wasm_bg.js": {
        __wbindgen_init_externref_table() {
          const table = (instance.exports as unknown as WasmExports).__wbindgen_externrefs;
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
    const wasm = instance.exports as unknown as WasmExports;
    wasm.__wbindgen_start();
    return wasm;
  } catch {
    return null;
  }
}

function tryWasm(): BackendModule | null {
  const wasmPath = resolve(dir, "../wasm/pack7_wasm_bg.wasm");
  const loaded = loadWasmSync(wasmPath);
  if (!loaded) {
    return null;
  }
  const wasm = loaded;

  return {
    backendName: "wasm",
    packedSize(n) { return (wasm.packed_size(n)) >>> 0; },
    // Convenience APIs use JS fallback -- crossing the WASM boundary
    // for caller-owned buffers adds alloc+copy overhead that's slower
    // than pure JS. WASM advantage is only through createPacker.
    pack7: jsFallback.pack7,
    unpack7: jsFallback.unpack7,
    packInto: jsFallback.packInto,
    unpackInto: jsFallback.unpackInto,
    packSAB: jsFallback.packSAB,
    unpackSAB: jsFallback.unpackSAB,
    createPacker(maxSize: number): Packer {
      const packedMax = (wasm.packed_size(maxSize)) >>> 0;
      const inPtr = (wasm.wasm_alloc(maxSize)) >>> 0;
      const outPtr = (wasm.wasm_alloc(packedMax)) >>> 0;
      let inputBuffer = new Uint8Array(wasm.memory.buffer, inPtr, maxSize);
      let outputBuffer = new Uint8Array(wasm.memory.buffer, outPtr, packedMax);
      return {
        get inputBuffer() {
          if (inputBuffer.buffer !== wasm.memory.buffer) {
            inputBuffer = new Uint8Array(wasm.memory.buffer, inPtr, maxSize);
          }
          return inputBuffer;
        },
        get outputBuffer() {
          if (outputBuffer.buffer !== wasm.memory.buffer) {
            outputBuffer = new Uint8Array(wasm.memory.buffer, outPtr, packedMax);
          }
          return outputBuffer;
        },
        pack(length) {
          const written = wasm.pack7(inPtr, length, outPtr, packedMax);
          if (written < 0) {
            throw new Error("non-ASCII byte in input");
          }
          return written;
        },
        unpack(packedLength, originalLength) {
          wasm.unpack7(outPtr, packedLength, originalLength, inPtr, maxSize);
        },
        free() {
          wasm.wasm_free(inPtr, maxSize);
          wasm.wasm_free(outPtr, packedMax);
        },
      };
    },
  };
}

let resolved: BackendModule | undefined;

export function getBackend(): BackendModule {
  if (resolved) {
    return resolved;
  }
  resolved = tryNative() ?? tryWasm() ?? undefined;
  if (!resolved) {
    resolved = { ...jsFallback, backendName: "js" as const };
  }
  return resolved;
}
