import { describe, it, expect } from "vitest";
import { useTmpDirs, makeGitRepo } from "../../tests/helpers.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../../tests/helpers.ts";
import { resolveUnversionedDirs, readPitConfig, writeFilteredSettings } from "./io.ts";

const { makeTmp, makeSandbox } = useTmpDirs();

// ── resolveUnversionedDirs ────────────────────────────────────────────────────
//
// Discovers unversioned directories (untracked + ignored) in a git repo.
// Uses `git ls-files --directory` so git recurses into tracked dirs to find
// nested unversioned ones while reporting each as a unit.

describe("resolveUnversionedDirs", () => {
  it("returns empty array for a non-git directory", async () => {
    expect(await run(resolveUnversionedDirs(makeTmp("pit-nongit-")))).toEqual([]);
  });
  it("returns empty array for a non-existent path", async () => {
    expect(await run(resolveUnversionedDirs("/nonexistent/path/pit-test-unversioned"))).toEqual([]);
  });
  it("returns empty array when no untracked or ignored dirs exist", async () => {
    expect(await run(resolveUnversionedDirs(makeGitRepo(makeTmp)))).toEqual([]);
  });
  it("does not return untracked files — only directories", async () => {
    // git ls-files marks dirs with a trailing slash; files have none.
    // resolveUnversionedDirs must filter to dirs only so callers don't
    // accidentally try to --tmp-overlay a regular file.
    const repo = makeGitRepo(makeTmp);
    fs.writeFileSync(path.join(repo, "untracked-file.txt"), "hello");
    fs.mkdirSync(path.join(repo, "untracked-dir"));
    const result = await run(resolveUnversionedDirs(repo));
    expect(result).toContain("untracked-dir");
    expect(result).not.toContain("untracked-file.txt");
  });
  it("does not return ignored files listed in .gitignore — only ignored dirs", async () => {
    // An ignored file should not appear; only the ignored directory should.
    const repo = makeGitRepo(makeTmp);
    fs.writeFileSync(path.join(repo, ".gitignore"), "*.log\nnode_modules/\n");
    fs.writeFileSync(path.join(repo, "debug.log"), "log content"); // ignored file
    fs.mkdirSync(path.join(repo, "node_modules"));
    const result = await run(resolveUnversionedDirs(repo));
    expect(result).toContain("node_modules");
    expect(result).not.toContain("debug.log");
  });
  it("returns an untracked directory (no .gitignore needed)", async () => {
    const repo = makeGitRepo(makeTmp);
    fs.mkdirSync(path.join(repo, "new-dir"));
    expect(await run(resolveUnversionedDirs(repo))).toContain("new-dir");
  });
  it("returns an ignored directory listed in .gitignore", async () => {
    const repo = makeGitRepo(makeTmp);
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    fs.mkdirSync(path.join(repo, "node_modules"));
    expect(await run(resolveUnversionedDirs(repo))).toContain("node_modules");
  });
  it("does not return tracked directories", async () => {
    const repo = makeGitRepo(makeTmp);
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "index.ts"), "");
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-m", "add src"], { stdio: "ignore" });
    expect(await run(resolveUnversionedDirs(repo))).not.toContain("src");
  });
  it("strips trailing slashes from git output", async () => {
    const repo = makeGitRepo(makeTmp);
    fs.mkdirSync(path.join(repo, "some-dir"));
    expect((await run(resolveUnversionedDirs(repo))).every((r) => !r.endsWith("/"))).toBe(true);
  });
  it("deduplicates when git would otherwise double-report", async () => {
    const repo = makeGitRepo(makeTmp);
    fs.mkdirSync(path.join(repo, "build"));
    const result = await run(resolveUnversionedDirs(repo));
    expect(result.filter((r) => r === "build").length).toBe(1);
  });
  it("finds nested unversioned dirs inside tracked directories", async () => {
    // packages/ is tracked; packages/foo/node_modules is ignored.
    const repo = makeGitRepo(makeTmp);
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    fs.mkdirSync(path.join(repo, "packages", "foo"), { recursive: true });
    fs.writeFileSync(path.join(repo, "packages", "foo", "package.json"), "{}");
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-m", "add packages"], { stdio: "ignore" });
    fs.mkdirSync(path.join(repo, "packages", "foo", "node_modules"));
    const result = await run(resolveUnversionedDirs(repo));
    expect(result).toContain("packages/foo/node_modules");
    expect(result).not.toContain("packages");
  });
  it("reports multiple unversioned dirs at different depths", async () => {
    const repo = makeGitRepo(makeTmp);
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\ndist/\n");
    fs.mkdirSync(path.join(repo, "node_modules"));
    fs.mkdirSync(path.join(repo, "dist"));
    fs.mkdirSync(path.join(repo, "packages", "bar"), { recursive: true });
    fs.writeFileSync(path.join(repo, "packages", "bar", "index.ts"), "");
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-m", "add packages"], { stdio: "ignore" });
    fs.mkdirSync(path.join(repo, "packages", "bar", "node_modules"));
    const result = await run(resolveUnversionedDirs(repo));
    expect(result).toContain("node_modules");
    expect(result).toContain("dist");
    expect(result).toContain("packages/bar/node_modules");
  });
});

// ── readPitConfig ─────────────────────────────────────────────────────────────
//
// Reads <pitDir>/config.json. Must return an empty object (not throw) for
// absent or malformed files.

describe("readPitConfig", () => {
  it("returns empty object when config.json does not exist", async () => {
    expect(await run(readPitConfig(makeSandbox("pit-config-")))).toEqual({});
  });
  it("parses denyPackages from config.json", async () => {
    const d = makeSandbox("pit-config-");
    fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ denyPackages: ["npm:@casualjim/pi-heimdall"] }));
    expect((await run(readPitConfig(d))).denyPackages).toEqual(["npm:@casualjim/pi-heimdall"]);
  });
  it("returns empty object for malformed JSON (does not throw)", async () => {
    const d = makeSandbox("pit-config-");
    fs.writeFileSync(path.join(d, "config.json"), "{ invalid json }");
    expect(await run(readPitConfig(d))).toEqual({});
  });
  it("returns empty object when denyPackages is absent from valid JSON", async () => {
    // Distinguishes "missing file" from "valid JSON without denyPackages key".
    // The function must not crash on missing key access.
    const d = makeSandbox("pit-config-");
    fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({}));
    expect((await run(readPitConfig(d))).denyPackages).toBeUndefined();
  });
});

// ── writeFilteredSettings ─────────────────────────────────────────────────────
//
// Reads settings.json, applies the denylist, and writes filtered result.

describe("writeFilteredSettings", () => {
  const rawSettings = {
    defaultModel: "claude-sonnet",
    packages: [
      "npm:@casualjim/pi-heimdall",
      "npm:@spences10/pi-confirm-destructive",
      "npm:pi-agent-browser-native",
    ],
  };

  it("writes a file at the given path", async () => {
    const agentDir = makeSandbox("pit-settings-agent-");
    const outDir = makeSandbox("pit-settings-out-");
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    const outPath = path.join(outDir, "settings.json");
    await run(writeFilteredSettings(agentDir, {}, outPath));
    expect(fs.existsSync(outPath)).toBe(true);
  });
  it("output is valid JSON", async () => {
    const agentDir = makeSandbox("pit-settings-agent-");
    const outDir = makeSandbox("pit-settings-out-");
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    await run(writeFilteredSettings(agentDir, {}, path.join(outDir, "settings.json")));
    expect(() => JSON.parse(fs.readFileSync(path.join(outDir, "settings.json"), "utf8"))).not.toThrow();
  });
  it("removes denied packages from the output", async () => {
    const agentDir = makeSandbox("pit-settings-agent-");
    const outDir = makeSandbox("pit-settings-out-");
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    const outPath = path.join(outDir, "settings.json");
    await run(writeFilteredSettings(agentDir, { denyPackages: ["npm:@casualjim/pi-heimdall"] }, outPath));
    const r = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(r.packages).not.toContain("npm:@casualjim/pi-heimdall");
    expect(r.packages).toContain("npm:pi-agent-browser-native");
  });
  it("with empty denylist, output packages match input exactly", async () => {
    const agentDir = makeSandbox("pit-settings-agent-");
    const outDir = makeSandbox("pit-settings-out-");
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    const outPath = path.join(outDir, "settings.json");
    await run(writeFilteredSettings(agentDir, {}, outPath));
    expect(JSON.parse(fs.readFileSync(outPath, "utf8")).packages).toEqual(rawSettings.packages);
  });
  it("creates parent directories if they don't exist", async () => {
    const agentDir = makeSandbox("pit-settings-agent-");
    const outDir = makeSandbox("pit-settings-out-");
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    const outPath = path.join(outDir, "nested", "deep", "settings.json");
    await run(writeFilteredSettings(agentDir, {}, outPath));
    expect(fs.existsSync(outPath)).toBe(true);
  });
  it("preserves non-packages keys in the output", async () => {
    // applyDenylist must not strip keys other than packages.
    const agentDir = makeSandbox("pit-settings-agent-");
    const outDir = makeSandbox("pit-settings-out-");
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    const outPath = path.join(outDir, "settings.json");
    await run(writeFilteredSettings(agentDir, { denyPackages: ["npm:@casualjim/pi-heimdall"] }, outPath));
    expect(JSON.parse(fs.readFileSync(outPath, "utf8")).defaultModel).toBe("claude-sonnet");
  });
  it("absent settings.json produces an empty object (no throw)", async () => {
    const agentDir = makeSandbox("pit-settings-agent-");
    const outDir = makeSandbox("pit-settings-out-");
    const outPath = path.join(outDir, "settings.json");
    await run(writeFilteredSettings(agentDir, {}, outPath));
    expect(JSON.parse(fs.readFileSync(outPath, "utf8"))).toEqual({});
  });
});
