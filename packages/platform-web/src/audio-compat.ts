/** Firefox exposes legacy listener methods instead of AudioParam listener coordinates. */
export function setListenerPose(listener: AudioListener, matrix: ArrayLike<number>): void {
  if (listener.positionX) {
    listener.positionX.value = matrix[3]!
    listener.positionY.value = matrix[7]!
    listener.positionZ.value = matrix[11]!
    listener.forwardX.value = -matrix[2]!
    listener.forwardY.value = -matrix[6]!
    listener.forwardZ.value = -matrix[10]!
    listener.upX.value = matrix[1]!
    listener.upY.value = matrix[5]!
    listener.upZ.value = matrix[9]!
  } else {
    listener.setPosition(matrix[3]!, matrix[7]!, matrix[11]!)
    listener.setOrientation(
      -matrix[2]!,
      -matrix[6]!,
      -matrix[10]!,
      matrix[1]!,
      matrix[5]!,
      matrix[9]!,
    )
  }
}

/** At current time .value is the rendered value; future automation supplies its tracked value. */
export function holdAudioParam(param: AudioParam, at: number, value = param.value): void {
  if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(at)
  else {
    param.cancelScheduledValues(at)
    param.setValueAtTime(value, at)
  }
}
