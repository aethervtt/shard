/** The planet graph from the spec. */
export const PLANET = {
  output: 'height',
  nodes: {
    continents: {
      fbm: { source: 'simplex', octaves: 5, frequency: 0.8, gain: 0.5, lacunarity: 2.0, seed: 1 },
    },
    mountains: { ridged: { source: 'simplex', octaves: 6, frequency: 3.2, seed: 2 } },
    mask: { remap: { input: 'continents', from: [0.1, 0.4], to: [0, 1], clamp: true } },
    warped: { warp: { input: 'mountains', by: 'continents', amount: 0.15 } },
    height: { add: ['continents', { multiply: ['warped', 'mask'] }] },
  },
}
