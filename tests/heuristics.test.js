import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../src/parser.js';
import { analyzeSession } from '../src/heuristics.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures', 'openclaw-mock');

describe('heuristics', () => {
  it('detects context_bloat in bloat session', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-001-bloat.jsonl'));
    const analysis = analyzeSession(events);
    const labels = analysis.labels.map(l => l.label);
    assert.ok(labels.includes('context_bloat'), `Expected context_bloat, got: ${labels.join(', ')}`);
  });

  it('detects looping_or_indecision in loop session', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-002-loop.jsonl'));
    const analysis = analyzeSession(events);
    const labels = analysis.labels.map(l => l.label);
    assert.ok(
      labels.includes('looping_or_indecision') || labels.includes('retry_churn'),
      `Expected looping or retry pattern, got: ${labels.join(', ')}`
    );
  });

  it('detects tool_failure_cascade in cascade session', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-003-cascade.jsonl'));
    const analysis = analyzeSession(events);
    const labels = analysis.labels.map(l => l.label);
    assert.ok(labels.includes('tool_failure_cascade'), `Expected tool_failure_cascade, got: ${labels.join(', ')}`);
  });

  it('detects overpowered_simple_task in overpowered session', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-004-overpowered.jsonl'));
    const analysis = analyzeSession(events);
    const labels = analysis.labels.map(l => l.label);
    assert.ok(labels.includes('overpowered_simple_task'), `Expected overpowered_simple_task, got: ${labels.join(', ')}`);
  });

  it('produces unknown for clean session', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-005-clean.jsonl'));
    const analysis = analyzeSession(events);
    // Clean session should have no strong diagnoses (or just unknown)
    const topLabel = analysis.labels[0].label;
    assert.ok(
      topLabel === 'unknown' || analysis.labels[0].confidence < 0.6,
      `Expected benign result for clean session, got: ${topLabel} (${analysis.labels[0].confidence})`
    );
  });

  it('returns labels sorted by confidence', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-002-loop.jsonl'));
    const analysis = analyzeSession(events);
    for (let i = 1; i < analysis.labels.length; i++) {
      assert.ok(
        analysis.labels[i].confidence <= analysis.labels[i - 1].confidence,
        'Labels should be sorted by confidence descending'
      );
    }
  });

  it('always has evidence for each label', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-001-bloat.jsonl'));
    const analysis = analyzeSession(events);
    for (const label of analysis.labels) {
      assert.ok(label.evidence.length > 0, `Label "${label.label}" should have evidence`);
    }
  });

  it('produces a summary string', async () => {
    const { events } = await parseTranscript(join(FIXTURES_DIR, 'sess-001-bloat.jsonl'));
    const analysis = analyzeSession(events);
    assert.ok(analysis.summary, 'Should produce a summary');
    assert.ok(analysis.summary.length > 10, 'Summary should be meaningful');
  });
});
