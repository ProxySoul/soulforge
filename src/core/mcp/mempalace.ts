/**
 * mempalace.ts — MemPalace MCP integration helpers.
 *
 * All calls are fire-and-forget. MemPalace is optional — if the MCP server
 * isn't connected, every function silently returns. Never blocks the main
 * agent loop or compaction.
 */

import { getMCPManager } from "./index.js";

const SERVER_NAME = "mempalace";

function isConnected(): boolean {
  try {
    return getMCPManager().isConnected(SERVER_NAME);
  } catch {
    return false;
  }
}

async function callTool(tool: string, args: Record<string, unknown>): Promise<string | null> {
  if (!isConnected()) return null;
  try {
    return await getMCPManager().callTool(SERVER_NAME, tool, args);
  } catch {
    return null;
  }
}

// ─── Palace Storage ──────────────────────────────────────────────────

/** Save a compaction summary as a palace drawer. */
export function saveCompactionDrawer(summary: string, projectName: string): void {
  callTool("mempalace_add_drawer", {
    content: summary,
    wing: projectName,
    room: "compaction",
  });
}

// ─── Knowledge Graph ─────────────────────────────────────────────────

/** File an array of decisions as knowledge graph triples. */
export function saveDecisions(decisions: string[], projectName: string): void {
  for (const decision of decisions) {
    callTool("mempalace_kg_add", {
      subject: projectName,
      predicate: "decided",
      object: decision,
    });
  }
}

/** File an array of discoveries as knowledge graph triples. */
export function saveDiscoveries(discoveries: string[], projectName: string): void {
  for (const discovery of discoveries) {
    callTool("mempalace_kg_add", {
      subject: projectName,
      predicate: "discovered",
      object: discovery,
    });
  }
}

/** File an array of failures as knowledge graph triples. */
export function saveFailures(failures: string[], projectName: string): void {
  for (const failure of failures) {
    callTool("mempalace_kg_add", {
      subject: projectName,
      predicate: "failed",
      object: failure,
    });
  }
}

// ─── Agent Diary ─────────────────────────────────────────────────────

/** Write an AAAK diary entry for an agent. */
export function writeDiary(agentName: string, entry: string): void {
  callTool("mempalace_diary_write", {
    agent_name: agentName,
    entry,
  });
}

/** Read recent diary entries for an agent. Returns null if unavailable. */
export async function readDiary(agentName: string, count = 5): Promise<string | null> {
  return callTool("mempalace_diary_read", {
    agent_name: agentName,
    last_n: count,
  });
}

// ─── Wake-up Context ─────────────────────────────────────────────────

/** Get the L0+L1 wake-up context (~170 tokens). Returns null if unavailable. */
export async function getWakeupContext(wing?: string): Promise<string | null> {
  const args: Record<string, unknown> = {};
  if (wing) args.wing = wing;
  return callTool("mempalace_status", args);
}

// ─── Search ──────────────────────────────────────────────────────────

/** Search the palace. Returns null if unavailable. */
export async function searchMemory(query: string, wing?: string): Promise<string | null> {
  const args: Record<string, unknown> = { query };
  if (wing) args.wing = wing;
  return callTool("mempalace_search", args);
}

// ─── Compaction Hook ─────────────────────────────────────────────────

/**
 * Called at compaction time with the full working state.
 * Saves the summary as a drawer and files structured facts to the knowledge graph.
 */
export function onCompaction(
  summary: string,
  state: {
    decisions: string[];
    discoveries: string[];
    failures: string[];
  },
  cwd: string,
): void {
  if (!isConnected()) return;
  const projectName = cwd.split("/").pop() ?? "unknown";

  saveCompactionDrawer(summary, projectName);

  if (state.decisions.length > 0) saveDecisions(state.decisions, projectName);
  if (state.discoveries.length > 0) saveDiscoveries(state.discoveries, projectName);
  if (state.failures.length > 0) saveFailures(state.failures, projectName);
}

/** Check if MemPalace MCP server is available. */
export { isConnected as isMempalaceConnected };
