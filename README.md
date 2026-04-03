# Agent Cost Debugger

A local-only CLI that scans OpenClaw session history to answer:
1. **Which sessions cost the most?** — ranked by actual cost, not just tokens
2. **Why did they get expensive?** — heuristic diagnosis with evidence
3. **What can I do about it?** — actionable recommendations with estimated savings

Runs entirely on your machine. No cloud, no uploads, no write-back.

## Quickstart

```bash
npm install
npm test
npm link          # optional — makes `agent-cost-debugger` available globally
```

## Usage

### Scan — find the costliest sessions

```bash
agent-cost-debugger scan                          # default: ~/.openclaw/agents/
agent-cost-debugger scan --path ./sessions        # custom path
agent-cost-debugger scan --sort cost -v           # verbose with savings estimates
agent-cost-debugger scan -n 10 --sort cost        # top 10 by cost
```

### Inspect — deep-dive into a specific session

```bash
agent-cost-debugger inspect <session-id>          # by ID or prefix
agent-cost-debugger inspect --rank 1 --sort cost  # inspect the costliest
```

### Find — search and filter sessions

```bash
agent-cost-debugger find --model gpt-5.4
agent-cost-debugger find --min-tokens 50000
agent-cost-debugger find --after 2026-03-01
```

### Report — full diagnostic report

```bash
agent-cost-debugger report --top 5 --format markdown > report.md
agent-cost-debugger report --path ./sessions -o report.txt
```

## Diagnostics

Each session gets heuristic labels with confidence scores and actionable advice:

| Label | What it means | Typical fix |
|-------|--------------|-------------|
| `context_bloat` | Context keeps growing, re-sending old tokens | Reset session between runs |
| `stale_scheduled_session` | Cron session with accumulated context | Add session.reset() or compaction |
| `looping_or_indecision` | Agent loops without progress | Add loop detection or max-turn limits |
| `retry_churn` | Identical tool calls retried | Add error handling, break retry loops |
| `tool_failure_cascade` | Cascading tool errors | Fix underlying tool errors, add early-exit |
| `overpowered_simple_task` | Premium model on a simple task | Downgrade to mini/economy model |
| `weak_model_for_complex_step` | Economy model struggling | Upgrade model for complex tasks |
| `bad_task_decomposition` | Monolithic prompt, long agent runs | Split into smaller sub-tasks |
| `possible_provider_regression` | Abnormal token spike | Compare with historical averages |
| `relay_workflow` | Message forwarding (WhatsApp/Telegram) | Usually expected cost |
| `scheduled_workflow` | Cron-triggered session | Usually expected cost |

## Privacy

- All processing is local and read-only
- PII (phone numbers, emails) is automatically redacted in CLI output
- Session data files are gitignored and never committed
