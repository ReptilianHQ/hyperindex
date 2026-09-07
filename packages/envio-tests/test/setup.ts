// Offline runs build HyperSync sources without a real token; the live tests
// (RpcSource, SourceBlockHashes, HyperSync*) recognise this placeholder and
// skip themselves.
process.env.ENVIO_API_TOKEN ||= "offline-tests";

// Importing Env triggers Logging.setLogger as a side effect,
// ensuring the logger is available for all tests.
// A dynamic import: a static one is hoisted above the env default.
await import("envio/src/Env.res.mjs");
