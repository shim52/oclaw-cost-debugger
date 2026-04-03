/**
 * Per-model pricing table (per million tokens).
 * Costs in USD. Updated for 2026 pricing estimates.
 */
const MODEL_PRICING = {
  // OpenAI
  'gpt-4':           { input: 30.00, output: 60.00, cacheRead: 15.00 },
  'gpt-4-turbo':     { input: 10.00, output: 30.00, cacheRead: 5.00 },
  'gpt-4o':          { input: 2.50,  output: 10.00, cacheRead: 1.25 },
  'gpt-4o-mini':     { input: 0.15,  output: 0.60,  cacheRead: 0.075 },
  'gpt-5':           { input: 5.00,  output: 20.00, cacheRead: 2.50 },
  'gpt-5-mini':      { input: 0.30,  output: 1.20,  cacheRead: 0.15 },
  'o1':              { input: 15.00, output: 60.00, cacheRead: 7.50 },
  'o1-mini':         { input: 3.00,  output: 12.00, cacheRead: 1.50 },
  'o3':              { input: 10.00, output: 40.00, cacheRead: 5.00 },
  'o3-mini':         { input: 1.10,  output: 4.40,  cacheRead: 0.55 },
  'o4-mini':         { input: 1.10,  output: 4.40,  cacheRead: 0.55 },

  // Anthropic
  'claude-3-opus':         { input: 15.00, output: 75.00, cacheRead: 7.50 },
  'claude-3.5-sonnet':     { input: 3.00,  output: 15.00, cacheRead: 1.50 },
  'claude-3.5-haiku':      { input: 0.80,  output: 4.00,  cacheRead: 0.40 },
  'claude-3.7-sonnet':     { input: 3.00,  output: 15.00, cacheRead: 1.50 },
  'claude-4-sonnet':       { input: 3.00,  output: 15.00, cacheRead: 1.50 },
  'claude-4-opus':         { input: 15.00, output: 75.00, cacheRead: 7.50 },

  // Google
  'gemini-2.0-flash':      { input: 0.10,  output: 0.40,  cacheRead: 0.025 },
  'gemini-2.5-pro':        { input: 1.25,  output: 10.00, cacheRead: 0.315 },
  'gemini-2.5-flash':      { input: 0.15,  output: 0.60,  cacheRead: 0.0375 },

  // DeepSeek
  'deepseek-chat':         { input: 0.27,  output: 1.10,  cacheRead: 0.07 },
  'deepseek-reasoner':     { input: 0.55,  output: 2.19,  cacheRead: 0.14 },

  // Fallback
  '_default':              { input: 2.00,  output: 8.00,  cacheRead: 1.00 },
};

/**
 * Find pricing for a model ID.
 * Fuzzy-matches: "gpt-5-mini" matches "gpt-5-mini", "claude-3.5-sonnet-20240620" matches "claude-3.5-sonnet".
 */
function getPricing(modelId) {
  if (!modelId) return MODEL_PRICING['_default'];

  const lower = modelId.toLowerCase();

  // Exact match
  if (MODEL_PRICING[lower]) return MODEL_PRICING[lower];

  // Prefix match (longest first)
  const keys = Object.keys(MODEL_PRICING)
    .filter(k => k !== '_default')
    .sort((a, b) => b.length - a.length);

  for (const key of keys) {
    if (lower.startsWith(key) || lower.includes(key)) {
      return MODEL_PRICING[key];
    }
  }

  return MODEL_PRICING['_default'];
}

/**
 * Estimate cost for a single assistant message's usage.
 */
export function estimateMessageCost(usage, modelId) {
  if (!usage) return 0;
  const pricing = getPricing(modelId);

  const inputCost = (usage.input / 1_000_000) * pricing.input;
  const outputCost = (usage.output / 1_000_000) * pricing.output;
  const cacheReadCost = (usage.cacheRead / 1_000_000) * pricing.cacheRead;

  return inputCost + outputCost + cacheReadCost;
}

/**
 * Estimate total cost from session metadata (tokens from sessions.json).
 * Prefers estimatedCostUsd from provider when available.
 */
export function estimateSessionCostFromMeta(meta) {
  if (meta.estimatedCostUsd != null && meta.estimatedCostUsd > 0) {
    return meta.estimatedCostUsd;
  }
  const pricing = getPricing(meta.model);
  const inputCost = (meta.inputTokens / 1_000_000) * pricing.input;
  const outputCost = (meta.outputTokens / 1_000_000) * pricing.output;
  const cacheReadCost = ((meta.cacheRead || 0) / 1_000_000) * pricing.cacheRead;
  return inputCost + outputCost + cacheReadCost;
}

/**
 * Estimate total cost from parsed transcript events.
 */
export function estimateSessionCostFromEvents(events) {
  let total = 0;
  for (const evt of events) {
    if (evt.type === 'message' && evt.role === 'assistant' && evt.usage) {
      total += estimateMessageCost(evt.usage, evt.model);
    }
  }
  return total;
}

/**
 * Rough token estimation from text (chars/4 heuristic).
 */
export function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Get the tier label for a model.
 */
export function getModelTier(modelId) {
  if (!modelId) return 'unknown';
  const lower = modelId.toLowerCase();

  if (lower.includes('opus') || lower === 'gpt-4' || lower === 'gpt-5' || lower.includes('o1') && !lower.includes('mini'))
    return 'premium';
  if (lower.includes('mini') || lower.includes('flash') || lower.includes('haiku'))
    return 'economy';
  return 'standard';
}

/**
 * Simulate session cost with a different model.
 * Recomputes cost using the same token counts but alternate model pricing.
 */
export function simulateModelSwitch(events, targetModelId) {
  let total = 0;
  for (const evt of events) {
    if (evt.type === 'message' && evt.role === 'assistant' && evt.usage) {
      total += estimateMessageCost(evt.usage, targetModelId);
    }
  }
  return total;
}

/**
 * Simulate session cost with a context cap (compaction).
 * Models what happens if context is reset when it exceeds a threshold.
 * Returns estimated cost with compaction applied.
 */
export function simulateCompaction(events, thresholdTokens) {
  let total = 0;
  let runningContext = 0;

  for (const evt of events) {
    if (evt.type === 'message' && evt.role === 'assistant' && evt.usage) {
      const usage = evt.usage;
      const contextSize = usage.input + usage.cacheRead;

      // If context exceeds threshold, simulate a reset
      if (contextSize > thresholdTokens && runningContext > thresholdTokens) {
        // After compaction, input is reduced to roughly the threshold
        const ratio = thresholdTokens / contextSize;
        const cappedUsage = {
          input: Math.round(usage.input * ratio),
          output: usage.output,
          cacheRead: Math.round(usage.cacheRead * ratio),
        };
        total += estimateMessageCost(cappedUsage, evt.model);
        runningContext = thresholdTokens;
      } else {
        total += estimateMessageCost(usage, evt.model);
        runningContext = contextSize;
      }
    }
  }
  return total;
}

/**
 * Get the cheapest economy model alternative for a given model.
 */
export function getEconomyAlternative(modelId) {
  if (!modelId) return null;
  const lower = modelId.toLowerCase();

  if (lower.includes('gpt-5') && !lower.includes('mini')) return 'gpt-5-mini';
  if (lower.includes('gpt-4o') && !lower.includes('mini')) return 'gpt-4o-mini';
  if (lower.includes('gpt-4') && !lower.includes('mini')) return 'gpt-4o-mini';
  if (lower.includes('claude') && lower.includes('opus')) return 'claude-3.5-haiku';
  if (lower.includes('claude') && lower.includes('sonnet')) return 'claude-3.5-haiku';
  if (lower.includes('gemini') && lower.includes('pro')) return 'gemini-2.5-flash';
  if (lower.includes('o1') && !lower.includes('mini')) return 'o1-mini';
  if (lower.includes('o3') && !lower.includes('mini')) return 'o3-mini';

  return null;
}

export { MODEL_PRICING, getPricing };
