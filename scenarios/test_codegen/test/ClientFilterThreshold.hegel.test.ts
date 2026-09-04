// Property-based tests for the fork's client-filter address-threshold behaviour.
// The threshold formula `maxAddrInPartition * maxChainConcurrency / 2` is fork-
// specific: upstream hard-codes chainConcurrency=100, making the threshold
// unreachable in practice. The fork exposes ENVIO_MAX_CHAIN_CONCURRENCY, which
// silently scales the filtering threshold — the coupling that produced the _v10
// staging incident (dlmm-site#2087).
//
// These tests probe the FetchState + AddressStore boundary with Hegel-generated
// inputs. The threshold is computed directly from the formula and passed
// explicitly to FetchState.make so the tests are stateless and reproducible.

import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";

const envioSrc = new URL(
  "../node_modules/envio/src/",
  import.meta.url,
);

// Import compiled modules once — stateless, no env-var dependency.
const AddressStore = await import(
  /* @vite-ignore */ new URL("sources/AddressStore.res.mjs", envioSrc).href
);
const FetchState = await import(
  /* @vite-ignore */ new URL("FetchState.res.mjs", envioSrc).href
);

const MAX_ADDR_IN_PARTITION = 5000;

// The fork's threshold formula: floor(maxAddrInPartition * chainConcurrency / 2).
const thresholdFor = (chainConcurrency: number) =>
  Math.floor((MAX_ADDR_IN_PARTITION * chainConcurrency) / 2);

const hexAddress = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

const makeReg = (
  index: number,
  contractName: string,
  startBlock?: number,
  dependsOnAddresses = true,
) => ({
  index,
  eventConfig: { contractName },
  startBlock,
  dependsOnAddresses,
  isWildcard: false,
  addressFilterParamGroups: undefined,
});

const makeFetchState = (
  addressStore: any,
  registrations: any[],
  addresses: any[],
  threshold: number,
  knownHeight = 52_000_000,
  progressBlock?: number,
) =>
  FetchState.make(
    0,
    60_000_000,
    registrations,
    addressStore,
    addresses,
    MAX_ADDR_IN_PARTITION,
    4663,
    1000,
    knownHeight,
    progressBlock,
    undefined,
    undefined,
    undefined,
    threshold,
  );

describe("client-filter threshold properties (fork-specific)", () => {
  test(
    "a retained gap ahead of the soft target is still repaired",
    () => hegel.test((tc) => {
      const baseBlock = tc.draw(gs.integers({ minValue: 1, maxValue: 100_000 }));
      const targetSpan = tc.draw(gs.integers({ minValue: 1, maxValue: 4_999 }));
      const gapOffset = tc.draw(gs.integers({ minValue: targetSpan + 1, maxValue: 10_000 }));
      const retainedSpan = tc.draw(gs.integers({ minValue: 1, maxValue: 5_000 }));
      const registrations = [makeReg(1, "StaticContract", undefined, false)];
      const addressStore = AddressStore.make(
        "evm",
        true,
        AddressStore.contractsOf(registrations, []),
      );
      const fetchState = makeFetchState(
        addressStore,
        registrations,
        [],
        thresholdFor(8),
        baseBlock + 100_000,
        baseBlock,
      );
      const laggingId = fetchState.optimizedPartitions.idsInAscOrder[0];
      const gapId = "retained-gap";
      const gapFrontier = baseBlock + gapOffset;
      const pendingFromBlock = gapFrontier + retainedSpan + 1;
      fetchState.optimizedPartitions = {
        ...fetchState.optimizedPartitions,
        idsInAscOrder: [laggingId, gapId],
        entities: {
          [laggingId]: fetchState.optimizedPartitions.entities[laggingId],
          [gapId]: {
            id: gapId,
            latestFetchedBlock: { blockNumber: gapFrontier, blockTimestamp: 0 },
            selection: { dependsOnAddresses: false, onEventRegistrations: registrations },
            addresses: addressStore.emptySet,
            mergeBlock: undefined,
            dynamicContract: undefined,
            mutPendingQueries: [{
              fromBlock: pendingFromBlock,
              toBlock: pendingFromBlock + retainedSpan - 1,
              isChunk: true,
              itemsTarget: undefined,
              itemsEst: retainedSpan,
              fetchedBlock: {
                blockNumber: pendingFromBlock + retainedSpan - 1,
                blockTimestamp: 0,
              },
            }],
            sourceRangeCapacity: retainedSpan,
            prevSourceRangeCapacity: retainedSpan,
            eventDensity: 1,
            latestSourceRangeCapacityUpdateBlock: 0,
          },
        },
        nextPartitionIndex: 2,
      };

      // The lagging partition cannot yet fund a full fixed-size historical
      // chunk. The completed result in the other partition must nevertheless
      // make its prerequisite gap runnable beyond this soft target.
      const action = FetchState.getNextQuery(
        fetchState,
        baseBlock + targetSpan,
        1_000_000,
        false,
        5_000,
      );
      expect(action).toMatchObject({
        TAG: "Ready",
        _0: [{
          partitionId: gapId,
          fromBlock: gapFrontier + 1,
          toBlock: pendingFromBlock - 1,
          rangeReason: "gap_fill",
        }],
      });
    }),
  );

  test(
    "retained gaps outside the first fair round cannot starve",
    () => hegel.test((tc) => {
      const baseBlock = tc.draw(gs.integers({ minValue: 1, maxValue: 100_000 }));
      const targetSpan = tc.draw(gs.integers({ minValue: 1, maxValue: 4_999 }));
      const gapCount = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
      const laggingCount = FetchState.maxChainConcurrency + tc.draw(
        gs.integers({ minValue: 1, maxValue: 8 }),
      );
      const registrations = [makeReg(1, "StaticContract", undefined, false)];
      const addressStore = AddressStore.make(
        "evm",
        true,
        AddressStore.contractsOf(registrations, []),
      );
      const fetchState = makeFetchState(
        addressStore,
        registrations,
        [],
        thresholdFor(8),
        baseBlock + 100_000,
        baseBlock,
      );
      const laggingIds = Array.from({ length: laggingCount }, (_, index) => `lagging-${index}`);
      const gapIds = Array.from({ length: gapCount }, (_, index) => `gap-${index}`);
      const ids = [...laggingIds, ...gapIds];
      const entities = Object.fromEntries(ids.map((id, index) => {
        const isGap = index >= laggingCount;
        const frontier = isGap ? baseBlock + targetSpan + 100 + index : baseBlock;
        const pendingFromBlock = frontier + 101;
        return [id, {
          id,
          latestFetchedBlock: { blockNumber: frontier, blockTimestamp: 0 },
          selection: { dependsOnAddresses: false, onEventRegistrations: registrations },
          addresses: addressStore.emptySet,
          mergeBlock: undefined,
          dynamicContract: undefined,
          mutPendingQueries: isGap ? [{
            fromBlock: pendingFromBlock,
            toBlock: pendingFromBlock + 99,
            isChunk: true,
            itemsTarget: undefined,
            itemsEst: 100,
            fetchedBlock: { blockNumber: pendingFromBlock + 99, blockTimestamp: 0 },
          }] : [],
          sourceRangeCapacity: 100,
          prevSourceRangeCapacity: 100,
          eventDensity: 1,
          latestSourceRangeCapacityUpdateBlock: 0,
        }];
      }));
      fetchState.optimizedPartitions = {
        idsInAscOrder: ids,
        entities,
        maxAddrInPartition: MAX_ADDR_IN_PARTITION,
        nextPartitionIndex: ids.length,
        dynamicContracts: new Set(),
        clientFilteredContracts: new Set(),
      };

      const action = FetchState.getNextQuery(
        fetchState,
        baseBlock + targetSpan,
        1_000_000,
        false,
        5_000,
      );
      if (action?.TAG !== "Ready") {
        throw new Error(`Expected Ready, got ${String(action)}`);
      }
      const queries = action._0;
      expect(new Set(queries.map((query: any) => query.partitionId))).toEqual(new Set(gapIds));
      expect(queries.every((query: any) => query.rangeReason === "gap_fill")).toBe(true);
    }),
  );

  test(
    "a saturated scheduler fills its first round with distinct runnable partitions",
    () => hegel.test((tc) => {
      const extraPartitions = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
      const partitionCount = FetchState.maxChainConcurrency + extraPartitions;
      const registrations = [makeReg(1, "StaticContract", undefined, false)];
      const addressStore = AddressStore.make(
        "evm",
        true,
        AddressStore.contractsOf(registrations, []),
      );
      const fetchState = makeFetchState(
        addressStore,
        registrations,
        [],
        thresholdFor(8),
        100_000,
        0,
      );
      const ids = Array.from({ length: partitionCount }, (_, index) => `${index}`);
      const entities = Object.fromEntries(ids.map((id, index) => [id, {
        id,
        latestFetchedBlock: { blockNumber: index * 100, blockTimestamp: 0 },
        selection: { dependsOnAddresses: false, onEventRegistrations: registrations },
        addresses: addressStore.emptySet,
        mergeBlock: undefined,
        dynamicContract: undefined,
        mutPendingQueries: [],
        sourceRangeCapacity: 10,
        prevSourceRangeCapacity: 10,
        eventDensity: 1,
        latestSourceRangeCapacityUpdateBlock: 0,
      }]));
      fetchState.optimizedPartitions = {
        idsInAscOrder: ids,
        entities,
        maxAddrInPartition: MAX_ADDR_IN_PARTITION,
        nextPartitionIndex: partitionCount,
        dynamicContracts: new Set(),
        clientFilteredContracts: new Set(),
      };

      const action = FetchState.getNextQuery(fetchState, 100_000, 1_000_000);
      if (action?.TAG !== "Ready") {
        throw new Error(`Expected Ready, got ${String(action)}`);
      }
      const queries = action._0;
      const distinctPartitions = new Set(queries.map((query: any) => query.partitionId));
      expect({ queries: queries.length, distinctPartitions: distinctPartitions.size }).toEqual({
        queries: FetchState.maxChainConcurrency,
        distinctPartitions: FetchState.maxChainConcurrency,
      });
    }),
  );

  test(
    "the last free slot goes to a partition with no existing reservations",
    () => hegel.test((tc) => {
      const baseBlock = tc.draw(gs.integers({ minValue: 0, maxValue: 10_000 }));
      const registrations = [makeReg(1, "StaticContract", undefined, false)];
      const addressStore = AddressStore.make(
        "evm",
        true,
        AddressStore.contractsOf(registrations, []),
      );
      const fetchState = makeFetchState(
        addressStore,
        registrations,
        [],
        thresholdFor(8),
        100_000,
        baseBlock,
      );
      const reservedSlots = FetchState.maxChainConcurrency - 1;
      const oldPartitionCount = Math.ceil(
        reservedSlots / FetchState.maxInFlightChunksPerPartition,
      );
      const newcomerId = `${oldPartitionCount}`;
      const ids = Array.from({ length: oldPartitionCount + 1 }, (_, index) => `${index}`);
      let remainingReservations = reservedSlots;
      const entities = Object.fromEntries(ids.map((id, index) => {
        const frontier = baseBlock + index * 1_000;
        const inFlight = id === newcomerId
          ? 0
          : Math.min(remainingReservations, FetchState.maxInFlightChunksPerPartition);
        remainingReservations -= inFlight;
        return [id, {
          id,
          latestFetchedBlock: { blockNumber: frontier, blockTimestamp: 0 },
          selection: { dependsOnAddresses: false, onEventRegistrations: registrations },
          addresses: addressStore.emptySet,
          mergeBlock: undefined,
          dynamicContract: undefined,
          mutPendingQueries: Array.from({ length: inFlight }, (_, queryIndex) => ({
            fromBlock: frontier + queryIndex * 10 + 1,
            toBlock: frontier + (queryIndex + 1) * 10,
            isChunk: true,
            itemsTarget: undefined,
            itemsEst: 1,
            fetchedBlock: undefined,
          })),
          sourceRangeCapacity: 10,
          prevSourceRangeCapacity: 10,
          eventDensity: 1,
          latestSourceRangeCapacityUpdateBlock: 0,
        }];
      }));
      fetchState.optimizedPartitions = {
        idsInAscOrder: ids,
        entities,
        maxAddrInPartition: MAX_ADDR_IN_PARTITION,
        nextPartitionIndex: ids.length,
        dynamicContracts: new Set(),
        clientFilteredContracts: new Set(),
      };

      const action = FetchState.getNextQuery(fetchState, 100_000, 1_000_000);
      expect(action).toMatchObject({
        TAG: "Ready",
        _0: [{ partitionId: newcomerId }],
      });
    }),
  );

  test(
    "an earlier gap-fill keeps the last free slot when reservations exhaust the budget",
    () => hegel.test((tc) => {
      const baseBlock = tc.draw(gs.integers({ minValue: 0, maxValue: 10_000 }));
      const registrations = [makeReg(1, "StaticContract", undefined, false)];
      const addressStore = AddressStore.make(
        "evm",
        true,
        AddressStore.contractsOf(registrations, []),
      );
      const fetchState = makeFetchState(
        addressStore,
        registrations,
        [],
        thresholdFor(8),
        100_000,
        baseBlock,
      );
      const reservedSlots = FetchState.maxChainConcurrency - 1;
      const firstPartitionReservations = FetchState.maxInFlightChunksPerPartition - 1;
      const oldPartitionCount = 1 + Math.ceil(
        (reservedSlots - firstPartitionReservations) /
          FetchState.maxInFlightChunksPerPartition,
      );
      const ids = Array.from({ length: oldPartitionCount + 1 }, (_, index) => `${index}`);
      let remainingReservations = reservedSlots;
      const entities = Object.fromEntries(ids.map((id, index) => {
        const frontier = baseBlock + index * 1_000;
        const inFlight = index === oldPartitionCount
          ? 0
          : Math.min(
              remainingReservations,
              index === 0
                ? firstPartitionReservations
                : FetchState.maxInFlightChunksPerPartition,
            );
        remainingReservations -= inFlight;
        const firstPendingBlock = frontier + (index === 0 ? 100 : 1);
        return [id, {
          id,
          latestFetchedBlock: { blockNumber: frontier, blockTimestamp: 0 },
          selection: { dependsOnAddresses: false, onEventRegistrations: registrations },
          addresses: addressStore.emptySet,
          mergeBlock: undefined,
          dynamicContract: undefined,
          mutPendingQueries: Array.from({ length: inFlight }, (_, queryIndex) => ({
            fromBlock: firstPendingBlock + queryIndex * 10,
            toBlock: firstPendingBlock + queryIndex * 10 + 9,
            isChunk: true,
            itemsTarget: undefined,
            itemsEst: 1,
            fetchedBlock: undefined,
          })),
          sourceRangeCapacity: 10,
          prevSourceRangeCapacity: 10,
          eventDensity: 1,
          latestSourceRangeCapacityUpdateBlock: 0,
        }];
      }));
      fetchState.optimizedPartitions = {
        idsInAscOrder: ids,
        entities,
        maxAddrInPartition: MAX_ADDR_IN_PARTITION,
        nextPartitionIndex: ids.length,
        dynamicContracts: new Set(),
        clientFilteredContracts: new Set(),
      };

      const action = FetchState.getNextQuery(fetchState, 100_000, 1);
      expect(action).toMatchObject({
        TAG: "Ready",
        _0: [{ partitionId: "0", rangeReason: "gap_fill", fromBlock: baseBlock + 1 }],
      });
    }),
  );

  // https://github.com/ReptilianHQ/dlmm-site/issues/2087
  test(
    "scheduler telemetry accounts for every retained query",
    () => hegel.test((tc) => {
      const progressBlock = tc.draw(gs.integers({ minValue: 1, maxValue: 52_000_000 }));
      const pendingCount = tc.draw(gs.integers({ minValue: 0, maxValue: 16 }));
      const registrations = [makeReg(1, "StaticContract", undefined, false)];
      const addressStore = AddressStore.make(
        "evm",
        true,
        AddressStore.contractsOf(registrations, []),
      );
      const fetchState = makeFetchState(
        addressStore,
        registrations,
        [],
        thresholdFor(8),
        53_000_000,
        progressBlock,
      );
      const partitionId = fetchState.optimizedPartitions.idsInAscOrder[0];
      const partition = fetchState.optimizedPartitions.entities[partitionId];
      let fetchedPendingQueries = 0;
      partition.mutPendingQueries.push(...Array.from({ length: pendingCount }, (_, index) => {
        const fetched = tc.draw(gs.booleans());
        if (fetched) fetchedPendingQueries += 1;
        return {
          fromBlock: progressBlock + 1 + index * 100,
          toBlock: progressBlock + 100 + index * 100,
          isChunk: true,
          itemsTarget: undefined,
          itemsEst: 100,
          fetchedBlock: fetched
            ? { blockNumber: progressBlock + 100 + index * 100, blockTimestamp: 0 }
            : undefined,
        };
      }));

      expect(FetchState.makeSchedulerPartitionSnapshot(partitionId, partition)).toEqual({
        partitionId,
        frontierBlock: progressBlock,
        pendingQueries: pendingCount,
        inFlightQueries: pendingCount - fetchedPendingQueries,
        fetchedPendingQueries,
        nextPendingFromBlock: pendingCount === 0 ? undefined : progressBlock + 1,
      });
    }),
  );

  // For any chain concurrency in the fork's supported range, registering
  // exactly threshold + 1 addresses must promote the contract to client-filter.
  test(
    "contract enters client-filter mode at threshold + 1 for any valid concurrency",
    () => hegel.test((tc) => {
      const chainConcurrency = tc.draw(gs.integers({ minValue: 1, maxValue: 32 }));
      const threshold = thresholdFor(chainConcurrency);

      const registrations = [makeReg(1, "PonsLaunchState", 0)];
      const addressStore = AddressStore.make(
        "evm",
        true,
        AddressStore.contractsOf(registrations, []),
      );
      const addresses = Array.from({ length: threshold + 1 }, (_, i) => ({
        address: hexAddress(i + 1),
        contractName: "PonsLaunchState",
        registrationBlock: 37_000_000 + i,
      }));

      const fetchState = makeFetchState(addressStore, registrations, addresses, threshold);
      const clientFiltered = [...fetchState.optimizedPartitions.clientFilteredContracts];

      if (!clientFiltered.includes("PonsLaunchState")) {
        throw new Error(
          `Expected PonsLaunchState in clientFilteredContracts at concurrency=${chainConcurrency} ` +
            `(threshold=${threshold}, registered=${threshold + 1}), got: [${clientFiltered.join(", ")}]`,
        );
      }
    }),
  );

  // Exactly at the threshold: must NOT be promoted (condition is >, not >=).
  test(
    "contract stays server-side at exactly the threshold",
    () => hegel.test((tc) => {
      const chainConcurrency = tc.draw(gs.integers({ minValue: 1, maxValue: 32 }));
      const threshold = thresholdFor(chainConcurrency);

      const registrations = [makeReg(1, "PonsLaunchState", 0)];
      const addressStore = AddressStore.make(
        "evm",
        true,
        AddressStore.contractsOf(registrations, []),
      );
      const addresses = Array.from({ length: threshold }, (_, i) => ({
        address: hexAddress(i + 1),
        contractName: "PonsLaunchState",
        registrationBlock: 37_000_000 + i,
      }));

      const fetchState = makeFetchState(addressStore, registrations, addresses, threshold);
      const clientFiltered = [...fetchState.optimizedPartitions.clientFilteredContracts];

      if (clientFiltered.includes("PonsLaunchState")) {
        throw new Error(
          `PonsLaunchState must NOT be client-filtered at exactly threshold=${threshold} ` +
            `(concurrency=${chainConcurrency}), but was promoted`,
        );
      }
    }),
  );

  // After threshold crossing via registerDynamicContracts, the standing client-
  // filter partition must include PonsLaunchState in its selection. This is the
  // liveness property that failed in _v10: factory-emitted TokenLaunched events
  // must still reach handlers after the switch.
  test(
    "standing partition selection includes client-filtered contract after registerDynamicContracts",
    () => hegel.test((tc) => {
      const chainConcurrency = tc.draw(gs.integers({ minValue: 1, maxValue: 32 }));
      const regBlock = tc.draw(gs.integers({ minValue: 0, maxValue: 50_000_000 }));
      const threshold = thresholdFor(chainConcurrency);

      const registrations = [
        makeReg(1, "StaticContract", undefined, false),
        makeReg(2, "PonsLaunchState", 0),
      ];
      const addressStore = AddressStore.make(
        "evm",
        true,
        AddressStore.contractsOf(registrations, []),
      );

      // Static partition already at head (52M).
      const atHead = makeFetchState(
        addressStore,
        registrations,
        [],
        threshold,
        52_000_000,
        52_000_000,
      );

      // Register threshold + 1 addresses to cross into client-filter mode.
      const crossingBatch = Array.from({ length: threshold + 1 }, (_, i) => ({
        address: hexAddress(i + 1),
        contractName: "PonsLaunchState",
        registrationBlock: regBlock + i,
      }));
      const afterCrossing = FetchState.registerDynamicContracts(
        atHead,
        addressStore,
        undefined,
        crossingBatch,
      );

      const standing = afterCrossing.optimizedPartitions.idsInAscOrder
        .map((id: string) => afterCrossing.optimizedPartitions.entities[id])
        .find((p: any) => !p.selection.dependsOnAddresses && p.mergeBlock === undefined);

      if (!standing) {
        throw new Error(
          `No client-filter standing partition after threshold crossing at concurrency=${chainConcurrency}`,
        );
      }
      const selectionNames: string[] = standing.selection.onEventRegistrations.map(
        (r: any) => r.eventConfig.contractName,
      );
      if (!selectionNames.includes("PonsLaunchState")) {
        throw new Error(
          `PonsLaunchState missing from standing partition selection at ` +
            `concurrency=${chainConcurrency} regBlock=${regBlock}. Got: [${selectionNames.join(", ")}]`,
        );
      }
    }),
  );

  // Two contracts registering in lockstep (the exact _v10 shape) must both
  // appear in the standing partition's clientFilteredContracts after crossing.
  // Cap concurrency at 8 (threshold ≤ 20,000) to keep address-batch creation fast.
  test(
    "lockstep two-contract crossing: both appear in standing clientFilteredContracts",
    () => hegel.test((tc) => {
      const chainConcurrency = tc.draw(gs.integers({ minValue: 1, maxValue: 8 }));
      const regBlock = tc.draw(gs.integers({ minValue: 0, maxValue: 37_000_000 }));
      const threshold = thresholdFor(chainConcurrency);

      const registrations = [
        makeReg(1, "StaticContract", undefined, false),
        makeReg(2, "PonsLaunchState", 0),
        makeReg(3, "QuoteAssetPrice", 0),
      ];
      const addressStore = AddressStore.make(
        "evm",
        true,
        AddressStore.contractsOf(registrations, []),
      );

      const atHead = makeFetchState(
        addressStore,
        registrations,
        [],
        threshold,
        52_000_000,
        52_000_000,
      );

      // Both contracts register in lockstep — same batch, same blocks.
      // Address ranges are non-overlapping: PonsLaunchState uses [1, threshold+1],
      // QuoteAssetPrice uses [threshold+2, 2*(threshold+1)+1].
      const lockstepBatch = Array.from({ length: threshold + 1 }, (_, i) => [
        {
          address: hexAddress(i + 1),
          contractName: "PonsLaunchState",
          registrationBlock: regBlock + i,
        },
        {
          address: hexAddress(i + 1 + threshold + 1),
          contractName: "QuoteAssetPrice",
          registrationBlock: regBlock + i,
        },
      ]).flat();

      const afterCrossing = FetchState.registerDynamicContracts(
        atHead,
        addressStore,
        undefined,
        lockstepBatch,
      );

      const globalFiltered = [
        ...afterCrossing.optimizedPartitions.clientFilteredContracts,
      ].sort();
      const standing = afterCrossing.optimizedPartitions.idsInAscOrder
        .map((id: string) => afterCrossing.optimizedPartitions.entities[id])
        .find((p: any) => !p.selection.dependsOnAddresses && p.mergeBlock === undefined);

      if (
        !globalFiltered.includes("PonsLaunchState") ||
        !globalFiltered.includes("QuoteAssetPrice")
      ) {
        throw new Error(
          `Both contracts must be client-filtered after lockstep crossing at concurrency=${chainConcurrency}. ` +
            `Got: [${globalFiltered.join(", ")}]`,
        );
      }
      if (!standing) {
        throw new Error(
          `No standing partition after lockstep crossing at concurrency=${chainConcurrency}`,
        );
      }
      const standingFiltered: string[] = standing.selection.clientFilteredContracts ?? [];
      if (
        !standingFiltered.includes("PonsLaunchState") ||
        !standingFiltered.includes("QuoteAssetPrice")
      ) {
        throw new Error(
          `Standing partition clientFilteredContracts must include both contracts at concurrency=${chainConcurrency}. ` +
            `Got: [${standingFiltered.join(", ")}]`,
        );
      }
    }),
  );

  // After the fix (SourceManager retry cap), queries that exhaust all sources
  // throw rather than spinning forever, so they can no longer hold reservations
  // indefinitely. The starvation scenario can still occur transiently, but only
  // until in-flight queries fail and release their slots. This test verifies
  // that a standing partition with work to do is NOT permanently starved when
  // the absorbing partition's pending queries are cleared.
  //
  // The pre-fix version of this test asserted NothingToQuery (the buggy
  // outcome). Post-fix it asserts that a query IS produced once stuck
  // queries are removed — confirming the reservation is released.
  //
  // Uses FetchState.maxChainConcurrency (the env-resolved value) so the stuck
  // query count always matches the actual concurrency cap, regardless of env.
  test(
    "concurrency starvation: stuck queries from absorbed partition block standing partition (BUG)",
    () => hegel.test((tc) => {
      // The concurrency cap is fixed by env at test-runner startup — use the
      // actual resolved value, not a drawn one, so the stuck query count matches.
      const chainConcurrency: number = FetchState.maxChainConcurrency;
      const threshold = thresholdFor(chainConcurrency);

      const registrations = [
        makeReg(1, "StaticContract", undefined, false),
        makeReg(2, "PonsLaunchState", 0),
      ];
      const addressStore = AddressStore.make(
        "evm",
        true,
        AddressStore.contractsOf(registrations, []),
      );

      // Static partition already at head.
      const atHead = makeFetchState(
        addressStore,
        registrations,
        [],
        threshold,
        52_000_000,
        52_000_000,
      );

      // Cross the threshold: creates a standing partition (at 52M) and a backfill
      // (from ~37M to 52M) that must fetch PonsLaunchState events.
      const crossingBatch = Array.from({ length: threshold + 1 }, (_, i) => ({
        address: hexAddress(i + 1),
        contractName: "PonsLaunchState",
        registrationBlock: 37_000_000 + i,
      }));
      const afterCrossing = FetchState.registerDynamicContracts(
        atHead,
        addressStore,
        undefined,
        crossingBatch,
      );

      const backfill = afterCrossing.optimizedPartitions.idsInAscOrder
        .map((id: string) => afterCrossing.optimizedPartitions.entities[id])
        .find((p: any) => !p.selection.dependsOnAddresses && p.mergeBlock !== undefined);

      if (!backfill) {
        // With static partition at 52M and dynamic at 37M there is always a backfill.
        throw new Error(`No backfill partition at concurrency=${chainConcurrency}`);
      }

      // Simulate chainConcurrency stuck in-flight queries in the backfill partition
      // (the _v10 scenario: queries from the absorbed address-based partition that
      // entered SourceManager's unbounded retry loop and never returned).
      for (let i = 0; i < chainConcurrency; i++) {
        backfill.mutPendingQueries.push({
          fromBlock: 37_000_000 + i * 1_000,
          toBlock: 37_001_000 + i * 1_000,
          isChunk: true,
          itemsEst: 100,
          itemsTarget: 100,
          fetchedBlock: undefined, // stuck — never resolves
        });
      }

      // Confirm the bug: with all slots consumed, getNextQuery returns NothingToQuery.
      const starved = FetchState.getNextQuery(afterCrossing, 52_000_000, 100_000);
      if (starved !== "NothingToQuery") {
        throw new Error(
          `Expected NothingToQuery when all ${chainConcurrency} slots are consumed, ` +
          `got queries instead`,
        );
      }

      // Now clear the stuck queries (simulating the retry cap throwing and
      // releasing the reservation). The standing partition must then get a query.
      backfill.mutPendingQueries.length = 0;
      const recovered = FetchState.getNextQuery(afterCrossing, 52_000_000, 100_000);
      if (recovered === "NothingToQuery") {
        throw new Error(
          `Standing partition still starved after stuck queries cleared at concurrency=${chainConcurrency}`,
        );
      }
    }),
  );
});
