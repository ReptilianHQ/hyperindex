type Server = {
  pushResponse(spec: string): void;
  takeQueries(): string[];
};
let server: Server;

export function installWorld(value: Server): void {
  server = value;
}

const address = (n: number) => "0x" + String(n).padStart(40, "0");
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const launchTopic = "0xa72e5e150ebe7b67363131cf1d5e72a8053adc58eb1879467ebd529ae3d4ecca";
const pingTopic = "0xca6e822df923f741dfe968d15d80a18abd25bd1e748bcb9ad81fea5bbb7386af";

export function configureWorld({ launches, pageSpan, delaySeed }: {
  launches: number;
  pageSpan: number;
  delaySeed: number;
}) {
  const logs: Record<string, unknown>[] = [];
  const expected: { id: string }[] = [];
  for (let n = 1; n <= launches; n++) {
    logs.push({
      block_number: n * 10,
      log_index: 0,
      transaction_index: 0,
      transaction_hash: hash(n),
      address: address(1),
      topic0: launchTopic,
      topic1: hash(n),
      data: "0x",
    });
    expected.push({ id: String(n) });
    for (let j = 1; j <= 3; j++) {
      for (let k = 1; k <= 2; k++) {
        logs.push({
          block_number: n * 10 + j,
          log_index: k,
          transaction_index: 0,
          transaction_hash: hash(n),
          address: address(k * 100 + n),
          topic0: pingTopic,
          data: "0x",
        });
        expected.push({ id: (k === 1 ? "Token" : "Curve") + ":" + (n * 10 + j) + ":" + k });
      }
    }
  }
  server.takeQueries();
  server.pushResponse(JSON.stringify({
    filterByQuery: true,
    pageSpan,
    delaySeed,
    logs,
    blocks: Array.from({ length: 400 }, (_, i) => ({
      number: i + 1,
      timestamp: 1700000000,
      hash: hash(i + 1),
    })),
  }));
  return expected;
}

export function filteringWasUsed(): boolean {
  return server.takeQueries().some(raw => {
    const query = JSON.parse(raw) as { logs?: { address?: string[] }[] };
    return query.logs?.some(selection => !selection.address?.length) ?? false;
  });
}
