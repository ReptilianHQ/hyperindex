// Offline runs build HyperSync sources without a real token; the live tests
// (RpcSource, SourceBlockHashes, HyperSync*) recognise this placeholder and
// skip themselves.
process.env.ENVIO_API_TOKEN ||= "offline-tests";

// This public-API fixture uses a real local HyperSync server, whose request
// decoder accepts JSON. Set its process-local transport before Env is loaded.
const { expect } = await import("vitest");
if (expect.getState().testPath?.endsWith("/OnBlockTimestamp_test.res.mjs")) {
  process.env.ENVIO_API_TOKEN = "00000000-0000-0000-0000-000000000000";
  process.env.ENVIO_HYPERSYNC_CLIENT_SERIALIZATION_FORMAT = "Json";
  process.env.ENVIO_HYPERSYNC_CLIENT_ENABLE_QUERY_CACHING = "false";
}

// Importing Env triggers Logging.setLogger as a side effect,
// ensuring the logger is available for all tests.
// A dynamic import: a static one is hoisted above the env default.
await import("envio/src/Env.res.mjs");
