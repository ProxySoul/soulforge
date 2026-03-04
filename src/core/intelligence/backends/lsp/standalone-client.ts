// ─── Standalone LSP Client (JSON-RPC over stdio) ───

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  decode,
  encode,
  filePathToUri,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type LspDiagnostic,
  type LspDocumentSymbol,
  type LspHover,
  type LspLocation,
  type LspLocationLink,
  type LspSymbolInformation,
  type LspWorkspaceEdit,
} from "./protocol.js";
import type { LspServerConfig } from "./server-registry.js";

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

type LspDefinitionResult = LspLocation | LspLocation[] | LspLocationLink[] | null;

export class StandaloneLspClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private openDocuments = new Set<string>();
  private diagnostics = new Map<string, LspDiagnostic[]>();
  private diagnosticWaiters = new Map<string, Array<() => void>>();
  private initialized = false;
  private rootUri: string;

  constructor(
    private config: LspServerConfig,
    private cwd: string,
  ) {
    this.rootUri = filePathToUri(cwd);
  }

  /** Spawn the server process and perform the initialize handshake */
  async start(): Promise<void> {
    this.process = spawn(this.config.command, this.config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
    });

    this.process.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.process.on("exit", () => {
      this.process = null;
      // Reject all pending requests
      for (const [, pending] of this.pending) {
        pending.reject(new Error("LSP server exited"));
      }
      this.pending.clear();
    });

    // Initialize handshake
    await this.request("initialize", {
      processId: process.pid,
      capabilities: {
        textDocument: {
          synchronization: { didOpen: true, didChange: true },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false },
          hover: { dynamicRegistration: false },
          rename: { dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true },
        },
      },
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name: "workspace" }],
    });

    this.notify("initialized", {});
    this.initialized = true;
  }

  /** Send a request and wait for the response */
  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.process?.stdin) throw new Error("LSP server not running");

    const id = this.nextId++;
    const msg = encode(method, params, id);
    this.process.stdin.write(msg);

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`LSP request ${method} timed out`));
        }
      }, 30_000);
    });
  }

  /** Send a notification (no response expected) */
  notify(method: string, params: unknown): void {
    if (!this.process?.stdin) return;
    const msg = encode(method, params);
    this.process.stdin.write(msg);
  }

  /** Process incoming data from stdout */
  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]) as Buffer<ArrayBuffer>;
    const { messages, remainder } = decode(this.buffer);
    this.buffer = remainder as Buffer<ArrayBuffer>;

    for (const msg of messages) {
      if (isResponse(msg)) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } else if (isNotification(msg) && msg.method === "textDocument/publishDiagnostics") {
        const params = msg.params as { uri: string; diagnostics: LspDiagnostic[] };
        this.diagnostics.set(params.uri, params.diagnostics);
        // Wake up any waiters for this URI
        const waiters = this.diagnosticWaiters.get(params.uri);
        if (waiters) {
          for (const waiter of waiters) waiter();
          this.diagnosticWaiters.delete(params.uri);
        }
      }
    }
  }

  /** Ensure a document is open in the server */
  ensureDocumentOpen(filePath: string): void {
    const uri = filePathToUri(filePath);
    if (this.openDocuments.has(uri)) return;

    let text: string;
    try {
      text = readFileSync(filePath, "utf-8");
    } catch {
      return;
    }

    const languageId =
      this.config.language === "typescript"
        ? "typescript"
        : this.config.language === "javascript"
          ? "javascript"
          : this.config.language === "python"
            ? "python"
            : this.config.language === "go"
              ? "go"
              : this.config.language === "rust"
                ? "rust"
                : "plaintext";

    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
    this.openDocuments.add(uri);
  }

  /** Get definition locations */
  async textDocumentDefinition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspLocation[]> {
    this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/definition", {
      textDocument: { uri: filePathToUri(filePath) },
      position: { line, character },
    })) as LspDefinitionResult;
    return normalizeLocations(result);
  }

  /** Get references */
  async textDocumentReferences(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspLocation[]> {
    this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/references", {
      textDocument: { uri: filePathToUri(filePath) },
      position: { line, character },
      context: { includeDeclaration: true },
    })) as LspLocation[] | null;
    return result ?? [];
  }

  /** Get document symbols */
  async textDocumentDocumentSymbol(
    filePath: string,
  ): Promise<Array<LspDocumentSymbol | LspSymbolInformation>> {
    this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/documentSymbol", {
      textDocument: { uri: filePathToUri(filePath) },
    })) as Array<LspDocumentSymbol | LspSymbolInformation> | null;
    return result ?? [];
  }

  /** Get hover info */
  async textDocumentHover(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspHover | null> {
    this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/hover", {
      textDocument: { uri: filePathToUri(filePath) },
      position: { line, character },
    })) as LspHover | null;
    return result;
  }

  /** Rename a symbol */
  async textDocumentRename(
    filePath: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<LspWorkspaceEdit | null> {
    this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/rename", {
      textDocument: { uri: filePathToUri(filePath) },
      position: { line, character },
      newName,
    })) as LspWorkspaceEdit | null;
    return result;
  }

  /** Get diagnostics for a file, waiting up to 2s for them to arrive */
  async getDiagnostics(filePath: string): Promise<LspDiagnostic[]> {
    this.ensureDocumentOpen(filePath);
    const uri = filePathToUri(filePath);

    // Check if we already have diagnostics
    const existing = this.diagnostics.get(uri);
    if (existing) return existing;

    // Wait up to 2s for diagnostics to arrive
    return new Promise<LspDiagnostic[]>((resolve) => {
      const timeout = setTimeout(() => {
        // Remove waiter and return whatever we have (or empty)
        const waiters = this.diagnosticWaiters.get(uri);
        if (waiters) {
          const idx = waiters.indexOf(waiterFn);
          if (idx >= 0) waiters.splice(idx, 1);
          if (waiters.length === 0) this.diagnosticWaiters.delete(uri);
        }
        resolve(this.diagnostics.get(uri) ?? []);
      }, 2000);

      const waiterFn = () => {
        clearTimeout(timeout);
        resolve(this.diagnostics.get(uri) ?? []);
      };

      const waiters = this.diagnosticWaiters.get(uri) ?? [];
      waiters.push(waiterFn);
      this.diagnosticWaiters.set(uri, waiters);
    });
  }

  /** Check if the client has been initialized */
  get isReady(): boolean {
    return this.initialized && this.process !== null;
  }

  /** Graceful shutdown */
  async stop(): Promise<void> {
    if (!this.process) return;
    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
    } catch {
      // Best effort
    }
    // Force kill after 2s
    const proc = this.process;
    if (proc) {
      setTimeout(() => proc.kill("SIGKILL"), 2000);
      proc.kill("SIGTERM");
    }
    this.process = null;
    this.initialized = false;
    this.openDocuments.clear();
    this.diagnostics.clear();
    this.pending.clear();
  }
}

// ─── Helpers ───

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && ("result" in msg || "error" in msg);
}

function isNotification(
  msg: JsonRpcMessage,
): msg is { jsonrpc: "2.0"; method: string; params?: unknown } {
  return "method" in msg && !("id" in msg);
}

function normalizeLocations(result: LspDefinitionResult): LspLocation[] {
  if (!result) return [];
  if (Array.isArray(result)) {
    return result.map((item) => {
      if ("targetUri" in item) {
        const link = item as LspLocationLink;
        return { uri: link.targetUri, range: link.targetRange };
      }
      return item as LspLocation;
    });
  }
  return [result];
}
