---
name: tenet:diagnose
description: >
  Diagnose tenet project issues by inspecting SQLite state, job history, event logs,
  and .tenet/ directory structure. Use when: tenet is misbehaving, jobs are stuck,
  eval keeps failing, MCP server won't start, or you need to understand what happened
  during an autonomous run.
  Triggers on: 'tenet diagnose', 'what went wrong', 'why did tenet fail',
  'debug tenet', 'tenet health', 'check tenet state'.
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
---

# Tenet Diagnose Skill

You are a tenet diagnostic expert. You know tenet's internals: SQLite schema, job lifecycle, MCP server architecture, adapter invocation, and the .tenet/ directory structure.

## Quick Start

Run these diagnostic queries to get a full picture:

### 1. Project structure check

```bash
# Verify .tenet directory exists and has expected structure
ls -la .tenet/
ls -la .tenet/.state/
```

Expected: `interview/`, `spec/`, `harness/`, `status/`, `knowledge/`, `journal/`, `steer/`, `bootstrap/`, `visuals/`, `.state/` directories. `.state/` should contain `tenet.db` and optionally `config.json`.

### 2. Database health

```bash
# Check DB exists and is readable
sqlite3 .tenet/.state/tenet.db "PRAGMA integrity_check"

# Schema version check — verify all expected columns exist
sqlite3 .tenet/.state/tenet.db "PRAGMA table_info(jobs)"
```

Expected columns: `id, type, status, params, agent_name, created_at, started_at, completed_at, last_heartbeat, retry_count, max_retries, parent_job_id, error, output, server_id`

### 3. Job status overview

```bash
# Summary counts by type and status
sqlite3 .tenet/.state/tenet.db "SELECT type, status, COUNT(*) FROM jobs GROUP BY type, status ORDER BY type, status"

# Any stuck 'running' jobs?
sqlite3 .tenet/.state/tenet.db "SELECT id, type, substr(json_extract(params, '$.name'), 1, 50) as name, datetime(started_at/1000, 'unixepoch', 'localtime') as started, datetime(last_heartbeat/1000, 'unixepoch', 'localtime') as heartbeat FROM jobs WHERE status='running'"
```

### 4. Failed jobs analysis

```bash
# Show all failures with error messages
sqlite3 .tenet/.state/tenet.db "SELECT substr(json_extract(params, '$.name'), 1, 50) as name, type, error, datetime(completed_at/1000, 'unixepoch', 'localtime') as failed_at, (completed_at - started_at)/1000 as dur_sec FROM jobs WHERE status='failed' ORDER BY completed_at"
```

Common failure patterns:
- **"stall detected"** — server restarted while job was running. Check if server_id column exists (migration may be needed). Run `tenet init --upgrade`.
- **"invocation timed out after Xms"** — adapter timeout too short. Check `tenet config` for timeout setting. Default is 30 minutes.
- **"Not inside a trusted directory"** — git safe.directory issue. Run: `git config --global --add safe.directory <project-path>`
- **"no agent adapter available"** — the configured agent CLI is not installed or not in PATH.

### 5. Job timeline

```bash
# Full job execution timeline
sqlite3 .tenet/.state/tenet.db "SELECT datetime(started_at/1000, 'unixepoch', 'localtime') as started, datetime(completed_at/1000, 'unixepoch', 'localtime') as done, type, status, substr(json_extract(params, '$.name'), 1, 40) as name, (completed_at - started_at)/1000 as dur_sec FROM jobs WHERE started_at IS NOT NULL ORDER BY started_at"
```

### 6. Event log

```bash
# Recent events (last 20)
sqlite3 .tenet/.state/tenet.db "SELECT datetime(timestamp/1000, 'unixepoch', 'localtime') as time, job_id, event, substr(data, 1, 100) as data FROM events ORDER BY id DESC LIMIT 20"

# Check for orphaned job resets
sqlite3 .tenet/.state/tenet.db "SELECT * FROM events WHERE event='orphaned_jobs_reset'"
```

### 7. Config check

```bash
# SQLite config
sqlite3 .tenet/.state/tenet.db "SELECT * FROM config"

# JSON config (source of truth)
cat .tenet/.state/config.json
```

The JSON config file is the source of truth. On server startup, it overwrites SQLite config values. If they disagree, the JSON values win.

### 8. Steer messages

```bash
# Pending steer messages
sqlite3 .tenet/.state/tenet.db "SELECT id, class, status, substr(content, 1, 80) as content FROM steer_messages WHERE status != 'resolved' ORDER BY timestamp"
```

### 9. Git vs DB desync check

```bash
# Compare git commits to completed dev jobs
# Git commits with tenet prefix
git log --oneline --grep="tenet(" | head -20

# Completed dev jobs
sqlite3 .tenet/.state/tenet.db "SELECT substr(json_extract(params, '$.name'), 1, 50) as name FROM jobs WHERE type='dev' AND status='completed'"

# Pending dev jobs (check if any were implemented outside MCP)
sqlite3 .tenet/.state/tenet.db "SELECT substr(json_extract(params, '$.name'), 1, 50) as name FROM jobs WHERE type='dev' AND status='pending'"
```

If git has commits for features that are "pending" in the DB, the agent bypassed the MCP pipeline. This usually happens when the MCP server crashed and the agent continued without it.

### 10. MCP server status

```bash
# Check if tenet serve process is running
ps aux | grep "tenet serve" | grep -v grep

# Check for background server PID file
cat .tenet/.state/server.pid 2>/dev/null

# Test MCP server connectivity (start in foreground to see errors)
tenet serve --project .
```

## Common Issues and Fixes

### Jobs stuck as "running" after server restart
The server_id mechanism should auto-recover these on restart. If it doesn't:
```bash
# Manual fix: reset stuck running jobs to pending
sqlite3 .tenet/.state/tenet.db "UPDATE jobs SET status='pending', started_at=NULL, last_heartbeat=NULL, server_id=NULL WHERE status='running'"
```

### Eval jobs always timing out
Check adapter timeout: `tenet config`. Default is 30 min. For Playwright e2e jobs that need to start servers + run tests, this may need to be higher.

### Agent using wrong CLI
```bash
# Check configured agent
sqlite3 .tenet/.state/tenet.db "SELECT * FROM config WHERE key='default_agent'"
cat .tenet/.state/config.json

# Verify agent is available
which claude && claude --version
which opencode && opencode --version
which codex && codex --version
```

### Database locked errors
Tenet uses WAL mode for concurrent reads. If you see "database locked":
```bash
# Check for other processes holding the DB
fuser .tenet/.state/tenet.db 2>/dev/null || lsof .tenet/.state/tenet.db
```

### Playwright MCP not working
```bash
# Check if installed
npm list -g @playwright/mcp
npx --no-install @playwright/mcp --help

# Check .mcp.json for playwright entry
cat .mcp.json | grep -A3 playwright

# Check if browsers are installed
npx playwright install --dry-run
```

## Reporting

After running diagnostics, summarize:
1. **Health**: Is the DB healthy? Are there stuck jobs?
2. **Timeline**: What was the last successful job? When did things go wrong?
3. **Root cause**: What caused the failure? (timeout, stall, crash, config, etc.)
4. **Recovery**: What's the recommended fix?
