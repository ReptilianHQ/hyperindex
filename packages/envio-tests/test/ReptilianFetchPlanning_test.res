open Vitest

let transferSighash = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

let buildRegistration = (~contractName, ~index) => {
  let registration = EventConfigBuilder.buildEvmOnEventRegistration(
    ~eventConfig=EventConfigBuilder.buildEvmEventConfig(
      ~contractName,
      ~eventName="Transfer",
      ~sighash=transferSighash,
      ~params=[
        {name: "from", abiType: "address", indexed: true},
        {name: "to", abiType: "address", indexed: true},
      ],
    ),
    ~isWildcard=false,
    ~handler=None,
    ~contractRegister=None,
    ~where=None,
    ~chainId=1->ChainId.fromInt,
    ~onEventBlockFilterSchema=Evm.make(~logger=Logging.getLogger()).onEventBlockFilterSchema,
  )
  {...registration, index}
}

let makePartition = (~id, ~contractName, ~registration, ~addresses): FetchState.partition => {
  id,
  latestFetchedBlock: {blockNumber: 100, blockTimestamp: 0},
  selection: FetchState.makeSelection(
    ~onEventRegistrations=[registration],
    ~dependsOnAddresses=true,
  ),
  addresses,
  mergeBlock: None,
  dynamicContract: Some(contractName),
  mutPendingQueries: [],
  sourceRangeCapacity: 25,
  prevSourceRangeCapacity: 25,
  eventDensity: Some(1.),
  latestSourceRangeCapacityUpdateBlock: 100,
}

describe("Reptilian fetch planning", () => {
  it("uses fixed source ranges only while backfilling", t => {
    t.expect([
      FetchState.getSourceBlocksPerRequest(~isRealtime=false, ~configured=Some(100)),
      FetchState.getSourceBlocksPerRequest(~isRealtime=true, ~configured=Some(100)),
    ]).toEqual([Some(100), None])
  })

  it("coalesces compatible address-bound contract partitions", t => {
    let store = AddressStore.make(
      ~ecosystem=Ecosystem.Evm,
      ~shouldChecksum=false,
      ~contracts=[
        {name: "Token", startBlock: None, dependsOnAddresses: true},
        {name: "Pool", startBlock: None, dependsOnAddresses: true},
      ],
    )
    let _ = store->AddressStore.registerBatch([
      {
        address: "0x1111111111111111111111111111111111111111"->Address.unsafeFromString,
        contractName: "Token",
        registrationBlock: -1,
      },
      {
        address: "0x2222222222222222222222222222222222222222"->Address.unsafeFromString,
        contractName: "Pool",
        registrationBlock: -1,
      },
    ])
    let tokenRegistration = buildRegistration(~contractName="Token", ~index=1)
    let poolRegistration = buildRegistration(~contractName="Pool", ~index=2)
    let dynamicContracts = Utils.Set.make()
    dynamicContracts->Utils.Set.add("Token")->ignore
    dynamicContracts->Utils.Set.add("Pool")->ignore

    let optimized = FetchState.OptimizedPartitions.make(
      ~partitions=[
        makePartition(
          ~id="0",
          ~contractName="Token",
          ~registration=(tokenRegistration :> Internal.onEventRegistration),
          ~addresses=store->AddressStore.makeSet(~contractName="Token"),
        ),
        makePartition(
          ~id="1",
          ~contractName="Pool",
          ~registration=(poolRegistration :> Internal.onEventRegistration),
          ~addresses=store->AddressStore.makeSet(~contractName="Pool"),
        ),
      ],
      ~maxAddrInPartition=5_000,
      ~nextPartitionIndex=2,
      ~dynamicContracts,
      ~clientFilteredContracts=Utils.Set.make(),
    )
    let partition =
      optimized->FetchState.OptimizedPartitions.getOrThrow(
        ~partitionId=optimized.idsInAscOrder->Utils.Array.firstUnsafe,
      )
    let contracts = partition.addresses->AddressSet.contractNames
    contracts->Array.sort(String.compare)->ignore

    t.expect({
      "partitions": optimized->FetchState.OptimizedPartitions.count,
      "addresses": partition.addresses->AddressSet.size,
      "contracts": contracts,
      "registrations": partition.selection.onEventRegistrations->Array.length,
    }).toEqual({
      "partitions": 1,
      "addresses": 2,
      "contracts": ["Pool", "Token"],
      "registrations": 2,
    })
  })
})
