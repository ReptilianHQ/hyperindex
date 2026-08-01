# Reptilian HyperIndex runtime

This fork tracks Envio HyperIndex and publishes the Reptilian runtime as
`@reptilianhq/envio`. Release `3.5.0-reptilian.1` is based on upstream
`v3.5.0` and reuses the official `envio-*` native packages at version `3.5.0`.

The fork retains the application-specific runtime behavior that upstream does
not provide:

- exact coalescing of compatible address-bound partitions across contract types;
- configurable per-partition and per-chain request concurrency;
- optional fixed-block source request pacing with finite-boundary handling; and
- low-cardinality source, pipeline, PostgreSQL, and phase telemetry hooks.

Publish only from a `v3.5.0-reptilian.N` tag after Build & Verify succeeds for
the tagged commit. The npm package is consumed through an alias so application
imports and the CLI remain named `envio`.
