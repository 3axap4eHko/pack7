use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::ptr;

#[napi]
pub fn packed_size(input_len: u32) -> u32 {
    pack7_core::packed_size(input_len as usize) as u32
}

#[napi]
pub fn validate_ascii(input: Buffer) -> bool {
    unsafe { validate_ascii_raw(input.as_ptr(), input.len()) }
}

#[napi]
pub fn pack7(input: Buffer) -> Buffer {
    let out_len = pack7_core::packed_size(input.len());
    let mut output = vec![0u8; out_len];
    unsafe {
        pack7_into_raw(input.as_ptr(), input.len(), output.as_mut_ptr());
    }
    output.into()
}

#[napi]
pub fn pack7_safe(input: Buffer) -> Option<Buffer> {
    if !unsafe { validate_ascii_raw(input.as_ptr(), input.len()) } {
        return None;
    }
    Some(pack7(input))
}

#[napi]
pub fn unpack7(input: Buffer, original_length: u32) -> Buffer {
    let mut output = vec![0u8; original_length as usize];
    unsafe {
        unpack7_into_raw(
            input.as_ptr(),
            original_length as usize,
            output.as_mut_ptr(),
        );
    }
    output.into()
}

#[napi]
pub fn unpack7_safe(input: Buffer, original_length: u32) -> Option<Buffer> {
    let original_length = original_length as usize;
    if input.len() < pack7_core::packed_size(original_length) {
        return None;
    }
    let mut output = vec![0u8; original_length];
    unsafe {
        unpack7_into_raw(input.as_ptr(), original_length, output.as_mut_ptr());
    }
    Some(output.into())
}

#[napi]
pub fn pack_into(
    src: Buffer,
    src_offset: u32,
    src_length: u32,
    mut dst: Buffer,
    dst_offset: u32,
) -> u32 {
    let src_off = src_offset as usize;
    let src_len = src_length as usize;
    let dst_off = dst_offset as usize;
    unsafe {
        pack7_into_raw(
            src.as_ptr().add(src_off),
            src_len,
            dst.as_mut_ptr().add(dst_off),
        ) as u32
    }
}

#[napi]
pub fn pack_into_safe(
    src: Buffer,
    src_offset: u32,
    src_length: u32,
    mut dst: Buffer,
    dst_offset: u32,
) -> Option<u32> {
    let src_off = src_offset as usize;
    let src_len = src_length as usize;
    let dst_off = dst_offset as usize;
    let out_len = pack7_core::packed_size(src_len);
    checked_range(src.len(), src_off, src_len)?;
    checked_range(dst.len(), dst_off, out_len)?;

    let src_ptr = unsafe { src.as_ptr().add(src_off) };
    let dst_ptr = unsafe { dst.as_mut_ptr().add(dst_off) };
    if !unsafe { validate_ascii_raw(src_ptr, src_len) } {
        return None;
    }
    if ranges_overlap(src_ptr, src_len, dst_ptr.cast_const(), out_len) {
        let copy = unsafe { copy_raw(src_ptr, src_len) };
        unsafe {
            pack7_into_raw(copy.as_ptr(), src_len, dst_ptr);
        }
    } else {
        unsafe {
            pack7_into_raw(src_ptr, src_len, dst_ptr);
        }
    }
    Some(out_len as u32)
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
    unsafe {
        unpack7_into_raw(
            src.as_ptr().add(src_off),
            orig_len,
            dst.as_mut_ptr().add(dst_off),
        );
    }
}

#[napi]
pub fn unpack_into_safe(
    src: Buffer,
    src_offset: u32,
    mut dst: Buffer,
    dst_offset: u32,
    original_length: u32,
) -> Option<u32> {
    let src_off = src_offset as usize;
    let dst_off = dst_offset as usize;
    let orig_len = original_length as usize;
    let packed_len = pack7_core::packed_size(orig_len);
    checked_range(src.len(), src_off, packed_len)?;
    checked_range(dst.len(), dst_off, orig_len)?;

    let src_ptr = unsafe { src.as_ptr().add(src_off) };
    let dst_ptr = unsafe { dst.as_mut_ptr().add(dst_off) };
    if ranges_overlap(src_ptr, packed_len, dst_ptr.cast_const(), orig_len) {
        let copy = unsafe { copy_raw(src_ptr, packed_len) };
        unsafe {
            unpack7_into_raw(copy.as_ptr(), orig_len, dst_ptr);
        }
    } else {
        unsafe {
            unpack7_into_raw(src_ptr, orig_len, dst_ptr);
        }
    }
    Some(orig_len as u32)
}

fn checked_range(len: usize, offset: usize, range_len: usize) -> Option<usize> {
    let end = offset.checked_add(range_len)?;
    (end <= len).then_some(end)
}

fn ranges_overlap(a_ptr: *const u8, a_len: usize, b_ptr: *const u8, b_len: usize) -> bool {
    let a_start = a_ptr as usize;
    let b_start = b_ptr as usize;
    let Some(a_end) = a_start.checked_add(a_len) else {
        return true;
    };
    let Some(b_end) = b_start.checked_add(b_len) else {
        return true;
    };
    a_start < b_end && b_start < a_end
}

unsafe fn copy_raw(ptr: *const u8, len: usize) -> Vec<u8> {
    let mut copy = vec![0u8; len];
    if len != 0 {
        unsafe {
            ptr::copy_nonoverlapping(ptr, copy.as_mut_ptr(), len);
        }
    }
    copy
}

unsafe fn validate_ascii_raw(ptr: *const u8, len: usize) -> bool {
    for i in 0..len {
        if unsafe { *ptr.add(i) } > 0x7f {
            return false;
        }
    }
    true
}

unsafe fn pack7_into_raw(input: *const u8, input_len: usize, output: *mut u8) -> usize {
    let out_len = pack7_core::packed_size(input_len);
    let chunks = input_len / 8;
    let remainder = input_len % 8;

    for i in 0..chunks {
        let src = unsafe { input.add(i * 8) };
        let val: u64 = unsafe {
            (*src as u64)
                | ((*src.add(1) as u64) << 7)
                | ((*src.add(2) as u64) << 14)
                | ((*src.add(3) as u64) << 21)
                | ((*src.add(4) as u64) << 28)
                | ((*src.add(5) as u64) << 35)
                | ((*src.add(6) as u64) << 42)
                | ((*src.add(7) as u64) << 49)
        };
        let bytes = val.to_le_bytes();
        unsafe {
            ptr::copy_nonoverlapping(bytes.as_ptr(), output.add(i * 7), 7);
        }
    }

    if remainder > 0 {
        let src = unsafe { input.add(chunks * 8) };
        let mut accum: u64 = 0;
        for j in 0..remainder {
            accum |= unsafe { (*src.add(j) as u64) << (j * 7) };
        }
        let bytes = accum.to_le_bytes();
        unsafe {
            ptr::copy_nonoverlapping(
                bytes.as_ptr(),
                output.add(chunks * 7),
                pack7_core::packed_size(remainder),
            );
        }
    }

    out_len
}

unsafe fn unpack7_into_raw(input: *const u8, original_length: usize, output: *mut u8) {
    let full_blocks = original_length / 8;
    let remainder = original_length % 8;

    for i in 0..full_blocks {
        let mut bytes = [0u8; 8];
        unsafe {
            ptr::copy_nonoverlapping(input.add(i * 7), bytes.as_mut_ptr(), 7);
        }
        let val = u64::from_le_bytes(bytes);
        let dst = unsafe { output.add(i * 8) };
        for j in 0..8 {
            unsafe {
                *dst.add(j) = ((val >> (j * 7)) & 0x7f) as u8;
            }
        }
    }

    if remainder > 0 {
        let remaining_bytes = pack7_core::packed_size(remainder);
        let mut bytes = [0u8; 8];
        unsafe {
            ptr::copy_nonoverlapping(
                input.add(full_blocks * 7),
                bytes.as_mut_ptr(),
                remaining_bytes,
            );
        }
        let val = u64::from_le_bytes(bytes);
        let dst = unsafe { output.add(full_blocks * 8) };
        for j in 0..remainder {
            unsafe {
                *dst.add(j) = ((val >> (j * 7)) & 0x7f) as u8;
            }
        }
    }
}
