/**
 * Framed line-JSON protocol shared by the daemon socket and approve-cli.
 * One request per line, one response per line, UTF-8. Each side closes the
 * socket after the response is flushed — this is RPC, not streaming.
 */

import { createConnection, type Socket } from "node:net";
import type { SocketRequest, SocketResponse } from "./types.js";
import { HEARTH_PROTOCOL_VERSION } from "./types.js";

export const HEARTH_MAX_FRAME_BYTES = 1024 * 1024; // 1 MiB hard cap per frame

export interface FrameReaderOptions {
  max?: number;
  onFrame: (req: SocketRequest) => void;
  onError?: (err: Error) => void;
}

/** Attach a length-bounded line reader to a socket. Never throws. */
export function attachFrameReader(socket: Socket, opts: FrameReaderOptions): void {
  const max = opts.max ?? HEARTH_MAX_FRAME_BYTES;
  let buf = "";
  let destroyed = false;

  const fail = (err: Error): void => {
    if (destroyed) return;
    destroyed = true;
    opts.onError?.(err);
    try {
      socket.destroy();
    } catch {}
  };

  socket.setEncoding("utf-8");
  socket.on("data", (chunk) => {
    buf += chunk;
    if (buf.length > max) {
      fail(new Error(`frame exceeds ${String(max)} bytes`));
      return;
    }
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) {
        try {
          const parsed = JSON.parse(line) as SocketRequest;
          if (
            parsed &&
            typeof parsed === "object" &&
            "v" in parsed &&
            parsed.v === HEARTH_PROTOCOL_VERSION
          ) {
            opts.onFrame(parsed);
          } else {
            fail(new Error("protocol version mismatch"));
            return;
          }
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }
      nl = buf.indexOf("\n");
    }
  });
  socket.on("error", (err) => fail(err));
}

export function writeFrame(socket: Socket, response: SocketResponse): void {
  try {
    socket.write(`${JSON.stringify(response)}\n`);
  } catch {
    // Socket already closed — drop silently
  }
}

export interface SocketClientOptions {
  path: string;
  timeoutMs?: number;
}

/**
 * Connect to the Hearth permission socket, send one request, await one response,
 * then close. Rejects on connection error, timeout, or protocol mismatch.
 */
export function socketRequest<TReq extends SocketRequest, TRes extends SocketResponse>(
  req: TReq,
  opts: SocketClientOptions,
): Promise<TRes> {
  return new Promise<TRes>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const sock = createConnection({ path: opts.path }, () => {
      try {
        sock.write(`${JSON.stringify(req)}\n`);
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });

    let buf = "";
    sock.setEncoding("utf-8");

    const timer = setTimeout(() => {
      settle(() => {
        try {
          sock.destroy();
        } catch {}
        reject(new Error(`socket timeout after ${String(opts.timeoutMs ?? 300_000)}ms`));
      });
    }, opts.timeoutMs ?? 300_000);

    sock.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      settle(() => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(line) as TRes;
          if (
            !parsed ||
            typeof parsed !== "object" ||
            !("v" in parsed) ||
            parsed.v !== HEARTH_PROTOCOL_VERSION
          ) {
            reject(new Error("protocol version mismatch"));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        } finally {
          try {
            sock.end();
          } catch {}
        }
      });
    });

    sock.on("error", (err) => {
      settle(() => {
        clearTimeout(timer);
        reject(err);
      });
    });

    sock.on("close", () => {
      settle(() => {
        clearTimeout(timer);
        reject(new Error("socket closed before response"));
      });
    });
  });
}
