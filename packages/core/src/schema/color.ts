export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
}

export const HEX_COLOR = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** Parses `#rrggbb` or `#rrggbbaa` (sRGB) into linear RGBA. */
export function hexToLinear(hex: string): [number, number, number, number] {
  const byte = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16) / 255
  const a = hex.length === 9 ? byte(7) : 1
  return [srgbToLinear(byte(1)), srgbToLinear(byte(3)), srgbToLinear(byte(5)), a]
}

/** Formats linear RGBA as sRGB hex, or returns undefined if hex can't represent it exactly. */
export function linearToHex(color: readonly number[]): string | undefined {
  const channels: number[] = []
  for (let i = 0; i < 4; i++) {
    const c = color[i]!
    if (c < 0 || c > 1) return undefined
    channels.push(Math.round((i === 3 ? c : linearToSrgb(c)) * 255))
  }
  const alpha = channels[3] === 255 ? '' : channels[3]!.toString(16).padStart(2, '0')
  const hex = `#${channels
    .slice(0, 3)
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')}${alpha}`
  const back = hexToLinear(hex)
  for (let i = 0; i < 4; i++) {
    if (Math.fround(back[i]!) !== Math.fround(color[i]!)) return undefined
  }
  return hex
}
