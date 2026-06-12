import { describe, it, expect } from "vitest";
import { formatSandboxNote, buildSandboxMountSpec } from "./pure.ts";
import type { OverlayMount, SandboxMounts } from "../../types.ts";

// ── formatSandboxNote ─────────────────────────────────────────────────────────

describe("formatSandboxNote", () => {
  const rw  = (p: string, label?: string) => ({ path: p, label });
  const deny = (p: string, label?: string) => ({ path: p, label });
  const ov  = (src: string, dest: string, label?: string): OverlayMount => ({ src, dest, label });

  // ── unified mode (both platforms) ────────────────────────────────────────

  it("includes the backend in header", () => {
    expect(formatSandboxNote({ rw: [rw("/work")], readDeny: [], backend: "bwrap" }))
      .toContain("**Sandbox (bwrap):**");
    expect(formatSandboxNote({ rw: [rw("/work")], readDeny: [], backend: "sandbox-exec" }))
      .toContain("**Sandbox (sandbox-exec):**");
  });

  it("lists rw paths under Read-write", () => {
    const n = formatSandboxNote({ rw: [rw("/work"), rw("/cfg", "Pi config dir")], readDeny: [] });
    expect(n).toContain("`/work`");
    expect(n).toContain("`Pi config dir`");
    expect(n).toMatch(/Read-write:.*\/work/);
  });

  it("uses the literal path as label when no label is provided", () => {
    expect(formatSandboxNote({ rw: [rw("/some/worktree")], readDeny: [] })).toContain("`/some/worktree`");
  });

  it("deduplicates rw entries with the same label", () => {
    const n = formatSandboxNote({
      rw: [rw("/ext/foo.ts", "Pi extensions"), rw("/ext/bar.ts", "Pi extensions")],
      readDeny: [],
    });
    expect((n.match(/`Pi extensions`/g) ?? []).length).toBe(1);
  });

  it("with empty readDeny shows reads unrestricted", () => {
    expect(formatSandboxNote({ rw: [rw("/work")], readDeny: [] }))
      .toContain("Reads unrestricted");
  });

  it("lists denied paths in reads section", () => {
    const n = formatSandboxNote({
      rw: [rw("/work")],
      readDeny: [deny("/home/user/.ssh", "~/.ssh"), deny("/home/user/.aws", "~/.aws")],
    });
    expect(n).toContain("`~/.ssh`");
    expect(n).toContain("`~/.aws`");
    expect(n).toContain("Reads unrestricted except:");
  });

  it("footer says no write access", () => {
    expect(formatSandboxNote({ rw: [rw("/work")], readDeny: [] }))
      .toContain("No write access:");
  });

  it("no overlay section when overlay is absent", () => {
    expect(formatSandboxNote({ rw: [rw("/work")], readDeny: [] })).not.toContain("Ephemeral overlay");
  });

  it("no overlay section when overlay is empty array", () => {
    expect(formatSandboxNote({ rw: [rw("/work")], readDeny: [], overlay: [] })).not.toContain("Ephemeral overlay");
  });

  it("includes ephemeral overlay section when overlay mounts present", () => {
    const n = formatSandboxNote({
      rw: [rw("/work")], readDeny: [],
      overlay: [ov("/parent/node_modules", "/work/node_modules", "node_modules")],
    });
    expect(n).toContain("Ephemeral overlay");
    expect(n).toContain("`node_modules`");
  });

  it("overlay section falls back to dest path when no label", () => {
    const n = formatSandboxNote({
      rw: [rw("/work")], readDeny: [],
      overlay: [ov("/parent/node_modules", "/work/node_modules")],
    });
    expect(n).toContain("`/work/node_modules`");
  });

  it("deduplicates overlay entries that share a label", () => {
    const n = formatSandboxNote({
      rw: [], readDeny: [],
      overlay: [
        ov("/parent/a/node_modules", "/wt/a/node_modules", "node_modules"),
        ov("/parent/b/node_modules", "/wt/b/node_modules", "node_modules"),
      ],
    });
    expect((n.match(/`node_modules`/g) ?? []).length).toBe(1);
  });
});

// ── buildSandboxMountSpec ──────────────────────────────────────────────────────

describe("buildSandboxMountSpec", () => {
  const params = {
    home: "/home/user",
    cwd: "/work/project",
    agentDir: "/home/user/.pi",
    nodeDir: "/usr",
    gitRwMounts: [],
    overlayDirs: [],
  };

  it("includes worktree in rw", () => {
    const spec = buildSandboxMountSpec(params);
    expect(spec.rw.some(m => m.path === "/work/project" && m.label === "worktree")).toBe(true);
  });

  it("includes /tmp in rw", () => {
    const spec = buildSandboxMountSpec(params);
    expect(spec.rw.some(m => m.path === "/tmp" && m.label === "temp dir")).toBe(true);
  });

  it("includes agentDir in rw", () => {
    const spec = buildSandboxMountSpec(params);
    expect(spec.rw.some(m => m.path === "/home/user/.pi" && m.label === "Pi config dir")).toBe(true);
  });

  it("includes git rw mounts", () => {
    const spec = buildSandboxMountSpec({
      ...params,
      gitRwMounts: [{ path: "/repo/.git", label: "git" }],
    });
    expect(spec.rw.some(m => m.path === "/repo/.git")).toBe(true);
  });

  it("includes default credential paths in readDeny", () => {
    const spec = buildSandboxMountSpec(params);
    expect(spec.readDeny.some(m => m.path === "/home/user/.ssh")).toBe(true);
    expect(spec.readDeny.some(m => m.path === "/home/user/.aws")).toBe(true);
    expect(spec.readDeny.some(m => m.path === "/home/user/.gnupg")).toBe(true);
  });

  it("merges user denyRead config", () => {
    const spec = buildSandboxMountSpec({
      ...params,
      pitConfig: { sandbox: { denyRead: ["/custom/secret"] } },
    });
    expect(spec.readDeny.some(m => m.path === "/custom/secret")).toBe(true);
  });

  it("merges user allowWrite config", () => {
    const spec = buildSandboxMountSpec({
      ...params,
      pitConfig: { sandbox: { allowWrite: ["/extra/writable"] } },
    });
    expect(spec.rw.some(m => m.path === "/extra/writable")).toBe(true);
  });

  it("includes overlay dirs", () => {
    const spec = buildSandboxMountSpec({
      ...params,
      overlayDirs: [{ src: "/parent/nm", dest: "/work/nm", label: "node_modules" }],
    });
    expect(spec.overlay).toHaveLength(1);
    expect(spec.overlay![0].src).toBe("/parent/nm");
  });
});
