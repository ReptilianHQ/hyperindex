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

Arc mainnet is the chain the Argus launcher deploys to, which is why 3.12.0 is
the right base to land on.

**But 3.12.0 is not a prerequisite for indexing Arc, and this document
previously claimed it was.** Measured on stock runtimes:

| runtime | chain 5042 config | `envio codegen` |
| --- | --- | --- |
| 3.12.0 | no endpoint given | **exit 0** — auto-resolved |
| 3.12.0 | bogus chain id (control) | exit 1 — demands explicit endpoint |
| 3.11.0 | no endpoint given | exit 1 — error text offers the manual override |
| 3.9.0 | `hypersync_config.url: https://5042.hypersync.xyz` | **exit 0** |

HyperSync serves Arc today (mainnet height ~21.2M, testnet ~62.5M, both
HTTP 200). So what 3.12.0 contributes is **auto-discovery, not capability**:
chain 5042 can be indexed on the fork's current 3.9.0 base with a three-line
explicit endpoint. The bogus-chain control matters — it shows the 3.12.0 pass is
a real resolution rather than a config parser that ignores unknown ids.

Consequence: Argus position indexing is **not** blocked on this rebase. The
rebase stands on its own merits; it should not be cited as a gate for that work.

(Verified against stock `envio@3.9.0`. The fork is a patch series on that base
and removes no config keys, so this should carry to
`@reptilianhq/envio@3.9.0-reptilian.7` — worth one confirmation run against the
scoped package before anyone relies on it.)

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

Carried forward. #283's acceptance criteria require that *every retained patch
has a current chain-indexer consumer or measured benefit*. The consumer audit
below was run against chain-indexer at `30b41e7` and the host repo, so several
rows are now VERIFIED rather than carried on the ticket's word.

**Consumer audit results**

- **Telemetry hooks — VERIFIED, strong consumer.** The shipped Grafana board
  graphs **37** `chain_indexer_*` series fed by the fork's `RuntimeHooks`,
  including `chain_indexer_source_max_partition_concurrency_config`,
  `..._max_chain_concurrency_config`, and `..._blocks_per_request_config`.
  Shipping path confirmed: `orchestration/Dockerfile.grafana` does
  `COPY orchestration/grafana/dashboards /etc/grafana/dashboards`, and the
  Grafana service is defined in `render.reptilian-ops.yaml`. Note chain-indexer
  retired *its* copy of this board in #290 as unshipped — the host's copy is the
  live one, so the retirement does not weaken this evidence.
- **`includeTimestamp` (#19) — VERIFIED, and upstream does not subsume it.**
  Consumer is `src/handlers/rolling.ts:178,189`. Worth recording why the obvious
  replacement fails: 3.12.0 adds `envio_progress_block_time_seconds` /
  `_meta.progressBlockTime`, which looks like a drop-in for "avoid timestamp RPC
  calls." It is not. Upstream's value is an *observability* readout of the block
  each chain has progressed to, populated best-effort during realtime sync. The
  heartbeat needs `block.timestamp` *inside* `onBlock` execution to drive
  `observeDeploymentIdentity` and `advanceRollingWindow` entity writes on an
  exact per-block clock. A metric observed outside handler execution cannot
  carry that. Retain the patch.
- **Concurrency and pacing knobs — VERIFIED.** `ENVIO_MAX_PARTITION_CONCURRENCY`,
  `ENVIO_MAX_CHAIN_CONCURRENCY`, `ENVIO_SOURCE_BLOCKS_PER_REQUEST`,
  `ENVIO_PROCESSING_BATCH_SIZE`, and `ENVIO_HYPERSYNC_HEAD_POLL_BLOCKS` all have
  live references in chain-indexer, and the first three export their configured
  values as graphed metrics.
- **Retry knobs — unexercised tuning surface.** `ENVIO_SOURCE_QUERY_MAX_RETRIES`
  appears only in a runbook line and a telemetry comment;
  `ENVIO_SOURCE_QUERY_RETRY_TIMEOUT_MILLIS` has **zero** references anywhere in
  chain-indexer or the host. This does not by itself condemn the bounded-retry
  patch — the behavior presumably runs on defaults and the knobs only tune it —
  but confirm the defaults exist on the new base, and consider dropping the two
  environment variables as dead configuration surface rather than porting them.

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

### Prove or remove — DECIDED

All four items were settled by the repo owner on 2026-09-16. Decisions and their
rationale are below; the table that follows is retained for the evidence behind
each.

| Item | Decision | Basis |
| --- | --- | --- |
| Sorted entity writes (`41c2159c6`) | **Drop** | Benchmarked. Buffer-read win reproduces, throughput does not; most expensive merge in the series. Recoverable from `main`. |
| Cross-contract coalescing | **Keep, without a benchmark** | Upstream implements no equivalent, so dropping loses the behavior outright; low merge cost; the workload genuinely produces the partitions it targets. Accepted tradeoff: our most invasive patch rides along unproven. |
| `ENVIO_HYPERSYNC_HEAD_POLL_BLOCKS` (`0d1af4a0a`) | **Keep, re-tune later** | Live consumers today; self-contained opt-in knob. Revisit the traffic-vs-lag setting once running on 3.12 alongside upstream's height-stream recovery. |
| Telemetry duplicating upstream | **Prune the duplicates** | Drop generic fetch/storage stall instruments upstream now covers; keep scheduler-specific visibility. **Must be driven panel-by-panel from the shipped dashboard's metric list** — 37 live series depend on these hooks, and a blind trim blanks panels or breaks alerts. |
| Simulated `blockLag: 0` | **Drop** | Unless something is found to need it during the port. |
| `ENVIO_SOURCE_QUERY_MAX_RETRIES`, `ENVIO_SOURCE_QUERY_RETRY_TIMEOUT_MILLIS` | **Drop the knobs** | Dead config surface — one has zero references anywhere, the other appears only in a runbook line and a comment. **The bounded-retry behavior is retained**; only the tuning dials go, so confirm the defaults exist on the new base. |

**Dependency created by keeping coalescing:** `a00245a3a` (#22, mixed-partition
coverage during client filtering) and `MixedPartitionCoverage_hegel_test` must
come with it. That patch is what prevents the silent launch-history loss the
original coalescing bug caused. Keeping coalescing without it reintroduces a
known data-loss defect.

The evidence behind each item:

| Item | Where | Status |
| --- | --- | --- |
| Cross-contract address-bound partition coalescing | `FetchState.OptimizedPartitions.coalesceAddressBoundPartitions` | NEEDS-BENCHMARK. Most invasive fork behavior; its former metadata bug caused silent launch-history loss. **Correction: the "upstream already does this" argument does not hold — see below.** Low rebase cost (see churn table) but that is not a reason to keep it. If removed, `a00245a3a` and the mixed-partition test apparatus go with it. **Not hypothetical for this workload:** `chain-indexer/config.yaml` declares 7 contract types (Launchpad, GraduationPool, FeeController, LBFactory, LBPair, LaunchToken, Router) with no static addresses, all registered dynamically via `indexer.contractRegister` (`src/handlers/registrations.ts`). Many address-bound partitions across distinct contract types is exactly the shape coalescing acts on, so benchmark it rather than dropping it blind. |
| Sorted entity writes | `41c2159c6` (#20), `PgStorage.res` | **BENCHMARKED — recommend remove.** See the section below. |
| `ENVIO_HYPERSYNC_HEAD_POLL_BLOCKS` | `0d1af4a0a` | NEEDS-BENCHMARK. Re-evaluate the traffic-vs-latency trade now that upstream 3.10 ships height-stream recovery. Currently permits bounded realtime lag by design. |
| Telemetry duplicating upstream metrics | `RuntimeHooks` surface | Scope narrowed by the consumer audit. 37 hook-fed series are graphed on the shipped board, so the surface is broadly live; the prune should be driven by that board's metric list rather than by reading the hook definitions. 3.12.0's `envio_progress_block_time_seconds` does **not** subsume the heartbeat (see Retain), and it is not novel for chain-indexer's external observer either — `scripts/indexer-observer.mjs:284,290` already derives `head` from an independent `getRpcHead` call, so its `blockLag` never depended on the source's claimed height. |
| Simulated `blockLag: 0` | `SimulateItems.patchConfig` | TICKET. Keep only if a focused test shows behavior not expressible in test config. |

### Remove

| Patch | Reason |
| --- | --- |
| `d8c106dcc` — HyperSync chain 988 | **VERIFIED redundant.** Upstream `v3.12.0` carries `StablesKinshipGrass = 988` at `chain_helpers.rs:395`. The fork's own code anticipated this with a "Fork divergence: chain 988 is not in upstream's enum. If upstream ever…" comment at line 677. chain-indexer deploys only Robinhood 4663/46630 regardless. |
| Prior-generation rebase tails | Superseded; see note 1 above |
| Fork-only fixtures/scaffolding for removed patches | Follows whatever the prove-or-remove pass drops |

## Correction: upstream never implemented coalescing, and its client filtering is not new

#283 motivates reconsidering coalescing partly on the grounds that "upstream 3.11
already includes large-scale client-side address filtering." That premise does
not survive checking.

**VERIFIED:**

- `coalesceAddressBoundPartitions` exists in **no** upstream release — absent from
  `v3.9.0`, `v3.11.0`, and `v3.12.0`. Upstream has never implemented this
  behavior in any form. (The `OptimizedPartitions` *module* is upstream's and
  predates the fork — `FetchState.res:222` in `v3.12.0` vs `:233` on `main` — so
  the shared name is not shared functionality.)
- Client-side address filtering is **not a new upstream capability**.
  `clientFilter` references in `FetchState.res` are identical across releases —
  48 in `v3.9.0`, 48 in `v3.11.0`, 48 in `v3.12.0` — and the
  `clientFilterAddressThreshold` env knob is present in all three. It was already
  in `v3.9.0`, which is the base this fork was built on.
- Upstream's entire `FetchState.res` change from `3.9.0` to `3.12.0` is the
  `isSameLog` helper (deduping one log routed to two registrations), 14 added
  lines. Nothing touching partitions or address filtering.

Consequence: the fork's coalescing was written **on top of** upstream client
filtering, not as a substitute for a capability upstream lacked at the time.
Moving to 3.12.0 therefore supplies no new upstream mechanism that would displace
it. The keep/remove call rests entirely on the benchmark — "upstream caught up"
is not available as a reason.

This also means the fork's own threshold comment is consistent: it says the
threshold is "Derived from upstream's constant," which only makes sense if
upstream already owned the client-filter switch.

## Evidence: sorted entity writes (`41c2159c6`, #20)

Ran `packages/envio/benchmarks/ordered-writes.mjs` — 4 rounds × 3 modes, 12
runs, mode order alternating per round. Every run passed the benchmark's own
row-count and block-sum parity check.

Environment: local throwaway PostgreSQL cluster, `shared_buffers = 32MB`,
`work_mem = 4MB`, `lc_collate = en_US.UTF-8`, `SEED_ROWS = 500000`,
`BATCH_SIZE = 16000`. Collation matters for this patch (client sorting uses
JavaScript comparison), and `en_US.UTF-8` is the likely production default —
chain-indexer pins no collation in its schema, so it inherits the server's.

Means across 4 runs per mode:

| mode | shared read blocks | temp written blocks | execution ms | elapsed ms |
| --- | --- | --- | --- | --- |
| `arrival` (no sorting) | 36,888 | 0 | 1,161.7 | 1,226.0 |
| `sql` (`ORDER BY id`) | 28,624 | 1,564 | 1,482.5 | 1,538.7 |
| `client` (the patch) | 28,623 | 0 | 1,129.2 | 1,209.2 |

**The buffer-read claim reproduces.** Client sorting cuts shared read blocks
22.4% versus arrival order, matching `REPTILIAN.md`'s ~23% almost exactly, on a
3.12-era workload rather than the original one.

**The throughput claim still does not.** Client is only **1.4%** faster than
arrival on elapsed time, and the per-run spreads overlap almost completely —
arrival `[1187, 1254, 1260, 1204]` vs client `[1139, 1214, 1223, 1261]`. Client's
worst run is slower than arrival's worst run. That is noise, not a throughput
improvement.

Client sorting does cleanly beat the `sql` alternative: identical buffer
locality (28,623 vs 28,624 blocks) with **zero** temp spill against SQL's 1,564
blocks, and ~350 ms less execution time. But the keep/remove comparison is
client versus *arrival* — versus not carrying the patch at all — not client
versus an alternative nobody proposed adopting.

**Recommendation: remove.** #283's bar is explicit — retain "only with a
material write-stall or throughput improvement." Less buffer I/O is real and
reproducible, but it is not that bar, and this is the most expensive merge in
the series (`PgStorage.res` is 289+/165- upstream). Removing it buys the single
largest reduction in rebase risk for no demonstrated performance loss.

Caveats, stated so the decision can be revisited honestly:

- This is a single-table microbenchmark measuring `EXPLAIN ANALYZE` execution on
  a laptop, not sustained production write stalls under concurrent load. #283
  itself asks for write-stall and throughput comparison "after any deployment."
- 32 MiB `shared_buffers` is deliberate cache pressure. Production buffers are
  far larger, which would tend to *shrink* the buffer-read advantage further,
  not grow it — so this setting is favorable to the patch, and it still did not
  clear the bar.
- If production write-stall telemetry later shows a real problem, the patch is
  recoverable from `main` and the harness is unchanged.

## Explicitly out of scope

Per #283: no ClickHouse migration, no schema `String` → `Bytes` conversion, and
no runtime-only transition onto an existing populated schema. Compatibility
policy allows fork-suffix upgrades on a shared upstream base, not `3.9 → 3.12`;
this base change lands with the next required fresh-schema replay or under a
separately approved compatibility plan.

Entity-level invalidation, selective projection rebuilds, and checkpoint seeding
remain [chain-indexer#247](https://github.com/ReptilianHQ/chain-indexer/issues/247).

## Port status

The retained series is applied on this branch. The fork's net delta was applied
against the 3.12.0 base with a 3-way merge and the resulting conflicts resolved
individually, rather than merging the old fork branch wholesale.

**Conflicts resolved: 17.** Thirteen in the ReScript runtime, two in the Rust
CLI, two in the ReScript tests. The consistent shape was *fork wrapper, upstream
body*: the fork's telemetry wraps call sites upstream reworked after 3.9.0, so
the hooks are preserved while the calls inside them are upstream's —
`Batch.make` (now `sequence`/`history`/`frontier`, no
`isInReorgThreshold`/`checkpointIdBeforeBatch`), `writeBatch` (no
`isInReorgThreshold`), `ensureQueryIndexes` (now `~entityConfig`/`~scope`),
`committedCheckpointIdFor(~scope)`, `initEffectOutputFromDb` (now `~chainId`),
and the progressed-chain record (now carries `progressBlockTime`).

**One gap required porting, not conflict resolution.** Upstream extracted source
construction into `ChainSources.make` after 3.9.0, and neither it nor
`EvmChain.makeSources` accepts `onBlockRegistrations`. Patch #19 needs those to
reach the HyperSync source so a handler opting into `includeTimestamp` gets block
headers requested. `EvmChain.makeSources` defaults the parameter to `[]`, so the
omission **compiles and fails silently** — the rolling heartbeat would simply
never receive timestamps. `ChainSources.make` now takes and forwards it, and
`REPTILIAN.md` records it as a fork requirement on this base.

**Two defects the builds caught**, neither visible to the runtime compile:

- an upstream-added `SourceManager_test` case omitted `rangeReason`, which the
  fork's query record makes required;
- `mock_hypersync_server.rs` called `request.body.bytes()`. `body` was a `String`
  on the 3.9.0 base and is a `Vec<u8>` on 3.12.0.

**Verification:** `rescript build` clean for the runtime (148 modules) and the
test package (212 modules); `cargo check --all-targets` clean. The vitest suite
requires PostgreSQL on port 5433 (`postgres`/`testing`, database `envio-dev`).

Release identity is `3.12.0-reptilian.N`. Both publish gates were updated — the
tag trigger and the version-validation regex in `publish.yml`, which pinned
`^3\.9\.0-reptilian\.` and would have rejected the new line on its own.

## Next steps

1. Get the vitest suite green, `MixedPartitionCoverage_hegel_test` above all —
   keeping coalescing makes that test the guard against the silent
   launch-history loss its original bug caused.
2. Prune telemetry that duplicates upstream, driven panel-by-panel from the
   shipped Grafana board's metric list rather than from the hook definitions.
3. Benchmark coalescing against stock 3.12 if its keep decision is ever revisited.
4. Only then bump `chain-indexer`'s `envio` alias pin — and note the compatibility
   policy: this is a `3.9 -> 3.12` base change, so it lands with a fresh-schema
   replay, not as a runtime-only swap on a populated schema.
