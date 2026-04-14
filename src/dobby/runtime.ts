import { Client, GatewayIntentBits } from "discord.js";
import { initHaiku } from "./haiku.js";
import { logDobby, logDobbyMetrics } from "./log.js";
import { onDobbyThreadCreate } from "./watcher.js";

export interface StartDobbyOptions {
  token?: string;
  anthropicApiKey?: string;
  relayBotId: string;
}

export async function startDobby(opts: StartDobbyOptions): Promise<{
  client: Client;
  shutdown: () => void;
} | null> {
  if (!opts.token && !opts.anthropicApiKey) {
    logDobby("DOBBY_DISABLED", "*", "No Dobby token or Anthropic key configured");
    return null;
  }

  if (!opts.token || !opts.anthropicApiKey) {
    logDobby("DOBBY_DISABLED", "*", "Dobby requires both DOBBY_DISCORD_TOKEN and ANTHROPIC_API_KEY");
    return null;
  }

  initHaiku(opts.anthropicApiKey);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on("threadCreate", async (thread) => {
    try {
      await onDobbyThreadCreate(thread, opts.relayBotId, client.user?.id ?? "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logDobby("DISCORD_ERROR", thread.id, `onDobbyThreadCreate error: ${msg}`);
    }
  });

  const metricsTimer = setInterval(() => logDobbyMetrics(), 5 * 60_000);

  await client.login(opts.token);
  logDobby("DOBBY_BOOT", "*", `Watching Relay (${opts.relayBotId}) threads as ${client.user?.tag}`);

  return {
    client,
    shutdown: () => {
      logDobby("DOBBY_SHUTDOWN", "*", "Dobby is going to sleep...");
      logDobbyMetrics();
      clearInterval(metricsTimer);
      client.destroy();
    },
  };
}
