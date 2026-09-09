open Vitest

type row = {id: string, value: int}
type numericRow = {id: bigint, value: int}
type ops<'row, 'id> = {set: 'row => unit, deleteUnsafe: 'id => unit}
type context = {
  @as("Entry") entry: ops<row, string>,
  @as("NumericEntry") numericEntry: ops<numericRow, bigint>,
}

let scenario = Scenario.make(
  ~configYaml=`
name: ordered-entity-writes
disable_default_cross_chain: true
storage:
  postgres:
    column_name_format: snake_case
chains:
  - id: 1337
    rpc:
      url: https://rpc.example.test
      for: sync
    start_block: 1
    contracts:
      - name: Token
        address: "0x0000000000000000000000000000000000000001"
        events:
          - event: "Transfer()"
`,
  ~schema=`
type Entry {
  id: ID!
  value: Int!
}
type NumericEntry {
  id: BigInt!
  value: Int!
}
`,
  ~unsupported=[
    {backend: #memory, reason: "checks physical Postgres insertion order"},
    {backend: #clickhouse, reason: "checks the Postgres-only bulk insert path"},
  ],
)

scenario->Scenario.it(
  "orders deduplicated entity writes by typed primary key and preserves later updates and deletes",
  ~sources=[{chain: 1337}],
  async (~t, ~indexer, ~source) => {
    let source = source(1337)
    source.resolveGetHeightOrThrow(1000)
    source.resolveGetItemsOrThrow(
      [
        {
          blockNumber: 5,
          logIndex: 0,
          handler: async args => {
            let context = args.context->(Utils.magic: Internal.handlerContext => context)
            [10, 2, 1]->Array.forEach(i => {
              context.entry.set({id: i->Int.toString, value: i})
              context.numericEntry.set({
                id: i->Int.toString->BigInt.fromString->Option.getOrThrow,
                value: i,
              })
            })
            context.entry.set({id: "2", value: 22})
            context.entry.set({id: "removed", value: 0})
            context.entry.deleteUnsafe("removed")
          },
        },
      ],
      ~latestFetchedBlockNumber=100,
    )
    await indexer.getBatchWritePromise()
    await indexer.waitUntilIdle()
    let {sql, pgSchema} = indexer->IndexerRunner.pgOrThrow
    let textOrder: array<{
      "id": string,
      "value": int,
      "chain_id": int,
    }> = await sql->Postgres.unsafe(
      `SELECT id, value, chain_id FROM "${pgSchema}"."Entry" ORDER BY ctid`,
    )
    let numericOrder: array<{
      "id": string,
    }> = await sql->Postgres.unsafe(
      `SELECT id::text FROM "${pgSchema}"."NumericEntry" ORDER BY ctid`,
    )
    source.resolveGetItemsOrThrow(
      [
        {
          blockNumber: 101,
          logIndex: 0,
          handler: async args => {
            let context = args.context->(Utils.magic: Internal.handlerContext => context)
            context.entry.set({id: "10", value: 100})
            context.entry.deleteUnsafe("1")
            context.entry.set({id: "3", value: 3})
          },
        },
      ],
      ~latestFetchedBlockNumber=200,
    )
    await indexer.getBatchWritePromise()
    await indexer.waitUntilIdle()
    let finalRows: array<{
      "id": string,
      "value": int,
    }> = await sql->Postgres.unsafe(`SELECT id, value FROM "${pgSchema}"."Entry" ORDER BY id`)
    t.expect((textOrder, numericOrder, finalRows)).toEqual((
      [
        {"id": "1", "value": 1, "chain_id": 1337},
        {"id": "10", "value": 10, "chain_id": 1337},
        {"id": "2", "value": 22, "chain_id": 1337},
      ],
      [{"id": "1"}, {"id": "2"}, {"id": "10"}],
      [{"id": "10", "value": 100}, {"id": "2", "value": 22}, {"id": "3", "value": 3}],
    ))
  },
)
