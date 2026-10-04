/** The playground's demos, in the order the page lists them. `location.hash` picks one. */
export const DEMOS = [
  'scene',
  'galaxy',
  'lights',
  'ibl',
  'sky',
  'deferred',
  'crowd',
  'post',
  'lens',
  'sprites',
  'particles',
  'physics',
  'planet',
  'physics2d',
  'character',
  'character-planet',
  'character2d',
  'prefabs',
  'data',
  'animation',
  'animgraph',
  'ik',
  'audio',
  'ui',
  'nav',
  'nav2d',
  'save',
  'lights2d',
  'grids',
  'noise',
  'procgen',
  'terrain',
  'atmosphere',
  'tabletop',
  'interior',
] as const

export type Demo = (typeof DEMOS)[number]

/** The demo picker's groups and labels. Every demo sits in exactly one group (demos-picker.test.ts). */
export const DEMO_GROUPS: readonly { name: string; demos: readonly (readonly [Demo, string])[] }[] =
  [
    {
      name: 'Benchmarks',
      demos: [
        ['scene', 'Scene: 10k cubes'],
        ['galaxy', 'Galaxy: 100k stars'],
        ['crowd', 'Crowd: LOD meshes'],
        ['lights', 'Lights: 256 point lights'],
        ['deferred', 'Deferred: foliage overdraw'],
      ],
    },
    {
      name: 'Rendering',
      demos: [
        ['ibl', 'Image-based lighting'],
        ['sky', 'Sky'],
        ['post', 'Post effects'],
        ['lens', 'Lens fields'],
        ['atmosphere', 'Atmosphere'],
        ['noise', 'Material noise'],
      ],
    },
    {
      name: '2D',
      demos: [
        ['sprites', 'Sprites'],
        ['lights2d', '2D lights and shadows'],
        ['physics2d', '2D physics'],
        ['character2d', '2D character'],
        ['nav2d', 'Grid navigation'],
      ],
    },
    {
      name: 'Physics',
      demos: [
        ['physics', 'Rigid bodies'],
        ['planet', 'Planet gravity'],
        ['character', 'Character controller'],
        ['character-planet', 'Character on a planet'],
        ['particles', 'Particles'],
      ],
    },
    {
      name: 'Animation',
      demos: [
        ['animation', 'glTF clips'],
        ['animgraph', 'Animation graph'],
        ['ik', 'IK and retargeting'],
      ],
    },
    {
      name: 'Gameplay',
      demos: [
        ['prefabs', 'Prefabs'],
        ['data', 'Data files and hot reload'],
        ['ui', 'UI'],
        ['audio', 'Audio'],
        ['save', 'Saves and settings'],
        ['nav', 'Navmesh'],
      ],
    },
    {
      name: 'Worlds',
      demos: [
        ['grids', 'Floating origin'],
        ['procgen', 'Procedural generation'],
        ['terrain', 'Terrain'],
        ['tabletop', 'Tabletop (VTT)'],
        ['interior', 'Interior lighting'],
      ],
    },
  ]

/** Pages of their own, listed after the demos. Relative, so they work under any base path. */
export const PAGES: readonly (readonly [string, string])[] = [
  ['embedding.html', 'Embedding in a page'],
  ['dice.html', 'Dice'],
]
