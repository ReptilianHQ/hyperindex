open Vitest

let server = MockHyperSyncServer.make(~height=13)
afterAll(() => {
  let queries = server->MockHyperSyncServer.takeQueries
  server->MockHyperSyncServer.close
  expect(
    queries->Array.map(query => {
      let obj = query->JSON.Decode.object->Option.getOrThrow
      (obj->Dict.get("from_block"), obj->Dict.get("to_block"), obj->Dict.get("include_all_blocks"))
    }),
  ).toEqual([
    (Some(JSON.Number(10.)), Some(JSON.Number(11.)), None),
    (Some(JSON.Number(11.)), Some(JSON.Number(13.)), Some(JSON.Boolean(true))),
    (Some(JSON.Number(13.)), Some(JSON.Number(14.)), None),
  ])
})
server->MockHyperSyncServer.pushResponse({nextBlock: 11})
server->MockHyperSyncServer.pushResponse({
  blocks: [11, 12]->Array.map(number =>
    JSON.parseOrThrow(
      `{"number":${number->Int.toString},"timestamp":${(1700000000 + number)
          ->Int.toString},"hash":"0x${number->Int.toString->String.padStart(64, "0")}"}`,
    )
  ),
  nextBlock: 13,
})

let _ = InternalTestIndexer.fromUserApi(
  ~configYaml=`
name: onblock-source-timestamps
rollback_on_reorg: false
chains:
  - id: 1
    start_block: 10
    max_reorg_depth: 0
    hypersync_config:
      url: ${server->MockHyperSyncServer.url}
    contracts:
      - name: Token
        address: "0x1111111111111111111111111111111111111111"
        events:
          - event: Transfer(address indexed from, address indexed to, uint256 value)
`,
  ~schema=`
type BlockClock {
  id: ID!
  timestamp: Int!
  preloaded: Boolean!
}
`,
  ~handlers=`
import { indexer } from "envio";
const preloaded = new Set<number>();
indexer.onEvent({ contract: "Token", event: "Transfer" }, async () => {});
indexer.onBlock({ name: "clock", includeTimestamp: true, where: () => ({ block: { number: { _gte: 11, _lte: 12 } } }) }, async ({ block, context }) => {
  if (block.timestamp === undefined) throw new Error("Missing source timestamp");
  if (context.isPreload) { preloaded.add(block.number); return; }
  context.BlockClock.set({ id: String(block.number), timestamp: block.timestamp, preloaded: preloaded.has(block.number) });
});
indexer.onBlock({ name: "number-only" }, async ({ block }) => {
  if (block.timestamp !== undefined) throw new Error("Unexpected timestamp without opt-in");
});
`,
  ~test=`
import { it } from "vitest";
import { createTestIndexer } from "envio";
it("delivers actual timestamps for empty blocks without RPC", async (t) => {
  const indexer = createTestIndexer();
  await indexer.process({ chains: { 1: { endBlock: 10 } } });
  await indexer.process({ chains: { 1: { startBlock: 11, endBlock: 12 } } });
  await indexer.process({ chains: { 1: { startBlock: 13, endBlock: 13 } } });
  t.expect(await Promise.all([10, 11, 12].map(n => indexer.BlockClock.get(String(n)))))
    .toEqual([undefined, ...[11, 12].map(n => ({ id: String(n), timestamp: 1700000000 + n, preloaded: true }))]);
});
`,
)
