use core::fmt;

#[derive(Debug)]
pub enum Pack7Error {
    NonAscii { position: usize, value: u8 },
}

impl fmt::Display for Pack7Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Pack7Error::NonAscii { position, value } => {
                write!(f, "non-ASCII byte 0x{value:02x} at position {position}")
            }
        }
    }
}

impl std::error::Error for Pack7Error {}

pub fn packed_size(input_len: usize) -> usize {
    (input_len * 7).div_ceil(8)
}

pub fn validate_ascii(input: &[u8]) -> Result<(), Pack7Error> {
    for (i, &b) in input.iter().enumerate() {
        if b > 0x7f {
            return Err(Pack7Error::NonAscii {
                position: i,
                value: b,
            });
        }
    }
    Ok(())
}

pub fn pack7(input: &[u8]) -> Result<Vec<u8>, Pack7Error> {
    validate_ascii(input)?;
    let mut output = vec![0u8; packed_size(input.len())];
    pack7_into(input, &mut output)?;
    Ok(output)
}

pub fn pack7_into(input: &[u8], output: &mut [u8]) -> Result<usize, Pack7Error> {
    validate_ascii(input)?;
    let out_len = packed_size(input.len());
    let chunks = input.len() / 8;
    let remainder = input.len() % 8;

    for i in 0..chunks {
        let src = &input[i * 8..];
        let val: u64 = (src[0] as u64)
            | ((src[1] as u64) << 7)
            | ((src[2] as u64) << 14)
            | ((src[3] as u64) << 21)
            | ((src[4] as u64) << 28)
            | ((src[5] as u64) << 35)
            | ((src[6] as u64) << 42)
            | ((src[7] as u64) << 49);
        output[i * 7..i * 7 + 7].copy_from_slice(&val.to_le_bytes()[..7]);
    }

    if remainder > 0 {
        let src = &input[chunks * 8..];
        let dst = &mut output[chunks * 7..];
        let mut accum: u64 = 0;
        for (j, &b) in src.iter().enumerate() {
            accum |= (b as u64) << (j * 7);
        }
        let out_bytes = packed_size(remainder);
        dst[..out_bytes].copy_from_slice(&accum.to_le_bytes()[..out_bytes]);
    }

    Ok(out_len)
}

pub fn unpack7(input: &[u8], original_length: usize) -> Vec<u8> {
    let mut output = vec![0u8; original_length];
    unpack7_into(input, original_length, &mut output);
    output
}

pub fn unpack7_into(input: &[u8], original_length: usize, output: &mut [u8]) {
    let full_blocks = original_length / 8;
    let remainder = original_length % 8;

    for i in 0..full_blocks {
        let src = &input[i * 7..];
        let mut bytes = [0u8; 8];
        bytes[..7].copy_from_slice(&src[..7]);
        let val = u64::from_le_bytes(bytes);
        let dst = &mut output[i * 8..i * 8 + 8];
        for (j, out) in dst.iter_mut().enumerate() {
            *out = ((val >> (j * 7)) & 0x7f) as u8;
        }
    }

    if remainder > 0 {
        let src = &input[full_blocks * 7..];
        let remaining_bytes = packed_size(remainder);
        let mut bytes = [0u8; 8];
        bytes[..remaining_bytes].copy_from_slice(&src[..remaining_bytes]);
        let val = u64::from_le_bytes(bytes);
        let dst = &mut output[full_blocks * 8..full_blocks * 8 + remainder];
        for (j, out) in dst.iter_mut().enumerate() {
            *out = ((val >> (j * 7)) & 0x7f) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packed_size_formula() {
        assert_eq!(packed_size(0), 0);
        assert_eq!(packed_size(1), 1);
        assert_eq!(packed_size(7), 7);
        assert_eq!(packed_size(8), 7);
        assert_eq!(packed_size(9), 8);
        assert_eq!(packed_size(16), 14);
    }

    #[test]
    fn roundtrip_empty() {
        let packed = pack7(b"").unwrap();
        assert!(packed.is_empty());
        let unpacked = unpack7(&packed, 0);
        assert!(unpacked.is_empty());
    }

    #[test]
    fn roundtrip_single_byte() {
        let input = b"A";
        let packed = pack7(input).unwrap();
        assert_eq!(packed.len(), 1);
        let unpacked = unpack7(&packed, input.len());
        assert_eq!(&unpacked, input);
    }

    #[test]
    fn roundtrip_7_bytes() {
        let input = b"abcdefg";
        let packed = pack7(input).unwrap();
        assert_eq!(packed.len(), packed_size(7));
        let unpacked = unpack7(&packed, input.len());
        assert_eq!(&unpacked, input);
    }

    #[test]
    fn roundtrip_8_bytes() {
        let input = b"abcdefgh";
        let packed = pack7(input).unwrap();
        assert_eq!(packed.len(), 7);
        let unpacked = unpack7(&packed, input.len());
        assert_eq!(&unpacked, input);
    }

    #[test]
    fn roundtrip_9_bytes() {
        let input = b"abcdefghi";
        let packed = pack7(input).unwrap();
        assert_eq!(packed.len(), packed_size(9));
        let unpacked = unpack7(&packed, input.len());
        assert_eq!(&unpacked, input);
    }

    #[test]
    fn roundtrip_all_printable_ascii() {
        let input: Vec<u8> = (0x20..=0x7e).collect();
        let packed = pack7(&input).unwrap();
        assert_eq!(packed.len(), packed_size(input.len()));
        let unpacked = unpack7(&packed, input.len());
        assert_eq!(unpacked, input);
    }

    #[test]
    fn roundtrip_control_chars() {
        let input: Vec<u8> = (0x00..=0x1f).collect();
        let packed = pack7(&input).unwrap();
        let unpacked = unpack7(&packed, input.len());
        assert_eq!(unpacked, input);
    }

    #[test]
    fn roundtrip_max_valid_byte() {
        let input = vec![0x7f; 100];
        let packed = pack7(&input).unwrap();
        let unpacked = unpack7(&packed, input.len());
        assert_eq!(unpacked, input);
    }

    #[test]
    fn non_ascii_rejected() {
        let input = vec![0x80];
        let err = pack7(&input).unwrap_err();
        match err {
            Pack7Error::NonAscii { position, value } => {
                assert_eq!(position, 0);
                assert_eq!(value, 0x80);
            }
        }
    }

    #[test]
    fn non_ascii_in_middle() {
        let mut input = b"hello".to_vec();
        input[3] = 0xff;
        let err = pack7(&input).unwrap_err();
        match err {
            Pack7Error::NonAscii { position, value } => {
                assert_eq!(position, 3);
                assert_eq!(value, 0xff);
            }
        }
    }

    #[test]
    fn roundtrip_large() {
        let input: Vec<u8> = (0..10000).map(|i| (i % 95 + 0x20) as u8).collect();
        let packed = pack7(&input).unwrap();
        assert_eq!(packed.len(), packed_size(input.len()));
        let unpacked = unpack7(&packed, input.len());
        assert_eq!(unpacked, input);
    }

    #[test]
    fn output_length_formula() {
        for n in 0..=100 {
            let input: Vec<u8> = vec![0x41; n];
            let packed = pack7(&input).unwrap();
            let expected = (n * 7).div_ceil(8);
            assert_eq!(
                packed.len(),
                expected,
                "pack7 output length wrong for n={n}"
            );
        }
    }
}
