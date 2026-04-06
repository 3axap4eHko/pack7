#![allow(clippy::missing_safety_doc)]

use std::alloc::{Layout, alloc, dealloc};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub unsafe fn wasm_alloc(size: usize) -> *mut u8 {
    let layout = Layout::from_size_align(size, 1).unwrap();
    unsafe { alloc(layout) }
}

#[wasm_bindgen]
pub unsafe fn wasm_free(ptr: *mut u8, size: usize) {
    let layout = Layout::from_size_align(size, 1).unwrap();
    unsafe { dealloc(ptr, layout) }
}

#[wasm_bindgen]
pub fn packed_size(input_len: usize) -> usize {
    pack7_core::packed_size(input_len)
}

#[wasm_bindgen]
pub unsafe fn pack7(
    input_ptr: *const u8,
    input_len: usize,
    output_ptr: *mut u8,
    output_len: usize,
) -> i32 {
    let input = unsafe { std::slice::from_raw_parts(input_ptr, input_len) };
    let output = unsafe { std::slice::from_raw_parts_mut(output_ptr, output_len) };
    match pack7_core::pack7_into(input, output) {
        Ok(n) => n as i32,
        Err(_) => -1,
    }
}

#[wasm_bindgen]
pub unsafe fn unpack7(
    input_ptr: *const u8,
    input_len: usize,
    original_length: usize,
    output_ptr: *mut u8,
    output_len: usize,
) {
    let input = unsafe { std::slice::from_raw_parts(input_ptr, input_len) };
    let output = unsafe { std::slice::from_raw_parts_mut(output_ptr, output_len) };
    pack7_core::unpack7_into(input, original_length, output);
}
