import { parseTranscript, getAssistantMessages, getToolResults, computeTotalUsage, getUserMessages, getMessages } from '../parser.js';
import { estimateSessionCostFromEvents } from '../estimator.js';
import { estimateMessageCost } from '../estimator.js';
import { analyzeSession } from '../heuristics.js';
import { formatDiagnosis, formatMessages, formatUserMessages } from '../formatter.js';
import { resolveSession, sessionLabel } from '../resolve-session.js';
import { computeTurnMetrics, markRetries } from '../trend.js';
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
    .option('-m, --messages', 'Show which of your messages triggered the most expensive work')
    .option('--all-messages', 'Also show detailed assistant turn breakdown (use with -m)')
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

        // Per-message breakdown
        if (opts.messages || opts.allMessages) {
          // User-centric view: which of YOUR messages triggered the most expensive work
          const userGroups = groupCostsByUserMessage(events);
          console.log(formatUserMessages(userGroups, finalCost, opts.format));

          // Detailed assistant turn breakdown (only with --all-messages)
          if (opts.allMessages) {
            let turnMetrics = computeTurnMetrics(events);
            turnMetrics = markRetries(turnMetrics, events);
            const enriched = enrichTurnsWithContent(turnMetrics, events);
            console.log(formatMessages(enriched, finalCost, opts.format, { showAll: true }));
          }
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
}

/**
 * Strip relay metadata wrappers and cron prefixes from user message text
 * to extract the actual human-written content.
 */
function extractUserText(raw) {
  if (!raw) return '';
  let text = raw;
  // Strip relay metadata blocks
  text = text.replace(/Conversation info \(untrusted metadata\):\n```json\n[\s\S]*?```\n\n/g, '');
  text = text.replace(/Sender \(untrusted metadata\):\n```json\n[\s\S]*?```\n\n/g, '');
  // Strip cron prefix
  text = text.replace(/^\[cron:[^\]]+\]\s*/, '');
  return text.trim();
}

/**
 * Group assistant turn costs by the user message that triggered them.
 * Each group contains: the user's text, total cost, assistant turn count,
 * and the index of the first assistant turn in that group.
 */
function groupCostsByUserMessage(events) {
  const messages = getMessages(events);
  const groups = [];
  let current = null;

  for (const m of messages) {
    if (m.role === 'user') {
      if (current) groups.push(current);
      current = {
        userText: extractUserText(m.textContent),
        rawText: m.textContent,
        timestamp: m.messageTimestamp || m.timestamp,
        totalCost: 0,
        assistantTurns: 0,
        totalInput: 0,
        totalOutput: 0,
        totalCacheRead: 0,
        toolCallCount: 0,
        toolErrors: 0,
        peakContext: 0,
        toolNames: [],
        agentPreview: '',
      };
    } else if (m.role === 'assistant' && current) {
      const usage = m.usage || {};
      const cost = estimateMessageCost(usage, m.model);
      current.totalCost += cost;
      current.assistantTurns++;
      current.totalInput += usage.input || 0;
      current.totalOutput += usage.output || 0;
      current.totalCacheRead += usage.cacheRead || 0;
      current.toolCallCount += m.toolCalls?.length || 0;
      const ctx = (usage.input || 0) + (usage.cacheRead || 0);
      if (ctx > current.peakContext) current.peakContext = ctx;

      // Collect tool names (deduplicated)
      for (const tc of (m.toolCalls || [])) {
        if (tc.name && !current.toolNames.includes(tc.name)) {
          current.toolNames.push(tc.name);
        }
      }
      // Capture first meaningful text snippet as agent preview
      if (!current.agentPreview && m.textContent && m.textContent.trim().length > 0) {
        current.agentPreview = m.textContent.trim();
      }
    }
  }
  if (current) groups.push(current);

  return groups;
}

/**
 * Enrich turn metrics with message content preview from the original events.
 * Each turn gets a `preview` string: assistant text snippet, or tool call names.
 */
function enrichTurnsWithContent(turnMetrics, events) {
  const assistantMsgs = getAssistantMessages(events);

  return turnMetrics.map((turn, i) => {
    const msg = assistantMsgs[i];
    if (!msg) return { ...turn, preview: '' };

    // Build preview: prefer text content, fall back to tool call names
    let preview = '';
    if (msg.textContent && msg.textContent.trim().length > 0) {
      preview = msg.textContent.trim();
    } else if (msg.toolCalls && msg.toolCalls.length > 0) {
      preview = msg.toolCalls.map(tc => tc.name).join(', ');
    }

    return { ...turn, preview };
  });
}
