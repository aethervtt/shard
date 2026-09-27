import { defineSchema, ShardError, t } from '@aethervtt/shard-core'
import type { MethodDef } from '@aethervtt/shard-protocol'
import { type App, AppControlResource, LogResource, type Plugin } from '@aethervtt/shard-runtime'
import { createProjectReloader, type ReloadReport } from './reload'

type ModuleLoader = () => Promise<{ default?: unknown }>

/** Parameter schemas of the `project.*` protocol methods (tools read them before a session exists). */
export const ProjectMethodParams = {
  'project.status': defineSchema('protocol/ProjectStatusParams', {}),
  'project.reload': defineSchema('protocol/ProjectReloadParams', {
    url: t.string({ description: 'Load this bundle URL instead of rebuilding (dev servers).' }),
    error: t.json({
      description:
        'A dev server reporting that the bundle failed to build: { code, message, source }.',
    }),
  }),
}

export interface ProjectStatus {
  /** The current bundle's content hash and build time. */
  bundle?: { hash: string; ms: number }
  /** How many reloads have succeeded. */
  reloads: number
  lastReload?: ReloadReport
  /** The last build or reload failure, if the latest attempt failed. */
  error?: { code: string; message: string; path?: string; hint?: string; source?: string }
  /** Components the current code no longer defines (kept in the world). */
  orphaned: string[]
  watching: boolean
}

/**
 * One running project's code: the reloader plus what happened last (bundle, reload, error), served
 * to tools as `project.status` / `project.reload`. Hosts feed it bundles; it never builds itself.
 */
export class ProjectSession {
  readonly app: App
  readonly reloader: ReturnType<typeof createProjectReloader>
  private state: ProjectStatus = { reloads: 0, orphaned: [], watching: false }
  private readonly listeners = new Set<(status: ProjectStatus) => void>()
  /** Set by the host: rebuilds and returns a loader for the new bundle. */
  rebuild: (() => Promise<{ load: ModuleLoader; hash: string; ms: number }>) | undefined

  constructor(
    app: App,
    options: { namespace: string; current: Plugin; bundle?: { hash: string; ms: number } },
  ) {
    this.app = app
    this.reloader = createProjectReloader(app, options)
    if (options.bundle) this.state.bundle = options.bundle
  }

  status(): ProjectStatus {
    return structuredClone(this.state)
  }

  set watching(on: boolean) {
    this.state.watching = on
  }

  onChange(listener: (status: ProjectStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Reloads from a freshly built bundle. Failures are logged and reported, never thrown. */
  async reload(load: ModuleLoader, bundle?: { hash: string; ms: number }): Promise<ReloadReport> {
    const report = await this.reloader.reload(load)
    this.state.lastReload = report
    if (report.ok) {
      this.state.reloads++
      // A frame that failed paused the app; new code is the fix, so carry on.
      const control = this.app.world.resource(AppControlResource)
      if (control.pausedByError) {
        control.paused = false
        control.pausedByError = false
      }
      this.state.orphaned = report.orphaned
      delete this.state.error
      if (bundle) this.state.bundle = bundle
      this.app.world
        .resource(LogResource)
        .info(
          `Project reloaded in ${Math.round(report.ms)} ms${report.migrated.length ? ` (migrated ${report.migrated.join(', ')})` : ''}`,
        )
    } else {
      this.state.error = report.error
      this.app.world.resource(LogResource).error(
        Object.assign(
          new ShardError(report.error!.code, report.error!.message, {
            path: report.error!.path,
            hint: report.error!.hint,
          }),
          { source: report.error!.source },
        ),
      )
    }
    this.emit()
    return report
  }

  /** Records a bundle that failed to build (the running code is unchanged). */
  buildFailed(error: unknown): void {
    const e =
      error instanceof ShardError ? error : new ShardError('project/bundle-failed', String(error))
    const source = (error as { source?: unknown })?.source
    this.state.error = {
      code: e.code,
      message: e.message,
      ...(e.path ? { path: e.path } : {}),
      ...(e.hint ? { hint: e.hint } : {}),
      ...(typeof source === 'string' ? { source } : {}),
    }
    this.app.world.resource(LogResource).error(error)
    this.emit()
  }

  private emit(): void {
    const status = this.status()
    for (const l of this.listeners) l(status)
  }

  /** `project.status` and `project.reload`, for the protocol server. */
  methods(): MethodDef[] {
    return [
      {
        name: 'project.status',
        description:
          'The project code: current bundle, reload count, the last reload report (migrated and orphaned components, systems added/removed/changed), and the last build or reload error with its source location.',
        params: ProjectMethodParams['project.status'],
        handler: () => this.status(),
      },
      {
        name: 'project.reload',
        description:
          'Rebuilds the project bundle and hot reloads it now (normally this happens on save). Returns the reload report.',
        params: ProjectMethodParams['project.reload'],
        handler: async (_ctx, p) => {
          if (p.error) {
            const e = p.error as {
              code?: string
              message?: string
              path?: string
              hint?: string
              source?: string
            }
            this.buildFailed(
              Object.assign(
                new ShardError(
                  e.code ?? 'project/bundle-failed',
                  e.message ?? 'The bundle failed to build',
                  {
                    path: e.path,
                    hint: e.hint,
                  },
                ),
                { source: e.source },
              ),
            )
            return this.status()
          }
          if (p.url) {
            const url = p.url as string
            return this.reload(() => import(/* @vite-ignore */ url), { hash: url, ms: 0 })
          }
          if (!this.rebuild) {
            throw new ShardError('project/no-bundler', 'This host has no bundler to rebuild with', {
              hint: 'Pass "url" with a built bundle.',
            })
          }
          let built: Awaited<ReturnType<NonNullable<ProjectSession['rebuild']>>>
          try {
            built = await this.rebuild()
          } catch (err) {
            this.buildFailed(err)
            throw err
          }
          return this.reload(built.load, { hash: built.hash, ms: built.ms })
        },
      },
    ]
  }
}
