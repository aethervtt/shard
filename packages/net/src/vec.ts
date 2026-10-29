/**
 * A growable list of numbers in a Float64Array. `clear` keeps the memory: an array's
 * `length = 0` lets V8 drop its backing store, so refilling it every tick would allocate.
 */
export class NumberList {
  data: Float64Array
  length = 0

  constructor(capacity = 64) {
    this.data = new Float64Array(capacity)
  }

  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Float64Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = v
  }

  at(i: number): number {
    return this.data[i]!
  }

  clear(): void {
    this.length = 0
  }

  toArray(): number[] {
    return Array.from(this.data.subarray(0, this.length))
  }
}
