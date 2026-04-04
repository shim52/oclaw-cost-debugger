import { getAssistantMessages, getToolResults, getUserMessages, getMessages } from './parser.js';
import { estimateTokensFromText, getModelTier, getPricing, simulateModelSwitch, simulateCompaction, getEconomyAlternative, estimateSessionCostFromEvents } from './estimator.js';

/**
 * Run all heuristic detectors against a parsed transcript.
 * @param {Array} events — normalized transcript events
 * @returns {{ labels: Array<{label: string, confidence: number, evidence: string[]}>, summary: string }}
 */
export function analyzeSession(events, meta = {}) {
  const messages = getMessages(events);
  const assistantMsgs = getAssistantMessages(events);
  const toolResults = getToolResults(events);
  const userMsgs = getUserMessages(events);

  const detectors = [
    detectRelayWorkflow,
    detectScheduledWorkflow, 
    detectContextBloat,
    detectLoopingOrIndecision,
    detectRetryChurn,
    detectToolFailureCascade,
    detectOverpoweredSimpleTask,
    detectWeakModelForComplexStep,
    detectBadTaskDecomposition,
    detectProviderRegression,
  ];

  const labels = [];
  for (const detect of detectors) {
    const result = detect({ events, messages, assistantMsgs, toolResults, userMsgs, meta });
    if (result && result.confidence > 0.3) {
      labels.push(result);
    }
  }

  // Sort by confidence descending
  labels.sort((a, b) => b.confidence - a.confidence);

  // Fallback to unknown
  if (labels.length === 0) {
    labels.push({
      label: 'unknown',
      confidence: 0.5,
      evidence: ['No strong pattern detected in this session'],
    });
  }

  const topLabel = labels[0];
  const summary = `Primary diagnosis: ${topLabel.label} (${(topLabel.confidence * 100).toFixed(0)}% confidence). ${topLabel.evidence[0]}`;
  const triage = computeTriage(topLabel, meta, labels, events);

  return { labels, summary, triage };
}

// ─── Detectors ─────────────────────────────────────────

function detectRelayWorkflow({ assistantMsgs, userMsgs, meta }) {
  const evidence = [];
  let confidence = 0;

  const provider = meta?.origin?.provider;
  if (provider === 'whatsapp' || provider === 'telegram' || provider === 'slack') {
    evidence.push(`Session origin marks it as a ${provider} direct message relay`);
    confidence += 0.85;
  } else if (userMsgs.some(m => m.textContent?.toLowerCase().includes('sender_id=')) || 
             assistantMsgs.some(m => m.textContent?.includes('[[reply_to_current]]')) ||
             assistantMsgs.some(m => m.toolCalls?.some(tc => tc.name === 'sessions_send'))) {
    evidence.push(`Identified forwarding or relay patterns (sessions_send or reply_to_current)`);
    confidence += 0.8;
  }

  if (confidence > 0) {
    return { label: 'relay_workflow', confidence: Math.min(confidence, 1), evidence };
  }
  return null;
}

function detectScheduledWorkflow({ userMsgs, events, meta }) {
  const evidence = [];
  let confidence = 0;

  const provider = meta?.origin?.provider;
  const isRelay = provider === 'whatsapp' || provider === 'telegram' || provider === 'slack';
  const isCron = provider === 'cron' ||
                 userMsgs.some(m => m.textContent?.toLowerCase().includes('[cron:'));

  if (isCron) {
    confidence += 0.8;
    evidence.push(`Session origin identified as a scheduled/cron-bound workflow`);

    // Don't promote to stale_scheduled if this is primarily a relay session —
    // relay sessions with embedded cron triggers are better described by context_bloat
    if (!isRelay) {
      const totalTokens = events.reduce((sum, e) => sum + (e?.message?.usage?.totalTokens || 0), 0);
      if (totalTokens > 50000 || events.length > 30) {
        evidence.push(`Scheduled session has accumulated massive context (${totalTokens.toLocaleString()} tokens or >30 events) and may be growing stale`);
        return { label: 'stale_scheduled_session', confidence: 0.95, evidence };
      }
    }
  }

  if (confidence > 0) {
    return { label: 'scheduled_workflow', confidence: Math.min(confidence, 1), evidence };
  }
  return null;
}

function detectContextBloat({ assistantMsgs, toolResults, meta }) {
  const evidence = [];
  let maxContext = 0;
  let firstContext = 0;
  let maxCacheRead = 0;
  let totalTokensAccum = 0;

  for (const msg of assistantMsgs) {
    if (msg.usage) {
      const context = msg.usage.input + msg.usage.cacheRead;
      if (firstContext === 0 && context > 0) firstContext = context;
      if (context > maxContext) maxContext = context;
      if (msg.usage.cacheRead > maxCacheRead) maxCacheRead = msg.usage.cacheRead;
      totalTokensAccum += msg.usage.totalTokens;
    }
  }

  const growthRate = firstContext > 0 ? maxContext / firstContext : 0;

  // Check for large tool results being inlined
  let largeToolResults = 0;
  for (const tr of toolResults) {
    if (tr.textContent && estimateTokensFromText(tr.textContent) > 2000) {
      largeToolResults++;
    }
  }

  let confidence = 0;

  if (maxContext > 50000) {
    evidence.push(`Peak context reached ${maxContext.toLocaleString()} tokens`);
    confidence += 0.3;
  }
  if (growthRate > 2) {
    evidence.push(`Context grew ${growthRate.toFixed(1)}x during session`);
    confidence += 0.2;
  }
  if (maxCacheRead > 30000) {
    evidence.push(`Cache read peaked at ${maxCacheRead.toLocaleString()} tokens — large context being re-sent`);
    confidence += 0.2;
  }
  if (totalTokensAccum > 100000) {
    evidence.push(`${totalTokensAccum.toLocaleString()} total tokens accumulated across ${assistantMsgs.length} turns`);
    confidence += 0.2;
  }
  if (largeToolResults > 3) {
    evidence.push(`${largeToolResults} tool results exceeded 2K tokens each`);
    confidence += 0.2;
  }

  if (confidence > 0) {
    return { label: 'context_bloat', confidence: Math.min(confidence, 1), evidence };
  }
  return null;
}

function detectLoopingOrIndecision({ assistantMsgs, userMsgs }) {
  const evidence = [];
  let confidence = 0;

  // Look for repeated similar assistant messages
  const texts = assistantMsgs
    .filter(m => m.textContent)
    .map(m => m.textContent.slice(0, 200));

  const seen = new Map();
  for (const t of texts) {
    const key = t.toLowerCase().replace(/\s+/g, ' ').trim();
    seen.set(key, (seen.get(key) || 0) + 1);
  }

  const repeated = [...seen.entries()].filter(([, count]) => count > 2);
  if (repeated.length > 0) {
    evidence.push(`${repeated.length} assistant response patterns repeated 3+ times`);
    confidence += 0.4;
  }

  // Look for repeated tool call patterns
  const toolPatterns = assistantMsgs
    .filter(m => m.toolCalls && m.toolCalls.length > 0)
    .map(m => m.toolCalls.map(tc => tc.name).join(','));

  const toolSeen = new Map();
  for (const p of toolPatterns) {
    toolSeen.set(p, (toolSeen.get(p) || 0) + 1);
  }
  const repeatedTools = [...toolSeen.entries()].filter(([, count]) => count > 3);
  if (repeatedTools.length > 0) {
    evidence.push(`Tool call pattern "${repeatedTools[0][0]}" repeated ${repeatedTools[0][1]} times`);
    confidence += 0.3;
  }

  // High message count with little forward progress
  if (assistantMsgs.length > 20 && userMsgs.length <= 3) {
    evidence.push(`${assistantMsgs.length} assistant turns but only ${userMsgs.length} user messages — agent might be looping`);
    confidence += 0.2;
  }

  if (confidence > 0) {
    return { label: 'looping_or_indecision', confidence: Math.min(confidence, 1), evidence };
  }
  return null;
}

function detectRetryChurn({ assistantMsgs }) {
  const evidence = [];
  let confidence = 0;

  // Find consecutive tool calls with the same name
  const toolCalls = assistantMsgs
    .filter(m => m.toolCalls && m.toolCalls.length > 0)
    .flatMap(m => m.toolCalls);

  let consecutiveCount = 0;
  let maxConsecutive = 0;
  let lastTool = null;

  for (const tc of toolCalls) {
    if (tc.name === lastTool) {
      consecutiveCount++;
      maxConsecutive = Math.max(maxConsecutive, consecutiveCount);
    } else {
      consecutiveCount = 1;
      lastTool = tc.name;
    }
  }

  if (maxConsecutive >= 3) {
    evidence.push(`Same tool called ${maxConsecutive} times consecutively`);
    confidence += 0.5;
  }

  // Look for same tool with similar args
  const toolArgStrs = toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.arguments)}`);
  const argSeen = new Map();
  for (const s of toolArgStrs) {
    argSeen.set(s, (argSeen.get(s) || 0) + 1);
  }
  const duplicateCalls = [...argSeen.entries()].filter(([, count]) => count > 2);
  if (duplicateCalls.length > 0) {
    evidence.push(`Identical tool call repeated ${duplicateCalls[0][1]} times`);
    confidence += 0.3;
  }

  if (confidence > 0) {
    return { label: 'retry_churn', confidence: Math.min(confidence, 1), evidence };
  }
  return null;
}

function detectToolFailureCascade({ toolResults }) {
  const evidence = [];
  let confidence = 0;

  // Count errors
  const errors = toolResults.filter(tr => tr.isError);
  const errorRate = toolResults.length > 0 ? errors.length / toolResults.length : 0;

  if (errors.length >= 3) {
    evidence.push(`${errors.length} tool errors out of ${toolResults.length} total tool results`);
    confidence += 0.3;
  }

  if (errorRate > 0.5 && toolResults.length > 4) {
    evidence.push(`${(errorRate * 100).toFixed(0)}% tool failure rate`);
    confidence += 0.3;
  }

  // Check for consecutive errors
  let consecutiveErrors = 0;
  let maxConsecutiveErrors = 0;
  for (const tr of toolResults) {
    if (tr.isError) {
      consecutiveErrors++;
      maxConsecutiveErrors = Math.max(maxConsecutiveErrors, consecutiveErrors);
    } else {
      // Also check for error-like content in non-error results
      if (tr.textContent && (tr.textContent.includes('"status":"error"') || tr.textContent.includes('ENOENT') || tr.textContent.includes('Error:'))) {
        consecutiveErrors++;
        maxConsecutiveErrors = Math.max(maxConsecutiveErrors, consecutiveErrors);
      } else {
        consecutiveErrors = 0;
      }
    }
  }

  if (maxConsecutiveErrors >= 3) {
    evidence.push(`${maxConsecutiveErrors} consecutive tool failures`);
    confidence += 0.3;
  }

  if (confidence > 0) {
    return { label: 'tool_failure_cascade', confidence: Math.min(confidence, 1), evidence };
  }
  return null;
}

function detectOverpoweredSimpleTask({ assistantMsgs, userMsgs, events, meta }) {
  const evidence = [];
  let confidence = 0;

  const totalMessages = assistantMsgs.length + userMsgs.length;
  const model = assistantMsgs[0]?.model;
  const tier = getModelTier(model);

  // Short session with an expensive model
  if (totalMessages <= 5 && tier === 'premium') {
    evidence.push(`Only ${totalMessages} messages but using premium model "${model}"`);
    confidence += 0.5;
  }

  // Low output tokens with high-tier model
  const totalOutput = assistantMsgs.reduce((sum, m) => sum + (m.usage?.output || 0), 0);
  if (totalOutput < 1000 && tier === 'premium') {
    evidence.push(`Only ${totalOutput} output tokens generated on premium model`);
    confidence += 0.3;
  }

  // Heartbeat on premium model — always overpowered
  const isHeartbeat = meta?.origin?.provider === 'heartbeat';
  if (isHeartbeat && (tier === 'premium' || tier === 'standard')) {
    evidence.push(`Heartbeat session using ${tier} model "${model}" — health checks don't need premium reasoning`);
    confidence += 0.6;
  }

  if (confidence > 0) {
    return { label: 'overpowered_simple_task', confidence: Math.min(confidence, 1), evidence };
  }
  return null;
}

function detectWeakModelForComplexStep({ assistantMsgs, toolResults }) {
  const evidence = [];
  let confidence = 0;

  const model = assistantMsgs[0]?.model;
  const tier = getModelTier(model);

  // Economy model with many retries
  if (tier === 'economy' && assistantMsgs.length > 15) {
    evidence.push(`${assistantMsgs.length} assistant turns using economy model "${model}" — may be too weak for task`);
    confidence += 0.4;
  }

  // Economy model with high error rate
  const errors = toolResults.filter(tr => tr.isError || (tr.textContent && tr.textContent.includes('"status":"error"')));
  if (tier === 'economy' && errors.length > 3) {
    evidence.push(`${errors.length} tool failures with economy model — suggests task needs a stronger model`);
    confidence += 0.3;
  }

  if (confidence > 0) {
    return { label: 'weak_model_for_complex_step', confidence: Math.min(confidence, 1), evidence };
  }
  return null;
}

function detectBadTaskDecomposition({ userMsgs, assistantMsgs, meta }) {
  const evidence = [];
  let confidence = 0;

  // Single huge user message driving many agent turns
  if (userMsgs.length === 1 && assistantMsgs.length > 10) {
    const inputSize = estimateTokensFromText(userMsgs[0]?.textContent || '');
    evidence.push(`Single user message (≈${inputSize} tokens) triggered ${assistantMsgs.length} agent turns — task may need decomposition`);
    confidence += 0.4;
  }

  // Very long user messages
  for (const msg of userMsgs) {
    const size = estimateTokensFromText(msg.textContent || '');
    if (size > 3000) {
      evidence.push(`User message with ≈${size} tokens — monolithic prompt`);
      confidence += 0.2;
    }
  }

  // Reduce confidence if this is a cron job, which naturally has one prompt driving the workflow
  const isCron = meta?.origin?.provider === 'cron' || 
                 userMsgs.some(m => m.textContent?.toLowerCase().includes('[cron:'));
  if (isCron) {
    confidence -= 0.5;
  }

  if (confidence > 0.3) {
    return { label: 'bad_task_decomposition', confidence: Math.min(confidence, 1), evidence };
  }
  return null;
}

function detectProviderRegression({ assistantMsgs }) {
  const evidence = [];
  let confidence = 0;

  if (assistantMsgs.length < 3) return null;

  // Check for sudden token spikes within the session
  const usages = assistantMsgs
    .filter(m => m.usage)
    .map(m => m.usage.totalTokens);

  if (usages.length < 3) return null;

  const avg = usages.reduce((a, b) => a + b, 0) / usages.length;
  const spikes = usages.filter(u => u > avg * 3);

  if (spikes.length > 0 && avg > 0) {
    evidence.push(`${spikes.length} token spike(s) exceeded 3x session average (avg: ${avg.toFixed(0)}, spike: ${Math.max(...spikes).toLocaleString()})`);
    confidence += 0.4;
  }

  // Check for model changes mid-session
  const models = [...new Set(assistantMsgs.map(m => m.model).filter(Boolean))];
  if (models.length > 1) {
    evidence.push(`Model changed mid-session: ${models.join(' → ')}`);
    confidence += 0.2;
  }

  if (confidence > 0) {
    return { label: 'possible_provider_regression', confidence: Math.min(confidence, 1), evidence };
  }
  return null;
}

function computeTriage(topLabel, meta, allLabels, events) {
  const label = topLabel.label;
  const cost = meta?.estimatedCostUsd || 0;
  const tokens = meta?.totalTokens || 0;
  const model = meta?.model || '';
  const hasEvents = events && events.length > 0;

  let actualCost = cost;
  if (hasEvents && actualCost === 0) {
    actualCost = estimateSessionCostFromEvents(events);
  }

  const economyModel = getEconomyAlternative(model);
  let modelSwitchCost = null;
  let compactedCost = null;

  if (hasEvents) {
    if (economyModel) modelSwitchCost = simulateModelSwitch(events, economyModel);
    compactedCost = simulateCompaction(events, 50000);
  }

  const remediations = [];

  // Helper to format savings string
  const fmtSavings = (amount, suffix = '/session') =>
    amount > 0.01 ? `~$${amount.toFixed(2)}${suffix}` : null;

  // ─── Context bloat / stale sessions ────────────────────

  if (label === 'context_bloat' || label === 'stale_scheduled_session') {
    const isRelay = allLabels.some(l => l.label === 'relay_workflow');
    const isCron = allLabels.some(l => l.label === 'scheduled_workflow' || l.label === 'stale_scheduled_session');

    remediations.push({
      title: isRelay ? 'Reset session after inactivity' : isCron ? 'Reset session between scheduled runs' : 'Reset or rotate long-lived sessions',
      why: 'This session has accumulated a large context that gets re-sent with every turn, driving up cost.',
      direction: isRelay
        ? 'Configure idle-based session reset so relay conversations automatically start fresh after a quiet period.'
        : isCron
        ? 'Configure daily or per-run session reset so cron jobs don\'t carry forward stale context.'
        : 'Ensure long-lived sessions are periodically reset or compacted to prevent unbounded context growth.',
      status: 'conceptual',
      confidence: 'high',
      savings: fmtSavings(actualCost * 0.7),
    });

    if (compactedCost != null && actualCost > 0) {
      const savings = actualCost - compactedCost;
      if (savings > 0.01) {
        remediations.push({
          title: 'Enable context compaction',
          why: 'Even without full session resets, compaction can summarize old history to keep context size bounded.',
          direction: 'Enable compaction with a reasonable token floor so the agent retains recent context while discarding old turns.',
          status: 'conceptual',
          confidence: 'high',
          savings: fmtSavings(savings),
        });
      }
    }

    const hasLargeToolResults = allLabels.some(l =>
      l.evidence?.some(e => e.includes('tool results exceeded'))
    );
    if (hasLargeToolResults) {
      remediations.push({
        title: 'Prune old tool results from context',
        why: 'Large tool results are being retained in context long after they\'re useful, inflating every subsequent turn.',
        direction: 'Enable context pruning so old tool results are trimmed or cleared after a TTL. This reduces context size without losing recent information.',
        status: 'conceptual',
        confidence: 'medium',
      });
    }

    if (economyModel && modelSwitchCost != null && actualCost > 0) {
      const savings = actualCost - modelSwitchCost;
      if (savings > 0.01) {
        remediations.push({
          title: `Use a cheaper model (e.g. ${economyModel})`,
          why: `This session uses "${model}" but the workload appears simple enough for an economy model.`,
          direction: `Route this session type to a cheaper model. "${economyModel}" would handle it at a fraction of the cost.`,
          status: 'conceptual',
          confidence: isRelay ? 'high' : 'medium',
          savings: fmtSavings(savings),
        });
      }
    }

    return {
      priority: 'high',
      suggestedNextStep: 'inspect',
      whyFlagged: label === 'stale_scheduled_session'
        ? 'stale cron session — context keeps growing between runs'
        : 'context keeps growing — each turn re-sends old tokens',
      remediations,
    };
  }

  // ─── Relay workflow (no bloat) ─────────────────────────

  if (label === 'relay_workflow') {
    if (economyModel && modelSwitchCost != null && actualCost > 0) {
      const savings = actualCost - modelSwitchCost;
      if (savings > 0.01) {
        remediations.push({
          title: `Use a cheaper model for relay (e.g. ${economyModel})`,
          why: 'Message relay rarely needs premium reasoning. The model is doing simple forwarding work.',
          direction: 'Route relay sessions to an economy model. This is the simplest cost reduction for this session type.',
          status: 'conceptual',
          confidence: 'high',
          savings: fmtSavings(savings),
        });
      }
    }

    remediations.push({
      title: 'Prevent context growth over time',
      why: 'Long relay conversations accumulate context. Each new message re-sends everything that came before.',
      direction: 'Configure idle-based session reset so relay sessions start fresh after a quiet period, preventing gradual context bloat.',
      status: 'conceptual',
      confidence: 'medium',
    });

    return {
      priority: 'low',
      suggestedNextStep: remediations.some(r => r.savings) ? 'review remediations' : 'ignore',
      whyFlagged: 'message relay — cost is expected but can be reduced',
      remediations,
    };
  }

  // ─── Scheduled workflow (healthy) ──────────────────────

  if (label === 'scheduled_workflow') {
    return {
      priority: 'low',
      suggestedNextStep: 'ignore',
      whyFlagged: 'cron session — expected recurring cost',
      remediations: [{
        title: 'Watch for context growth',
        why: 'This cron session is healthy now, but long-running cron sessions tend to accumulate context over time.',
        direction: 'Consider enabling daily session reset as a preventive measure so cron sessions always start with a clean context.',
        status: 'conceptual',
        confidence: 'low',
      }],
    };
  }

  // ─── Looping / retry churn ─────────────────────────────

  if (label === 'looping_or_indecision' || label === 'retry_churn') {
    remediations.push({
      title: 'Limit runaway turn counts',
      why: label === 'retry_churn'
        ? 'The agent is retrying identical tool calls, burning tokens without making progress.'
        : 'The agent is producing many turns without clear forward progress, likely stuck in a loop.',
      direction: 'Cap agent-to-agent turn limits and add compaction as a safety net. Investigate the root cause — the agent may need a clearer prompt or better error handling.',
      status: 'conceptual',
      confidence: 'high',
      savings: fmtSavings(actualCost * 0.5, ' wasted on loops'),
    });

    return {
      priority: 'high',
      suggestedNextStep: 'inspect',
      whyFlagged: label === 'retry_churn'
        ? 'identical tool calls being retried — burning tokens'
        : 'agent is looping without progress',
      remediations,
    };
  }

  // ─── Tool failure cascade ──────────────────────────────

  if (label === 'tool_failure_cascade') {
    remediations.push({
      title: 'Fix the failing tools',
      why: 'The agent keeps retrying broken tool calls. Each retry burns tokens on the full context re-send.',
      direction: 'Investigate which tools are failing and fix the root cause. If a tool is intermittently broken, consider disabling it temporarily.',
      status: 'conceptual',
      confidence: 'high',
      savings: fmtSavings(actualCost * 0.3, ' wasted on failures'),
    });

    return {
      priority: 'high',
      suggestedNextStep: 'inspect',
      whyFlagged: 'tool errors cascading — agent keeps trying and failing',
      remediations,
    };
  }

  // ─── Overpowered simple task ───────────────────────────

  if (label === 'overpowered_simple_task') {
    const isHeartbeat = meta?.origin?.provider === 'heartbeat';

    if (economyModel && modelSwitchCost != null && actualCost > 0) {
      remediations.push({
        title: `Use a cheaper model (e.g. ${economyModel})`,
        why: isHeartbeat
          ? `Heartbeat health checks are running on "${model}" which is expensive for a simple status check.`
          : `This session used "${model}" for a simple task with minimal output.`,
        direction: isHeartbeat
          ? 'Route heartbeat sessions to an economy model. If your platform supports a heartbeat-specific model override, use that.'
          : `Route this session type to an economy model like "${economyModel}".`,
        status: 'conceptual',
        confidence: 'high',
        savings: fmtSavings(actualCost - modelSwitchCost, '/run'),
      });
    }

    if (isHeartbeat) {
      remediations.push({
        title: 'Use lightweight context for heartbeats',
        why: 'Heartbeats may be loading full agent context unnecessarily, inflating input tokens.',
        direction: 'If your platform supports it, enable a "light context" mode for heartbeat runs that loads only essential bootstrap files.',
        status: 'conceptual',
        confidence: 'medium',
      });
    }

    return {
      priority: 'medium',
      suggestedNextStep: 'inspect',
      whyFlagged: isHeartbeat ? `heartbeat using expensive model "${model}"` : `premium model "${model}" on a simple task`,
      remediations,
    };
  }

  // ─── Weak model for complex step ───────────────────────

  if (label === 'weak_model_for_complex_step') {
    remediations.push({
      title: 'Upgrade to a stronger model',
      why: `The economy model "${model}" is generating excessive turns, suggesting the task is too complex for it.`,
      direction: 'Route this session type to a standard or premium model. A stronger model would likely complete the task in fewer turns, potentially at lower total cost.',
      status: 'conceptual',
      confidence: 'medium',
    });

    return {
      priority: 'medium',
      suggestedNextStep: 'inspect',
      whyFlagged: `economy model "${model}" struggling — too many turns`,
      remediations,
    };
  }

  // ─── Bad task decomposition ────────────────────────────

  if (label === 'bad_task_decomposition') {
    remediations.push({
      title: 'Break into smaller sub-tasks',
      why: 'A single monolithic prompt is driving many agent turns. The context grows with each turn, compounding cost.',
      direction: 'Split the work into smaller, focused prompts. Each sub-task gets a fresh context, avoiding the cost of re-sending accumulated history.',
      status: 'conceptual',
      confidence: 'high',
      savings: fmtSavings(actualCost * 0.3, ' by reducing context re-sends'),
    });

    remediations.push({
      title: 'Lower the context budget',
      why: 'A smaller context budget forces the agent to work more efficiently and triggers compaction sooner.',
      direction: 'Reduce the effective context token limit for this agent or session type.',
      status: 'conceptual',
      confidence: 'medium',
    });

    return {
      priority: 'medium',
      suggestedNextStep: 'inspect',
      whyFlagged: 'monolithic prompt causing long agent runs',
      remediations,
    };
  }

  // ─── Provider regression ───────────────────────────────

  if (label === 'possible_provider_regression') {
    return {
      priority: 'medium',
      suggestedNextStep: 'inspect',
      whyFlagged: 'abnormal token spike — possible provider issue',
      remediations: [{
        title: 'Investigate the token spike',
        why: 'A sudden increase in token usage may indicate a model update that changed output verbosity, or an unexpected change in input size.',
        direction: 'Compare recent runs with historical averages. Check if the model provider released an update around the time of the spike.',
        status: 'conceptual',
        confidence: 'medium',
      }],
    };
  }

  // ─── Fallback: high or medium usage ────────────────────

  if (tokens > 50000) {
    if (economyModel && modelSwitchCost != null && actualCost > 0) {
      remediations.push({
        title: `Consider a cheaper model (e.g. ${economyModel})`,
        why: `High token usage with "${model}". If this session type doesn't need premium reasoning, a cheaper model would reduce cost.`,
        direction: `Evaluate whether this session type can use "${economyModel}" without quality loss.`,
        status: 'conceptual',
        confidence: 'medium',
        savings: fmtSavings(actualCost - modelSwitchCost),
      });
    }

    return {
      priority: 'high',
      suggestedNextStep: 'inspect',
      whyFlagged: 'high token usage with no clear pattern',
      remediations,
    };
  }

  if (tokens >= 10000) {
    return {
      priority: 'medium',
      suggestedNextStep: 'inspect',
      whyFlagged: 'non-trivial usage — worth reviewing',
      remediations: [],
    };
  }

  return {
    priority: 'low',
    suggestedNextStep: 'ignore',
    whyFlagged: 'low cost, no issues detected',
    remediations: [],
  };
}
