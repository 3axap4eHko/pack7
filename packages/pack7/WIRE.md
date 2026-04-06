# pack7 wire format

pack7 encodes 7-bit ASCII data into a dense byte stream by eliminating the unused MSB of each input byte. Output is 87.5% the size of input. The packing scheme is identical to GSM 7-bit packing (3GPP TS 23.038) but carries no GSM charset mapping or PDU framing.

## Constraints

- Valid input bytes: 0x00-0x7F. Byte values >= 0x80 must be rejected.
- Output bytes span the full 0x00-0xFF range. Output is binary, not text-safe.
- Byte order: little-endian only.

## Core operation (8 -> 7)

OR-shift 8 input bytes at 7-bit intervals into a 56-bit value, write 7 little-endian bytes:

```
value = src[0]
      | (src[1] << 7)
      | (src[2] << 14)
      | (src[3] << 21)
      | (src[4] << 28)
      | (src[5] << 35)
      | (src[6] << 42)
      | (src[7] << 49)

output = value[0..7] as little-endian bytes
```

Example -- `"Hello Wo"` = `[48 65 6c 6c 6f 20 57 6f]`:

```
value = 0x48 | (0x65 << 7) | (0x6c << 14) | (0x6c << 21)
      | (0x6f << 28) | (0x20 << 35) | (0x57 << 42) | (0x6f << 49)

packed = [c8 32 9b fd 06 5d df]
```

Decode: read 7 bytes into a 56-bit value, extract 8 values via `(value >> (i * 7)) & 0x7F`.

## Remainder

When input length is not a multiple of 8, the final 1-7 bytes are packed identically -- OR-shift at 7-bit intervals, write the low bytes. Output length:

```
output_length = ceil(input_length * 7 / 8)
```

## Framing

pack7 does not encode the original length. The decoder requires `original_length` to know how many values to extract from the final block. Transmit it out-of-band. Suggested framing:

```
[4 bytes: original_length as u32 LE] [packed_data]
```

This is a suggestion, not a requirement. Any framing that conveys the original length is valid.

## Test vectors

| Input | Input (hex) | Packed (hex) |
|---|---|---|
| (empty) | | |
| "A" | 41 | 41 |
| "AB" | 41 42 | 41 21 |
| "ABCDEFGH" | 41 42 43 44 45 46 47 48 | 41 e1 90 58 34 1e 91 |
| "ABCDEFGHx" | 41 42 43 44 45 46 47 48 78 | 41 e1 90 58 34 1e 91 78 |
| "Hello Wo" | 48 65 6c 6c 6f 20 57 6f | c8 32 9b fd 06 5d df |
| 8 x 0x7F | 7f 7f 7f 7f 7f 7f 7f 7f | ff ff ff ff ff ff ff |
| 8 x 0x00 | 00 00 00 00 00 00 00 00 | 00 00 00 00 00 00 00 |

## Reference

3GPP TS 23.038 defines the original GSM 7-bit packing. pack7 is wire-compatible with the packing algorithm but does not implement the GSM default alphabet mapping.
