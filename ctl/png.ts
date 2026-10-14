// Reads and writes the PNG files screenshots come in, and compares two of them
// pixel by pixel. Screenshots from Chromium, Firefox and WebKit are 8-bit RGB or
// RGBA without interlacing, which is all this reads. Anything else fails with a
// message naming what the file is. The loops index inside the arrays' bounds, so
// each `?? 0` on a byte only satisfies noUncheckedIndexedAccess.

import { crc32, deflateSync, inflateSync } from 'node:zlib'

export type Image = { width: number; height: number; rgba: Uint8Array }

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// Channels per pixel for each colour type: grey, RGB, grey with alpha, RGBA.
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export function decode(file: Buffer, name = 'the image'): Image {
  if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error(`${name} is not a PNG`)
  let offset = 8
  let header: { width: number; height: number; depth: number; colour: number; interlace: number } | null = null
  const data: Buffer[] = []
  while (offset < file.length) {
    const length = file.readUInt32BE(offset)
    const type = file.toString('latin1', offset + 4, offset + 8)
    const body = file.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body.readUInt8(8), colour: body.readUInt8(9), interlace: body.readUInt8(12) }
    } else if (type === 'IDAT') {
      data.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (!header) throw new Error(`${name} has no IHDR chunk`)
  const channels = CHANNELS[header.colour]
  if (header.depth !== 8 || header.interlace !== 0 || channels === undefined) {
    throw new Error(`${name} is a ${String(header.depth)}-bit PNG of colour type ${String(header.colour)}${header.interlace ? ', interlaced' : ''}, which this does not read`)
  }
  const { width, height } = header
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const row = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const value = raw[row + x] ?? 0
      const left = x >= channels ? pixels[y * stride + x - channels] ?? 0 : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] ?? 0 : 0
      const corner = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] ?? 0 : 0
      const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, corner) : -1
      if (predicted < 0) throw new Error(`${name} has an unknown filter ${String(filter)} on row ${String(y)}`)
      pixels[y * stride + x] = (value + predicted) & 0xff
    }
  }
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const at = (k: number) => pixels[i * channels + k] ?? 0
    const [r, g, b, a] = channels === 4 ? [at(0), at(1), at(2), at(3)] : channels === 3 ? [at(0), at(1), at(2), 255]
      : channels === 2 ? [at(0), at(0), at(0), at(1)] : [at(0), at(0), at(0), 255]
    rgba.set([r, g, b, a], i * 4)
  }
  return { width, height, rgba }
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  const named = Buffer.concat([Buffer.from(type, 'latin1'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(named))
  return Buffer.concat([length, named, crc])
}

export function encode(image: Image): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const stride = image.width * 4
  const raw = Buffer.alloc((stride + 1) * image.height)
  for (let y = 0; y < image.height; y++) raw.set(image.rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

export type Box = { x: number; y: number; width: number; height: number; pixels: number }

// Regions are found on a grid of cells this many pixels wide, so pixels that
// differ near each other report as one region.
const CELL = 16

// Compares two images of the same size. A pixel differs when any channel moves
// by more than `threshold`. Returns the count, the regions where they lie, and
// an image of the run with the differing pixels in red over a faded copy.
export function diff(baseline: Image, actual: Image, threshold: number): { differing: number; regions: Box[]; picture: Image } {
  if (baseline.width !== actual.width || baseline.height !== actual.height) throw new Error('the images are different sizes')
  const { width, height } = actual
  const picture = new Uint8Array(actual.rgba.length)
  const cols = Math.ceil(width / CELL)
  const cells = new Map<number, Box>()
  let differing = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      let delta = 0
      for (let k = 0; k < 4; k++) delta = Math.max(delta, Math.abs((baseline.rgba[i + k] ?? 0) - (actual.rgba[i + k] ?? 0)))
      if (delta > threshold) {
        differing++
        picture.set([255, 0, 0, 255], i)
        const key = Math.floor(y / CELL) * cols + Math.floor(x / CELL)
        const box = cells.get(key)
        if (box) {
          const right = Math.max(box.x + box.width, x + 1)
          const bottom = Math.max(box.y + box.height, y + 1)
          box.x = Math.min(box.x, x)
          box.y = Math.min(box.y, y)
          box.width = right - box.x
          box.height = bottom - box.y
          box.pixels++
        } else {
          cells.set(key, { x, y, width: 1, height: 1, pixels: 1 })
        }
      } else {
        // Faded, so the red stands out.
        const grey = Math.round(((actual.rgba[i] ?? 0) + (actual.rgba[i + 1] ?? 0) + (actual.rgba[i + 2] ?? 0)) / 3)
        const faded = 255 - Math.round((255 - grey) * 0.3)
        picture.set([faded, faded, faded, 255], i)
      }
    }
  }
  // Joins neighbouring cells into regions.
  const regions: Box[] = []
  const seen = new Set<number>()
  for (const start of cells.keys()) {
    if (seen.has(start)) continue
    const stack = [start]
    seen.add(start)
    let region: Box | null = null
    for (let key = stack.pop(); key !== undefined; key = stack.pop()) {
      const box = cells.get(key)
      if (!box) continue
      region = region === null ? { ...box } : {
        x: Math.min(region.x, box.x), y: Math.min(region.y, box.y),
        width: Math.max(region.x + region.width, box.x + box.width) - Math.min(region.x, box.x),
        height: Math.max(region.y + region.height, box.y + box.height) - Math.min(region.y, box.y),
        pixels: region.pixels + box.pixels,
      }
      const [cx, cy] = [key % cols, Math.floor(key / cols)]
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const next = (cy + dy) * cols + (cx + dx)
        if (cx + dx >= 0 && cx + dx < cols && cells.has(next) && !seen.has(next)) {
          seen.add(next)
          stack.push(next)
        }
      }
    }
    if (region) regions.push(region)
  }
  regions.sort((a, b) => b.pixels - a.pixels)
  return { differing, regions, picture: { width, height, rgba: picture } }
}
