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

describe("RuntimeHooks", () => {
  it("resolves a counter hook installed after the module loaded", t => {
    let seen = []
    install("dlmm.chain-indexer.source-rate-limit", (retry, waitMs) =>
      seen->Array.push((retry, waitMs))->ignore
    )
    RuntimeHooks.recordSourceRateLimit(2, 500)
    uninstall("dlmm.chain-indexer.source-rate-limit")
    // Uninstalled again: back to the no-op, not a stale binding.
    RuntimeHooks.recordSourceRateLimit(3, 700)
    t.expect(seen).toEqual([(2, 500)])
  })

  it("passes the source range reason as the string the host validates", t => {
    let seen = []
    install("dlmm.chain-indexer.source-range-request", (reason, blocks) =>
      seen->Array.push((reason, blocks))->ignore
    )
    RuntimeHooks.recordSourceRange((FetchState.GapFill :> string), 12)
    RuntimeHooks.recordSourceRange((FetchState.MergeBoundary :> string), 3)
    uninstall("dlmm.chain-indexer.source-range-request")
    t.expect(seen).toEqual([("gap_fill", 12), ("merge_boundary", 3)])
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
