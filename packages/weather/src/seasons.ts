import type { TimeOfDayValue } from '@aethervtt/shard-sky'

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const
export type Season = (typeof SEASONS)[number]

/** Days a season blends into the next over. */
const BLEND_DAYS = 15

/** Day of the year (0-based) of a clock's current date. */
export function dayOfYear(clock: Pick<TimeOfDayValue, 'startDate' | 'day'>, extraDays = 0): number {
  const { year, month, day } = clock.startDate
  const start = Date.UTC(year, month - 1, day)
  const now = new Date(start + (clock.day + extraDays) * 86400000)
  return (now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86400000
}

/**
 * Season weights (spring, summer, autumn, winter; they sum to 1) on a day of the year, with each
 * season blending into the next over BLEND_DAYS around the equinoxes and solstices. The southern
 * hemisphere is half a year off.
 */
export function seasonWeights(doy: number, latitude: number, out: Float32Array): Float32Array {
  // Spring starts at the March equinox (day 79); one season is a quarter year.
  const quarter = 365.25 / 4
  let p = (((doy - 79) % 365.25) + 365.25) % 365.25
  if (latitude < 0) p = (p + 2 * quarter) % 365.25
  p /= quarter
  const half = BLEND_DAYS / 2 / quarter
  let total = 0
  for (let j = 0; j < 4; j++) {
    let d = Math.abs(p - (j + 0.5))
    d = Math.min(d, 4 - d)
    const t = Math.min(1, Math.max(0, (0.5 + half - d) / (2 * half)))
    out[j] = t * t * (3 - 2 * t)
    total += out[j]!
  }
  for (let j = 0; j < 4; j++) out[j] = out[j]! / (total || 1)
  return out
}

/** The season with the most weight. */
export function dominantSeason(weights: ArrayLike<number>): Season {
  let best = 0
  for (let j = 1; j < 4; j++) if (weights[j]! > weights[best]!) best = j
  return SEASONS[best]!
}

/** °C a season adds to a preset's temperature. */
export const SEASON_TEMPERATURE: Record<Season, number> = {
  spring: 0,
  summer: 7,
  autumn: -1,
  winter: -9,
}
