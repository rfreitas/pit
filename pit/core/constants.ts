/**
 * Shared runtime constants for pit.
 * Centralised here so launcher and program both resolve AGENT_DIR exactly once.
 */

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "/";
export const AGENT_DIR = getAgentDir();
export const PIT_DIR = join(AGENT_DIR, "pit");
