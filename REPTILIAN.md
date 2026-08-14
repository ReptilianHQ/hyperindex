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
  handling; realtime fetching retains Envio's native partial-range behavior;
  and
- low-cardinality source, pipeline, PostgreSQL, and phase telemetry hooks.

Publish only from a `v3.6.1-reptilian.N` tag after Build & Verify succeeds for
the tagged commit. The publish workflow builds all supported native platforms,
publishes them first, and then publishes the runtime with exact-version optional
dependencies. The npm package is consumed through an alias so application imports
and the CLI remain named `envio`.
