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

function formatDate(d) {
  if (!d) return '-';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date)) return '-';
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${m}-${day} ${h}:${min}`;
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

function colorStatus(status) {
  if (status === 'verified') return chalk.green('verified');
  if (status === 'unverified') return chalk.yellow('unverified');
  return chalk.dim('conceptual');
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
          triage.suggestedNextStep === 'inspect' || triage.suggestedNextStep === 'review remediations'
            ? `   ${chalk.green('→')} ${triage.whyFlagged}`
            : `   ${chalk.dim('→')} ${triage.whyFlagged || 'N/A'}`,
          triage.remediations?.[0]?.savings
            ? `   ${chalk.yellow('$')} Top remediation: ${triage.remediations[0].title} — ${chalk.yellow(triage.remediations[0].savings)}`
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
    padRight('Origin', 12) +
    padRight('Date', 12) +
    padRight('Model', 14) +
    padRight('Cost', 10) +
    padRight('Tokens', 9) +
    padRight('Diagnosis', 24) +
    padRight('Action', 28)
  );

  const divider = chalk.dim('─'.repeat(fullIds ? 164 : 134));

  const rows = sessions.map((s, i) => {
    const triage = s.triage || {};

    const rank = padRight(`${i + 1}`, 4);
    const sid = padRight(fullIds ? s.sessionId : truncate(s.sessionId, 16), idWidth);
    const origin = s.origin ? (s.origin.provider || '-') : '-';
    const originCol = padRight(truncate(origin, 10), 12);
    const date = formatDate(s.updatedAt);
    const dateCol = padRight(date, 12);
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

    return `${chalk.dim(rank)}${sid}${chalk.cyan(originCol)}${chalk.dim(dateCol)}${model}${coloredCost}${tokens}${diag}${action}`;
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
  const header = '| # | Session ID | Origin | Date | Model | Cost | Tokens | Diagnosis | Action |';
  const divider = '|---|------------|--------|------|-------|------|--------|-----------|--------|';

  const rows = sessions.map((s, i) => {
    const triage = s.triage || {};
    const origin = s.origin ? (s.origin.provider || '-') : '-';
    const date = formatDate(s.updatedAt);
    return `| ${i + 1} | \`${truncate(s.sessionId, 22)}\` | ${origin} | ${date} | ${s.model} | ${formatCost(s.estimatedCost)} | ${s.totalTokens.toLocaleString()} | ${s.topLabel || 'unknown'} | ${triage.suggestedNextStep === 'inspect' ? '**inspect**' : triage.whyFlagged || '-'} |`;
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

  // Remediations section
  if (analysis.triage) {
    const t = analysis.triage;
    const rems = t.remediations || [];

    lines.push(chalk.bold.white('Remediations'));
    lines.push(`  Priority:  ${colorPriority(t.priority)}`);
    lines.push(`  Issue:     ${t.whyFlagged}`);
    lines.push('');

    if (rems.length > 0) {
      for (let i = 0; i < rems.length; i++) {
        const r = rems[i];
        const badge = colorStatus(r.status);
        const conf = r.confidence ? chalk.dim(` [${r.confidence} confidence]`) : '';
        lines.push(chalk.bold.green(`  ${i + 1}. ${r.title}`) + `  ${badge}${conf}`);
        lines.push(chalk.dim(`     Why: ${r.why}`));
        lines.push(`     ${r.direction}`);
        if (r.savings) {
          lines.push(chalk.yellow(`     Savings: ${r.savings}`));
        }
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
    const rems = t.remediations || [];

    lines.push('## Remediations');
    lines.push(`**Priority:** ${t.priority}  `);
    lines.push(`**Issue:** ${t.whyFlagged}`);
    lines.push('');

    if (rems.length > 0) {
      for (let i = 0; i < rems.length; i++) {
        const r = rems[i];
        const badge = r.status === 'verified' ? '✅ verified' : r.status === 'unverified' ? '⚠️ unverified' : '💡 conceptual';
        const conf = r.confidence ? ` [${r.confidence} confidence]` : '';
        lines.push(`### ${i + 1}. ${r.title} — ${badge}${conf}`);
        lines.push(`> **Why:** ${r.why}`);
        lines.push(r.direction);
        if (r.savings) lines.push(`**Savings:** ${r.savings}`);
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

// ─── Impact Validation ─────────────────────────────────

/**
 * Format an impact validation result.
 */
export function formatValidation(sessionId, validation, analysis, format = 'text') {
  switch (format) {
    case 'json':
      return JSON.stringify({ sessionId: sanitize(sessionId), validation, diagnosis: analysis }, null, 2);
    case 'markdown':
      return formatValidationMarkdown(sessionId, validation, analysis);
    default:
      return formatValidationText(sessionId, validation, analysis);
  }
}

function formatValidationText(sessionId, validation, analysis) {
  const lines = [
    '',
    chalk.bold.cyan(`Impact Validation: ${sanitize(sessionId)}`),
    chalk.dim('─'.repeat(70)),
    '',
  ];

  // Verdict banner
  const v = validation.verdict;
  lines.push(chalk.bold.white('  Verdict'));
  lines.push(`  ${colorVerdict(v.verdict)}  ${chalk.dim(`[${v.confidence} confidence]`)}`);
  lines.push(`  ${v.reason}`);
  lines.push('');

  // Strategy
  lines.push(chalk.dim(`  Comparison strategy: ${validation.strategy}`));
  lines.push('');

  // Windows side-by-side
  const bw = validation.baselineWindow;
  const rw = validation.recentWindow;

  if (bw && rw) {
    lines.push(chalk.bold.white('  Window Comparison'));
    lines.push(chalk.dim('  ' + '─'.repeat(66)));
    lines.push(
      '  ' +
      padRight('', 30) +
      padRight('Baseline', 18) +
      padRight('Recent', 18) +
      'Change'
    );
    lines.push(chalk.dim('  ' + '─'.repeat(66)));

    for (const m of validation.metrics) {
      const bVal = formatMetricValue(m.id, m.baselineVal);
      const rVal = formatMetricValue(m.id, m.recentVal);
      const change = formatChange(m.pctChange, m.trend);
      lines.push(
        '  ' +
        padRight(m.label, 30) +
        padRight(bVal, 18) +
        padRight(rVal, 18) +
        change
      );
    }
    lines.push(chalk.dim('  ' + '─'.repeat(66)));
    lines.push(
      '  ' +
      padRight('Turns in window', 30) +
      padRight(String(bw.turnCount), 18) +
      padRight(String(rw.turnCount), 18)
    );
    lines.push('');

    // Frequency-based metrics
    lines.push(chalk.bold.white('  Pattern Indicators'));
    lines.push(
      `  Large tool results:   ${colorFrequency(bw.largeToolResultFrequency)} → ${colorFrequency(rw.largeToolResultFrequency)}`
    );
    lines.push(
      `  Premium model usage:  ${fmtPct(bw.premiumModelRate)} → ${fmtPct(rw.premiumModelRate)}`
    );
    lines.push('');
  }

  // Current diagnosis context
  if (analysis && analysis.labels?.length > 0) {
    lines.push(chalk.bold.white('  Active Diagnosis'));
    const topLabel = analysis.labels[0];
    lines.push(`  ${colorLabel(topLabel.label)} ${chalk.dim(`(${(topLabel.confidence * 100).toFixed(0)}% confidence)`)}`);
    lines.push(chalk.dim(`  ${topLabel.evidence[0]}`));
    lines.push('');
  }

  // Actionable guidance based on verdict
  lines.push(chalk.bold.white('  What This Means'));
  lines.push(`  ${getVerdictGuidance(v.verdict, validation, analysis)}`);
  lines.push('');

  return lines.join('\n');
}

function formatValidationMarkdown(sessionId, validation, analysis) {
  const lines = [
    `# Impact Validation: ${sanitize(sessionId)}`,
    '',
  ];

  const v = validation.verdict;
  lines.push(`## Verdict: ${verdictEmoji(v.verdict)} ${v.verdict.replace(/_/g, ' ')}`);
  lines.push(`**Confidence:** ${v.confidence}`);
  lines.push(`> ${v.reason}`);
  lines.push('');
  lines.push(`_Comparison strategy: ${validation.strategy}_`);
  lines.push('');

  const bw = validation.baselineWindow;
  const rw = validation.recentWindow;

  if (bw && rw) {
    lines.push('## Window Comparison');
    lines.push('| Metric | Baseline | Recent | Change |');
    lines.push('|--------|----------|--------|--------|');

    for (const m of validation.metrics) {
      const bVal = formatMetricValue(m.id, m.baselineVal);
      const rVal = formatMetricValue(m.id, m.recentVal);
      const change = `${m.pctChange > 0 ? '+' : ''}${m.pctChange.toFixed(0)}% ${m.trend}`;
      lines.push(`| ${m.label} | ${bVal} | ${rVal} | ${change} |`);
    }
    lines.push('');
    lines.push(`_Baseline: ${bw.turnCount} turns, Recent: ${rw.turnCount} turns_`);
    lines.push('');
  }

  if (analysis && analysis.labels?.length > 0) {
    lines.push('## Active Diagnosis');
    const topLabel = analysis.labels[0];
    lines.push(`**${topLabel.label}** (${(topLabel.confidence * 100).toFixed(0)}% confidence)`);
    lines.push(`- ${topLabel.evidence[0]}`);
    lines.push('');
  }

  lines.push('## Guidance');
  lines.push(getVerdictGuidance(v.verdict, validation, analysis));
  lines.push('');

  return lines.join('\n');
}

function colorVerdict(verdict) {
  switch (verdict) {
    case 'likely_improved': return chalk.green.bold('LIKELY IMPROVED');
    case 'no_clear_improvement': return chalk.yellow.bold('NO CLEAR IMPROVEMENT');
    case 'still_recurring': return chalk.red('STILL RECURRING');
    case 'worse': return chalk.red.bold('WORSE');
    case 'insufficient_data': return chalk.dim.bold('INSUFFICIENT DATA');
    default: return chalk.white(verdict);
  }
}

function verdictEmoji(verdict) {
  switch (verdict) {
    case 'likely_improved': return '✅';
    case 'no_clear_improvement': return '➖';
    case 'still_recurring': return '🔄';
    case 'worse': return '❌';
    case 'insufficient_data': return '⚠️';
    default: return '';
  }
}

function formatMetricValue(id, val) {
  if (id === 'avg_cost_per_turn') return `$${val.toFixed(4)}`;
  if (id === 'retry_rate' || id === 'tool_error_rate') return `${(val * 100).toFixed(0)}%`;
  if (id === 'context_growth_slope') return `${val >= 0 ? '+' : ''}${val.toFixed(0)} tok/turn`;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`;
  return String(Math.round(val));
}

function formatChange(pctChange, trend) {
  const sign = pctChange > 0 ? '+' : '';
  const pctStr = `${sign}${pctChange.toFixed(0)}%`;

  switch (trend) {
    case 'improved': return chalk.green(pctStr + ' ▼');
    case 'worsened': return chalk.red(pctStr + ' ▲');
    case 'flat': return chalk.dim(pctStr + ' ─');
    default: return pctStr;
  }
}

function colorFrequency(freq) {
  switch (freq) {
    case 'high': return chalk.red('high');
    case 'medium': return chalk.yellow('medium');
    case 'low': return chalk.green('low');
    case 'none': return chalk.dim('none');
    default: return String(freq);
  }
}

function fmtPct(rate) {
  return `${(rate * 100).toFixed(0)}%`;
}

function getVerdictGuidance(verdict, validation, analysis) {
  const topLabel = analysis?.labels?.[0]?.label;

  switch (verdict) {
    case 'likely_improved':
      return 'Token burn per turn is trending down. If this pattern holds, cost should decrease. Continue monitoring with periodic validate runs.';
    case 'no_clear_improvement':
      if (topLabel === 'context_bloat' || topLabel === 'stale_scheduled_session') {
        return 'Context is not shrinking meaningfully. The session may need a harder reset, compaction threshold change, or idle-reset configuration.';
      }
      return 'Metrics are mostly flat. The applied changes may not have taken effect yet, or the session needs a different intervention.';
    case 'still_recurring':
      if (topLabel === 'context_bloat') {
        return 'Context continues to grow. The bloat pattern is active — consider forcing a session reset or lowering the context token budget.';
      }
      if (topLabel === 'looping_or_indecision' || topLabel === 'retry_churn') {
        return 'The agent is still retrying or looping. The root cause likely requires a prompt or tool fix, not just a cost optimization.';
      }
      return 'The diagnosed pattern is still active. The applied fix may not address the root cause.';
    case 'worse':
      return 'Key metrics have worsened. Investigate whether a recent change (model update, prompt change, new tool) is causing increased token burn.';
    case 'insufficient_data':
      return 'Not enough turns to draw conclusions. Run validate again after more activity in this session.';
    default:
      return '';
  }
}
