export const backendName = "js" as const;

export function packedSize(inputLen: number): number {
  return Math.ceil(inputLen * 7 / 8);
}

function isValidRange(length: number, offset: number, rangeLength: number): boolean {
  return Number.isInteger(offset)
    && Number.isInteger(rangeLength)
    && offset >= 0
    && rangeLength >= 0
    && offset + rangeLength <= length;
}

function regionsOverlap(aOff: number, aLen: number, bOff: number, bLen: number): boolean {
  return aOff < bOff + bLen && bOff < aOff + aLen;
}

function sameBackingStore(a: Uint8Array, b: Uint8Array): boolean {
  return a.buffer === b.buffer;
}

function byteOffset(view: Uint8Array, offset: number): number {
  return view.byteOffset + offset;
}

export function validateAscii(src: Uint8Array, srcOffset = 0, srcLength = src.length - srcOffset): boolean {
  if (!isValidRange(src.length, srcOffset, srcLength)) {
    return false;
  }
  for (let i = 0; i < srcLength; i++) {
    if (src[srcOffset + i]! > 0x7f) {
      return false;
    }
  }
  return true;
}

export function packInto(
  src: Uint8Array, srcOffset: number, srcLength: number,
  dst: Uint8Array, dstOffset: number,
): number {
  const chunks = (srcLength / 8) | 0;
  const remainder = srcLength % 8;

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

    const lo = c0 | (c1 << 7) | (c2 << 14) | (c3 << 21) | ((c4 & 0x0f) << 28);
    const hi = (c4 >> 4) | (c5 << 3) | (c6 << 10) | (c7 << 17);

    dst[di] = lo & 0xff;
    dst[di + 1] = (lo >> 8) & 0xff;
    dst[di + 2] = (lo >> 16) & 0xff;
    dst[di + 3] = (lo >> 24) & 0xff;
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

export function packIntoSafe(
  src: Uint8Array, srcOffset: number, srcLength: number,
  dst: Uint8Array, dstOffset: number,
): number | undefined {
  if (!isValidRange(src.length, srcOffset, srcLength) || !validateAscii(src, srcOffset, srcLength)) {
    return undefined;
  }
  const outLen = packedSize(srcLength);
  if (!isValidRange(dst.length, dstOffset, outLen)) {
    return undefined;
  }
  if (
    sameBackingStore(src, dst)
    && regionsOverlap(byteOffset(src, srcOffset), srcLength, byteOffset(dst, dstOffset), outLen)
  ) {
    const copy = new Uint8Array(src.subarray(srcOffset, srcOffset + srcLength));
    return packInto(copy, 0, srcLength, dst, dstOffset);
  }
  return packInto(src, srcOffset, srcLength, dst, dstOffset);
}

export function unpackInto(
  src: Uint8Array, srcOffset: number,
  dst: Uint8Array, dstOffset: number,
  originalLength: number,
): void {
  const fullBlocks = (originalLength / 8) | 0;
  const remainder = originalLength % 8;

  for (let i = 0; i < fullBlocks; i++) {
    const si = srcOffset + i * 7;
    const di = dstOffset + i * 8;

    const lo = src[si]! | (src[si + 1]! << 8) | (src[si + 2]! << 16) | (src[si + 3]! << 24);
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

export function unpackIntoSafe(
  src: Uint8Array, srcOffset: number,
  dst: Uint8Array, dstOffset: number,
  originalLength: number,
): number | undefined {
  if (
    !Number.isInteger(originalLength)
    || originalLength < 0
  ) {
    return undefined;
  }
  const packedLen = packedSize(originalLength);
  if (!isValidRange(src.length, srcOffset, packedLen) || !isValidRange(dst.length, dstOffset, originalLength)) {
    return undefined;
  }
  if (
    sameBackingStore(src, dst)
    && regionsOverlap(byteOffset(src, srcOffset), packedLen, byteOffset(dst, dstOffset), originalLength)
  ) {
    const copy = new Uint8Array(src.subarray(srcOffset, srcOffset + packedLen));
    unpackInto(copy, 0, dst, dstOffset, originalLength);
    return originalLength;
  }
  unpackInto(src, srcOffset, dst, dstOffset, originalLength);
  return originalLength;
}

export function pack7(input: Uint8Array | Buffer): Uint8Array {
  const outLen = packedSize(input.length);
  const output = new Uint8Array(outLen);
  packInto(input, 0, input.length, output, 0);
  return output;
}

export function pack7Safe(input: Uint8Array | Buffer): Uint8Array | undefined {
  if (!validateAscii(input)) {
    return undefined;
  }
  return pack7(input);
}

export function unpack7(input: Uint8Array, originalLength: number): Uint8Array {
  const output = new Uint8Array(originalLength);
  unpackInto(input, 0, output, 0, originalLength);
  return output;
}

export function unpack7Safe(input: Uint8Array, originalLength: number): Uint8Array | undefined {
  if (
    !Number.isInteger(originalLength)
    || originalLength < 0
    || !isValidRange(input.length, 0, packedSize(originalLength))
  ) {
    return undefined;
  }
  return unpack7(input, originalLength);
}

export function packSAB(
  sab: SharedArrayBuffer,
  srcOffset: number, srcLength: number,
  dstOffset: number,
): number {
  const view = new Uint8Array(sab);
  const outLen = packedSize(srcLength);
  if (regionsOverlap(srcOffset, srcLength, dstOffset, outLen)) {
    const srcCopy = new Uint8Array(view.subarray(srcOffset, srcOffset + srcLength));
    return packInto(srcCopy, 0, srcLength, view, dstOffset);
  }
  return packInto(view, srcOffset, srcLength, view, dstOffset);
}

export function unpackSAB(
  sab: SharedArrayBuffer,
  srcOffset: number,
  dstOffset: number,
  originalLength: number,
): void {
  const view = new Uint8Array(sab);
  const pLen = packedSize(originalLength);
  if (regionsOverlap(srcOffset, pLen, dstOffset, originalLength)) {
    const srcCopy = new Uint8Array(view.subarray(srcOffset, srcOffset + pLen));
    unpackInto(srcCopy, 0, view, dstOffset, originalLength);
    return;
  }
  unpackInto(view, srcOffset, view, dstOffset, originalLength);
}

export function createPacker(maxSize: number) {
  const inputBuffer = new Uint8Array(maxSize);
  const outputBuffer = new Uint8Array(packedSize(maxSize));

  return {
    inputBuffer,
    outputBuffer,
    pack(length: number): number {
      if (length > maxSize) {
        throw new RangeError(`length ${length} exceeds packer maxSize ${maxSize}`);
      }
      return packInto(inputBuffer, 0, length, outputBuffer, 0);
    },
    unpack(packedLength: number, originalLength: number): void {
      if (originalLength > maxSize) {
        throw new RangeError(`originalLength ${originalLength} exceeds packer maxSize ${maxSize}`);
      }
      const expected = packedSize(originalLength);
      if (packedLength < expected) {
        throw new RangeError(`packed length ${packedLength} too short for ${originalLength} bytes (need ${expected})`);
      }
      unpackInto(outputBuffer, 0, inputBuffer, 0, originalLength);
    },
    free() {},
  };
}
