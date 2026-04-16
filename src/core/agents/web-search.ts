import type { LanguageModel } from "ai";
import { stepCountIs, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import { getModelId, supportsTemperature } from "../llm/provider-options.js";
import { fetchPageTool } from "../tools/fetch-page.js";
import { webSearchScraper } from "../tools/web-search-scraper.js";
import { repairToolCall, sanitizeToolInputsStep } from "./stream-options.js";

const WEB_SEARCH_INSTRUCTIONS = `You are a web search agent. Your job is to find accurate, up-to-date information from the web.

You have two tools:
- **web_search** — search the web with a query. Returns snippets and URLs.
- **fetch_page** — fetch a page URL and read its full content.

Strategy:
1. Start with a web_search for the user's query
2. If the snippets answer the question fully, synthesize and respond
3. If you need more detail, use fetch_page on the most promising URLs
4. You may run multiple searches with refined queries if the first results are insufficient

Output a clear, well-structured summary of your findings. Include source URLs for key facts.`;

export function createWebSearchAgent(
  model: LanguageModel,
  opts?: { onApproveFetchPage?: (url: string) => Promise<boolean> },
) {
  return new ToolLoopAgent({
    id: "web-search",
    model,
    ...(supportsTemperature(getModelId(model)) ? { temperature: 0 } : {}),
    tools: {
      web_search: tool({
        description: webSearchScraper.description,
        inputSchema: z.object({
          query: z.string().describe("Search query"),
          count: z.number().nullable().describe("Number of results (default 5)"),
        }),
        execute: (args) => webSearchScraper.execute({ ...args, count: args.count ?? undefined }),
      }),
      fetch_page: tool({
        description: fetchPageTool.description,
        inputSchema: z.object({
          url: z.string().describe("URL to fetch"),
        }),
        execute: async (args) => {
          if (opts?.onApproveFetchPage) {
            const approved = await opts.onApproveFetchPage(args.url);
            if (!approved) {
              return { success: false, output: "Page fetch denied by user.", error: "denied" };
            }
          }
          return fetchPageTool.execute(args);
        },
      }),
    },
    instructions: WEB_SEARCH_INSTRUCTIONS,
    stopWhen: stepCountIs(15),
    prepareStep: sanitizeToolInputsStep,
    experimental_repairToolCall: repairToolCall,
  });
}
