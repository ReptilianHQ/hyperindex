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

import { describe, test } from "vitest";
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

  // THE BUG: after threshold crossing, stuck in-flight queries from the absorbed
  // address-based partition consume all maxChainConcurrency slots. getNextQuery
  // returns NothingToQuery even though the standing/backfill partition has 15M
  // blocks of PonsLaunchState events to fetch — so no new launches register.
  //
  // This test documents the confirmed failure mode from the _v10 incident.
  // It currently PASSES (the assertion matches the buggy behaviour).
  // When the fix lands — releasing reservations from absorbed partitions —
  // this test must be INVERTED: the result should no longer be NothingToQuery.
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

      // availableConcurrency = chainConcurrency - chainConcurrency = 0
      // getNextQuery must return NothingToQuery — the standing partition is starved.
      // BUG: the standing partition has 15M blocks of events to fetch but can't.
      const result = FetchState.getNextQuery(afterCrossing, 52_000_000, 100_000);
      if (result !== "NothingToQuery") {
        throw new Error(
          `Expected NothingToQuery when all ${chainConcurrency} slots are consumed by stuck ` +
          `queries, but got queries — concurrency starvation did not reproduce`,
        );
      }
    }),
  );
});
