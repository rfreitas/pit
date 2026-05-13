/**
 * Handoff extension - move current session to another project directory.
 *
 * Usage: /handoff <target-directory>
 *
 * Moves the current Pi session file into the target project's session bucket,
 * updates the cwd header, and prefixes the session name with "handedoff:"
 * so it is easy to identify in the session picker.
 *
 * Example:
 *   /handoff C:\Users\ricfr\Repos\agent
 *   /handoff ../other-repo
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * List directories matching a typed prefix, for use in argument completion.
 * Handles absolute paths, relative paths, and partial names.
 */
function getDirectoryCompletions(prefix: string, cwd: string): AutocompleteItem[] {
	try {
		let listDir: string;
		let filterStr: string;

		const endsWithSep = prefix === "" || prefix.endsWith("/") || prefix.endsWith("\\");

		if (endsWithSep) {
			listDir = path.resolve(cwd, prefix || ".");
			filterStr = "";
		} else {
			const resolved = path.resolve(cwd, prefix);
			listDir = path.dirname(resolved);
			filterStr = path.basename(resolved).toLowerCase();
		}

		const entries = fs.readdirSync(listDir, { withFileTypes: true });

		return entries
			.filter((e) => e.isDirectory())
			.filter((e) => !e.name.startsWith(".") || filterStr.startsWith("."))
			.filter((e) => e.name.toLowerCase().startsWith(filterStr))
			.map((e) => {
				const fullPath = path.join(listDir, e.name);
				return {
					value: fullPath,
					label: e.name,
					description: fullPath,
				};
			});
	} catch {
		return [];
	}
}

/**
 * Convert an absolute path to a Pi session bucket directory name.
 * e.g. C:\Users\ricfr\Repos\agent → --C--Users-ricfr-Repos-agent--
 */
function pathToBucketName(targetPath: string): string {
	return "--" + targetPath.replace(/^[\/\\]/, "").replace(/[\/\\:]/g, "-") + "--";
}

export default function (pi: ExtensionAPI) {
	// Track session cwd so getArgumentCompletions (which has no ctx) can use it
	let sessionCwd: string = process.cwd();

	pi.on("session_start", (_event, ctx) => {
		sessionCwd = ctx.cwd;
		if (process.cwd() !== ctx.cwd) {
			ctx.ui.setStatus("cwd-mismatch", `⚠ session dir: ${ctx.cwd} (process is in ${process.cwd()})`);
		} else {
			ctx.ui.setStatus("cwd-mismatch", undefined);
		}
	});

	pi.registerCommand("handoff", {
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = getDirectoryCompletions(prefix, sessionCwd);
			return items.length > 0 ? items : null;
		},
		description: "Move current session to another project directory. Usage: /handoff <target-directory>",
		handler: async (args, ctx) => {
			const targetArg = args.trim();
			if (!targetArg) {
				ctx.ui.notify("Usage: /handoff <target-directory>", "error");
				return;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("No session file — running in ephemeral mode", "error");
				return;
			}

			// Resolve target path relative to current working directory, then resolve symlinks
			const targetPath = (() => {
				const resolved = path.resolve(ctx.cwd, targetArg);
				try { return fs.realpathSync(resolved); } catch { return resolved; }
			})();
			if (!fs.existsSync(targetPath)) {
				ctx.ui.notify(`Directory not found: ${targetPath}`, "error");
				return;
			}

			if (targetPath === ctx.cwd) {
				ctx.ui.notify("Target is already the current project directory", "error");
				return;
			}

			// Derive sessions root: <sessionsDir>/<bucketName>/<filename>.jsonl
			const sessionsDir = path.dirname(path.dirname(sessionFile));
			const bucketName = pathToBucketName(targetPath);
			const newBucketDir = path.join(sessionsDir, bucketName);
			const newSessionFile = path.join(newBucketDir, path.basename(sessionFile));

			// Read current session file
			const content = fs.readFileSync(sessionFile, "utf8");
			const lines = content.split("\n").filter((l) => l.trim() !== "");

			// Update cwd in header (line 0)
			const header = JSON.parse(lines[0]);
			const currentName = pi.getSessionName() ?? path.basename(ctx.cwd);
			header.cwd = targetPath;
			lines[0] = JSON.stringify(header);

			// Append a session_info entry with the handedoff: name.
			// We write this directly into the file before switching so we don't
			// have to deal with stale extension context inside withSession.
			const lastEntry = JSON.parse(lines[lines.length - 1]);
			const nameEntry = {
				type: "session_info",
				id: crypto.randomBytes(4).toString("hex"),
				parentId: lastEntry.id,
				timestamp: new Date().toISOString(),
				name: `handedoff: ${currentName}`,
			};
			lines.push(JSON.stringify(nameEntry));

			// Write to new bucket
			fs.mkdirSync(newBucketDir, { recursive: true });
			fs.writeFileSync(newSessionFile, lines.join("\n") + "\n", "utf8");

			// Capture original path before switch (ctx becomes stale after switchSession)
			const originalSessionFile = sessionFile;

			const result = await ctx.switchSession(newSessionFile, {
				withSession: async (newCtx) => {
					newCtx.ui.notify(`Session handed off to ${targetPath}`, "info");
					if (process.cwd() !== targetPath) {
						newCtx.ui.notify(
							`Note: the session CWD is now ${targetPath} but the process CWD is still ${process.cwd()}. Tool calls and relative paths may behave unexpectedly until you restart pi from the new directory.`,
							"warning"
						);
					}
					// Delete original now that we are safely in the new session
					try {
						fs.unlinkSync(originalSessionFile);
					} catch {
						// Non-fatal — original may already be gone or locked
					}
				},
			});

			if (result.cancelled) {
				// Switch was cancelled — remove the copy we made
				try {
					fs.unlinkSync(newSessionFile);
				} catch {}
				ctx.ui.notify("Handoff cancelled", "info");
			}
		},
	});
}
