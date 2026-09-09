# Reptilian HyperIndex runtime

This fork tracks Envio HyperIndex and publishes the Reptilian runtime as
`@reptilianhq/envio`. The `3.9.0-reptilian.N` release line is based on upstream
`v3.9.0` and publishes matching native packages as
`@reptilianhq/envio-{platform}-{arch}` (plus `-musl` for Linux x64). The runtime
pins those packages at its own exact version: the ReScript bindings and the
N-API addon are built from the same commit, and the addon loader
(`Core.res`) resolves only the scoped names, so a runtime must never load a
native package from another fork release.

The fork is carried as a patch series on top of the upstream tag, re-applied on
each base upgrade (the `3.6.1-reptilian.N` line preceded this one). It retains
the application-specific runtime behavior that upstream does not provide:

- exact coalescing of compatible address-bound partitions across contract types
  (`FetchState.OptimizedPartitions.coalesceAddressBoundPartitions`);
- configurable per-partition and per-chain request concurrency
  (`ENVIO_MAX_PARTITION_CONCURRENCY`, `ENVIO_MAX_CHAIN_CONCURRENCY`);
- a scheduling policy change in `FetchState.getNextQuery`: gap fills
  (`FetchState.rangeReason` `GapFill`) that unblock a retained response are
  admitted ahead of all other work and are not gated on the soft target, and
  fresh work is selected in partition-fair rounds before the block-ordered
  budget pass;
- optional fixed-block historical source request pacing with finite-boundary
  handling (`ENVIO_SOURCE_BLOCKS_PER_REQUEST`, historical only);
- optional `ENVIO_HYPERSYNC_HEAD_POLL_BLOCKS` coalescing after realtime is
  reached, without delaying historical backfill or RPC realtime fetching;
- EVM `onBlock` callbacks can opt into `includeTimestamp: true` to expose
  `block.timestamp` in chain seconds. This requires a HyperSync-only chain
  with event registrations; unsupported sources and block-only indexers fail
  at registration. The default is false, preserving existing query selection.
  HyperSync event queries overlapping a registered block callback's range
  request all headers, including empty blocks, and reject incomplete header
  ranges. Timestamps use the chain's existing block store and are discarded on
  rollback, then read again from replacement headers. Queries before the
  registration's start block retain their existing selection. Callbacks with
  timestamp selection disabled leave the field undefined. Missing required
  timestamps fail closed. This runtime registration option does not change
  event field selection or persisted schema identity, so a replay can keep it
  off until live heartbeat activation;
- low-cardinality source, pipeline, PostgreSQL, and phase telemetry hooks
  (`RuntimeHooks`, bound through `globalThis` symbols by the host). Every hook
  is resolved per call, so the host may install its symbols before or after
  importing envio; an uninstalled hook is a no-op. Query range reasons reach
  the source-range hook as the strings `full_range`, `merge_boundary`,
  `end_boundary`, `adaptive`, `gap_fill` and `provider_retry`;
- a client-filter address threshold derived from upstream's fixed concurrency,
  so `ENVIO_MAX_CHAIN_CONCURRENCY` never moves the filtering switch;
- bounded source-query retries (`ENVIO_SOURCE_QUERY_MAX_RETRIES`,
  `ENVIO_SOURCE_QUERY_RETRY_TIMEOUT_MILLIS`) that release the chain slot and
  re-plan the range instead of holding the slot until the query resolves;
- resume compatibility that ignores the `-reptilian.N` suffix of the stored
  envio version (`Config.diffPaths`): a fork release resumes on the previous
  one's data, while an upstream base upgrade is still refused;
- simulated chains run with `blockLag: 0` (`SimulateItems.patchConfig`); and
- the StablesKinshipGrass HyperSync chain (id 988), which upstream's chain enum
  does not carry.

Publish only from a `v3.9.0-reptilian.N` tag after Build & Verify succeeds for
the tagged commit's `push` run on `main`. The publish workflow builds all
supported native platforms, publishes them first, and then publishes the
runtime with exact-version optional dependencies. Its `workflow_dispatch` input
is a recovery path only: it re-publishes the runtime package of an existing tag
from that tag's verified artifact and does not rebuild the native packages. The
npm package is consumed through an alias so application imports and the CLI
remain named `envio`.

## PostgreSQL write locality

Entity batches sort their deduplicated IDs before writing current rows. Sorting
uses the scalar ID values (including numeric IDs), within each chain scope. It
does not reorder the change history, alter IDs or checkpoints, or require a new
schema. Text ordering uses JavaScript comparison; locality benefits depend on
how closely that matches the database collation. Hash-style ASCII IDs are the
intended workload. The writer sorts the existing ID array, avoiding a database
sort over the full rows and its potential temporary-file spill.

Run the repeatable local experiment against a dedicated PostgreSQL database:

```sh
cd packages/envio
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=postgres node benchmarks/ordered-writes.mjs
```

It creates and removes an isolated schema, compares arrival order, SQL sorting,
and client sorting, and checks exact row-count/block-sum parity. `SEED_ROWS`
(default 500000) and `BATCH_SIZE` (default 16000) control the workload. JSON output
includes client elapsed time, server execution time, shared-buffer reads, and
sort spill. Use a test server with an index larger than `shared_buffers` to
exercise cache pressure; do not change production settings for the experiment.

A four-round local run with 32 MiB shared buffers reduced shared-buffer reads
by approximately 23% with client sorting and produced no sort spill. Elapsed
time varied across rounds: this is evidence of less buffer I/O, not a proven
production throughput improvement. Compare sustained write stalls and event
throughput after any deployment. OS cache, checkpoint activity, and event mix
can dominate timing. Existing workflow ownership remains the runtime's Build &
Verify and versioned publishing process described above.

## Entity-load timing hook

`LoadLayer` exposes `dlmm.chain-indexer.trace-entity-load` as a host wrapper with
arguments `(operation, step, callback)`. The host must invoke the callback exactly
once and preserve synchronous returns, asynchronous results, and errors. Without
an installed host, the runtime directly invokes the callback.

The `read` step covers the storage-client await (including pool wait and driver
decoding); `initialize` covers entity-map construction/in-memory initialization or
effect-cache validation; `index_prepare` covers filtered-read index preparation.
Operations contain only entity/effect names, access kind, and optional chain scope.
The chain-indexer host uses async-local processing-phase context to distinguish
preload reads from handler reads without relying on sampled tracing. These are
batched-load observations; they add no storage queries or RPCs. Overlapping read
durations must not be summed as exclusive batch wall time.

Verification: compile `packages/envio-tests` and run `EntityLoadTiming_test`,
`RuntimeHooks_test`, and `LoadLayer_test`. The public-handler regression checks
read/initialization boundaries, filtered-read index preparation, and unchanged
stored output; host telemetry tests cover concurrent phase attribution and errors.

## Mixed-partition filtering safety

A partition's `dynamicContract` tag means it holds addresses from only that
contract type. Coalescing addresses from multiple types clears the tag. Otherwise,
client-filter catch-up cleanup can retire a mixed partition and silently discard
unrelated factory coverage while other streams continue advancing.

`MixedPartitionCoverage_hegel_test` exercises real user configuration and handlers
against a local HyperSync world. Hegel varies launch counts, pagination, response
timing, and resume boundaries. Both continuous and resumed runs must retain every
factory, token, and curve event and must actually cross into client filtering.
Each generated input executes a full HTTP replay, so these two properties suppress
Hegel's 30-second slow-generation health check while retaining their 120-second
Vitest deadlines and 20 cases each.
The original implementation fails generated replay completion; the fixed one
passes. Runtime changes prevent further loss but do not reconstruct data already
skipped: recover from before the gap and validate event/launch parity.

Compile `packages/envio-tests` and run `MixedPartitionCoverage_hegel_test`,
`FetchState_test`, `DynamicSplitQueueAlias_test`, `ClientFilterDedup_test`, and
`DynamicContractPersistence_test`. Release ownership remains Build & Verify and
the versioned publish workflow described above; this library has no Render service
or Blueprint to deploy directly.
