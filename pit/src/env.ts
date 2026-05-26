/**
 * Process environment mutations for pit.
 *
 * Isolated here so functional/immutable-data is disabled in one place
 * rather than scattered across program.ts.
 */

export const setPitEscapeSocket = (path: string): void => {
  process.env.PIT_ESCAPE_SOCKET = path;
};

export const setPitIsInner = (): void => {
  process.env.PIT_IS_INNER = "1";
};

export const deletePitIsInner = (): void => {
  delete process.env.PIT_IS_INNER;
};

export const setPitEscapeToken = (token: string): void => {
  process.env.PIT_ESCAPE_TOKEN = token;
};

export const deletePitEscapeToken = (): void => {
  delete process.env.PIT_ESCAPE_TOKEN;
};
