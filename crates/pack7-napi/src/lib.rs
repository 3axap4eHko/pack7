use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn packed_size(input_len: u32) -> u32 {
    pack7_core::packed_size(input_len as usize) as u32
}

#[napi]
pub fn pack7(input: Buffer) -> Result<Buffer> {
    pack7_core::pack7(&input)
        .map(|v| v.into())
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn unpack7(input: Buffer, original_length: u32) -> Buffer {
    pack7_core::unpack7(&input, original_length as usize).into()
}

#[napi]
pub fn pack_into(
    src: Buffer,
    src_offset: u32,
    src_length: u32,
    mut dst: Buffer,
    dst_offset: u32,
) -> Result<u32> {
    let src_off = src_offset as usize;
    let src_len = src_length as usize;
    let dst_off = dst_offset as usize;
    pack7_core::pack7_into(&src[src_off..src_off + src_len], &mut dst[dst_off..])
        .map(|n| n as u32)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn unpack_into(
    src: Buffer,
    src_offset: u32,
    mut dst: Buffer,
    dst_offset: u32,
    original_length: u32,
) {
    let src_off = src_offset as usize;
    let dst_off = dst_offset as usize;
    let orig_len = original_length as usize;
    let packed_len = pack7_core::packed_size(orig_len);
    pack7_core::unpack7_into(
        &src[src_off..src_off + packed_len],
        orig_len,
        &mut dst[dst_off..dst_off + orig_len],
    );
}
