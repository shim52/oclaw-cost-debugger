import { discoverSessions } from '../discovery.js';
import { parseTranscript } from '../parser.js';
import { estimateSessionCostFromMeta } from '../estimator.js';
import { analyzeSession } from '../heuristics.js';
import chalk from 'chalk';

export function registerDashboard(program) {
  program
    .command('dashboard')
    .description('Show a concise cost dashboard with breakdowns and quick wins')
    .option('-p, --path <path>', 'Custom OpenClaw sessions path')
    .option('-f, --format <format>', 'Output format: text, json', 'text')
    .option('--include-empty', 'Include sessions with zero tokens/cost')
    .action(async (opts) => {
      try {
        const sessions = await discoverSessions(opts.path);

        if (sessions.length === 0) {
          console.log(chalk.yellow('No OpenClaw sessions found.'));
          return;
        }

        // Filter out empty sessions unless --include-empty
        const filtered = opts.includeEmpty
          ? sessions
          : sessions.filter(s => s.meta.totalTokens > 0 || (s.meta.estimatedCostUsd || 0) > 0);

        // Build enriched session list
        const enriched = [];
        for (const s of filtered) {
          const cost = estimateSessionCostFromMeta(s.meta);
          const origin = s.meta.origin?.provider || 'unknown';
          let topLabel = null;
          let triage = null;
          let remediations = [];

          if (s.transcriptPath) {
            try {
              const { events } = await parseTranscript(s.transcriptPath);
              const analysis = analyzeSession(events, s.meta);
              topLabel = analysis.labels[0]?.label || 'clean_session';
              triage = analysis.triage;
              remediations = triage?.remediations || [];
            } catch { /* skip */ }
          }

          enriched.push({
            sessionId: s.sessionId,
            model: s.meta.model,
            origin,
            cost,
            totalTokens: s.meta.totalTokens,
            updatedAt: s.meta.updatedAt,
            topLabel,
            triage,
            remediations,
          });
        }

        if (opts.format === 'json') {
          console.log(JSON.stringify(buildDashboardData(enriched), null, 2));
          return;
        }

        console.log(renderDashboard(enriched));
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
}

function buildDashboardData(sessions) {
  const totalCost = sessions.reduce((s, x) => s + x.cost, 0);
  const totalTokens = sessions.reduce((s, x) => s + x.totalTokens, 0);

  // By origin
  const byOrigin = {};
  for (const s of sessions) {
    const key = s.origin;
    if (!byOrigin[key]) byOrigin[key] = { count: 0, cost: 0, tokens: 0 };
    byOrigin[key].count++;
    byOrigin[key].cost += s.cost;
    byOrigin[key].tokens += s.totalTokens;
  }

  // By diagnosis
  const byDiagnosis = {};
  for (const s of sessions) {
    const key = s.topLabel || 'unknown';
    if (!byDiagnosis[key]) byDiagnosis[key] = { count: 0, cost: 0 };
    byDiagnosis[key].count++;
    byDiagnosis[key].cost += s.cost;
  }

  // Collect all remediations with savings
  const quickWins = [];
  for (const s of sessions) {
    for (const r of s.remediations) {
      if (r.savings) {
        quickWins.push({
          sessionId: s.sessionId,
          origin: s.origin,
          title: r.title,
          savings: r.savings,
          confidence: r.confidence,
          savingsNum: parseSavings(r.savings),
        });
      }
    }
  }
  quickWins.sort((a, b) => b.savingsNum - a.savingsNum);

  return { totalCost, totalTokens, sessionCount: sessions.length, byOrigin, byDiagnosis, quickWins: quickWins.slice(0, 5) };
}

function renderDashboard(sessions) {
  const data = buildDashboardData(sessions);
  const W = 72;
  const lines = [];

  // Header
  lines.push('');
  lines.push(chalk.bold.cyan('┌' + '─'.repeat(W - 2) + '┐'));
  lines.push(chalk.bold.cyan('│') + centerText(chalk.bold.white(' Agent Cost Dashboard '), W - 2) + chalk.bold.cyan('│'));
  lines.push(chalk.bold.cyan('└' + '─'.repeat(W - 2) + '┘'));
  lines.push('');

  // Summary bar
  lines.push(chalk.bold.white('  Overview'));
  lines.push(chalk.dim('  ' + '─'.repeat(W - 4)));
  lines.push(`  Sessions: ${chalk.bold.white(data.sessionCount)}    Total Cost: ${colorCost(data.totalCost)}    Tokens: ${chalk.cyan(fmtNum(data.totalTokens))}`);
  lines.push('');

  // Cost by origin
  lines.push(chalk.bold.white('  Cost by Channel'));
  lines.push(chalk.dim('  ' + '─'.repeat(W - 4)));

  const origins = Object.entries(data.byOrigin).sort((a, b) => b[1].cost - a[1].cost);
  for (const [origin, info] of origins) {
    const pct = data.totalCost > 0 ? (info.cost / data.totalCost * 100) : 0;
    const bar = makeBar(pct, 20);
    lines.push(`  ${padRight(origin, 12)} ${colorCost(info.cost)}  ${bar} ${chalk.dim(`${pct.toFixed(0)}%`)}  ${chalk.dim(`${info.count} session(s)`)}`);
  }
  lines.push('');

  // Cost by diagnosis
  lines.push(chalk.bold.white('  Cost by Issue'));
  lines.push(chalk.dim('  ' + '─'.repeat(W - 4)));

  const diags = Object.entries(data.byDiagnosis).sort((a, b) => b[1].cost - a[1].cost);
  for (const [label, info] of diags) {
    const pct = data.totalCost > 0 ? (info.cost / data.totalCost * 100) : 0;
    const bar = makeBar(pct, 20);
    lines.push(`  ${colorLabel(padRight(label, 26))} ${colorCost(info.cost)}  ${bar} ${chalk.dim(`${pct.toFixed(0)}%`)}`);
  }
  lines.push('');

  // Top offenders
  const topSessions = [...sessions].sort((a, b) => b.cost - a.cost).slice(0, 5);
  lines.push(chalk.bold.white('  Top Sessions'));
  lines.push(chalk.dim('  ' + '─'.repeat(W - 4)));

  for (let i = 0; i < topSessions.length; i++) {
    const s = topSessions[i];
    const pct = data.totalCost > 0 ? (s.cost / data.totalCost * 100) : 0;
    lines.push(
      `  ${chalk.dim(`${i + 1}.`)} ${colorCost(s.cost)} ${chalk.dim(`(${pct.toFixed(0)}%)`)}  ` +
      `${chalk.cyan(s.origin)}  ${chalk.dim(s.sessionId.slice(0, 8))}  ` +
      `${colorLabel(s.topLabel || 'unknown')}`
    );
  }
  lines.push('');

  // Quick wins
  if (data.quickWins.length > 0) {
    lines.push(chalk.bold.white('  Quick Wins'));
    lines.push(chalk.dim('  ' + '─'.repeat(W - 4)));

    for (let i = 0; i < data.quickWins.length; i++) {
      const w = data.quickWins[i];
      const conf = w.confidence === 'high' ? chalk.green('high') : w.confidence === 'medium' ? chalk.yellow('med') : chalk.dim('low');
      lines.push(
        `  ${chalk.bold.yellow(w.savings)}  ${w.title}  ` +
        `${chalk.dim(w.origin + '/' + w.sessionId.slice(0, 8))}  [${conf}]`
      );
    }
    lines.push('');

    const totalSavings = data.quickWins.reduce((s, w) => s + w.savingsNum, 0);
    if (totalSavings > 0.01) {
      lines.push(chalk.bold(`  Potential savings from top ${data.quickWins.length} fixes: ${chalk.yellow.bold(`~$${totalSavings.toFixed(2)}`)}`));
      lines.push('');
    }
  }

  lines.push(chalk.dim(`  Run ${chalk.white('agent-cost-debugger inspect <id>')} for full diagnosis`));
  lines.push('');

  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────

function colorCost(cost) {
  const s = fmtCost(cost);
  if (cost >= 1) return chalk.red.bold(s);
  if (cost >= 0.10) return chalk.yellow(s);
  return chalk.green(s);
}

function fmtCost(cost) {
  if (cost == null || cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function fmtNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function parseSavings(str) {
  if (!str) return 0;
  const m = str.match(/\$([0-9.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function makeBar(pct, width) {
  const filled = Math.round(pct / 100 * width);
  const empty = width - filled;
  return chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

function padRight(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function centerText(str, width) {
  // strip ANSI for length calc
  const visible = str.replace(/\x1B\[[0-9;]*m/g, '');
  const pad = Math.max(0, Math.floor((width - visible.length) / 2));
  const right = Math.max(0, width - visible.length - pad);
  return ' '.repeat(pad) + str + ' '.repeat(right);
}

const LABEL_COLORS = {
  context_bloat: chalk.red,
  stale_scheduled_session: chalk.red,
  looping_or_indecision: chalk.yellow,
  retry_churn: chalk.magenta,
  tool_failure_cascade: chalk.redBright,
  overpowered_simple_task: chalk.blue,
  weak_model_for_complex_step: chalk.cyan,
  bad_task_decomposition: chalk.yellowBright,
  possible_provider_regression: chalk.red,
  relay_workflow: chalk.dim,
  scheduled_workflow: chalk.dim,
  clean_session: chalk.green,
  unknown: chalk.dim,
};

function colorLabel(label) {
  const colorFn = LABEL_COLORS[label] || LABEL_COLORS[label.trim()] || chalk.white;
  return colorFn(label);
}
