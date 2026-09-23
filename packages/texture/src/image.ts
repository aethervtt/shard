/** A decoded image: RGBA8 (`u8`) or RGBA float (`f32`, linear, for HDR). Top row first. */
export interface Image {
  width: number
  height: number
  kind: 'u8' | 'f32'
  data: Uint8Array | Float32Array
}
