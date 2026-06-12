/**
 * Process environment mutations for pit.
 *
 * Isolated here so functional/immutable-data is disabled in one place
 * rather than scattered across program.ts.
 */

export const setPitEscapeSocket = (path: string): void => {
  process.env.PIT_ESCAPE_SOCKET = path;
};

export const deletePitEscapeToken = (): void => {
  delete process.env.PIT_ESCAPE_TOKEN;
};

export const deletePitSandboxed = (): void => {
  delete process.env.PIT_SANDBOXED;
};

export const bootstrapProcess = (): void => {
  process.title = "pi";
  process.emitWarning = () => {};
};
