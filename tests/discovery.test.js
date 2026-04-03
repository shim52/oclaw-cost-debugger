import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { discoverSessions } from '../src/discovery.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures', 'openclaw-mock');

describe('discoverSessions', () => {
  it('discovers sessions from a directory with sessions.json', async () => {
    const sessions = await discoverSessions(FIXTURES_DIR);
    assert.ok(sessions.length >= 5, `Expected at least 5 sessions, got ${sessions.length}`);
  });

  it('parses session metadata correctly', async () => {
    const sessions = await discoverSessions(FIXTURES_DIR);
    const bloat = sessions.find(s => s.sessionId === 'sess-001-bloat');
    assert.ok(bloat, 'sess-001-bloat not found');
    assert.equal(bloat.meta.model, 'claude-3.5-sonnet');
    assert.equal(bloat.meta.modelProvider, 'anthropic');
    assert.equal(bloat.meta.totalTokens, 227000);
    assert.equal(bloat.agentId, 'main');
  });

  it('resolves transcript paths for existing .jsonl files', async () => {
    const sessions = await discoverSessions(FIXTURES_DIR);
    const bloat = sessions.find(s => s.sessionId === 'sess-001-bloat');
    assert.ok(bloat.transcriptPath, 'Transcript path should be resolved');
    assert.ok(bloat.transcriptPath.endsWith('.jsonl'), 'Should end with .jsonl');
  });

  it('returns empty array for nonexistent path', async () => {
    const sessions = await discoverSessions('/tmp/nonexistent-openclaw-dir');
    assert.equal(sessions.length, 0);
  });
});
