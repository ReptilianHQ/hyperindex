open Vitest

// The handler side of the query retry budget: once SourceManager.executeQuery
// gives a range up, ChainFetching must release its slot and re-plan the range
// instead of ending the indexer. Before this handler existed the same throw
// went to errorExit.

let scenario = Scenario.make(
  ~configYaml=`
name: query-retry-budget
contracts:
  - name: Gravatar
    events:
      - event: "TestEvent()"
chains:
  - id: 1337
    rpc:
      url: https://rpc.example.test
      for: sync
    start_block: 1
    contracts:
      - name: Gravatar
        address: "0x2B2f78c5BF6D9C12Ee1225D5F374aa91204580c3"
`,
  ~schema=`
type Gravatar {
  id: ID!
}
`,
)

let rejectWithBackoff = (call: MockSource.getItemsOrThrowCall) =>
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
let waitForItemsCall = async (sourceMock: MockSource.t) => {
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
  let fatalErrors = []
  scenario->Scenario.it(
    "releases a range that exhausts its retries and re-plans it instead of exiting",
    ~sources=[{chain: 1337, methods: [#getHeightOrThrow, #getItemsOrThrow, #getBlockHashes]}],
    ~onError=errHandler => fatalErrors->Array.push(errHandler)->ignore,
    async (~t, ~indexer, ~source) => {
      let sourceMock = source(1337)
      sourceMock.resolveGetHeightOrThrow(300)

      let first = await waitForItemsCall(sourceMock)
      let rangeFrom = first.payload["fromBlock"]
      // Fail the same range through the whole retry budget.
      rejectWithBackoff(first)
      let lastRetry = ref(first.payload["retry"])
      for _attempt in 2 to Env.maxSourceQueryRetries {
        let call = await waitForItemsCall(sourceMock)
        lastRetry := call.payload["retry"]
        rejectWithBackoff(call)
      }

      // The budget is spent. The query is released and re-planned rather than
      // ending the indexer, so the next call starts at the same block again
      // (the planner may re-shape its upper bound, an open-ended probe in
      // place of a chunk), and a response to it is indexed normally. What
      // separates a re-plan from one more retry is the retry counter the
      // source sees: a re-planned query starts over at zero, whereas the loop
      // would have reached the budget.
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
      await indexer.getBatchWritePromise()

      t.expect({
        "fatalErrors": fatalErrors->Array.length,
        "replannedFromBlock": replanned.payload["fromBlock"],
        "lastRetryBeforeGiveUp": lastRetry.contents,
        "replannedRetry": replanned.payload["retry"],
        "handled": handled.contents,
      }).toEqual({
        "fatalErrors": 0,
        "replannedFromBlock": rangeFrom,
        "lastRetryBeforeGiveUp": Env.maxSourceQueryRetries - 1,
        "replannedRetry": 0,
        "handled": true,
      })
    },
  )
})
