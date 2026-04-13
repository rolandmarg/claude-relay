import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ChannelConfig {
  cwd?: string;
  systemPrompt?: string;
  files?: string[];
  allowedTools?: string[];
  additionalDirectories?: string[];
  permissionMode?: "default" | "acceptEdits" | "auto" | "bypassPermissions" | "plan";
}

interface ChannelConfigFile {
  defaults?: ChannelConfig;
  channels?: Record<string, ChannelConfig>;
}

export interface Config {
  discordToken: string;
  cwd: string;
  idleTimeout: number;
  checkpointInterval: number;
  notesDir: string;
  sweepInterval: number;
  sessionsFile: string;
  channelDefaults: ChannelConfig;
  channels: Record<string, ChannelConfig>;
}

export function resolveChannelConfig(config: Config, channelName: string): ChannelConfig {
  const channel = config.channels[channelName];
  if (!channel) return config.channelDefaults;
  return {
    ...config.channelDefaults,
    ...channel,
    // Merge arrays instead of replacing
    files: [...(config.channelDefaults.files ?? []), ...(channel.files ?? [])],
    allowedTools: channel.allowedTools ?? config.channelDefaults.allowedTools,
    additionalDirectories: [
      ...(config.channelDefaults.additionalDirectories ?? []),
      ...(channel.additionalDirectories ?? []),
    ],
  };
}

export async function loadConfig(): Promise<Config> {
  const discordToken = process.env.DISCORD_TOKEN;
  if (!discordToken) {
    console.error("DISCORD_TOKEN is required");
    process.exit(1);
  }

  const projectRoot = new URL("..", import.meta.url).pathname;
  const cwd = process.env.RELAY_CWD ?? process.cwd();

  // Load channel config file
  let channelDefaults: ChannelConfig = {};
  let channels: Record<string, ChannelConfig> = {};

  const configPath = process.env.RELAY_CHANNELS_FILE ?? join(projectRoot, "relay-channels.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as ChannelConfigFile;
    channelDefaults = parsed.defaults ?? {};
    channels = parsed.channels ?? {};
    console.log(`Loaded channel config from ${configPath} (${Object.keys(channels).length} channels)`);
  } catch {
    // No config file — use defaults for everything
  }

  return {
    discordToken,
    cwd,
    idleTimeout: Number(process.env.RELAY_IDLE_TIMEOUT) || 3_600_000,
    checkpointInterval: Number(process.env.RELAY_CHECKPOINT_INTERVAL) || 10,
    notesDir: process.env.RELAY_NOTES_DIR ?? "relay-notes",
    sweepInterval: Number(process.env.RELAY_SWEEP_INTERVAL) || 5 * 60_000,
    sessionsFile: process.env.RELAY_SESSIONS_FILE ?? join(projectRoot, "relay-sessions.json"),
    channelDefaults,
    channels,
  };
}
