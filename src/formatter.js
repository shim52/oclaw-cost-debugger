import chalk from 'chalk';

// ─── PII Sanitization ──────────────────────────────────

const PHONE_RE = /\+\d{10,15}\b/g;
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
  return {
    ...s,
    sessionKey: sanitizeSessionKey(s.sessionKey),
    costliestMsgCost: s.costliestMsgCost,
    costliestMsgPct: s.costliestMsgPct,
  };
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
        const peakMsgLine = s.costliestMsgCost != null
          ? `   Peak msg: ${colorCost(s.costliestMsgCost)} (${s.costliestMsgPct}% of total)`
          : null;
        return [
          `${chalk.dim(`#${i + 1}`)} ${chalk.bold.white(truncate(s.sessionId, 36))}  ${colorCost(s.estimatedCost)}`,
          `   Model: ${chalk.yellow(s.model)}  Tokens: ${chalk.cyan(s.totalTokens.toLocaleString())}  Duration: ${formatDuration(s.runtimeMs)}`,
          `   Origin: ${originLabel}  Cache: ${(s.cacheRead || 0).toLocaleString()} read`,
          peakMsgLine,
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
    padRight('Peak Msg', 16) +
    padRight('Tokens', 9) +
    padRight('Diagnosis', 24) +
    padRight('Action', 28)
  );

  const divider = chalk.dim('─'.repeat(fullIds ? 180 : 150));

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

    const peakMsg = s.costliestMsgCost != null
      ? `${formatCost(s.costliestMsgCost)} (${s.costliestMsgPct}%)`
      : '-';
    const peakMsgCol = padRight(peakMsg, 16);

    const tokens = padRight(s.totalTokens >= 1000 ? Math.round(s.totalTokens / 1000) + 'k' : String(s.totalTokens), 9);

    const rawDiag = truncate(s.topLabel || 'unknown', 22);
    const diagPad = padRight(rawDiag, 24);
    const diag = diagPad.replace(rawDiag, colorLabel(rawDiag));

    const action = triage.suggestedNextStep === 'inspect'
      ? chalk.green('inspect — ' + truncate(triage.whyFlagged || '', 16))
      : chalk.dim(truncate(triage.whyFlagged || 'n/a', 26));

    return `${chalk.dim(rank)}${sid}${chalk.cyan(originCol)}${chalk.dim(dateCol)}${model}${coloredCost}${peakMsgCol}${tokens}${diag}${action}`;
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
  const header = '| # | Session ID | Origin | Date | Model | Cost | Peak Msg | Tokens | Diagnosis | Action |';
  const divider = '|---|------------|--------|------|-------|------|----------|--------|-----------|--------|';

  const rows = sessions.map((s, i) => {
    const triage = s.triage || {};
    const origin = s.origin ? (s.origin.provider || '-') : '-';
    const date = formatDate(s.updatedAt);
    const peakMsg = s.costliestMsgCost != null
      ? `${formatCost(s.costliestMsgCost)} (${s.costliestMsgPct}%)`
      : '-';
    return `| ${i + 1} | \`${truncate(s.sessionId, 22)}\` | ${origin} | ${date} | ${s.model} | ${formatCost(s.estimatedCost)} | ${peakMsg} | ${s.totalTokens.toLocaleString()} | ${s.topLabel || 'unknown'} | ${triage.suggestedNextStep === 'inspect' ? '**inspect**' : triage.whyFlagged || '-'} |`;
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

  // Next hypothesis for failed remediations
  const nh = validation.nextHypothesis;
  if (nh) {
    lines.push(chalk.bold.white('  Next Hypothesis'));
    lines.push(chalk.dim('  ' + '─'.repeat(66)));
    lines.push(`  Likely issue: ${chalk.yellow.bold(nh.likelyIssueClass)}`);
    if (nh.structuralRisk) {
      lines.push(`  Also consider: ${chalk.dim(nh.structuralRisk)}`);
    }
    lines.push('');
    lines.push(`  ${chalk.dim('Why:')} ${nh.causalBridge}`);
    lines.push('');
    lines.push(chalk.bold.white('  What to Try Next'));
    for (let i = 0; i < nh.nextActions.length; i++) {
      lines.push(`  ${chalk.cyan(`${i + 1}.`)} ${nh.nextActions[i]}`);
    }
    lines.push('');
  }

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

  const nh = validation.nextHypothesis;
  if (nh) {
    lines.push('## Next Hypothesis');
    lines.push(`**Likely issue:** ${nh.likelyIssueClass}`);
    if (nh.structuralRisk) {
      lines.push(`**Also consider:** ${nh.structuralRisk}`);
    }
    lines.push('');
    lines.push(`> **Why:** ${nh.causalBridge}`);
    lines.push('');
    lines.push('### What to Try Next');
    for (let i = 0; i < nh.nextActions.length; i++) {
      lines.push(`${i + 1}. ${nh.nextActions[i]}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function colorVerdict(verdict) {
  switch (verdict) {
    case 'likely_improved': return chalk.green.bold('LIKELY IMPROVED');
    case 'mixed_signals': return chalk.yellow('MIXED SIGNALS');
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
    case 'mixed_signals': return '⚖️';
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

function fmtTokens(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function getVerdictGuidance(verdict, validation, analysis) {
  const topLabel = analysis?.labels?.[0]?.label;

  switch (verdict) {
    case 'likely_improved':
      return 'The main cost burden has materially decreased — cache-read, context size, and/or cost per turn are down with no worsening. Continue monitoring to confirm the trend holds.';
    case 'mixed_signals':
      if (topLabel === 'context_bloat' || topLabel === 'stale_scheduled_session') {
        return 'Some efficiency metrics improved, but context burden and cache-read remain high or worsened. The main cost pathology is still active — this is not a practical improvement yet.';
      }
      return 'Some metrics improved but others worsened. The session is not clearly healthier — the applied changes may be helping in one area while another cost driver persists.';
    case 'no_clear_improvement':
      if (topLabel === 'context_bloat' || topLabel === 'stale_scheduled_session') {
        return 'Context burden is not shrinking. The session may need a harder reset, compaction threshold change, or idle-reset configuration.';
      }
      return 'Burden metrics are flat. The applied changes have not produced a measurable cost reduction yet. A different intervention may be needed.';
    case 'still_recurring':
      if (topLabel === 'context_bloat') {
        return 'Context continues to grow and cost burden is worsening. The bloat pattern is active — consider forcing a session reset or lowering the context token budget.';
      }
      if (topLabel === 'looping_or_indecision' || topLabel === 'retry_churn') {
        return 'The agent is still retrying or looping with no cost improvement. The root cause likely requires a prompt or tool fix, not just a cost optimization.';
      }
      if (topLabel === 'tool_failure_cascade') {
        return 'Tool errors are still cascading. Fix the failing tools before expecting cost improvement.';
      }
      return 'The diagnosed pattern is still active with no burden reduction. The applied fix may not address the root cause.';
    case 'worse':
      return 'The main cost burden has increased. Investigate whether a recent change (model update, prompt change, new tool) is causing higher token burn.';
    case 'insufficient_data':
      return 'Not enough turns to draw conclusions. Run validate again after more activity in this session.';
    default:
      return '';
  }
}

// ─── Per-Message Cost Breakdown ────────────────────────

/**
 * Format a per-message cost breakdown with insights and content preview.
 *
 * @param {Array} turns - Enriched turn metrics (with `preview` field)
 * @param {number} totalCost - Total cost across all turns
 * @param {string} format - Output format: 'text' | 'json' | 'markdown'
 * @param {object} opts - { showAll: boolean }
 * @returns {string} Formatted output
 */
export function formatMessages(turns, totalCost, format = 'text', opts = {}) {
  if (turns.length === 0) {
    return format === 'json'
      ? JSON.stringify({ totalCost: 0, turns: [], insights: [] }, null, 2)
      : 'No assistant turns found.';
  }

  const insights = computeCostInsights(turns, totalCost);

  switch (format) {
    case 'json':
      return formatMessagesJson(turns, totalCost, insights);
    case 'markdown':
      return formatMessagesMarkdown(turns, totalCost, insights, opts);
    default:
      return formatMessagesText(turns, totalCost, insights, opts);
  }
}

/**
 * Compute actionable insights from turn-level cost data.
 */
function computeCostInsights(turns, totalCost) {
  const insights = [];
  if (turns.length === 0) return insights;

  const totalInput = turns.reduce((s, t) => s + t.inputTokens, 0);
  const totalCache = turns.reduce((s, t) => s + t.cacheRead, 0);
  const totalOutput = turns.reduce((s, t) => s + t.outputTokens, 0);
  const totalTokens = totalInput + totalCache + totalOutput;

  // Context re-send ratio
  const contextPct = totalTokens > 0 ? Math.round(((totalInput + totalCache) / totalTokens) * 100) : 0;
  const outputPct = totalTokens > 0 ? Math.round((totalOutput / totalTokens) * 100) : 0;
  if (contextPct > 80) {
    insights.push(`${contextPct}% of tokens are context re-send (input + cache-read), only ${outputPct}% is new output — cost is driven by history size, not by what the model generates.`);
  }

  // Context growth
  if (turns.length >= 3) {
    const firstCtx = turns[0].contextSize;
    const lastCtx = turns[turns.length - 1].contextSize;
    if (lastCtx > firstCtx * 3 && lastCtx > 20000) {
      const growth = (lastCtx / Math.max(firstCtx, 1)).toFixed(1);
      insights.push(`Context grew ${growth}x during session (${fmtTokens(firstCtx)} to ${fmtTokens(lastCtx)}). Later turns cost much more because the entire history is re-sent.`);
    }
  }

  // Cache miss penalty
  const cacheMissTurns = turns.filter(t => t.cacheRead === 0 && t.inputTokens > 10000);
  const cachedTurns = turns.filter(t => t.cacheRead > 0 && t.cost > 0);
  if (cacheMissTurns.length > 0 && cachedTurns.length > 0) {
    const avgMissCost = cacheMissTurns.reduce((s, t) => s + t.cost, 0) / cacheMissTurns.length;
    const avgCachedCost = cachedTurns.reduce((s, t) => s + t.cost, 0) / cachedTurns.length;
    if (avgMissCost > avgCachedCost * 1.3) {
      const multiplier = (avgMissCost / avgCachedCost).toFixed(1);
      insights.push(`${cacheMissTurns.length} turn(s) had cache misses (context reloaded from scratch), costing ${multiplier}x more than cached turns (${formatCost(avgMissCost)} vs ${formatCost(avgCachedCost)} avg).`);
    }
  }

  // Retry waste
  const retryTurns = turns.filter(t => t.isRetry);
  if (retryTurns.length > 0) {
    const retryWaste = retryTurns.reduce((s, t) => s + t.cost, 0);
    insights.push(`${retryTurns.length} retry turn(s) wasted ${formatCost(retryWaste)} — same tool calls repeated without progress.`);
  }

  // Concentration — top 10% of turns
  if (turns.length >= 10) {
    const sorted = [...turns].sort((a, b) => b.cost - a.cost);
    const top10Pct = sorted.slice(0, Math.ceil(turns.length * 0.1));
    const top10PctCost = top10Pct.reduce((s, t) => s + t.cost, 0);
    const top10PctShare = totalCost > 0 ? Math.round((top10PctCost / totalCost) * 100) : 0;
    if (top10PctShare > 30) {
      insights.push(`Top 10% of turns (${top10Pct.length} turns) account for ${top10PctShare}% of total cost.`);
    }
  }

  return insights;
}

function formatMessagesText(turns, totalCost, insights, opts = {}) {
  const maxCost = Math.max(...turns.map(t => t.cost));
  const lines = [''];

  // ─── Insights ───
  if (insights.length > 0) {
    lines.push(chalk.bold.cyan('Cost Insights'));
    lines.push(chalk.dim('─'.repeat(90)));
    for (const insight of insights) {
      lines.push(`  ${chalk.yellow('*')} ${insight}`);
    }
    lines.push('');
  }

  // ─── Top costliest turns ───
  const showAll = opts.showAll;
  const topN = 10;
  const sorted = [...turns].sort((a, b) => b.cost - a.cost);
  const displayed = showAll ? turns : sorted.slice(0, topN);
  const title = showAll
    ? `All Messages (${turns.length} turns)`
    : `Top ${Math.min(topN, turns.length)} Costliest Messages`;

  lines.push(chalk.bold.cyan(title));
  lines.push(chalk.dim('─'.repeat(90)));

  for (const t of displayed) {
    const pct = totalCost > 0 ? Math.round((t.cost / totalCost) * 100) : 0;
    const isCostliest = t.cost === maxCost && maxCost > 0;

    // Flags
    const flags = [];
    if (isCostliest) flags.push(chalk.red('PEAK'));
    if (t.isRetry) flags.push(chalk.magenta('retry'));
    if (t.toolErrors > 0) flags.push(chalk.red('err'));
    const flagStr = flags.length > 0 ? '  ' + flags.join(' ') : '';

    // Row 1: cost + metadata
    const costColor = isCostliest ? chalk.red.bold : (pct > 10 ? chalk.yellow : chalk.white);
    lines.push(
      chalk.dim(`  #${padRight(String(t.index), 4)}`) +
      costColor(formatCost(t.cost)) +
      chalk.dim(` (${pct}%)`) +
      `  ${chalk.dim('ctx:')} ${fmtTokens(t.contextSize)}` +
      `  ${chalk.dim('in:')} ${fmtTokens(t.inputTokens)}` +
      `  ${chalk.dim('cache:')} ${fmtTokens(t.cacheRead)}` +
      `  ${chalk.dim('out:')} ${fmtTokens(t.outputTokens)}` +
      (t.toolCallCount > 0 ? `  ${chalk.dim('tools:')} ${t.toolCallCount}` : '') +
      flagStr
    );

    // Row 2: message preview
    const preview = t.preview || '';
    if (preview.length > 0) {
      const previewText = sanitize(preview.replace(/\n/g, ' ').replace(/\s+/g, ' '));
      lines.push(chalk.dim(`         ${truncate(previewText, 100)}`));
    }
  }

  lines.push(chalk.dim('─'.repeat(90)));
  lines.push(chalk.bold(`  ${turns.length} turn(s) — total: ${colorCost(totalCost)}`));
  if (!showAll && turns.length > topN) {
    lines.push(chalk.dim(`  Showing top ${topN} of ${turns.length}. Use --all-messages to see all.`));
  }
  lines.push('');

  return lines.join('\n');
}

function formatMessagesJson(turns, totalCost, insights) {
  const data = turns.map(t => {
    const pctOfTotal = totalCost > 0 ? Math.round((t.cost / totalCost) * 100) : 0;
    return {
      index: t.index,
      timestamp: t.timestamp,
      model: t.model,
      cost: t.cost,
      pctOfTotal,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheRead: t.cacheRead,
      contextSize: t.contextSize,
      toolCallCount: t.toolCallCount,
      toolErrors: t.toolErrors,
      isRetry: t.isRetry,
      preview: sanitize(t.preview || ''),
    };
  });

  return JSON.stringify({ totalCost, insights, turns: data }, null, 2);
}

function formatMessagesMarkdown(turns, totalCost, insights, opts = {}) {
  const maxCost = Math.max(...turns.map(t => t.cost));
  const lines = ['## Per-Message Cost Breakdown', ''];

  if (insights.length > 0) {
    lines.push('### Insights', '');
    for (const insight of insights) {
      lines.push(`- ${insight}`);
    }
    lines.push('');
  }

  const showAll = opts.showAll;
  const topN = 10;
  const sorted = [...turns].sort((a, b) => b.cost - a.cost);
  const displayed = showAll ? turns : sorted.slice(0, topN);

  lines.push(showAll ? '### All Messages' : `### Top ${Math.min(topN, turns.length)} Costliest Messages`);
  lines.push('');
  lines.push('| # | Cost | % | Context | Input | Cache | Output | Tools | Flags | Preview |');
  lines.push('|---|------|---|---------|-------|-------|--------|-------|-------|---------|');

  for (const t of displayed) {
    const pct = totalCost > 0 ? Math.round((t.cost / totalCost) * 100) : 0;
    const isCostliest = t.cost === maxCost && maxCost > 0;
    const flags = [];
    if (isCostliest) flags.push('**PEAK**');
    if (t.isRetry) flags.push('retry');
    if (t.toolErrors > 0) flags.push('err');
    const preview = sanitize((t.preview || '').replace(/\n/g, ' ').replace(/\s+/g, ' '));
    lines.push(
      `| #${t.index} | ${formatCost(t.cost)} | ${pct}% | ${fmtTokens(t.contextSize)} | ${fmtTokens(t.inputTokens)} | ${fmtTokens(t.cacheRead)} | ${fmtTokens(t.outputTokens)} | ${t.toolCallCount} | ${flags.join(' ')} | ${truncate(preview, 60)} |`
    );
  }

  lines.push('');
  lines.push(`**Total: ${turns.length} turn(s), ${formatCost(totalCost)}**`);
  if (!showAll && turns.length > topN) {
    lines.push(`_Showing top ${topN} of ${turns.length}. Use --all-messages to see all._`);
  }
  lines.push('');

  return lines.join('\n');
}
