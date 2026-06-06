#![allow(clippy::missing_safety_doc)]

use std::alloc::{Layout, alloc, dealloc};
use std::ptr;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub unsafe fn wasm_alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return ptr::NonNull::<u8>::dangling().as_ptr();
    }
    let Ok(layout) = Layout::from_size_align(size, 1) else {
        return ptr::null_mut();
    };
    unsafe { alloc(layout) }
}

#[wasm_bindgen]
pub unsafe fn wasm_free(ptr: *mut u8, size: usize) {
    if size == 0 {
        return;
    }
    let Ok(layout) = Layout::from_size_align(size, 1) else {
        return;
    };
    unsafe {
        dealloc(ptr, layout);
    }
}

#[wasm_bindgen]
pub fn packed_size(input_len: usize) -> usize {
    pack7_core::packed_size(input_len)
}

#[wasm_bindgen]
pub unsafe fn validate_ascii(input_ptr: *const u8, input_len: usize) -> bool {
    unsafe { validate_ascii_raw(input_ptr, input_len) }
}

#[wasm_bindgen]
pub unsafe fn pack7(input_ptr: *const u8, input_len: usize, output_ptr: *mut u8) -> usize {
    unsafe { pack7_into_raw(input_ptr, input_len, output_ptr) }
}

#[wasm_bindgen]
pub unsafe fn pack7_safe(
    input_ptr: *const u8,
    input_len: usize,
    output_ptr: *mut u8,
    output_len: usize,
) -> i32 {
    let out_len = pack7_core::packed_size(input_len);
    if output_len < out_len || !unsafe { validate_ascii_raw(input_ptr, input_len) } {
        return -1;
    }
    unsafe {
        pack7_into_raw(input_ptr, input_len, output_ptr);
    }
    out_len as i32
}

#[wasm_bindgen]
pub unsafe fn unpack7(input_ptr: *const u8, original_length: usize, output_ptr: *mut u8) {
    unsafe {
        unpack7_into_raw(input_ptr, original_length, output_ptr);
    }
}

#[wasm_bindgen]
pub unsafe fn unpack7_safe(
    input_ptr: *const u8,
    input_len: usize,
    original_length: usize,
    output_ptr: *mut u8,
    output_len: usize,
) -> i32 {
    if input_len < pack7_core::packed_size(original_length) || output_len < original_length {
        return -1;
    }
    unsafe {
        unpack7_into_raw(input_ptr, original_length, output_ptr);
    }
    original_length as i32
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
