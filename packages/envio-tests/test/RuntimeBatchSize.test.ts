import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

const coreModule = new URL("../node_modules/envio/src/Core.res.mjs", import.meta.url).href;
const configModule = new URL("../node_modules/envio/src/Config.res.mjs", import.meta.url).href;

const configYaml = `
name: runtime-batch-size
full_batch_size: 5000
contracts: []
chains:
  - id: 1
    rpc:
      url: https://rpc.example.test
    start_block: 1
`;

test("runtime processing batch override leaves the public config unchanged", () => {
  const script = `
    const Core = await import(${JSON.stringify(coreModule)});
    const Config = await import(${JSON.stringify(configModule)});
    const publicConfig = JSON.parse(Core.fromUserApi(undefined, undefined, undefined, undefined, ${JSON.stringify(configYaml)}).config);
    const config = Config.fromPublic(publicConfig);
    console.log(JSON.stringify({ batchSize: config.batchSize, fullBatchSize: publicConfig.fullBatchSize }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ENVIO_PROCESSING_BATCH_SIZE: "10000" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  expect(JSON.parse(out.trim().split("\n").pop() ?? "{}")).toEqual({
    batchSize: 10_000,
    fullBatchSize: 5_000,
  });
});
