import { NavGridData } from './grid'

/** A small deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let x = s
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A size × size maze: rooms on odd cells, carved by a randomized depth-first search, then
 * `loops` extra walls knocked out so there's more than one way through. Some corridors cost 3.
 */
export function maze(size: number, seed: number, loops = 0.08): NavGridData {
  const grid = new NavGridData(size, size, new Uint8Array(size * size))
  const random = rng(seed)
  const stack = [1 + size]
  grid.costs[1 + size] = 1
  while (stack.length > 0) {
    const cur = stack[stack.length - 1]!
    const x = cur % size
    const y = (cur - x) / size
    const options: number[] = []
    for (const [dx, dy] of [
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
    ] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx > 0 && ny > 0 && nx < size - 1 && ny < size - 1 && grid.costs[ny * size + nx] === 0)
        options.push(dx, dy)
    }
    if (options.length === 0) {
      stack.pop()
      continue
    }
    const k = Math.floor(random() * (options.length / 2)) * 2
    const dx = options[k]!
    const dy = options[k + 1]!
    const cost = random() < 0.1 ? 3 : 1
    grid.costs[(y + dy / 2) * size + x + dx / 2] = cost
    grid.costs[(y + dy) * size + x + dx] = cost
    stack.push((y + dy) * size + x + dx)
  }
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      if (grid.costs[y * size + x] === 0 && (x + y) % 2 === 1 && random() < loops)
        grid.costs[y * size + x] = 1
    }
  }
  return grid
}
