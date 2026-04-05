import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatMessages, formatScanTable } from '../src/formatter.js';

describe('formatMessages', () => {
  const turnMetrics = [
    { index: 0, timestamp: new Date('2026-04-01T10:00:00Z'), inputTokens: 5000, outputTokens: 200, cacheRead: 3000, contextSize: 8000, cost: 0.02, model: 'gpt-5-mini', toolCallCount: 1, toolErrors: 0, isRetry: false },
    { index: 1, timestamp: new Date('2026-04-01T10:01:00Z'), inputTokens: 12000, outputTokens: 500, cacheRead: 8000, contextSize: 20000, cost: 0.08, model: 'gpt-5-mini', toolCallCount: 2, toolErrors: 1, isRetry: false },
    { index: 2, timestamp: new Date('2026-04-01T10:02:00Z'), inputTokens: 25000, outputTokens: 300, cacheRead: 18000, contextSize: 43000, cost: 0.15, model: 'gpt-5-mini', toolCallCount: 0, toolErrors: 0, isRetry: false },
  ];
  const totalCost = 0.25;

  it('returns a string containing all turn indices for text format', () => {
    const output = formatMessages(turnMetrics, totalCost, 'text');
    assert.ok(typeof output === 'string');
    assert.ok(output.includes('#0'), 'Should contain turn #0');
    assert.ok(output.includes('#1'), 'Should contain turn #1');
    assert.ok(output.includes('#2'), 'Should contain turn #2');
  });

  it('shows cost for each turn in text format', () => {
    const output = formatMessages(turnMetrics, totalCost, 'text');
    assert.ok(output.includes('0.15') || output.includes('0.1500'), 'Should show turn 2 cost');
  });

  it('shows percentage of total cost', () => {
    const output = formatMessages(turnMetrics, totalCost, 'text');
    assert.ok(output.includes('60%'), 'Should show 60% for the costliest turn');
  });

  it('highlights the costliest turn', () => {
    const output = formatMessages(turnMetrics, totalCost, 'text');
    assert.ok(output.includes('43'), 'Should show context size ~43k for costliest turn');
  });

  it('returns valid JSON for json format', () => {
    const output = formatMessages(turnMetrics, totalCost, 'json');
    const parsed = JSON.parse(output);
    assert.equal(parsed.turns.length, 3);
    assert.equal(parsed.totalCost, 0.25);
    assert.ok(parsed.turns[0].cost !== undefined);
    assert.ok(parsed.turns[0].pctOfTotal !== undefined);
  });

  it('returns markdown table for markdown format', () => {
    const output = formatMessages(turnMetrics, totalCost, 'markdown');
    assert.ok(output.includes('|'), 'Should contain table pipes');
    assert.ok(output.includes('#0'), 'Should contain turn indices');
  });

  it('handles empty turn metrics', () => {
    const output = formatMessages([], 0, 'text');
    assert.ok(output.includes('No assistant turns'));
  });
});

describe('formatScanTable with costliestMsgCost', () => {
  it('shows Peak Msg column when data is present', () => {
    const sessions = [
      {
        sessionId: 'sess-001', sessionKey: 'test', model: 'gpt-5-mini',
        totalTokens: 50000, estimatedCost: 0.25, updatedAt: new Date(),
        origin: { provider: 'whatsapp' }, topLabel: 'context_bloat',
        triage: { priority: 'high', whyFlagged: 'test', suggestedNextStep: 'inspect' },
        costliestMsgCost: 0.15, costliestMsgPct: 60,
      },
    ];
    const output = formatScanTable(sessions, { format: 'text' });
    assert.ok(output.includes('60%'), 'Should show costliest message percentage');
  });

  it('includes costliestMsgCost in JSON output', () => {
    const sessions = [
      {
        sessionId: 'sess-001', sessionKey: 'test', model: 'gpt-5-mini',
        totalTokens: 50000, estimatedCost: 0.25, updatedAt: new Date(),
        origin: null, topLabel: 'clean_session',
        triage: { priority: 'low', whyFlagged: 'n/a' },
        costliestMsgCost: 0.15, costliestMsgPct: 60,
      },
    ];
    const output = formatScanTable(sessions, { format: 'json' });
    const parsed = JSON.parse(output);
    assert.equal(parsed[0].costliestMsgCost, 0.15);
    assert.equal(parsed[0].costliestMsgPct, 60);
  });

  it('shows dash when costliestMsgCost is not available', () => {
    const sessions = [
      {
        sessionId: 'sess-002', sessionKey: 'test2', model: 'gpt-5-mini',
        totalTokens: 1000, estimatedCost: 0.01, updatedAt: new Date(),
        origin: null, topLabel: 'clean_session',
        triage: { priority: 'low', whyFlagged: 'n/a' },
      },
    ];
    const output = formatScanTable(sessions, { format: 'text' });
    // Should still render without error
    assert.ok(typeof output === 'string');
  });
});
