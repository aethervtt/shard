# 0125 — Generated records that keep: compressed, counted across reloads

- **Status:** draft (built 2026-11-16). Implemented once its criteria pass in CI.
- **Packages:** `@aethervtt/shard-procgen`, `@aethervtt/shard-platform-web`, `@aethervtt/shard-project`
- **Depends on:** 0042, 0113

## Context

0042 caches generator records on disk (`.shard/cache/generated/`) and, where the project can't be
written, in platform storage (IndexedDB) under a size cap. Risen moves its expensive generated data
(town cells, the dead per cell) into records and pre-generates them (its spec 0019), which shows
three gaps:

- The storage cap only holds within one page load. `ProcgenRuntime` counts what it wrote in memory,
  so records from earlier sessions are never counted or evicted, and the store grows without bound.
- Records are stored as encoded, uncompressed. Risen's records gzip 10 to 1 overall (a 1.9 MB
  cell record to 119 KB), and its server cache is 600 MB.
- The browser store never asks for persistent storage, so it's evicted first under pressure, and
  Safari drops it after 7 idle days.

## Goals

- Records are gzipped on disk and in storage, and records written before this still read.
- The storage's records are counted across reloads and evicted least recently used first; a read
  refreshes a record's place.
- The web storage asks once for `navigator.storage.persist()`.
- No new main-thread cost on the worker path: a worker gzips the record it made.

## Non-goals

- A cap on the disk cache (`fs`). It's the project's, and pre-generation (Risen 0019) fills it on
  purpose. Deleting `.shard/cache/generated/` stays the way to drop it.
- Sharing records between machines (0042's deferred question).
- Coordinating two tabs: each keeps its own ledger, and the next load reconciles it with the store.

## Design

**Format.** A stored record is `gzip(encodeRecord(record))` (CompressionStream, which Bun, Node 18+,
browsers and their workers all have; zlib's default level). On read, bytes starting with gzip's
`1f 8b` are gunzipped first; anything else is decoded as before (an encoded record starts with
`SHGN`), so old caches keep working and are rewritten compressed only when regenerated. A record
that fails to gunzip or decode is a miss, as a damaged one is today.

**Workers.** `runJob` passes `compress` when the runtime stores records; `runGeneratorJob` then
returns `{ packed, stored }`, both moved back. The main thread decodes `packed` and writes `stored`
as is. A worker bundle older than this returns only `packed`; the main thread gzips it.

**Ledger.** `StoredLedger` (procgen) keeps the storage's records as `key → stored bytes` in a Map,
least recently used first, and their total. It lives in the same storage under `procgen-index`
(outside the `procgen/` prefix): `{ "version": 1, "records": [[key, bytes], …] }`.

- Loading (on first use): read the index, then `list('procgen/')`. Indexed keys that are gone are
  dropped; listed keys the index lacks (written after its last flush, or before ledgers existed)
  are read once for their size and counted as least recently used.
- A storage hit moves its record last; a write adds it last and evicts from the front while the
  total is over `storageSize`, never the record just written.
- Changes mark the index dirty and it's written two seconds later (one write per burst);
  `flushStorage()` writes it now. An index lost to a closed tab only costs the next load a
  reconciliation.

**Limits.** `cacheSize` keeps bounding decoded records in memory. `storageSize` (new, default
256 MB, `shard.json` `procgen.storageSize` in MB) bounds stored, compressed bytes.

**Persistence.** `createIndexedDbStorage` calls `navigator.storage.persist()` the first time it
opens its database, on the main thread of a secure context, unless `persisted()` already says yes.
Failures are ignored.

### API sketch

```ts
interface ProcgenOptions {
  /** Stored (compressed) bytes of records kept in `storage`. Default 256 MB. */
  storageSize?: number
}
class ProcgenRuntime {
  /** Writes the storage's index now (it's otherwise written two seconds after a change). */
  flushStorage(): Promise<void>
  cacheStats(): { …; stored: { records: number; bytes: number; limit: number } }
}
function compressRecord(packed: Uint8Array): Promise<Uint8Array>
/** Decodes a stored record, gunzipping it first when it's compressed. */
function decodeStored(data: Uint8Array): Promise<OutputRecord | undefined>
```

### Agent surface

`procgen.describe`'s `cache` gains `stored` (records, bytes and limit of the storage ledger).

## Decisions

- **gzip through CompressionStream, not a platform hook.** Every host has it, workers too. A
  1.9 MB Risen record, gzip / gunzip in ms: Bun 1.4 3.9 / 0.8, Node 22 6.4 / 1.9, Chromium 153
  5.7 / 1.1, WebKit 26 5.9 / 0.7, Firefox 155 4.6 / 2.1. Level 1 would halve the gzip time for
  a record 50% larger; with workers gzipping, it isn't needed.
- **Gzip header detection, not a format bump.** Old records stay hits; nothing is regenerated.
- **A separate `storageSize`.** Memory holds decoded records and storage compressed ones, about
  10 times smaller: one number can't mean both.
- **Index record, not listing sizes.** `KeyValueStorage` can list keys but not their sizes; reading
  every record on each load would cost the whole store.

## Acceptance criteria

- [x] A record round-trips through `compressRecord` and `decodeStored` with the same `recordHash`,
      and an uncompressed record from before still decodes.
- [x] A new runtime over the same storage counts the records an earlier one wrote, and evicts the
      least recently used first past `storageSize` (a record read since stays).
- [x] Records the index doesn't list are counted on load; indexed records that are gone are dropped.
- [x] `runGeneratorJob` with `compress` returns a `stored` record that decodes to `packed`'s assets.
- [x] Disk records are gzipped and read back in a new world as disk hits.

## Open questions

- None blocking. Firefox shows a prompt for `persist()`; if a game wants to choose its moment, the
  call can move behind an option.
