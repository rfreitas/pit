import { describe, it, expect } from "vitest";
import { formatSandboxNote, buildSandboxMountSpec } from "./pure.ts";
import type { OverlayMount, SandboxMounts } from "../../types.ts";

// ── formatSandboxNote ─────────────────────────────────────────────────────────

describe("formatSandboxNote", () => {
  const ro  = (p: string, label?: string) => ({ path: p, label });
  const rw  = (p: string, label?: string) => ({ path: p, label });
  const opt = (p: string, label?: string) => ({ path: p, label, optional: true as const });
  const ov  = (src: string, dest: string, label?: string): OverlayMount => ({ src, dest, label });

  // ── whitelist mode (bwrap / Linux) ────────────────────────────────────────

  it("whitelist: includes the bwrap header line", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")] })).toContain("**Sandbox (bwrap):**");
  });
  it("whitelist: backend field controls header name", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")], backend: "bwrap" }))
      .toContain("**Sandbox (bwrap):**");
  });
  it("whitelist: lists rw paths under Read-write", () => {
    const n = formatSandboxNote({ ro: [], rw: [rw("/work"), rw("/cfg", "Pi config dir")] });
    expect(n).toContain("`/work`");
    expect(n).toContain("`Pi config dir`");
    expect(n).toMatch(/Read-write:.*\/work/);
  });
  it("whitelist: lists ro paths under Read-only", () => {
    expect(formatSandboxNote({ ro: [ro("/usr", "system dirs"), ro("/etc", "system dirs")], rw: [] }))
      .toMatch(/Read-only:.*system dirs/);
  });
  it("whitelist: uses the literal path as label when no label is provided", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/some/worktree")] })).toContain("`/some/worktree`");
  });
  it("whitelist: deduplicates entries with the same label", () => {
    const n = formatSandboxNote({
      ro: [ro("/ext/foo.ts", "Pi extensions"), ro("/ext/bar.ts", "Pi extensions")],
      rw: [],
    });
    expect((n.match(/`Pi extensions`/g) ?? []).length).toBe(1);
  });
  it("whitelist: Read-write section always appears before Read-only section", () => {
    const n = formatSandboxNote({
      ro: [ro("/home", "home directory"), ro("/usr", "system dirs")],
      rw: [rw("/work"), rw("/cfg", "Pi config dir")],
    });
    expect(n.indexOf("Read-write")).toBeLessThan(n.indexOf("Read-only"));
  });
  it("whitelist: optional flag does not affect the label", () => {
    const required = formatSandboxNote({ ro: [ro("/lib", "system dirs")],  rw: [] });
    const optional = formatSandboxNote({ ro: [opt("/lib", "system dirs")], rw: [] });
    expect(required).toBe(optional);
  });
  it("whitelist: includes the no-access footer", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")] })).toContain("No access:");
  });
  it("whitelist: no overlay section when overlay is absent", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")] })).not.toContain("Ephemeral overlay");
  });
  it("whitelist: no overlay section when overlay is empty array", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")], overlay: [] })).not.toContain("Ephemeral overlay");
  });
  it("whitelist: includes ephemeral overlay section when overlay mounts present", () => {
    const n = formatSandboxNote({
      ro: [], rw: [rw("/work")],
      overlay: [ov("/parent/node_modules", "/work/node_modules", "node_modules")],
    });
    expect(n).toContain("Ephemeral overlay");
    expect(n).toContain("`node_modules`");
  });
  it("whitelist: overlay section falls back to dest path when no label", () => {
    const n = formatSandboxNote({
      ro: [], rw: [rw("/work")],
      overlay: [ov("/parent/node_modules", "/work/node_modules")],
    });
    expect(n).toContain("`/work/node_modules`");
  });
  it("whitelist: deduplicates overlay entries that share a label", () => {
    const n = formatSandboxNote({
      ro: [], rw: [],
      overlay: [
        ov("/parent/a/node_modules", "/wt/a/node_modules", "node_modules"),
        ov("/parent/b/node_modules", "/wt/b/node_modules", "node_modules"),
      ],
    });
    expect((n.match(/`node_modules`/g) ?? []).length).toBe(1);
  });

  // ── blacklist mode (sandbox-exec / macOS) ─────────────────────────────────

  it("blacklist: uses sandbox-exec header", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")], readDeny: [], backend: "sandbox-exec" }))
      .toContain("**Sandbox (sandbox-exec):**");
  });
  it("blacklist: lists rw paths under Read-write", () => {
    const n = formatSandboxNote({ ro: [], rw: [rw("/work")], readDeny: [], backend: "sandbox-exec" });
    expect(n).toContain("`/work`");
    expect(n).toMatch(/Read-write:.*\/work/);
  });
  it("blacklist: no Read-only section", () => {
    const n = formatSandboxNote({ ro: [ro("/usr")], rw: [], readDeny: [], backend: "sandbox-exec" });
    expect(n).not.toContain("Read-only:");
  });
  it("blacklist: with empty readDeny shows reads unrestricted", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")], readDeny: [], backend: "sandbox-exec" }))
      .toContain("Reads unrestricted");
  });
  it("blacklist: lists denied paths in reads section", () => {
    const n = formatSandboxNote({
      ro: [], rw: [rw("/work")],
      readDeny: [{ path: "/home/user/.ssh", label: "~/.ssh" }, { path: "/home/user/.aws", label: "~/.aws" }],
      backend: "sandbox-exec",
    });
    expect(n).toContain("`~/.ssh`");
    expect(n).toContain("`~/.aws`");
    expect(n).toContain("Reads unrestricted except:");
  });
  it("blacklist: footer says no write access", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")], readDeny: [], backend: "sandbox-exec" }))
      .toContain("No write access:");
  });
  it("blacklist: no Ephemeral overlay section (macOS feature gap)", () => {
    expect(formatSandboxNote({ ro: [], rw: [], readDeny: [], backend: "sandbox-exec" }))
      .not.toContain("Ephemeral overlay");
  });
});


