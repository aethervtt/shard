export type CharsetName = 'latin' | 'latin-extended'

/** Typographic punctuation every Latin text needs: dashes, curly quotes, bullet, ellipsis, €, ™. */
const PUNCTUATION = [
  0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026,
  0x2030, 0x2039, 0x203a, 0x20ac, 0x2122,
]

function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let c = from; c <= to; c++) out.push(c)
  return out
}

/**
 * Codepoints of a charset, sorted and unique:
 * - `latin`: printable ASCII, Latin-1 Supplement, and common typographic punctuation.
 * - `latin-extended`: `latin` plus Latin Extended-A.
 * - any other string: exactly its characters (plus the space).
 */
export function charsetCodepoints(charset: CharsetName | (string & {})): number[] {
  const set = new Set<number>()
  if (charset === 'latin' || charset === 'latin-extended') {
    for (const c of range(0x20, 0x7e)) set.add(c)
    for (const c of range(0xa0, 0xff)) set.add(c)
    for (const c of PUNCTUATION) set.add(c)
    if (charset === 'latin-extended') for (const c of range(0x100, 0x17f)) set.add(c)
  } else {
    set.add(0x20)
    for (const ch of charset) {
      const cp = ch.codePointAt(0)!
      if (cp >= 0x20 && cp !== 0x7f) set.add(cp)
    }
  }
  return [...set].sort((a, b) => a - b)
}
