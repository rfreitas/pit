import { describe, it, expect } from "vitest";
import { formatLoc } from "../extensions/status/loc-diff.ts";

describe("formatLoc", () => {
  it("returns undefined when both are zero", () => {
    expect(formatLoc(0, 0)).toBeUndefined();
  });

  it("shows only insertions when deletions are zero", () => {
    expect(formatLoc(42, 0)).toBe("+42");
  });

  it("shows only deletions when insertions are zero", () => {
    expect(formatLoc(0, 7)).toBe("\u22127");
  });

  it("shows both when non-zero", () => {
    expect(formatLoc(42, 7)).toBe("+42 \u22127");
  });

  it("handles singular counts", () => {
    expect(formatLoc(1, 0)).toBe("+1");
    expect(formatLoc(0, 1)).toBe("\u22121");
    expect(formatLoc(1, 1)).toBe("+1 \u22121");
  });

  it("handles large counts", () => {
    expect(formatLoc(1000, 999)).toBe("+1000 \u2212999");
  });
});
