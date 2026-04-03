import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, getAssistantMessages, getToolResults, getUserMessages, computeTotalUsage } from '../src/parser.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures', 'openclaw-mock');

describe('parseTranscript', () => {
  it('parses a valid JSONL transcript', async () => {
    const { events, warnings } = await parseTranscript(join(FIXTURES_DIR, 'sess-005-clean.jsonl'));
    assert.ok(events.length > 0, 'Should have parsed events');
    assert.equal(warnings.length, 0, 'Should have no warnings');
  });

  it('extracts session header event', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-005-clean.jsonl'));
    const session = events.find(e => e.type === 'session');
    assert.ok(session, 'Should have a session event');
    assert.equal(session.id, 'sess-005-clean');
  });

  it('extracts user messages', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-005-clean.jsonl'));
    const userMsgs = getUserMessages(events);
    assert.equal(userMsgs.length, 1);
    assert.ok(userMsgs[0].textContent.includes('utility function'));
  });

  it('extracts assistant messages with usage', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-005-clean.jsonl'));
    const assistantMsgs = getAssistantMessages(events);
    assert.ok(assistantMsgs.length >= 2, 'Should have at least 2 assistant messages');
    assert.ok(assistantMsgs[0].usage, 'First assistant message should have usage');
    assert.ok(assistantMsgs[0].usage.totalTokens > 0, 'Should have non-zero tokens');
  });

  it('extracts tool calls from assistant messages', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-005-clean.jsonl'));
    const assistantMsgs = getAssistantMessages(events);
    const withTools = assistantMsgs.filter(m => m.toolCalls && m.toolCalls.length > 0);
    assert.ok(withTools.length >= 1, 'Should have at least 1 assistant message with tool calls');
    assert.equal(withTools[0].toolCalls[0].name, 'write');
  });

  it('extracts tool results', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-005-clean.jsonl'));
    const toolResults = getToolResults(events);
    assert.ok(toolResults.length >= 1);
    assert.equal(toolResults[0].isError, false);
  });

  it('computes total usage', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-005-clean.jsonl'));
    const usage = computeTotalUsage(events);
    assert.ok(usage.totalTokens > 0, 'Total tokens should be positive');
    assert.ok(usage.input > 0, 'Input tokens should be positive');
    assert.ok(usage.output > 0, 'Output tokens should be positive');
  });

  it('handles bloat transcript with large contexts', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-001-bloat.jsonl'));
    const usage = computeTotalUsage(events);
    assert.ok(usage.totalTokens > 100000, `Expected >100K tokens, got ${usage.totalTokens}`);
  });
});
