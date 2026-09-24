/** A 16-bit PCM WAV of a sine, for tests and generated sounds. */
export function sineWav(
  seconds: number,
  options: { rate?: number; channels?: number; frequency?: number; amplitude?: number } = {},
): Uint8Array {
  const rate = options.rate ?? 44100
  const channels = options.channels ?? 1
  const frequency = options.frequency ?? 440
  const amplitude = options.amplitude ?? 0.5
  const frames = Math.round(rate * seconds)
  const out = new Uint8Array(44 + frames * channels * 2)
  const view = new DataView(out.buffer)
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + frames * channels * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, frames * channels * 2, true)
  for (let i = 0; i < frames; i++) {
    const v = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * frequency * i) / rate))
    for (let c = 0; c < channels; c++) view.setInt16(44 + (i * channels + c) * 2, v, true)
  }
  return out
}
