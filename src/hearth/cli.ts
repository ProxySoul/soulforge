/**
 * `soulforge hearth …` CLI — foreground daemon, pair, status, doctor.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasSecret, setSecret } from "../core/secrets.js";
import { GLOBAL_CONFIG_PATH, loadHearthConfig, writeGlobalHearthConfig } from "./config.js";
import { HearthDaemon } from "./daemon.js";
import { generatePairingCode } from "./pairing.js";
import { socketRequest } from "./protocol.js";
import { HEARTH_PROTOCOL_VERSION, type SurfaceId } from "./types.js";

export type HearthCliAction =
  | { kind: "start"; detach?: boolean }
  | { kind: "stop" }
  | { kind: "status" }
  | { kind: "pair"; surface: SurfaceId; code?: string; externalId?: string }
  | { kind: "unpair"; surface: SurfaceId; externalId: string }
  | { kind: "login"; surface: SurfaceId; token?: string }
  | { kind: "doctor" }
  | { kind: "logs"; follow?: boolean }
  | { kind: "help" };

export function parseHearthArgs(argv: string[]): HearthCliAction {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") return { kind: "help" };

  switch (sub) {
    case "start":
      return { kind: "start", detach: rest.includes("--detach") };
    case "stop":
      return { kind: "stop" };
    case "status":
      return { kind: "status" };
    case "pair": {
      const surface = rest[0] as SurfaceId | undefined;
      if (!surface) return { kind: "help" };
      if (rest.includes("--issue")) return { kind: "pair", surface };
      const code = rest[1];
      const externalId = rest[2];
      return { kind: "pair", surface, code, externalId };
    }
    case "unpair": {
      const surface = rest[0] as SurfaceId | undefined;
      const externalId = rest[1];
      if (!surface || !externalId) return { kind: "help" };
      return { kind: "unpair", surface, externalId };
    }
    case "login": {
      const surface = rest[0] as SurfaceId | undefined;
      if (!surface) return { kind: "help" };
      const token = rest[1];
      return { kind: "login", surface, token };
    }
    case "doctor":
      return { kind: "doctor" };
    case "logs":
      return { kind: "logs", follow: rest.includes("--follow") };
    default:
      return { kind: "help" };
  }
}

const USAGE = `soulforge hearth — remote control for SoulForge

Usage:
  soulforge hearth start [--detach]              Start the daemon (foreground)
  soulforge hearth stop                          Graceful shutdown via socket
  soulforge hearth status                        Daemon health + paired chats
  soulforge hearth login <surface>[:<id>] [tok]  Store a bot token in keychain
                                                   e.g. telegram:1234 <token>
                                                        discord:<appId> <token>
  soulforge hearth pair   <surface> --issue      Mint a pairing code locally
  soulforge hearth pair   <surface> <code>       Redeem a code sent from a chat
  soulforge hearth unpair <surface> <chatId>     Revoke a paired chat
  soulforge hearth doctor                        Env + keychain + socket checks
  soulforge hearth logs   [--follow]             Tail the daemon log
`;

export async function runHearthCli(action: HearthCliAction): Promise<number> {
  switch (action.kind) {
    case "help":
      process.stdout.write(USAGE);
      return 0;
    case "start":
      return runStart(action.detach === true);
    case "stop":
      return runStop();
    case "status":
      return runStatus();
    case "login":
      return runLogin(action.surface, action.token);
    case "pair":
      return runPair(action.surface, action.code, action.externalId);
    case "unpair":
      return runUnpair(action.surface, action.externalId);
    case "doctor":
      return runDoctor();
    case "logs":
      return runLogs(action.follow === true);
    default:
      process.stdout.write(USAGE);
      return 1;
  }
}

async function runStart(detach: boolean): Promise<number> {
  if (detach) {
    process.stderr.write(
      "--detach not yet supported — run under a service manager (launchd/systemd)\n",
    );
  }
  const config = loadHearthConfig();
  // Surfaces are now built and managed by the daemon's SurfaceHost (owner-swap
  // model) — we don't pre-build or pre-start them here. The banner is static
  // based on config; the real "online" list is logged by the daemon as it
  // brings SurfaceHost up.
  const configuredSurfaces = Object.entries(config.surfaces)
    .filter(([, s]) => s.enabled)
    .map(([id]) => id);

  const daemon = new HearthDaemon({
    config,
    onLog: (line) => process.stderr.write(`${line}\n`),
  });

  process.stdout.write(
    [
      `  ⌂  hearth  —  the forge stays warm`,
      `     socket: ${config.daemon.socketPath} (0o600)`,
      `     surfaces: ${configuredSurfaces.join(", ") || "(none)"}`,
    ].join("\n"),
  );
  process.stdout.write("\n\n");

  await daemon.start();

  // Block on SIGINT/SIGTERM — daemon.stop handles both
  await new Promise<void>((resolve) => {
    const onExit = () => {
      resolve();
    };
    process.once("SIGINT", onExit);
    process.once("SIGTERM", onExit);
  });
  await daemon.stop();
  return 0;
}

async function runStop(): Promise<number> {
  const config = loadHearthConfig();
  const sock = config.daemon.socketPath;
  if (!existsSync(sock)) {
    process.stderr.write("daemon not running\n");
    return 1;
  }
  // No dedicated stop op — rely on signal when daemon runs in foreground.
  process.stderr.write(
    "stop not implemented remotely — send SIGTERM to the foreground `soulforge hearth start` process\n",
  );
  return 1;
}

async function runStatus(): Promise<number> {
  const config = loadHearthConfig();
  try {
    const res = await socketRequest(
      { op: "health", v: HEARTH_PROTOCOL_VERSION },
      { path: config.daemon.socketPath, timeoutMs: 3000 },
    );
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(
      `daemon unreachable at ${config.daemon.socketPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

async function runLogin(surfaceId: SurfaceId, tokenArg?: string): Promise<number> {
  const [kind, id] = surfaceId.split(":") as [string, string | undefined];
  if (!kind || !id) {
    process.stderr.write("surface must be like 'telegram:<botId>' or 'discord:<appId>'\n");
    return 1;
  }
  const secretKey = `${kind}.bot.${id}`;
  let token = tokenArg;
  if (!token) {
    // Read from stdin so the token never appears in `ps` output
    token = (await readStdin()).trim();
  }
  if (!token) {
    process.stderr.write("no token provided — pipe it on stdin or pass as argument\n");
    return 1;
  }
  setSecret(secretKey, token);
  process.stdout.write(`stored ${secretKey} in keychain\n`);
  // Enable the surface in config if it isn't already
  const config = loadHearthConfig();
  if (!config.surfaces[surfaceId]) {
    config.surfaces[surfaceId] = { enabled: true, chats: {}, allowed: {} };
    writeGlobalHearthConfig(config);
    process.stdout.write(`added ${surfaceId} to ${GLOBAL_CONFIG_PATH}\n`);
  }
  return 0;
}

async function runPair(
  surfaceId: SurfaceId,
  codeOrUndef?: string,
  externalId?: string,
): Promise<number> {
  const config = loadHearthConfig();
  if (!codeOrUndef) {
    // Issue a local code the user can type inside the chat after DM'ing the bot.
    const code = generatePairingCode();
    process.stdout.write(`Pairing code for ${surfaceId}: ${code}\n`);
    process.stdout.write(`DM your bot, then reply inside the chat: /pair ${code}\n`);
    process.stdout.write(
      "Tip: the daemon must be running (`soulforge hearth start`) for the chat-side redemption to work.\n",
    );
    return 0;
  }

  try {
    const res = await socketRequest(
      { op: "pair", v: HEARTH_PROTOCOL_VERSION, surfaceId, code: codeOrUndef },
      { path: config.daemon.socketPath, timeoutMs: 5000 },
    );
    const maybe = res as { ok?: boolean; externalId?: string; error?: string };
    if (maybe.ok) {
      process.stdout.write(`paired ${surfaceId} · ${maybe.externalId ?? externalId ?? ""}\n`);
      return 0;
    }
    process.stderr.write(`pair failed: ${maybe.error ?? "unknown"}\n`);
    return 1;
  } catch (err) {
    process.stderr.write(
      `daemon unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

async function runUnpair(surfaceId: SurfaceId, externalId: string): Promise<number> {
  const config = loadHearthConfig();
  const surface = config.surfaces[surfaceId];
  if (!surface?.chats[externalId]) {
    process.stderr.write("no such binding\n");
    return 1;
  }
  delete surface.chats[externalId];
  writeGlobalHearthConfig(config);
  process.stdout.write(`unpaired ${surfaceId} · ${externalId}\n`);
  return 0;
}

async function runDoctor(): Promise<number> {
  const config = loadHearthConfig();
  const lines: string[] = [];

  lines.push(`config: ${GLOBAL_CONFIG_PATH}`);
  lines.push(`socket: ${config.daemon.socketPath}`);
  lines.push(`state : ${config.daemon.stateFile}`);
  lines.push(`log   : ${config.daemon.logFile}`);
  lines.push("");

  for (const [surfaceId, cfg] of Object.entries(config.surfaces)) {
    const [kind, id] = surfaceId.split(":");
    lines.push(`surface ${surfaceId} — enabled: ${String(cfg.enabled)}`);
    if (kind === "telegram" || kind === "discord") {
      const secretKey = `${kind}.bot.${id ?? ""}`;
      const ok = hasSecret(secretKey);
      lines.push(`  token ${secretKey}: ${ok ? "present" : "MISSING"}`);
    }
    if (kind === "imessage") {
      const dbPath = join(homedir(), "Library", "Messages", "chat.db");
      const ok = existsSync(dbPath);
      lines.push(`  chat.db: ${ok ? dbPath : "MISSING — grant Full Disk Access"}`);
    }
    const chats = Object.keys(cfg.chats).length;
    lines.push(`  chats: ${String(chats)} paired`);
  }

  lines.push("");
  lines.push(
    `daemon: ${existsSync(config.daemon.socketPath) ? "socket present" : "socket absent"}`,
  );

  // Redaction self-test — prove no secrets leak through stdout
  const testToken = `bot123456:ABC-${"x".repeat(40)}`;
  const { redact } = await import("./redact.js");
  const scrubbed = redact(testToken);
  lines.push(`redaction: ${scrubbed === testToken ? "FAIL" : "ok"}`);

  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function runLogs(follow: boolean): Promise<number> {
  const config = loadHearthConfig();
  const path = config.daemon.logFile;
  if (!existsSync(path)) {
    process.stderr.write(`log file missing: ${path}\n`);
    return 1;
  }
  const { spawn } = await import("node:child_process");
  const args = follow ? ["-f", path] : [path];
  const child = spawn("tail", args, { stdio: "inherit" });
  return new Promise<number>((resolve) => {
    child.once("close", (code) => resolve(code ?? 0));
    process.once("SIGINT", () => child.kill("SIGINT"));
  });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}
