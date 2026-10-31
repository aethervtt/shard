# Publishing Shard

The [Release workflow](.github/workflows/release.yml) publishes every package in `packages/`
to npm as public `@aethervtt/shard-*` packages with provenance, and the CLI (`apps/cli`, as
`@aethervtt/shard-cli`, 0093). The other apps and the examples stay private.
The root `package.json` supplies the shared release version; workspace package manifests keep
their development versions and source exports. `scripts/release.mjs` creates publishable
manifests, JavaScript, declarations, runtime files, and exact internal dependency versions.

## Prepare and publish

1. Bump the root `package.json` version and update `CHANGELOG.md` in a PR. Use a minor bump for
   potentially breaking changes during `0.x`. Check that the version is unused on npm.
2. Let CI pass and merge the PR. Packaging can be checked before tagging by manually running the
   **Audio evidence** workflow on the release branch; its packaging job runs `pnpm release --check`.
   This installs the tarballs into a separate consumer, checks declarations, builds with Vite,
   Bun, webpack and Next, executes Node/Bun codecs and a headless frame, and verifies visible
   surfaces and workers in Chromium. Builds can stay entirely in CI.
3. Tag the merged commit with the exact root version and push that tag. For example, for 0.2.2:

   ```sh
   git switch main
   git pull --ff-only
   git tag -a v0.2.2 -m 'Shard 0.2.2'
   git push origin v0.2.2
   ```

4. Watch **Release** in GitHub Actions. It validates the tag/version, runs lint and typechecking,
   and runs the tests the way CI does: four runners split the package tests, and the gameplay
   examples and playground run serially on a fifth. Once all of them pass, it runs the release
   consumer check, saves the validated tarballs as a workflow artifact, then publishes them. Publishing uses npm's default `latest` tag; do not use this procedure
   unchanged for prereleases.
5. Verify every package's version, `latest` tag, exact internal dependencies, `shard.buildSha`,
   and provenance on npm. Install a representative set from the registry into a clean consumer
   to confirm the published packages resolve.

   A successful publish can precede install availability: npm scans packages before making them
   available, typically taking about five minutes and sometimes 15 minutes or longer. Wait for
   every package's metadata and tarball to be available before testing installation. A processing
   delay does not require republishing. See npm's
   [publish-time scanning announcement](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).

## Authentication

The repository secret `NPM_TOKEN` provides npm publishing credentials for the `@aethervtt` scope.
It must permit all packages being released, including creating new packages, and satisfy npm's
current publishing/2FA requirements. Never commit the token or paste it into logs. The workflow's
`id-token: write` permission supports provenance; it does not by itself grant npm publishing access.

See npm's [publishing documentation](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
and [provenance documentation](https://docs.npmjs.com/generating-provenance-statements/).
Trusted publishing is an alternative that requires configuring npm package trust and changing
the workflow; this workflow currently uses the repository secret.

## Failed releases

If validation fails before publishing, fix the problem and prepare a new release commit/version.
If publishing fails, inspect which packages reached npm before retrying: publication is sequential,
not atomic, and an existing name/version cannot be overwritten. The workflow skips versions already
on npm and retries a failed publish once, so rerunning the same run's failed job completes a
partial publish from the same validated commit. Do not move a tag. When a rerun isn't possible,
release a new version of the full set. Do not unpublish packages as routine recovery.

0.3.0 stopped partway (a transient provenance error); 0.4.0 failed validation (a teardown timeout)
and was never published. 0.4.1 is the first complete release after 0.2.2. 0.5.0 failed validation
when a star-explorer test timed out: the workflow ran every test on one runner, where gameplay
examples starve beside the GPU suites. 0.5.1 splits the tests as CI does.
