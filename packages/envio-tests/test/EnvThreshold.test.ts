// The client-filter threshold must not move with ENVIO_MAX_CHAIN_CONCURRENCY.
// Env resolves at import time, so the knob is set in a child process that
// imports Env fresh; an in-process assertion could never see the coupling.
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

const envModule = new URL("../node_modules/envio/src/Env.res.mjs", import.meta.url).href;

const resolveEnv = (overrides: Record<string, string>) => {
  const script =
    `const m = await import(${JSON.stringify(envModule)});` +
    `console.log(JSON.stringify({ threshold: m.clientFilterAddressThreshold, chainConcurrency: m.maxChainConcurrency, partitionSize: m.maxAddrInPartition }));`;
  const env = { ...process.env, ...overrides };
  delete env.ENVIO_CLIENT_FILTER_ADDRESS_THRESHOLD;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop() ?? "{}");
};

test("client-filter threshold ignores ENVIO_MAX_CHAIN_CONCURRENCY", () => {
  // The old formula gave 20,000 at concurrency 8 and 2,500 at 1. Both must
  // now read the upstream-derived default, while the knob itself still takes.
  const at8 = resolveEnv({ ENVIO_MAX_CHAIN_CONCURRENCY: "8" });
  const at1 = resolveEnv({ ENVIO_MAX_CHAIN_CONCURRENCY: "1" });
  expect({ at8, at1 }).toEqual({
    at8: { threshold: 250_000, chainConcurrency: 8, partitionSize: 5_000 },
    at1: { threshold: 250_000, chainConcurrency: 1, partitionSize: 5_000 },
  });
});

test("client-filter threshold still follows an explicit override", () => {
  const script =
    `const m = await import(${JSON.stringify(envModule)});` +
    `console.log(m.clientFilterAddressThreshold);`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ENVIO_MAX_CHAIN_CONCURRENCY: "8", ENVIO_CLIENT_FILTER_ADDRESS_THRESHOLD: "42000" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(Number(out.trim().split("\n").pop())).toBe(42_000);
});
