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

let recordSourceRateLimit = (retry: int, waitMs: int): unit =>
  get("dlmm.chain-indexer.source-rate-limit", noop2)(retry, waitMs)

let recordSourceRequest = (event: string, partitionId: string): unit =>
  get("dlmm.chain-indexer.source-request-event", noop2)(event, partitionId)

let recordSourcePage = (requestedBlocks: int, fetchedBlocks: int): unit =>
  get("dlmm.chain-indexer.source-page-result", noop2)(requestedBlocks, fetchedBlocks)

let recordSourceRange = (reason: string, blocks: int): unit =>
  get("dlmm.chain-indexer.source-range-request", noop2)(reason, blocks)

// One query gave up its retry budget and was released for re-planning. A
// counter on this is how a permanently degraded source shows up: the indexer
// keeps going, so nothing else does.
let recordSourceQueryExhausted = (partitionId: string): unit =>
  get("dlmm.chain-indexer.source-query-exhausted", noop1)(partitionId)

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
  get("dlmm.chain-indexer.fetch-scheduler-snapshot", noop1)(snapshot)

type pipelineSnapshot = {queueBatches: int, queueItems: int}

let recordPipeline = (event: string, snapshot: pipelineSnapshot): unit =>
  get("dlmm.chain-indexer.pipeline-event", noop2)(event, snapshot)

let recordPoolConfig = (maxConnections: int): unit =>
  get("dlmm.chain-indexer.pool-config", noop1)(maxConnections)

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
