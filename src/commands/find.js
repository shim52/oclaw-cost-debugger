import { discoverSessions } from '../discovery.js';
import { estimateSessionCostFromMeta } from '../estimator.js';
import { formatScanTable } from '../formatter.js';
import chalk from 'chalk';

export function registerFind(program) {
  program
    .command('find')
    .description('Search and filter sessions')
    .option('-p, --path <path>', 'Custom OpenClaw sessions path')
    .option('-f, --format <format>', 'Output format: text, json, markdown', 'text')
    .option('--model <model>', 'Filter by model name (substring match)')
    .option('--agent <agent>', 'Filter by agent ID')
    .option('--min-tokens <n>', 'Minimum total tokens')
    .option('--max-tokens <n>', 'Maximum total tokens')
    .option('--after <date>', 'Sessions updated after this date (ISO format)')
    .option('--before <date>', 'Sessions updated before this date (ISO format)')
    .option('--kind <kind>', 'Filter by session kind (e.g., direct)')
    .action(async (opts) => {
      try {
        let sessions = await discoverSessions(opts.path);

        if (sessions.length === 0) {
          console.log(chalk.yellow('⚠ No OpenClaw sessions found.'));
          return;
        }

        // Apply filters
        if (opts.model) {
          const m = opts.model.toLowerCase();
          sessions = sessions.filter(s => s.meta.model.toLowerCase().includes(m));
        }

        if (opts.agent) {
          sessions = sessions.filter(s => s.agentId === opts.agent);
        }

        if (opts.minTokens) {
          const min = parseInt(opts.minTokens, 10);
          sessions = sessions.filter(s => s.meta.totalTokens >= min);
        }

        if (opts.maxTokens) {
          const max = parseInt(opts.maxTokens, 10);
          sessions = sessions.filter(s => s.meta.totalTokens <= max);
        }

        if (opts.after) {
          const date = new Date(opts.after);
          sessions = sessions.filter(s => s.meta.updatedAt && s.meta.updatedAt >= date);
        }

        if (opts.before) {
          const date = new Date(opts.before);
          sessions = sessions.filter(s => s.meta.updatedAt && s.meta.updatedAt <= date);
        }

        if (opts.kind) {
          sessions = sessions.filter(s => s.meta.kind === opts.kind);
        }

        if (sessions.length === 0) {
          console.log(chalk.yellow('⚠ No sessions match the given filters.'));
          return;
        }

        // Format as scan results
        const results = sessions
          .map(s => ({
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
            origin: s.meta.origin,
            topLabel: null,
            triage: null,
          }))
          .sort((a, b) => b.estimatedCost - a.estimatedCost);

        console.log(formatScanTable(results, opts.format));
        console.log(chalk.dim(`  ${results.length} session(s) matched filters`));
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
}
