/**
 * Workspace + surface registries — keyed lookups for the daemon router.
 */

import type { ExternalChatId, Surface, SurfaceId } from "./types.js";
import type { ChatWorkspace } from "./workspace.js";

export class SurfaceRegistry {
  private surfaces = new Map<SurfaceId, Surface>();

  register(surface: Surface): void {
    this.surfaces.set(surface.id, surface);
  }

  unregister(id: SurfaceId): void {
    this.surfaces.delete(id);
  }

  get(id: SurfaceId): Surface | undefined {
    return this.surfaces.get(id);
  }

  list(): Surface[] {
    return [...this.surfaces.values()];
  }

  async startAll(): Promise<{ id: SurfaceId; ok: boolean; error?: string }[]> {
    const out: { id: SurfaceId; ok: boolean; error?: string }[] = [];
    for (const surface of this.surfaces.values()) {
      try {
        await surface.start();
        out.push({ id: surface.id, ok: surface.isConnected() });
      } catch (err) {
        out.push({
          id: surface.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  async stopAll(): Promise<void> {
    for (const surface of this.surfaces.values()) {
      try {
        await surface.stop();
      } catch {}
    }
  }
}

export class ChatWorkspaceRegistry {
  private workspaces = new Map<string, ChatWorkspace>();

  private key(surfaceId: SurfaceId, externalId: ExternalChatId): string {
    return `${surfaceId}\u0000${externalId}`;
  }

  has(surfaceId: SurfaceId, externalId: ExternalChatId): boolean {
    return this.workspaces.has(this.key(surfaceId, externalId));
  }

  get(surfaceId: SurfaceId, externalId: ExternalChatId): ChatWorkspace | undefined {
    return this.workspaces.get(this.key(surfaceId, externalId));
  }

  set(surfaceId: SurfaceId, externalId: ExternalChatId, ws: ChatWorkspace): void {
    this.workspaces.set(this.key(surfaceId, externalId), ws);
  }

  delete(surfaceId: SurfaceId, externalId: ExternalChatId): boolean {
    return this.workspaces.delete(this.key(surfaceId, externalId));
  }

  list(): ChatWorkspace[] {
    return [...this.workspaces.values()];
  }

  size(): number {
    return this.workspaces.size;
  }

  async closeAll(): Promise<void> {
    for (const ws of this.workspaces.values()) {
      try {
        await ws.close();
      } catch {}
    }
    this.workspaces.clear();
  }
}
