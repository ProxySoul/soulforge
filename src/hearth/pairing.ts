/**
 * Pairing-code registry — short-lived 6-character codes that bind a freshly
 * authenticated chat to an existing surface. The user runs the daemon, the
 * daemon prints/sends a code, and the user types it on the trusted side.
 *
 * Codes are derived from crypto.randomBytes — never timestamps. TTL keeps
 * old codes from being reused; one-shot resolves keep the surface idempotent.
 */

import { randomBytes, randomInt } from "node:crypto";
import type { ExternalChatId, PairingCode, SurfaceId } from "./types.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/I/1

export function generatePairingCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    const byte = bytes[i] ?? 0;
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

export class PairingRegistry {
  private codes = new Map<string, PairingCode>();

  constructor(private ttlMs: number) {}

  issue(surfaceId: SurfaceId, externalId: ExternalChatId): PairingCode {
    const code = generatePairingCode();
    const now = Date.now();
    const entry: PairingCode = {
      code,
      surfaceId,
      externalId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.codes.set(code, entry);
    return entry;
  }

  consume(surfaceId: SurfaceId, code: string): PairingCode | null {
    const upper = code.trim().toUpperCase();
    const entry = this.codes.get(upper);
    if (!entry) return null;
    if (entry.surfaceId !== surfaceId) return null;
    if (entry.expiresAt < Date.now()) {
      this.codes.delete(upper);
      return null;
    }
    this.codes.delete(upper);
    return entry;
  }

  /** Drop expired entries — called by daemon sweep. */
  prune(): number {
    const now = Date.now();
    let n = 0;
    for (const [k, v] of this.codes) {
      if (v.expiresAt < now) {
        this.codes.delete(k);
        n++;
      }
    }
    return n;
  }

  list(): PairingCode[] {
    return [...this.codes.values()];
  }

  /** Used by tests to seed deterministic codes. */
  injectForTests(entry: PairingCode): void {
    this.codes.set(entry.code, entry);
  }
}

/** Random nonce used for pairing handshakes that can't reuse the alphabet. */
export function randomNonceHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

/** Numeric verification code (e.g. SMS-style fallback when the surface can't render text). */
export function randomNumericCode(digits = 6): string {
  let out = "";
  for (let i = 0; i < digits; i++) out += String(randomInt(0, 10));
  return out;
}
