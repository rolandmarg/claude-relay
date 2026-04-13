# claude-relay

Discord ↔ Claude Code session bridge. Each Discord thread becomes an independent Claude Code session.

## Setup

1. `bun install`
2. Set `DISCORD_TOKEN` environment variable (or use SOPS: `sops exec-env secrets.env 'bun run start'`)
3. `bun run start`

## How it works

- Post a message in any channel → bot creates a thread and spawns a Claude Code session
- Each thread is an independent session with full Claude Code capabilities
- Sessions idle-timeout after 1 hour, resume automatically on next message
- Cross-thread awareness via shared `relay-notes/` directory
- Periodic checkpoint injections prevent drift and forgotten tasks

## Configuration

Environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | Yes | — | Discord bot token |
| `RELAY_CWD` | No | `process.cwd()` | Working directory for Claude Code sessions |
| `RELAY_IDLE_TIMEOUT` | No | `3600000` | Session idle timeout in ms (default: 1 hour) |
| `RELAY_CHECKPOINT_INTERVAL` | No | `10` | Turns between checkpoint injections |
| `RELAY_NOTES_DIR` | No | `relay-notes` | Directory for cross-thread shared findings |
