import { Client, GatewayIntentBits, type TextChannel, type ThreadChannel } from "discord.js";
import { loadConfig } from "./config.js";
import { SessionManager } from "./sessions.js";
import { channelTopic, errMsg, log } from "./prompts.js";
import { startSession, sendToSession, setupIdleHandler, sweep, activeChannels } from "./relay.js";

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

// Graceful shutdown
const sweepTimer = setInterval(
  () => sweep(config, sessions, client, enqueue).catch(console.error),
  config.sweepInterval,
);

async function shutdown() {
  console.log("Shutting down...");
  clearInterval(sweepTimer);
  await sessions.save();
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await client.login(config.discordToken);
console.log(`claude-relay online as ${client.user?.tag}`);
console.log(`Channel sweep every ${config.sweepInterval / 1000}s`);
