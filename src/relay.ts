import { ChannelType, type Message, type TextChannel, type ThreadChannel } from "discord.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SessionManager, SessionEntry } from "./sessions.js";
import type { Config, ChannelConfig } from "./config.js";
import { resolveChannelConfig } from "./config.js";
import { splitMessage } from "./split.js";
import {
  log,
  errMsg,
  sessionPrompt,
  checkpointPrompt,
  teardownPrompt,
} from "./prompts.js";

// --- Helpers ---

async function sendChunks(thread: ThreadChannel, text: string, replyTo?: Message) {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0 && replyTo) {
      await replyTo.reply(chunks[i]).catch(() => thread.send(chunks[i]));
    } else {
      await thread.send(chunks[i]);
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
    const { resultText, sessionId } = await drainStream(
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
    );

    sessions.register(threadId, sessionId, opts.channelName, opts.channelDescription);
    if (resultText) await sendChunks(opts.thread, resultText, opts.replyTo);
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
    const { resultText, sessionId } = await drainStream(
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
    );

    sessions.updateSessionId(threadId, sessionId);
    if (resultText) await sendChunks(thread, resultText, replyTo);
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
              name: msg.content.slice(0, 90) || `Session ${new Date().toISOString().slice(0, 16)}`,
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
