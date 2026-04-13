import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { SessionManager, type SessionEntry } from "./sessions.js";
import { splitMessage } from "./split.js";
import { join } from "node:path";

// --- Config ---

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is required");
  process.exit(1);
}

const PROJECT_ROOT = process.env.RELAY_CWD ?? process.cwd();
const IDLE_TIMEOUT = Number(process.env.RELAY_IDLE_TIMEOUT) || 3_600_000;
const CHECKPOINT_INTERVAL = Number(process.env.RELAY_CHECKPOINT_INTERVAL) || 10;
const NOTES_DIR = process.env.RELAY_NOTES_DIR ?? "relay-notes";
const SWEEP_INTERVAL = Number(process.env.RELAY_SWEEP_INTERVAL) || 5 * 60_000;
const SESSIONS_FILE =
  process.env.RELAY_SESSIONS_FILE ??
  join(new URL("..", import.meta.url).pathname, "relay-sessions.json");

// --- Prompt templates ---

function sessionPrompt(
  channelName: string,
  channelDescription: string,
  threadName: string,
): string {
  return [
    `You are responding to a message from Discord channel #${channelName}.`,
    channelDescription ? `Channel description: ${channelDescription}` : "",
    `Thread: ${threadName}`,
    "",
    `When you produce notable findings, write them to ${NOTES_DIR}/${channelName}/.`,
    `Before starting work, scan ${NOTES_DIR}/ for relevant context from other channels.`,
  ]
    .filter(Boolean)
    .join("\n");
}

const CHECKPOINT_PROMPT = `[CHECKPOINT] Review your current state:
- What tasks did you start that aren't finished?
- Any changes you made that should be reverted or cleaned up?
- Any files left in a dirty state?
- Is your current work still aligned with what the user originally asked?
List anything outstanding, then continue.`;

const TEARDOWN_PROMPT = `[SESSION ENDING] This session is going idle. Before shutdown:
- Summarize what was accomplished
- Flag anything left incomplete
- Write notable findings to ${NOTES_DIR}/`;

// --- Logging ---

type LogEvent =
  | "SESSION_START"
  | "SESSION_RESUME"
  | "SESSION_MESSAGE"
  | "SESSION_CHECKPOINT"
  | "SESSION_TEARDOWN"
  | "SESSION_ERROR"
  | "SWEEP_START"
  | "SWEEP_FOUND"
  | "SWEEP_BUSY"
  | "SWEEP_DONE";

function log(event: LogEvent, threadId: string, detail?: string) {
  const ts = new Date().toISOString();
  const parts = [ts, event, threadId];
  if (detail) parts.push(detail);
  console.log(parts.join(" | "));
}

// --- Helpers ---

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function channelTopic(ch: { topic?: string | null } | null | undefined): string {
  return ch?.topic ?? "";
}

async function sendChunks(thread: ThreadChannel, text: string) {
  for (const chunk of splitMessage(text)) {
    await thread.send(chunk);
  }
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

// --- Session Manager ---

const sessions = await SessionManager.load(SESSIONS_FILE, {
  cwd: PROJECT_ROOT,
  idleTimeout: IDLE_TIMEOUT,
  checkpointInterval: CHECKPOINT_INTERVAL,
  notesDir: NOTES_DIR,
  sessionsFile: SESSIONS_FILE,
});

const busyThreads = new Set<string>();

// Track channels with recent activity so sweep can skip quiet ones
const activeChannels = new Set<string>();

// --- Core functions ---

async function startSession(opts: {
  prompt: string;
  channelName: string;
  channelDescription: string;
  thread: ThreadChannel;
}) {
  const threadId = opts.thread.id;
  log("SESSION_START", threadId, opts.channelName);

  busyThreads.add(threadId);
  try {
    const { resultText, sessionId } = await drainStream(
      query({
        prompt: opts.prompt,
        options: {
          cwd: PROJECT_ROOT,
          permissionMode: "default",
          systemPrompt: {
            type: "preset" as const,
            preset: "claude_code" as const,
            append: sessionPrompt(
              opts.channelName,
              opts.channelDescription,
              opts.thread.name,
            ),
          },
        },
      }),
    );

    sessions.register(
      threadId,
      sessionId,
      opts.channelName,
      opts.channelDescription,
    );

    if (resultText) await sendChunks(opts.thread, resultText);
  } catch (err) {
    log("SESSION_ERROR", threadId, errMsg(err));
    await opts.thread.send(`Error: ${errMsg(err)}`).catch(console.error);
  } finally {
    busyThreads.delete(threadId);
  }
}

async function sendToSession(
  threadId: string,
  prompt: string,
  thread: ThreadChannel,
) {
  const entry = sessions.get(threadId);
  if (!entry) return;

  if (!entry.active) log("SESSION_RESUME", threadId);

  sessions.incrementTurn(threadId);

  let effectivePrompt = prompt;
  if (sessions.isCheckpointDue(threadId)) {
    log("SESSION_CHECKPOINT", threadId);
    effectivePrompt = CHECKPOINT_PROMPT + "\n\n" + prompt;
    sessions.resetCheckpoint(threadId);
  }

  log("SESSION_MESSAGE", threadId, `turn=${entry.turnCount}`);

  busyThreads.add(threadId);
  try {
    const { resultText, sessionId } = await drainStream(
      query({
        prompt: effectivePrompt,
        options: {
          cwd: PROJECT_ROOT,
          permissionMode: "default",
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
                  ),
                },
              }),
        },
      }),
    );

    sessions.updateSessionId(threadId, sessionId);
    if (resultText) await sendChunks(thread, resultText);
  } catch (err) {
    log("SESSION_ERROR", threadId, errMsg(err));
    await thread.send(`Error: ${errMsg(err)}`).catch(console.error);
    sessions.markInactive(threadId);
  } finally {
    busyThreads.delete(threadId);
  }
}

// --- Idle handler ---

sessions.setIdleHandler(async (threadId: string, entry: SessionEntry) => {
  log("SESSION_TEARDOWN", threadId);

  try {
    const channel = await client.channels.fetch(threadId);
    if (!channel?.isThread()) return;
    const thread = channel as ThreadChannel;

    const { resultText } = await drainStream(
      query({
        prompt: TEARDOWN_PROMPT,
        options: {
          cwd: PROJECT_ROOT,
          permissionMode: "default",
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

// --- Discord client ---

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const messageQueues = new Map<string, Promise<void>>();

function enqueue(id: string, fn: () => Promise<void>) {
  const prev = messageQueues.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (messageQueues.get(id) === next) messageQueues.delete(id);
  });
  messageQueues.set(id, next);
}

// --- MessageCreate handler ---

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.channel.isThread()) {
    const thread = message.channel as ThreadChannel;
    const threadId = thread.id;

    enqueue(threadId, async () => {
      const entry = sessions.get(threadId);
      if (entry) {
        await sendToSession(threadId, message.content, thread);
      } else {
        const parent = thread.parent;
        await startSession({
          prompt: message.content,
          channelName: parent?.name ?? "unknown",
          channelDescription: channelTopic(parent),
          thread,
        });
      }
    });
  } else {
    const channel = message.channel as TextChannel;
    activeChannels.add(channel.id);

    enqueue(message.id, async () => {
      await message.react("🔄").catch(console.error);
      try {
        const thread = await message.startThread({
          name: message.content.slice(0, 90) || `Session ${new Date().toISOString().slice(0, 16)}`,
          autoArchiveDuration: 1440,
        });
        await startSession({
          prompt: message.content,
          channelName: channel.name,
          channelDescription: channelTopic(channel),
          thread,
        });
      } catch (err) {
        log("SESSION_ERROR", message.id, errMsg(err));
      }
      await message.reactions
        .resolve("🔄")
        ?.users.remove(client.user?.id)
        .catch(console.error);
    });
  }
});

// --- Channel sweep ---

async function sweep() {
  log("SWEEP_START", "*");

  for (const guild of client.guilds.cache.values()) {
    // Fetch active threads once per guild (single API call)
    let guildActiveThreads: ReadonlyMap<string, ThreadChannel> | undefined;
    try {
      const fetched = await guild.channels.fetchActiveThreads();
      guildActiveThreads = fetched.threads as ReadonlyMap<string, ThreadChannel>;
    } catch {
      // no permission
    }

    const channels = guild.channels.cache.filter(
      (ch) => ch.type === ChannelType.GuildText,
    );

    for (const [channelId, channel] of channels) {
      // Skip channels with no recent activity since last sweep
      if (!activeChannels.has(channelId)) continue;

      const textChannel = channel as TextChannel;
      let messages;
      try {
        messages = await textChannel.messages.fetch({ limit: 50 });
      } catch {
        continue;
      }

      const channelName = textChannel.name;
      const channelDescription = channelTopic(textChannel);

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
            await startSession({
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

    // Post progress updates on busy threads
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

let sweepTimer: Timer;

// --- Graceful shutdown ---

async function shutdown() {
  console.log("Shutting down...");
  clearInterval(sweepTimer);
  await sessions.save();
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Boot ---

await client.login(DISCORD_TOKEN);
console.log(`claude-relay online as ${client.user?.tag}`);

sweepTimer = setInterval(() => sweep().catch(console.error), SWEEP_INTERVAL);
console.log(`Channel sweep every ${SWEEP_INTERVAL / 1000}s`);
