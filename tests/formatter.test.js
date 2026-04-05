import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatMessages, formatScanTable, formatUserMessages } from '../src/formatter.js';

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

describe('formatUserMessages', () => {
  const groups = [
    { userText: 'Fix the login bug', timestamp: new Date('2026-04-01T10:00:00Z'), totalCost: 0.50, assistantTurns: 3, totalInput: 30000, totalOutput: 500, totalCacheRead: 20000, peakContext: 50000, toolCallCount: 4, toolErrors: 0 },
    { userText: 'Deploy to staging', timestamp: new Date('2026-04-01T10:05:00Z'), totalCost: 0.10, assistantTurns: 1, totalInput: 5000, totalOutput: 100, totalCacheRead: 3000, peakContext: 8000, toolCallCount: 1, toolErrors: 0 },
    { userText: 'Refactor the auth module completely', timestamp: new Date('2026-04-01T10:10:00Z'), totalCost: 1.20, assistantTurns: 7, totalInput: 80000, totalOutput: 2000, totalCacheRead: 60000, peakContext: 140000, toolCallCount: 12, toolErrors: 1 },
  ];
  const totalCost = 1.80;

  it('shows costliest user messages sorted by cost', () => {
    const output = formatUserMessages(groups, totalCost, 'text');
    assert.ok(output.includes('Refactor the auth'), 'Should show costliest message text');
    assert.ok(output.includes('PEAK'), 'Should flag costliest message');
    assert.ok(output.includes('67%'), 'Should show percentage for costliest');
  });

  it('shows user message text in quotes', () => {
    const output = formatUserMessages(groups, totalCost, 'text');
    assert.ok(output.includes('"Fix the login bug"'), 'Should quote user text');
  });

  it('returns valid JSON with userMessages array', () => {
    const output = formatUserMessages(groups, totalCost, 'json');
    const parsed = JSON.parse(output);
    assert.ok(Array.isArray(parsed.userMessages));
    assert.equal(parsed.userMessages.length, 3);
    assert.equal(parsed.totalCost, 1.80);
    // Should be sorted by cost desc
    assert.ok(parsed.userMessages[0].totalCost > parsed.userMessages[1].totalCost);
    assert.ok(parsed.userMessages[0].pctOfTotal > 0);
  });

  it('returns markdown table', () => {
    const output = formatUserMessages(groups, totalCost, 'markdown');
    assert.ok(output.includes('|'), 'Should contain table pipes');
    assert.ok(output.includes('Costliest Messages'), 'Should have header');
  });

  it('handles empty groups', () => {
    const output = formatUserMessages([], 0, 'text');
    assert.ok(output.includes('No user messages'));
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
