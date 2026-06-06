export type { BackendModule, Packer } from "./types.js";
import { getBackend } from "./platform.js";

const backend = getBackend();

export const backendName = backend.backendName;
export const packedSize = backend.packedSize;
export const validateAscii = backend.validateAscii;
export const pack7 = backend.pack7;
export const pack7Safe = backend.pack7Safe;
export const unpack7 = backend.unpack7;
export const unpack7Safe = backend.unpack7Safe;
export const packInto = backend.packInto;
export const packIntoSafe = backend.packIntoSafe;
export const unpackInto = backend.unpackInto;
export const unpackIntoSafe = backend.unpackIntoSafe;
export const packSAB = backend.packSAB;
export const unpackSAB = backend.unpackSAB;
export const createPacker = backend.createPacker;
