import {
  AssetStore,
  assetServer,
  defineAssetSchema,
  defineAssetType,
  defineImporter,
  type ImporterDef,
} from '@shard/assets'
import {
  type ComponentDef,
  defineResource,
  defineSchema,
  defineSystem,
  isPlainObject,
  type JsonValue,
  PostUpdate,
  pointer,
  type Query,
  ShardError,
  t,
  type World,
} from '@shard/core'
import { type App, type AppMethod, LogResource } from '@shard/runtime'
import { Localized, ScreenText, Text } from './components'

// --- string tables -------------------------------------------------------------------------------

export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number]

/** One string: plain, or by plural category (`{ "one": "{n} item", "other": "{n} items" }`). */
export type StringEntry = string | Partial<Record<PluralCategory, string>>

/** A loaded `*.strings.json`: key → string for one locale. Hot reload bumps `version`. */
export class StringTable {
  locale: string
  strings: Map<string, StringEntry>
  version = 0

  constructor(locale: string, strings: Map<string, StringEntry>) {
    this.locale = locale
    this.strings = strings
  }

  copyFrom(other: StringTable): void {
    this.locale = other.locale
    this.strings = other.strings
    this.version++
  }
}

export const StringTables = defineResource<AssetStore<StringTable, 'StringTable'>>(
  'text/StringTables',
  {
    description: 'Loaded string tables (locales/*.strings.json) by guid.',
    init: () => new AssetStore('StringTable'),
  },
)

export const StringTableAssetType = defineAssetType<StringTable>('StringTable', {
  store: StringTables as never,
  load: (artifact) => {
    const json = artifact.json as { locale: string; strings: Record<string, StringEntry> }
    return new StringTable(json.locale, new Map(Object.entries(json.strings)))
  },
  update: (existing, next) => existing.copyFrom(next),
})

/**
 * The locale a table's file name names: `en.strings.json` and `hud.pt-BR.strings.json` are `en`
 * and `pt-BR`. Undefined if the name has no valid BCP 47 tag.
 */
export function localeOfPath(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.strings\.json$/i, '')
  const tag = name.slice(name.lastIndexOf('.') + 1)
  try {
    return Intl.getCanonicalLocales(tag)[0]
  } catch {
    return undefined
  }
}

const PLACEHOLDER = /\{([A-Za-z_][\w-]*)\}/g

/** The `{name}` placeholders in an entry, sorted and deduplicated. */
export function placeholdersOf(entry: StringEntry): string[] {
  const names = new Set<string>()
  const texts = typeof entry === 'string' ? [entry] : Object.values(entry)
  for (const text of texts) {
    if (typeof text !== 'string') continue
    for (const m of text.matchAll(PLACEHOLDER)) names.add(m[1]!)
  }
  return [...names].sort()
}

/** Every problem in a string table's JSON, each with a JSON pointer. */
export function validateStringTable(json: unknown): ShardError[] {
  const errors: ShardError[] = []
  if (!isPlainObject(json)) {
    return [
      new ShardError('locale/invalid-table', 'A string table must be a JSON object', {
        path: '',
        hint: 'Map keys to strings: { "hud.fuel": "Fuel: {amount}%" }.',
      }),
    ]
  }
  for (const [key, value] of Object.entries(json)) {
    if (key === '$schema') continue
    const at = pointer('', key)
    if (typeof value === 'string') continue
    if (!isPlainObject(value)) {
      errors.push(
        new ShardError('schema/type-mismatch', `"${key}" must be a string or plural forms`, {
          path: at,
          hint: 'Use "text", or { "one": "{n} item", "other": "{n} items" } for plurals.',
        }),
      )
      continue
    }
    for (const [category, text] of Object.entries(value)) {
      if (!(PLURAL_CATEGORIES as readonly string[]).includes(category)) {
        errors.push(
          new ShardError('locale/bad-plural', `"${category}" isn't a plural category in "${key}"`, {
            path: pointer(at, category),
            hint: `Plural forms are ${PLURAL_CATEGORIES.join(', ')} (Intl.PluralRules categories).`,
          }),
        )
      } else if (typeof text !== 'string') {
        errors.push(
          new ShardError('schema/type-mismatch', `"${key}".${category} must be a string`, {
            path: pointer(at, category),
          }),
        )
      }
    }
    if (typeof value.other !== 'string') {
      errors.push(
        new ShardError('locale/bad-plural', `Plural forms of "${key}" need "other"`, {
          path: at,
          hint: '"other" is the form every locale falls back to.',
        }),
      )
    }
  }
  return errors
}

const NoSettings = defineSchema('text/StringTableSettings', {}, { description: 'No settings.' })

/** `*.strings.json`: one locale's strings, named by the locale (`locales/pt-BR.strings.json`). */
export const StringTableImporter: ImporterDef = defineImporter({
  name: 'strings',
  version: 1,
  extensions: ['.strings.json'],
  settings: NoSettings,
  async import(source) {
    const locale = localeOfPath(source.path)
    if (!locale) {
      throw new ShardError('locale/bad-locale', `${source.path} doesn't name a locale`, {
        path: '',
        hint: 'Name tables by BCP 47 tag: locales/en.strings.json, locales/pt-BR.strings.json (or hud.pt-BR.strings.json).',
      })
    }
    let json: unknown
    try {
      json = JSON.parse(source.text())
    } catch (cause) {
      throw new ShardError('assets/import-failed', `${source.path} isn't valid JSON`, {
        path: '',
        cause,
      })
    }
    const errors = validateStringTable(json)
    if (errors.length > 0) {
      throw new ShardError(errors[0]!.code, `${source.path}: ${errors[0]!.message}`, {
        path: errors[0]!.path,
        hint: errors[0]!.hint,
        details: errors,
      })
    }
    const { $schema: _, ...strings } = json as Record<string, JsonValue>
    return {
      assets: [
        {
          label: '',
          type: 'StringTable',
          json: { locale, strings },
          info: { locale, keys: Object.keys(strings).length },
        },
      ],
    }
  },
})

defineAssetSchema('strings.schema.json', () => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Shard string table',
  description:
    'locales/<locale>.strings.json: key → string. {name} is a placeholder filled from params; an object picks a plural form by n (or count).',
  type: 'object',
  properties: { $schema: { type: 'string' } },
  additionalProperties: {
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        properties: Object.fromEntries(PLURAL_CATEGORIES.map((c) => [c, { type: 'string' }])),
        required: ['other'],
        additionalProperties: false,
      },
    ],
  },
}))

// --- the current locale -------------------------------------------------------------------------

export interface LocaleValue {
  /** BCP 47 tag, e.g. `pt-BR`. */
  current: string
  /** The last locale tried: `pt-BR` falls back to `pt`, then this. */
  fallback: string
}

export const Locale = defineResource<LocaleValue>('text/Locale', {
  description:
    'The current locale (current, e.g. "pt-BR") and the last one tried (fallback, "en"). Set current to switch language: keyed text updates on the next frame.',
  init: () => ({ current: 'en', fallback: 'en' }),
})

/** The locales tried for `current`, in order: `pt-BR` → `pt` → `en`. */
export function localeChain(current: string, fallback: string): string[] {
  const out: string[] = []
  const add = (tag: string) => {
    if (tag !== '' && !out.includes(tag)) out.push(tag)
  }
  add(current)
  const dash = current.indexOf('-')
  if (dash > 0) add(current.slice(0, dash))
  add(fallback)
  return out
}

interface Merged {
  /** Key → entry, over every loaded table of the locale. */
  strings: Map<string, StringEntry>
  /** Key → the table it came from, for validation messages. */
  source: Map<string, string>
}

/** Localization state for one world: merged tables, formatters, and what failed to resolve. */
export class LocaleStore {
  /** Bumped when a string table loads, changes, or goes away. */
  revision = 0
  /** The chain tried for the current locale. */
  chain: string[] = []
  /** Bumped when the chain changes (the locale was switched). */
  chainRevision = 0
  private chainFor = '\u0000'
  private merged: Map<string, Merged> | undefined
  private readonly plurals = new Map<string, Intl.PluralRules>()
  private readonly numbers = new Map<string, Intl.NumberFormat>()
  /** Keys requested at runtime that no locale in the chain had, by locale. */
  readonly missing = new Map<string, Set<string>>()
  /** Components whose `key` and `params` fields localize (UiText, Text, ScreenText). */
  readonly targets: { def: ComponentDef; query: Query | undefined }[] = []
  /** The resolved string's locale after `resolve` ('' if the key was missing). */
  resolvedLocale = ''

  /** Recomputes the chain if the locale changed. True if it did. */
  sync(locale: LocaleValue): boolean {
    const id = `${locale.current}|${locale.fallback}`
    if (id === this.chainFor) return false
    this.chainFor = id
    this.chain = localeChain(locale.current, locale.fallback)
    this.chainRevision++
    return true
  }

  /** Every loaded table's strings, merged per locale (rebuilt after a table changes). */
  tables(world: World): Map<string, Merged> {
    if (this.merged) return this.merged
    const out = new Map<string, Merged>()
    const server = assetServer(world)
    const store = world.tryResource(StringTables)
    for (const entry of server.all('StringTable')) {
      const table = store?.byGuid(entry.guid)
      if (!table) {
        // A table that appeared in the catalog, or was unloaded: load it (its event rebuilds this).
        if (entry.state === 'unloaded') {
          server.pin(entry.guid, PIN)
          void server.request(entry.guid)
        }
        continue
      }
      let m = out.get(table.locale)
      if (!m) {
        m = { strings: new Map(), source: new Map() }
        out.set(table.locale, m)
      }
      for (const [key, value] of table.strings) {
        m.strings.set(key, value)
        m.source.set(key, entry.path)
      }
    }
    this.merged = out
    return out
  }

  invalidate(): void {
    this.merged = undefined
    this.revision++
  }

  /**
   * The string for `key` in the first locale of the chain that has it, formatted with `params`.
   * Undefined if none has it (the miss is recorded and logged once).
   */
  resolve(world: World, key: string, params: unknown): string | undefined {
    const tables = this.tables(world)
    for (let i = 0; i < this.chain.length; i++) {
      const locale = this.chain[i]!
      const entry = tables.get(locale)?.strings.get(key)
      if (entry === undefined) continue
      this.resolvedLocale = locale
      return this.format(entry, this.chain[0]!, params)
    }
    this.resolvedLocale = ''
    const current = this.chain[0] ?? ''
    let keys = this.missing.get(current)
    if (!keys) {
      keys = new Set()
      this.missing.set(current, keys)
    }
    if (!keys.has(key)) {
      keys.add(key)
      world
        .tryResource(LogResource)
        ?.log('warn', `No string for "${key}" in ${this.chain.join(' → ')}`, {
          code: 'locale/missing-key',
          hint: `Add "${key}" to locales/${current}.strings.json (or the fallback locale's table).`,
        })
    }
    return undefined
  }

  /** Formats one entry: picks the plural form, then fills `{name}` placeholders. */
  format(entry: StringEntry, locale: string, params: unknown): string {
    const values = isPlainObject(params) ? params : undefined
    let text: string
    if (typeof entry === 'string') text = entry
    else {
      const n = pluralCount(values)
      const category =
        n === 0 && entry.zero !== undefined ? 'zero' : this.pluralRules(locale).select(n)
      text = entry[category as PluralCategory] ?? entry.other ?? ''
    }
    if (!values || text.indexOf('{') === -1) return text
    return text.replace(PLACEHOLDER, (whole, name: string) => {
      const v = values[name]
      if (typeof v === 'number') return this.numberFormat(locale).format(v)
      if (typeof v === 'string' || typeof v === 'boolean') return String(v)
      return whole
    })
  }

  pluralRules(locale: string): Intl.PluralRules {
    let rules = this.plurals.get(locale)
    if (!rules) {
      rules = new Intl.PluralRules(locale)
      this.plurals.set(locale, rules)
    }
    return rules
  }

  numberFormat(locale: string): Intl.NumberFormat {
    let format = this.numbers.get(locale)
    if (!format) {
      format = new Intl.NumberFormat(locale)
      this.numbers.set(locale, format)
    }
    return format
  }
}

/** The number that picks a plural form: `n`, else `count`, else the first number. */
function pluralCount(params: Record<string, unknown> | undefined): number {
  if (!params) return 0
  if (typeof params.n === 'number') return params.n
  if (typeof params.count === 'number') return params.count
  for (const k in params) if (typeof params[k] === 'number') return params[k] as number
  return 0
}

export const LocaleState = defineResource<LocaleStore>('text/LocaleState', {
  description: 'Merged string tables, plural rules, and missing keys (localization internals).',
})

/**
 * The string for `key` in the current locale: `tr(world, 'hud.fuel', { amount: 42 })`. Falls back
 * along `pt-BR` → `pt` → `en`; plural entries pick their form from `n` (or `count`) with
 * `Intl.PluralRules`, and numbers format with `Intl.NumberFormat`. A missing key returns the key
 * itself (and logs `locale/missing-key` once).
 */
export function tr(world: World, key: string, params?: Record<string, unknown>): string {
  const store = world.tryResource(LocaleState)
  if (!store) return key
  store.sync(world.resource(Locale))
  return store.resolve(world, key, params) ?? key
}

/** Switches the locale; keyed text updates on the next frame. */
export function setLocale(world: World, locale: string): void {
  let tag: string | undefined
  try {
    tag = Intl.getCanonicalLocales(locale)[0]
  } catch {
    tag = undefined
  }
  if (!tag) {
    throw new ShardError('locale/bad-locale', `"${locale}" isn't a locale`, {
      hint: 'Use a BCP 47 tag like "en", "pt-BR", or "ja".',
    })
  }
  world.resource(Locale).current = tag
}

/**
 * Makes a component's `key` and `params` fields localize: its entities get `text/Localized` with
 * the resolved string. Text, ScreenText, and UiText are registered by their plugins.
 */
export function localizeComponent(world: World, def: ComponentDef): void {
  const store = world.resource(LocaleState)
  if (!store.targets.some((x) => x.def === def)) store.targets.push({ def, query: undefined })
}

/** Resolves localized keys into `text/Localized`: only rows whose text changed, unless the locale or a table did. */
export const localizeText = defineSystem({
  name: 'text/localize',
  description: 'Resolves UiText, Text, and ScreenText keys in the current locale.',
  setup: () => ({ revision: -1, chain: -1 }),
  run: (s, world, ctx) => {
    const store = world.resource(LocaleState)
    store.sync(world.resource(Locale))
    // tr() and locale.set may have synced first: compare revisions, not sync's result.
    const all = store.chainRevision !== s.chain || store.revision !== s.revision
    s.revision = store.revision
    s.chain = store.chainRevision
    const since = ctx.lastRunTick
    for (let t = 0; t < store.targets.length; t++) {
      const target = store.targets[t]!
      target.query ??= world.query({ with: [target.def] })
      const def = target.def as ComponentDef<{ key: never; params: never }>
      const tables = target.query.tables
      for (let k = 0; k < tables.length; k++) {
        const table = tables[k]!
        if (table.count === 0 || (!all && table.lastChanged(def) <= since)) continue
        const keys = table.column(def, 'key') as unknown as string[]
        const params = table.column(def, 'params') as unknown as unknown[]
        const ticks = table.changedTicks(def)
        const has = table.has(Localized)
        const values = has ? table.column(Localized, 'value') : undefined
        const locales = has ? table.column(Localized, 'locale') : undefined
        let wrote = false
        for (let i = 0; i < table.count; i++) {
          if (!all && ticks[i]! <= since) continue
          const entity = table.entities[i]!
          const key = keys[i]!
          if (key === '') {
            if (has) ctx.commands.remove(entity, Localized)
            continue
          }
          // Missing: the component's own text shows, or the key when there's none.
          const value = store.resolve(world, key, params[i])
          const locale = store.resolvedLocale
          if (value === undefined) {
            if (has) ctx.commands.remove(entity, Localized)
            continue
          }
          if (!has) ctx.commands.add(entity, Localized, { value, locale })
          else if (values![i] !== value || locales![i] !== locale) {
            values![i] = value
            locales![i] = locale
            wrote = true
          }
        }
        if (wrote) table.markChanged(Localized)
      }
    }
  },
})

// --- validation ----------------------------------------------------------------------------------

/** Components that carry localization keys, by name (for scanning files without the classes). */
export const KEYED_COMPONENTS = ['ui/UiText', 'text/Text', 'text/ScreenText'] as const

/** Keys used in a scene or prefab file: every keyed component's `key`, with its JSON pointer. */
export function localizationKeysIn(json: unknown): { key: string; path: string }[] {
  const out: { key: string; path: string }[] = []
  const walk = (value: unknown, at: string) => {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) walk(value[i], pointer(at, i))
      return
    }
    if (!isPlainObject(value)) return
    for (const [k, v] of Object.entries(value)) {
      const here = pointer(at, k)
      if ((KEYED_COMPONENTS as readonly string[]).includes(k) && isPlainObject(v)) {
        if (typeof v.key === 'string' && v.key !== '')
          out.push({ key: v.key, path: pointer(here, 'key') })
      }
      walk(v, here)
    }
  }
  walk(json, '')
  return out
}

export interface LocalizationReport {
  /** Locales with at least one table. */
  locales: string[]
  /** Every key some table defines. */
  keys: Set<string>
  /** Missing keys and placeholder mismatches, each with the table it concerns. */
  errors: { source: string; error: ShardError }[]
}

/**
 * Checks the project's string tables against each other: a key one locale defines and another
 * lacks (`locale/missing-key`), and a key whose `{placeholders}` differ between locales
 * (`locale/param-mismatch`). Loads every table in the catalog.
 */
export async function validateLocalization(world: World): Promise<LocalizationReport> {
  const server = assetServer(world)
  const entries = server.all('StringTable')
  await Promise.all(entries.map((e) => server.load(e.guid).catch(() => undefined)))
  const store = world.initResource(StringTables)
  const byLocale = new Map<string, { path: string; table: StringTable }[]>()
  for (const entry of entries) {
    const table = store.byGuid(entry.guid)
    if (!table) continue
    const list = byLocale.get(table.locale) ?? []
    list.push({ path: entry.path, table })
    byLocale.set(table.locale, list)
  }
  const keys = new Set<string>()
  for (const list of byLocale.values())
    for (const { table } of list) for (const key of table.strings.keys()) keys.add(key)
  const locales = [...byLocale.keys()].sort()
  const errors: LocalizationReport['errors'] = []
  const firstDefinition = new Map<string, { locale: string; params: string }>()
  for (const locale of locales) {
    const list = byLocale.get(locale)!
    const own = new Map<string, StringEntry>()
    for (const { table } of list) for (const [k, v] of table.strings) own.set(k, v)
    const source = list[0]!.path
    for (const key of [...keys].sort()) {
      const entry = own.get(key)
      if (entry === undefined) {
        const others = locales.filter(
          (l) => l !== locale && byLocale.get(l)!.some((x) => x.table.strings.has(key)),
        )
        errors.push({
          source,
          error: new ShardError('locale/missing-key', `"${key}" is missing in ${locale}`, {
            path: pointer('', key),
            hint: `Defined in ${others.join(', ')}. Add it to ${source}.`,
          }),
        })
        continue
      }
      const params = placeholdersOf(entry).join(', ')
      const first = firstDefinition.get(key)
      if (!first) firstDefinition.set(key, { locale, params })
      else if (first.params !== params) {
        errors.push({
          source,
          error: new ShardError(
            'locale/param-mismatch',
            `"${key}" uses {${params}} in ${locale} but {${first.params}} in ${first.locale}`,
            {
              path: pointer('', key),
              hint: 'Every locale gets the same params: use the same {placeholders} in each.',
            },
          ),
        })
      }
    }
  }
  return { locales, keys, errors }
}

// --- protocol ------------------------------------------------------------------------------------

export const localeMethods: AppMethod[] = [
  {
    name: 'locale.set',
    description:
      'Switches the locale (a BCP 47 tag like "pt-BR"): keyed UiText, Text, and ScreenText update on the next frame. Returns the fallback chain.',
    params: defineSchema('protocol/LocaleSetParams', {
      locale: t.string({ required: true, description: 'e.g. "en", "pt-BR".' }),
    }),
    handler: ({ world }, params) => {
      setLocale(world, params.locale as string)
      const store = world.resource(LocaleState)
      store.sync(world.resource(Locale))
      return { current: world.resource(Locale).current, chain: store.chain }
    },
  },
  {
    name: 'locale.missing',
    description:
      "What doesn't translate: per locale, keys another locale's table defines but its own lacks, and keys requested at runtime that no locale in the chain had. Also the current locale, chain, and loaded locales.",
    params: defineSchema('protocol/LocaleMissingParams', {}),
    handler: ({ world }) => {
      const store = world.resource(LocaleState)
      store.sync(world.resource(Locale))
      const tables = store.tables(world)
      const all = new Set<string>()
      for (const m of tables.values()) for (const k of m.strings.keys()) all.add(k)
      const missing: Record<string, string[]> = {}
      for (const [locale, m] of tables) {
        const lacks = [...all].filter((k) => !m.strings.has(k)).sort()
        if (lacks.length > 0) missing[locale] = lacks
      }
      const requested: Record<string, string[]> = {}
      for (const [locale, keys] of store.missing) requested[locale] = [...keys].sort()
      return {
        current: world.resource(Locale).current,
        chain: store.chain,
        locales: [...tables.keys()].sort(),
        missing,
        requested,
      }
    },
  },
]

const installed = new WeakSet<App>()

/**
 * Localization for an app (idempotent): the Locale resource, string tables, the resolving system,
 * and the locale protocol methods. The text and UI plugins install it.
 */
export function installLocalization(app: App): void {
  if (installed.has(app)) return
  installed.add(app)
  const world = app.world
  world.initResource(Locale)
  world.initResource(StringTables)
  const store = new LocaleStore()
  world.insertResource(LocaleState, store)
  localizeComponent(world, Text)
  localizeComponent(world, ScreenText)
  assetServer(world).onEvent((e) => {
    if (assetServer(world).entry(e.guid)?.type !== 'StringTable' && e.kind !== 'removed') return
    store.invalidate()
  })
  app.addSystems(PostUpdate, localizeText)
  app.addMethod(...localeMethods)
}

/** Requests every string table in the catalog (small files: all locales stay loaded). */
export async function loadStringTables(world: World): Promise<void> {
  const server = assetServer(world)
  const entries = server.all('StringTable')
  // Nothing in a scene references a table, so they're pinned against asset collection.
  for (const e of entries) server.pin(e.guid, PIN)
  await Promise.all(entries.map((e) => server.load(e.guid)))
}

const PIN = 'text/strings'
