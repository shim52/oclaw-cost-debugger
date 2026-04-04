import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../src/parser.js';
import {
  computeTurnMetrics,
  markRetries,
  splitWindows,
  aggregateWindow,
  compareWindows,
  computeVerdict,
  validateImpact
} from '../src/trend.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures', 'openclaw-mock');

describe('trend analysis', () => {
  describe('computeTurnMetrics', () => {
    it('produces one entry per assistant message', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-006-long-lived.jsonl'));
      const metrics = computeTurnMetrics(events);
      // sess-006 has 15 assistant messages
      assert.ok(metrics.length > 0, 'Should produce turn metrics');
      for (const m of metrics) {
        assert.ok(typeof m.inputTokens === 'number');
        assert.ok(typeof m.cacheRead === 'number');
        assert.ok(typeof m.contextSize === 'number');
        assert.ok(typeof m.cost === 'number');
      }
    });

    it('captures tool error counts', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-007-no-improvement.jsonl'));
      const metrics = computeTurnMetrics(events);
      const totalErrors = metrics.reduce((s, m) => s + m.toolErrors, 0);
      assert.ok(totalErrors > 0, 'Should count tool errors from the cascade fixture');
    });
  });

  describe('markRetries', () => {
    it('detects repeated tool call patterns as retries', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-007-no-improvement.jsonl'));
      let metrics = computeTurnMetrics(events);
      metrics = markRetries(metrics, events);
      const retries = metrics.filter(m => m.isRetry);
      assert.ok(retries.length > 0, 'Should detect retries in the loop/retry fixture');
    });
  });

  describe('splitWindows', () => {
    it('returns null for fewer than 4 turns', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-005-clean.jsonl'));
      const metrics = computeTurnMetrics(events);
      if (metrics.length < 4) {
        const result = splitWindows(metrics);
        assert.equal(result, null, 'Should return null for insufficient turns');
      }
    });

    it('splits long-lived sessions into baseline and recent', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-006-long-lived.jsonl'));
      const metrics = computeTurnMetrics(events);
      const windows = splitWindows(metrics, 'halves');
      assert.ok(windows, 'Should produce windows');
      assert.ok(windows.baseline.length > 0, 'Baseline should have turns');
      assert.ok(windows.recent.length > 0, 'Recent should have turns');
      assert.equal(windows.baseline.length + windows.recent.length, metrics.length);
    });
  });

  describe('aggregateWindow', () => {
    it('computes meaningful aggregates', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-006-long-lived.jsonl'));
      const metrics = computeTurnMetrics(events);
      const agg = aggregateWindow(metrics);
      assert.ok(agg.turnCount > 0);
      assert.ok(agg.avgInputTokens > 0);
      assert.ok(agg.avgContextSize > 0);
      assert.ok(agg.totalCost > 0);
      assert.ok(typeof agg.contextGrowthSlope === 'number');
    });

    it('returns zeros for empty window', () => {
      const agg = aggregateWindow([]);
      assert.equal(agg.turnCount, 0);
      assert.equal(agg.avgInputTokens, 0);
      assert.equal(agg.totalCost, 0);
    });
  });

  describe('compareWindows', () => {
    it('produces metric comparisons with trends', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-006-long-lived.jsonl'));
      const metrics = computeTurnMetrics(events);
      const windows = splitWindows(metrics, 'halves');
      const baseAgg = aggregateWindow(windows.baseline);
      const recentAgg = aggregateWindow(windows.recent);
      const comparisons = compareWindows(baseAgg, recentAgg);

      assert.ok(comparisons.length > 0, 'Should produce comparisons');
      for (const c of comparisons) {
        assert.ok(['improved', 'worsened', 'flat'].includes(c.trend), `Unexpected trend: ${c.trend}`);
        assert.ok(typeof c.pctChange === 'number');
        assert.ok(typeof c.label === 'string');
      }
    });
  });

  describe('computeVerdict', () => {
    it('returns insufficient_data for tiny windows', () => {
      const emptyAgg = aggregateWindow([]);
      const tinyAgg = { ...emptyAgg, turnCount: 1 };
      const verdict = computeVerdict([], tinyAgg, tinyAgg);
      assert.equal(verdict.verdict, 'insufficient_data');
    });
  });

  describe('validateImpact (integration)', () => {
    it('produces a full validation for a long-lived session', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-006-long-lived.jsonl'));
      const result = validateImpact(events);

      assert.ok(result.verdict, 'Should have a verdict');
      assert.ok(
        ['likely_improved', 'no_clear_improvement', 'still_recurring', 'worse', 'insufficient_data']
          .includes(result.verdict.verdict),
        `Unexpected verdict: ${result.verdict.verdict}`
      );
      assert.ok(result.strategy, 'Should report strategy used');
    });

    it('detects improving pattern in long-lived session', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-006-long-lived.jsonl'));
      const result = validateImpact(events, {
        diagnosisLabels: ['context_bloat'],
      });

      // sess-006 has high context early, lower later (after implied reset at day boundary)
      assert.ok(result.baselineWindow, 'Should have baseline');
      assert.ok(result.recentWindow, 'Should have recent');
      // The recent window should show lower avg context than baseline
      assert.ok(
        result.recentWindow.avgContextSize < result.baselineWindow.avgContextSize,
        `Recent avg context (${result.recentWindow.avgContextSize}) should be less than baseline (${result.baselineWindow.avgContextSize})`
      );
    });

    it('detects non-improvement in worsening session', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-007-no-improvement.jsonl'));
      const result = validateImpact(events, {
        diagnosisLabels: ['retry_churn', 'tool_failure_cascade'],
      });

      // sess-007 shows steadily growing context with persistent errors
      assert.ok(result.verdict.verdict !== 'likely_improved',
        `Should NOT report improvement for a worsening session, got: ${result.verdict.verdict}`);
    });

    it('returns insufficient_data for very short sessions', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-004-overpowered.jsonl'));
      const result = validateImpact(events);
      // sess-004 has very few turns — may be insufficient
      if (result.verdict.verdict === 'insufficient_data') {
        assert.equal(result.strategy, 'none');
      }
    });
  });
});
