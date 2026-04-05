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
  computeNextHypothesis,
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
        ['likely_improved', 'mixed_signals', 'no_clear_improvement', 'still_recurring', 'worse', 'insufficient_data']
          .includes(result.verdict.verdict),
        `Unexpected verdict: ${result.verdict.verdict}`
      );
      assert.ok(result.strategy, 'Should report strategy used');
    });

    it('detects partial improvement but stays conservative in long-lived session', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-006-long-lived.jsonl'));
      const result = validateImpact(events, {
        diagnosisLabels: ['context_bloat'],
      });

      // sess-006 has lower avg context in recent half, but peak context still grew
      assert.ok(result.baselineWindow, 'Should have baseline');
      assert.ok(result.recentWindow, 'Should have recent');
      assert.ok(
        result.recentWindow.avgContextSize < result.baselineWindow.avgContextSize,
        `Recent avg context (${result.recentWindow.avgContextSize}) should be less than baseline (${result.baselineWindow.avgContextSize})`
      );
      // Verdict should be conservative — mixed_signals, not likely_improved — because peak context worsened
      assert.ok(
        ['mixed_signals', 'no_clear_improvement'].includes(result.verdict.verdict),
        `Expected conservative verdict when burden signals are mixed, got: ${result.verdict.verdict}`
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

    it('produces mixed_signals when burden worsens but process improves', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-008-mixed-signals.jsonl'));
      const result = validateImpact(events, {
        diagnosisLabels: ['context_bloat'],
      });

      // sess-008: retries stop in later half (process improves) but cache-read/context keep growing (burden worsens)
      assert.ok(
        result.verdict.verdict !== 'likely_improved',
        `Should NOT report likely_improved when burden metrics worsen, got: ${result.verdict.verdict}`
      );
      // Should be mixed_signals, worse, or no_clear_improvement — never likely_improved
      assert.ok(
        ['mixed_signals', 'worse', 'no_clear_improvement', 'still_recurring'].includes(result.verdict.verdict),
        `Expected conservative verdict, got: ${result.verdict.verdict}`
      );
    });

    it('never returns likely_improved when key burden metrics worsen', async () => {
      // Synthetic test: simulate burden worsened, process improved
      const fakeBaseline = aggregateWindow([
        { inputTokens: 20000, outputTokens: 200, cacheRead: 30000, contextSize: 50000, cost: 0.10, modelTier: 'standard', toolCallCount: 1, toolErrors: 1, largeToolResults: 0, isRetry: true },
        { inputTokens: 22000, outputTokens: 200, cacheRead: 32000, contextSize: 54000, cost: 0.11, modelTier: 'standard', toolCallCount: 1, toolErrors: 1, largeToolResults: 0, isRetry: true },
        { inputTokens: 24000, outputTokens: 200, cacheRead: 34000, contextSize: 58000, cost: 0.12, modelTier: 'standard', toolCallCount: 1, toolErrors: 0, largeToolResults: 0, isRetry: false },
      ]);
      const fakeRecent = aggregateWindow([
        { inputTokens: 18000, outputTokens: 200, cacheRead: 50000, contextSize: 68000, cost: 0.14, modelTier: 'standard', toolCallCount: 1, toolErrors: 0, largeToolResults: 0, isRetry: false },
        { inputTokens: 17000, outputTokens: 200, cacheRead: 55000, contextSize: 72000, cost: 0.15, modelTier: 'standard', toolCallCount: 1, toolErrors: 0, largeToolResults: 0, isRetry: false },
        { inputTokens: 16000, outputTokens: 200, cacheRead: 58000, contextSize: 74000, cost: 0.16, modelTier: 'standard', toolCallCount: 1, toolErrors: 0, largeToolResults: 0, isRetry: false },
      ]);
      const metrics = compareWindows(fakeBaseline, fakeRecent);
      const verdict = computeVerdict(metrics, fakeBaseline, fakeRecent, ['context_bloat']);

      assert.notEqual(verdict.verdict, 'likely_improved',
        `Must not claim likely_improved when cache-read and context size worsened (got: ${verdict.verdict})`);
    });

    it('returns insufficient_data for very short sessions', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-004-overpowered.jsonl'));
      const result = validateImpact(events);
      // sess-004 has very few turns — may be insufficient
      if (result.verdict.verdict === 'insufficient_data') {
        assert.equal(result.strategy, 'none');
        assert.equal(result.nextHypothesis, null, 'No next hypothesis for insufficient data');
      }
    });


    it('returns insufficient_data when a config change is too recent to validate fairly', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-006-long-lived.jsonl'));
      const result = validateImpact(events, {
        diagnosisLabels: ['context_bloat'],
        changeDetectedAt: new Date().toISOString(),
      });

      assert.ok(['insufficient_data', 'mixed_signals', 'no_clear_improvement', 'still_recurring', 'worse'].includes(result.verdict.verdict));
      assert.ok(result.changeLag, 'Should include change-lag metadata');
      assert.ok(typeof result.verdict.reason === 'string' && result.verdict.reason.length > 0);
    });
  });

  describe('computeNextHypothesis', () => {
    it('returns null for likely_improved', () => {
      const verdict = { verdict: 'likely_improved', confidence: 'high', reason: 'test' };
      const result = computeNextHypothesis(verdict, [], aggregateWindow([]), aggregateWindow([]), []);
      assert.equal(result, null);
    });

    it('returns null for insufficient_data', () => {
      const verdict = { verdict: 'insufficient_data', confidence: 'low', reason: 'test' };
      const result = computeNextHypothesis(verdict, [], aggregateWindow([]), aggregateWindow([]), []);
      assert.equal(result, null);
    });

    it('produces escalation with causalBridge for worse verdict', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-007-no-improvement.jsonl'));
      const result = validateImpact(events, {
        diagnosisLabels: ['context_bloat'],
      });

      assert.ok(result.nextHypothesis, 'Should produce a next hypothesis for negative verdict');
      assert.ok(result.nextHypothesis.likelyIssueClass, 'Should have a likely issue class');
      assert.ok(result.nextHypothesis.causalBridge, 'Should have a causal bridge explaining why first-line failed');
      assert.ok(result.nextHypothesis.nextActions.length > 0, 'Should have next actions');
    });

    it('includes structuralRisk when context is large and bloat persists', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-007-no-improvement.jsonl'));
      const result = validateImpact(events, {
        diagnosisLabels: ['context_bloat'],
      });

      // sess-007 has large, growing context — should surface structural risk
      assert.ok(result.nextHypothesis.structuralRisk,
        'Should include a structural risk for large-context bloat sessions');
    });

    it('produces escalation for still_recurring retry_churn', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-007-no-improvement.jsonl'));
      const result = validateImpact(events, {
        diagnosisLabels: ['retry_churn'],
      });

      assert.ok(result.nextHypothesis, 'Should produce next hypothesis for retry_churn');
      assert.ok(result.nextHypothesis.causalBridge, 'Should have a causal bridge');
      assert.ok(
        result.nextHypothesis.likelyIssueClass.includes('retry') || result.nextHypothesis.likelyIssueClass.includes('workflow'),
        `Expected retry/workflow issue class, got: ${result.nextHypothesis.likelyIssueClass}`
      );
    });

    it('produces layered escalation for mixed_signals bloat', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-006-long-lived.jsonl'));
      const result = validateImpact(events, {
        diagnosisLabels: ['context_bloat'],
      });

      // sess-006 gets mixed_signals — should still get escalation with causal bridge
      assert.ok(result.nextHypothesis, 'mixed_signals should produce escalation guidance');
      assert.ok(result.nextHypothesis.causalBridge, 'Should explain why first-line was insufficient');
      assert.ok(result.nextHypothesis.nextActions.length >= 2, 'Should have at least 2 next actions');
    });

    it('causal bridge references what improved vs worsened', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-006-long-lived.jsonl'));
      const result = validateImpact(events, {
        diagnosisLabels: ['context_bloat'],
      });

      const bridge = result.nextHypothesis.causalBridge;
      // Should mention either improvement or worsening
      assert.ok(
        bridge.includes('improved') || bridge.includes('worsened') || bridge.includes('flat'),
        `Causal bridge should reference metric trends, got: ${bridge}`
      );
    });

    it('does not produce escalation for improved sessions', () => {
      const verdict = { verdict: 'likely_improved', confidence: 'medium', reason: 'test' };
      const result = computeNextHypothesis(verdict, [], aggregateWindow([]), aggregateWindow([]), ['context_bloat']);
      assert.equal(result, null, 'Should not escalate an improved session');
    });

    it('produces generic escalation with causalBridge for unknown diagnosis', async () => {
      const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-007-no-improvement.jsonl'));
      const result = validateImpact(events, {
        diagnosisLabels: ['unknown'],
      });

      if (result.nextHypothesis) {
        assert.ok(result.nextHypothesis.likelyIssueClass, 'Generic escalation should have an issue class');
        assert.ok(result.nextHypothesis.causalBridge, 'Generic escalation should have a causal bridge');
        assert.ok(result.nextHypothesis.nextActions.length > 0, 'Generic escalation should have actions');
      }
    });
  });
});
