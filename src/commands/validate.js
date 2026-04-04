import { discoverSessions } from '../discovery.js';
import { parseTranscript, getAssistantMessages, getToolResults, computeTotalUsage } from '../parser.js';
import { estimateSessionCostFromEvents, estimateSessionCostFromMeta } from '../estimator.js';
import { analyzeSession } from '../heuristics.js';
import { validateImpact } from '../trend.js';
import { formatValidation } from '../formatter.js';
import chalk from 'chalk';

export function registerValidate(program) {
  program
    .command('validate [sessionKeyOrId]')
    .description('Check whether a session is getting healthier over time')
    .option('-s, --session <id>', 'Session ID to validate (legacy)')
    .option('-p, --path <path>', 'Custom OpenClaw sessions path')
    .option('-f, --format <format>', 'Output format: text, json, markdown', 'text')
    .option('--rank <index>', 'Validate session by rank (1-based index)')
    .option('--sort <field>', 'Sort field for ranking: tokens, cost, age', 'tokens')
    .option('--strategy <strategy>', 'Window split strategy: auto, halves, recent-N, time-24h', 'auto')
    .action(async (sessionKeyOrId, opts) => {
      try {
        const targetSession = sessionKeyOrId || opts.session;
        if (!targetSession && !opts.rank) {
          console.error(chalk.red('Error: missing required argument: <sessionKeyOrId> or --session or --rank'));
          process.exit(1);
        }

        const sessions = await discoverSessions(opts.path);
        let session = null;

        if (opts.rank) {
          const rank = parseInt(opts.rank, 10);
          if (isNaN(rank) || rank < 1) {
            console.error(chalk.red('Error: --rank must be a positive integer'));
            process.exit(1);
          }

          let sorted = [...sessions];
          sorted.forEach(s => s.estimatedCost = estimateSessionCostFromMeta(s.meta));

          switch (opts.sort) {
            case 'cost':
              sorted.sort((a, b) => b.estimatedCost - a.estimatedCost);
              break;
            case 'age':
              sorted.sort((a, b) => (b.meta.updatedAt || 0) - (a.meta.updatedAt || 0));
              break;
            default:
              sorted.sort((a, b) => b.meta.totalTokens - a.meta.totalTokens);
          }

          session = sorted[rank - 1];
          if (!session) {
            console.error(chalk.red(`Error: rank ${rank} is out of bounds. Found ${sorted.length} sessions.`));
            process.exit(1);
          }
        } else {
          session = sessions.find(s => s.sessionKey === targetSession || s.sessionId === targetSession);

          if (!session) {
            const matches = sessions.filter(s =>
              (s.sessionKey && s.sessionKey.startsWith(targetSession)) ||
              (s.sessionId && s.sessionId.startsWith(targetSession))
            );
            if (matches.length === 1) {
              session = matches[0];
            } else if (matches.length > 1) {
              console.log(chalk.yellow(`Prefix "${targetSession}" is ambiguous. Matches:`));
              for (const m of matches.slice(0, 5)) {
                console.log(chalk.dim(`    - ${m.sessionKey && m.sessionKey !== 'unknown' ? m.sessionKey : m.sessionId}`));
              }
              if (matches.length > 5) console.log(chalk.dim(`    ... and ${matches.length - 5} more`));
              return;
            }
          }
        }

        if (!session) {
          console.log(chalk.yellow(`Session "${targetSession}" not found.`));
          if (sessions.length > 0) {
            console.log(chalk.dim(`  Available sessions:`));
            for (const s of sessions.slice(0, 10)) {
              console.log(chalk.dim(`    - ${s.sessionKey && s.sessionKey !== 'unknown' ? s.sessionKey : s.sessionId}`));
            }
          }
          return;
        }

        if (!session.transcriptPath) {
          console.log(chalk.yellow(`Transcript file not found for session "${targetSession}".`));
          console.log(chalk.dim(`  Only metadata is available — validation requires the .jsonl transcript.`));
          return;
        }

        // Parse transcript
        const { events, warnings } = await parseTranscript(session.transcriptPath);

        if (warnings.length > 0) {
          console.error(chalk.dim(`  ${warnings.length} parse warning(s) — partial data may affect validation`));
        }

        // Run diagnosis first to provide context
        const analysis = analyzeSession(events, session.meta);
        const diagnosisLabels = analysis.labels;

        // Run impact validation
        const validation = validateImpact(events, {
          strategy: opts.strategy,
          diagnosisLabels,
        });

        const sessionLabel = session.sessionKey && session.sessionKey !== 'unknown'
          ? session.sessionKey
          : session.sessionId;

        console.log(formatValidation(sessionLabel, validation, analysis, opts.format));
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
}
