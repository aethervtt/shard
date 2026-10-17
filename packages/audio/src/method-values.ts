import { ShardError } from '@aethervtt/shard-core'
export function parameterValue(value: unknown): number | string {
  if (typeof value !== 'number' && typeof value !== 'string')
    throw new ShardError('audio/unknown-parameter', 'Parameter values must be numbers or labels')
  return value
}
