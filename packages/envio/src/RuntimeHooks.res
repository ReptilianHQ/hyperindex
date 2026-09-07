type globalObject
type symbol

@val external globalObject: globalObject = "globalThis"
@val @scope("Symbol") external symbolFor: string => symbol = "for"
@get_index external getProperty: (globalObject, symbol) => Nullable.t<'a> = ""

// Resolved on every call, never at module load: the host installs its hooks
// on globalThis under Symbol.for(name), and in ESM an import is evaluated
// before the importing module's own statements, so a load-time lookup would
// pin the fallback for any host that installs after importing envio. A
// property read per event is nothing next to the source request or batch it
// describes.
let get = (name, fallback) =>
  switch getProperty(globalObject, symbolFor(name))->Nullable.toOption {
  | Some(hook) => hook
  | None => fallback
  }

let noop2 = (_, _) => ()
let noop1 = _ => ()

// Observation must never fail the observed path: a host hook that throws
// (the host validates event pairing and rejects unknown reasons) is dropped
// here, so no call site has to remember to guard it.
let record1 = (name, arg) =>
  try get(name, noop1)(arg) catch {
  | _ => ()
  }
let record2 = (name, a, b) =>
  try get(name, noop2)(a, b) catch {
  | _ => ()
  }

let recordSourceRateLimit = (retry: int, waitMs: int): unit =>
  record2("dlmm.chain-indexer.source-rate-limit", retry, waitMs)

let recordSourceRequest = (event: string, partitionId: string): unit =>
  record2("dlmm.chain-indexer.source-request-event", event, partitionId)

let recordSourcePage = (requestedBlocks: int, fetchedBlocks: int): unit =>
  record2("dlmm.chain-indexer.source-page-result", requestedBlocks, fetchedBlocks)

let recordSourceRange = (reason: string, blocks: int): unit =>
  record2("dlmm.chain-indexer.source-range-request", reason, blocks)

// One query gave up its retry budget and was released for re-planning. A
// counter on this is how a permanently degraded source shows up: the indexer
// keeps going, so nothing else does.
let recordSourceQueryExhausted = (partitionId: string): unit =>
  record1("dlmm.chain-indexer.source-query-exhausted", partitionId)

type fetchSchedulerPartitionSnapshot = {
  partitionId: string,
  frontierBlock: int,
  pendingQueries: int,
  inFlightQueries: int,
  fetchedPendingQueries: int,
  nextPendingFromBlock: option<int>,
}

type fetchSchedulerSnapshot = {
  knownHeight: int,
  bufferBlock: int,
  bufferSize: int,
  bufferReadyCount: int,
  pendingBudget: int,
  availableConcurrency: int,
  candidateQueries: int,
  acceptedQueries: int,
  decision: string,
  partitions: array<fetchSchedulerPartitionSnapshot>,
}

let recordFetchScheduler = (snapshot: unit => fetchSchedulerSnapshot): unit =>
  record1("dlmm.chain-indexer.fetch-scheduler-snapshot", snapshot)

type pipelineSnapshot = {queueBatches: int, queueItems: int}

let recordPipeline = (event: string, snapshot: pipelineSnapshot): unit =>
  record2("dlmm.chain-indexer.pipeline-event", event, snapshot)

let recordPoolConfig = (maxConnections: int): unit =>
  record1("dlmm.chain-indexer.pool-config", maxConnections)

// The trace wrappers run the observed callback through the host, so a throw
// there is the callback's own and must propagate; only the counters above
// are fire-and-forget. Fallbacks are hoisted so the traced path allocates
// nothing of its own.
let tracePhaseFallback = (_, callback, _) => callback()
let traceStorageFallback = (_, callback) => callback()
let tracePoolAcquisitionFallback = callback => callback(() => ())

let tracePhase = (phase, callback, ~attributes: dict<int>=Dict.make()) => {
  let hook: (string, unit => 'a, dict<int>) => 'a = get(
    "dlmm.chain-indexer.trace-phase",
    tracePhaseFallback,
  )
  hook(phase, callback, attributes)
}

let traceStorage = (operation, callback) => {
  let hook: (string, unit => 'a) => 'a = get(
    "dlmm.chain-indexer.trace-storage",
    traceStorageFallback,
  )
  hook(operation, callback)
}

let tracePoolAcquisition = callback => {
  let hook: ((unit => unit) => promise<'a>) => promise<'a> = get(
    "dlmm.chain-indexer.trace-pool-acquisition",
    tracePoolAcquisitionFallback,
  )
  hook(callback)
}
