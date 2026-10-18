/** Draw a cached envelope. No decoding, timers or canvas ownership is hidden in the renderer. */
export function drawAudioWaveform(
  context: CanvasRenderingContext2D,
  peaks: Float32Array,
  width: number,
  height: number,
  color: string,
): void {
  context.clearRect(0, 0, width, height)
  context.fillStyle = color
  const scale = width / peaks.length
  for (let i = 0; i < peaks.length; i++) {
    const amplitude = Math.min(1, Math.abs(peaks[i]!)) * height * 0.94
    context.fillRect(i * scale, (height - amplitude) / 2, Math.max(1, scale), amplitude)
  }
}
