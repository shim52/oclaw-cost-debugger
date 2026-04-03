import { discoverSessions } from '../discovery.js';
import { parseTranscript, getAssistantMessages, getToolResults } from '../parser.js';
import { estimateSessionCostFromMeta, estimateSessionCostFromEvents } from '../estimator.js';
import { analyzeSession } from '../heuristics.js';
import { formatScanTable } from '../formatter.js';
import chalk from 'chalk';

export function registerScan(program) {
  program
    .command('scan')
    .description('Scan sessions and rank by token usage')
    .option('-p, --path <path>', 'Custom OpenClaw sessions path')
    .option('-n, --top <n>', 'Number of top sessions to show', '5')
    .option('-f, --format <format>', 'Output format: text, json, markdown', 'text')
    .option('--sort <field>', 'Sort by: tokens, cost, age', 'tokens')
    .option('--no-diagnose', 'Skip heuristic diagnosis on top sessions')
    .option('-v, --verbose', 'Verbose multi-line format with detailed triage')
    .option('--full-ids', 'Display full session IDs without truncation')
    .action(async (opts) => {
      try {
        const sessions = await discoverSessions(opts.path);

        if (sessions.length === 0) {
          console.log(chalk.yellow('⚠ No OpenClaw sessions found.'));
          if (!opts.path) {
            console.log(chalk.dim('  Tip: use --path to specify your sessions directory'));
          }
          return;
        }

        // Build scan results with cost estimates
        let results = sessions.map(s => ({
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
          status: s.meta.status,
          compactionCount: s.meta.compactionCount,
          transcriptPath: s.transcriptPath,
          origin: s.meta.origin,
          topLabel: null,
          triage: null,
        }));

        // Sort
        switch (opts.sort) {
          case 'cost':
            results.sort((a, b) => b.estimatedCost - a.estimatedCost);
            break;
          case 'age':
            results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            break;
          default: // tokens
            results.sort((a, b) => b.totalTokens - a.totalTokens);
        }

        // Limit
        const top = parseInt(opts.top, 10) || 5;
        results = results.slice(0, top);

        // Optionally run heuristic diagnosis on top sessions
        if (opts.diagnose !== false) {
          for (const r of results) {
            if (r.transcriptPath) {
              try {
                const { events } = await parseTranscript(r.transcriptPath);
                // We need to look up the original session meta
                const sessionMeta = sessions.find(s => s.sessionId === r.sessionId)?.meta || {};
                const analysis = analyzeSession(events, sessionMeta);
                r.topLabel = analysis.labels[0]?.label || 'clean_session';
                r.triage = analysis.triage;
              } catch { /* skip */ }
            }
          }
        } else {
          for (const r of results) {
            r.triage = {
              priority: 'unknown',
              worthInspecting: 'unknown',
              whyFlagged: 'diagnosis skipped (--no-diagnose)',
              suggestedNextStep: 'remove --no-diagnose flag to view'
            };
          }
        }

        console.log(formatScanTable(results, { format: opts.format, verbose: opts.verbose, fullIds: opts.fullIds }));
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
}
