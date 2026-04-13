import { Client, GatewayIntentBits, type TextChannel, type ThreadChannel } from "discord.js";
import { loadConfig } from "./config.js";
import { SessionManager } from "./sessions.js";
import { channelTopic, errMsg, log } from "./prompts.js";
import {
  startSession,
  sendToSession,
  setupIdleHandler,
  sweep,
  activeChannels,
  busyThreads,
} from "./relay.js";

const config = await loadConfig();

const sessions = await SessionManager.load(config.sessionsFile, {
  cwd: config.cwd,
  idleTimeout: config.idleTimeout,
  checkpointInterval: config.checkpointInterval,
  notesDir: config.notesDir,
  sessionsFile: config.sessionsFile,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

setupIdleHandler(config, sessions, () => client);

// --- Drain state ---

let draining = false;
const DRAIN_TIMEOUT = Number(process.env.RELAY_DRAIN_TIMEOUT) || 60_000;

// Per-thread message queue
const messageQueues = new Map<string, Promise<void>>();

function enqueue(id: string, fn: () => Promise<void>) {
  const prev = messageQueues.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (messageQueues.get(id) === next) messageQueues.delete(id);
  });
  messageQueues.set(id, next);
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (draining) {
    await message.react("⏳").catch(console.error);
    return;
  }

  if (message.channel.isThread()) {
    const thread = message.channel as ThreadChannel;
    const threadId = thread.id;

    enqueue(threadId, async () => {
      const entry = sessions.get(threadId);
      if (entry) {
        await sendToSession(config, sessions, threadId, message.content, thread);
      } else {
        const parent = thread.parent;
        await startSession(config, sessions, {
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
        await startSession(config, sessions, {
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

// --- Graceful shutdown with drain ---

const sweepTimer = setInterval(
  () => sweep(config, sessions, client, enqueue).catch(console.error),
  config.sweepInterval,
);

async function shutdown() {
  if (draining) return; // already shutting down
  draining = true;
  clearInterval(sweepTimer);

  const active = busyThreads.size;
  if (active > 0) {
    console.log(`Draining ${active} active session(s)... (timeout: ${DRAIN_TIMEOUT / 1000}s)`);

    const deadline = Date.now() + DRAIN_TIMEOUT;
    while (busyThreads.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (busyThreads.size > 0) {
        console.log(`  ${busyThreads.size} session(s) still active...`);
      }
    }

    if (busyThreads.size > 0) {
      console.log(`Drain timeout — ${busyThreads.size} session(s) interrupted`);
    } else {
      console.log("All sessions drained cleanly");
    }
  } else {
    console.log("No active sessions — shutting down immediately");
  }

  await sessions.save();
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Boot ---

await client.login(config.discordToken);
console.log(`claude-relay online as ${client.user?.tag}`);
console.log(`Channel sweep every ${config.sweepInterval / 1000}s`);
