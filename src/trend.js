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
    };
  }

  const baselineAgg = aggregateWindow(windows.baseline);
  const recentAgg = aggregateWindow(windows.recent);
  const metrics = compareWindows(baselineAgg, recentAgg);
  const verdict = computeVerdict(metrics, baselineAgg, recentAgg, diagnosisLabels);

  return {
    verdict,
    baselineWindow: baselineAgg,
    recentWindow: recentAgg,
    metrics,
    strategy: windows.strategy,
  };
}
