// Flexbox layout cases, in UiNode fields. `gen-flex.html` lays each out in Chrome and records the
// rects into flex.chrome.json; flex.test.ts lays them out with the engine and compares.
const box = (w, h, extra = {}) => ({ style: { width: w, height: h, ...extra } })
const row3 = (justify) => ({
  style: { width: 400, height: 50, justify },
  children: [box(50, 30), box(80, 40), box(30, 20)],
})

export const CASES = [
  {
    name: 'row',
    root: { style: { width: 400, height: 200 }, children: [box(50, 40), box(60, 30), box(70, 50)] },
  },
  {
    name: 'column',
    root: {
      style: { width: 400, height: 300, direction: 'column', padding: [10, 20, 10, 20] },
      children: [box(50, 40), box('auto', 30), box(70, 50, { margin: [5, 5, 5, 5] })],
    },
  },
  {
    name: 'grow',
    root: {
      style: { width: 500, height: 100, gap: [10, 0] },
      children: [
        box(50, 40, { grow: 1 }),
        box(50, 40, { grow: 2 }),
        box('auto', 40, { grow: 1, basis: 20 }),
      ],
    },
  },
  {
    name: 'shrink',
    root: {
      style: { width: 300, height: 100 },
      children: [box(200, 40), box(100, 40), box(100, 40, { shrink: 2 })],
    },
  },
  {
    name: 'shrink-min-freezes',
    root: {
      style: { width: 300, height: 100 },
      children: [box(200, 40, { minWidth: 160 }), box(200, 40), box(200, 40, { shrink: 0, width: 50 })],
    },
  },
  {
    name: 'grow-max-freezes',
    root: {
      style: { width: 600, height: 100 },
      children: [box(50, 40, { grow: 1, maxWidth: 120 }), box(50, 40, { grow: 1 }), box(50, 40, { grow: 3 })],
    },
  },
  {
    name: 'grow-fractional',
    root: {
      style: { width: 400, height: 60 },
      children: [box(100, 40, { grow: 0.25 }), box(100, 40, { grow: 0.25 })],
    },
  },
  {
    name: 'wrap',
    root: {
      style: { width: 330, height: 300, wrap: true, gap: [10, 12], padding: [5, 5, 5, 5] },
      children: [
        box(100, 40, { margin: [0, 5, 0, 5] }),
        box(100, 50),
        box(100, 30),
        box(100, 40),
        box(150, 20),
      ],
    },
  },
  {
    name: 'wrap-stretch-lines',
    root: {
      style: { width: 300, height: 300, wrap: true },
      children: [box(120, 'auto'), box(120, 60), box(120, 'auto'), box(120, 90)],
    },
  },
  {
    name: 'wrap-grow',
    root: {
      style: { width: 300, height: 200, wrap: true, gap: [10, 10] },
      children: [box(100, 40, { grow: 1 }), box(100, 40, { grow: 1 }), box(100, 40, { grow: 1 })],
    },
  },
  {
    name: 'justify',
    root: {
      style: { width: 400, height: 360, direction: 'column', gap: [0, 10] },
      children: ['start', 'center', 'end', 'space-between', 'space-around', 'space-evenly'].map(row3),
    },
  },
  {
    name: 'justify-overflow',
    root: {
      style: { width: 100, height: 200, direction: 'column' },
      children: ['space-between', 'space-around', 'center'].map((justify) => ({
        style: { width: 100, height: 50, justify },
        children: [box(80, 20, { shrink: 0 }), box(80, 20, { shrink: 0 })],
      })),
    },
  },
  {
    name: 'align',
    root: {
      style: { width: 400, height: 120, padding: [10, 10, 10, 10] },
      children: [
        box(50, 'auto'),
        box(50, 30, { alignSelf: 'start' }),
        box(50, 30, { alignSelf: 'center' }),
        box(50, 30, { alignSelf: 'end' }),
        box(50, 'auto', { margin: [10, 0, 20, 0] }),
      ],
    },
  },
  {
    name: 'align-items-column',
    root: {
      style: { width: 300, height: 300, direction: 'column', alignItems: 'center', justify: 'center' },
      children: [box(100, 40), box(60, 40), box('auto', 40, { alignSelf: 'stretch' }), box(80, 40, { alignSelf: 'end' })],
    },
  },
  {
    name: 'absolute',
    root: {
      style: { width: 400, height: 300, padding: [20, 20, 20, 20] },
      children: [
        box(50, 50),
        box(60, 40, { position: 'absolute', left: 10, top: 15 }),
        box(60, 40, { position: 'absolute', right: 10, bottom: 15 }),
        box('auto', 30, { position: 'absolute', left: 30, right: 50, top: 100 }),
        box(40, 'auto', { position: 'absolute', top: '10%', bottom: '20%', left: '50%' }),
        box(70, 20, { position: 'absolute', margin: [5, 0, 0, 7] }),
      ],
    },
  },
  {
    name: 'absolute-static-centered',
    root: {
      style: { width: 400, height: 300, justify: 'center', alignItems: 'center' },
      children: [box(100, 60, { position: 'absolute' }), box(50, 50, { position: 'absolute', alignSelf: 'end' })],
    },
  },
  {
    name: 'percent',
    root: {
      style: { width: 400, height: 200, padding: [10, 20, 10, 20] },
      children: [
        box('25%', '50%'),
        box('50%', 40, { margin: [0, 0, 0, 10] }),
        { style: { width: '20%', height: '100%', padding: [5, 5, 5, 5] }, children: [box('50%', '50%')] },
      ],
    },
  },
  {
    name: 'min-max',
    root: {
      style: { width: 500, height: 200 },
      children: [
        box('50%', 40, { maxWidth: 100 }),
        box(20, 'auto', { minWidth: 60, maxHeight: 90 }),
        box(30, 10, { minHeight: 70 }),
        box(200, 50, { maxWidth: '10%' }),
      ],
    },
  },
  {
    name: 'content-sized',
    root: {
      style: { width: 500, height: 300, direction: 'column', alignItems: 'start' },
      children: [
        {
          style: { padding: [8, 12, 8, 12], gap: [6, 0] },
          children: [box(40, 20), box(50, 30), box(30, 25)],
        },
        {
          style: { direction: 'column', padding: [4, 4, 4, 4], gap: [0, 4] },
          children: [box(80, 20), box(120, 20)],
        },
        {
          style: { wrap: true, maxWidth: 150, gap: [5, 5] },
          children: [box(60, 20), box(60, 20), box(60, 20)],
        },
      ],
    },
  },
  {
    name: 'reverse',
    root: {
      style: { width: 400, height: 300, direction: 'column' },
      children: [
        {
          style: { height: 60, direction: 'row-reverse', gap: [10, 0], padding: [0, 5, 0, 15] },
          children: [box(50, 30, { margin: [0, 8, 0, 3] }), box(60, 30), box(70, 30)],
        },
        {
          style: { height: 200, direction: 'column-reverse', justify: 'center' },
          children: [box(50, 30), box(60, 40, { margin: [5, 0, 10, 0] })],
        },
      ],
    },
  },
  {
    name: 'order',
    root: {
      style: { width: 400, height: 100 },
      children: [box(50, 40, { order: 2 }), box(60, 40, { order: -1 }), box(70, 40), box(80, 40, { order: 2 })],
    },
  },
  {
    name: 'relative-offsets',
    root: {
      style: { width: 400, height: 100 },
      children: [box(50, 40, { left: 10, top: 5 }), box(60, 40, { right: 20, bottom: 10 }), box(70, 40)],
    },
  },
  {
    name: 'column-grow-content',
    root: {
      style: { width: 200, height: 400, direction: 'column' },
      children: [
        box('auto', 50),
        {
          style: { grow: 1, direction: 'column', justify: 'end', padding: [10, 10, 10, 10] },
          children: [box(40, 40), box('auto', 20)],
        },
        box('auto', 30, { margin: [10, 20, 0, 20] }),
      ],
    },
  },
  {
    name: 'display-none',
    root: {
      style: { width: 300, height: 100, gap: [10, 0] },
      children: [box(50, 40), box(60, 40, { display: 'none' }), box(70, 40)],
    },
  },
  {
    name: 'nested-hud',
    root: {
      style: { width: 640, height: 360, padding: [16, 16, 16, 16], justify: 'space-between' },
      children: [
        {
          style: { direction: 'column', width: 200, gap: [0, 8], padding: [8, 8, 8, 8] },
          children: [box('auto', 12), box('70%', 12), box('auto', 12)],
        },
        {
          style: { direction: 'column', justify: 'end', alignItems: 'end' },
          children: [box(120, 120), box(60, 20, { margin: [8, 0, 0, 0] })],
        },
        box(300, 24, { position: 'absolute', bottom: 16, left: 170 }),
      ],
    },
  },
]
