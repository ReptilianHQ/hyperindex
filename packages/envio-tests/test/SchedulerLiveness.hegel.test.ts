// Liveness and fairness properties of the fork's fetch scheduler.
//
// The scheduler (FetchState.getNextQuery) took five fixes in two days on the
// same code path, each repairing a starvation the previous one introduced, and
// the _v13 replay ran partly without them. These properties state what every
// version of it must satisfy, so a rebase or another fix cannot quietly bring
// a starvation back:
//
//   1. Bounded admission: a tick never admits more fresh queries than the
//      chain has free slots.
//   2. Fairness: no partition receives a second fresh query in a tick while
//      a partition with work and nothing in flight received none. The
//      scheduler is frontier-first on purpose, so a high-frontier partition
//      can wait for lower ones -- they are finite and retire -- but it may
//      never lose a slot to someone's pipeline depth.
//   3. Liveness: with responses landing in any order, every partition reaches
//      the head within a bounded number of ticks.
//   4. Slots held by queries that never resolve do not stop the rest of the
//      chain, and a full set of stuck slots recovers once they are released
//      through FetchState.releaseInFlightQuery -- the path ChainFetching takes
//      when a query exhausts its retry budget.
//
// The simulation drives the real module: partitions come from FetchState.make
// over dynamic-contract addresses registered far enough apart to land in
// separate partitions, admission goes through startFetchingQueries, and
// responses land through handleQueryResult. Nothing reaches into the queue.

import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";

const AddressStore = await import("envio/src/sources/AddressStore.res.mjs");
const FetchState = await import("envio/src/FetchState.res.mjs");
// Seeds address rows and builds stores the way FetchState.make expects since
// the store took a contract mapping and columnar rows (upstream 3.9.0).
const TestAddresses = await import("./helpers/TestAddresses.res.mjs");

const MAX_ADDR_IN_PARTITION = 5_000;
// Registration blocks this far apart never share a partition (tooFarBlockRange).
const PARTITION_SPACING = 20_000;
const SETTINGS = { testCases: 40 };

const hexAddress = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

const makeReg = (index: number, contractName: string) => ({
  index,
  eventConfig: { contractName },
  startBlock: 0,
  dependsOnAddresses: true,
  isWildcard: false,
  addressFilterParamGroups: undefined,
});

type Query = {
  partitionId: string;
  fromBlock: number;
  toBlock: number | undefined;
};

type Sim = {
  fs: any;
  head: number;
  span: number;
  concurrency: number;
  inFlight: Query[];
  stuck: Query[];
  ticks: number;
  lastAdmitted: any[];
};

// N partitions of one dynamic contract, each anchored one block before its
// registration block, spaced so they never share a partition. The fork's
// coalescing then chains them: each earlier partition fetches up to the next
// one's frontier and retires, and the last one carries every address to head.
const makeSim = (
  partitions: number,
  span: number,
  concurrency: number,
  tailBlocks: number,
): Sim => {
  const base = 1_000_000;
  const registrations = [makeReg(1, "Pool")];
  const addressStore = TestAddresses.makeStore(registrations);
  const addresses = Array.from({ length: partitions }, (_, i) => ({
    address: hexAddress(i + 1),
    contractName: "Pool",
    registrationBlock: base + i * PARTITION_SPACING,
  }));
  const head = base + (partitions - 1) * PARTITION_SPACING + tailBlocks;
  const fs = FetchState.make(
    0,
    undefined,
    registrations,
    addressStore,
    TestAddresses.addressRows(addresses, registrations),
    MAX_ADDR_IN_PARTITION,
    4663,
    1000,
    head,
    undefined,
    undefined,
    0,
    undefined,
    250_000,
  );
  return { fs, head, span, concurrency, inFlight: [], stuck: [], ticks: 0, lastAdmitted: [] };
};

const partitionsOf = (fs: any): any[] =>
  fs.optimizedPartitions.idsInAscOrder.map((id: string) => fs.optimizedPartitions.entities[id]);

const inFlightCount = (p: any) =>
  p.mutPendingQueries.filter((pq: any) => pq.fetchedBlock === undefined).length;

// Work remains while the partition's frontier is below what it may fetch.
const hasWork = (p: any, head: number) =>
  p.latestFetchedBlock < Math.min(head, p.mergeBlock ?? head);

const tick = (sim: Sim) => {
  sim.ticks += 1;
  // Pass the concurrency explicitly so the property holds at every cap, not
  // only the one the environment happens to set.
  const action = FetchState.getNextQuery(
    sim.fs,
    sim.head,
    1_000_000,
    false,
    sim.span,
    1,
    false,
    sim.concurrency,
  );
  sim.lastAdmitted = [];
  if (action?.TAG !== "Ready") return action;
  const queries: any[] = action._0;
  const free = sim.concurrency - sim.inFlight.length - sim.stuck.length;
  if (queries.length > free) {
    throw new Error(
      `tick ${sim.ticks} admitted ${queries.length} queries with ${free} free slots (cap ${sim.concurrency})`,
    );
  }
  FetchState.startFetchingQueries(sim.fs, queries);
  for (const q of queries) {
    sim.inFlight.push({ partitionId: q.partitionId, fromBlock: q.fromBlock, toBlock: q.toBlock, raw: q } as any);
  }
  sim.lastAdmitted = queries;
  return action;
};

// Lands one in-flight query as a full, empty response.
const land = (sim: Sim, index: number) => {
  const [q] = sim.inFlight.splice(index, 1);
  if (q === undefined) throw new Error(`no in-flight query at index ${index}`);
  const raw = (q as any).raw;
  const toBlock = q.toBlock ?? sim.head;
  sim.fs = FetchState.handleQueryResult(
    sim.fs,
    raw,
    Math.min(toBlock, sim.head),
    [],
  );
};

const allAtHead = (sim: Sim) =>
  partitionsOf(sim.fs).every((p) => p.latestFetchedBlock >= sim.head);

// Drives the simulation to completion, landing a drawn nonempty subset of the
// in-flight queries each tick so responses arrive out of order. Checks the
// per-tick fairness property on every tick and returns the tick count.
const run = (tc: any, sim: Sim, maxTicks: number) => {
  while (!allAtHead(sim)) {
    if (sim.ticks >= maxTicks) {
      const frontiers = partitionsOf(sim.fs)
        .map((p) => `${p.id}@${p.latestFetchedBlock}${p.mergeBlock !== undefined ? `->${p.mergeBlock}` : ""}`)
        .join(" ");
      throw new Error(`no liveness: ${maxTicks} ticks, head ${sim.head}, partitions ${frontiers}`);
    }
    const freeBefore = sim.concurrency - sim.inFlight.length - sim.stuck.length;
    const idleWithWork = partitionsOf(sim.fs)
      .filter((p) => hasWork(p, sim.head) && inFlightCount(p) === 0)
      .map((p) => p.id);
    tick(sim);
    // Fairness: gap fills are prerequisites and bypass the rounds, so only
    // forward work counts. If any idle partition with work got nothing while a
    // slot was free, no partition may have taken two.
    const freshByPartition = new Map<string, number>();
    for (const q of sim.lastAdmitted) {
      if (q.rangeReason === "gap_fill") continue;
      freshByPartition.set(q.partitionId, (freshByPartition.get(q.partitionId) ?? 0) + 1);
    }
    const served = new Set(sim.lastAdmitted.map((q) => q.partitionId));
    const passedOver = idleWithWork.filter((id) => !served.has(id));
    const deepest = Math.max(0, ...freshByPartition.values());
    if (freeBefore > 0 && passedOver.length > 0 && deepest > 1) {
      throw new Error(
        `tick ${sim.ticks}: partition(s) ${passedOver.join(",")} had work and nothing in flight, ` +
          `yet another partition was admitted ${deepest} fresh queries`,
      );
    }
    if (sim.inFlight.length > 0) {
      const landCount = tc.draw(gs.integers({ minValue: 1, maxValue: sim.inFlight.length }));
      for (let i = 0; i < landCount; i++) {
        const idx = tc.draw(gs.integers({ minValue: 0, maxValue: sim.inFlight.length - 1 }));
        land(sim, idx);
      }
    }
  }
  return { ticks: sim.ticks };
};

const totalChunks = (partitions: number, span: number, tailBlocks: number) =>
  (partitions - 1) * Math.ceil(PARTITION_SPACING / span) + Math.ceil(tailBlocks / span) + partitions;

describe("fetch scheduler liveness (fork-specific)", () => {
  test(
    "every partition reaches head with responses landing in any order, and no partition's pipeline depth takes a slot from an idle one",
    () => hegel.test((tc) => {
      const partitions = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
      const concurrency = tc.draw(gs.integers({ minValue: 1, maxValue: 8 }));
      const span = tc.draw(gs.sampledFrom([100, 2_500, 10_000, 20_000]));
      const tailBlocks = tc.draw(gs.integers({ minValue: 1, maxValue: 30_000 }));
      const sim = makeSim(partitions, span, concurrency, tailBlocks);
      // Each tick admits up to the free slots and lands at least one query, so
      // the whole range needs at most one tick per chunk plus a round per
      // partition to retire it. Anything beyond twice that is a stall.
      const budget = 2 * totalChunks(partitions, span, tailBlocks) + 4 * partitions + 20;
      const { ticks } = run(tc, sim, budget);
      expect(allAtHead(sim), `all partitions at head after ${ticks} ticks`).toBe(true);
    }, SETTINGS),
  );

  test(
    "queries that never resolve slow the chain but do not stop it while any slot is free",
    () => hegel.test((tc) => {
      const partitions = tc.draw(gs.integers({ minValue: 2, maxValue: 10 }));
      const concurrency = tc.draw(gs.integers({ minValue: 2, maxValue: 8 }));
      const stuckCount = tc.draw(gs.integers({ minValue: 1, maxValue: concurrency - 1 }));
      const span = tc.draw(gs.sampledFrom([2_500, 10_000, 20_000]));
      const sim = makeSim(partitions, span, concurrency, 5_000);
      // Admit once and freeze the first `stuckCount` queries forever.
      tick(sim);
      const frozen = sim.inFlight.splice(0, Math.min(stuckCount, sim.inFlight.length));
      sim.stuck.push(...frozen);
      const budget = 3 * totalChunks(partitions, span, 5_000) + 4 * partitions + 40;
      // A frozen query pins its partition's frontier forever, so those
      // partitions are excluded. Every other partition, retired ones included,
      // must still fetch everything up to its own ceiling (head, or its merge
      // block) within the budget. A retired partition with unfetched range is
      // stalled, not done.
      const stuckPartitions = new Set(frozen.map((q) => q.partitionId));
      const unstuckWithWork = () =>
        partitionsOf(sim.fs).filter((p) => !stuckPartitions.has(p.id) && hasWork(p, sim.head));
      let ticks = 0;
      while (ticks < budget && unstuckWithWork().length > 0) {
        ticks += 1;
        tick(sim);
        if (sim.inFlight.length > 0) {
          const idx = tc.draw(gs.integers({ minValue: 0, maxValue: sim.inFlight.length - 1 }));
          land(sim, idx);
        }
      }
      const stalled = unstuckWithWork().map(
        (p) => `${p.id}@${p.latestFetchedBlock}->${Math.min(sim.head, p.mergeBlock ?? sim.head)}`,
      );
      expect(
        stalled,
        `partitions still short of their ceiling after ${ticks} ticks behind ${stuckCount} stuck slot(s) at concurrency ${concurrency}`,
      ).toEqual([]);
    }, SETTINGS),
  );

  test(
    "a chain with every slot stuck recovers once the stuck queries are released",
    () => hegel.test((tc) => {
      const partitions = tc.draw(gs.integers({ minValue: 1, maxValue: 8 }));
      const concurrency = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
      const span = tc.draw(gs.sampledFrom([2_500, 10_000, 20_000]));
      const sim = makeSim(partitions, span, concurrency, 5_000);
      // Fill every slot and freeze all of them.
      for (let i = 0; i < 4 && sim.inFlight.length < concurrency; i++) tick(sim);
      sim.stuck.push(...sim.inFlight.splice(0));
      if (sim.stuck.length === concurrency) {
        const starved = tick(sim);
        expect(starved, "a fully stuck chain must admit nothing").not.toHaveProperty("TAG", "Ready");
      }
      // Release each stuck query through the runtime's own path. Each release
      // must find its query exactly once.
      for (const q of sim.stuck.splice(0)) {
        const released = FetchState.releaseInFlightQuery(sim.fs, q.partitionId, q.fromBlock);
        expect(released, `release of ${q.partitionId}@${q.fromBlock} returns its reservation`).toBe(
          (q as any).raw.itemsEst,
        );
        expect(
          FetchState.releaseInFlightQuery(sim.fs, q.partitionId, q.fromBlock),
          "a second release must find nothing",
        ).toBeUndefined();
      }
      const budget = 2 * totalChunks(partitions, span, 5_000) + 4 * partitions + 20;
      run(tc, sim, budget);
      expect(allAtHead(sim)).toBe(true);
    }, SETTINGS),
  );
});
