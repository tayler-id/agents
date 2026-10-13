// Encodes a screen as PNG, the format Claude reads screenshots in. Node has no
// image encoder, and PNG is a filtered, deflated list of rows, so this is the
// few dozen lines it takes. Rows use whichever of PNG's five filters leaves the
// smallest bytes, as libpng picks them.

import { crc32, deflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const RGB = 3
const FILTERS = 5
// Screenshots go to the model on every action, so speed beats the last few
// percent of size: level 6 is zlib's own balance of the two.
const DEFLATE_LEVEL = 6

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(data, crc32(head.subarray(4))), 0)
  return Buffer.concat([head, data, crc])
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

// Writes each filter's version of the row into `out` and returns the one with
// the smallest sum of bytes read as signed values.
function filterRow(row: DataView, above: DataView | null, out: Uint8Array): Uint8Array {
  const size = row.byteLength
  let best = out.subarray(0, size + 1)
  let bestCost = Infinity
  for (let type = 0; type < FILTERS; type++) {
    const filtered = out.subarray(type * (size + 1), (type + 1) * (size + 1))
    filtered[0] = type
    let cost = 0
    for (let i = 0; i < size; i++) {
      const a = i >= RGB ? row.getUint8(i - RGB) : 0
      const b = above ? above.getUint8(i) : 0
      const c = above && i >= RGB ? above.getUint8(i - RGB) : 0
      const predicted = type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : type === 4 ? paeth(a, b, c) : 0
      const value = (row.getUint8(i) - predicted) & 0xff
      filtered[i + 1] = value
      cost += value < 128 ? value : 256 - value
    }
    if (cost < bestCost) {
      bestCost = cost
      best = filtered
    }
  }
  return best
}

// A frame in the box's pixel format: four bytes per pixel, blue, green, red, then
// one unused.
export function encodePng(width: number, height: number, bgrx: Uint8Array): Buffer {
  if (bgrx.length !== width * height * 4) throw new Error(`a ${width}x${height} frame needs ${width * height * 4} bytes, not ${bgrx.length}`)
  const frame = viewOf(bgrx)
  const stride = width * RGB
  const rows = Buffer.alloc(height * (stride + 1))
  const scratch = new Uint8Array(FILTERS * (stride + 1))
  let above: DataView | null = null
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(stride)
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4
      row[x * RGB] = frame.getUint8(from + 2)
      row[x * RGB + 1] = frame.getUint8(from + 1)
      row[x * RGB + 2] = frame.getUint8(from)
    }
    const rowView = viewOf(row)
    rows.set(filterRow(rowView, above, scratch), y * (stride + 1))
    above = rowView
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: DEFLATE_LEVEL })), chunk('IEND', Buffer.alloc(0))])
}
