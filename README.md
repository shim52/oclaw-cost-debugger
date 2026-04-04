# Agent Cost Debugger

Local CLI that scans OpenClaw session history to find expensive sessions, explain why they got expensive, and suggest what to try next.

Runs entirely on your machine. No cloud, no uploads, no write-back.

## Install

```bash
npm install
npm link          # makes `agent-cost-debugger` available globally
```

## Quick start

```bash
# See where your money is going
agent-cost-debugger dashboard --path ~/.openclaw/agents/main/sessions

# Find the costliest sessions
agent-cost-debugger scan --sort cost

# Deep-dive into a specific session
agent-cost-debugger inspect 21fd        # by ID prefix
agent-cost-debugger inspect --rank 1 --sort cost   # the most expensive one
```

## Commands

### `dashboard` — one-screen overview

Shows total cost, cost breakdown by channel and issue type, top sessions, and quick wins with estimated savings.

```bash
agent-cost-debugger dashboard
agent-cost-debugger dashboard --path ./sessions
agent-cost-debugger dashboard --format json
```

### `scan` — find the costliest sessions

Ranks sessions by cost or token usage. Each session gets a heuristic diagnosis and action recommendation.

```bash
agent-cost-debugger scan                              # default top 5 by tokens
agent-cost-debugger scan --sort cost -v               # verbose, sorted by cost
agent-cost-debugger scan -n 10 --sort cost            # top 10 by cost
agent-cost-debugger scan --include-empty              # include zero-activity sessions
agent-cost-debugger scan --format markdown            # pipe-friendly output
```

### `inspect` — deep-dive into a session

Shows full stats, heuristic diagnosis with evidence, and remediations with confidence levels.

```bash
agent-cost-debugger inspect <session-id>              # by full or prefix ID
agent-cost-debugger inspect --rank 1 --sort cost      # inspect the costliest
agent-cost-debugger inspect --rank 2 --format json    # JSON output for scripting
```

### `find` — search and filter sessions

```bash
agent-cost-debugger find --model gpt-5
agent-cost-debugger find --min-tokens 50000
agent-cost-debugger find --after 2026-03-01
```

### `report` — full diagnostic report

Generates scan + diagnosis for the top N sessions. Useful for saving or sharing.

```bash
agent-cost-debugger report --top 5 --format markdown > report.md
agent-cost-debugger report -o report.txt
```

## What it detects

Each session gets one or more heuristic labels with confidence scores:

| Label | What it means |
|-------|--------------|
| `context_bloat` | Context keeps growing, re-sending old tokens every turn |
| `stale_scheduled_session` | Cron session with accumulated context that never resets |
| `looping_or_indecision` | Agent stuck in a loop without progress |
| `retry_churn` | Identical tool calls retried repeatedly |
| `tool_failure_cascade` | Cascading tool errors burning tokens on retries |
| `overpowered_simple_task` | Premium model on a task that doesn't need it |
| `weak_model_for_complex_step` | Economy model struggling with a complex task |
| `bad_task_decomposition` | Monolithic prompt leading to long, expensive runs |
| `relay_workflow` | Message relay (WhatsApp/Telegram) — usually expected cost |
| `scheduled_workflow` | Cron-triggered session — usually expected cost |

## Remediations

Each diagnosis includes remediations with:

- **Status** — `verified` (confirmed in your environment), `unverified` (plausible but unconfirmed), or `conceptual` (directional guidance)
- **Confidence** — `high`, `medium`, or `low` likelihood the fix helps
- **Savings estimate** — when calculable from your session data

The tool gives you honest guidance. If it can't verify a config option exists in your installation, it says so.

## Privacy

- All processing is local and read-only
- PII (phone numbers, emails) is automatically redacted in output
- Session data files are gitignored and never committed
- No network calls — works fully offline

## Running tests

```bash
npm test
```
