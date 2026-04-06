export const backendName = "js" as const;

export function packedSize(inputLen: number): number {
  return (inputLen * 7 + 7) >> 3;
}

export function packInto(
  src: Uint8Array, srcOffset: number, srcLength: number,
  dst: Uint8Array, dstOffset: number,
): number {
  const chunks = (srcLength / 8) | 0;
  const remainder = srcLength % 8;
  const dstDV = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);

  for (let i = 0; i < chunks; i++) {
    const si = srcOffset + i * 8;
    const di = dstOffset + i * 7;
    const c0 = src[si]!;
    const c1 = src[si + 1]!;
    const c2 = src[si + 2]!;
    const c3 = src[si + 3]!;
    const c4 = src[si + 4]!;
    const c5 = src[si + 5]!;
    const c6 = src[si + 6]!;
    const c7 = src[si + 7]!;

    if ((c0 | c1 | c2 | c3 | c4 | c5 | c6 | c7) > 0x7f) {
      for (let j = 0; j < 8; j++) {
        if (src[si + j]! > 0x7f) {
          throw new Error(`non-ASCII byte 0x${src[si + j]!.toString(16)} at position ${si + j - srcOffset}`);
        }
      }
    }

    const lo = c0 | (c1 << 7) | (c2 << 14) | (c3 << 21) | ((c4 & 0x0f) << 28);
    const hi = (c4 >> 4) | (c5 << 3) | (c6 << 10) | (c7 << 17);

    dstDV.setUint32(di, lo, true);
    dst[di + 4] = hi & 0xff;
    dst[di + 5] = (hi >> 8) & 0xff;
    dst[di + 6] = (hi >> 16) & 0xff;
  }

  if (remainder > 0) {
    const si = srcOffset + chunks * 8;
    let di = dstOffset + chunks * 7;
    let bitBuf = 0;
    let bitsInBuf = 0;
    for (let j = 0; j < remainder; j++) {
      const b = src[si + j]!;
      if (b > 0x7f) {
        throw new Error(`non-ASCII byte 0x${b.toString(16)} at position ${si + j - srcOffset}`);
      }
      bitBuf |= b << bitsInBuf;
      bitsInBuf += 7;
      while (bitsInBuf >= 8) {
        dst[di++] = bitBuf & 0xff;
        bitBuf >>>= 8;
        bitsInBuf -= 8;
      }
    }
    if (bitsInBuf > 0) {
      dst[di] = bitBuf & 0xff;
    }
  }

  return packedSize(srcLength);
}

export function unpackInto(
  src: Uint8Array, srcOffset: number,
  dst: Uint8Array, dstOffset: number,
  originalLength: number,
): void {
  const fullBlocks = (originalLength / 8) | 0;
  const remainder = originalLength % 8;
  const srcDV = new DataView(src.buffer, src.byteOffset, src.byteLength);

  for (let i = 0; i < fullBlocks; i++) {
    const si = srcOffset + i * 7;
    const di = dstOffset + i * 8;

    const lo = srcDV.getUint32(si, true);
    const hi = src[si + 4]! | (src[si + 5]! << 8) | (src[si + 6]! << 16);

    dst[di] = lo & 0x7f;
    dst[di + 1] = (lo >> 7) & 0x7f;
    dst[di + 2] = (lo >> 14) & 0x7f;
    dst[di + 3] = (lo >> 21) & 0x7f;
    dst[di + 4] = ((lo >>> 28) | (hi << 4)) & 0x7f;
    dst[di + 5] = (hi >> 3) & 0x7f;
    dst[di + 6] = (hi >> 10) & 0x7f;
    dst[di + 7] = (hi >> 17) & 0x7f;
  }

  if (remainder > 0) {
    let si = srcOffset + fullBlocks * 7;
    const di = dstOffset + fullBlocks * 8;
    let bitBuf = 0;
    let bitsInBuf = 0;
    for (let j = 0; j < remainder; j++) {
      while (bitsInBuf < 7) {
        bitBuf |= src[si++]! << bitsInBuf;
        bitsInBuf += 8;
      }
      dst[di + j] = bitBuf & 0x7f;
      bitBuf >>>= 7;
      bitsInBuf -= 7;
    }
  }
}

export function pack7(input: Uint8Array | Buffer): Uint8Array {
  const outLen = packedSize(input.length);
  const output = new Uint8Array(outLen);
  packInto(input, 0, input.length, output, 0);
  return output;
}

export function unpack7(input: Uint8Array, originalLength: number): Uint8Array {
  const output = new Uint8Array(originalLength);
  unpackInto(input, 0, output, 0, originalLength);
  return output;
}

export function packSAB(
  sab: SharedArrayBuffer,
  srcOffset: number, srcLength: number,
  dstOffset: number,
): number {
  const view = new Uint8Array(sab);
  return packInto(view, srcOffset, srcLength, view, dstOffset);
}

export function unpackSAB(
  sab: SharedArrayBuffer,
  srcOffset: number,
  dstOffset: number,
  originalLength: number,
): void {
  const view = new Uint8Array(sab);
  unpackInto(view, srcOffset, view, dstOffset, originalLength);
}

export function createPacker(maxSize: number) {
  const inputBuffer = new Uint8Array(maxSize);
  const outputBuffer = new Uint8Array(packedSize(maxSize));

  return {
    inputBuffer,
    outputBuffer,
    pack(length: number): number {
      return packInto(inputBuffer, 0, length, outputBuffer, 0);
    },
    unpack(packedLength: number, originalLength: number): void {
      unpackInto(outputBuffer, 0, inputBuffer, 0, originalLength);
    },
    free() {},
  };
}
