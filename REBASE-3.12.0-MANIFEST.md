# Rebase manifest: `3.9.0-reptilian.7` → `3.12.0-reptilian.0`

Working document for [chain-indexer#283](https://github.com/ReptilianHQ/chain-indexer/issues/283).
Branch `rebase/3.12.0`, based on upstream tag `v3.12.0` (`6f7763df9`).

Each retained patch is applied individually onto the upstream tag, not merged
wholesale from the old fork line. This file records the decision for every
patch and the evidence behind it.

Evidence markers used below:

- **VERIFIED** — confirmed against code in this repo during this pass.
- **TICKET** — carried from #283's stated position, not independently re-verified.
- **NEEDS-BENCHMARK** — decision blocked on the evidence bundle #283 requires.

## Why 3.12.0 and not 3.11.0

#283 was written against upstream `v3.11.0`. Retarget to `v3.12.0`.

**VERIFIED:** `v3.12.0` adds Arc to the CLI chain enum —
`Arc = 5042` and `ArcTestnet = 5042002` in
`packages/cli/src/config_parsing/chain_helpers.rs:54,57`, with
`arc_mainnet_is_supported_by_hypersync` coverage at line 677 and Arc joined to
`UNLISTED_BUT_SERVED` (commit `6f7763df9`, PR #1645). `v3.11.0` contains no Arc
entry at all.

Arc mainnet is the chain the Argus launcher deploys to, so indexed Argus
positions require a runtime at `>= 3.12.0`. This makes the rebase a hard
dependency for that work rather than routine fork hygiene.

Note that the published 3.12.0 release notes do not mention Arc in their
headline sections (they cover per-chain processes, the progress-block-time
metric, and Solana changes). The Arc support is in the tag but uncalled-out;
read the chain enum, not the notes.

Nothing in 3.12.0 conflicts with #283's scope — it is a superset of 3.11.0 for
these purposes.

## Conflict surface

Measured with `git diff --name-only` across both ranges:

- fork touches **84** files (`v3.9.0..main`)
- upstream touches **315** files (`v3.9.0..v3.12.0`)
- **46 files are in both** — a ~55% overlap on the fork's footprint

The overlap covers exactly the modules #283 flags for deliberate resolution:
`FetchState.res`, `SourceManager.res`, `PgStorage.res`, `LoadLayer.res`,
`Config.res`, and the rollback/chain-state files.

Per-file churn (upstream vs fork, `v3.9.0` baseline):

| File | Upstream 3.9→3.12 | Fork | Rebase risk |
| --- | --- | --- | --- |
| `FetchState.res` | 14+/0- | 433+/119- | **Low** — fork's largest patch, upstream barely moved |
| `SourceManager.res` | 248+/235- | 110+/7- | **High** — upstream substantially rewrote it |
| `PgStorage.res` | 289+/165- | 98+/74- | **High** — upstream substantially rewrote it |
| `LoadLayer.res` | 11+/4- | 65+/48- | Low |
| `Config.res` | 164+/80- | 20+/4- | Moderate |

**This inverts the intuition in #283.** The ticket treats cross-contract
coalescing as the scariest carry-forward because it is the most invasive fork
behavior — but it lives in `FetchState.res`, which upstream hardly touched, so
it rebases comparatively cleanly. Conversely, sorted entity writes
(`PgStorage.res`) is simultaneously the patch with the **weakest evidence** and
the **highest conflict cost**. Resolve that one first: if the benchmark does not
clear it, dropping it removes the single most expensive merge in the series.

## Patch series

`v3.9.0..main` is 77 commits, 56 excluding merges. The effective set is much
smaller than either number, for two reasons:

1. **Prior-generation rebase tails are superseded — do not replay.** The bottom
   of the series is the 3.5.0 and 3.6.1 forward-port generations:
   `6c3cd3be9`, `2398407d6`, `a4a1d6c49`, `79d660dc6`, `bfea28bf4`,
   `026eb5f06`, `227e2dd85`, `54e18a5cd`, `e76c4750e`. Their surviving behavior
   is already folded into the 3.9.0 port commit. Replaying them would reapply
   stale intermediate states. (Note `79d660dc6`/`54e18a5cd` are duplicate
   "resume across version-only upgrades" commits across generations — the
   behavior is retained, but via the current implementation, not these.)
2. **Docs/CI commits are re-derived, not cherry-picked** — `0a8c204a3`,
   `484f7b4e6`, `9a4b1c184`, `d494351fb`, `66194be90`, `197db9f21`, and the
   `review:`/`test:` follow-up commits. Their content belongs in the new line's
   own docs and workflows.

### Retain

Carried forward. Each has a named runtime consumer in `REPTILIAN.md` or an
environment variable chain-indexer actually sets.

| Patch | Behavior | Evidence |
| --- | --- | --- |
| `53cb79df9` | Umbrella port: scheduler, pacing, telemetry, retry budget onto v3.9.0 | TICKET — the base of the retained series |
| `2a31bb22f` (#10) | Partition-fair fetch candidate scheduling | TICKET |
| `72ed725fa` (#9) | Fetch scheduler telemetry | TICKET |
| `43a5187fa`, `351c0449b`, `a3a03f1fc`, `c0bde8190` | Gap-fill admission, soft-target starvation, gap borrowing, target containment | TICKET |
| `89d0f9627` | Client-filter threshold decoupled from `ENVIO_MAX_CHAIN_CONCURRENCY`; bounded query retries; scheduler liveness | TICKET |
| `6c8c48888` | Cap `executeQuery`/`getBlockHashes` retry loops | TICKET |
| `ddd7d9467` | Return buffer reservation on release | TICKET |
| `1f41405e9` | Scope fixed ranges to backfill (`ENVIO_SOURCE_BLOCKS_PER_REQUEST`, historical only) | TICKET |
| `3e4267b1f` (#19) | Opt-in HyperSync source timestamps for block handlers — powers the rolling heartbeat without timestamp RPCs | TICKET |
| `66a94a09f` (#23) | Checkpoint-safe `ENVIO_PROCESSING_BATCH_SIZE` override | TICKET |
| `a00245a3a` (#22) | Mixed-partition coverage safety during client filtering | TICKET — retain **only as long as coalescing survives**; see below |
| `b830f08d6` (#21), `a00cd7dd6`, `d27665b41`, `ef0197257` | Entity read/initialize timing split; per-call hook resolution; query-range reason variant | TICKET |
| `04e8bac87` | Publish the line as `@reptilianhq/envio` with exact-version native packages | Required for packaging |

Resume compatibility (`Config.diffPaths` ignoring the `-reptilian.N` suffix) is
retained as behavior, reimplemented on the new base rather than cherry-picked.

### Prove or remove

Blocked on #283's evidence bundle. Default to **remove** if the benchmark does
not show a material benefit.

| Item | Where | Status |
| --- | --- | --- |
| Cross-contract address-bound partition coalescing | `FetchState.OptimizedPartitions.coalesceAddressBoundPartitions` | NEEDS-BENCHMARK. Most invasive fork behavior; its former metadata bug caused silent launch-history loss. Upstream 3.11+ already does large-scale client-side address filtering. Low rebase cost (see churn table) but that is not a reason to keep it. If removed, `a00245a3a` and the mixed-partition test apparatus go with it. |
| Sorted entity writes | `41c2159c6` (#20), `PgStorage.res` | NEEDS-BENCHMARK. Prior local run showed ~23% fewer shared-buffer reads at 32 MiB shared_buffers, with no proven sustained throughput gain. **Highest conflict cost in the series.** Harness already exists: `packages/envio/benchmarks/ordered-writes.mjs` (VERIFIED present). Decide this one first. |
| `ENVIO_HYPERSYNC_HEAD_POLL_BLOCKS` | `0d1af4a0a` | NEEDS-BENCHMARK. Re-evaluate the traffic-vs-latency trade now that upstream 3.10 ships height-stream recovery. Currently permits bounded realtime lag by design. |
| Telemetry duplicating upstream metrics | `RuntimeHooks` surface | NEEDS-BENCHMARK. Keep scheduler-specific visibility; drop generic fetch/storage stall instruments that upstream now covers. 3.12.0's new `envio_progress_block_time_seconds` may subsume part of the heartbeat story. |
| Simulated `blockLag: 0` | `SimulateItems.patchConfig` | TICKET. Keep only if a focused test shows behavior not expressible in test config. |

### Remove

| Patch | Reason |
| --- | --- |
| `d8c106dcc` — HyperSync chain 988 | **VERIFIED redundant.** Upstream `v3.12.0` carries `StablesKinshipGrass = 988` at `chain_helpers.rs:395`. The fork's own code anticipated this with a "Fork divergence: chain 988 is not in upstream's enum. If upstream ever…" comment at line 677. chain-indexer deploys only Robinhood 4663/46630 regardless. |
| Prior-generation rebase tails | Superseded; see note 1 above |
| Fork-only fixtures/scaffolding for removed patches | Follows whatever the prove-or-remove pass drops |

## Explicitly out of scope

Per #283: no ClickHouse migration, no schema `String` → `Bytes` conversion, and
no runtime-only transition onto an existing populated schema. Compatibility
policy allows fork-suffix upgrades on a shared upstream base, not `3.9 → 3.12`;
this base change lands with the next required fresh-schema replay or under a
separately approved compatibility plan.

Entity-level invalidation, selective projection rebuilds, and checkpoint seeding
remain [chain-indexer#247](https://github.com/ReptilianHQ/chain-indexer/issues/247).

## Next steps

1. Run `packages/envio/benchmarks/ordered-writes.mjs` to settle sorted writes —
   cheapest decision, highest conflict payoff.
2. Benchmark coalescing against stock 3.12 on a representative replay.
3. Apply the retained series individually onto `rebase/3.12.0`.
4. Only then bump `chain-indexer`'s `envio` alias pin.
