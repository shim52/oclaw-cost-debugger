import chalk from 'chalk';

// ─── PII Sanitization ──────────────────────────────────

const PHONE_RE = /\+?\d{10,15}/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Sanitize PII from a string (phone numbers, emails).
 */
export function sanitize(str) {
  if (!str) return str;
  return str
    .replace(EMAIL_RE, '<email>')
    .replace(PHONE_RE, '<phone>');
}

/**
 * Sanitize a session key — redact phone numbers and emails.
 */
function sanitizeSessionKey(key) {
  if (!key) return key;
  return sanitize(key);
}

// ─── Scan Table ─────────────────────────────────────────

/**
 * Format a session scan table.
 */
export function formatScanTable(sessions, options = {}) {
  const format = typeof options === 'string' ? options : (options.format || 'text');
  const opts = typeof options === 'object' ? options : {};

  switch (format) {
    case 'json':
      return JSON.stringify(sessions.map(sanitizeScanResult), null, 2);
    case 'markdown':
      return formatScanMarkdown(sessions);
    default:
      return formatScanText(sessions, opts);
  }
}

function sanitizeScanResult(s) {
  return { ...s, sessionKey: sanitizeSessionKey(s.sessionKey) };
}

function formatCost(cost) {
  if (cost == null || cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(2)}`;
}

function formatDuration(ms) {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function colorCost(cost) {
  const s = formatCost(cost);
  if (cost >= 1) return chalk.red.bold(s);
  if (cost >= 0.10) return chalk.yellow(s);
  return chalk.green(s);
}

function colorPriority(pri) {
  if (pri === 'high') return chalk.red('high');
  if (pri === 'medium') return chalk.yellow('medium');
  if (pri === 'low') return chalk.dim('low');
  return String(pri || 'unknown');
}

function formatScanText(sessions, opts = {}) {
  const verbose = !!opts.verbose;
  const fullIds = !!opts.fullIds;

  if (sessions.length === 0) return chalk.yellow('No sessions found.');

  // Compute totals
  const totalCost = sessions.reduce((sum, s) => sum + (s.estimatedCost || 0), 0);

  if (verbose) {
    return [
      '',
      chalk.bold.cyan('Session Scan Results'),
      chalk.dim('─'.repeat(70)),
      ...sessions.map((s, i) => {
        const triage = s.triage || {};
        const origin = s.origin;
        const originLabel = origin ? `${origin.provider || ''}${origin.surface ? '/' + origin.surface : ''}` : '-';
        return [
          `${chalk.dim(`#${i + 1}`)} ${chalk.bold.white(truncate(s.sessionId, 36))}  ${colorCost(s.estimatedCost)}`,
          `   Model: ${chalk.yellow(s.model)}  Tokens: ${chalk.cyan(s.totalTokens.toLocaleString())}  Duration: ${formatDuration(s.runtimeMs)}`,
          `   Origin: ${originLabel}  Cache: ${(s.cacheRead || 0).toLocaleString()} read`,
          `   Diagnosis: ${colorLabel(s.topLabel || 'unknown')} — ${triage.whyFlagged || 'N/A'}`,
          triage.suggestedNextStep === 'inspect' || triage.suggestedNextStep === 'review fixes'
            ? `   ${chalk.green('→')} ${triage.whyFlagged}`
            : `   ${chalk.dim('→')} ${triage.whyFlagged || 'N/A'}`,
          triage.fixes?.[0]?.savings
            ? `   ${chalk.yellow('$')} Top fix: ${triage.fixes[0].title} — ${chalk.yellow(triage.fixes[0].savings)}`
            : null,
          triage.combinedSavings
            ? `   ${chalk.yellow('$$')} All fixes combined: ${chalk.yellow(triage.combinedSavings)}`
            : null,
          chalk.dim('─'.repeat(70))
        ].filter(Boolean).join('\n');
      }),
      '',
      chalk.bold(`  Total: ${sessions.length} session(s), ${colorCost(totalCost)} estimated cost`),
      '',
    ].join('\n');
  }

  const idWidth = fullIds ? 38 : 18;
  const header = chalk.bold.white(
    padRight('#', 4) +
    padRight('Session ID', idWidth) +
    padRight('Model', 14) +
    padRight('Cost', 10) +
    padRight('Tokens', 9) +
    padRight('Diagnosis', 24) +
    padRight('Action', 28)
  );

  const divider = chalk.dim('─'.repeat(fullIds ? 140 : 110));

  const rows = sessions.map((s, i) => {
    const triage = s.triage || {};

    const rank = padRight(`${i + 1}`, 4);
    const sid = padRight(fullIds ? s.sessionId : truncate(s.sessionId, 16), idWidth);
    const model = padRight(truncate(s.model, 12), 14);
    const cost = padRight(formatCost(s.estimatedCost), 10);
    const coloredCost = cost.replace(formatCost(s.estimatedCost), colorCost(s.estimatedCost));
    const tokens = padRight(s.totalTokens >= 1000 ? Math.round(s.totalTokens / 1000) + 'k' : String(s.totalTokens), 9);

    const rawDiag = truncate(s.topLabel || 'unknown', 22);
    const diagPad = padRight(rawDiag, 24);
    const diag = diagPad.replace(rawDiag, colorLabel(rawDiag));

    const action = triage.suggestedNextStep === 'inspect'
      ? chalk.green('inspect — ' + truncate(triage.whyFlagged || '', 16))
      : chalk.dim(truncate(triage.whyFlagged || 'n/a', 26));

    return `${chalk.dim(rank)}${sid}${model}${coloredCost}${tokens}${diag}${action}`;
  });

  return [
    '',
    chalk.bold.cyan('Session Scan Results'),
    divider,
    header,
    divider,
    ...rows,
    divider,
    chalk.bold(`  ${sessions.length} session(s) — total estimated cost: ${colorCost(totalCost)}`),
    '',
  ].join('\n');
}

function formatScanMarkdown(sessions) {
  if (sessions.length === 0) return '_No sessions found._';

  const totalCost = sessions.reduce((sum, s) => sum + (s.estimatedCost || 0), 0);
  const header = '| # | Session ID | Model | Cost | Tokens | Diagnosis | Action |';
  const divider = '|---|------------|-------|------|--------|-----------|--------|';

  const rows = sessions.map((s, i) => {
    const triage = s.triage || {};
    return `| ${i + 1} | \`${truncate(s.sessionId, 22)}\` | ${s.model} | ${formatCost(s.estimatedCost)} | ${s.totalTokens.toLocaleString()} | ${s.topLabel || 'unknown'} | ${triage.suggestedNextStep === 'inspect' ? '**inspect**' : triage.whyFlagged || '-'} |`;
  });

  return ['# Session Scan Results', '', header, divider, ...rows, '', `**Total: ${formatCost(totalCost)}**`, ''].join('\n');
}

// ─── Diagnosis ──────────────────────────────────────────

/**
 * Format a diagnosis report for a single session.
 */
export function formatDiagnosis(sessionId, analysis, stats, format = 'text') {
  switch (format) {
    case 'json':
      return JSON.stringify({ sessionId, analysis, stats }, null, 2);
    case 'markdown':
      return formatDiagnosisMarkdown(sessionId, analysis, stats);
    default:
      return formatDiagnosisText(sessionId, analysis, stats);
  }
}

function formatDiagnosisText(sessionId, analysis, stats) {
  const lines = [
    '',
    chalk.bold.cyan(`Session Diagnosis: ${sanitize(sessionId)}`),
    chalk.dim('─'.repeat(70)),
    '',
  ];

  if (stats) {
    lines.push(chalk.bold.white('Stats'));
    lines.push(`  Model:           ${chalk.yellow(stats.model || 'unknown')} (${stats.provider || 'unknown'})`);
    lines.push(`  Cost:            ${colorCost(stats.estimatedCost)}`);
    lines.push(`  Total Tokens:    ${chalk.cyan((stats.totalTokens || 0).toLocaleString())}`);
    lines.push(`    Input:         ${(stats.inputTokens || 0).toLocaleString()}`);
    lines.push(`    Output:        ${(stats.outputTokens || 0).toLocaleString()}`);
    lines.push(`    Cache Read:    ${(stats.cacheRead || 0).toLocaleString()}`);
    if (stats.cacheWrite) lines.push(`    Cache Write:   ${(stats.cacheWrite).toLocaleString()}`);
    lines.push(`  Messages:        ${stats.messageCount || '0'}  (${stats.toolCallCount || 0} tool calls, ${stats.toolErrorCount || 0} errors)`);
    if (stats.runtimeMs) lines.push(`  Duration:        ${formatDuration(stats.runtimeMs)}`);
    if (stats.compactionCount) lines.push(`  Compactions:     ${stats.compactionCount}`);
    if (stats.origin) {
      const o = stats.origin;
      lines.push(`  Origin:          ${sanitize(o.provider || '')}${o.surface ? '/' + o.surface : ''}`);
    }
    lines.push('');
  }

  // Diagnosis section
  lines.push(chalk.bold.white('Diagnosis'));
  for (const label of analysis.labels) {
    const conf = `${(label.confidence * 100).toFixed(0)}%`;
    lines.push(`  ${colorLabel(label.label)} ${chalk.dim(`(${conf} confidence)`)}`);
    for (const ev of label.evidence) {
      lines.push(chalk.dim(`    ${ev}`));
    }
    if (label.savings) {
      lines.push(chalk.yellow(`    Potential savings: ${label.savings}`));
    }
    lines.push('');
  }

  // Fixes section
  if (analysis.triage) {
    const t = analysis.triage;
    const fixes = t.fixes || [];

    lines.push(chalk.bold.white('How To Fix'));
    lines.push(`  Priority:  ${colorPriority(t.priority)}`);
    lines.push(`  Issue:     ${t.whyFlagged}`);
    lines.push('');

    if (fixes.length > 0) {
      for (let i = 0; i < fixes.length; i++) {
        const fix = fixes[i];
        lines.push(chalk.bold.green(`  Fix ${i + 1}: ${fix.title}`));
        lines.push(`  ${fix.description}`);
        if (fix.savings) {
          lines.push(chalk.yellow(`  Savings: ${fix.savings}`));
        }
        if (fix.config) {
          lines.push('');
          for (const line of fix.config.split('\n')) {
            lines.push(chalk.dim(`    ${line}`));
          }
        }
        if (fix.docs) {
          lines.push(chalk.dim(`    Docs: ${fix.docs}`));
        }
        lines.push('');
      }

      if (t.combinedSavings) {
        lines.push(chalk.yellow.bold(`  Combined: ${t.combinedSavings}`));
        lines.push('');
      }
    }
  }

  // Summary
  lines.push(chalk.bold.white('Summary'));
  lines.push(`  ${analysis.summary}`);
  lines.push('');

  return lines.join('\n');
}

function formatDiagnosisMarkdown(sessionId, analysis, stats) {
  const lines = [`# Session Diagnosis: ${sanitize(sessionId)}`, ''];

  if (stats) {
    lines.push('## Stats');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Model | ${stats.model || 'unknown'} |`);
    lines.push(`| Cost | ${formatCost(stats.estimatedCost)} |`);
    lines.push(`| Total Tokens | ${(stats.totalTokens || 0).toLocaleString()} |`);
    lines.push(`| Input | ${(stats.inputTokens || 0).toLocaleString()} |`);
    lines.push(`| Output | ${(stats.outputTokens || 0).toLocaleString()} |`);
    lines.push(`| Cache Read | ${(stats.cacheRead || 0).toLocaleString()} |`);
    lines.push(`| Messages | ${stats.messageCount || '0'} |`);
    lines.push(`| Tool Calls | ${stats.toolCallCount || '0'} |`);
    lines.push(`| Tool Errors | ${stats.toolErrorCount || '0'} |`);
    if (stats.runtimeMs) lines.push(`| Duration | ${formatDuration(stats.runtimeMs)} |`);
    lines.push('');
  }

  if (analysis.triage) {
    const t = analysis.triage;
    const fixes = t.fixes || [];

    lines.push('## How To Fix');
    lines.push(`**Priority:** ${t.priority}  `);
    lines.push(`**Issue:** ${t.whyFlagged}`);
    lines.push('');

    if (fixes.length > 0) {
      for (let i = 0; i < fixes.length; i++) {
        const fix = fixes[i];
        lines.push(`### Fix ${i + 1}: ${fix.title}`);
        lines.push(fix.description);
        if (fix.savings) lines.push(`**Savings:** ${fix.savings}`);
        if (fix.config) {
          lines.push('```json5');
          lines.push(fix.config.replace(/^\/\/.*\n/, '')); // strip comment line
          lines.push('```');
        }
        if (fix.docs) lines.push(`*Config keys: ${fix.docs}*`);
        lines.push('');
      }

      if (t.combinedSavings) {
        lines.push(`**Combined savings:** ${t.combinedSavings}`);
        lines.push('');
      }
    }
  }

  lines.push('## Diagnosis');
  for (const label of analysis.labels) {
    lines.push(`### ${label.label} (${(label.confidence * 100).toFixed(0)}%)`);
    for (const ev of label.evidence) {
      lines.push(`- ${ev}`);
    }
    lines.push('');
  }

  lines.push('## Summary');
  lines.push(analysis.summary);
  lines.push('');

  return lines.join('\n');
}

// ─── Full Report ────────────────────────────────────────

/**
 * Format a full report (scan + diagnosis for multiple sessions).
 */
export function formatReport(reportData, format = 'text') {
  switch (format) {
    case 'json':
      return JSON.stringify(reportData, null, 2);
    case 'markdown':
      return formatReportMarkdown(reportData);
    default:
      return formatReportText(reportData);
  }
}

function formatReportText(reportData) {
  const lines = [
    '',
    chalk.bold.magenta('═'.repeat(70)),
    chalk.bold.magenta('  Cost Diagnosis Report'),
    chalk.bold.magenta('═'.repeat(70)),
    chalk.dim(`  Generated: ${new Date().toISOString()}`),
    '',
  ];

  lines.push(formatScanText(reportData.sessions));
  lines.push('');

  for (const diag of reportData.diagnoses) {
    lines.push(chalk.dim('─'.repeat(70)));
    lines.push(formatDiagnosisText(diag.sessionId, diag.analysis, diag.stats));
  }

  return lines.join('\n');
}

function formatReportMarkdown(reportData) {
  const lines = [
    `# Cost Diagnosis Report`,
    `> Generated: ${new Date().toISOString()}`,
    '',
  ];

  lines.push(formatScanMarkdown(reportData.sessions));
  lines.push('---');
  lines.push('');

  for (const diag of reportData.diagnoses) {
    lines.push(formatDiagnosisMarkdown(diag.sessionId, diag.analysis, diag.stats));
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────

function padRight(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
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
  const colorFn = LABEL_COLORS[label] || chalk.white;
  return colorFn(label);
}
