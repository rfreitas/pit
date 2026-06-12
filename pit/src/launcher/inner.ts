/**
 * pit inner mode — runs inside bwrap.
 *
 * Replicates the pi binary bootstrap then calls main() with pit's own
 * extensions registered as closures (no jiti, no --extension flags).
 */
import { main } from "@earendil-works/pi-coding-agent";
import { deletePitEscapeToken, deletePitSandboxed, bootstrapProcess } from "../env.ts";
import { createExtensionFactories } from "../extensions/index.ts";
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

  // Read and delete env vars before any child process is spawned
  const sandboxed = env.PIT_SANDBOXED === "1";
  deletePitSandboxed();

  const token = env.PIT_ESCAPE_TOKEN ?? "";
  deletePitEscapeToken();
  const socketPath = env.PIT_ESCAPE_SOCKET ?? "";

  await main(argv, {
    extensionFactories: createExtensionFactories(socketPath, token, sandboxed),
  });
};

// Entry point when run directly inside bwrap
await runInner(process.argv.slice(2), process.env);
