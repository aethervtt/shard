import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Rng, ShardError } from '@aethervtt/shard-core'
import { budget, timingMode } from '@aethervtt/shard-core/test-env'
import type { MeshData } from '@aethervtt/shard-mesh'
import { canonicalParams, meshBuilder, requireGenerator } from '@aethervtt/shard-procgen'
import { describe, expect, it } from 'vitest'
import { buildTree, TreeGenerator } from './generator'
import { TREE_PRESETS, type TreePreset } from './presets'
import { TreeSpecies, type TreeSpeciesValue } from './species'
import { natureStarterFiles } from './starter'
import { BARK_PART_MAX, FULL_DETAIL, growTree, meshTree } from './tree'

const assets = join(dirname(fileURLToPath(import.meta.url)), '../assets')
const presets = Object.keys(TREE_PRESETS) as TreePreset[]
const tree = (species: TreeSpeciesValue, seed: number) =>
  buildTree(species, new Rng(seed), 1, meshBuilder.finish)
const triangles = (m: MeshData) => (m.indices?.length ?? 0) / 3

function bounds(m: MeshData) {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (let i = 1; i < m.positions.length; i += 3) {
    lo = Math.min(lo, m.positions[i]!)
    hi = Math.max(hi, m.positions[i]!)
  }
  return { lo, hi }
}

describe('nature/Tree', () => {
  it('is a generator with a species handle', () => {
    expect(requireGenerator('nature/Tree')).toBe(TreeGenerator)
    const params = canonicalParams(TreeGenerator, {
      species: { path: 'assets/nature/species/oak_medium.tree.json' },
    })
    expect(params).toEqual({
      scale: 1,
      species: { path: 'assets/nature/species/oak_medium.tree.json' },
    })
  })

  it.each(presets)('%s grows the same tree from the same seed, standing on the ground', (name) => {
    const a = tree(TREE_PRESETS[name], 3)
    const b = tree(TREE_PRESETS[name], 3)
    expect(a.mesh.positions).toEqual(b.mesh.positions)
    expect(a.mesh.indices).toEqual(b.mesh.indices)
    expect(a.mesh.uvs1).toEqual(b.mesh.uvs1)
    expect(tree(TREE_PRESETS[name], 4).mesh.positions).not.toEqual(a.mesh.positions)
    for (const v of a.mesh.positions) expect(Number.isFinite(v)).toBe(true)
    const { lo, hi } = bounds(a.mesh)
    expect(lo).toBeGreaterThan(-0.5)
    expect(hi).toBeGreaterThan(1)
    expect(hi).toBeLessThan(25)
  })

  it.each(presets)('%s has LODs at most half, then under a third, of its triangles', (name) => {
    const t = tree(TREE_PRESETS[name], 1)
    expect(t.lods).toHaveLength(2)
    const full = triangles(t.mesh)
    expect(triangles(t.lods[0]!)).toBeLessThanOrEqual(full * 0.5)
    expect(triangles(t.lods[1]!)).toBeLessThanOrEqual(full * 0.3)
  })

  it('marks bark from 0 at the trunk to BARK_PART_MAX, and leaves 1', () => {
    const species = TREE_PRESETS.oak_medium
    const b = meshTree(growTree(species, new Rng(2)), species, FULL_DETAIL)
    const m = b.finish()
    const parts = new Set<number>()
    for (let i = 0; i < m.uvs1!.length; i += 2) parts.add(Math.round(m.uvs1![i]! * 1000) / 1000)
    expect([...parts].sort()).toEqual([0, 0.1, 0.2, BARK_PART_MAX, 1])
  })

  it('continues a deciduous branch from exactly where its parent ends', () => {
    const species = TREE_PRESETS.oak_medium
    const skeleton = growTree(species, new Rng(9))
    const trunk = skeleton.branches[0]!
    const end = (trunk.count - 1) * 9
    // The trunk's continuation is the first level-1 branch queued.
    const next = skeleton.branches.find(
      (b) => b.level === 1 && b.sections[0] === trunk.sections[end],
    )
    expect(next).toBeDefined()
    expect([...next!.sections.subarray(0, 8)]).toEqual([...trunk.sections.subarray(end, end + 8)])
    expect(next!.segmentCount).toBe(trunk.segmentCount)
  })

  it('scales the whole tree', () => {
    const a = bounds(tree(TREE_PRESETS.pine_small, 5).mesh)
    const b = bounds(buildTree(TREE_PRESETS.pine_small, new Rng(5), 2, meshBuilder.finish).mesh)
    expect(b.hi).toBeCloseTo(a.hi * 2, 4)
  })

  it.runIf(timingMode === 'bench')('grows oak_medium with its LODs within budget', () => {
    tree(TREE_PRESETS.oak_medium, 0)
    const times: number[] = []
    for (let i = 1; i <= 10; i++) {
      const t0 = performance.now()
      tree(TREE_PRESETS.oak_medium, i)
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    expect(times[5]!).toBeLessThan(budget('nature/generate'))
  })

  it('refuses a species that would be too big, naming the level to cut', () => {
    const species = structuredClone(TREE_PRESETS.oak_large)
    for (const level of species.levels) level.children = 16
    species.leaves.count = 128
    expect(() => tree(species, 1)).toThrow(ShardError)
    try {
      tree(species, 1)
    } catch (err) {
      expect((err as ShardError).code).toBe('nature/too-big')
      expect((err as ShardError).path).toMatch(/^\/levels\/\d\/children$/)
    }
  })

  it('refuses a species with no levels', () => {
    const species = { ...TREE_PRESETS.oak_small, levels: [] }
    expect(() => tree(species, 1)).toThrow(/1 to 4 levels/)
  })
})

describe('starter files', () => {
  it('writes valid species, and materials whose textures ship with the package', () => {
    const files = natureStarterFiles()
    const paths = new Set(files.map((f) => f.path))
    for (const f of files) {
      if ('copy' in f) {
        expect(existsSync(join(assets, f.copy)), f.copy).toBe(true)
        continue
      }
      if (f.path.endsWith('.tree.json')) {
        expect(TreeSpecies.validate(JSON.parse(f.text)), f.path).toEqual([])
        continue
      }
      const json = f.text.match(/"path": "([^"]+)"/g)!.map((m) => m.slice(9, -1))
      expect(json.length).toBe(4)
      for (const path of json) expect(paths.has(path), path).toBe(true)
    }
    expect(files.filter((f) => f.path.endsWith('.tree.json'))).toHaveLength(15)
    expect(files.filter((f) => f.path.endsWith('.material.json'))).toHaveLength(4)
  })
})
