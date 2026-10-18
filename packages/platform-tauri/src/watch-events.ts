import type { FileChangeEvent } from '@aethervtt/shard-platform'
import type { WatchEvent } from '@tauri-apps/plugin-fs'

/** Reads must never invalidate the source that an observer has just read. */
export function projectFileChanges(root: string, event: WatchEvent): FileChangeEvent[] {
  const projectRoot = root.replaceAll('\\', '/').replace(/\/+$/, '')
  const type = event.type
  if (typeof type === 'object') {
    if ('access' in type) return []
    if ('modify' in type && type.modify.kind === 'metadata' && type.modify.mode === 'access-time')
      return []
  }
  const kind =
    typeof type === 'object' && 'create' in type
      ? 'create'
      : typeof type === 'object' && 'remove' in type
        ? 'remove'
        : 'modify'
  return event.paths.map((nativePath) => {
    const path = nativePath.replaceAll('\\', '/')
    return {
      kind,
      path: path.startsWith(`${projectRoot}/`) ? path.slice(projectRoot.length + 1) : path,
    }
  })
}
