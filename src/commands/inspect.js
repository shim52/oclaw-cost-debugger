import { parseTranscript, getAssistantMessages, getToolResults, computeTotalUsage } from '../parser.js';
import { estimateSessionCostFromEvents } from '../estimator.js';
import { analyzeSession } from '../heuristics.js';
import { formatDiagnosis } from '../formatter.js';
import { resolveSession, sessionLabel } from '../resolve-session.js';
import chalk from 'chalk';

export function registerInspect(program) {
  program
    .command('inspect [sessionKeyOrId]')
    .description('Deep-dive into a specific session with heuristic diagnosis')
    .option('-s, --session <id>', 'Session ID to inspect (legacy)')
    .option('-p, --path <path>', 'Custom OpenClaw sessions path')
    .option('-f, --format <format>', 'Output format: text, json, markdown', 'text')
    .option('--rank <index>', 'Inspect session by rank (1-based index)')
    .option('--sort <field>', 'Sort field for ranking: tokens, cost, age', 'tokens')
    .action(async (sessionKeyOrId, opts) => {
      try {
        const result = await resolveSession(sessionKeyOrId, opts);
        if (!result) return;
        const { session } = result;

        if (!session.transcriptPath) {
          console.log(chalk.yellow(`Transcript file not found for session "${sessionLabel(session)}".`));
          console.log(chalk.dim(`  Only metadata is available — diagnosis requires the .jsonl transcript.`));
          return;
        }

        // Parse transcript
        const { events, warnings } = await parseTranscript(session.transcriptPath);

        if (warnings.length > 0) {
          console.error(chalk.dim(`  ${warnings.length} parse warning(s) — partial data may affect diagnosis`));
        }

        // Compute stats
        const assistantMsgs = getAssistantMessages(events);
        const toolResults = getToolResults(events);
        const usage = computeTotalUsage(events);
        const estimatedCost = estimateSessionCostFromEvents(events);

        const metaCost = session.meta.estimatedCostUsd;
        const finalCost = (metaCost != null && metaCost > 0) ? metaCost : estimatedCost;

        const stats = {
          model: session.meta.model,
          provider: session.meta.modelProvider,
          totalTokens: usage.totalTokens,
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          messageCount: events.filter(e => e.type === 'message').length,
          toolCallCount: assistantMsgs.reduce((sum, m) => sum + (m.toolCalls?.length || 0), 0),
          toolErrorCount: toolResults.filter(tr => tr.isError || (tr.textContent && tr.textContent.includes('"status":"error"'))).length,
          estimatedCost: finalCost,
          runtimeMs: session.meta.runtimeMs,
          status: session.meta.status,
          compactionCount: session.meta.compactionCount,
          origin: session.meta.origin,
        };

        // Run heuristic analysis
        const analysis = analyzeSession(events, session.meta);

        console.log(formatDiagnosis(sessionLabel(session), analysis, stats, opts.format));
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
}
