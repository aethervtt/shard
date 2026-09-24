import { type DataType, type DataTypeOptions, defineDataType } from '@shard/assets'
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
import { defineMaterial, type MaterialType, type MaterialTypeOptions } from '@shard/render'
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
  resource<T>(
    name: string,
    options?: { description?: string; init?: () => T; reload?: 'keep' | 'replace' },
  ): ResourceDef<T>
  event<T = undefined>(name: string, options?: { description?: string }): EventDef<T>
  /**
   * Defines the material type `<project>/<name>`: fields (numbers, colors, texture handles) and a
   * shader in `shaders/` (`project::<file>`) that overrides hooks. Assets name it in `"type"`.
   */
  material<const F extends Fields>(name: string, options: MaterialTypeOptions<F>): MaterialType
  /**
   * Defines the data asset type `<project>/<name>`: `*.<extension>.json` files under the asset
   * roots are validated by `fields`, can `$extends` each other, and load into `store`. Components
   * reference them with `t.handle('<project>/<name>')`.
   */
  dataAsset<const F extends Fields, const N extends string>(
    name: N,
    fields: F,
    options: DataTypeOptions,
  ): DataType<F, N extends `${string}/${string}` ? N : `${string}/${N}`>
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
    material: (name, materialOptions) => defineMaterial(qualify(name), materialOptions),
    dataAsset: (name, fields, dataOptions) =>
      defineDataType(qualify(name) as never, fields, dataOptions) as never,
  }
}
