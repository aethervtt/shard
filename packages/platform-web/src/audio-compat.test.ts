import { describe, expect, it, vi } from 'vitest'
import { holdAudioParam, setListenerPose } from './audio-compat'

describe('Web Audio compatibility', () => {
  it('uses legacy listener pose methods without changing coordinates or orientation', () => {
    const setPosition = vi.fn(),
      setOrientation = vi.fn()
    setListenerPose(
      { setPosition, setOrientation } as unknown as AudioListener,
      new Float64Array([1, 0, 0, 4, 0, 1, 0, 5, 0, 0, 1, 6]),
    )
    expect(setPosition).toHaveBeenCalledWith(4, 5, 6)
    expect(setOrientation).toHaveBeenCalledWith(-0, -0, -1, 0, 1, 0)
  })

  it('keeps native hold automation and holds the tracked future value in legacy hosts', () => {
    const cancelAndHoldAtTime = vi.fn()
    holdAudioParam({ cancelAndHoldAtTime, value: 0.7 } as unknown as AudioParam, 4, 0.25)
    expect(cancelAndHoldAtTime).toHaveBeenCalledWith(4)
    const cancelScheduledValues = vi.fn(),
      setValueAtTime = vi.fn()
    const param = { value: 0.7, cancelScheduledValues, setValueAtTime } as unknown as AudioParam
    holdAudioParam(param, 4, 0.25)
    expect(cancelScheduledValues).toHaveBeenCalledWith(4)
    expect(setValueAtTime).toHaveBeenLastCalledWith(0.25, 4)
    holdAudioParam(param, 5)
    expect(setValueAtTime).toHaveBeenLastCalledWith(0.7, 5)
  })
})
