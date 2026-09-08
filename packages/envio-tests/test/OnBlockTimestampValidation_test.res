open Vitest

let config = TestConfig.fromUserApi(`
name: timestamp-registration
chains:
  - id: 1
    start_block: 0
    contracts:
      - name: Token
        address: "0x1111111111111111111111111111111111111111"
        events:
          - event: Transfer(address indexed from, address indexed to, uint256 value)
`)

it("rejects timestamp opt-in without any event source registration", t => {
  HandlerRegister.resetOnEventRegistrations()
  HandlerRegister.startRegistration(~config)
  HandlerRegister.registerOnBlock(
    ~name="timestamp",
    ~where=%raw(`undefined`),
    ~includeTimestamp=true,
    ~handler=async _ => (),
    ~getChainsObject=_ => Dict.fromArray([("1", %raw(`{id: 1}`))]),
  )
  t->toThrowErrorEqual(
    () => HandlerRegister.finishRegistration(~config)->ignore,
    "includeTimestamp requires an event registration on the same chain",
  )
})
