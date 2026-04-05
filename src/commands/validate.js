import { parseTranscript } from '../parser.js';
import { analyzeSession } from '../heuristics.js';
import { validateImpact } from '../trend.js';
import { formatValidation } from '../formatter.js';
import { resolveSession, sessionLabel } from '../resolve-session.js';
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
        const result = await resolveSession(sessionKeyOrId, opts);
        if (!result) return;
        const { session } = result;

        if (!session.transcriptPath) {
          console.log(chalk.yellow(`Transcript file not found for session "${sessionLabel(session)}".`));
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
          changeDetectedAt: process.env.OCLAW_COST_CHANGE_DETECTED_AT || null,
        });

        console.log(formatValidation(sessionLabel(session), validation, analysis, opts.format));
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
}
