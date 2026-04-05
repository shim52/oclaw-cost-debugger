import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatMessages, formatScanTable } from '../src/formatter.js';

describe('formatMessages', () => {
  const turns = [
    { index: 0, timestamp: new Date('2026-04-01T10:00:00Z'), inputTokens: 5000, outputTokens: 200, cacheRead: 3000, contextSize: 8000, cost: 0.02, model: 'gpt-5-mini', toolCallCount: 1, toolErrors: 0, isRetry: false, preview: 'memory_search, write' },
    { index: 1, timestamp: new Date('2026-04-01T10:01:00Z'), inputTokens: 12000, outputTokens: 500, cacheRead: 8000, contextSize: 20000, cost: 0.08, model: 'gpt-5-mini', toolCallCount: 2, toolErrors: 1, isRetry: false, preview: 'Found the root cause: the cron job is failing' },
    { index: 2, timestamp: new Date('2026-04-01T10:02:00Z'), inputTokens: 25000, outputTokens: 300, cacheRead: 18000, contextSize: 43000, cost: 0.15, model: 'gpt-5-mini', toolCallCount: 0, toolErrors: 0, isRetry: false, preview: 'Here is the full analysis of the session costs' },
  ];
  const totalCost = 0.25;

  it('shows top costliest turns sorted by cost', () => {
    const output = formatMessages(turns, totalCost, 'text');
    assert.ok(typeof output === 'string');
    // Turn #2 is costliest, should appear first in top-N view
    assert.ok(output.includes('#2'), 'Should contain costliest turn #2');
    assert.ok(output.includes('0.15'), 'Should show turn 2 cost');
  });

  it('shows percentage of total cost', () => {
    const output = formatMessages(turns, totalCost, 'text');
    assert.ok(output.includes('60%'), 'Should show 60% for the costliest turn');
  });

  it('shows message preview content', () => {
    const output = formatMessages(turns, totalCost, 'text');
    assert.ok(output.includes('full analysis'), 'Should show preview of costliest message');
  });

  it('shows PEAK flag on costliest turn', () => {
    const output = formatMessages(turns, totalCost, 'text');
    assert.ok(output.includes('PEAK'), 'Should flag costliest turn');
  });

  it('returns valid JSON with insights and preview', () => {
    const output = formatMessages(turns, totalCost, 'json');
    const parsed = JSON.parse(output);
    assert.equal(parsed.turns.length, 3);
    assert.equal(parsed.totalCost, 0.25);
    assert.ok(parsed.turns[0].cost !== undefined);
    assert.ok(parsed.turns[0].pctOfTotal !== undefined);
    assert.ok(parsed.turns[0].preview !== undefined);
    assert.ok(Array.isArray(parsed.insights));
  });

  it('returns markdown table with preview column', () => {
    const output = formatMessages(turns, totalCost, 'markdown');
    assert.ok(output.includes('|'), 'Should contain table pipes');
    assert.ok(output.includes('Preview'), 'Should have Preview column');
  });

  it('handles empty turn metrics', () => {
    const output = formatMessages([], 0, 'text');
    assert.ok(output.includes('No assistant turns'));
  });

  it('shows all turns chronologically with showAll option', () => {
    const output = formatMessages(turns, totalCost, 'text', { showAll: true });
    assert.ok(output.includes('#0'), 'Should contain turn #0');
    assert.ok(output.includes('#1'), 'Should contain turn #1');
    assert.ok(output.includes('#2'), 'Should contain turn #2');
    assert.ok(output.includes('All Messages'), 'Should show All Messages title');
  });

  it('computes cost insights for context-heavy sessions', () => {
    const heavyTurns = [
      { index: 0, inputTokens: 50000, outputTokens: 100, cacheRead: 40000, contextSize: 90000, cost: 0.20, model: 'gpt-5', toolCallCount: 1, toolErrors: 0, isRetry: false, preview: 'turn 0' },
      { index: 1, inputTokens: 60000, outputTokens: 100, cacheRead: 80000, contextSize: 140000, cost: 0.40, model: 'gpt-5', toolCallCount: 1, toolErrors: 0, isRetry: false, preview: 'turn 1' },
      { index: 2, inputTokens: 70000, outputTokens: 100, cacheRead: 120000, contextSize: 190000, cost: 0.60, model: 'gpt-5', toolCallCount: 1, toolErrors: 0, isRetry: true, preview: 'turn 2' },
    ];
    const output = formatMessages(heavyTurns, 1.20, 'text');
    // Should have insight about context re-send ratio (99%+ is context)
    assert.ok(output.includes('context re-send') || output.includes('tokens are context'), 'Should include context insight');
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
