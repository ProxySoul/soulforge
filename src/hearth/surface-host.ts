/**
 * SurfaceHost — owner-agnostic surface supervisor.
 *
 * Runs in whichever process currently owns the bridge lock (TUI or daemon).
 * Builds the Surface adapters from config, wires inbound traffic into an
 * injected router, and exposes outbound render/notify/approval primitives.
 *
 * The host itself is "dumb" — it doesn't know about tabs, workspaces, or the
 * bridge. The owner process installs a router (the TUI installs one that drops
 * into the in-process `hearthBridge`; the daemon installs one that dispatches
 * to `ChatWorkspace`s). This keeps the adapter lifecycle (start/stop/reload)
 * in one place, independent of which process is the active router.
 */

import type { HeadlessEvent } from "../headless/types.js";
import { SurfaceRegistry } from "./registry.js";
import { buildSurfacesFromConfig } from "./surface-factory.js";
import type {
  ExternalChatId,
  HearthConfig,
  InboundMessage,
  PermissionDecision,
  Surface,
  SurfaceId,
} from "./types.js";

export interface SurfaceHostRouter {
  /** Called for every inbound surface message (text, command, image). */
  onInbound(surfaceId: SurfaceId, msg: InboundMessage): void | Promise<void>;
}

export interface SurfaceHostOptions {
  config: HearthConfig;
  router: SurfaceHostRouter;
  log?: (line: string) => void;
}

export class SurfaceHost {
  private registry = new SurfaceRegistry();
  private config: HearthConfig;
  private router: SurfaceHostRouter;
  private log: (line: string) => void;
  private started = false;
  private wired = new WeakSet<Surface>();

  constructor(opts: SurfaceHostOptions) {
    this.config = opts.config;
    this.router = opts.router;
    this.log = opts.log ?? (() => {});
  }

  /** Build + start all enabled surfaces. Idempotent. */
  async start(): Promise<{ ok: SurfaceId[]; failed: { id: SurfaceId; error: string }[] }> {
    if (this.started) return { ok: [], failed: [] };
    this.started = true;
    const built = buildSurfacesFromConfig(this.config, this.log);
    for (const s of built.surfaces) this.registerOne(s);
    const failed: { id: SurfaceId; error: string }[] = [...built.errors];
    const ok: SurfaceId[] = [];
    const results = await this.registry.startAll();
    for (const r of results) {
      if (r.ok) ok.push(r.id);
      else failed.push({ id: r.id, error: r.error ?? "unknown" });
    }
    return { ok, failed };
  }

  /** Stop + drop all surfaces. Safe to call multiple times. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.registry.stopAll();
    // Rebuild registry so restart() works from scratch.
    this.registry = new SurfaceRegistry();
  }

  /** Rebuild all surfaces from the new config. Existing adapters are always
   *  stopped and replaced so live config edits (allowlist, chats, token) take
   *  effect immediately — the per-adapter state (`allowedByChannel`,
   *  `allowedByChat`) is captured at construction time and isn't otherwise
   *  refreshed. Cheap: reconnect latency is well under a second. */
  async reload(nextConfig: HearthConfig): Promise<{
    started: SurfaceId[];
    stopped: SurfaceId[];
    errors: { id: SurfaceId; error: string }[];
  }> {
    this.config = nextConfig;
    const built = buildSurfacesFromConfig(nextConfig, this.log);
    const desired = new Map<SurfaceId, Surface>();
    for (const s of built.surfaces) desired.set(s.id, s);

    const started: SurfaceId[] = [];
    const stopped: SurfaceId[] = [];
    const errors: { id: SurfaceId; error: string }[] = [...built.errors];

    for (const live of this.registry.list()) {
      try {
        await live.stop();
      } catch (err) {
        errors.push({ id: live.id, error: err instanceof Error ? err.message : String(err) });
      }
      this.registry.unregister(live.id);
      if (!desired.has(live.id)) stopped.push(live.id);
    }

    for (const [id, surface] of desired) {
      this.registerOne(surface);
      try {
        await surface.start();
        started.push(id);
      } catch (err) {
        errors.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { started, stopped, errors };
  }

  /** Hot-swap the router without bouncing adapters. */
  setRouter(router: SurfaceHostRouter): void {
    this.router = router;
  }

  /** Push a HeadlessEvent to a chat via the matching surface adapter. */
  async render(
    surfaceId: SurfaceId,
    externalId: ExternalChatId,
    event: HeadlessEvent,
    tabId: string = "bridged",
  ): Promise<void> {
    const surface = this.registry.get(surfaceId);
    if (!surface) return;
    try {
      await surface.render({ externalId, tabId, event });
    } catch (err) {
      this.log(
        `render ${surfaceId}/${externalId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Send a plain notification (pairing prompt, error hint, etc.). */
  async notify(surfaceId: SurfaceId, externalId: ExternalChatId, message: string): Promise<void> {
    const surface = this.registry.get(surfaceId);
    if (!surface) return;
    try {
      await surface.notify(externalId, message);
    } catch (err) {
      this.log(
        `notify ${surfaceId}/${externalId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async requestApproval(
    surfaceId: SurfaceId,
    externalId: ExternalChatId,
    ui: import("./types.js").ApprovalUI,
  ): Promise<{ decision: PermissionDecision; remember?: "once" | "session" | "always" }> {
    const surface = this.registry.get(surfaceId);
    if (!surface) return { decision: "deny" };
    try {
      return await surface.requestApproval(externalId, ui);
    } catch {
      return { decision: "deny" };
    }
  }

  async sendPairingPrompt(
    surfaceId: SurfaceId,
    externalId: ExternalChatId,
    code: string,
  ): Promise<boolean> {
    const surface = this.registry.get(surfaceId);
    if (!surface) return false;
    try {
      await surface.sendPairingPrompt(externalId, code);
      return true;
    } catch {
      return false;
    }
  }

  getSurface(surfaceId: SurfaceId): Surface | undefined {
    return this.registry.get(surfaceId);
  }

  listSurfaces(): Surface[] {
    return this.registry.list();
  }

  private registerOne(surface: Surface): void {
    this.registry.register(surface);
    if (this.wired.has(surface)) return;
    this.wired.add(surface);
    surface.onInbound((msg) => {
      void this.router.onInbound(surface.id, msg);
    });
  }
}
