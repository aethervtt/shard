/** Small local line icons. Decorative only: the surrounding control owns its name. */
const paths: Record<string, string> = {
  library: 'M3 5h6l2 2h10v12H3z M3 9h18',
  event: 'M3 12h3l2-7 4 14 3-10 2 3h4',
  mixer: 'M5 3v7m0 4v7m7-18v13m0 4v1m7-18v3m0 4v11 M2 10h6v4H2z M9 16h6v4H9z M16 6h6v4h-6z',
  music: 'M9 18V5l11-2v13 M9 8l11-2 M9 18c0 4-7 4-7 1s7-4 7-1 M20 16c0 4-7 4-7 1s7-4 7-1',
  parameters: 'M3 7h7m4 0h7M3 17h3m4 0h11 M10 4v6m4-6v6M6 14v6m4-6v6',
  diagnostics: 'M3 3v18h18 M7 15l4-5 4 3 5-8',
  undo: 'M9 5 4 10l5 5 M4 10h10a6 6 0 0 1 0 12',
  redo: 'm15 5 5 5-5 5 M20 10H10a6 6 0 0 0 0 12',
  save: 'M5 3h12l4 4v14H3V3z M7 3v6h10V3 M7 21v-8h10v8',
  play: 'm8 4 12 8-12 8z',
  stop: 'M6 6h12v12H6z',
  clip: 'M3 10v4m4-8v12m5-15v18m5-15v12m4-8v4',
  snapshot: 'M4 5h16v14H4z M8 9h8m-8 4h5',
}
export function audioIcon(document: Document, name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.classList.add('icon')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', paths[name] ?? paths.event!)
  svg.append(path)
  return svg
}
