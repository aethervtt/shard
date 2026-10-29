import { type DataType, type DataTypeOptions, defineDataType } from '@aethervtt/shard-assets'
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
  type ResourceOptions,
  ShardError,
  type TagDef,
} from '@aethervtt/shard-core'
import type { NetOptions } from '@aethervtt/shard-net'
import {
  defineGenerator,
  type Generator,
  type GeneratorOptions,
  type OutputSpec,
} from '@aethervtt/shard-procgen'
import {
  defineMaterial,
  type MaterialType,
  type MaterialTypeOptions,
} from '@aethervtt/shard-render'
import type { App, Plugin } from '@aethervtt/shard-runtime'
import { defineSettings, type SettingsDef } from '@aethervtt/shard-save'

export interface ProjectOptions {
  /** Must match `shard.json`'s name. Becomes the namespace of every project type. */
  name: string
  build?(app: App): void
  ready?(app: App): Promise<void> | void
}

/** A project's network setup: everything but where it runs (0092). Hosts add the role. */
export type ProjectNetOptions = Omit<
  NetOptions,
  'role' | 'transport' | 'address' | 'session' | 'code' | 'now'
>

export interface ProjectDef extends Plugin {
  readonly namespace: string
  /**
   * Makes the project multiplayer (0092): what replicates, its commands and events, and the
   * server's hooks. `shard server`, `shard run --net` and `shard dev --connect` add the net
   * plugin with it. Call it after defining the components it names.
   */
  net(options: ProjectNetOptions): void
  /** Defines `<project>/<name>`. A name in another namespace throws `project/namespace`. */
  component<const F extends Fields>(
    name: string,
    fields: F,
    options?: ComponentOptions,
  ): ComponentDef<F>
  tag(name: string, options?: { description?: string }): TagDef
  resource<T>(name: string, options?: ResourceOptions<T>): ResourceDef<T>
  event<T = undefined>(name: string, options?: { description?: string }): EventDef<T>
  /**
   * Defines the project's settings, `<project>/Settings`: a resource persisted per player in
   * `settings.json` (defaults from `settings/*.json`), loaded before Startup. Read it like any
   * resource; `setSettings` changes it and applies at once.
   */
  settings<const F extends Fields>(
    fields: F,
    options?: Pick<ComponentOptions, 'description' | 'version' | 'migrate'> & { name?: string },
  ): SettingsDef<F>
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
  /**
   * Defines the generator `<project>/<name>`: `(seed, params) → output` (a mesh, texture, data
   * value, or entities), cached by the hash of its inputs and run on the worker pool. Place its
   * output with a `generators/*.gen.json` file, a `procedural:<project>/<name>?…` ref, a
   * `procgen/GeneratorInstance`, or `generate(world, gen, params, seed)`.
   */
  generator<const P extends Fields, const O extends OutputSpec>(
    name: string,
    options: GeneratorOptions<P, O>,
  ): Generator<P, O>
}

/**
 * The project plugin: the game's own code, exported as the default of `scripts/main.ts`. Project
 * types are namespaced by the project name, so they never collide with engine types.
 */
const netConfigs = new WeakMap<Plugin, ProjectNetOptions>()

/** The project's `project.net(...)` options, or undefined for a single-player project. */
export function projectNet(project: Plugin): ProjectNetOptions | undefined {
  return netConfigs.get(project)
}

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
  const project: ProjectDef = {
    name: `project:${ns}`,
    namespace: ns,
    dependencies: ['core/time'],
    net: (netOptions) => {
      netConfigs.set(project, netOptions)
    },
    build: (app) => options.build?.(app),
    ready: (app) => options.ready?.(app),
    component: (name, fields, componentOptions) =>
      defineComponent(qualify(name), fields, componentOptions),
    tag: (name, tagOptions) => defineTag(qualify(name), tagOptions),
    resource: (name, resourceOptions) => defineResource(qualify(name), resourceOptions),
    event: (name, eventOptions) => defineEvent(qualify(name), eventOptions),
    settings: (fields, settingsOptions = {}) => {
      const { name = 'Settings', ...rest } = settingsOptions
      return defineSettings(qualify(name), fields, {
        description: `${ns} settings, persisted per player.`,
        ...rest,
      })
    },
    material: (name, materialOptions) => defineMaterial(qualify(name), materialOptions),
    dataAsset: (name, fields, dataOptions) =>
      defineDataType(qualify(name) as never, fields, dataOptions) as never,
    generator: (name, generatorOptions) => defineGenerator(qualify(name), generatorOptions),
  }
  return project
}
