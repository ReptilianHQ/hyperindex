process.env.ENVIO_API_TOKEN ||= "offline-tests";

// Ensure cargo is on PATH so loadDevAddon can build the NAPI addon when the
// Hegel property tests import FetchState/AddressStore from the local source.
import { homedir } from "node:os";
import { join } from "node:path";
const cargoBin = join(homedir(), ".cargo", "bin");
if (!process.env.PATH?.includes(cargoBin)) {
  process.env.PATH = cargoBin + ":" + (process.env.PATH ?? "");
}

await import("envio/src/Env.res.mjs");
