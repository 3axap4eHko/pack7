export interface Packer {
  readonly inputBuffer: Uint8Array;
  readonly outputBuffer: Uint8Array;
  pack(length: number): number;
  unpack(packedLength: number, originalLength: number): void;
  free(): void;
}

export interface BackendModule {
  backendName: "native" | "wasm" | "js";
  packedSize(inputLen: number): number;
  pack7(input: Uint8Array | Buffer): Uint8Array;
  unpack7(input: Uint8Array, originalLength: number): Uint8Array;
  packInto(
    src: Uint8Array, srcOffset: number, srcLength: number,
    dst: Uint8Array, dstOffset: number,
  ): number;
  unpackInto(
    src: Uint8Array, srcOffset: number,
    dst: Uint8Array, dstOffset: number,
    originalLength: number,
  ): void;
  packSAB(
    sab: SharedArrayBuffer,
    srcOffset: number, srcLength: number,
    dstOffset: number,
  ): number;
  unpackSAB(
    sab: SharedArrayBuffer,
    srcOffset: number,
    dstOffset: number,
    originalLength: number,
  ): void;
  createPacker(maxSize: number): Packer;
}
