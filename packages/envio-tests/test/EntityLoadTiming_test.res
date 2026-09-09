let _ = InternalTestIndexer.fromUserApi(
  ~configYaml=`
name: entity-load-timing
chains:
  - id: 1
    start_block: 0
    contracts:
      - name: Token
        address: "0x1111111111111111111111111111111111111111"
        events:
          - event: Transfer(address indexed from, address indexed to, uint256 value)
`,
  ~schema=`
type Account {
  id: ID!
  balance: BigInt!
}
`,
  ~handlers=`
import { indexer } from "envio";
indexer.onEvent({ contract: "Token", event: "Transfer" }, async ({ event, context }) => {
  const existing = await context.Account.get(event.params.to);
  await context.Account.getWhere({ balance: { _gt: 0n } });
  context.Account.set({ id: event.params.to, balance: (existing?.balance ?? 0n) + event.params.value });
});
`,
  ~test=`
import { it } from "vitest";
import { createTestIndexer, TestHelpers } from "envio";

it("observes a handler's entity read separately from initialization", async (t) => {
  const symbol = Symbol.for("dlmm.chain-indexer.trace-entity-load");
  const host = globalThis as unknown as Record<symbol, unknown>;
  const previous = host[symbol];
  const seen: string[] = [];
  host[symbol] = (operation: string, step: string, callback: () => unknown) => {
    seen.push(operation + ":" + step);
    return callback();
  };
  try {
    const indexer = createTestIndexer();
    const to = TestHelpers.Addresses.defaultAddress;
    await indexer.process({ chains: { 1: { simulate: [{ contract: "Token", event: "Transfer",
      params: { from: TestHelpers.Addresses.mockAddresses[1], to, value: 5n } }] } } });
    const observed = [...seen];
    const account = await indexer.Account.getOrThrow(to);
    t.expect({ observed, account }).toEqual({
      observed: ["Account.get:read", "Account.get:initialize", "Account.getWhere:index_prepare", "Account.getWhere:read", "Account.getWhere:initialize"],
      account: { id: to, balance: 5n },
    });
  } finally {
    if (previous === undefined) delete host[symbol]; else host[symbol] = previous;
  }
});
`,
)
