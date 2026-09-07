open Vitest

// The host installs its telemetry under Symbol.for names on globalThis. The
// counters must see a hook installed after envio was imported: in ESM the
// import graph is evaluated first, so a load-time lookup would have pinned
// the no-op fallback for every host that is not a --import preload.

let install: (string, 'hook) => unit = %raw(`(name, hook) => {
  globalThis[Symbol.for(name)] = hook;
}`)
let uninstall: string => unit = %raw(`name => {
  delete globalThis[Symbol.for(name)];
}`)

// Installs for the body only, so a failing assertion cannot leak a hook into
// the next case.
let withHook = (name, hook, body) => {
  install(name, hook)
  let outcome = try Ok(body()) catch {
  | exn => Error(exn)
  }
  uninstall(name)
  switch outcome {
  | Ok(value) => value
  | Error(exn) => throw(exn)
  }
}

let snapshot: RuntimeHooks.fetchSchedulerSnapshot = {
  knownHeight: 1,
  bufferBlock: 0,
  bufferSize: 0,
  bufferReadyCount: 0,
  pendingBudget: 0,
  availableConcurrency: 1,
  candidateQueries: 0,
  acceptedQueries: 0,
  decision: "nothing_to_query",
  partitions: [],
}

// Every counter, by the symbol the host installs and one call through it.
let counters: array<(string, unit => unit)> = [
  ("dlmm.chain-indexer.source-rate-limit", () => RuntimeHooks.recordSourceRateLimit(2, 500)),
  ("dlmm.chain-indexer.source-request-event", () => RuntimeHooks.recordSourceRequest("start", "0")),
  ("dlmm.chain-indexer.source-page-result", () => RuntimeHooks.recordSourcePage(100, 60)),
  ("dlmm.chain-indexer.source-range-request", () => RuntimeHooks.recordSourceRange("adaptive", 9)),
  ("dlmm.chain-indexer.source-query-exhausted", () => RuntimeHooks.recordSourceQueryExhausted("0")),
  ("dlmm.chain-indexer.fetch-scheduler-snapshot", () => RuntimeHooks.recordFetchScheduler(() => snapshot)),
  ("dlmm.chain-indexer.pipeline-event", () => RuntimeHooks.recordPipeline("queued", {queueBatches: 1, queueItems: 2})),
  ("dlmm.chain-indexer.pool-config", () => RuntimeHooks.recordPoolConfig(8)),
]

describe("RuntimeHooks", () => {
  it("resolves every counter hook installed after the module loaded, once", t => {
    let fired = counters->Array.map(((name, call)) => {
      let count = ref(0)
      // Variadic on purpose: each counter has its own arity.
      let hook = %raw(`(counter) => (...args) => { counter.contents += 1; }`)(count)
      withHook(name, hook, call)
      // Uninstalled again: back to the no-op, not a stale binding.
      call()
      (name, count.contents)
    })
    t.expect(fired).toEqual(counters->Array.map(((name, _)) => (name, 1)))
  })

  it("passes every range reason as the string the host validates", t => {
    let seen = []
    withHook("dlmm.chain-indexer.source-range-request", (reason, blocks) =>
      seen->Array.push((reason, blocks))->ignore
    , () => {
      [FetchState.FullRange, MergeBoundary, EndBoundary, Adaptive, GapFill]->Array.forEachWithIndex(
        (reason, idx) => RuntimeHooks.recordSourceRange((reason :> string), idx),
      )
    })
    t.expect(seen).toEqual([
      ("full_range", 0),
      ("merge_boundary", 1),
      ("end_boundary", 2),
      ("adaptive", 3),
      ("gap_fill", 4),
    ])
  })

  it("drops a counter hook that throws instead of failing the observed path", t => {
    let attempts = ref(0)
    let outcome = withHook("dlmm.chain-indexer.pipeline-event", (_, _) => {
      attempts := attempts.contents + 1
      JsError.throwWithMessage("Indexer pipeline queue tracking mismatch")
    }, () => {
      RuntimeHooks.recordPipeline("write_error", {queueBatches: 0, queueItems: 0})
      "continued"
    })
    t.expect((outcome, attempts.contents)).toEqual(("continued", 1))
  })

  Async.it("still traces through the fallback with nothing installed", async t => {
    let ran = ref(false)
    let value = await RuntimeHooks.tracePhase("phase", async () => {
      ran := true
      42
    })
    t.expect((ran.contents, value)).toEqual((true, 42))
  })
})
