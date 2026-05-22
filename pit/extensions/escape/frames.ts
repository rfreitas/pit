/**
 * socketLines — convert a net.Socket to a Stream<string> of newline-delimited frames.
 *
 * Uses Readable.toWeb() to get a Web ReadableStream, then Stream.splitLines handles
 * TCP chunking transparently — no manual buffer accumulation.
 *
 * Only suitable for receive-only sockets (client reads after writing, subscribe streams).
 * Bidirectional sockets (server: read request then write response) cannot use this because
 * Readable.toWeb() transfers read ownership, breaking the write path on the same socket.
 */

import { Readable } from "node:stream";
import type { Socket } from "node:net";
import { Stream } from "effect";

export const socketLines = (sock: Socket): Stream.Stream<string, null> =>
  Stream.fromReadableStream(
    () => Readable.toWeb(sock) as ReadableStream<Uint8Array>,
    () => null,
  ).pipe(
    Stream.decodeText("utf8"),
    Stream.splitLines,
  );
