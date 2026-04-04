import { getAssistantMessages, getToolResults, getUserMessages } from './parser.js';
import { estimateMessageCost, estimateTokensFromText, getModelTier } from './estimator.js';

/**
 * Compute per-turn metrics from assistant messages.
 * Each entry represents one assistant turn with its token/cost characteristics.
 */
export function computeTurnMetrics(events) {
  const assistantMsgs = getAssistantMessages(events);
  const toolResults = getToolResults(events);

  // Build a set of tool result sizes keyed by the preceding assistant turn index
  const toolResultsByParent = new Map();
  for (const tr of toolResults) {
    const parentId = tr.parentId;
    if (!toolResultsByParent.has(parentId)) toolResultsByParent.set(parentId, []);
    toolResultsByParent.get(parentId).push(tr);
  }

  return assistantMsgs.map((msg, i) => {
    const usage = msg.usage || {};
    const inputTokens = usage.input || 0;
    const outputTokens = usage.output || 0;
    const cacheRead = usage.cacheRead || 0;
    const contextSize = inputTokens + cacheRead;
    const cost = estimateMessageCost(usage, msg.model);

    // Check if this turn's tool results had errors
    const relatedResults = toolResultsByParent.get(msg.id) || [];
    const toolErrors = relatedResults.filter(tr => tr.isError).length;

    // Check for large tool results
    const largeToolResults = relatedResults.filter(
      tr => tr.textContent && estimateTokensFromText(tr.textContent) > 2000
    ).length;

    const tier = getModelTier(msg.model);

    return {
      index: i,
      timestamp: msg.messageTimestamp || msg.timestamp,
      inputTokens,
      outputTokens,
      cacheRead,
      contextSize,
      cost,
      model: msg.model,
      modelTier: tier,
      toolCallCount: msg.toolCalls?.length || 0,
      toolErrors,
      largeToolResults,
      isRetry: false, // filled in below
    };
  });
}

/**
 * Mark turns that look like retries of the previous turn.
 */
export function markRetries(turnMetrics, events) {
  const assistantMsgs = getAssistantMessages(events);
  for (let i = 1; i < turnMetrics.length; i++) {
    const prev = assistantMsgs[i - 1];
    const curr = assistantMsgs[i];
    if (prev.toolCalls?.length > 0 && curr.toolCalls?.length > 0) {
      const prevSig = prev.toolCalls.map(tc => tc.name).join(',');
      const currSig = curr.toolCalls.map(tc => tc.name).join(',');
      if (prevSig === currSig) {
        turnMetrics[i].isRetry = true;
      }
    }
  }
  return turnMetrics;
}

/**
 * Split turn metrics into two windows for comparison.
 *
 * Strategies:
 *   - 'halves': split at midpoint
 *   - 'recent-N': last N turns vs previous N turns
 *   - 'time-24h': last 24h vs prior 24h
 *   - 'auto': pick the best strategy based on data
 */
export function splitWindows(turnMetrics, strategy = 'auto') {
  if (turnMetrics.length < 4) {
    return null; // insufficient data
  }

  if (strategy === 'auto') {
    strategy = pickStrategy(turnMetrics);
  }

  if (strategy === 'halves') {
    const mid = Math.floor(turnMetrics.length / 2);
    return {
      strategy: 'halves',
      baseline: turnMetrics.slice(0, mid),
      recent: turnMetrics.slice(mid),
    };
  }

  if (strategy.startsWith('recent-')) {
    const n = parseInt(strategy.split('-')[1], 10) || Math.floor(turnMetrics.length / 2);
    const effectiveN = Math.min(n, Math.floor(turnMetrics.length / 2));
    return {
      strategy,
      baseline: turnMetrics.slice(turnMetrics.length - 2 * effectiveN, turnMetrics.length - effectiveN),
      recent: turnMetrics.slice(turnMetrics.length - effectiveN),
    };
  }

  if (strategy === 'time-24h') {
    return splitByTime(turnMetrics, 24 * 60 * 60 * 1000);
  }

  // fallback to halves
  const mid = Math.floor(turnMetrics.length / 2);
  return {
    strategy: 'halves',
    baseline: turnMetrics.slice(0, mid),
    recent: turnMetrics.slice(mid),
  };
}

function pickStrategy(turnMetrics) {
  // If we have timestamps spanning > 24h, use time-based split
  const first = turnMetrics[0]?.timestamp;
  const last = turnMetrics[turnMetrics.length - 1]?.timestamp;
  if (first && last) {
    const span = new Date(last) - new Date(first);
    if (span > 48 * 60 * 60 * 1000) {
      return 'time-24h';
    }
  }
  // For shorter sessions, use halves
  return 'halves';
}

function splitByTime(turnMetrics, windowMs) {
  const last = turnMetrics[turnMetrics.length - 1]?.timestamp;
  if (!last) {
    // fallback
    const mid = Math.floor(turnMetrics.length / 2);
    return { strategy: 'halves', baseline: turnMetrics.slice(0, mid), recent: turnMetrics.slice(mid) };
  }

  const cutoff = new Date(new Date(last).getTime() - windowMs);
  const baselineCutoff = new Date(cutoff.getTime() - windowMs);

  const recent = turnMetrics.filter(t => t.timestamp && new Date(t.timestamp) >= cutoff);
  const baseline = turnMetrics.filter(t => t.timestamp && new Date(t.timestamp) >= baselineCutoff && new Date(t.timestamp) < cutoff);

  if (recent.length < 2 || baseline.length < 2) {
    // Not enough data in time windows, fall back to halves
    const mid = Math.floor(turnMetrics.length / 2);
    return { strategy: 'halves', baseline: turnMetrics.slice(0, mid), recent: turnMetrics.slice(mid) };
  }

  return { strategy: 'time-24h', baseline, recent };
}

/**
 * Aggregate a window of turn metrics into summary stats.
 */
export function aggregateWindow(turns) {
  if (turns.length === 0) {
    return {
      turnCount: 0,
      avgInputTokens: 0,
      avgOutputTokens: 0,
      avgCacheRead: 0,
      avgContextSize: 0,
      avgCostPerTurn: 0,
      peakContext: 0,
      totalCost: 0,
      retryRate: 0,
      toolErrorRate: 0,
      largeToolResultFrequency: 0,
      premiumModelRate: 0,
      contextGrowthSlope: 0,
    };
  }

  const n = turns.length;
  const sum = (fn) => turns.reduce((s, t) => s + fn(t), 0);
  const avg = (fn) => sum(fn) / n;

  const retries = turns.filter(t => t.isRetry).length;
  const totalToolCalls = sum(t => t.toolCallCount);
  const totalToolErrors = sum(t => t.toolErrors);
  const totalLargeResults = sum(t => t.largeToolResults);
  const premiumTurns = turns.filter(t => t.modelTier === 'premium').length;

  // Context growth slope: linear regression of contextSize over turn index
  const slope = computeSlope(turns.map((t, i) => [i, t.contextSize]));

  return {
    turnCount: n,
    avgInputTokens: Math.round(avg(t => t.inputTokens)),
    avgOutputTokens: Math.round(avg(t => t.outputTokens)),
    avgCacheRead: Math.round(avg(t => t.cacheRead)),
    avgContextSize: Math.round(avg(t => t.contextSize)),
    avgCostPerTurn: avg(t => t.cost),
    peakContext: Math.max(...turns.map(t => t.contextSize)),
    totalCost: sum(t => t.cost),
    retryRate: n > 0 ? retries / n : 0,
    toolErrorRate: totalToolCalls > 0 ? totalToolErrors / totalToolCalls : 0,
    largeToolResultFrequency: totalLargeResults > 0 ? (totalLargeResults > 3 ? 'high' : totalLargeResults > 1 ? 'medium' : 'low') : 'none',
    premiumModelRate: n > 0 ? premiumTurns / n : 0,
    contextGrowthSlope: slope,
  };
}

/**
 * Simple linear regression slope for [x, y] pairs.
 */
function computeSlope(points) {
  if (points.length < 2) return 0;
  const n = points.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

/**
 * Compare two window aggregates and produce an impact assessment.
 */
export function compareWindows(baselineAgg, recentAgg) {
  const metrics = [];

  metrics.push(compareMetric(
    'avg_input_tokens_per_turn',
    'Avg input tokens/turn',
    baselineAgg.avgInputTokens,
    recentAgg.avgInputTokens,
    'lower_is_better',
  ));

  metrics.push(compareMetric(
    'avg_cache_read_per_turn',
    'Avg cache-read/turn',
    baselineAgg.avgCacheRead,
    recentAgg.avgCacheRead,
    'lower_is_better',
  ));

  metrics.push(compareMetric(
    'avg_context_size',
    'Avg context size',
    baselineAgg.avgContextSize,
    recentAgg.avgContextSize,
    'lower_is_better',
  ));

  metrics.push(compareMetric(
    'avg_cost_per_turn',
    'Avg cost/turn',
    baselineAgg.avgCostPerTurn,
    recentAgg.avgCostPerTurn,
    'lower_is_better',
  ));

  metrics.push(compareMetric(
    'peak_context',
    'Peak context',
    baselineAgg.peakContext,
    recentAgg.peakContext,
    'lower_is_better',
  ));

  metrics.push(compareMetric(
    'context_growth_slope',
    'Context growth slope',
    baselineAgg.contextGrowthSlope,
    recentAgg.contextGrowthSlope,
    'lower_is_better',
  ));

  metrics.push(compareMetric(
    'retry_rate',
    'Retry rate',
    baselineAgg.retryRate,
    recentAgg.retryRate,
    'lower_is_better',
  ));

  metrics.push(compareMetric(
    'tool_error_rate',
    'Tool error rate',
    baselineAgg.toolErrorRate,
    recentAgg.toolErrorRate,
    'lower_is_better',
  ));

  return metrics;
}

function compareMetric(id, label, baselineVal, recentVal, direction) {
  const delta = recentVal - baselineVal;
  const pctChange = baselineVal !== 0 ? (delta / Math.abs(baselineVal)) * 100 : (recentVal > 0 ? 100 : 0);

  let trend;
  const threshold = 10; // 10% change threshold for significance
  if (Math.abs(pctChange) < threshold) {
    trend = 'flat';
  } else if (direction === 'lower_is_better') {
    trend = delta < 0 ? 'improved' : 'worsened';
  } else {
    trend = delta > 0 ? 'improved' : 'worsened';
  }

  return { id, label, baselineVal, recentVal, delta, pctChange, trend };
}

/**
 * Diagnosis-specific metric classification.
 *
 * Burden metrics = what the user actually feels (cost, context size, cache-read).
 * Process metrics = internal efficiency signals (slope, retry rate, input tokens).
 *
 * The verdict depends primarily on burden metrics. Process metrics can only
 * upgrade "no_clear_improvement" to "mixed_signals" — never to "likely_improved".
 */
const DIAGNOSIS_METRIC_PROFILES = {
  context_bloat: {
    burden: ['avg_cache_read_per_turn', 'avg_context_size', 'avg_cost_per_turn', 'peak_context'],
    process: ['context_growth_slope', 'avg_input_tokens_per_turn', 'retry_rate', 'tool_error_rate'],
  },
  stale_scheduled_session: {
    burden: ['avg_cache_read_per_turn', 'avg_context_size', 'avg_cost_per_turn', 'peak_context'],
    process: ['context_growth_slope', 'avg_input_tokens_per_turn', 'retry_rate', 'tool_error_rate'],
  },
  retry_churn: {
    burden: ['retry_rate', 'tool_error_rate', 'avg_cost_per_turn'],
    process: ['avg_cache_read_per_turn', 'avg_context_size', 'context_growth_slope', 'avg_input_tokens_per_turn', 'peak_context'],
  },
  tool_failure_cascade: {
    burden: ['tool_error_rate', 'retry_rate', 'avg_cost_per_turn'],
    process: ['avg_cache_read_per_turn', 'avg_context_size', 'context_growth_slope', 'avg_input_tokens_per_turn', 'peak_context'],
  },
  looping_or_indecision: {
    burden: ['retry_rate', 'avg_cost_per_turn', 'avg_context_size'],
    process: ['tool_error_rate', 'avg_cache_read_per_turn', 'context_growth_slope', 'avg_input_tokens_per_turn', 'peak_context'],
  },
  overpowered_simple_task: {
    burden: ['avg_cost_per_turn', 'avg_input_tokens_per_turn', 'avg_context_size'],
    process: ['avg_cache_read_per_turn', 'peak_context', 'context_growth_slope', 'retry_rate', 'tool_error_rate'],
  },
  relay_workflow: {
    burden: ['avg_cost_per_turn', 'avg_cache_read_per_turn', 'avg_context_size'],
    process: ['peak_context', 'context_growth_slope', 'avg_input_tokens_per_turn', 'retry_rate', 'tool_error_rate'],
  },
  // Default profile when diagnosis doesn't match a specific pattern
  _default: {
    burden: ['avg_cache_read_per_turn', 'avg_context_size', 'avg_cost_per_turn', 'peak_context'],
    process: ['context_growth_slope', 'avg_input_tokens_per_turn', 'retry_rate', 'tool_error_rate'],
  },
};

function getMetricProfile(diagnosisLabels) {
  const diagLabels = diagnosisLabels.map(l => typeof l === 'string' ? l : l.label);
  // Use the primary (highest-confidence) diagnosis
  for (const label of diagLabels) {
    if (DIAGNOSIS_METRIC_PROFILES[label]) {
      return DIAGNOSIS_METRIC_PROFILES[label];
    }
  }
  return DIAGNOSIS_METRIC_PROFILES._default;
}

/**
 * Produce an overall verdict from metric comparisons and diagnosis context.
 *
 * Verdicts:
 *   - likely_improved   — burden metrics clearly better, no major worsening
 *   - mixed_signals     — some burden metrics improve, others worsen
 *   - no_clear_improvement — burden metrics flat, pathology may still be active
 *   - still_recurring   — diagnosed pattern is clearly still active
 *   - worse             — burden metrics materially worse
 *   - insufficient_data — not enough turns to judge
 */
export function computeVerdict(metricComparisons, baselineAgg, recentAgg, diagnosisLabels = []) {
  if (baselineAgg.turnCount < 2 || recentAgg.turnCount < 2) {
    return {
      verdict: 'insufficient_data',
      confidence: 'low',
      reason: `Not enough turns to compare (baseline: ${baselineAgg.turnCount}, recent: ${recentAgg.turnCount}).`,
    };
  }

  const profile = getMetricProfile(diagnosisLabels);
  const byId = new Map(metricComparisons.map(m => [m.id, m]));

  const burdenMetrics = profile.burden.map(id => byId.get(id)).filter(Boolean);
  const processMetrics = profile.process.map(id => byId.get(id)).filter(Boolean);

  const burdenImproved = burdenMetrics.filter(m => m.trend === 'improved');
  const burdenWorsened = burdenMetrics.filter(m => m.trend === 'worsened');
  const burdenFlat = burdenMetrics.filter(m => m.trend === 'flat');

  const processImproved = processMetrics.filter(m => m.trend === 'improved');
  const processWorsened = processMetrics.filter(m => m.trend === 'worsened');

  // Check if diagnosed patterns are still actively present
  const diagLabels = diagnosisLabels.map(l => typeof l === 'string' ? l : l.label);
  const hadContextBloat = diagLabels.includes('context_bloat') || diagLabels.includes('stale_scheduled_session');
  const hadLooping = diagLabels.includes('looping_or_indecision') || diagLabels.includes('retry_churn');
  const hadFailureCascade = diagLabels.includes('tool_failure_cascade');

  const contextStillGrowing = byId.get('context_growth_slope')?.trend !== 'improved'
    && recentAgg.contextGrowthSlope > 500;
  const retriesStillHigh = recentAgg.retryRate > 0.2;
  const errorsStillHigh = recentAgg.toolErrorRate > 0.3;

  // ─── still_recurring: diagnosed pathology clearly still active ───
  if (hadContextBloat && contextStillGrowing && burdenWorsened.length > 0) {
    return {
      verdict: 'still_recurring',
      confidence: 'medium',
      reason: `Context is still growing and ${burdenWorsened.map(m => m.label).join(', ')} worsened — the bloat pattern is still active.`,
    };
  }

  if (hadLooping && retriesStillHigh && burdenImproved.length === 0) {
    return {
      verdict: 'still_recurring',
      confidence: 'medium',
      reason: `Retry rate is still ${(recentAgg.retryRate * 100).toFixed(0)}% and no burden metrics improved — looping pattern persists.`,
    };
  }

  if (hadFailureCascade && errorsStillHigh && burdenImproved.length === 0) {
    return {
      verdict: 'still_recurring',
      confidence: 'medium',
      reason: `Tool error rate is still ${(recentAgg.toolErrorRate * 100).toFixed(0)}% — failure cascade persists.`,
    };
  }

  // ─── worse: majority of burden metrics worsened ───
  if (burdenWorsened.length >= Math.ceil(burdenMetrics.length / 2)) {
    return {
      verdict: 'worse',
      confidence: burdenWorsened.length >= 3 ? 'high' : 'medium',
      reason: `${burdenWorsened.length} of ${burdenMetrics.length} burden metrics worsened: ${burdenWorsened.map(m => m.label).join(', ')}.`,
    };
  }

  // ─── likely_improved: burden clearly better, no burden worsening ───
  if (burdenImproved.length >= Math.ceil(burdenMetrics.length / 2) && burdenWorsened.length === 0) {
    const avgImprovement = burdenImproved.reduce((s, m) => s + Math.abs(m.pctChange), 0) / burdenImproved.length;
    const confidence = avgImprovement > 30 ? 'high' : 'medium';
    return {
      verdict: 'likely_improved',
      confidence,
      reason: `${burdenImproved.length} of ${burdenMetrics.length} burden metrics improved with no worsening: ${burdenImproved.map(m => `${m.label} (${m.pctChange > 0 ? '+' : ''}${m.pctChange.toFixed(0)}%)`).join(', ')}.`,
    };
  }

  // ─── mixed_signals: some burden improved, some worsened ───
  if (burdenImproved.length > 0 && burdenWorsened.length > 0) {
    return {
      verdict: 'mixed_signals',
      confidence: 'low',
      reason: `Mixed burden signals — ${burdenImproved.map(m => m.label).join(', ')} improved but ${burdenWorsened.map(m => m.label).join(', ')} worsened. No clear practical improvement.`,
    };
  }

  // ─── process-only improvement: not enough to claim "improved" ───
  if (burdenImproved.length === 0 && processImproved.length > 0 && burdenWorsened.length === 0) {
    // Process metrics improved but burden is flat — cautious signal
    if (processImproved.length >= 2) {
      return {
        verdict: 'mixed_signals',
        confidence: 'low',
        reason: `Some efficiency metrics improved (${processImproved.map(m => m.label).join(', ')}), but the main cost burden (${burdenFlat.map(m => m.label).join(', ')}) remains unchanged.`,
      };
    }
    return {
      verdict: 'no_clear_improvement',
      confidence: 'low',
      reason: `Burden metrics are flat. Minor process improvement in ${processImproved.map(m => m.label).join(', ')} does not indicate practical cost reduction.`,
    };
  }

  // ─── all flat or minimal movement ───
  return {
    verdict: 'no_clear_improvement',
    confidence: 'low',
    reason: 'Burden metrics are mostly flat — no significant practical change detected.',
  };
}

// ─── Issue classes for failed-remediation escalation ───

const ISSUE_CLASSES = {
  session_architecture: 'session architecture',
  context_retention: 'context retention',
  model_choice: 'model choice',
  workflow_design: 'workflow design',
  tool_payload: 'tool payload',
  retry_error: 'retry / error handling',
};

/**
 * Compute a next-hypothesis escalation when validation is negative.
 *
 * Only produced for: worse, no_clear_improvement, still_recurring, mixed_signals.
 * Returns null for likely_improved and insufficient_data.
 */
export function computeNextHypothesis(verdict, metrics, baselineAgg, recentAgg, diagnosisLabels = []) {
  const verdictType = verdict.verdict;
  if (verdictType === 'likely_improved' || verdictType === 'insufficient_data') {
    return null;
  }

  const diagLabels = diagnosisLabels.map(l => typeof l === 'string' ? l : l.label);
  const primaryDiag = diagLabels[0] || 'unknown';
  const byId = new Map(metrics.map(m => [m.id, m]));

  // Analyze what specifically failed to improve
  const cacheReadTrend = byId.get('avg_cache_read_per_turn')?.trend;
  const contextSizeTrend = byId.get('avg_context_size')?.trend;
  const peakContextTrend = byId.get('peak_context')?.trend;
  const costTrend = byId.get('avg_cost_per_turn')?.trend;
  const retryTrend = byId.get('retry_rate')?.trend;
  const errorTrend = byId.get('tool_error_rate')?.trend;
  const slopeTrend = byId.get('context_growth_slope')?.trend;

  const contextStillLarge = recentAgg.peakContext > 50000;
  const cacheReadStillHigh = recentAgg.avgCacheRead > 30000;
  const largeToolResultsPresent = recentAgg.largeToolResultFrequency === 'high' || recentAgg.largeToolResultFrequency === 'medium';

  // ─── context_bloat / stale_scheduled_session ───
  if (primaryDiag === 'context_bloat' || primaryDiag === 'stale_scheduled_session') {
    return computeContextBloatEscalation({
      cacheReadTrend, contextSizeTrend, peakContextTrend, costTrend, slopeTrend,
      contextStillLarge, cacheReadStillHigh, largeToolResultsPresent,
      recentAgg, verdictType,
    });
  }

  // ─── retry_churn / looping_or_indecision ───
  if (primaryDiag === 'retry_churn' || primaryDiag === 'looping_or_indecision') {
    return computeRetryEscalation({
      retryTrend, errorTrend, costTrend, recentAgg, verdictType,
    });
  }

  // ─── tool_failure_cascade ───
  if (primaryDiag === 'tool_failure_cascade') {
    return computeToolFailureEscalation({
      errorTrend, retryTrend, costTrend, recentAgg, verdictType,
    });
  }

  // ─── relay_workflow ───
  if (primaryDiag === 'relay_workflow') {
    return computeRelayEscalation({
      cacheReadTrend, contextSizeTrend, costTrend,
      contextStillLarge, cacheReadStillHigh, recentAgg, verdictType,
    });
  }

  // ─── scheduled_workflow ───
  if (primaryDiag === 'scheduled_workflow') {
    return computeScheduledEscalation({
      contextSizeTrend, costTrend, largeToolResultsPresent, recentAgg, verdictType,
    });
  }

  // ─── overpowered_simple_task ───
  if (primaryDiag === 'overpowered_simple_task') {
    return computeOverpoweredEscalation({
      costTrend, contextSizeTrend, cacheReadStillHigh, contextStillLarge, recentAgg, verdictType,
    });
  }

  // ─── Generic fallback ───
  return computeGenericEscalation({
    cacheReadTrend, contextSizeTrend, costTrend, retryTrend,
    contextStillLarge, cacheReadStillHigh, largeToolResultsPresent,
    recentAgg, verdictType,
  });
}

function computeContextBloatEscalation(ctx) {
  const nextActions = [];
  let likelyIssueClass;
  let explanation;

  // Determine the likely deeper issue
  if (ctx.cacheReadStillHigh && ctx.contextStillLarge && ctx.slopeTrend !== 'improved') {
    // Context keeps growing despite first-line fixes → session architecture
    likelyIssueClass = ISSUE_CLASSES.session_architecture;
    explanation = 'First-line fixes (reset, compaction, model switch) did not reduce the cost burden. The session is likely mixing unrelated workloads — relays, scheduled tasks, and interactive conversation share the same context, causing it to grow regardless of per-turn optimizations.';
    nextActions.push(
      'Isolate relay messages, scheduled jobs, and interactive owner conversation into separate session contexts',
      'If using a single long-lived owner chat, split it into purpose-specific channels or use per-peer DM isolation',
      'Force aggressive compaction with a lower token threshold — the current context budget may be too generous',
    );
  } else if (ctx.largeToolResultsPresent) {
    // Large tool results still entering context → tool payload issue
    likelyIssueClass = ISSUE_CLASSES.tool_payload;
    explanation = 'Large tool results are still being retained in the session context. Even with resets or compaction, these payloads re-inflate the context on every turn they persist.';
    nextActions.push(
      'Enable tool-result TTL pruning so large results are dropped from context after a few turns',
      'Reduce the verbosity of tool outputs — return summaries instead of full payloads',
      'If tools return structured data, truncate or paginate the response before it enters the context',
    );
  } else if (ctx.cacheReadTrend === 'worsened' || ctx.cacheReadTrend === 'flat') {
    // Cache-read not improving → context retention
    likelyIssueClass = ISSUE_CLASSES.context_retention;
    explanation = 'Context is being retained longer than useful. The session may have compaction enabled but with a threshold that is too high, or old conversation turns are not being pruned aggressively enough.';
    nextActions.push(
      'Lower the compaction token threshold significantly (e.g., halve the current setting)',
      'Check whether the session is loading SOUL.md, AGENTS.md, or memory files that inflate the base context',
      'Consider idle-based session reset for periods of inactivity longer than 30 minutes',
    );
  } else {
    likelyIssueClass = ISSUE_CLASSES.session_architecture;
    explanation = 'The bloat pattern persists despite first-line interventions. The root cause is likely structural — this session is doing too much across too many concerns.';
    nextActions.push(
      'Audit what kinds of messages flow through this session (relay, cron, interactive, sub-agent)',
      'Separate high-context workloads into dedicated sessions',
      'Set a hard context token cap to force more aggressive summarization',
    );
  }

  return { likelyIssueClass, explanation, nextActions };
}

function computeRetryEscalation(ctx) {
  const nextActions = [];
  let likelyIssueClass;
  let explanation;

  if (ctx.recentAgg.toolErrorRate > 0.3) {
    likelyIssueClass = ISSUE_CLASSES.retry_error;
    explanation = 'The agent is retrying because tools keep failing. This is a tool reliability issue, not a cost optimization issue. Each retry re-sends the full context.';
    nextActions.push(
      'Identify which tools are failing and fix the root cause (check logs, permissions, API limits)',
      'Add circuit-breaker logic so the agent stops retrying after 2-3 failures instead of burning tokens indefinitely',
      'If a tool is intermittently unreliable, consider disabling it temporarily',
    );
  } else {
    likelyIssueClass = ISSUE_CLASSES.workflow_design;
    explanation = 'The agent is looping without tool errors — it may be stuck in an indecision cycle where the prompt is ambiguous or the task is under-specified.';
    nextActions.push(
      'Review the agent prompt (SOUL.md) for ambiguous instructions that could cause looping',
      'Add explicit stop conditions or max-turn limits for autonomous agent runs',
      'Check if the agent is trying to accomplish something beyond its tool capabilities and getting stuck',
    );
  }

  return { likelyIssueClass, explanation, nextActions };
}

function computeToolFailureEscalation(ctx) {
  return {
    likelyIssueClass: ISSUE_CLASSES.retry_error,
    explanation: 'Tool failures are cascading and driving up cost through repeated retries. The agent keeps attempting the same failing operations, re-sending the full context each time.',
    nextActions: [
      'Check tool logs for the specific error — is it a permission issue, API rate limit, or broken endpoint?',
      'Add a failure budget: if a tool fails N times consecutively, skip it and inform the user',
      'If the tool depends on an external service, verify the service is healthy before the agent runs',
    ],
  };
}

function computeRelayEscalation(ctx) {
  const nextActions = [];
  let likelyIssueClass;
  let explanation;

  if (ctx.contextStillLarge || ctx.cacheReadStillHigh) {
    likelyIssueClass = ISSUE_CLASSES.session_architecture;
    explanation = 'This looks like more than a simple relay cost issue. The session is carrying a large context, which suggests it is mixing relay forwarding with broader reasoning or carrying over context from non-relay work.';
    nextActions.push(
      'Check if this session also handles scheduled tasks, interactive queries, or sub-agent work alongside relay',
      'Isolate the relay path into a dedicated session with minimal context',
      'If relays share an owner session, switch to per-peer DM isolation so each contact gets a clean context',
    );
  } else {
    likelyIssueClass = ISSUE_CLASSES.model_choice;
    explanation = 'Relay cost is still elevated despite the session looking structurally sound. The model may still be more expensive than necessary for forwarding work.';
    nextActions.push(
      'Verify the model was actually switched — check the session metadata for the current model',
      'If already on an economy model, the cost may simply be the baseline for this volume of relay traffic',
      'Consider reducing relay frequency or batching messages where possible',
    );
  }

  return { likelyIssueClass, explanation, nextActions };
}

function computeScheduledEscalation(ctx) {
  const nextActions = [];
  let likelyIssueClass;
  let explanation;

  if (ctx.largeToolResultsPresent) {
    likelyIssueClass = ISSUE_CLASSES.tool_payload;
    explanation = 'Scheduled jobs are generating large tool results that persist in the session context. Each subsequent run inherits this bloated context.';
    nextActions.push(
      'Ensure each scheduled run uses an isolated session (--session isolated) so it starts with a clean context',
      'Reduce tool output size — return only what the next step needs, not the full payload',
      'If jobs must share a session, enable aggressive pruning of old tool results between runs',
    );
  } else {
    likelyIssueClass = ISSUE_CLASSES.session_architecture;
    explanation = 'Scheduled jobs may be reusing a polluted session or targeting the wrong session scope. Context from previous runs or other session work is being carried forward.';
    nextActions.push(
      'Verify that each cron job runs in an isolated session, not the shared main session',
      'Check the cron configuration for session targeting — it may be defaulting to the owner session',
      'If the job needs context from previous runs, use memory/storage instead of session context carry-over',
    );
  }

  return { likelyIssueClass, explanation, nextActions };
}

function computeOverpoweredEscalation(ctx) {
  const nextActions = [];
  let likelyIssueClass;
  let explanation;

  if (ctx.contextStillLarge || ctx.cacheReadStillHigh) {
    likelyIssueClass = ISSUE_CLASSES.context_retention;
    explanation = 'The task may not be as simple as it appears. A large context is being loaded even for what looks like a simple operation, suggesting the real cost driver is context size rather than model choice.';
    nextActions.push(
      'Check what is being loaded into the context — SOUL.md, memory, tool definitions may be inflating it',
      'Enable a light-context mode for simple tasks that loads only essential bootstrap files',
      'If the context cannot be reduced, the model switch alone will not be sufficient — context is the main driver',
    );
  } else {
    likelyIssueClass = ISSUE_CLASSES.workflow_design;
    explanation = 'The model was switched but cost did not drop as expected. The task may be more complex than the heuristic detected, or the agent is doing more work than necessary.';
    nextActions.push(
      'Review what the agent actually does in these sessions — it may be running unnecessary tool calls',
      'Check if the "simple task" is triggering sub-agent work or multi-step reasoning',
      'If the task truly is simple, verify the model change was applied by checking session metadata',
    );
  }

  return { likelyIssueClass, explanation, nextActions };
}

function computeGenericEscalation(ctx) {
  const nextActions = [];
  let likelyIssueClass;
  let explanation;

  if (ctx.contextStillLarge && ctx.cacheReadStillHigh) {
    likelyIssueClass = ISSUE_CLASSES.context_retention;
    explanation = 'The session carries a large context that is not being reduced by first-line fixes. The issue is likely structural — context is being retained across unrelated work.';
    nextActions.push(
      'Audit the session to understand what is consuming context (messages, tool results, system prompts)',
      'Enable compaction with a lower threshold, or switch to isolated sessions for different workloads',
      'Check if large tool results or memory payloads are inflating the base context',
    );
  } else if (ctx.retryTrend !== 'improved' && ctx.recentAgg.retryRate > 0.1) {
    likelyIssueClass = ISSUE_CLASSES.retry_error;
    explanation = 'Retry patterns are contributing to cost. Each retry re-sends the full conversation context.';
    nextActions.push(
      'Identify which tools are being retried and why they fail',
      'Add retry limits to prevent unbounded retry loops',
      'Fix the underlying tool or permission issue causing the failures',
    );
  } else {
    likelyIssueClass = ISSUE_CLASSES.workflow_design;
    explanation = 'No single clear issue stands out. The cost may be distributed across multiple factors. A deeper audit of this session type is recommended.';
    nextActions.push(
      'Run "inspect" to review the full session transcript and identify the costliest turns',
      'Compare this session against similar sessions that cost less to identify what is different',
      'Consider whether this session type genuinely needs this level of interaction or could be simplified',
    );
  }

  return { likelyIssueClass, explanation, nextActions };
}

/**
 * Full impact validation pipeline.
 * Takes parsed events and optional diagnosis context, returns a complete validation result.
 */
export function validateImpact(events, options = {}) {
  const { strategy = 'auto', diagnosisLabels = [] } = options;

  let turnMetrics = computeTurnMetrics(events);
  turnMetrics = markRetries(turnMetrics, events);

  const windows = splitWindows(turnMetrics, strategy);
  if (!windows) {
    return {
      verdict: { verdict: 'insufficient_data', confidence: 'low', reason: 'Fewer than 4 assistant turns — not enough data to compare trends.' },
      baselineWindow: null,
      recentWindow: null,
      metrics: [],
      strategy: 'none',
      nextHypothesis: null,
    };
  }

  const baselineAgg = aggregateWindow(windows.baseline);
  const recentAgg = aggregateWindow(windows.recent);
  const metrics = compareWindows(baselineAgg, recentAgg);
  const verdict = computeVerdict(metrics, baselineAgg, recentAgg, diagnosisLabels);
  const nextHypothesis = computeNextHypothesis(verdict, metrics, baselineAgg, recentAgg, diagnosisLabels);

  return {
    verdict,
    baselineWindow: baselineAgg,
    recentWindow: recentAgg,
    metrics,
    strategy: windows.strategy,
    nextHypothesis,
  };
}
