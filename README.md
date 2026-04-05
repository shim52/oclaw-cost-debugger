# OClaw Cost Debugger

Local CLI that scans OpenClaw session history to find expensive sessions, explain why they got expensive, and suggest what to try next.

Runs entirely on your machine. No cloud, no uploads, no write-back.

## Install

```bash
git clone https://github.com/shim52/oclaw-cost-debugger
cd oclaw-cost-debugger
npm install
npm link          # makes `oclaw-cost-debugger` available globally
```

## Quick start

```bash
# See where your money is going
oclaw-cost-debugger dashboard --path ~/.openclaw/agents/main/sessions

# Find the costliest sessions
oclaw-cost-debugger scan --sort cost

# Deep-dive into a specific session
oclaw-cost-debugger inspect 21fd        # by ID prefix
oclaw-cost-debugger inspect --rank 1 --sort cost   # the most expensive one

# Check if a session is getting healthier over time
oclaw-cost-debugger validate 21fd
```

## Commands

### `dashboard` — one-screen overview

Shows total cost, cost breakdown by channel and issue type, top sessions, and quick wins with estimated savings.

```bash
oclaw-cost-debugger dashboard
oclaw-cost-debugger dashboard --path ./sessions
oclaw-cost-debugger dashboard --format json
```

### `scan` — find the costliest sessions

Ranks sessions by cost or token usage. Each session gets a heuristic diagnosis and action recommendation.

```bash
oclaw-cost-debugger scan                              # default top 5 by tokens
oclaw-cost-debugger scan --sort cost -v               # verbose, sorted by cost
oclaw-cost-debugger scan -n 10 --sort cost            # top 10 by cost
oclaw-cost-debugger scan --include-empty              # include zero-activity sessions
oclaw-cost-debugger scan --format markdown            # pipe-friendly output
```

### `inspect` — deep-dive into a session

Shows full stats, heuristic diagnosis with evidence, and remediations with confidence levels.

```bash
oclaw-cost-debugger inspect <session-id>              # by full or prefix ID
oclaw-cost-debugger inspect --rank 1 --sort cost      # inspect the costliest
oclaw-cost-debugger inspect --rank 2 --format json    # JSON output for scripting
```

### `find` — search and filter sessions

```bash
oclaw-cost-debugger find --model gpt-5
oclaw-cost-debugger find --min-tokens 50000
oclaw-cost-debugger find --after 2026-03-01
```

### `validate` — check if a session is getting healthier

Compares recent turns against older turns within the same session to see whether token burn, context growth, and error patterns are improving. Designed for long-lived sessions (WhatsApp owner chats, persistent main sessions) where you don't get a clean "new session" boundary.

```bash
oclaw-cost-debugger validate <session-id>              # by full or prefix ID
oclaw-cost-debugger validate --rank 1 --sort cost      # validate the costliest
oclaw-cost-debugger validate 21fd --strategy halves    # split at midpoint
oclaw-cost-debugger validate 21fd --strategy time-24h  # last 24h vs prior 24h
oclaw-cost-debugger validate 21fd --format json        # for scripting
```

Produces a verdict:

| Verdict | Meaning |
|---------|---------|
| `likely_improved` | Burden metrics (cost, context, cache-read) clearly better with no worsening |
| `mixed_signals` | Some burden metrics improved, others worsened — no clear practical improvement |
| `no_clear_improvement` | Burden metrics are flat — changes have not produced measurable cost reduction |
| `still_recurring` | The diagnosed pattern (bloat, looping, etc.) is still active and burden is not decreasing |
| `worse` | Burden metrics have materially worsened since the baseline |
| `insufficient_data` | Not enough turns to compare — check back later |

Each verdict includes confidence level, evidence, and actionable guidance.

### `report` — full diagnostic report

Generates scan + diagnosis for the top N sessions. Useful for saving or sharing.

```bash
oclaw-cost-debugger report --top 5 --format markdown > report.md
oclaw-cost-debugger report -o report.txt
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
