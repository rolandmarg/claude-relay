# claude-relay

Discord ↔ Claude Code session bridge. Each Discord thread becomes an independent Claude Code session.

## Setup

1. `bun install`
2. Set `DISCORD_TOKEN` environment variable (or use SOPS: `sops exec-env secrets.env 'bun run start'`)
3. Optionally create `relay-channels.json` for per-channel config (see below)
4. `bun run start`

## How it works

- Post a message in any channel → bot creates a thread and spawns a Claude Code session
- Each thread is an independent session with full Claude Code capabilities
- Sessions idle-timeout after 1 hour, resume automatically on next message
- Cross-thread awareness via shared `relay-notes/` directory
- Periodic checkpoint injections prevent drift and forgotten tasks
- Every 5 minutes, sweeps channels for unanswered messages and posts progress on active sessions

## Configuration

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | Yes | — | Discord bot token |
| `RELAY_CWD` | No | `process.cwd()` | Default working directory for sessions |
| `RELAY_IDLE_TIMEOUT` | No | `3600000` | Session idle timeout in ms (default: 1 hour) |
| `RELAY_CHECKPOINT_INTERVAL` | No | `10` | Turns between checkpoint injections |
| `RELAY_NOTES_DIR` | No | `relay-notes` | Directory for cross-thread shared findings |
| `RELAY_SWEEP_INTERVAL` | No | `300000` | Channel sweep interval in ms (default: 5 min) |
| `RELAY_CHANNELS_FILE` | No | `relay-channels.json` | Path to per-channel config file |

### Per-channel config (`relay-channels.json`)

Configure each Discord channel with its own working directory, files to inject, system prompt, and allowed tools:

```json
{
  "defaults": {
    "cwd": "/path/to/default/project",
    "permissionMode": "default"
  },
  "channels": {
    "research-models": {
      "systemPrompt": "Focus on image generation model research.",
      "files": ["docs/wiki/image-models.md", "data/presets.json"]
    },
    "research-harnesses": {
      "cwd": "/path/to/different/project",
      "systemPrompt": "Focus on GPU provisioning infrastructure.",
      "files": ["src/gpu/provision.ts"],
      "allowedTools": ["Read", "Glob", "Grep", "Bash"],
      "additionalDirectories": ["/path/to/extra/dir"]
    }
  }
}
```

Channel config options:

| Field | Description |
|-------|-------------|
| `cwd` | Working directory for sessions in this channel |
| `systemPrompt` | Additional instructions injected into the session |
| `files` | Files the session should read for context before starting |
| `allowedTools` | Restrict which Claude Code tools are available |
| `additionalDirectories` | Extra directories the session can access |
| `permissionMode` | Permission mode: `default`, `acceptEdits`, `auto`, `plan` |

See `relay-channels.example.json` for a full example.
