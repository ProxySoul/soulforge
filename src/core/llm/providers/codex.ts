import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import type {
  JSONSchema7,
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

export interface CodexRunnerCall {
  modelId: string;
  prompt: string;
  schema: JSONSchema7;
  abortSignal?: AbortSignal;
}

export interface CodexRunnerResult {
  text: string;
  usage: LanguageModelV2Usage;
}

export interface CodexRunner {
  run(call: CodexRunnerCall): Promise<CodexRunnerResult>;
}

export interface CodexLoginStatus {
  installed: boolean;
  loggedIn: boolean;
  authMode: "chatgpt" | "api-key" | null;
  message: string;
}

export interface CodexAppServerClient {
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  waitForNotification<T>(
    method: string,
    predicate: (params: T) => boolean,
    timeoutMs?: number,
  ): Promise<T>;
  close(): void;
}

interface CodexLoginStartResponse {
  type?: string;
  loginId?: string;
  authUrl?: string;
}

interface CodexLoginCompletedNotification {
  loginId?: string | null;
  success?: boolean;
  error?: string | null;
}

interface ParsedCodexResponse {
  finishReason: LanguageModelV2FinishReason;
  content: LanguageModelV2Content[];
}

interface SerializedTool {
  name: string;
  description?: string;
  inputSchema: JSONSchema7;
}

type PromptArrayContent = Exclude<LanguageModelV2CallOptions["prompt"][number]["content"], string>;
type PromptPart = PromptArrayContent[number];
type ToolResultPromptPart = Extract<PromptPart, { type: "tool-result" }>;

export function parseCodexLoginStatus(status: number | null, output: string): CodexLoginStatus {
  const message = output.trim() || (status === 0 ? "Logged in" : "Not logged in");
  if (message.includes("Logged in using ChatGPT")) {
    return { installed: true, loggedIn: true, authMode: "chatgpt", message };
  }
  if (message.includes("Logged in using an API key")) {
    return { installed: true, loggedIn: true, authMode: "api-key", message };
  }
  if (message.includes("Not logged in")) {
    return { installed: true, loggedIn: false, authMode: null, message };
  }
  return {
    installed: true,
    loggedIn: status === 0,
    authMode: status === 0 ? "chatgpt" : null,
    message,
  };
}

export function parseCodexModelListResult(result: unknown): ProviderModelInfo[] {
  const data =
    result && typeof result === "object" && "data" in result
      ? (result as { data?: unknown }).data
      : undefined;
  if (!Array.isArray(data)) return [];

  return data.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as {
      id?: unknown;
      model?: unknown;
      displayName?: unknown;
      hidden?: unknown;
    };
    if (item.hidden === true) return [];
    const id =
      typeof item.id === "string" ? item.id : typeof item.model === "string" ? item.model : null;
    if (!id) return [];
    const name =
      typeof item.displayName === "string" && item.displayName.trim() ? item.displayName : id;
    return [{ id, name }];
  });
}

export async function performCodexBrowserLogin(
  client: CodexAppServerClient,
  openUrl: (url: string) => boolean | Promise<boolean>,
  onEvent?: (message: string) => void,
): Promise<void> {
  onEvent?.("Starting Codex browser login...");

  const response = (await client.request("account/login/start", {
    type: "chatgpt",
  })) as CodexLoginStartResponse;

  if (response.type !== "chatgpt" || !response.loginId || !response.authUrl) {
    throw new Error("Codex returned an unexpected browser login response");
  }

  onEvent?.("Opening browser for Codex login...");
  const opened = await openUrl(response.authUrl);
  if (opened) {
    onEvent?.("Browser opened. Complete the login in ChatGPT.");
  } else {
    onEvent?.(`Could not open browser automatically. Open this URL manually: ${response.authUrl}`);
  }

  const completed = await client.waitForNotification<CodexLoginCompletedNotification>(
    "account/login/completed",
    (params) => params.loginId === response.loginId,
  );

  if (!completed.success) {
    throw new Error(completed.error ?? "Codex authentication failed.");
  }

  onEvent?.("Codex authentication complete.");
}

function getFunctionTools(options: LanguageModelV2CallOptions): SerializedTool[] {
  return (options.tools ?? []).flatMap((tool) => {
    if (tool.type !== "function") return [];
    return [
      {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
    ];
  });
}

function renderDataValue(data: unknown): string {
  if (typeof data === "string") return data.startsWith("data:") ? "inline-data-url" : data;
  if (data instanceof URL) return data.toString();
  if (data instanceof Uint8Array) return `binary:${data.byteLength} bytes`;
  return String(data);
}

function renderToolResult(output: ToolResultPromptPart): string {
  switch (output.output.type) {
    case "text":
    case "error-text":
      return output.output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.output.value, null, 2);
    case "content":
      return output.output.value
        .map((part: (typeof output.output.value)[number]) =>
          part.type === "text"
            ? part.text
            : `[media ${part.mediaType} ${Math.ceil(part.data.length / 4) * 3} bytes]`,
        )
        .join("\n");
    default:
      return JSON.stringify(output.output);
  }
}

function renderMessageContent(content: PromptArrayContent): string {
  return content
    .map((part: PromptPart) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "reasoning":
          return `[reasoning]\n${part.text}`;
        case "file":
          return `[file mediaType=${part.mediaType}${part.filename ? ` filename=${part.filename}` : ""} data=${renderDataValue(part.data)}]`;
        case "tool-call":
          return `[assistant tool call ${part.toolName} id=${part.toolCallId}]\n${JSON.stringify(part.input, null, 2)}`;
        case "tool-result":
          return `[tool result ${part.toolName} id=${part.toolCallId}]\n${renderToolResult(part)}`;
        default:
          return JSON.stringify(part);
      }
    })
    .join("\n\n");
}

function describeToolChoice(options: LanguageModelV2CallOptions): string {
  const choice = options.toolChoice;
  if (!choice || choice.type === "auto") {
    return "Client tools are available for this step. If a tool helps you answer correctly, return finishReason=tool-calls and request it.";
  }
  if (choice.type === "none") return "Do not call any tools. Answer directly.";
  if (choice.type === "required") return "You must call one or more tools before responding.";
  return `You must call the tool named ${choice.toolName} before responding.`;
}

export function serializeCodexPrompt(options: LanguageModelV2CallOptions): string {
  const tools = getFunctionTools(options);
  const transcript = options.prompt
    .map((message, index) => {
      const role = message.role.toUpperCase();
      const content =
        typeof message.content === "string"
          ? message.content
          : renderMessageContent(message.content);
      return `${index + 1}. ${role}\n${content}`;
    })
    .join("\n\n");

  const toolBlock =
    tools.length === 0
      ? "No tools are available for this step."
      : tools
          .map(
            (tool, index) =>
              `${index + 1}. ${tool.name}${tool.description ? ` — ${tool.description}` : ""}\nInput schema:\n${JSON.stringify(tool.inputSchema, null, 2)}`,
          )
          .join("\n\n");

  const jsonInstruction =
    options.responseFormat?.type === "json"
      ? `If you choose finishReason=stop, the text field must contain raw JSON matching this schema exactly:\n${JSON.stringify(options.responseFormat.schema ?? {}, null, 2)}`
      : "If you choose finishReason=stop, the text field must contain the assistant reply as plain text with no markdown wrapper.";

  return [
    "You are Codex running as the language-model backend for SoulForge.",
    "Operate only as a model adapter.",
    "Do not execute shell commands, edit files, browse the web, or use Codex internal tools.",
    "The tools listed below are external client tools. You ARE allowed to request them by returning toolCalls in your JSON response.",
    "Decide the next assistant step for the conversation transcript below.",
    "Return ONLY valid JSON that matches the provided output schema.",
    "When finishReason is tool-calls, leave text empty and fill toolCalls with the exact tool names and an inputJson string that is valid JSON for that tool.",
    jsonInstruction,
    describeToolChoice(options),
    "",
    "AVAILABLE TOOLS",
    toolBlock,
    "",
    "CONVERSATION TRANSCRIPT",
    transcript,
  ].join("\n");
}

export function buildCodexSchema(options: LanguageModelV2CallOptions): JSONSchema7 {
  const tools = getFunctionTools(options);
  const toolChoice = options.toolChoice;
  const finishReasons: string[] = [];

  if (!tools.length || toolChoice?.type === "none") finishReasons.push("stop");
  else if (toolChoice?.type === "required" || toolChoice?.type === "tool")
    finishReasons.push("tool-calls");
  else finishReasons.push("stop", "tool-calls");

  const allowedNames =
    toolChoice?.type === "tool" ? [toolChoice.toolName] : tools.map((tool) => tool.name);

  const toolCallItems: JSONSchema7 = tools.length
    ? {
        type: "object",
        additionalProperties: false,
        properties: {
          toolName: { type: "string", enum: allowedNames },
          inputJson: { type: "string" },
        },
        required: ["toolName", "inputJson"],
      }
    : {
        type: "object",
        additionalProperties: false,
        properties: {},
      };

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      finishReason: { type: "string", enum: finishReasons },
      reasoning: { type: "string" },
      text: { type: "string" },
      toolCalls: {
        type: "array",
        minItems:
          tools.length && (toolChoice?.type === "required" || toolChoice?.type === "tool") ? 1 : 0,
        maxItems: tools.length ? undefined : 0,
        items: toolCallItems,
      },
    },
    required: ["finishReason", "reasoning", "text", "toolCalls"],
  };
}

export function parseCodexResponse(text: string): ParsedCodexResponse {
  let parsed: {
    finishReason?: string;
    reasoning?: string;
    text?: string;
    toolCalls?: Array<{
      toolName?: string;
      input?: Record<string, unknown>;
      inputJson?: string;
    }>;
  };

  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { content: [{ type: "text", text }], finishReason: "stop" };
  }

  const content: LanguageModelV2Content[] = [];
  if (parsed.reasoning?.trim()) {
    content.push({ type: "reasoning", text: parsed.reasoning.trim() });
  }

  if (parsed.finishReason === "tool-calls") {
    const toolCalls = Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [];
    for (const toolCall of toolCalls) {
      if (!toolCall?.toolName) continue;
      const inputJson =
        typeof toolCall.inputJson === "string"
          ? toolCall.inputJson
          : JSON.stringify(toolCall.input ?? {});
      content.push({
        type: "tool-call",
        toolCallId: randomUUID(),
        toolName: toolCall.toolName,
        input: inputJson,
      });
    }
    if (content.length === 0 || content.every((part) => part.type === "reasoning")) {
      throw new Error("Codex returned finishReason=tool-calls without any tool calls");
    }
    return { content, finishReason: "tool-calls" };
  }

  if (parsed.text) {
    content.push({ type: "text", text: parsed.text });
  }

  return { content, finishReason: "stop" };
}

function collectWarnings(options: LanguageModelV2CallOptions): LanguageModelV2CallWarning[] {
  const warnings: LanguageModelV2CallWarning[] = [];
  for (const setting of [
    "maxOutputTokens",
    "temperature",
    "stopSequences",
    "topP",
    "topK",
    "presencePenalty",
    "frequencyPenalty",
    "seed",
  ] as const) {
    if (options[setting] !== undefined) {
      warnings.push({
        type: "unsupported-setting",
        setting,
        details: "Codex CLI ignores this setting",
      });
    }
  }
  return warnings;
}

class CodexCliRunner implements CodexRunner {
  async run(call: CodexRunnerCall): Promise<CodexRunnerResult> {
    const dir = await mkdtemp(join(tmpdir(), "soulforge-codex-"));
    const schemaPath = join(dir, "schema.json");
    await writeFile(schemaPath, JSON.stringify(call.schema, null, 2), "utf8");

    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "--config",
      'approval_policy="never"',
      "--cd",
      process.cwd(),
      "--output-schema",
      schemaPath,
      "--model",
      call.modelId,
    ];

    try {
      return await runCodexProcess(args, call.prompt, call.abortSignal);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

async function runCodexProcess(
  args: string[],
  prompt: string,
  abortSignal?: AbortSignal,
): Promise<CodexRunnerResult> {
  const child = spawn("codex", args, { signal: abortSignal });
  let spawnError: unknown | null = null;
  child.once("error", (error) => {
    spawnError = error;
  });

  if (!child.stdin || !child.stdout) {
    child.kill();
    throw new Error("Failed to start Codex CLI");
  }

  child.stdin.write(prompt);
  child.stdin.end();

  const stderrChunks: Buffer[] = [];
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
  }

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let finalText = "";
  let usage: LanguageModelV2Usage = {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
  };
  let turnFailure: string | null = null;
  let streamFailure: string | null = null;

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (event.type === "item.completed") {
        const item = event.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          finalText = item.text;
        }
      } else if (event.type === "turn.completed") {
        const rawUsage = event.usage as
          | { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
          | undefined;
        if (rawUsage) {
          usage = {
            inputTokens: rawUsage.input_tokens,
            outputTokens: rawUsage.output_tokens,
            totalTokens:
              rawUsage.input_tokens != null && rawUsage.output_tokens != null
                ? rawUsage.input_tokens + rawUsage.output_tokens
                : undefined,
            cachedInputTokens: rawUsage.cached_input_tokens,
          };
        }
      } else if (event.type === "turn.failed") {
        const error = event.error as { message?: string } | undefined;
        turnFailure = error?.message ?? "Codex turn failed";
      } else if (event.type === "error") {
        streamFailure = typeof event.message === "string" ? event.message : "Codex stream failed";
      }
    }

    if (spawnError) throw spawnError;
    const exit = await exitPromise;
    if (turnFailure) throw new Error(turnFailure);
    if (streamFailure) throw new Error(streamFailure);
    if (exit.code !== 0 || exit.signal) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const detail = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 1}`;
      throw new Error(`Codex exec exited with ${detail}${stderr ? `: ${stderr}` : ""}`);
    }
    if (!finalText) {
      throw new Error("Codex exec returned no final agent message");
    }
    return { text: finalText, usage };
  } finally {
    rl.close();
    child.removeAllListeners();
    try {
      if (!child.killed) child.kill();
    } catch {}
  }
}

function isCodexInstalled(): boolean {
  try {
    return spawnSync("codex", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

function getCodexLoginStatus(): CodexLoginStatus {
  try {
    const result = spawnSync("codex", ["login", "status"], {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.error) {
      return {
        installed: false,
        loggedIn: false,
        authMode: null,
        message: result.error.message,
      };
    }

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    return parseCodexLoginStatus(result.status, output);
  } catch (error) {
    return {
      installed: false,
      loggedIn: false,
      authMode: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function assertCodexReady(): void {
  const status = getCodexLoginStatus();
  if (!status.installed) {
    throw new Error("Codex CLI is not installed. Install Codex, then run `codex login`.");
  }
  if (!status.loggedIn) {
    throw new Error("Codex is not logged in. Run `codex login` and try again.");
  }
}

async function startCodexAppServerSession(): Promise<CodexAppServerClient> {
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!child.stdin || !child.stdout) {
    child.kill();
    throw new Error("Failed to start Codex app-server");
  }

  const stderrChunks: Buffer[] = [];
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
  }

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify(message)}\n`);

  let closed = false;
  let nextRequestId = 1;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  const listeners = new Set<(method: string, params: unknown) => void>();

  const shutdown = () => {
    if (closed) return;
    closed = true;
    rl.close();
    child.removeAllListeners();
    for (const waiter of pending.values()) {
      waiter.reject(new Error("Codex app-server connection closed"));
    }
    pending.clear();
    listeners.clear();
    try {
      if (!child.killed) child.kill();
    } catch {}
  };

  child.once("error", (error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    for (const waiter of pending.values()) {
      waiter.reject(err);
    }
    pending.clear();
  });

  child.once("exit", (code, signal) => {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    const err = new Error(
      stderr
        ? `Codex app-server exited with ${detail}: ${stderr}`
        : `Codex app-server exited with ${detail}`,
    );
    for (const waiter of pending.values()) {
      waiter.reject(err);
    }
    pending.clear();
  });

  rl.on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const id = typeof message.id === "number" ? message.id : null;
    if (id != null && pending.has(id)) {
      const waiter = pending.get(id);
      pending.delete(id);
      if (!waiter) return;
      if (message.error) {
        waiter.reject(
          new Error(
            typeof message.error === "object"
              ? JSON.stringify(message.error)
              : String(message.error),
          ),
        );
        return;
      }
      waiter.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") {
      const params = message.params;
      for (const listener of listeners) listener(message.method, params);
    }
  });

  const request = (method: string, params: Record<string, unknown>, timeoutMs = 30_000) => {
    const id = nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ id, method, params });
    });
  };

  const waitForNotification = <T>(
    method: string,
    predicate: (params: T) => boolean,
    timeoutMs = 300_000,
  ) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`Codex app-server notification ${method} timed out`));
      }, timeoutMs);

      const listener = (nextMethod: string, rawParams: unknown) => {
        if (nextMethod !== method) return;
        const params = rawParams as T;
        if (!predicate(params)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(params);
      };

      listeners.add(listener);
    });

  try {
    await request("initialize", {
      clientInfo: { name: "soulforge", title: "SoulForge", version: "0.0.0" },
    });
    send({ method: "initialized", params: {} });
    return {
      request,
      waitForNotification,
      close: shutdown,
    };
  } catch (error) {
    shutdown();
    throw error;
  }
}

async function requestCodexAppServer(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const session = await startCodexAppServerSession();
  try {
    return await session.request(method, params);
  } finally {
    session.close();
  }
}

async function fetchCodexModelsFromAppServer(): Promise<ProviderModelInfo[]> {
  const result = await requestCodexAppServer("model/list", {});
  return parseCodexModelListResult(result);
}

function openUrlInBrowser(url: string): boolean {
  try {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open";
    return spawnSync(command, [url], { stdio: "ignore", timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

export function runCodexBrowserLogin(onEvent?: (message: string) => void): {
  promise: Promise<void>;
  abort: () => void;
} {
  let session: CodexAppServerClient | null = null;
  let aborted = false;

  const promise = (async () => {
    const status = getCodexLoginStatus();
    if (!status.installed) {
      throw new Error("Codex CLI is not installed. Install Codex first.");
    }
    if (status.loggedIn) {
      onEvent?.("Codex is already logged in.");
      return;
    }

    session = await startCodexAppServerSession();
    if (aborted) {
      session.close();
      throw new Error("Codex login cancelled.");
    }

    try {
      await performCodexBrowserLogin(session, openUrlInBrowser, onEvent);
    } finally {
      session.close();
    }
  })();

  return {
    promise,
    abort: () => {
      aborted = true;
      session?.close();
    },
  };
}

class NullCodexRunner implements CodexRunner {
  async run(_call: CodexRunnerCall): Promise<CodexRunnerResult> {
    return {
      text: "",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }
}

export function createCodexLanguageModel(
  modelId: string,
  runner: CodexRunner = isCodexInstalled() ? new CodexCliRunner() : new NullCodexRunner(),
): LanguageModelV2 {
  const warningsFor = (options: LanguageModelV2CallOptions) => collectWarnings(options);

  return {
    specificationVersion: "v2",
    provider: "codex",
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      const warnings = warningsFor(options);
      const result = await runner.run({
        modelId,
        prompt: serializeCodexPrompt(options),
        schema: buildCodexSchema(options),
        abortSignal: options.abortSignal,
      });

      const parsed = parseCodexResponse(result.text);
      return {
        content: parsed.content,
        finishReason: parsed.finishReason,
        usage: result.usage,
        warnings,
      };
    },
    async doStream(options) {
      const generated = await this.doGenerate(options);
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: warningsFor(options) });
          for (const part of generated.content) {
            if (part.type === "reasoning") {
              const id = `${modelId}-reasoning-${randomUUID()}`;
              controller.enqueue({ type: "reasoning-start", id });
              controller.enqueue({ type: "reasoning-delta", id, delta: part.text });
              controller.enqueue({ type: "reasoning-end", id });
            } else if (part.type === "text") {
              const id = `${modelId}-text-${randomUUID()}`;
              controller.enqueue({ type: "text-start", id });
              controller.enqueue({ type: "text-delta", id, delta: part.text });
              controller.enqueue({ type: "text-end", id });
            } else if (part.type === "tool-call") {
              controller.enqueue(part);
            }
          }
          controller.enqueue({
            type: "finish",
            finishReason: generated.finishReason,
            usage: generated.usage,
          });
          controller.close();
        },
      });

      return { stream };
    },
  };
}

export const codex: ProviderDefinition = {
  id: "codex",
  name: "Codex",
  envVar: "",
  icon: "⌘",
  asciiIcon: "C",
  description: "OpenAI Codex subscription",
  createModel(modelId: string) {
    assertCodexReady();
    return createCodexLanguageModel(modelId);
  },
  async fetchModels() {
    const status = getCodexLoginStatus();
    if (!status.installed) return null;
    if (!status.loggedIn) {
      throw new Error("Codex is not logged in. Run `codex login`.");
    }
    return fetchCodexModelsFromAppServer();
  },
  fallbackModels: [],
  contextWindows: [],
  checkAvailability: async () => {
    const status = getCodexLoginStatus();
    return status.installed && status.loggedIn;
  },
};
