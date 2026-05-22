import { describe, it, expect } from "vitest";
import { formatStatus } from "../src/extensions/status/merge-status.ts";

describe("formatStatus", () => {
  it("in sync — 0 ahead, 0 behind", () => {
    expect(formatStatus(0, 0, "master")).toBe("in sync with master");
  });

  it("ahead only — singular", () => {
    expect(formatStatus(1, 0, "master")).toBe("1 commit ahead of master");
  });

  it("ahead only — plural", () => {
    expect(formatStatus(3, 0, "main")).toBe("3 commits ahead of main");
  });

  it("behind only — singular", () => {
    expect(formatStatus(0, 1, "master")).toBe("1 commit behind master");
  });

  it("behind only — plural", () => {
    expect(formatStatus(0, 4, "main")).toBe("4 commits behind main");
  });

  it("diverged — ahead and behind", () => {
    expect(formatStatus(2, 3, "master")).toBe("2 ahead · 3 behind master");
  });

  it("uses the actual parent branch name in all states", () => {
    expect(formatStatus(0, 0, "develop")).toBe("in sync with develop");
    expect(formatStatus(2, 0, "develop")).toBe("2 commits ahead of develop");
    expect(formatStatus(0, 2, "develop")).toBe("2 commits behind develop");
    expect(formatStatus(2, 2, "develop")).toBe("2 ahead · 2 behind develop");
  });
});
