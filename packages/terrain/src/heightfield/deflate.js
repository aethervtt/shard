// Raw DEFLATE (RFC 1951) for terrain packs (spec 0071). Plain JavaScript with no imports, so pool
// workers load it directly (no bundler, no TypeScript loader); types are in deflate.d.ts. Written
// here so a bake writes the same pack bytes on every host: Node's zlib and Chrome's
// CompressionStream are free to emit different streams for the same input, and pages are compared
// byte for byte. One block per call: LZ77 over a 32 KB window with hash chains of fixed length and
// one step of lazy matching, then dynamic Huffman codes limited to 15 bits. Every choice is fixed,
// so the output depends on the input alone.

const WINDOW = 32768
const MIN_MATCH = 3
const MAX_MATCH = 258
const HASH_BITS = 15
const HASH_SIZE = 1 << HASH_BITS
/** Candidates tried per position: deterministic, and enough for terrain pages. */
const CHAIN = 48
/** A match this long is taken without looking for a better one at the next byte. */
const GOOD = 32

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]
/** Order code length code lengths are sent in. */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

/** Length code (257–285) for a match length. */
const lengthCode = new Uint16Array(MAX_MATCH + 1)
for (let c = 0; c < LENGTH_BASE.length; c++) {
  const end = c + 1 < LENGTH_BASE.length ? LENGTH_BASE[c + 1] : MAX_MATCH + 1
  for (let l = LENGTH_BASE[c]; l < end; l++) lengthCode[l] = c
}
lengthCode[MAX_MATCH] = 28

/** Distance code (0–29) per distance (1–32768). */
const distCodes = new Uint8Array(WINDOW + 1)
for (let c = 0; c < DIST_BASE.length; c++) {
  const end = c + 1 < DIST_BASE.length ? DIST_BASE[c + 1] : WINDOW + 1
  for (let d = DIST_BASE[c]; d < end; d++) distCodes[d] = c
}

function distCode(d) {
  return distCodes[d]
}

/** Huffman codes go out most significant bit first: reversed into the LSB-first stream. */
function reverse(code, length) {
  let rev = 0
  for (let i = 0; i < length; i++) rev |= ((code >>> i) & 1) << (length - 1 - i)
  return rev
}

class BitWriter {
  buf = new Uint8Array(1024)
  len = 0
  acc = 0
  bits = 0

  write(value, count) {
    this.acc |= value << this.bits
    this.bits += count
    while (this.bits >= 8) {
      this.byte(this.acc & 0xff)
      this.acc >>>= 8
      this.bits -= 8
    }
  }

  byte(b) {
    if (this.len === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    this.buf[this.len++] = b
  }

  finish() {
    if (this.bits > 0) this.byte(this.acc & 0xff)
    this.acc = 0
    this.bits = 0
    return this.buf.slice(0, this.len)
  }
}

/**
 * Code lengths for `freqs`, at most `limit` bits: Huffman's by a sort with ties broken by symbol,
 * then lengths over the limit moved up the tree, so the result is the same everywhere.
 */
export function codeLengths(freqs, limit) {
  const n = freqs.length
  const lengths = new Uint8Array(n)
  const symbols = []
  for (let s = 0; s < n; s++) if (freqs[s] > 0) symbols.push(s)
  if (symbols.length === 0) return lengths
  if (symbols.length === 1) {
    lengths[symbols[0]] = 1
    return lengths
  }
  // Nodes: leaves first (weight, symbol order), then internal ones made in order.
  const weight = []
  const parent = []
  const order = symbols.slice().sort((a, b) => freqs[a] - freqs[b] || a - b)
  for (const s of order) {
    weight.push(freqs[s])
    parent.push(-1)
  }
  // Two queues: leaves sorted, internal nodes made in nondecreasing weight.
  let leaf = 0
  let inner = order.length
  const pick = () => {
    if (leaf < order.length && (inner >= weight.length || weight[leaf] <= weight[inner]))
      return leaf++
    return inner++
  }
  // Until one node is left: join the two lightest.
  while (order.length - leaf + (weight.length - inner) >= 2) {
    const a = pick()
    const b = pick()
    weight.push(weight[a] + weight[b])
    parent.push(-1)
    parent[a] = weight.length - 1
    parent[b] = weight.length - 1
  }
  const depth = new Array(weight.length).fill(0)
  for (let i = weight.length - 2; i >= 0; i--) depth[i] = depth[parent[i]] + 1
  let deepest = 0
  for (let i = 0; i < order.length; i++) deepest = Math.max(deepest, depth[i])
  const count = new Array(Math.max(limit, deepest) + 1).fill(0)
  for (let i = 0; i < order.length; i++) count[depth[i]]++
  // Lengths over the limit move up the tree two leaves at a time (JPEG's Annex K.3): a pair at
  // depth i becomes one leaf at i − 1, and a leaf at a shallower j splits to make room. The Kraft
  // sum stays 1.
  for (let i = count.length - 1; i > limit; i--) {
    while (count[i] > 0) {
      let j = i - 2
      while (count[j] === 0) j--
      count[i] -= 2
      count[i - 1] += 1
      count[j + 1] += 2
      count[j] -= 1
    }
  }
  // Longest codes to the least frequent symbols (the sorted order), as Huffman would.
  let i = 0
  for (let l = limit; l >= 1; l--) {
    for (let k = 0; k < count[l]; k++) lengths[order[i++]] = l
  }
  return lengths
}

/** Canonical codes for code lengths (RFC 1951 3.2.2), bit-reversed for the stream. */
function canonical(lengths) {
  const maxLen = 16
  const blCount = new Uint16Array(maxLen)
  for (const l of lengths) if (l > 0) blCount[l]++
  const next = new Uint16Array(maxLen)
  let code = 0
  for (let bits = 1; bits < maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1
    next[bits] = code
  }
  const codes = new Uint16Array(lengths.length)
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s]
    if (l > 0) codes[s] = reverse(next[l]++, l)
  }
  return codes
}

/** LZ77 tokens: a literal is `byte`, a match is `(256 + length) | distance << 16`. */
function tokenize(input) {
  const n = input.length
  const out = new Uint32Array(n + 1)
  let count = 0
  const head = new Int32Array(HASH_SIZE).fill(-1)
  const prev = new Int32Array(WINDOW).fill(-1)
  const hash = (i) =>
    (((input[i] << 10) ^ (input[i + 1] << 5) ^ input[i + 2]) * 2654435761) >>> (32 - HASH_BITS)
  const insert = (i) => {
    if (i + MIN_MATCH > n) return
    const h = hash(i)
    prev[i & (WINDOW - 1)] = head[h]
    head[h] = i
  }
  /** Longest match at `i` among earlier positions: [length, distance]. */
  let bestLen = 0
  let bestDist = 0
  const find = (i) => {
    bestLen = 0
    bestDist = 0
    if (i + MIN_MATCH > n) return
    let candidate = head[hash(i)]
    const limit = Math.min(MAX_MATCH, n - i)
    for (let chain = 0; chain < CHAIN && candidate >= 0 && i - candidate <= WINDOW; chain++) {
      if (input[candidate + bestLen] === input[i + bestLen]) {
        let l = 0
        while (l < limit && input[candidate + l] === input[i + l]) l++
        if (l > bestLen) {
          bestLen = l
          bestDist = i - candidate
          if (l === limit) break
        }
      }
      const p = prev[candidate & (WINDOW - 1)]
      if (p >= candidate) break
      candidate = p
    }
    if (bestLen < MIN_MATCH) bestLen = 0
  }
  let i = 0
  while (i < n) {
    find(i)
    let len = bestLen
    let dist = bestDist
    if (len > 0 && len < GOOD && i + 1 < n) {
      // Lazy: if the next byte starts a longer match, this one goes out as a literal.
      insert(i)
      find(i + 1)
      if (bestLen > len) {
        out[count++] = input[i]
        i++
        len = bestLen
        dist = bestDist
        for (let k = 0; k < len; k++) insert(i + k)
      } else for (let k = 1; k < len; k++) insert(i + k)
      out[count++] = (256 + len) | (dist << 16)
      i += len
    } else if (len > 0) {
      for (let k = 0; k < len; k++) insert(i + k)
      out[count++] = (256 + len) | (dist << 16)
      i += len
    } else {
      insert(i)
      out[count++] = input[i]
      i++
    }
  }
  return out.subarray(0, count)
}

/** Compresses `input` to a raw DEFLATE stream (one final block). Same bytes on every host. */
export function deflate(input) {
  const tokens = tokenize(input)
  const litFreq = new Uint32Array(286)
  const distFreq = new Uint32Array(30)
  for (const t of tokens) {
    if (t < 256) litFreq[t]++
    else {
      const len = (t & 0xffff) - 256
      litFreq[257 + lengthCode[len]]++
      distFreq[distCode(t >>> 16)]++
    }
  }
  litFreq[256] = 1
  // At least one distance code (inflaters want a distance tree even with no matches).
  if (distFreq.every((f) => f === 0)) distFreq[0] = 1
  const litLen = codeLengths(litFreq, 15)
  const distLen = codeLengths(distFreq, 15)
  let hlit = 286
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--
  let hdist = 30
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--
  // Run-length code the two length tables together.
  const all = new Uint8Array(hlit + hdist)
  all.set(litLen.subarray(0, hlit))
  all.set(distLen.subarray(0, hdist), hlit)
  const cl = []
  const clExtra = []
  for (let i = 0; i < all.length; ) {
    const v = all[i]
    let run = 1
    while (i + run < all.length && all[i + run] === v) run++
    if (v === 0 && run >= 3) {
      const r = Math.min(run, 138)
      if (r >= 11) {
        cl.push(18)
        clExtra.push(r - 11)
      } else {
        cl.push(17)
        clExtra.push(r - 3)
      }
      i += r
    } else if (v !== 0 && run >= 4) {
      cl.push(v)
      clExtra.push(0)
      const r = Math.min(run - 1, 6)
      cl.push(16)
      clExtra.push(r - 3)
      i += 1 + r
    } else {
      cl.push(v)
      clExtra.push(0)
      i++
    }
  }
  const clFreq = new Uint32Array(19)
  for (const c of cl) clFreq[c]++
  const clLen = codeLengths(clFreq, 7)
  const clCodes = canonical(clLen)
  let hclen = 19
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--
  const litCodes = canonical(litLen)
  const distCodes = canonical(distLen)
  const w = new BitWriter()
  w.write(1, 1) // final block
  w.write(2, 2) // dynamic Huffman
  w.write(hlit - 257, 5)
  w.write(hdist - 1, 5)
  w.write(hclen - 4, 4)
  for (let i = 0; i < hclen; i++) w.write(clLen[CL_ORDER[i]], 3)
  for (let i = 0; i < cl.length; i++) {
    const c = cl[i]
    w.write(clCodes[c], clLen[c])
    if (c === 16) w.write(clExtra[i], 2)
    else if (c === 17) w.write(clExtra[i], 3)
    else if (c === 18) w.write(clExtra[i], 7)
  }
  for (const t of tokens) {
    if (t < 256) {
      w.write(litCodes[t], litLen[t])
      continue
    }
    const len = (t & 0xffff) - 256
    const lc = lengthCode[len]
    w.write(litCodes[257 + lc], litLen[257 + lc])
    if (LENGTH_EXTRA[lc] > 0) w.write(len - LENGTH_BASE[lc], LENGTH_EXTRA[lc])
    const dist = t >>> 16
    const dc = distCode(dist)
    w.write(distCodes[dc], distLen[dc])
    if (DIST_EXTRA[dc] > 0) w.write(dist - DIST_BASE[dc], DIST_EXTRA[dc])
  }
  w.write(litCodes[256], litLen[256])
  return w.finish()
}

// --- inflate -----------------------------------------------------------------------------------

/** A Huffman decoding table: counts per length and symbols in canonical order. */
function decoder(lengths, n) {
  const counts = new Uint16Array(16)
  for (let i = 0; i < n; i++) counts[lengths[i]]++
  counts[0] = 0
  const offs = new Uint16Array(16)
  for (let l = 1; l < 16; l++) offs[l] = offs[l - 1] + counts[l - 1]
  const symbols = new Uint16Array(n)
  for (let i = 0; i < n; i++) if (lengths[i] > 0) symbols[offs[lengths[i]]++] = i
  return { counts, symbols }
}

const fixedLit = (() => {
  const l = new Uint8Array(288)
  l.fill(8, 0, 144)
  l.fill(9, 144, 256)
  l.fill(7, 256, 280)
  l.fill(8, 280, 288)
  return decoder(l, 288)
})()
const fixedDist = decoder(new Uint8Array(30).fill(5), 30)

function corrupt(why) {
  return Object.assign(new Error(`A terrain page doesn't inflate: ${why}`), {
    code: 'terrain/corrupt-pack',
    hint: 'The pack is damaged or from another bake: `shard terrain bake --force` rewrites it.',
  })
}

/**
 * Decompresses a raw DEFLATE stream into exactly `size` bytes (a page's known length). Any
 * conforming stream works; terrain packs hold `deflate`'s.
 */
export function inflate(input, size) {
  const out = new Uint8Array(size)
  let o = 0
  let pos = 0
  let acc = 0
  let bits = 0
  const need = (n) => {
    while (bits < n) {
      if (pos >= input.length) throw corrupt('it ends early')
      acc |= input[pos++] << bits
      bits += 8
    }
  }
  const take = (n) => {
    if (n === 0) return 0
    need(n)
    const v = acc & ((1 << n) - 1)
    acc >>>= n
    bits -= n
    return v
  }
  const decode = (d) => {
    let code = 0
    let first = 0
    let index = 0
    for (let len = 1; len < 16; len++) {
      code |= take(1)
      const count = d.counts[len]
      if (code - count < first) return d.symbols[index + (code - first)]
      index += count
      first += count
      first <<= 1
      code <<= 1
    }
    throw corrupt('a code is invalid')
  }
  let final = 0
  while (!final) {
    final = take(1)
    const type = take(2)
    if (type === 0) {
      acc = 0
      bits = 0
      if (pos + 4 > input.length) throw corrupt('it ends early')
      const len = input[pos] | (input[pos + 1] << 8)
      pos += 4
      if (o + len > size || pos + len > input.length) throw corrupt('a stored block overruns')
      out.set(input.subarray(pos, pos + len), o)
      o += len
      pos += len
      continue
    }
    let lit = fixedLit
    let dist = fixedDist
    if (type === 2) {
      const hlit = take(5) + 257
      const hdist = take(5) + 1
      const hclen = take(4) + 4
      const clLen = new Uint8Array(19)
      for (let i = 0; i < hclen; i++) clLen[CL_ORDER[i]] = take(3)
      const cl = decoder(clLen, 19)
      const lengths = new Uint8Array(hlit + hdist)
      for (let i = 0; i < hlit + hdist; ) {
        const sym = decode(cl)
        if (sym < 16) lengths[i++] = sym
        else {
          let rep = 0
          let v = 0
          if (sym === 16) {
            if (i === 0) throw corrupt('a repeat has nothing before it')
            v = lengths[i - 1]
            rep = 3 + take(2)
          } else if (sym === 17) rep = 3 + take(3)
          else rep = 11 + take(7)
          if (i + rep > lengths.length) throw corrupt('code lengths overrun')
          lengths.fill(v, i, i + rep)
          i += rep
        }
      }
      lit = decoder(lengths.subarray(0, hlit), hlit)
      dist = decoder(lengths.subarray(hlit), hdist)
    } else if (type !== 1) throw corrupt('a block has an unknown type')
    for (;;) {
      const sym = decode(lit)
      if (sym < 256) {
        if (o >= size) throw corrupt('it is longer than the page')
        out[o++] = sym
      } else if (sym === 256) break
      else {
        const lc = sym - 257
        if (lc >= 29) throw corrupt('a length code is invalid')
        const len = LENGTH_BASE[lc] + take(LENGTH_EXTRA[lc])
        const dc = decode(dist)
        if (dc >= 30) throw corrupt('a distance code is invalid')
        const d = DIST_BASE[dc] + take(DIST_EXTRA[dc])
        if (d > o || o + len > size) throw corrupt('a match reaches outside the page')
        for (let k = 0; k < len; k++) out[o + k] = out[o + k - d]
        o += len
      }
    }
  }
  if (o !== size) throw corrupt(`it holds ${o} bytes, not ${size}`)
  return out
}
