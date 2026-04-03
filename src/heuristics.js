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
  const isCron = provider === 'cron' || 
                 userMsgs.some(m => m.textContent?.toLowerCase().includes('[cron:'));
                 
  if (isCron) {
    confidence += 0.8;
    evidence.push(`Session origin identified as a scheduled/cron-bound workflow`);
    
    // Check if it's getting stale/bloated
    const totalTokens = events.reduce((sum, e) => sum + (e?.message?.usage?.totalTokens || 0), 0);
    // If context is huge or there are many turns over a long time
    if (totalTokens > 50000 || events.length > 30) {
      evidence.push(`Scheduled session has accumulated massive context (${totalTokens.toLocaleString()} tokens or >30 events) and may be growing stale`);
      return { label: 'stale_scheduled_session', confidence: 0.95, evidence };
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

  // Compute simulated costs when we have events
  let actualCost = cost;
  if (hasEvents && actualCost === 0) {
    actualCost = estimateSessionCostFromEvents(events);
  }

  const economyModel = getEconomyAlternative(model);
  let modelSwitchCost = null;
  let compactedCost = null;

  if (hasEvents) {
    if (economyModel) {
      modelSwitchCost = simulateModelSwitch(events, economyModel);
    }
    compactedCost = simulateCompaction(events, 50000);
  }

  const fixes = [];

  // ─── Context bloat / stale sessions ────────────────────

  if (label === 'context_bloat' || label === 'stale_scheduled_session') {
    const isRelay = allLabels.some(l => l.label === 'relay_workflow');
    const isCron = allLabels.some(l => l.label === 'scheduled_workflow' || l.label === 'stale_scheduled_session');

    // Fix 1: Session reset
    if (isRelay) {
      fixes.push({
        title: 'Enable idle session reset',
        description: 'Automatically reset the session after a period of inactivity, clearing accumulated context.',
        savings: actualCost > 0 ? `~$${(actualCost * 0.7).toFixed(2)}/session` : null,
        config: `// openclaw.config.json5\n{\n  session: {\n    reset: {\n      mode: "idle",\n      idleMinutes: 30\n    }\n  }\n}`,
        docs: 'session.reset.mode, session.reset.idleMinutes',
      });
    } else if (isCron) {
      fixes.push({
        title: 'Reset session between cron runs',
        description: 'Use daily reset so each cron invocation starts fresh instead of accumulating context.',
        savings: actualCost > 0 ? `~$${(actualCost * 0.7).toFixed(2)}/run` : null,
        config: `// openclaw.config.json5\n{\n  session: {\n    reset: {\n      mode: "daily",\n      atHour: 4   // reset at 4am before morning cron\n    }\n  }\n}`,
        docs: 'session.reset.mode, session.reset.atHour',
      });
    }

    // Fix 2: Compaction
    if (compactedCost != null && actualCost > 0) {
      const savings = actualCost - compactedCost;
      if (savings > 0.01) {
        fixes.push({
          title: 'Enable context compaction',
          description: 'Automatically summarize old conversation history when context exceeds a threshold, keeping recent messages intact.',
          savings: `~$${savings.toFixed(2)}/session`,
          config: `// openclaw.config.json5\n{\n  agents: {\n    defaults: {\n      compaction: {\n        mode: "safeguard",\n        reserveTokensFloor: 24000,\n        memoryFlush: { enabled: true }\n      }\n    }\n  }\n}`,
          docs: 'agents.defaults.compaction.mode, agents.defaults.compaction.reserveTokensFloor',
        });
      }
    }

    // Fix 3: Context pruning for large tool results
    const hasLargeToolResults = allLabels.some(l =>
      l.evidence?.some(e => e.includes('tool results exceeded'))
    );
    if (hasLargeToolResults) {
      fixes.push({
        title: 'Enable context pruning for tool results',
        description: 'Automatically trim or clear old tool results that bloat the context window.',
        savings: null,
        config: `// openclaw.config.json5\n{\n  agents: {\n    defaults: {\n      contextPruning: {\n        mode: "cache-ttl",\n        ttl: "30m",\n        softTrim: { maxChars: 4000 },\n        hardClear: { enabled: true }\n      }\n    }\n  }\n}`,
        docs: 'agents.defaults.contextPruning.mode, agents.defaults.contextPruning.ttl',
      });
    }

    // Fix 4: Cheaper model
    if (economyModel && modelSwitchCost != null && actualCost > 0) {
      const savings = actualCost - modelSwitchCost;
      if (savings > 0.01) {
        fixes.push({
          title: `Switch to ${economyModel}`,
          description: `Relay and simple tasks rarely need a premium model. "${economyModel}" handles them at a fraction of the cost.`,
          savings: `~$${savings.toFixed(2)}/session`,
          config: `// openclaw.config.json5\n{\n  agents: {\n    defaults: {\n      model: {\n        primary: "openai/${economyModel}"\n      }\n    }\n  }\n}`,
          docs: 'agents.defaults.model.primary',
        });
      }
    }

    // Combined savings
    let combinedSavings = null;
    if (compactedCost != null && economyModel && actualCost > 0) {
      const compactedOnCheap = hasEvents ? simulateCompaction(events, 50000) : null;
      const cheapCompacted = compactedOnCheap != null
        ? simulateModelSwitch(events, economyModel) * (compactedCost / Math.max(actualCost, 0.001))
        : null;
      if (cheapCompacted != null && cheapCompacted < actualCost) {
        combinedSavings = `~$${(actualCost - cheapCompacted).toFixed(2)}/session (compaction + model switch)`;
      }
    }

    return {
      priority: 'high',
      suggestedNextStep: 'inspect',
      whyFlagged: label === 'stale_scheduled_session'
        ? 'stale cron session — context keeps growing between runs'
        : 'context keeps growing — each turn re-sends old tokens',
      fixes,
      combinedSavings,
    };
  }

  // ─── Relay workflow (no bloat) ─────────────────────────

  if (label === 'relay_workflow') {
    if (economyModel && modelSwitchCost != null && actualCost > 0) {
      const savings = actualCost - modelSwitchCost;
      if (savings > 0.01) {
        fixes.push({
          title: `Use ${economyModel} for relay sessions`,
          description: 'Message relay rarely needs a premium model. A cheaper model handles forwarding just as well.',
          savings: `~$${savings.toFixed(2)}/session`,
          config: `// openclaw.config.json5\n{\n  agents: {\n    defaults: {\n      model: {\n        primary: "openai/${economyModel}"\n      }\n    }\n  }\n}`,
          docs: 'agents.defaults.model.primary',
        });
      }
    }

    fixes.push({
      title: 'Enable idle session reset',
      description: 'Prevent context from growing over long relay conversations.',
      savings: null,
      config: `// openclaw.config.json5\n{\n  session: {\n    reset: {\n      mode: "idle",\n      idleMinutes: 60\n    }\n  }\n}`,
      docs: 'session.reset.mode, session.reset.idleMinutes',
    });

    return {
      priority: fixes.some(f => f.savings) ? 'low' : 'low',
      suggestedNextStep: fixes.some(f => f.savings) ? 'review fixes' : 'ignore',
      whyFlagged: 'message relay — cost is expected but can be reduced',
      fixes,
    };
  }

  // ─── Scheduled workflow (healthy) ──────────────────────

  if (label === 'scheduled_workflow') {
    return {
      priority: 'low',
      suggestedNextStep: 'ignore',
      whyFlagged: 'cron session — expected recurring cost',
      fixes: [{
        title: 'Monitor for context growth',
        description: 'This cron session is healthy now, but long-running cron sessions tend to accumulate context over time.',
        savings: null,
        config: `// openclaw.config.json5 (preventive)\n{\n  session: {\n    reset: {\n      mode: "daily",\n      atHour: 4\n    }\n  }\n}`,
        docs: 'session.reset.mode',
      }],
    };
  }

  // ─── Looping / retry churn ─────────────────────────────

  if (label === 'looping_or_indecision' || label === 'retry_churn') {
    fixes.push({
      title: 'Limit agent-to-agent ping-pong',
      description: 'Cap the maximum back-and-forth turns between agents to prevent runaway loops.',
      savings: actualCost > 0 ? `~$${(actualCost * 0.5).toFixed(2)} wasted on loops` : null,
      config: `// openclaw.config.json5\n{\n  session: {\n    agentToAgent: {\n      maxPingPongTurns: 3\n    }\n  }\n}`,
      docs: 'session.agentToAgent.maxPingPongTurns',
    });

    fixes.push({
      title: 'Enable compaction to limit damage',
      description: 'Even if the agent loops, compaction prevents the context from growing unbounded.',
      savings: null,
      config: `// openclaw.config.json5\n{\n  agents: {\n    defaults: {\n      compaction: {\n        mode: "safeguard",\n        reserveTokensFloor: 24000\n      }\n    }\n  }\n}`,
      docs: 'agents.defaults.compaction.mode',
    });

    return {
      priority: 'high',
      suggestedNextStep: 'inspect',
      whyFlagged: label === 'retry_churn'
        ? 'identical tool calls being retried — burning tokens'
        : 'agent is looping without progress',
      fixes,
    };
  }

  // ─── Tool failure cascade ──────────────────────────────

  if (label === 'tool_failure_cascade') {
    fixes.push({
      title: 'Fix the failing tools',
      description: 'The agent keeps retrying broken tool calls. Fix the root cause or disable the broken tool.',
      savings: actualCost > 0 ? `~$${(actualCost * 0.3).toFixed(2)} wasted on failures` : null,
      config: null,
      docs: null,
    });

    return {
      priority: 'high',
      suggestedNextStep: 'inspect',
      whyFlagged: 'tool errors cascading — agent keeps trying and failing',
      fixes,
    };
  }

  // ─── Overpowered simple task ───────────────────────────

  if (label === 'overpowered_simple_task') {
    if (economyModel && modelSwitchCost != null && actualCost > 0) {
      fixes.push({
        title: `Switch to ${economyModel}`,
        description: `This session used only a few messages. "${economyModel}" would handle it at a fraction of the cost.`,
        savings: `~$${(actualCost - modelSwitchCost).toFixed(2)}/run`,
        config: `// openclaw.config.json5\n{\n  agents: {\n    defaults: {\n      model: {\n        primary: "openai/${economyModel}"\n      }\n    }\n  }\n}`,
        docs: 'agents.defaults.model.primary',
      });
    }

    // Suggest heartbeat-specific config if it's a heartbeat
    const isHeartbeat = meta?.origin?.provider === 'heartbeat';
    if (isHeartbeat) {
      fixes.push({
        title: 'Use a dedicated heartbeat model',
        description: 'Override the model specifically for heartbeat runs to avoid paying premium prices for health checks.',
        savings: null,
        config: `// openclaw.config.json5\n{\n  agents: {\n    defaults: {\n      heartbeat: {\n        model: "openai/${economyModel || 'gpt-5-mini'}",\n        lightContext: true\n      }\n    }\n  }\n}`,
        docs: 'agents.defaults.heartbeat.model, agents.defaults.heartbeat.lightContext',
      });
    }

    return {
      priority: 'medium',
      suggestedNextStep: 'inspect',
      whyFlagged: `premium model "${model}" on a simple task`,
      fixes,
    };
  }

  // ─── Weak model for complex step ───────────────────────

  if (label === 'weak_model_for_complex_step') {
    fixes.push({
      title: 'Upgrade model for complex tasks',
      description: 'The economy model is generating excessive turns. A stronger model would complete the task in fewer turns, potentially at lower total cost.',
      savings: null,
      config: `// openclaw.config.json5\n{\n  agents: {\n    defaults: {\n      model: {\n        primary: "openai/gpt-5",\n        fallbacks: ["openai/${model}"]\n      }\n    }\n  }\n}`,
      docs: 'agents.defaults.model.primary, agents.defaults.model.fallbacks',
    });

    return {
      priority: 'medium',
      suggestedNextStep: 'inspect',
      whyFlagged: `economy model "${model}" struggling — too many turns`,
      fixes,
    };
  }

  // ─── Bad task decomposition ────────────────────────────

  if (label === 'bad_task_decomposition') {
    fixes.push({
      title: 'Break into sub-tasks',
      description: 'A single monolithic prompt is driving many agent turns. Split into smaller prompts that each get a fresh context.',
      savings: actualCost > 0 ? `~$${(actualCost * 0.3).toFixed(2)} by reducing context re-sends` : null,
      config: null,
      docs: null,
    });

    fixes.push({
      title: 'Lower the context budget',
      description: 'Force the agent to work within a smaller context window, which naturally limits cost per turn.',
      savings: null,
      config: `// openclaw.config.json5\n{\n  agents: {\n    defaults: {\n      model: {\n        contextTokens: 100000\n      }\n    }\n  }\n}`,
      docs: 'agents.defaults.model.contextTokens',
    });

    return {
      priority: 'medium',
      suggestedNextStep: 'inspect',
      whyFlagged: 'monolithic prompt causing long agent runs',
      fixes,
    };
  }

  // ─── Provider regression ───────────────────────────────

  if (label === 'possible_provider_regression') {
    return {
      priority: 'medium',
      suggestedNextStep: 'inspect',
      whyFlagged: 'abnormal token spike — possible provider issue',
      fixes: [{
        title: 'Check provider changelog',
        description: 'A sudden token spike may indicate a model update that changed output verbosity. Compare recent runs with historical averages.',
        savings: null,
        config: null,
        docs: null,
      }],
    };
  }

  // ─── Fallback: high or medium usage ────────────────────

  if (tokens > 50000) {
    if (economyModel && modelSwitchCost != null && actualCost > 0) {
      fixes.push({
        title: `Consider ${economyModel}`,
        description: 'If this session type doesn\'t need premium reasoning, switching models would reduce cost.',
        savings: `~$${(actualCost - modelSwitchCost).toFixed(2)}/session`,
        config: `// openclaw.config.json5\n{\n  agents: {\n    defaults: {\n      model: {\n        primary: "openai/${economyModel}"\n      }\n    }\n  }\n}`,
        docs: 'agents.defaults.model.primary',
      });
    }

    return {
      priority: 'high',
      suggestedNextStep: 'inspect',
      whyFlagged: 'high token usage with no clear pattern',
      fixes,
    };
  }

  if (tokens >= 10000) {
    return {
      priority: 'medium',
      suggestedNextStep: 'inspect',
      whyFlagged: 'non-trivial usage — worth reviewing',
      fixes: [],
    };
  }

  return {
    priority: 'low',
    suggestedNextStep: 'ignore',
    whyFlagged: 'low cost, no issues detected',
    fixes: [],
  };
}
