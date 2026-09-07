open Vitest

// The store takes 32-byte block hashes; widen the short markers these
// fixtures use rather than making every one of them 64 digits long.
let evmHash = hex =>
  "0x" ++ hex->String.slice(~start=2, ~end=hex->String.length)->String.padStart(64, "0")


let chainId = 1->ChainId.fromInt

// Mock source that throws Source.RateLimited on the first N calls, then
// returns Ok with the requested block data. Lets us exercise
// SourceManager.getBlockHashes' rate-limit retry path deterministically
// without depending on a live HyperSync endpoint.
let makeMockSource = (~rateLimitedCalls: int, ~resetMs: int): Source.t => {
  let callCount = ref(0)
  {
    name: "MockHyperSync",
    sourceFor: Sync,
    chainId,
    poweredByHyperSync: true,
    pollingInterval: 100,
    getBlockHashes: (~blockNumbers, ~logger as _) => {
      let current = callCount.contents
      callCount := current + 1
      if current < rateLimitedCalls {
        throw(Source.RateLimited({resetMs: resetMs, requestStats: []}))
      }
      let data = BlockStore.fromJs(
        blockNumbers->Array.map(n => {
          let hashDigits = n->Int.toString
          {
            BlockStore.blockNumber: n,
            blockHash: evmHash(`0x${hashDigits}`),
            blockTimestamp: n,
          }
        }),
        ~ecosystem=Evm,
        ~shouldChecksum=false,
      )
      Promise.resolve({Source.result: Ok(data), requestStats: []})
    },
    getHeightOrThrow: () => Promise.resolve({Source.height: 100, requestStats: []}),
    getItemsOrThrow: (
      ~fromBlock as _,
      ~toBlock as _,
      ~addressSet as _,
      ~knownHeight as _,
      ~partitionId as _,
      ~selection as _,
      ~itemsTarget as _,
      ~retry as _,
      ~logger as _,
    ) => JsError.throwWithMessage("Not used by rate limit test"),
  }
}

describe("SourceManager.getBlockHashes rate limit handling", () => {
  Async.it("calls source.onReorg after an inconsistent hash response", async t => {
    let reorgCalls = ref(0)
    let attempt = ref(0)
    let source: Source.t = {
      ...makeMockSource(~rateLimitedCalls=0, ~resetMs=0),
      getBlockHashes: (~blockNumbers, ~logger as _) => {
        let blockNumber = blockNumbers->Utils.Array.firstUnsafe
        let response = BlockStore.fromJs(
          [{BlockStore.blockNumber, blockHash: evmHash("0x01")}],
          ~ecosystem=Evm,
          ~shouldChecksum=false,
        )
        if attempt.contents === 0 {
          attempt := 1
          let conflictingPage = BlockStore.fromJs(
            [{BlockStore.blockNumber, blockHash: evmHash("0x02")}],
            ~ecosystem=Evm,
            ~shouldChecksum=false,
          )
          response->BlockStore.appendPage(conflictingPage)
        }
        Promise.resolve({Source.result: Ok(response), requestStats: []})
      },
      onReorg: () => reorgCalls := reorgCalls.contents + 1,
    }
    let sourceManager = SourceManager.make(~sources=[source], ~isRealtime=false)

    let _ = await sourceManager->SourceManager.getBlockHashes(
      ~blockNumbers=[1],
      ~isRealtime=false,
    )

    t.expect(reorgCalls.contents).toEqual(1)
  })

  it("identifies the source query execution will use in each phase", t => {
    let hyperSync = makeMockSource(~rateLimitedCalls=0, ~resetMs=100)
    let realtimeRpc: Source.t = {
      ...hyperSync,
      name: "MockRealtimeRpc",
      sourceFor: Realtime,
      poweredByHyperSync: false,
    }
    let sourceManager = SourceManager.make(
      ~sources=[hyperSync, realtimeRpc],
      ~isRealtime=false,
    )
    t.expect({
      "backfill": sourceManager->SourceManager.willQueryHyperSync(~isRealtime=false),
      "realtime": sourceManager->SourceManager.willQueryHyperSync(~isRealtime=true),
    }).toEqual({"backfill": true, "realtime": false})
  })

  Async.it("recovers after a rate limit and tracks wait time", async t => {
    // 500ms resetMs * 2 rate-limited calls = ~1s minimum total wait
    let source = makeMockSource(~rateLimitedCalls=2, ~resetMs=500)
    let sourceManager = SourceManager.make(
      ~sources=[source],
      ~isRealtime=false,
    )

    let blockNumbers = [100, 101, 102]
    let result = await sourceManager->SourceManager.getBlockHashes(
      ~blockNumbers,
      ~isRealtime=false,
    )

    t.expect(result->BlockStore.getHashedBlockNumbers(~fromBlock=0, ~belowBlock=103)).toEqual(
      blockNumbers,
    )
    t.expect(sourceManager->SourceManager.getRateLimitTimeMs > 900.0).toEqual(true)
  })

  Async.it("succeeds immediately when no rate limit", async t => {
    let source = makeMockSource(~rateLimitedCalls=0, ~resetMs=100)
    let sourceManager = SourceManager.make(
      ~sources=[source],
      ~isRealtime=false,
    )

    let result = await sourceManager->SourceManager.getBlockHashes(
      ~blockNumbers=[1, 2],
      ~isRealtime=false,
    )

    t.expect(result->BlockStore.getHashedBlockNumbers(~fromBlock=0, ~belowBlock=3)).toEqual([1, 2])
    t.expect(sourceManager->SourceManager.getRateLimitTimeMs).toEqual(0.0)
  })

  Async.it(
    "concurrent rate-limited calls only count the overlapping wall-clock window once",
    async t => {
      let source = makeMockSource(~rateLimitedCalls=4, ~resetMs=500)
      let sourceManager = SourceManager.make(
        ~sources=[source],
        ~isRealtime=false,
      )

      // Two parallel calls — each hits 2 rate limits at ~500ms each.
      // Sequential accounting would yield ~4 * 500ms = 2000ms; the dedup'd
      // wall-clock total should be roughly half that (~1000ms).
      let start = Date.now()
      let _ =
        await [
          sourceManager->SourceManager.getBlockHashes(~blockNumbers=[1], ~isRealtime=false),
          sourceManager->SourceManager.getBlockHashes(~blockNumbers=[2], ~isRealtime=false),
        ]->Promise.all
      let elapsed = Date.now() -. start

      let rateLimitTime = sourceManager->SourceManager.getRateLimitTimeMs
      t.expect(rateLimitTime > 400.0 && rateLimitTime < elapsed +. 100.0).toEqual(true)
    },
  )
})

// Mock source whose block-range queries never succeed: every call fails with a
// backoff retry, the shape a persistently degraded provider produces.
let makeAlwaysFailingItemsSource = (~backoffMillis: int): Source.t => {
  name: "MockFailingHyperSync",
  sourceFor: Sync,
  chainId,
  poweredByHyperSync: true,
  pollingInterval: 100,
  getBlockHashes: (~blockNumbers as _, ~logger as _) =>
    JsError.throwWithMessage("Not used by retry budget test"),
  getHeightOrThrow: () => Promise.resolve({Source.height: 100, requestStats: []}),
  getItemsOrThrow: (
    ~fromBlock as _,
    ~toBlock,
    ~addressSet as _,
    ~knownHeight as _,
    ~partitionId as _,
    ~selection as _,
    ~itemsTarget as _,
    ~retry as _,
    ~logger as _,
  ) =>
    throw(
      Source.GetItemsError(
        FailedGettingItems({
          exn: Not_found,
          attemptedToBlock: toBlock->Option.getOr(0),
          retry: WithBackoff({message: "mock provider failure", backoffMillis}),
        }),
      ),
    ),
}

// Mock source that always answers with a narrower suggested range. That branch
// resets the retry counter on every attempt and never waits, so only the wall
// clock can end it.
let makeAlwaysNarrowingItemsSource = (): Source.t => {
  name: "MockNarrowingHyperSync",
  sourceFor: Sync,
  chainId,
  poweredByHyperSync: true,
  pollingInterval: 100,
  getBlockHashes: (~blockNumbers as _, ~logger as _) =>
    JsError.throwWithMessage("Not used by retry budget test"),
  getHeightOrThrow: () => Promise.resolve({Source.height: 100, requestStats: []}),
  getItemsOrThrow: (
    ~fromBlock,
    ~toBlock,
    ~addressSet as _,
    ~knownHeight as _,
    ~partitionId as _,
    ~selection as _,
    ~itemsTarget as _,
    ~retry as _,
    ~logger as _,
  ) => {
    let attempted = toBlock->Option.getOr(fromBlock + 1)
    // Rejects asynchronously: the suggested-range branch has no wait of its
    // own, so a synchronous throw would spin the event loop for the whole
    // timeout instead of yielding between attempts.
    Utils.delay(0)->Promise.then(() =>
      Promise.reject(
        Source.GetItemsError(
          FailedGettingItems({
            exn: Not_found,
            attemptedToBlock: attempted,
            retry: WithSuggestedToBlock({toBlock: Pervasives.max(fromBlock, attempted - 1)}),
          }),
        ),
      )
    )
  },
}

let makeRangeQuery = (): FetchState.query => {
  partitionId: "7",
  fromBlock: 1,
  toBlock: Some(10),
  isChunk: true,
  rangeReason: "full_range",
  itemsTarget: None,
  itemsEst: 1,
  selection: FetchState.makeSelection(~dependsOnAddresses=true, ~onEventRegistrations=[]),
  addresses: AddressStore.make(
    ~ecosystem=Ecosystem.Evm,
    ~shouldChecksum=false,
    ~contracts=[],
  )->AddressStore.emptySet,
}

describe("SourceManager.executeQuery retry budget", () => {
  Async.it("gives the query up after the retry count so its slot can be re-planned", async t => {
    let sourceManager = SourceManager.make(
      ~sources=[makeAlwaysFailingItemsSource(~backoffMillis=1)],
      ~isRealtime=false,
    )
    let outcome = try {
      let _ = await sourceManager->SourceManager.executeQuery(
        ~query=makeRangeQuery(),
        ~knownHeight=100,
        ~isRealtime=false,
        ~maxRetries=3,
        ~retryTimeoutMillis=60_000,
      )
      "resolved"
    } catch {
    | SourceManager.QueryRetriesExhausted({retries}) => `exhausted retries=${retries->Int.toString}`
    }
    t.expect(outcome).toEqual("exhausted retries=3")
  })

  Async.it("gives the query up on wall clock even while the retry count is far off", async t => {
    let sourceManager = SourceManager.make(
      ~sources=[makeAlwaysFailingItemsSource(~backoffMillis=40)],
      ~isRealtime=false,
    )
    let startedAt = Date.now()
    let outcome = try {
      let _ = await sourceManager->SourceManager.executeQuery(
        ~query=makeRangeQuery(),
        ~knownHeight=100,
        ~isRealtime=false,
        ~maxRetries=1_000_000,
        ~retryTimeoutMillis=1_000,
      )
      "resolved"
    } catch {
    | SourceManager.QueryRetriesExhausted({retries, elapsedMillis}) =>
      // Backoff is 40ms, so the count stays tiny while the clock runs out.
      retries < 1_000 && elapsedMillis >= 1_000 ? "exhausted by time" : "exhausted by count"
    }
    let elapsed = Date.now() -. startedAt
    t.expect({"outcome": outcome, "boundedWait": elapsed < 5_000.}).toEqual({
      "outcome": "exhausted by time",
      "boundedWait": true,
    })
  })

  Async.it("gives up on wall clock when every attempt resets the retry counter", async t => {
    let sourceManager = SourceManager.make(
      ~sources=[makeAlwaysNarrowingItemsSource()],
      ~isRealtime=false,
    )
    let outcome = try {
      let _ = await sourceManager->SourceManager.executeQuery(
        ~query=makeRangeQuery(),
        ~knownHeight=100,
        ~isRealtime=false,
        ~maxRetries=3,
        ~retryTimeoutMillis=1_000,
      )
      "resolved"
    } catch {
    | SourceManager.QueryRetriesExhausted({retries, elapsedMillis}) =>
      // The counter is reset to zero on every suggested-range retry, so it can
      // never reach 3; the clock is the only bound that fires.
      retries === 0 && elapsedMillis >= 1_000 ? "exhausted by time with counter reset" : `retries=${retries->Int.toString}`
    }
    t.expect(outcome).toEqual("exhausted by time with counter reset")
  })
})
