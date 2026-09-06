# Reptilian HyperIndex runtime

This fork tracks Envio HyperIndex and publishes the Reptilian runtime as
`@reptilianhq/envio`. The `3.6.1-reptilian.N` release line is based on upstream
`v3.6.1` and publishes matching native packages as
`@reptilianhq/envio-{platform}-{arch}`. The runtime and native packages must
always use the same fork version because the fork extends the N-API boundary.

The fork retains the application-specific runtime behavior that upstream does
not provide:

- exact coalescing of compatible address-bound partitions across contract types;
- configurable per-partition and per-chain request concurrency;
- optional fixed-block historical source request pacing with finite-boundary
  handling;
- optional `ENVIO_HYPERSYNC_HEAD_POLL_BLOCKS` coalescing after realtime is
  reached, without delaying historical backfill or RPC realtime fetching; and
- low-cardinality source, pipeline, PostgreSQL, and phase telemetry hooks;
- a client-filter address threshold derived from upstream's fixed concurrency,
  so `ENVIO_MAX_CHAIN_CONCURRENCY` never moves the filtering switch; and
- bounded source-query retries (`ENVIO_SOURCE_QUERY_MAX_RETRIES`,
  `ENVIO_SOURCE_QUERY_RETRY_TIMEOUT_MILLIS`) that release the chain slot and
  re-plan the range instead of holding the slot until the query resolves.

Publish only from a `v3.6.1-reptilian.N` tag after Build & Verify succeeds for
the tagged commit. The publish workflow builds all supported native platforms,
publishes them first, and then publishes the runtime with exact-version optional
dependencies. The npm package is consumed through an alias so application imports
and the CLI remain named `envio`.
