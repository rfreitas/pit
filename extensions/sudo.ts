/**
 * sudo extension — lets the LLM run commands with elevated privileges.
 *
 * Flow:
 *   1. Try sudo -n (non-interactive) — succeeds if NOPASSWD or credentials cached by kernel
 *   2. If password required, check in-memory cache (15 min window)
 *   3. Otherwise prompt the user with a masked password input
 *   4. Run sudo -S, piping the password to stdin
 *   5. Cache the password on success
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  function runCommand(
    command: string,
    password: string | null,
    signal: AbortSignal
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const args = password !== null
        ? ["-S", "--", "sh", "-c", command]   // -S: read password from stdin
        : ["-n", "--", "sh", "-c", command];  // -n: non-interactive (no prompt)

      const proc = spawn("sudo", args, { stdio: ["pipe", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      if (password !== null) {
        proc.stdin.write(password + "\n");
        proc.stdin.end();
      }

      proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
      proc.on("error", reject);

      signal.addEventListener("abort", () => {
        proc.kill();
        reject(new Error("aborted"));
      }, { once: true });
    });
  }

  async function promptPassword(command: string, ctx: Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[4]): Promise<string | null> {
    return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      let value = "";
      let dirty = true;

      function render(width: number): string[] {
        const lines: string[] = [];
        const border = theme.fg("accent", "─".repeat(width));
        lines.push(border);
        lines.push(truncateToWidth(theme.fg("accent", theme.bold(" sudo")) + theme.fg("muted", " — enter password to run:"), width));
        lines.push(truncateToWidth(theme.fg("warning", "  $ ") + theme.fg("text", command), width));
        lines.push("");

        const masked = "●".repeat(value.length);
        const cursor = theme.fg("accent", "▌");
        lines.push(truncateToWidth(` ${masked}${cursor}`, width));

        lines.push("");
        lines.push(truncateToWidth(theme.fg("dim", " Enter to confirm • Esc to cancel"), width));
        lines.push(border);
        dirty = false;
        return lines;
      }

      function handleInput(data: string): void {
        if (matchesKey(data, Key.enter)) {
          done(value);
          return;
        }
        if (matchesKey(data, Key.escape)) {
          done(null);
          return;
        }
        if (matchesKey(data, Key.backspace) || data === "\x7f") {
          if (value.length > 0) value = value.slice(0, -1);
          dirty = true;
          tui.requestRender();
          return;
        }
        // Accept printable characters only
        if (data.length === 1 && data.charCodeAt(0) >= 32) {
          value += data;
          dirty = true;
          tui.requestRender();
        }
      }

      return {
        render,
        invalidate: () => { dirty = true; },
        handleInput,
      };
    });
  }

  pi.registerTool({
    name: "sudo",
    label: "Sudo",
    description: "Run a shell command with sudo (elevated privileges). Prompts the user for their password if needed.",
    promptSnippet: "Run a shell command with elevated privileges via sudo",
    parameters: Type.Object({
      command: Type.String({ description: "The shell command to run as root" }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Error: sudo tool requires interactive mode (no UI available)" }],
          isError: true,
          details: {},
        };
      }

      // 1. Try non-interactive first (NOPASSWD or kernel-cached creds)
      try {
        const result = await runCommand(params.command, null, signal ?? new AbortController().signal);
        if (result.code === 0) {
          return {
            content: [{ type: "text", text: result.stdout || "(no output)" }],
            details: { stderr: result.stderr, code: result.code },
          };
        }
        // code 1 from -n means password required — fall through
        // any other error is a real failure
        if (result.code !== 1) {
          return {
            content: [{ type: "text", text: result.stderr || `exited with code ${result.code}` }],
            isError: true,
            details: { stderr: result.stderr, code: result.code },
          };
        }
      } catch (e: any) {
        if (e.message === "aborted") {
          return { content: [{ type: "text", text: "Cancelled" }], isError: true, details: {} };
        }
        throw e;
      }

      // 2. Prompt for password
      onUpdate?.({ content: [{ type: "text", text: "Waiting for password…" }], details: {} });
      const password = await promptPassword(params.command, ctx);
      if (password === null) {
        return {
          content: [{ type: "text", text: "Cancelled by user" }],
          isError: true,
          details: {},
        };
      }

      // 3. Run with password
      try {
        const result = await runCommand(params.command, password, signal ?? new AbortController().signal);

        if (result.code === 0) {
          return {
            content: [{ type: "text", text: result.stdout || "(no output)" }],
            details: { stderr: result.stderr, code: result.code },
          };
        }

        // Wrong password or command failure
        const isAuthFailure = result.stderr.toLowerCase().includes("incorrect password")
          || result.stderr.toLowerCase().includes("authentication failure")
          || result.stderr.toLowerCase().includes("sorry");

        if (isAuthFailure) {
          ctx.ui.notify("Incorrect password", "error");
        }

        return {
          content: [{ type: "text", text: result.stderr || `exited with code ${result.code}` }],
          isError: true,
          details: { stderr: result.stderr, code: result.code },
        };
      } catch (e: any) {
        if (e.message === "aborted") {
          return { content: [{ type: "text", text: "Cancelled" }], isError: true, details: {} };
        }
        throw e;
      }
    },
  });
}
