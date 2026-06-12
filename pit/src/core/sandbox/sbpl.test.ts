import { describe, it, expect } from "vitest";
import { buildSbplProfile } from "./sbpl.ts";
import type { SandboxMounts } from "../../types.ts";

const base = (): SandboxMounts => ({
  rw: [{ path: "/home/user/repo-wt-abc" }, { path: "/home/user/.pi/agent", label: "Pi config dir" }],
  readDeny: [],
  backend: "sandbox-exec",
});

describe("buildSbplProfile", () => {
  describe("structure", () => {
    it("starts with (version 1)", () => {
      expect(buildSbplProfile(base())).toMatch(/^\(version 1\)/);
    });

    it("contains (deny default)", () => {
      expect(buildSbplProfile(base())).toContain("(deny default)");
    });

    it("contains global (allow file-read*)", () => {
      expect(buildSbplProfile(base())).toContain("(allow file-read*)");
    });

    it("contains (allow process-exec) and (allow process-fork)", () => {
      const p = buildSbplProfile(base());
      expect(p).toContain("(allow process-exec)");
      expect(p).toContain("(allow process-fork)");
    });

    it("contains (allow network*)", () => {
      expect(buildSbplProfile(base())).toContain("(allow network*)");
    });

    it("contains AF_UNIX socket allow for pit-escape", () => {
      expect(buildSbplProfile(base())).toContain("(socket-domain AF_UNIX)");
    });

    it("always includes /private/tmp as writable", () => {
      expect(buildSbplProfile(base())).toContain('(subpath "/private/tmp")');
    });
  });

  describe("write grants", () => {
    it("emits (allow file-write* (subpath ...)) for each rw entry", () => {
      const p = buildSbplProfile(base());
      expect(p).toContain('(subpath "/home/user/repo-wt-abc")');
      expect(p).toContain('(subpath "/home/user/.pi/agent")');
    });

    it("no write grant section when rw is empty", () => {
      const p = buildSbplProfile({ ...base(), rw: [] });
      // /private/tmp is still there but no other write grants
      expect(p).not.toContain('(subpath "/home/user/repo-wt-abc")');
    });
  });

  describe("read denylist", () => {
    it("emits (deny file-read* (subpath ...)) for each readDeny entry", () => {
      const p = buildSbplProfile({
        ...base(),
        readDeny: [
          { path: "/home/user/.ssh",  label: "~/.ssh" },
          { path: "/home/user/.aws",  label: "~/.aws" },
        ],
      });
      expect(p).toContain('(deny file-read* (subpath "/home/user/.ssh"))');
      expect(p).toContain('(deny file-read* (subpath "/home/user/.aws"))');
    });

    it("no deny rules when readDeny is empty", () => {
      const p = buildSbplProfile({ ...base(), readDeny: [] });
      expect(p).not.toContain("(deny file-read*");
    });
  });

  describe("device nodes", () => {
    it("allows file-read* and file-write* on /dev/null", () => {
      // git and subprocesses open /dev/null for r+w on startup
      const p = buildSbplProfile(base());
      expect(p).toContain('(allow file-read* file-write* (literal "/dev/null"))');
    });

    it("allows file-read* and file-write* on /dev/tty", () => {
      const p = buildSbplProfile(base());
      expect(p).toContain('(allow file-read* file-write* (literal "/dev/tty"))');
    });

    it("allows pseudo-tty", () => {
      expect(buildSbplProfile(base())).toContain("(allow pseudo-tty)");
    });
  });

  describe("mach services", () => {
    it("includes com.apple.logd", () => {
      expect(buildSbplProfile(base())).toContain('"com.apple.logd"');
    });

    it("includes com.apple.mDNSResponder for DNS via getaddrinfo", () => {
      expect(buildSbplProfile(base())).toContain('"com.apple.mDNSResponder"');
    });

    it("includes com.apple.SecurityServer", () => {
      expect(buildSbplProfile(base())).toContain('"com.apple.SecurityServer"');
    });
  });

  describe("path escaping", () => {
    it("escapes paths with spaces", () => {
      const p = buildSbplProfile({
        ...base(),
        rw: [{ path: "/home/user/my repo" }],
      });
      expect(p).toContain('"/home/user/my repo"');
    });

    it("escapes paths with double quotes", () => {
      const p = buildSbplProfile({
        ...base(),
        rw: [{ path: '/home/user/a"b' }],
      });
      expect(p).toContain('"/home/user/a\\"b"');
    });
  });
});
