/**
 * pit inner mode — runs inside bwrap.
 *
 * Replicates the pi binary bootstrap then calls main() with pit's own
 * extensions registered as closures (no jiti, no --extension flags).
 */
import * as undici from "undici";
import { main } from "@earendil-works/pi-coding-agent";
import { deletePitEscapeToken, deletePitIsInner, bootstrapProcess } from "./env.ts";
import { createExtensionFactories } from "./extensions/index.ts";

/**
 * Bootstrap and run inner pit.
 * Exported so inner.test.ts can call it directly with controlled env/argv.
 */
export const runInner = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> => {
  // Bootstrap — mirrors what the pi binary does before calling main()
  bootstrapProcess();
  undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({
    allowH2: false,
    bodyTimeout: 300_000,
    headersTimeout: 300_000,
  }));
  undici.install?.();

  // Read and delete env vars before any child process is spawned
  deletePitIsInner();
  const token = env.PIT_ESCAPE_TOKEN ?? "";
  deletePitEscapeToken();
  const socketPath = env.PIT_ESCAPE_SOCKET ?? "";

  await main(argv, {
    extensionFactories: createExtensionFactories(socketPath, token),
  });
};

// Entry point when run directly inside bwrap
await runInner(process.argv.slice(2), process.env);
