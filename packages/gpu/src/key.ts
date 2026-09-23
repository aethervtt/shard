const ids = new WeakMap<object, number>()
let nextId = 1

function idOf(obj: object): number {
  let id = ids.get(obj)
  if (id === undefined) {
    id = nextId++
    ids.set(obj, id)
  }
  return id
}

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null || Array.isArray(value)
}

/**
 * A stable string key for a WebGPU descriptor. Plain data is serialized; GPU objects inside it
 * (shader modules, layouts, bind group layouts) are keyed by identity.
 */
export function descriptorKey(descriptor: unknown): string {
  return JSON.stringify(descriptor, (key, value) => {
    if (key === 'label') return undefined
    if (value !== null && typeof value === 'object' && !isPlain(value)) {
      if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
      return `#${idOf(value)}`
    }
    return value
  })
}
