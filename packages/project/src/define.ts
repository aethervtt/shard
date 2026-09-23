import {
  type ComponentDef,
  type ComponentOptions,
  defineComponent,
  defineEvent,
  defineResource,
  defineTag,
  type EventDef,
  type Fields,
  type ResourceDef,
  ShardError,
  type TagDef,
} from '@shard/core'
import type { App, Plugin } from '@shard/runtime'

export interface ProjectOptions {
  /** Must match `shard.json`'s name. Becomes the namespace of every project type. */
  name: string
  build?(app: App): void
  ready?(app: App): Promise<void> | void
}

export interface ProjectDef extends Plugin {
  readonly namespace: string
  /** Defines `<project>/<name>`. A name in another namespace throws `project/namespace`. */
  component<const F extends Fields>(
    name: string,
    fields: F,
    options?: ComponentOptions,
  ): ComponentDef<F>
  tag(name: string, options?: { description?: string }): TagDef
  resource<T>(name: string, options?: { description?: string; init?: () => T }): ResourceDef<T>
  event<T = undefined>(name: string, options?: { description?: string }): EventDef<T>
}

/**
 * The project plugin: the game's own code, exported as the default of `scripts/main.ts`. Project
 * types are namespaced by the project name, so they never collide with engine types.
 */
export function defineProject(options: ProjectOptions): ProjectDef {
  const ns = options.name
  const qualify = (name: string) => {
    const slash = name.indexOf('/')
    if (slash === -1) return `${ns}/${name}`
    if (name.slice(0, slash) !== ns) {
      throw new ShardError(
        'project/namespace',
        `"${name}" is outside the project namespace "${ns}"`,
        {
          hint: `Project types are named "${ns}/<Name>"; pass just "<Name>".`,
        },
      )
    }
    return name
  }
  return {
    name: `project:${ns}`,
    namespace: ns,
    dependencies: ['core/time'],
    build: (app) => options.build?.(app),
    ready: (app) => options.ready?.(app),
    component: (name, fields, componentOptions) =>
      defineComponent(qualify(name), fields, componentOptions),
    tag: (name, tagOptions) => defineTag(qualify(name), tagOptions),
    resource: (name, resourceOptions) => defineResource(qualify(name), resourceOptions),
    event: (name, eventOptions) => defineEvent(qualify(name), eventOptions),
  }
}
