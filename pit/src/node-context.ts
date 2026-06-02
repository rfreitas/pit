/**
 * Minimal NodeContext for pit — provides only the Node.js platform services
 * pit actually uses (filesystem, commands, paths, terminal), without pulling
 * in the full @effect/platform-node (and its undici HTTP dependency).
 *
 * Mirrors the upstream NodeContext.layer from @effect/platform-node but
 * omits NodeWorker — pit never touches workers.
 */

import * as NodeCommandExecutor from "@effect/platform-node-shared/NodeCommandExecutor";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import type * as FileSystem from "@effect/platform/FileSystem";
import type * as Path from "@effect/platform/Path";
import type * as Terminal from "@effect/platform/Terminal";

/**
 * The set of platform services required by pit's Effects.
 * Compatible with the upstream NodeContext type (union of service tags).
 */
export type NodeContext =
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
  | Terminal.Terminal;

/**
 * Layer that provides all the platform services pit needs.
 */
export const layer: Layer.Layer<NodeContext> = pipe(
  Layer.mergeAll(NodePath.layer, NodeCommandExecutor.layer, NodeTerminal.layer),
  Layer.provideMerge(NodeFileSystem.layer),
);
