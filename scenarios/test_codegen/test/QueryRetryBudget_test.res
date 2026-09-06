open Vitest

// The handler side of the query retry budget: once SourceManager.executeQuery
// gives a range up, ChainFetching must release its slot and re-plan the range
// instead of ending the indexer. Before this handler existed the same throw
// went to errorExit.

let rejectWithBackoff = (call: MockIndexer.Source.getItemsOrThrowCall) =>
  call.reject(
    Source.GetItemsError(
      FailedGettingItems({
        exn: Not_found,
        attemptedToBlock: call.payload["toBlock"]->Option.getOr(call.payload["fromBlock"]),
        // Zero backoff keeps the whole budget inside the test timeout; the
        // branch still counts as a retry.
        retry: WithBackoff({message: "mock provider failure", backoffMillis: 0}),
      }),
    ),
  )

// Polls until exactly one range query is pending on the mock source.
let waitForItemsCall = async (sourceMock: MockIndexer.Source.t) => {
  let attempts = ref(0)
  while sourceMock.getItemsOrThrowCalls->Array.length === 0 && attempts.contents < 2_000 {
    await Utils.delay(1)
    attempts := attempts.contents + 1
  }
  switch sourceMock.getItemsOrThrowCalls {
  | [call] => call
  | calls =>
    JsError.throwWithMessage(
      `expected exactly one pending getItemsOrThrow call, found ${calls
        ->Array.length
        ->Int.toString}`,
    )
  }
}

describe("Query retry budget", () => {
  Async.it(
    "releases a range that exhausts its retries and re-plans it instead of exiting",
    async t => {
      let sourceMock = MockIndexer.Source.make(
        [#getHeightOrThrow, #getItemsOrThrow, #getBlockHashes],
        ~chainId=#1337,
      )
      let fatalErrors = []
      let indexerMock = await MockIndexer.Indexer.make(
        ~chains=[{chain: #1337, sourceConfig: Config.CustomSources([sourceMock.source])}],
        ~onError=errHandler => fatalErrors->Array.push(errHandler)->ignore,
      )
      await Utils.delay(0)
      sourceMock.resolveGetHeightOrThrow(300)

      let first = await waitForItemsCall(sourceMock)
      let range = (first.payload["fromBlock"], first.payload["toBlock"])
      // Fail the same range through the whole retry budget.
      rejectWithBackoff(first)
      for _attempt in 2 to Env.maxSourceQueryRetries {
        let call = await waitForItemsCall(sourceMock)
        rejectWithBackoff(call)
      }

      // The budget is spent. The query is released and re-planned rather than
      // ending the indexer, so the next call is the same range again, and a
      // response to it is indexed normally.
      let replanned = await waitForItemsCall(sourceMock)
      let handled = ref(false)
      replanned.resolve(
        [
          {
            blockNumber: 100,
            logIndex: 0,
            handler: async _ => {
              handled := true
            },
          },
        ],
        ~latestFetchedBlockNumber=100,
      )
      await indexerMock.getBatchWritePromise()

      t.expect({
        "fatalErrors": fatalErrors->Array.length,
        "replannedRange": (replanned.payload["fromBlock"], replanned.payload["toBlock"]),
        "handled": handled.contents,
      }).toEqual({
        "fatalErrors": 0,
        "replannedRange": range,
        "handled": true,
      })
      await indexerMock.stop()
    },
  )
})
