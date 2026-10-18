import {
  type AnyField,
  type ComponentDef,
  type JsonObject,
  type JsonValue,
  pointer,
  ShardError,
} from '@aethervtt/shard-core'
import { drawAudioWaveform } from '../drawing'
import type { AudioEditorSession } from '../model'
import { audioEditorTypes } from '../schema'
import { audioEditorStyles } from '../styles'
import type { AudioAssetEntry, AudioEditorState, AudioWaveform } from '../types'

export type AudioEditorPanel =
  | 'library'
  | 'event'
  | 'mixer'
  | 'music'
  | 'parameters'
  | 'diagnostics'
export interface AudioEditorMountOptions {
  session: AudioEditorSession
  theme?: 'dark' | 'light'
  layout?: 'full' | 'compact'
  /** A host-served copy of audioEditorStyles, for CSPs forbidding inline style elements. */
  stylesheetUrl?: string
  strings?: Readonly<Record<string, string>>
  scene?: AudioEditorSceneSelection
}
/** Optional scene component selection. The host owns its history and persistence. */
export interface AudioEditorSceneSelection {
  schema: ComponentDef
  value: JsonObject
  readOnly?: boolean
  edit(change: { path: string; value?: JsonValue; remove?: boolean }): void
}
export interface AudioEditorView {
  readonly element: HTMLElement
  readonly root: ShadowRoot
  setTheme(theme: 'dark' | 'light'): void
  /** Rerender after the host updates its optional scene selection. */
  refresh(): void
  dispose(): void
}

const panels: AudioEditorPanel[] = [
  'library',
  'event',
  'mixer',
  'music',
  'parameters',
  'diagnostics',
]
const titles: Record<AudioEditorPanel, string> = {
  library: 'Library',
  event: 'Event',
  mixer: 'Mixer',
  music: 'Music',
  parameters: 'Parameters',
  diagnostics: 'Diagnostics',
}
function title(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (s) => s.toUpperCase())
}
function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}
function at(value: unknown, path: string): unknown {
  let current = value
  for (const part of path.split('/').slice(1)) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return current
}

/** All panels share this command-driven renderer; mount never starts audio. */
export function mountPanel(
  container: HTMLElement,
  options: AudioEditorMountOptions,
  fixedPanel?: AudioEditorPanel,
): AudioEditorView {
  const doc = container.ownerDocument
  const session = options.session
  const abort = new AbortController()
  let disposed = false
  let generation = 0
  let active: AudioEditorPanel = fixedPanel ?? (options.layout === 'compact' ? 'mixer' : 'library')
  let error = ''
  let picker:
    | { path: string; type: string; label: string; edit?: AudioEditorSceneSelection['edit'] }
    | undefined
  let search = ''
  let typeFilter = ''
  let cursor: string | undefined
  const cursors: (string | undefined)[] = []
  let libraryPage: { items: AudioAssetEntry[]; nextCursor?: string; total?: number } | undefined
  let inspection: unknown
  let waveformId = ''
  let waveform: { peaks: Float32Array; duration: number; sampleRate: number } | undefined
  let rendering = false
  let dragging = false
  let visible = true
  let meterTimer: ReturnType<typeof setInterval> | undefined
  let meterBusy = false
  const meters = new Map<string, { meter: HTMLMeterElement; label: HTMLElement }>()
  const downloadUrls = new Set<string>()
  const layerWaveforms = new Map<string, Promise<AudioWaveform>>()
  let waveformDocument = ''
  let renameFrom = ''
  let renameTo = ''
  let renameScanKey = ''
  let renameDependencies: { id: string; name: string; paths: string[] }[] = []
  let renameBlocked = ''
  const expanded = new Map<string, boolean>()
  const element = doc.createElement('div')
  element.dataset.audioEditor = fixedPanel ?? options.layout ?? 'full'
  element.dataset.theme = options.theme ?? 'dark'
  container.append(element)
  const root = element.attachShadow({ mode: 'open' })
  if (options.stylesheetUrl) {
    const link = doc.createElement('link')
    link.rel = 'stylesheet'
    link.href = options.stylesheetUrl
    root.append(link)
  } else {
    const style = doc.createElement('style')
    style.textContent = audioEditorStyles
    root.append(style)
  }
  const shell = el('div', 'editor')
  const toolbar = el('div', 'toolbar')
  toolbar.setAttribute('role', 'toolbar')
  toolbar.setAttribute('aria-label', 'Audio editor commands')
  const tabs = el('div', 'tabs')
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', 'Audio editor panels')
  const body = el('div', 'body')
  const status = el('div', 'status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  shell.append(toolbar, tabs, body, status)
  root.append(shell)

  function text(key: string): string {
    return options.strings?.[key] ?? key
  }
  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls = '',
    content?: string,
  ): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag)
    if (cls) node.className = cls
    if (content !== undefined) node.textContent = text(content)
    return node
  }
  function run(action: () => unknown): void {
    error = ''
    try {
      const result = action()
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void Promise.resolve(result).then(() => {
          if (!disposed) render()
        }, fail)
      } else render()
    } catch (cause) {
      fail(cause)
    }
  }
  function fail(cause: unknown): void {
    if (disposed) return
    error = cause instanceof Error ? cause.message : String(cause)
    render()
  }
  function download(bytes: BlobPart, mime: string, filename: string): void {
    if (disposed) return
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
    downloadUrls.add(url)
    const anchor = el('a')
    anchor.href = url
    anchor.download = filename
    root.append(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => {
      URL.revokeObjectURL(url)
      downloadUrls.delete(url)
    }, 0)
  }
  function button(name: string, action: () => unknown, disabled = false): HTMLButtonElement {
    const node = el('button', '', name)
    node.type = 'button'
    node.disabled = disabled
    node.addEventListener('click', () => run(action))
    return node
  }
  function inputLabel(name: string, input: HTMLElement): HTMLLabelElement {
    const label = el('label', 'field')
    label.append(el('span', 'field-label', name), input)
    return label
  }
  function details(name: string, path: string, open = false): HTMLDetailsElement {
    const node = el('details')
    node.dataset.group = path
    node.open = expanded.get(path) ?? open
    node.append(el('summary', '', name))
    node.addEventListener('toggle', () => expanded.set(path, node.open))
    return node
  }
  function edit(path: string, value: JsonValue): void {
    session.edit({ path, value })
  }
  function render(): void {
    if (disposed || rendering || dragging) return
    rendering = true
    try {
      const focused = root.activeElement as HTMLInputElement | null
      const focusPath = focused?.dataset.path
      const focusAction = focused?.dataset.focus
      const scrollTop = body.scrollTop
      const state = session.state
      toolbar.replaceChildren()
      toolbar.append(el('span', 'title', state.document?.name ?? 'Audio editor'))
      toolbar.append(
        button('Undo', () => session.undo(), !state.canUndo || state.readOnly),
        button('Redo', () => session.redo(), !state.canRedo || state.readOnly),
        button(
          state.saving ? 'Saving…' : 'Save',
          () => session.save(),
          !state.dirty ||
            state.saving ||
            state.readOnly ||
            !!state.conflict ||
            state.diagnostics.length > 0,
        ),
        button(
          'Play',
          () => session.play(),
          !session.preview ||
            session.preview.capabilities.play === false ||
            !state.document ||
            state.diagnostics.length > 0,
        ),
        button('Stop', () => session.stop(), !session.preview),
      )
      if (state.dirty && state.document?.revision && !state.conflict)
        toolbar.append(button('Discard changes', () => session.reload(), state.saving))
      tabs.replaceChildren()
      tabs.hidden = !!fixedPanel
      for (const panel of panels) {
        if (
          options.layout === 'compact' &&
          !['library', 'mixer', 'parameters', 'diagnostics'].includes(panel)
        )
          continue
        const tab = button(titles[panel], () => {
          active = panel
          picker = undefined
          return panel === 'library' ? loadLibrary() : undefined
        })
        tab.setAttribute('role', 'tab')
        tab.setAttribute('aria-selected', String(active === panel))
        tab.tabIndex = active === panel ? 0 : -1
        tab.dataset.focus = `tab-${panel}`
        tabs.append(tab)
      }
      body.replaceChildren()
      meters.clear()
      if (error) body.append(el('div', 'error notice', error))
      if (state.conflict) {
        const conflict = el('div', 'notice')
        conflict.append(
          el('p', 'error', 'This document changed on the server. Your draft has been kept.'),
          button('Discard draft and reload', () => session.reload()),
          button('Save draft as new document', () =>
            session.saveAs(
              globalThis.crypto.randomUUID(),
              `${state.document?.name ?? 'Audio'} copy`,
            ),
          ),
        )
        const versions = details('Compare local and server versions', 'conflict')
        versions.append(
          el(
            'pre',
            '',
            JSON.stringify({ local: state.document?.value, remote: state.conflict.value }, null, 2),
          ),
        )
        conflict.append(versions)
        body.append(conflict)
      }
      if (state.readOnly)
        body.append(el('p', 'notice', 'Read-only document. Editing and saving are unavailable.'))
      if (picker) renderLibrary(true)
      else if (active === 'library') renderLibrary(false)
      else if (active === 'diagnostics') renderDiagnostics(state)
      else renderAuthoring(state)
      status.textContent = [
        state.loading ? 'Loading' : state.dirty ? 'Unsaved changes' : 'Saved',
        `${state.diagnostics.length} issue${state.diagnostics.length === 1 ? '' : 's'}`,
        `Preview: ${state.previewState}`,
        session.preview?.mode === 'attached' ? 'Attached runtime' : 'Isolated audition',
        state.historyEvicted ? `${state.historyEvicted} history entries evicted` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      body.scrollTop = scrollTop
      if (focusPath || focusAction) {
        for (const candidate of root.querySelectorAll<HTMLElement>('[data-path],[data-focus]')) {
          if (
            (focusPath && candidate.dataset.path === focusPath) ||
            (focusAction && candidate.dataset.focus === focusAction)
          ) {
            candidate.focus({ preventScroll: true })
            break
          }
        }
      }
    } finally {
      rendering = false
      updateMeterPolling()
    }
  }

  function updateMeterPolling(): void {
    const enabled =
      !disposed &&
      visible &&
      !doc.hidden &&
      active === 'mixer' &&
      meters.size > 0 &&
      session.state.previewState === 'playing' &&
      !!session.preview?.command
    if (!enabled && meterTimer !== undefined) {
      clearInterval(meterTimer)
      meterTimer = undefined
    }
    if (enabled && meterTimer === undefined)
      meterTimer = setInterval(() => {
        void refreshMeters()
      }, 100)
  }
  async function refreshMeters(): Promise<void> {
    if (meterBusy || disposed || doc.hidden || !visible) return
    meterBusy = true
    try {
      for (const [bus, controls] of meters) {
        if (disposed || !visible || doc.hidden) break
        const measurement = object(await session.preview!.command!('audio.meters', { bus }))
        if (disposed || !controls.meter.isConnected) continue
        controls.meter.value = measurement.available
          ? Math.min(1, Number(measurement.peak) || 0)
          : 0
        controls.label.textContent = measurement.available
          ? `Measured peak ${Number(measurement.peak).toFixed(3)}, RMS ${Number(measurement.rms).toFixed(3)} · at ${Number(measurement.at).toFixed(3)}s`
          : 'Measured meter unavailable on this backend'
      }
    } catch {
      for (const controls of meters.values())
        controls.label.textContent = 'Measured meter unavailable: preview disconnected'
    } finally {
      meterBusy = false
    }
  }

  async function loadLibrary(): Promise<void> {
    const token = ++generation
    const page = await session.assets.list({
      search,
      type: picker?.type ?? (typeFilter || undefined),
      cursor,
      limit: 60,
      signal: abort.signal,
    })
    if (disposed || token !== generation) return
    libraryPage = { ...page, items: page.items.slice(0, 60) }
    render()
  }
  function renderLibrary(choosing: boolean): void {
    body.append(
      el('h2', '', choosing ? `Choose ${picker?.label ?? 'asset'}` : 'Host asset library'),
    )
    body.append(
      el(
        'p',
        'hint',
        'Audio comes from your host asset catalog. References keep stable asset IDs.',
      ),
    )
    if (choosing)
      body.append(
        button('Cancel selection', () => {
          picker = undefined
        }),
      )
    const searchInput = el('input')
    searchInput.type = 'search'
    searchInput.value = search
    searchInput.dataset.focus = 'catalog-search'
    searchInput.addEventListener('change', () => {
      search = searchInput.value
      cursor = undefined
      cursors.length = 0
      run(loadLibrary)
    })
    body.append(inputLabel('Search assets', searchInput))
    if (!choosing) {
      const filter = el('select')
      filter.append(new Option('All audio types', ''))
      for (const schema of audioEditorTypes) filter.append(new Option(schema.name, schema.name))
      filter.append(new Option('Audio clips', 'AudioClip'))
      filter.value = typeFilter
      filter.addEventListener('change', () => {
        typeFilter = filter.value
        cursor = undefined
        cursors.length = 0
        run(loadLibrary)
      })
      body.append(inputLabel('Asset type', filter))
      renderCreate()
    }
    const list = el('div', 'catalog')
    list.setAttribute('aria-label', 'Host assets')
    list.setAttribute('role', 'list')
    for (const asset of libraryPage?.items ?? []) {
      const row = el('div', 'catalog-row')
      row.setAttribute('role', 'listitem')
      const select = button(asset.name, async () => {
        if (picker) {
          const path = picker.path
          const sceneEdit = picker.edit
          picker = undefined
          if (sceneEdit) sceneEdit({ path, value: { guid: asset.id } })
          else edit(path, { guid: asset.id })
        } else if (asset.type === 'AudioClip') await showWaveform(asset.id)
        else {
          await session.open(asset.id)
          active = panelFor(asset.type)
        }
      })
      select.title = `${asset.name} (${asset.id})`
      row.append(select, el('span', 'badge', asset.type.replace('audio/', '')))
      list.append(row)
    }
    if (!libraryPage?.items.length) list.append(el('p', 'empty', 'No matching assets.'))
    body.append(list)
    const paging = el('div', 'actions')
    paging.append(
      button(
        'Previous assets',
        async () => {
          cursor = cursors.pop()
          await loadLibrary()
        },
        cursors.length === 0,
      ),
      button(
        'Next assets',
        async () => {
          cursors.push(cursor)
          cursor = libraryPage?.nextCursor
          await loadLibrary()
        },
        !libraryPage?.nextCursor,
      ),
      el(
        'span',
        'hint',
        libraryPage?.total === undefined
          ? 'Up to 60 assets per page'
          : `${libraryPage.total} catalog assets`,
      ),
    )
    body.append(paging)
    body.append(button('Refresh assets', loadLibrary))
    if (!choosing && session.state.document?.type.includes('Collection'))
      renderAuthoring(session.state)
    renderWaveform()
  }
  function renderCreate(): void {
    const create = details('Create or duplicate document', 'create')
    const name = el('input')
    name.value = 'New audio document'
    const type = el('select')
    for (const schema of audioEditorTypes)
      type.append(new Option(schema.name.replace('audio/', ''), schema.name))
    create.append(
      inputLabel('Document name', name),
      inputLabel('Document type', type),
      button(
        'Create document',
        async () => {
          await session.createNew(type.value, name.value)
          active = panelFor(type.value)
        },
        !session.documents.commit,
      ),
      button(
        'Duplicate document',
        () => session.duplicate(name.value),
        !session.state.document || !session.documents.commit,
      ),
    )
    body.append(create)
  }
  function panelFor(type: string): AudioEditorPanel {
    if (type.includes('Music')) return 'music'
    if (type.includes('Mixer') || type.includes('Snapshot')) return 'mixer'
    if (type.includes('Parameters')) return 'parameters'
    if (type.includes('Collection')) return 'library'
    return 'event'
  }
  function renderAuthoring(state: AudioEditorState): void {
    if (!state.document || !state.schema) {
      body.append(el('p', 'empty', 'Open an audio document from the Library.'))
      if (fixedPanel)
        body.append(
          button('Browse documents', () => {
            active = 'library'
            return loadLibrary()
          }),
        )
      return
    }
    const value = state.effective ?? state.document.value
    if (active === 'event') renderEvent(value)
    if (active === 'music') renderMusic(value)
    if (active === 'mixer') renderMixer(value)
    if (active === 'parameters') renderParameters(value)
    if (fixedPanel)
      body.append(
        button('Browse documents', () => {
          active = 'library'
          return loadLibrary()
        }),
      )
    const propertyHeading = el('h3', '', 'Properties')
    body.append(propertyHeading)
    const properties = el('div', 'properties')
    for (const [name, field] of Object.entries(state.schema.fields)) {
      if (field.options.hidden) continue
      if (active === 'parameters' && name !== 'parameters' && name !== 'globals') continue
      renderField(properties, name, field, pointer('', name), value[name], 0)
    }
    body.append(properties)
    renderWaveform()
    const raw = details('Document JSON', 'raw')
    const json = el('textarea')
    json.value = JSON.stringify(state.document.value, null, 2)
    json.setAttribute('aria-label', 'Document JSON')
    raw.append(
      json,
      button('Apply JSON draft', () => session.replace(JSON.parse(json.value)), state.readOnly),
    )
    body.append(raw)
  }
  function renderField(
    parent: HTMLElement,
    name: string,
    field: AnyField,
    path: string,
    value: unknown,
    depth: number,
    target?: AudioEditorSceneSelection,
  ): void {
    if (field.options.hidden) return
    const state = session.state
    const readonly =
      (target ? target.readOnly === true : state.readOnly) || field.options.readonly === true
    const edit = (path: string, value: JsonValue) =>
      target ? target.edit({ path, value }) : session.edit({ path, value })
    const displayName = title(name)
    const resolved = value ?? field.toJson(field.defaultValue())
    if (field.kind === 'struct' && field.fields) {
      const group = details(displayName, path, depth < 1)
      for (const [key, child] of Object.entries(field.fields))
        renderField(group, key, child, pointer(path, key), object(resolved)[key], depth + 1, target)
      parent.append(group)
      return
    }
    if (field.kind === 'list' && field.item) {
      const values = Array.isArray(resolved) ? resolved : []
      const group = details(`${displayName} (${values.length})`, path, depth < 1)
      for (let index = 0; index < values.length; index++) {
        const row = el('div', 'list-item')
        const heading = el('div', 'item-title')
        const itemName = object(values[index]).id ?? object(values[index]).name ?? `${index + 1}`
        heading.append(
          el('span', '', String(itemName)),
          button(
            `Move ${name} ${index + 1} up`,
            () => {
              const next = [...values]
              ;[next[index - 1], next[index]] = [next[index]!, next[index - 1]!]
              edit(path, next as JsonValue[])
            },
            readonly || index === 0,
          ),
          button(
            `Remove ${name} ${index + 1}`,
            () => edit(path, values.filter((_, i) => i !== index) as JsonValue[]),
            readonly,
          ),
        )
        row.append(heading)
        renderField(
          row,
          `${name} ${index + 1}`,
          field.item,
          pointer(path, index),
          values[index],
          depth + 1,
          target,
        )
        group.append(row)
      }
      group.append(
        button(
          `Add ${name}`,
          () => {
            const item = field.item!.toJson(field.item!.defaultValue())
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              if ('id' in item) item.id = `${name.replace(/s$/, '')}-${values.length + 1}`
              if ('name' in item) item.name = `${name.replace(/s$/, '')}-${values.length + 1}`
            }
            expanded.set(path, true)
            edit(path, [...values, item] as JsonValue[])
          },
          readonly,
        ),
      )
      parent.append(group)
      return
    }
    const wrap = el('div', 'field')
    if (field.kind === 'handle') {
      const ref = object(resolved)
      const id = typeof ref.guid === 'string' ? ref.guid : ''
      wrap.append(
        el('span', 'field-label', displayName),
        el('span', 'hint', id || 'No asset selected'),
      )
      const actions = el('div', 'actions')
      actions.append(
        button(
          `Choose ${name}`,
          async () => {
            picker = { path, type: field.assetType ?? '', label: name, edit: target?.edit }
            cursor = undefined
            cursors.length = 0
            search = ''
            await loadLibrary()
          },
          readonly,
        ),
        button(`Clear ${name}`, () => edit(path, null), readonly || !id),
      )
      if (field.assetType === 'AudioClip' && id)
        actions.append(
          button(`Waveform ${name}`, () => showWaveform(id), !session.preview?.waveform),
        )
      wrap.append(actions)
    } else if (field.stride > 1) {
      const values = Array.isArray(resolved) ? resolved : []
      wrap.append(el('span', 'field-label', displayName))
      const components = el('div', 'field-inline')
      for (let i = 0; i < field.stride; i++) {
        const input = el('input')
        input.type = 'number'
        input.step = 'any'
        input.value = String(values[i] ?? 0)
        input.dataset.path = `${path}/${i}`
        input.setAttribute('aria-label', `${displayName} ${i + 1}`)
        input.disabled = readonly
        input.addEventListener('change', () =>
          run(() => {
            const next = [...values] as JsonValue[]
            next[i] = Number(input.value)
            edit(path, next)
          }),
        )
        components.append(input)
      }
      wrap.append(components)
    } else {
      const schema = field.jsonSchema()
      let control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      if (field.kind === 'enum') {
        const select = el('select')
        for (const choice of (schema.enum ?? []) as string[])
          select.append(new Option(choice, choice))
        select.value = String(resolved ?? '')
        control = select
      } else if (field.kind === 'json') {
        const textarea = el('textarea')
        textarea.value = JSON.stringify(resolved, null, 2)
        control = textarea
      } else {
        const input = el('input')
        if (field.kind === 'bool') {
          input.type = 'checkbox'
          input.checked = !!resolved
        } else if (field.kind === 'string') {
          input.type = 'text'
          input.value = String(resolved ?? '')
        } else {
          input.type = 'number'
          input.step = field.kind.startsWith('f') ? 'any' : '1'
          input.value = String(resolved ?? 0)
          if (field.options.min !== undefined) input.min = String(field.options.min)
          if (field.options.max !== undefined) input.max = String(field.options.max)
        }
        control = input
      }
      control.disabled = readonly
      control.dataset.path = path
      control.addEventListener('change', () =>
        run(() => {
          const value =
            field.kind === 'bool'
              ? (control as HTMLInputElement).checked
              : field.kind === 'json'
                ? JSON.parse(control.value)
                : field.kind === 'enum' || field.kind === 'string'
                  ? control.value
                  : Number(control.value)
          edit(path, value)
        }),
      )
      wrap.append(
        inputLabel(
          `${displayName}${field.options.unit ? ` (${field.options.unit})` : ''}`,
          control,
        ),
      )
    }
    if (field.options.description) wrap.append(el('p', 'hint', field.options.description))
    const authored = at(target?.value ?? state.document?.value, path) !== undefined
    if (!authored && state.document?.value.$extends) wrap.append(el('span', 'hint', 'Inherited'))
    else if (authored && state.document?.value.$extends)
      wrap.append(
        button(
          `Reset ${name} override`,
          () =>
            target ? target.edit({ path, remove: true }) : session.edit({ path, remove: true }),
          readonly,
        ),
      )
    for (const diagnostic of target ? [] : state.diagnostics)
      if (diagnostic.path === path) wrap.append(el('p', 'error', diagnostic.message))
    parent.append(wrap)
  }
  function renderEvent(value: JsonObject): void {
    const layers = Array.isArray(value.layers) ? value.layers : []
    const waveKey = `${session.assets.scope}:${session.state.document?.id}:${session.state.document?.revision}`
    if (waveKey !== waveformDocument) {
      layerWaveforms.clear()
      waveformDocument = waveKey
    }
    if (!layers.length) return
    body.append(
      el(
        'p',
        'hint',
        'Layer timing in seconds. Edit exact delay, duration and envelope values below.',
      ),
    )
    const timeline = el('div', 'timeline')
    timeline.setAttribute('aria-label', 'Event layer timing')
    for (const layerValue of layers) {
      const layer = object(layerValue)
      const lane = el('div', 'timeline-lane')
      const clip = el(
        'span',
        'timeline-clip',
        `${layer.id ?? 'Layer'} · ${layer.delay ?? 0}s + ${layer.duration || 'clip'}s`,
      )
      clip.style.insetInlineStart = `${Math.min(80, Number(layer.delay ?? 0) * 10)}%`
      clip.style.width = `${Math.min(100, Math.max(15, Number(layer.duration || 1) * 10))}%`
      lane.append(clip)
      timeline.append(lane)
    }
    body.append(timeline)
    const waves = el('div', 'event-waves')
    for (const layerValue of layers) {
      const layer = object(layerValue)
      const choice = object(Array.isArray(layer.choices) ? layer.choices[0] : undefined)
      const clip = object(choice.clip)
      if (typeof clip.guid !== 'string' || !session.preview?.waveform) continue
      const lane = el('div', 'wave-lane')
      lane.append(el('span', 'wave-label', String(layer.id ?? 'Layer')))
      const canvas = el('canvas')
      canvas.width = 1024
      canvas.height = 96
      canvas.setAttribute('role', 'img')
      canvas.setAttribute('aria-label', `${layer.id} audio waveform`)
      lane.append(canvas)
      waves.append(lane)
      let pending = layerWaveforms.get(clip.guid)
      if (!pending) {
        pending = session.preview.waveform(clip.guid, 512, abort.signal)
        layerWaveforms.set(clip.guid, pending)
      }
      void pending
        .then((wave) => {
          if (disposed || !canvas.isConnected) return
          const context = canvas.getContext('2d')
          if (context)
            drawAudioWaveform(
              context,
              wave.peaks,
              canvas.width,
              canvas.height,
              element.dataset.theme === 'light' ? '#1555aa' : '#98c7ff',
            )
          canvas.setAttribute(
            'aria-label',
            `${layer.id} waveform, ${wave.duration.toFixed(3)} seconds`,
          )
        })
        .catch(() => {
          if (!disposed && canvas.isConnected) {
            canvas.remove()
            lane.append(el('span', 'hint', 'Waveform unavailable'))
          }
        })
    }
    body.append(waves)
  }
  function renderMixer(value: JsonObject): void {
    if (session.state.document?.type === 'audio/AudioSnapshot') {
      const snapshot = object(session.state.previewResult).snapshot
      const weight = el('input')
      weight.type = 'number'
      weight.min = '0'
      weight.max = '1'
      weight.step = '0.01'
      weight.value = '1'
      body.append(
        inputLabel('Audition snapshot weight', weight),
        button(
          'Apply snapshot weight',
          () =>
            session.preview?.command?.('audio.snapshot.set', {
              snapshot,
              weight: Number(weight.value),
            }),
          typeof snapshot !== 'number' || !session.preview?.command,
        ),
      )
    }
    const buses = Array.isArray(value.buses) ? value.buses : []
    if (!buses.length) return
    const grid = el('div', 'mixer-strips')
    for (let index = 0; index < buses.length; index++) {
      const bus = object(buses[index])
      const card = el('div', 'mixer-strip')
      card.append(el('h3', '', `${bus.id} → ${bus.parent || 'output'}`))
      const fader = el('input')
      fader.type = 'range'
      fader.min = '-120'
      fader.max = '24'
      fader.step = '0.1'
      fader.value = String(bus.gainDb ?? 0)
      fader.disabled = session.state.readOnly
      fader.dataset.path = `/buses/${index}/gainDb/fader`
      let transaction = false
      fader.addEventListener('pointerdown', () => {
        dragging = true
        session.beginTransaction('Bus gain')
        transaction = true
      })
      fader.addEventListener('input', () => {
        if (!transaction) {
          dragging = true
          session.beginTransaction('Bus gain')
          transaction = true
        }
        session.edit({ path: `/buses/${index}/gainDb`, value: Number(fader.value) })
      })
      const finish = () => {
        if (transaction) {
          transaction = false
          dragging = false
          session.endTransaction()
          render()
        }
      }
      fader.addEventListener('change', finish)
      fader.addEventListener('pointerup', finish)
      fader.addEventListener('blur', finish)
      fader.addEventListener('pointercancel', () => {
        if (transaction) {
          transaction = false
          dragging = false
          session.cancelTransaction()
          render()
        }
      })
      fader.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && transaction) {
          event.preventDefault()
          transaction = false
          dragging = false
          session.cancelTransaction()
          render()
        }
      })
      const faderRow = el('div', 'fader-row')
      fader.setAttribute('aria-label', `${bus.id} authored gain (dB)`)
      faderRow.append(fader)
      const gain = el('input')
      gain.type = 'number'
      gain.min = '-120'
      gain.max = '24'
      gain.step = '0.1'
      gain.value = String(bus.gainDb ?? 0)
      gain.disabled = session.state.readOnly
      gain.dataset.path = `/buses/${index}/gainDb/numeric`
      gain.addEventListener('change', () =>
        run(() => edit(`/buses/${index}/gainDb`, Number(gain.value))),
      )
      gain.setAttribute('aria-label', `${bus.id} exact authored gain (dB)`)
      faderRow.append(gain, el('span', 'hint', 'dB'))
      card.append(faderRow)
      const meter = el('meter')
      meter.min = 0
      meter.max = 1
      meter.value = 0
      meter.setAttribute('aria-label', `${bus.id} measured peak`)
      const meterLabel = el('span', 'hint meter-caption', 'Meter unavailable')
      meters.set(String(bus.id), { meter, label: meterLabel })
      card.append(meter, meterLabel)
      grid.append(card)
    }
    body.append(grid)
    const preferences = details('Audition category controls (not saved)', 'user-controls')
    for (const bus of ['master', 'music', 'sfx', 'voice', 'ambient', 'ui']) {
      const volume = el('input')
      volume.type = 'number'
      volume.min = '0'
      volume.max = '1'
      volume.step = '0.01'
      volume.value = '1'
      const muted = el('input')
      muted.type = 'checkbox'
      const row = el('div', 'card')
      const disabled = !session.preview?.capabilities.userControls
      volume.disabled = disabled
      muted.disabled = disabled
      row.append(
        inputLabel(`${bus} user volume`, volume),
        inputLabel(`${bus} user muted`, muted),
        button(
          `Apply ${bus} user preference`,
          () =>
            session.preview?.command?.('audio.user.set', {
              bus,
              volume: Number(volume.value),
              muted: muted.checked,
            }),
          disabled,
        ),
      )
      preferences.append(row)
    }
    body.append(
      preferences,
      button(
        'Inspect effective mixer values',
        async () => {
          inspection = await session.preview?.command?.('audio.mix.inspect', {})
        },
        !session.preview?.command,
      ),
    )
    if (inspection !== undefined) {
      const effective = details('Preview inspection', 'mix-inspection')
      effective.append(el('pre', '', JSON.stringify(inspection, null, 2)))
      body.append(effective)
    }
  }
  function renderMusic(value: JsonObject): void {
    const transport = object(session.state.previewResult).transport
    const canControl = typeof transport === 'number' && !!session.preview?.command
    body.append(
      el(
        'p',
        'notice',
        `${value.bpm ?? 120} BPM · ${value.numerator ?? 4}/${value.denominator ?? 4} · 960 ticks per quarter note`,
      ),
    )
    const sections = Array.isArray(value.sections) ? value.sections : []
    for (const sectionValue of sections) {
      const section = object(sectionValue)
      const card = el('div', 'card')
      card.append(el('h3', '', `${section.id} · ${section.bars} bars`))
      card.append(
        button(
          `Audition section ${section.id}`,
          async () => {
            inspection = await session.preview?.command?.('audio.music.transition', {
              transport,
              section: section.id,
              quantize: 'bar',
            })
          },
          !canControl,
        ),
      )
      for (const stemValue of Array.isArray(section.stems) ? section.stems : []) {
        const stem = object(stemValue)
        card.append(
          el('p', 'hint', `${stem.id}: samples ${stem.startSample ?? 0}–${stem.endSample ?? 0}`),
        )
      }
      body.append(card)
    }
    const transportControls = el('div', 'actions')
    for (const action of ['pause', 'resume'])
      transportControls.append(
        button(
          `${title(action)} music`,
          () => session.preview?.command?.(`audio.music.${action}`, { transport }),
          !canControl,
        ),
      )
    const tick = el('input')
    tick.type = 'number'
    tick.min = '0'
    tick.step = '1'
    tick.value = '0'
    body.append(
      transportControls,
      inputLabel('Audition seek tick (960 PPQ)', tick),
      button(
        'Seek music',
        () =>
          session.preview?.command?.('audio.music.seek', { transport, tick: Number(tick.value) }),
        !canControl,
      ),
    )
    for (const stingerValue of Array.isArray(value.stingers) ? value.stingers : []) {
      const stinger = object(stingerValue)
      body.append(
        button(
          `Audition stinger ${stinger.id}`,
          () =>
            session.preview?.command?.('audio.music.stinger', {
              transport,
              stinger: stinger.id,
              quantize: 'beat',
            }),
          !canControl,
        ),
      )
    }
    renderParameters(value)
    body.append(
      el(
        'p',
        'hint',
        'Sections, transition boundaries, stem sample markers and stingers are editable in the schema controls below.',
      ),
    )
  }
  function renderParameters(value: JsonObject): void {
    const parameters = Array.isArray(value.parameters) ? value.parameters : []
    if (!parameters.length) return
    renderRename(parameters)
    const section = details('Audition values (not saved)', 'audition', true)
    for (const item of parameters) {
      const parameter = object(item)
      const input = parameter.kind === 'label' ? el('select') : el('input')
      if (input instanceof HTMLSelectElement) {
        for (const label of Array.isArray(parameter.labels) ? parameter.labels : [])
          input.append(new Option(String(label), String(label)))
        input.selectedIndex = Number(parameter.initial ?? 0)
      } else {
        input.type = 'number'
        input.step = parameter.kind === 'discrete' ? '1' : 'any'
        input.value = String(parameter.initial ?? 0)
        input.min = String(parameter.min ?? 0)
        input.max = String(parameter.max ?? 1)
      }
      input.disabled = !session.preview?.command || !!parameter.readonly
      const result = object(session.state.previewResult)
      const music = typeof result.transport === 'number'
      const local = session.state.document?.type !== 'audio/AudioParameters'
      const disabled =
        !session.preview?.command ||
        !!parameter.readonly ||
        (local && !music && typeof result.instance !== 'number')
      section.append(
        inputLabel(String(parameter.name), input),
        button(
          `Audition ${parameter.name}`,
          () =>
            session.preview?.command?.(music ? 'audio.music.parameter' : 'audio.parameter.set', {
              ...(music ? { transport: result.transport } : { instance: result.instance ?? 0 }),
              name: parameter.name,
              value: parameter.kind === 'label' ? input.value : Number(input.value),
            }),
          disabled,
        ),
      )
    }
    body.append(section)
  }
  function referencePaths(value: unknown, name: string, path = ''): string[] {
    const paths: string[] = []
    if (!value || typeof value !== 'object') return paths
    for (const [key, child] of Object.entries(value)) {
      const childPath = pointer(path, key)
      if ((key === 'parameter' || key === 'selectParameter') && child === name)
        paths.push(childPath)
      else if (child && typeof child === 'object')
        paths.push(...referencePaths(child, name, childPath))
    }
    return paths
  }
  function renderRename(parameters: JsonValue[]): void {
    const state = session.state
    const document = state.document!
    const global = document.type === 'audio/AudioParameters'
    const rename = details('Rename a parameter safely', 'rename')
    const source = el('select')
    for (const parameter of parameters) {
      const name = String(object(parameter).name ?? '')
      source.append(new Option(name, name))
    }
    if (!parameters.some((parameter) => object(parameter).name === renameFrom))
      renameFrom = String(object(parameters[0]).name ?? '')
    source.value = renameFrom
    source.addEventListener('change', () => {
      renameFrom = source.value
      renameScanKey = ''
      render()
    })
    const name = el('input')
    name.value = renameTo
    name.addEventListener('input', () => {
      renameTo = name.value
    })
    rename.append(inputLabel('Parameter to rename', source), inputLabel('New parameter name', name))
    const localReferences = referencePaths(state.effective, renameFrom)
    rename.append(
      el('p', 'hint', `${localReferences.length} references in this document will change.`),
    )
    if (localReferences.length) rename.append(el('pre', '', localReferences.join('\n')))
    const key = `${document.id}:${document.revision}:${renameFrom}`
    if (global) {
      rename.append(
        button(
          'Find dependent documents',
          async () => {
            const dependencies: typeof renameDependencies = []
            const allDocuments: { id: string; name: string; value: JsonObject }[] = []
            const seen = new Set<string>()
            for (const schema of audioEditorTypes) {
              let pageCursor: string | undefined
              do {
                const page = await session.assets.list({
                  type: schema.name,
                  cursor: pageCursor,
                  limit: 60,
                  signal: abort.signal,
                })
                for (const entry of page.items) {
                  if (entry.id === document.id || seen.has(entry.id)) continue
                  seen.add(entry.id)
                  const dependent = await session.documents.read(entry.id, abort.signal)
                  allDocuments.push({
                    id: dependent.id,
                    name: dependent.name,
                    value: dependent.value,
                  })
                  if (object(dependent.value.globals).guid === document.id)
                    dependencies.push({
                      id: dependent.id,
                      name: dependent.name,
                      paths: referencePaths(dependent.value, renameFrom),
                    })
                }
                if (page.nextCursor === pageCursor && page.nextCursor !== undefined)
                  throw new ShardError(
                    'audio-editor/invalid-document',
                    'The host asset catalog returned a repeated page cursor.',
                    { hint: 'Ask the host to correct its catalog pagination.' },
                  )
                pageCursor = page.nextCursor
              } while (pageCursor && !disposed)
            }
            if (disposed || session.state.document?.id !== document.id) return
            const inherited = allDocuments.filter(
              (entry) =>
                typeof entry.value.$extends === 'string' &&
                (entry.value.$extends === document.id ||
                  dependencies.some((dependent) => dependent.id === entry.value.$extends)) &&
                referencePaths(entry.value, renameFrom).length > 0,
            )
            renameBlocked = inherited.length
              ? `Inherited references need a host-aware rename: ${inherited.map((entry) => entry.name).join(', ')}`
              : ''
            renameDependencies = dependencies
            renameScanKey = key
          },
          !session.documents.atomic || state.dirty,
        ),
      )
      if (!session.documents.atomic)
        rename.append(
          el('p', 'hint', 'This host cannot rename references across documents atomically.'),
        )
      if (renameScanKey === key) {
        rename.append(
          el(
            'p',
            'hint',
            `${renameDependencies.length} dependent documents will be updated atomically.`,
          ),
        )
        for (const dependent of renameDependencies)
          rename.append(el('p', 'hint', `${dependent.name}: ${dependent.paths.length} references`))
        if (renameBlocked) rename.append(el('p', 'error', renameBlocked))
      }
    }
    rename.append(
      button(
        'Rename safely',
        async () => {
          await session.renameParameter(
            renameFrom,
            renameTo,
            global ? renameDependencies.map((dependent) => dependent.id) : [],
          )
          renameFrom = renameTo
          renameTo = ''
          renameScanKey = ''
        },
        state.readOnly ||
          state.dirty ||
          !document.revision ||
          (global && (!session.documents.atomic || renameScanKey !== key || !!renameBlocked)),
      ),
    )
    if (state.dirty) rename.append(el('p', 'hint', 'Save changes before renaming.'))
    body.append(rename)
  }
  function renderDiagnostics(state: AudioEditorState): void {
    body.append(el('h2', '', 'Diagnostics'))
    if (state.document)
      body.append(
        el(
          'p',
          'hint',
          `${state.document.type} · ${state.document.id} · revision ${state.document.revision || 'new'}`,
        ),
      )
    for (const diagnostic of state.diagnostics) {
      body.append(
        button(`${diagnostic.path ?? '/'}: ${diagnostic.message}`, () => {
          active = panelFor(state.document?.type ?? '')
          const path = diagnostic.path ?? ''
          const parts = path.split('/')
          for (let i = 1; i <= parts.length; i++) expanded.set(parts.slice(0, i).join('/'), true)
          render()
          for (const input of root.querySelectorAll<HTMLElement>('[data-path]'))
            if (input.dataset.path === path) input.focus()
        }),
      )
      if (diagnostic.hint) body.append(el('p', 'hint', diagnostic.hint))
    }
    if (!state.diagnostics.length) body.append(el('p', '', 'No validation issues.'))
    body.append(
      button('Validate references', () => session.validate()),
      button(
        'Refresh preview inspection',
        async () => {
          inspection = await session.preview?.inspect()
        },
        !session.preview,
      ),
    )
    body.append(
      el('p', 'hint', 'Inspection refreshes on request. Idle and hidden panels do not poll.'),
    )
    if (inspection !== undefined) body.append(el('pre', '', JSON.stringify(inspection, null, 2)))
    if (!session.preview?.export)
      body.append(el('p', 'hint', 'WAV/trace export unavailable: this host has no export adapter.'))
    else {
      const plan = el('textarea')
      plan.value = '{"seed":1}'
      plan.setAttribute('aria-label', 'Preview export plan')
      body.append(
        plan,
        button(
          'Export WAV and trace',
          async () => {
            const result = await session.preview!.export!(
              state.document!,
              JSON.parse(plan.value),
              abort.signal,
            )
            if (disposed || !result || typeof result !== 'object') return
            const exported = result as Record<string, unknown>
            if (exported.wav instanceof Uint8Array) {
              download(new Uint8Array(exported.wav).buffer, 'audio/wav', 'audio-preview.wav')
              const { wav: _wav, ...report } = exported
              download(
                JSON.stringify(report, null, 2),
                'application/json',
                'audio-preview.trace.json',
              )
            } else {
              inspection = result
              render()
            }
          },
          !state.document || state.diagnostics.length > 0,
        ),
      )
    }
    const position = details('Audition listener and emitter', 'position')
    const coords: HTMLInputElement[] = []
    for (const axis of ['X', 'Y', 'Z']) {
      const input = el('input')
      input.type = 'number'
      input.step = 'any'
      input.value = '0'
      coords.push(input)
      position.append(inputLabel(`${axis} position`, input))
    }
    position.append(
      button(
        'Set audition listener',
        () =>
          session.preview?.command?.('audio.listener.set', {
            position: coords.map((input) => Number(input.value)),
          }),
        !session.preview?.capabilities.listener,
      ),
    )
    const instance = object(state.previewResult).instance
    position.append(
      button(
        'Set audition emitter',
        () =>
          session.preview?.command?.('audio.emitter.set', {
            instance,
            position: coords.map((input) => Number(input.value)),
          }),
        !session.preview?.capabilities.emitter || typeof instance !== 'number',
      ),
    )
    body.append(position)
    if (options.scene) {
      const scene = details(`Scene component: ${options.scene.schema.name}`, 'scene', true)
      for (const [name, field] of Object.entries(options.scene.schema.fields))
        renderField(
          scene,
          name,
          field,
          pointer('', name),
          options.scene.value[name],
          0,
          options.scene,
        )
      body.append(scene)
    } else
      body.append(
        el(
          'p',
          'hint',
          'Scene component editing unavailable: this host has not supplied a scene selection adapter.',
        ),
      )
  }
  async function showWaveform(id: string): Promise<void> {
    if (!session.preview?.waveform) {
      error = 'Waveform unavailable: this host has no waveform capability.'
      return
    }
    const token = ++generation
    const result = await session.preview.waveform(id, 512, abort.signal)
    if (disposed || token !== generation) return
    waveformId = id
    waveform = result
  }
  function renderWaveform(): void {
    if (!waveform) return
    const canvas = el('canvas')
    canvas.width = 1024
    canvas.height = 160
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', `Waveform of ${waveformId}, ${waveform.duration} seconds`)
    body.append(
      canvas,
      el(
        'p',
        'hint',
        `${waveformId} · ${waveform.duration.toFixed(3)} seconds · ${waveform.sampleRate} Hz`,
      ),
    )
    const context = canvas.getContext('2d')
    if (!context) return
    drawAudioWaveform(
      context,
      waveform.peaks,
      canvas.width,
      canvas.height,
      element.dataset.theme === 'light' ? '#1555aa' : '#98c7ff',
    )
  }
  root.addEventListener(
    'keydown',
    (event) => {
      const key = event as KeyboardEvent
      if (
        (key.target as HTMLElement).getAttribute('role') === 'tab' &&
        ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key.key)
      ) {
        key.preventDefault()
        const buttons = [...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        const current = buttons.indexOf(key.target as HTMLButtonElement)
        const next =
          key.key === 'Home'
            ? 0
            : key.key === 'End'
              ? buttons.length - 1
              : (current + (key.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.click()
        ;(tabs.children[next] as HTMLButtonElement | undefined)?.focus()
      }
      if (key.key === 'Escape' && picker) {
        key.preventDefault()
        picker = undefined
        render()
      }
      if (!(key.ctrlKey || key.metaKey)) return
      if (key.key.toLowerCase() === 's') {
        key.preventDefault()
        run(() => session.save())
      }
      if (key.key.toLowerCase() === 'z') {
        key.preventDefault()
        run(() => (key.shiftKey ? session.redo() : session.undo()))
      }
    },
    { signal: abort.signal },
  )
  const unsubscribe = session.subscribe(() => render())
  const unsubscribeAssets = session.assets.subscribe?.(() => {
    layerWaveforms.clear()
    waveform = undefined
    renameScanKey = ''
    if (!disposed) render()
  })
  const visibility = () => updateMeterPolling()
  doc.addEventListener('visibilitychange', visibility, { signal: abort.signal })
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver((entries) => {
          visible = entries.some((entry) => entry.isIntersecting)
          updateMeterPolling()
        })
  observer?.observe(element)
  render()
  if (active === 'library') run(loadLibrary)
  return {
    element,
    root,
    refresh: render,
    setTheme(theme) {
      element.dataset.theme = theme
      render()
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation++
      abort.abort()
      unsubscribe()
      unsubscribeAssets?.()
      observer?.disconnect()
      if (meterTimer !== undefined) clearInterval(meterTimer)
      for (const url of downloadUrls) URL.revokeObjectURL(url)
      downloadUrls.clear()
      if (dragging) session.cancelTransaction()
      element.remove()
      waveform = undefined
      layerWaveforms.clear()
    },
  }
}
