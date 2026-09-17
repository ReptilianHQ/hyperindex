open Vitest
@module("./helpers/PartitionCoverageWorld.ts")
external installWorld: MockHyperSyncServer.t => unit = "installWorld"
let server = MockHyperSyncServer.make(~height=400)
installWorld(server)
afterAll(() => server->MockHyperSyncServer.close)
let addr = n => "0x" ++ n->Int.toString->String.padStart(40, "0")
// https://github.com/ReptilianHQ/reptilian/issues/2087
let _ = InternalTestIndexer.fromUserApi(
 ~configYaml=`
name: v15-threshold
rollback_on_reorg: false
chains:
  - id: 1
    start_block: 1
    max_reorg_depth: 0
    hypersync_config:
      url: ${server->MockHyperSyncServer.url}
    contracts:
      - name: Factory
        start_block: 1
        address: "${addr(1)}"
        events:
          - event: Launch(uint256 indexed n)
      - name: Token
        address: ["${addr(2)}", "${addr(3)}"]
        events:
          - event: Ping()
      - name: Curve
        address: "${addr(4)}"
        events:
          - event: Ping()
`,
 ~schema=`type Seen { id: ID! }`,
 ~handlers=`
import {indexer, type Address} from "envio";
indexer.contractRegister({contract:"Factory",event:"Launch"}, async ({event,context})=>{
 const n=Number(event.params.n);
 context.chain.Token.add(("0x"+String(100+n).padStart(40,"0")) as Address);
 context.chain.Curve.add(("0x"+String(200+n).padStart(40,"0")) as Address);
});
indexer.onEvent({contract:"Factory",event:"Launch"},async ({event,context})=>context.Seen.set({id:String(event.params.n)}));
indexer.onEvent({contract:"Token",event:"Ping"},async ({event,context})=>context.Seen.set({id:"Token:"+event.block.number+":"+event.logIndex}));
indexer.onEvent({contract:"Curve",event:"Ping"},async ({event,context})=>context.Seen.set({id:"Curve:"+event.block.number+":"+event.logIndex}));
`,
 ~test=`
import {it,expect} from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {createTestIndexer} from "envio";
import {configureWorld, filteringWasUsed} from "../helpers/PartitionCoverageWorld";

for (const resumed of [false, true]) {
 it(resumed ? "Hegel: resumed replay retains every contract stream" : "Hegel: client-filter crossing retains every contract stream", () => hegel.testAsync(async tc => {
   const launches = tc.draw(gs.integers({minValue:30,maxValue:35}));
   const pageSpan = tc.draw(gs.integers({minValue:5,maxValue:10}));
   const delaySeed = tc.draw(gs.integers({minValue:7,maxValue:15}));
   const split = tc.draw(gs.integers({minValue:41,maxValue:launches*10}));
   const expected = configureWorld({launches,pageSpan,delaySeed});
   const indexer = createTestIndexer();
   if (resumed) {
     await indexer.process({chains:{1:{endBlock:split}}});
     await indexer.process({chains:{1:{startBlock:split+1,endBlock:400}}});
   } else {
     await indexer.process({chains:{1:{endBlock:400}}});
   }
   expect({
     events: await Promise.all(expected.map(row=>indexer.Seen.get(row.id))),
     clientFiltering: filteringWasUsed(),
   }).toEqual({events:expected,clientFiltering:true});
 }, {
   testCases:20,
   seed:150909,
   reportMultipleFailures:false,
   // Each generated input executes a full HTTP replay; retain the Vitest deadline.
   suppressHealthCheck:[hegel.HealthCheck.TooSlow],
 }), 120000);
}
`,
)
