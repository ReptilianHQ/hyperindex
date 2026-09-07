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
