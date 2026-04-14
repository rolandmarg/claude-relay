import type { ThreadChannel } from "discord.js";
import { generateTitle } from "./haiku.js";
import { incrementDobby, logDobby } from "./log.js";

const titledThreads = new Set<string>();

export function shouldWatchThread(
  threadOwnerId: string,
  relayBotId: string,
  selfId?: string,
): boolean {
  if (selfId && threadOwnerId === selfId) return false;
  return threadOwnerId === relayBotId;
}

export function extractFirstUserMessage(
  messages: Array<{ author: { bot: boolean; id: string }; content: string }>,
  relayBotId: string,
  selfId?: string,
): string | null {
  for (const msg of messages) {
    if (msg.author.id === relayBotId) continue;
    if (msg.author.bot) continue;
    if (selfId && msg.author.id === selfId) continue;
    return msg.content || null;
  }
  return null;
}

export async function autoTitle(
  thread: ThreadChannel,
  userMessage: string,
): Promise<void> {
  const threadId = thread.id;

  if (titledThreads.has(threadId)) return;
  titledThreads.add(threadId);

  incrementDobby("threads_detected");
  logDobby("THREAD_DETECTED", threadId, `"${userMessage.slice(0, 60)}"`);

  const title = await generateTitle(userMessage);
  if (!title) {
    incrementDobby("titles_failed");
    logDobby("TITLE_FAILED", threadId, "Haiku returned no title");
    return;
  }

  try {
    await thread.setName(title);
    incrementDobby("titles_applied");
    logDobby("TITLE_RENAMED", threadId, `"${title}"`);
  } catch (err) {
    incrementDobby("titles_failed");
    const msg = err instanceof Error ? err.message : String(err);
    logDobby("DISCORD_ERROR", threadId, `setName failed: ${msg}`);
  }
}

export async function onDobbyThreadCreate(
  thread: ThreadChannel,
  relayBotId: string,
  selfId: string,
): Promise<void> {
  const threadId = thread.id;
  if (titledThreads.has(threadId)) return;

  if (!shouldWatchThread(thread.ownerId ?? "", relayBotId, selfId)) return;

  try {
    const fetched = await thread.messages.fetch({ limit: 10 });
    const messages = [...fetched.values()].reverse();
    const userMessage = extractFirstUserMessage(
      messages.map((entry) => ({
        author: { bot: entry.author.bot, id: entry.author.id },
        content: entry.content,
      })),
      relayBotId,
      selfId,
    );

    if (userMessage) {
      await autoTitle(thread, userMessage);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logDobby("DISCORD_ERROR", threadId, `fetch messages failed: ${msg}`);
  }
}

export function clearDobbyCache() {
  titledThreads.clear();
}
