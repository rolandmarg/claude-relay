import type { ChannelConfig } from "./config.js";

export type LogEvent =
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

export function log(event: LogEvent, threadId: string, detail?: string) {
  const ts = new Date().toISOString();
  const parts = [ts, event, threadId];
  if (detail) parts.push(detail);
  console.log(parts.join(" | "));
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function channelTopic(ch: { topic?: string | null } | null | undefined): string {
  return ch?.topic ?? "";
}

export function sessionPrompt(
  channelName: string,
  channelDescription: string,
  threadName: string,
  notesDir: string,
  channelConfig: ChannelConfig,
): string {
  const lines = [
    `You are responding to a message from Discord channel #${channelName}.`,
    channelDescription ? `Channel description: ${channelDescription}` : "",
    `Thread: ${threadName}`,
  ];

  if (channelConfig.systemPrompt) {
    lines.push("", channelConfig.systemPrompt);
  }

  if (channelConfig.files?.length) {
    lines.push(
      "",
      "Before starting, read these files for context:",
      ...channelConfig.files.map((f) => `- ${f}`),
    );
  }

  lines.push(
    "",
    `When you produce notable findings, write them to ${notesDir}/${channelName}/.`,
    `Before starting work, scan ${notesDir}/ for relevant context from other channels.`,
  );

  return lines.filter(Boolean).join("\n");
}

export function checkpointPrompt(): string {
  return `[CHECKPOINT] Review your current state:
- What tasks did you start that aren't finished?
- Any changes you made that should be reverted or cleaned up?
- Any files left in a dirty state?
- Is your current work still aligned with what the user originally asked?
List anything outstanding, then continue.`;
}

export function teardownPrompt(notesDir: string): string {
  return `[SESSION ENDING] This session is going idle. Before shutdown:
- Summarize what was accomplished
- Flag anything left incomplete
- Write notable findings to ${notesDir}/`;
}
