import { DEMO_GROUPS, type Demo, PAGES } from './demos'

/** Demos in the picker's order, for the previous and next buttons. */
const ORDER: readonly Demo[] = DEMO_GROUPS.flatMap((g) => g.demos.map(([demo]) => demo))

/** Opens a demo (a hash; the hashchange listener reloads) or a page, keeping `?backend=` and the rest. */
function open(value: string): void {
  if (value.endsWith('.html')) location.href = new URL(value + location.search, location.href).href
  else location.hash = value
}

/**
 * The demo picker, first in `container`: a dropdown of the demos by group and the pages after them,
 * between previous and next buttons.
 */
export function addDemoPicker(container: HTMLElement, demo: Demo): void {
  const select = document.createElement('select')
  select.id = 'demo'
  select.title = 'Demo'
  for (const group of DEMO_GROUPS) {
    const optgroup = document.createElement('optgroup')
    optgroup.label = group.name
    for (const [value, label] of group.demos) optgroup.append(new Option(label, value))
    select.append(optgroup)
  }
  const pages = document.createElement('optgroup')
  pages.label = 'Pages'
  for (const [value, label] of PAGES) pages.append(new Option(label, value))
  select.append(pages)
  select.value = demo
  select.addEventListener('change', () => open(select.value))

  const step = (by: number, text: string, title: string) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'step'
    button.textContent = text
    button.title = title
    button.addEventListener('click', () => {
      const at = ORDER.indexOf(demo)
      open(ORDER[(at + by + ORDER.length) % ORDER.length] as Demo)
    })
    return button
  }

  const row = document.createElement('div')
  row.id = 'picker'
  row.append(step(-1, '‹', 'Previous demo'), select, step(1, '›', 'Next demo'))
  container.prepend(row)
}
