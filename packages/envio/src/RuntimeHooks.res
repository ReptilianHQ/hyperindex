type globalObject
type symbol

@val external globalObject: globalObject = "globalThis"
@val @scope("Symbol") external symbolFor: string => symbol = "for"
@get_index external getProperty: (globalObject, symbol) => Nullable.t<'a> = ""

let get = (name, fallback) =>
  switch getProperty(globalObject, symbolFor(name))->Nullable.toOption {
  | Some(hook) => hook
  | None => fallback
  }

let recordSourceRateLimit: (int, int) => unit = get("dlmm.chain-indexer.source-rate-limit", (
  _,
  _,
) => ())

let recordSourceRequest: (string, string) => unit = get("dlmm.chain-indexer.source-request-event", (
  _,
  _,
) => ())

let recordSourcePage: (int, int) => unit = get("dlmm.chain-indexer.source-page-result", (_, _) =>
  ()
)

let recordSourceRange: (string, int) => unit = get("dlmm.chain-indexer.source-range-request", (
  _,
  _,
) => ())

type pipelineSnapshot = {queueBatches: int, queueItems: int}

let recordPipeline: (string, pipelineSnapshot) => unit = get("dlmm.chain-indexer.pipeline-event", (
  _,
  _,
) => ())

let recordPoolConfig: int => unit = get("dlmm.chain-indexer.pool-config", _ => ())

let tracePhase = (phase, callback, ~attributes: dict<int>=Dict.make()) => {
  let hook: (string, unit => 'a, dict<int>) => 'a = get("dlmm.chain-indexer.trace-phase", (
    _,
    callback,
    _,
  ) => callback())
  hook(phase, callback, attributes)
}

let traceStorage = (operation, callback) => {
  let hook: (string, unit => 'a) => 'a = get("dlmm.chain-indexer.trace-storage", (_, callback) =>
    callback()
  )
  hook(operation, callback)
}

let tracePoolAcquisition = callback => {
  let hook: ((unit => unit) => promise<'a>) => promise<
    'a,
  > = get("dlmm.chain-indexer.trace-pool-acquisition", callback => callback(() => ()))
  hook(callback)
}
