import Anthropic from "@anthropic-ai/sdk";
import { incrementDobby, logDobby } from "./log.js";
import { SYSTEM_PROMPT, titlePrompt } from "./personality.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

let client: Anthropic | null = null;

export function initHaiku(apiKey: string) {
  client = new Anthropic({ apiKey });
}

export function cleanTitle(raw: string): string | null {
  let title = raw.trim();

  if (
    (title.startsWith("\"") && title.endsWith("\""))
    || (title.startsWith("'") && title.endsWith("'"))
  ) {
    title = title.slice(1, -1);
  }

  if (title.toLowerCase().startsWith("title:")) {
    title = title.slice(6);
  }

  title = title.replace(/\.$/, "").trim();

  if (!title) return null;

  if (title.length > 80) {
    title = `${title.slice(0, 77)}...`;
  }

  return title;
}

export async function generateTitle(userMessage: string): Promise<string | null> {
  if (!client) {
    logDobby("HAIKU_ERROR", "*", "Haiku client not initialized");
    return null;
  }

  const start = Date.now();
  incrementDobby("haiku_calls");
  logDobby("HAIKU_CALL", "*", `${Math.min(userMessage.length, 500)} chars`);

  try {
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 30,
      temperature: 0.3,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: titlePrompt(userMessage) }],
    });

    const latency = Date.now() - start;
    incrementDobby("haiku_latency_total_ms", latency);

    const raw = response.content.find((block) => block.type === "text");
    const title = cleanTitle(raw?.type === "text" ? raw.text : "");

    if (title) {
      incrementDobby("titles_generated");
      logDobby("TITLE_GENERATED", "*", `"${title}" (${latency}ms)`);
    }

    return title;
  } catch (err) {
    incrementDobby("haiku_errors");
    const msg = err instanceof Error ? err.message : String(err);
    logDobby("HAIKU_ERROR", "*", msg);
    return null;
  }
}
