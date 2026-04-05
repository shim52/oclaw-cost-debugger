import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../src/parser.js';
import { computeTurnMetrics, markRetries } from '../src/trend.js';
import { estimateSessionCostFromEvents } from '../src/estimator.js';
import { formatMessages } from '../src/formatter.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures', 'openclaw-mock');

describe('inspect --messages integration', () => {
  it('produces per-message output for a long-lived session', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-006-long-lived.jsonl'));
    let turnMetrics = computeTurnMetrics(events);
    turnMetrics = markRetries(turnMetrics, events);
    const totalCost = estimateSessionCostFromEvents(events);

    const output = formatMessages(turnMetrics, totalCost, 'text');
    assert.ok(output.includes('#0'), 'Should have first turn');
    assert.ok(output.includes('Per-Message Cost Breakdown'), 'Should have header');
    assert.ok(turnMetrics.length > 5, 'sess-006 should have many turns');
  });

  it('marks the costliest turn with PEAK', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-006-long-lived.jsonl'));
    let turnMetrics = computeTurnMetrics(events);
    turnMetrics = markRetries(turnMetrics, events);
    const totalCost = estimateSessionCostFromEvents(events);

    const output = formatMessages(turnMetrics, totalCost, 'text');
    assert.ok(output.includes('PEAK'), 'Should mark costliest turn');
  });

  it('shows retry flags for sessions with retry churn', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-007-no-improvement.jsonl'));
    let turnMetrics = computeTurnMetrics(events);
    turnMetrics = markRetries(turnMetrics, events);
    const totalCost = estimateSessionCostFromEvents(events);

    const output = formatMessages(turnMetrics, totalCost, 'text');
    const hasRetries = turnMetrics.some(t => t.isRetry);
    if (hasRetries) {
      assert.ok(output.includes('retry'), 'Should flag retries');
    }
  });

  it('produces valid JSON with pctOfTotal', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-001-bloat.jsonl'));
    let turnMetrics = computeTurnMetrics(events);
    turnMetrics = markRetries(turnMetrics, events);
    const totalCost = estimateSessionCostFromEvents(events);

    const output = formatMessages(turnMetrics, totalCost, 'json');
    const parsed = JSON.parse(output);
    assert.ok(parsed.turns.length > 0);
    const pctSum = parsed.turns.reduce((s, t) => s + t.pctOfTotal, 0);
    assert.ok(pctSum >= 90 && pctSum <= 110, `Percentages should sum to ~100, got ${pctSum}`);
  });
});
