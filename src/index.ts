import { Client, GatewayIntentBits, type ThreadChannel } from "discord.js";
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
    `Channel description: ${channelDescription}`,
    `Thread: ${threadName}`,
    "",
    `When you produce notable findings, write them to ${NOTES_DIR}/${channelName}/.`,
    `Before starting work, scan ${NOTES_DIR}/ for relevant context from other channels.`,
  ].join("\n");
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

function log(event: string, threadId: string, detail?: string) {
  const ts = new Date().toISOString();
  const parts = [ts, event, threadId];
  if (detail) parts.push(detail);
  console.log(parts.join(" | "));
}

// --- Session Manager ---

const sessions = await SessionManager.load(SESSIONS_FILE, {
  cwd: PROJECT_ROOT,
  idleTimeout: IDLE_TIMEOUT,
  checkpointInterval: CHECKPOINT_INTERVAL,
  notesDir: NOTES_DIR,
  sessionsFile: SESSIONS_FILE,
});

// --- Core function ---

async function sendToSession(
  threadId: string,
  prompt: string,
  thread: ThreadChannel,
) {
  const entry = sessions.get(threadId);
  if (!entry) return;

  if (!entry.active) {
    log("SESSION_RESUME", threadId);
  }

  sessions.incrementTurn(threadId);

  let effectivePrompt = prompt;
  if (sessions.isCheckpointDue(threadId)) {
    log("SESSION_CHECKPOINT", threadId);
    effectivePrompt = CHECKPOINT_PROMPT + "\n\n" + prompt;
    sessions.resetCheckpoint(threadId);
  }

  log(
    "SESSION_MESSAGE",
    threadId,
    `turn=${entry.turnCount}`,
  );

  try {
    let resultText = "";
    let sessionId = "";

    const stream = query({
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
    });

    for await (const message of stream) {
      if (message.type === "result") {
        sessionId = message.session_id;
        if (message.subtype === "success") {
          resultText = message.result;
        } else {
          resultText =
            message.errors?.join("\n") || "Session ended with an error.";
        }
      }
    }

    sessions.updateSessionId(threadId, sessionId);

    if (resultText) {
      const chunks = splitMessage(resultText);
      for (const chunk of chunks) {
        await thread.send(chunk);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("SESSION_ERROR", threadId, msg);
    await thread.send(`Error: ${msg}`).catch(console.error);
    sessions.markInactive(threadId);
  }
}

// --- Idle handler ---

sessions.setIdleHandler(async (threadId: string, entry: SessionEntry) => {
  log("SESSION_TEARDOWN", threadId);

  try {
    const channel = await client.channels.fetch(threadId);
    if (!channel?.isThread()) return;
    const thread = channel as ThreadChannel;

    let resultText = "";

    const stream = query({
      prompt: TEARDOWN_PROMPT,
      options: {
        cwd: PROJECT_ROOT,
        permissionMode: "default",
        resume: entry.sessionId,
      },
    });

    for await (const message of stream) {
      if (message.type === "result" && message.subtype === "success") {
        resultText = message.result;
      }
    }

    if (resultText) {
      const chunks = splitMessage(resultText);
      for (const chunk of chunks) {
        await thread.send(chunk);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("SESSION_ERROR", threadId, msg);
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

// Serialize messages per thread — one at a time
const messageQueues = new Map<string, Promise<void>>();

function enqueue(threadId: string, fn: () => Promise<void>) {
  const prev = messageQueues.get(threadId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  messageQueues.set(threadId, next);
}

// --- MessageCreate handler ---

client.on("messageCreate", async (message) => {
  // Ignore bots (including self)
  if (message.author.bot) return;

  if (message.channel.isThread()) {
    const thread = message.channel as ThreadChannel;
    const threadId = thread.id;

    enqueue(threadId, async () => {
      const entry = sessions.get(threadId);

      if (entry) {
        // Existing session — send to it
        await sendToSession(threadId, message.content, thread);
      } else {
        // New session in an existing thread — create one
        const parent = thread.parent;
        const channelName = parent?.name ?? "unknown";
        const channelDescription =
          (parent && "topic" in parent ? (parent.topic ?? "") : "") || "";

        log("SESSION_START", threadId, channelName);

        try {
          let resultText = "";
          let sessionId = "";

          const stream = query({
            prompt: message.content,
            options: {
              cwd: PROJECT_ROOT,
              permissionMode: "default",
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: sessionPrompt(
                  channelName,
                  channelDescription,
                  thread.name,
                ),
              },
            },
          });

          for await (const msg of stream) {
            if (msg.type === "result") {
              sessionId = msg.session_id;
              if (msg.subtype === "success") {
                resultText = msg.result;
              } else {
                resultText =
                  msg.errors?.join("\n") || "Session ended with an error.";
              }
            }
          }

          sessions.register(threadId, sessionId, channelName, channelDescription);

          if (resultText) {
            const chunks = splitMessage(resultText);
            for (const chunk of chunks) {
              await thread.send(chunk);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("SESSION_ERROR", threadId, msg);
          await thread.send(`Error: ${msg}`).catch(console.error);
        }
      }
    });
  } else {
    // Top-level channel message — create a thread
    const threadName = message.content.slice(0, 90);
    const channelName = "name" in message.channel ? (message.channel.name ?? "unknown") : "unknown";
    const channelDescription =
      "topic" in message.channel ? (message.channel.topic ?? "") : "";

    enqueue(message.id, async () => {
      await message.react("🔄").catch(console.error);

      try {
        const thread = await message.startThread({
          name: threadName,
          autoArchiveDuration: 1440,
        });
        const threadId = thread.id;

        log("SESSION_START", threadId, channelName);

        let resultText = "";
        let sessionId = "";

        const stream = query({
          prompt: message.content,
          options: {
            cwd: PROJECT_ROOT,
            permissionMode: "default",
            systemPrompt: {
              type: "preset" as const,
              preset: "claude_code" as const,
              append: sessionPrompt(channelName, channelDescription, thread.name),
            },
          },
        });

        for await (const msg of stream) {
          if (msg.type === "result") {
            sessionId = msg.session_id;
            if (msg.subtype === "success") {
              resultText = msg.result;
            } else {
              resultText =
                msg.errors?.join("\n") || "Session ended with an error.";
            }
          }
        }

        sessions.register(threadId, sessionId, channelName, channelDescription);

        if (resultText) {
          const chunks = splitMessage(resultText);
          for (const chunk of chunks) {
            await thread.send(chunk);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("SESSION_ERROR", message.id, msg);
      }

      await message.reactions
        .resolve("🔄")
        ?.users.remove(client.user?.id)
        .catch(console.error);
    });
  }
});

// --- Graceful shutdown ---

async function shutdown() {
  console.log("Shutting down...");
  await sessions.save();
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Boot ---

await client.login(DISCORD_TOKEN);
console.log(`claude-relay online as ${client.user?.tag}`);
