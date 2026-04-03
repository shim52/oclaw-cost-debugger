import { writeFile } from 'node:fs/promises';
import { discoverSessions } from '../discovery.js';
import { parseTranscript, getAssistantMessages, getToolResults, computeTotalUsage } from '../parser.js';
import { estimateSessionCostFromMeta, estimateSessionCostFromEvents } from '../estimator.js';
import { analyzeSession } from '../heuristics.js';
import { formatReport } from '../formatter.js';
import chalk from 'chalk';

export function registerReport(program) {
  program
    .command('report')
    .description('Generate a full report with scan + diagnosis for top sessions')
    .option('-p, --path <path>', 'Custom OpenClaw sessions path')
    .option('-n, --top <n>', 'Number of top sessions to diagnose', '3')
    .option('-f, --format <format>', 'Output format: text, json, markdown', 'text')
    .option('-o, --output <file>', 'Write report to file instead of stdout')
    .option('--sort <field>', 'Sort by: tokens, cost, age', 'cost')
    .action(async (opts) => {
      try {
        const sessions = await discoverSessions(opts.path);

        if (sessions.length === 0) {
          console.log(chalk.yellow('No OpenClaw sessions found.'));
          return;
        }

        // Build scan results with full metadata
        let scanResults = sessions.map(s => ({
          sessionId: s.sessionId,
          sessionKey: s.sessionKey,
          agentId: s.agentId,
          model: s.meta.model,
          provider: s.meta.modelProvider,
          totalTokens: s.meta.totalTokens,
          inputTokens: s.meta.inputTokens,
          outputTokens: s.meta.outputTokens,
          cacheRead: s.meta.cacheRead,
          estimatedCost: estimateSessionCostFromMeta(s.meta),
          updatedAt: s.meta.updatedAt,
          runtimeMs: s.meta.runtimeMs,
          transcriptPath: s.transcriptPath,
          origin: s.meta.origin,
          topLabel: null,
          triage: null,
        }));

        // Sort
        switch (opts.sort) {
          case 'tokens':
            scanResults.sort((a, b) => b.totalTokens - a.totalTokens);
            break;
          case 'age':
            scanResults.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            break;
          default: // cost
            scanResults.sort((a, b) => b.estimatedCost - a.estimatedCost);
        }

        const top = parseInt(opts.top, 10) || 3;
        const topSessions = scanResults.slice(0, top);

        // Run diagnosis on top sessions
        const diagnoses = [];
        for (const r of topSessions) {
          const sessionMeta = sessions.find(s => s.sessionId === r.sessionId)?.meta || {};

          if (!r.transcriptPath) {
            const analysis = analyzeSession([], sessionMeta);
            r.topLabel = 'unknown';
            r.triage = analysis.triage;
            diagnoses.push({
              sessionId: r.sessionId,
              analysis,
              stats: { model: r.model, provider: r.provider, totalTokens: r.totalTokens, estimatedCost: r.estimatedCost },
            });
            continue;
          }

          try {
            const { events } = await parseTranscript(r.transcriptPath);
            const assistantMsgs = getAssistantMessages(events);
            const toolResults = getToolResults(events);
            const usage = computeTotalUsage(events);
            const eventCost = estimateSessionCostFromEvents(events);
            const metaCost = sessionMeta.estimatedCostUsd;
            const finalCost = (metaCost != null && metaCost > 0) ? metaCost : eventCost;

            const stats = {
              model: r.model,
              provider: r.provider,
              totalTokens: usage.totalTokens,
              inputTokens: usage.input,
              outputTokens: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              messageCount: events.filter(e => e.type === 'message').length,
              toolCallCount: assistantMsgs.reduce((sum, m) => sum + (m.toolCalls?.length || 0), 0),
              toolErrorCount: toolResults.filter(tr => tr.isError || (tr.textContent && tr.textContent.includes('"status":"error"'))).length,
              estimatedCost: finalCost,
              runtimeMs: sessionMeta.runtimeMs,
              origin: sessionMeta.origin,
              compactionCount: sessionMeta.compactionCount,
            };

            const analysis = analyzeSession(events, sessionMeta);
            r.topLabel = analysis.labels[0]?.label || 'clean_session';
            r.triage = analysis.triage;

            diagnoses.push({ sessionId: r.sessionId, analysis, stats });
          } catch {
            diagnoses.push({
              sessionId: r.sessionId,
              analysis: { labels: [{ label: 'unknown', confidence: 0.5, evidence: ['Failed to parse transcript'] }], summary: 'Parse error' },
              stats: { model: r.model, totalTokens: r.totalTokens, estimatedCost: r.estimatedCost },
            });
          }
        }

        const reportData = {
          generated: new Date().toISOString(),
          sessions: topSessions,
          diagnoses,
        };

        const output = formatReport(reportData, opts.format);

        if (opts.output) {
          await writeFile(opts.output, output, 'utf-8');
          console.log(chalk.green(`Report written to ${opts.output}`));
        } else {
          console.log(output);
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
}
