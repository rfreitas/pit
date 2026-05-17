/**
 * /rename-branch — rename the worktree branch based on what was actually built.
 *
 * Human-facing command, only active in pit sessions (PIT_ESCAPE_SOCKET is set).
 *
 * Uses git log + diff stat against the parent branch as the primary signal
 * (what was actually committed is more precise than chat history). Falls back
 * to conversation text when the branch has no commits yet.
 *
 * Branch ref updates must go through pit-escape (outside the sandbox):
 * refs/heads/ is shared state across all worktrees and is not rw-mounted in
 * the sandbox. The extension reads the current branch (worktree gitdir is
 * rw-mounted and readable), computes the new name, then delegates the actual
 * git branch -m to pit-escape.
 *
 * Note on session metadata: PitMetadata.branch in the session file becomes
 * stale after rename. This only matters if the worktree directory is deleted
 * and pit tries to recreate it — the resulting error ("branch no longer
 * exists") is clear enough for that edge case.
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { send, errMsg } from "../escape-client.ts";

// ── git context ────────────────────────────────────────────────────────────

type StateResponse = { parentBranch: string | null };

/**
 * Build context from the git diff against the parent branch.
 * Returns null if there is no parent branch or no commits yet.
 */
async function buildGitContext(socketPath: string): Promise<string | null> {
  const stateResp = await send(socketPath, { op: "get-state" });
  if ("error" in stateResp) return null;

  const { parentBranch } = stateResp as unknown as StateResponse;
  if (!parentBranch) return null;

  const [logResp, diffResp] = await Promise.all([
    send(socketPath, { op: "git", args: ["log", `${parentBranch}..HEAD`, "--oneline", "--max-count=20"] }),
    send(socketPath, { op: "git", args: ["diff", "--stat", `${parentBranch}...HEAD`] }),
  ]);

  const log  = !("error" in logResp)  && logResp.code  === 0 ? logResp.stdout.trim()  : "";
  const diff = !("error" in diffResp) && diffResp.code === 0 ? diffResp.stdout.trim() : "";

  if (!log) return null; // no commits yet — caller falls back to conversation

  const parts: string[] = [];
  if (log)  parts.push(`Commits:\n${log}`);
  if (diff) parts.push(`Files changed:\n${diff}`);
  return parts.join("\n\n");
}

// ── conversation fallback ──────────────────────────────────────────────────

type ContentBlock = { type?: string; text?: string };
type SessionEntry = { type: string; message?: { role?: string; content?: unknown } };

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function buildConversationText(entries: SessionEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;
    const { role, content } = entry.message;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(content).trim();
    if (text) lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  return lines.join("\n\n");
}

// ── prompt ─────────────────────────────────────────────────────────────────

const PROMPT = (context: string) => `\
You are a helpful assistant that names git branches.

Analyze the following context and respond with a short branch slug describing what was done or the topic.
Rules:
- Lowercase only
- Words separated by hyphens (no spaces, no underscores, no special characters)
- 2 to 5 words, max 40 characters total
- Must be a valid git branch name component

Respond ONLY with valid JSON matching this schema, no other text:
{"slug": string}

<context>
${context}
</context>`;

// ── branch helpers ─────────────────────────────────────────────────────────

function getCurrentBranch(cwd: string): string | null {
  try {
    const gitPath = path.join(cwd, ".git");
    if (fs.statSync(gitPath).isDirectory()) return null;
    const worktreeGitDir = fs.readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "");
    const head = fs.readFileSync(path.join(worktreeGitDir, "HEAD"), "utf8").trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;

  pi.registerCommand("rename-branch", {
    description: "Rename the worktree branch based on what was built (git diff) or the session topic",
    handler: async (_args, ctx) => {
      // Fail fast if we're not in a worktree
      const cwd = process.cwd();
      const currentBranch = getCurrentBranch(cwd);
      if (!currentBranch) {
        ctx.ui.notify("Could not read current branch — are you in a pit worktree?", "error");
        return;
      }

      const model = ctx.model;
      if (!model) {
        ctx.ui.notify("No active model", "warning");
        return;
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        ctx.ui.notify(auth.error, "warning");
        return;
      }

      // Primary: git diff against parent branch
      ctx.ui.notify("Building context...", "info");
      let context = await buildGitContext(socketPath);

      // Fallback: conversation text (branch has no commits yet)
      if (!context) {
        const entries = ctx.sessionManager.getBranch() as SessionEntry[];
        context = buildConversationText(entries);
      }

      if (!context.trim()) {
        ctx.ui.notify("Nothing to analyze yet — make some commits or start a conversation", "warning");
        return;
      }

      ctx.ui.notify("Asking the model for a branch name...", "info");

      const response = await complete(
        model,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: PROMPT(context) }],
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey: auth.apiKey ?? "", headers: auth.headers },
      );

      const raw = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");

      const match = raw.match(/\{[^}]*\}/s);
      if (!match) {
        ctx.ui.notify("Could not parse structured output from model", "error");
        return;
      }

      let parsed: { slug?: string };
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        ctx.ui.notify("Invalid JSON in model response", "error");
        return;
      }

      // Sanitise: lowercase, hyphens only, no leading/trailing hyphens, max 40 chars
      const slug = parsed.slug
        ?.trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);

      if (!slug) {
        ctx.ui.notify("Model returned an empty slug", "error");
        return;
      }

      // Preserve branch path prefix: "pi/fd9b759f" -> prefix "pi/", new branch "pi/<slug>"
      const lastSlash = currentBranch.lastIndexOf("/");
      const prefix = lastSlash !== -1 ? currentBranch.slice(0, lastSlash + 1) : "";
      const newBranch = prefix + slug;

      if (newBranch === currentBranch) {
        ctx.ui.notify(`Branch already named: ${currentBranch}`, "info");
        return;
      }

      // Delegate the actual git branch -m to pit-escape (refs/heads/ is not
      // rw-mounted in the sandbox — branch ref updates must go through the host)
      const resp = await send(socketPath, { op: "rename-branch", newBranch });

      if ("error" in resp || resp.code !== 0) {
        ctx.ui.notify(`Branch rename failed: ${errMsg(resp)}`, "error");
        return;
      }

      ctx.ui.notify(`Branch renamed: ${currentBranch} -> ${newBranch}`, "info");
    },
  });
}
