export type DobbyLogEvent =
  | "DOBBY_BOOT"
  | "DOBBY_DISABLED"
  | "DOBBY_SHUTDOWN"
  | "DOBBY_METRICS"
  | "THREAD_DETECTED"
  | "TITLE_GENERATED"
  | "TITLE_RENAMED"
  | "TITLE_FAILED"
  | "HAIKU_CALL"
  | "HAIKU_ERROR"
  | "DISCORD_ERROR";

const counters = {
  threads_detected: 0,
  titles_generated: 0,
  titles_applied: 0,
  titles_failed: 0,
  haiku_calls: 0,
  haiku_errors: 0,
  haiku_latency_total_ms: 0,
};

export type DobbyMetricName = keyof typeof counters;

export function logDobby(event: DobbyLogEvent, threadId: string, detail?: string) {
  const ts = new Date().toISOString();
  const parts = [ts, event, threadId];
  if (detail) parts.push(detail);
  console.log(parts.join(" | "));
}

export function incrementDobby(metric: DobbyMetricName, value = 1) {
  counters[metric] = (counters[metric] ?? 0) + value;
}

export function getDobbyMetrics(): Readonly<typeof counters> {
  return { ...counters };
}

export function logDobbyMetrics() {
  const metrics = getDobbyMetrics();
  const avgLatency = metrics.haiku_calls > 0
    ? Math.round(metrics.haiku_latency_total_ms / metrics.haiku_calls)
    : 0;
  logDobby("DOBBY_METRICS", "*", [
    `threads=${metrics.threads_detected}`,
    `titled=${metrics.titles_applied}`,
    `failed=${metrics.titles_failed}`,
    `haiku_calls=${metrics.haiku_calls}`,
    `haiku_errors=${metrics.haiku_errors}`,
    `avg_latency=${avgLatency}ms`,
  ].join(" "));
}
