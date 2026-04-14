import { ChannelType, type Message, type TextChannel, type ThreadChannel } from "discord.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SessionManager, SessionEntry } from "./sessions.js";
import type { Config, ChannelConfig } from "./config.js";
import { resolveChannelConfig } from "./config.js";
import { splitMessage } from "./split.js";
import { sanitizeName } from "./sanitize.js";
import {
  log,
  errMsg,
  sessionPrompt,
  checkpointPrompt,
  teardownPrompt,
} from "./prompts.js";

// --- Helpers ---

const CURSOR = " \u258D";
const MIN_EDIT_INTERVAL = 1_000;
const MAX_EDIT_INTERVAL = 10_000;

/** Retry a Discord API call once on rate-limit or 5xx. */
async function discordRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const code = (err as { httpStatus?: number }).httpStatus
      ?? (err as { status?: number }).status;
    if (code === 429 || (typeof code === "number" && code >= 500)) {
      await new Promise((r) => setTimeout(r, 3_000));
      return fn();
    }
    throw err;
  }
}

/** Send a message, falling back to plain send if reply fails with 50035. */
async function safeSend(
  thread: ThreadChannel,
  text: string,
  replyTo?: Message,
): Promise<Message> {
  if (replyTo) {
    try {
      return await discordRetry(() => replyTo.reply(text));
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      if (code === 50035) {
        // "Cannot reply to a system message" — fall through to plain send
      } else {
        throw err;
      }
    }
  }
  return discordRetry(() => thread.send(text));
}

/**
 * Stream a Claude Code session to Discord with progressive message editing.
 *
 * Shows a live progress indicator while Claude works (tool summaries),
 * then progressively sends the final result.
 */
async function streamToDiscord(
  stream: ReturnType<typeof query>,
  thread: ThreadChannel,
  replyTo?: Message,
): Promise<{ sessionId: string; resultText: string }> {
  let sessionId = "";
  let resultText = "";
  let progressMsg: Message | null = null;
  let lastEditTime = 0;
  let editInterval = MIN_EDIT_INTERVAL;
  let toolName = "";

  for await (const message of stream) {
    switch (message.type) {
      case "assistant": {
        // Extract tool names from content blocks for progress display
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use") {
              toolName = block.name as string;
            }
          }
        }
        break;
      }

      case "tool_use_summary": {
        const now = Date.now();
        if (now - lastEditTime >= editInterval) {
          const statusText = `_Working..._ ${toolName ? `(${toolName})` : ""}${CURSOR}`;
          try {
            if (!progressMsg) {
              progressMsg = await safeSend(thread, statusText, replyTo);
              // Don't reply to subsequent messages
              replyTo = undefined;
            } else {
              await discordRetry(() => progressMsg!.edit(statusText));
            }
            lastEditTime = now;
            editInterval = MIN_EDIT_INTERVAL;
          } catch {
            // Rate limited on edit — back off
            editInterval = Math.min(editInterval * 2, MAX_EDIT_INTERVAL);
          }
        }
        break;
      }

      case "tool_progress": {
        if (message.tool_name) toolName = message.tool_name;
        break;
      }

      case "result": {
        sessionId = message.session_id;
        if (message.subtype === "success") {
          resultText = message.result;
        } else {
          resultText = message.errors?.join("\n") || "Session ended with an error.";
        }
        break;
      }
    }
  }

  // Clean up progress message and send final result
  if (progressMsg && resultText) {
    // Try to edit progress message into start of result
    const chunks = splitMessage(resultText);
    try {
      await discordRetry(() => progressMsg!.edit(chunks[0]));
    } catch {
      // Edit failed — delete progress and send fresh
      await progressMsg.delete().catch(() => {});
      await safeSend(thread, chunks[0], replyTo);
    }
    // Send remaining chunks
    for (let i = 1; i < chunks.length; i++) {
      await discordRetry(() => thread.send(chunks[i]));
    }
  } else if (progressMsg && !resultText) {
    // No result — remove the progress message
    await progressMsg.delete().catch(() => {});
  } else if (!progressMsg && resultText) {
    // Never showed progress — just send the result
    const chunks = splitMessage(resultText);
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await safeSend(thread, chunks[i], replyTo);
      } else {
        await discordRetry(() => thread.send(chunks[i]));
      }
    }
  }

  return { sessionId, resultText };
}

/**
 * Send result text without streaming (for teardown / simple cases).
 */
async function sendChunks(thread: ThreadChannel, text: string, replyTo?: Message) {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) {
      await safeSend(thread, chunks[i], replyTo);
    } else {
      await discordRetry(() => thread.send(chunks[i]));
    }
  }
}

function startTyping(thread: ThreadChannel): Timer {
  thread.sendTyping().catch(() => {});
  return setInterval(() => thread.sendTyping().catch(() => {}), 8_000);
}

async function drainStream(
  stream: ReturnType<typeof query>,
): Promise<{ resultText: string; sessionId: string }> {
  let resultText = "";
  let sessionId = "";
  for await (const message of stream) {
    if (message.type === "result") {
      sessionId = message.session_id;
      resultText =
        message.subtype === "success"
          ? message.result
          : (message.errors?.join("\n") || "Session ended with an error.");
    }
  }
  return { resultText, sessionId };
}

function queryOptions(config: Config, channelConfig: ChannelConfig) {
  return {
    cwd: channelConfig.cwd ?? config.cwd,
    permissionMode: channelConfig.permissionMode ?? ("bypassPermissions" as const),
    ...(channelConfig.allowedTools && { allowedTools: channelConfig.allowedTools }),
    ...(channelConfig.additionalDirectories?.length && {
      additionalDirectories: channelConfig.additionalDirectories,
    }),
  };
}

// --- Exported state ---

export const busyThreads = new Set<string>();
export const activeChannels = new Set<string>();

// --- Core functions ---

export async function startSession(
  config: Config,
  sessions: SessionManager,
  opts: {
    prompt: string;
    channelName: string;
    channelDescription: string;
    thread: ThreadChannel;
    replyTo?: Message;
  },
): Promise<boolean> {
  const threadId = opts.thread.id;
  const channelConfig = resolveChannelConfig(config, opts.channelName);
  log("SESSION_START", threadId, opts.channelName);

  const typingTimer = startTyping(opts.thread);
  busyThreads.add(threadId);
  try {
    const { sessionId, resultText } = await streamToDiscord(
      query({
        prompt: opts.prompt,
        options: {
          ...queryOptions(config, channelConfig),
          systemPrompt: {
            type: "preset" as const,
            preset: "claude_code" as const,
            append: sessionPrompt(
              opts.channelName,
              opts.channelDescription,
              opts.thread.name,
              config.notesDir,
              channelConfig,
            ),
          },
        },
      }),
      opts.thread,
      opts.replyTo,
    );

    sessions.register(threadId, sessionId, opts.channelName, opts.channelDescription);
    return true;
  } catch (err) {
    log("SESSION_ERROR", threadId, errMsg(err));
    await opts.thread.send(`Error: ${errMsg(err)}`).catch(console.error);
    return false;
  } finally {
    clearInterval(typingTimer);
    busyThreads.delete(threadId);
  }
}

export async function sendToSession(
  config: Config,
  sessions: SessionManager,
  threadId: string,
  prompt: string,
  thread: ThreadChannel,
  replyTo?: Message,
): Promise<boolean> {
  const entry = sessions.get(threadId);
  if (!entry) return false;

  const channelConfig = resolveChannelConfig(config, entry.channelName);

  if (!entry.active) log("SESSION_RESUME", threadId);

  sessions.incrementTurn(threadId);

  let effectivePrompt = prompt;
  if (sessions.isCheckpointDue(threadId)) {
    log("SESSION_CHECKPOINT", threadId);
    effectivePrompt = checkpointPrompt() + "\n\n" + prompt;
    sessions.resetCheckpoint(threadId);
  }

  log("SESSION_MESSAGE", threadId, `turn=${entry.turnCount}`);

  const typingTimer = startTyping(thread);
  busyThreads.add(threadId);
  try {
    const { sessionId } = await streamToDiscord(
      query({
        prompt: effectivePrompt,
        options: {
          ...queryOptions(config, channelConfig),
          ...(entry.active
            ? { resume: entry.sessionId }
            : {
                systemPrompt: {
                  type: "preset" as const,
                  preset: "claude_code" as const,
                  append: sessionPrompt(
                    entry.channelName,
                    entry.channelDescription,
                    thread.name,
                    config.notesDir,
                    channelConfig,
                  ),
                },
              }),
        },
      }),
      thread,
      replyTo,
    );

    sessions.updateSessionId(threadId, sessionId);
    return true;
  } catch (err) {
    log("SESSION_ERROR", threadId, errMsg(err));
    await thread.send(`Error: ${errMsg(err)}`).catch(console.error);
    sessions.markInactive(threadId);
    return false;
  } finally {
    clearInterval(typingTimer);
    busyThreads.delete(threadId);
  }
}

export function setupIdleHandler(
  config: Config,
  sessions: SessionManager,
  getClient: () => { channels: { fetch(id: string): Promise<unknown> } },
) {
  sessions.setIdleHandler(async (threadId: string, entry: SessionEntry) => {
    log("SESSION_TEARDOWN", threadId);
    const channelConfig = resolveChannelConfig(config, entry.channelName);

    try {
      const channel = await getClient().channels.fetch(threadId);
      if (!channel || !(channel as { isThread?: () => boolean }).isThread?.()) return;
      const thread = channel as ThreadChannel;

      const { resultText } = await drainStream(
        query({
          prompt: teardownPrompt(config.notesDir),
          options: {
            ...queryOptions(config, channelConfig),
            resume: entry.sessionId,
          },
        }),
      );

      if (resultText) await sendChunks(thread, resultText);
    } catch (err) {
      log("SESSION_ERROR", threadId, errMsg(err));
    }

    sessions.markInactive(threadId);
  });
}

export async function sweep(
  config: Config,
  sessions: SessionManager,
  client: {
    guilds: { cache: Map<string, { channels: { cache: Map<string, unknown>; fetchActiveThreads(): Promise<{ threads: ReadonlyMap<string, ThreadChannel> }> } }> };
  },
  enqueue: (id: string, fn: () => Promise<void>) => void,
) {
  log("SWEEP_START", "*");

  for (const guild of client.guilds.cache.values()) {
    let guildActiveThreads: ReadonlyMap<string, ThreadChannel> | undefined;
    try {
      const fetched = await guild.channels.fetchActiveThreads();
      guildActiveThreads = fetched.threads;
    } catch {
      // no permission
    }

    const channels = [...(guild.channels.cache as Map<string, { type: number }>).entries()]
      .filter(([, ch]) => ch.type === ChannelType.GuildText);

    for (const [channelId, channel] of channels) {
      if (!activeChannels.has(channelId)) continue;

      const textChannel = channel as unknown as TextChannel;
      let messages;
      try {
        messages = await textChannel.messages.fetch({ limit: 50 });
      } catch {
        continue;
      }

      const channelName = textChannel.name;
      const channelDescription = textChannel.topic ?? "";

      for (const [, msg] of messages) {
        if (msg.author.bot) continue;
        if (msg.hasThread) continue;
        if (Date.now() - msg.createdTimestamp > 30 * 60_000) continue;

        log("SWEEP_FOUND", msg.id, `#${channelName}: "${msg.content.slice(0, 60)}"`);

        enqueue(msg.id, async () => {
          try {
            const thread = await msg.startThread({
              name: sanitizeName(msg.content),
              autoArchiveDuration: 1440,
            });
            await startSession(config, sessions, {
              prompt: msg.content,
              channelName,
              channelDescription,
              thread,
            });
          } catch (err) {
            log("SESSION_ERROR", msg.id, errMsg(err));
          }
        });
      }
    }

    if (guildActiveThreads) {
      for (const [threadId, thread] of guildActiveThreads) {
        if (!busyThreads.has(threadId)) continue;
        const entry = sessions.get(threadId);
        if (!entry) continue;

        const elapsed = Math.round((Date.now() - entry.lastActivity) / 1000);
        log("SWEEP_BUSY", threadId, `active for ${elapsed}s`);
        await thread
          .send(`_Still working... (${elapsed}s elapsed, turn ${entry.turnCount})_`)
          .catch(console.error);
      }
    }
  }

  activeChannels.clear();
  log("SWEEP_DONE", "*");
}
