import { describe, it, expect } from "vitest";
import { parseNumstat, formatBranchStatus, type ParsedBranchStatus } from "./branch-status.ts";

// ── factory ───────────────────────────────────────────────────────────────────

const s = (overrides: Partial<ParsedBranchStatus> = {}): ParsedBranchStatus => ({
  aheadCount: 0, aheadInsertions: 0, aheadDeletions: 0, aheadBinaryFiles: 0,
  behindCount: 0, parentBranch: "main",
  stagedInsertions: 0, stagedDeletions: 0,
  unstagedInsertions: 0, unstagedDeletions: 0,
  detachedHead: false, mergeInProgress: false,
  ...overrides,
});

// ── parseNumstat ──────────────────────────────────────────────────────────────

describe("parseNumstat", () => {
  it("1. empty string → all zeros", () => {
    expect(parseNumstat("")).toEqual({ insertions: 0, deletions: 0, binaryFiles: 0 });
  });

  it("2. single text file", () => {
    expect(parseNumstat("5\t2\tfoo.ts\n")).toEqual({ insertions: 5, deletions: 2, binaryFiles: 0 });
  });

  it("3. multiple text files → sums correctly", () => {
    expect(parseNumstat("5\t2\ta.ts\n3\t1\tb.ts\n")).toEqual({ insertions: 8, deletions: 3, binaryFiles: 0 });
  });

  it("4. single binary file", () => {
    expect(parseNumstat("-\t-\timage.png\n")).toEqual({ insertions: 0, deletions: 0, binaryFiles: 1 });
  });

  it("5. multiple binary files", () => {
    expect(parseNumstat("-\t-\ta.png\n-\t-\tb.png\n")).toEqual({ insertions: 0, deletions: 0, binaryFiles: 2 });
  });

  it("6. mixed text and binary", () => {
    expect(parseNumstat("42\t7\tfoo.ts\n-\t-\timg.png\n")).toEqual({ insertions: 42, deletions: 7, binaryFiles: 1 });
  });

  it("7. file with zero insertions", () => {
    expect(parseNumstat("0\t5\tfoo.ts\n")).toEqual({ insertions: 0, deletions: 5, binaryFiles: 0 });
  });

  it("8. file with zero deletions", () => {
    expect(parseNumstat("5\t0\tfoo.ts\n")).toEqual({ insertions: 5, deletions: 0, binaryFiles: 0 });
  });

  it("9. trailing newline handled", () => {
    expect(parseNumstat("5\t2\tfoo.ts\n")).toEqual({ insertions: 5, deletions: 2, binaryFiles: 0 });
  });

  it("10. CRLF line endings", () => {
    expect(parseNumstat("5\t2\tfoo.ts\r\n")).toEqual({ insertions: 5, deletions: 2, binaryFiles: 0 });
  });
});

// ── formatBranchStatus ────────────────────────────────────────────────────────

describe("formatBranchStatus", () => {
  describe("normal states", () => {
    it("1. in sync, clean", () => {
      expect(formatBranchStatus(s())).toBe("in sync with main");
    });

    it("2. ahead only", () => {
      expect(formatBranchStatus(s({ aheadCount: 2, aheadInsertions: 42, aheadDeletions: 7 })))
        .toBe("2 commits ahead (+42 \u22127) of main");
    });

    it("3. behind only", () => {
      expect(formatBranchStatus(s({ behindCount: 3 }))).toBe("3 commits behind main");
    });

    it("4. ahead and behind", () => {
      expect(formatBranchStatus(s({ aheadCount: 2, aheadInsertions: 42, aheadDeletions: 7, behindCount: 3 })))
        .toBe("2 commits ahead (+42 \u22127) of main, 3 behind");
    });

    it("5. in sync + staged", () => {
      expect(formatBranchStatus(s({ stagedInsertions: 5 }))).toBe("in sync with main \u00b7 staged (+5)");
    });

    it("6. in sync + unstaged", () => {
      expect(formatBranchStatus(s({ unstagedInsertions: 3, unstagedDeletions: 1 })))
        .toBe("in sync with main \u00b7 unstaged (+3 \u22121)");
    });

    it("7. in sync + staged + unstaged", () => {
      expect(formatBranchStatus(s({ stagedInsertions: 5, unstagedInsertions: 3, unstagedDeletions: 1 })))
        .toBe("in sync with main \u00b7 staged (+5) \u00b7 unstaged (+3 \u22121)");
    });

    it("8. ahead + staged", () => {
      expect(formatBranchStatus(s({ aheadCount: 2, aheadInsertions: 42, aheadDeletions: 7, stagedInsertions: 5 })))
        .toBe("2 commits ahead (+42 \u22127) of main \u00b7 staged (+5)");
    });

    it("9. behind + staged + unstaged", () => {
      expect(formatBranchStatus(s({ behindCount: 3, stagedInsertions: 5, unstagedInsertions: 3, unstagedDeletions: 1 })))
        .toBe("3 commits behind main \u00b7 staged (+5) \u00b7 unstaged (+3 \u22121)");
    });

    it("10. full house", () => {
      expect(formatBranchStatus(s({
        aheadCount: 2, aheadInsertions: 42, aheadDeletions: 7,
        behindCount: 3, stagedInsertions: 5,
        unstagedInsertions: 3, unstagedDeletions: 1,
      }))).toBe("2 commits ahead (+42 \u22127) of main, 3 behind \u00b7 staged (+5) \u00b7 unstaged (+3 \u22121)");
    });
  });

  describe("LOC edge cases", () => {
    it("11. ahead with zero LOC and zero binary → explicit +0", () => {
      expect(formatBranchStatus(s({ aheadCount: 2 }))).toBe("2 commits ahead (+0) of main");
    });

    it("12. ahead with binary only", () => {
      expect(formatBranchStatus(s({ aheadCount: 2, aheadBinaryFiles: 2 })))
        .toBe("2 commits ahead (2 binary files) of main");
    });

    it("13. ahead with text and binary", () => {
      expect(formatBranchStatus(s({ aheadCount: 2, aheadInsertions: 42, aheadDeletions: 7, aheadBinaryFiles: 2 })))
        .toBe("2 commits ahead (+42 \u22127, 2 binary files) of main");
    });

    it("14. staged insertions only", () => {
      expect(formatBranchStatus(s({ stagedInsertions: 5 }))).toBe("in sync with main \u00b7 staged (+5)");
    });

    it("15. staged deletions only", () => {
      expect(formatBranchStatus(s({ stagedDeletions: 3 }))).toBe("in sync with main \u00b7 staged (\u22123)");
    });

    it("16. unstaged insertions only", () => {
      expect(formatBranchStatus(s({ unstagedInsertions: 5 }))).toBe("in sync with main \u00b7 unstaged (+5)");
    });

    it("17. unstaged deletions only", () => {
      expect(formatBranchStatus(s({ unstagedDeletions: 3 }))).toBe("in sync with main \u00b7 unstaged (\u22123)");
    });
  });

  describe("special states", () => {
    it("18. merge in progress, in sync", () => {
      expect(formatBranchStatus(s({ mergeInProgress: true })))
        .toBe("merge in progress \u00b7 in sync with main");
    });

    it("19. merge in progress, full house", () => {
      expect(formatBranchStatus(s({
        mergeInProgress: true,
        aheadCount: 2, aheadInsertions: 42, aheadDeletions: 7,
        behindCount: 3, stagedInsertions: 5,
        unstagedInsertions: 3, unstagedDeletions: 1,
      }))).toBe("merge in progress \u00b7 2 commits ahead (+42 \u22127) of main, 3 behind \u00b7 staged (+5) \u00b7 unstaged (+3 \u22121)");
    });

    it("20. no parent branch, clean → hidden", () => {
      expect(formatBranchStatus(s({ parentBranch: null }))).toBeUndefined();
    });

    it("21. no parent branch + dirty", () => {
      expect(formatBranchStatus(s({ parentBranch: null, stagedInsertions: 5 })))
        .toBe("staged (+5) \u00b7 no parent branch");
    });

    it("22. detached HEAD, clean → hidden", () => {
      expect(formatBranchStatus(s({ detachedHead: true }))).toBeUndefined();
    });

    it("23. detached HEAD + dirty", () => {
      expect(formatBranchStatus(s({ detachedHead: true, stagedInsertions: 5 })))
        .toBe("staged (+5) \u00b7 detached HEAD");
    });
  });

  describe("singular/plural", () => {
    it("24. 1 commit ahead", () => {
      expect(formatBranchStatus(s({ aheadCount: 1, aheadInsertions: 5 })))
        .toBe("1 commit ahead (+5) of main");
    });

    it("25. 2 commits ahead", () => {
      expect(formatBranchStatus(s({ aheadCount: 2, aheadInsertions: 5 })))
        .toBe("2 commits ahead (+5) of main");
    });

    it("26. 1 commit behind", () => {
      expect(formatBranchStatus(s({ behindCount: 1 }))).toBe("1 commit behind main");
    });

    it("27. 2 commits behind", () => {
      expect(formatBranchStatus(s({ behindCount: 2 }))).toBe("2 commits behind main");
    });

    it("28. 1 commit ahead, 1 binary file", () => {
      expect(formatBranchStatus(s({ aheadCount: 1, aheadBinaryFiles: 1 })))
        .toBe("1 commit ahead (1 binary file) of main");
    });

    it("29. 1 commit ahead, 2 binary files", () => {
      expect(formatBranchStatus(s({ aheadCount: 1, aheadBinaryFiles: 2 })))
        .toBe("1 commit ahead (2 binary files) of main");
    });

    it("30. combined, singular behind", () => {
      expect(formatBranchStatus(s({ aheadCount: 2, aheadInsertions: 42, aheadDeletions: 7, behindCount: 1 })))
        .toBe("2 commits ahead (+42 \u22127) of main, 1 behind");
    });
  });

  describe("consistency", () => {
    it("31. parent branch name flows through — master", () => {
      expect(formatBranchStatus(s({ parentBranch: "master", behindCount: 3 })))
        .toBe("3 commits behind master");
    });

    it("32. parent branch name flows through — develop", () => {
      expect(formatBranchStatus(s({ parentBranch: "develop", aheadCount: 1, aheadInsertions: 5 })))
        .toBe("1 commit ahead (+5) of develop");
    });
  });
});
