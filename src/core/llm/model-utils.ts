/** Infer a provider group from a model ID prefix (pure function, no deps). */
export function inferModelGroup(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.startsWith("claude")) return "anthropic";
  if (
    id.startsWith("gpt") ||
    id.startsWith("o1-") ||
    id.startsWith("o3-") ||
    id.startsWith("o4-") ||
    id.startsWith("chatgpt")
  )
    return "openai";
  if (id.startsWith("gemini")) return "google";
  if (id.startsWith("grok")) return "xai";
  if (id.startsWith("llama") || id.startsWith("meta-")) return "meta";
  if (id.startsWith("mistral") || id.startsWith("codestral") || id.startsWith("pixtral"))
    return "mistral";
  if (id.startsWith("deepseek")) return "deepseek";
  return "other";
}
