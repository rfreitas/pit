/**
 * /rename-branch — rename the worktree branch based on the session topic.
 *
 * Only active in pit sessions (PIT_ESCAPE_SOCKET is set, confirming a
 * worktree session is running).
 *
 * Does NOT need pit-escape for the actual rename. The bwrap sandbox already
 * mounts refs/heads/<prefix>/ as read-write, and git updates the worktree
 * HEAD file automatically when a branch is renamed. So `git branch -m` works
 * directly from inside the sandbox — no socket hop required.
 *
 * Limitation: if the branch has been packed into packed-refs (e.g. after
 * `git gc`), `git branch -m` would need to rewrite that file in the main git
 * dir root, which is not rw-mounted. Freshly created pit branches are always
 * loose refs, so this is not an issue in practice.
 *
 * Note on session metadata: PitMetadata.branch in the session file becomes
 * stale after rename. This only matters if the worktree directory is deleted
 * and pit tries to recreate it — the clear error message ("branch no longer
 * exists") covers that edge case. All runtime git operations read from the
 * actual .git file, not the metadata.
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";

// ── conversation helpers ───────────────────────────────────────────────────

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

const PROMPT = (conversation: string) => `\
You are a helpful assistant that names git branches.

Analyze the conversation below and respond with a short branch slug that describes the topic.
Rules:
- Lowercase only
- Words separated by hyphens (no spaces, no underscores, no special characters)
- 2 to 5 words, max 40 characters total
- Must be a valid git branch name component

Respond ONLY with valid JSON matching this schema, no other text:
{"slug": string}

<conversation>
${conversation}
</conversation>`;

// ── git branch rename ──────────────────────────────────────────────────────

function getCurrentBranch(cwd: string): string | null {
  try {
    const gitPath = path.join(cwd, ".git");
    if (fs.statSync(gitPath).isDirectory()) return null; // main worktree, not linked
    const worktreeGitDir = fs.readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, "");
    const head = fs.readFileSync(path.join(worktreeGitDir, "HEAD"), "utf8").trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function renameBranch(oldBranch: string, newBranch: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["branch", "-m", oldBranch, newBranch], { cwd }, (err) => {
      resolve(err ? err.message : null);
    });
  });
}

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Only register in pit worktree sessions
  if (!process.env.PIT_ESCAPE_SOCKET) return;

  pi.registerCommand("rename-branch", {
    description: "Rename the worktree branch based on the session topic (preserves branch path prefix)",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getBranch() as SessionEntry[];
      const conversation = buildConversationText(entries);

      if (!conversation.trim()) {
        ctx.ui.notify("No conversation to analyze yet", "warning");
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

      // Read current branch before the AI call so we fail fast if not in a worktree
      const cwd = process.cwd();
      const currentBranch = getCurrentBranch(cwd);
      if (!currentBranch) {
        ctx.ui.notify("Could not determine current branch — are you in a pit worktree?", "error");
        return;
      }

      ctx.ui.notify("Asking the model for a branch name...", "info");

      const response = await complete(
        model,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: PROMPT(conversation) }],
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

      const error = await renameBranch(currentBranch, newBranch, cwd);
      if (error) {
        ctx.ui.notify(`Branch rename failed: ${error}`, "error");
        return;
      }

      ctx.ui.notify(`Branch renamed: ${currentBranch} -> ${newBranch}`, "info");
    },
  });
}
