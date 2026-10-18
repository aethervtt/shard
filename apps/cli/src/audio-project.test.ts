import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { describeAudioEvents, describeMusic } from '@aethervtt/shard-audio'
import { timeout } from '@aethervtt/shard-core/test-env'
import { openProject } from '@aethervtt/shard-node'
import { describe, expect, it } from 'vitest'

// This exercises project compilation and the actual headless host. Run in the evidence pipeline,
// whose software Vulkan driver makes it independent of a developer's GPU/toolchain.
describe.skipIf(process.env.SHARD_AUDIO_PROJECT_TESTS !== 'required')(
  'audio-lab project lifecycle',
  () => {
    it(
      'starts its authored room and score, then reloads scripts without duplicate sustained audio',
      async () => {
        const dir = await mkdtemp(resolve(import.meta.dirname, '../.audio-project-'))
        try {
          await cp(resolve(import.meta.dirname, '../../../examples/audio-lab'), dir, {
            recursive: true,
            filter: (path) => !['node_modules', '.shard', 'captures'].includes(basename(path)),
          })
          const project = await openProject({ root: dir, generatorWorkers: false })
          try {
            expect(project.imports.failed).toEqual([])
            const world = project.app.world
            for (let i = 0; i < 500 && !describeMusic(world).transports.length; i++) {
              project.app.update(1 / 60)
              await new Promise((resolve) => setTimeout(resolve, 10))
            }
            expect(describeMusic(world).transports).toHaveLength(1)
            const sustained = () =>
              describeAudioEvents(world).instances.filter((instance) => instance.mode === 'sustain')
            expect(sustained()).toHaveLength(1)
            const before = describeMusic(world).transports[0]!.id
            const entry = join(dir, 'scripts/main.ts')
            await writeFile(
              entry,
              (await readFile(entry, 'utf8')).replace('(beat % 8) / 7', '(beat % 6) / 5'),
            )
            const rebuilt = await project.session.rebuild!()
            expect((await project.session.reload(rebuilt.load)).ok).toBe(true)
            for (let i = 0; i < 60; i++) {
              project.app.update(1 / 60)
              await new Promise((resolve) => setTimeout(resolve, 1))
            }
            expect(describeMusic(world).transports.map((transport) => transport.id)).toEqual([
              before,
            ])
            expect(sustained()).toHaveLength(1)
          } finally {
            project.close()
          }
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      },
      timeout(60000),
    )
  },
)
