import { readFile } from 'node:fs/promises';

/**
 * Parse a JSONL transcript file into structured events.
 * Handles malformed lines gracefully (skips with warning).
 * @param {string} filePath
 * @returns {Promise<Array<TranscriptEvent>>}
 */
export async function parseTranscript(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const events = [];
  const warnings = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      const event = normalizeEvent(obj);
      if (event) events.push(event);
    } catch {
      warnings.push(`Line ${i + 1}: malformed JSON, skipped`);
    }
  }

  return { events, warnings };
}

/**
 * Normalize a raw JSONL object into a structured event.
 */
function normalizeEvent(obj) {
  const base = {
    type: obj.type,
    id: obj.id,
    parentId: obj.parentId || null,
    timestamp: obj.timestamp ? new Date(obj.timestamp) : null,
  };

  switch (obj.type) {
    case 'session':
      return { ...base, version: obj.version, cwd: obj.cwd };

    case 'model_change':
      return { ...base, provider: obj.provider, modelId: obj.modelId };

    case 'thinking_level_change':
      return { ...base, thinkingLevel: obj.thinkingLevel };

    case 'custom':
      return { ...base, customType: obj.customType, data: obj.data };

    case 'message':
      return normalizeMessage(base, obj.message);

    case 'summary':
      return { ...base, summary: obj.summary };

    default:
      return { ...base, raw: obj };
  }
}

/**
 * Normalize a message event (user, assistant, toolResult).
 */
function normalizeMessage(base, msg) {
  if (!msg) return { ...base, role: 'unknown', content: [] };

  const role = msg.role;
  const content = msg.content || [];

  const event = {
    ...base,
    role,
    content,
    messageTimestamp: msg.timestamp ? new Date(msg.timestamp) : null,
  };

  // Extract tool calls from assistant messages
  if (role === 'assistant') {
    event.toolCalls = content
      .filter(c => c.type === 'toolCall')
      .map(c => ({
        id: c.id,
        name: c.name,
        arguments: c.arguments,
      }));

    event.textContent = content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    // Extract usage/cost info
    if (msg.usage) {
      event.usage = {
        input: msg.usage.input || 0,
        output: msg.usage.output || 0,
        cacheRead: msg.usage.cacheRead || 0,
        cacheWrite: msg.usage.cacheWrite || 0,
        totalTokens: msg.usage.totalTokens || 0,
        cost: msg.usage.cost || null,
      };
    }

    event.model = msg.model || null;
    event.provider = msg.provider || null;
    event.stopReason = msg.stopReason || null;
  }

  // Extract tool result info
  if (role === 'toolResult') {
    event.toolCallId = msg.toolCallId;
    event.toolName = msg.toolName;
    event.isError = msg.isError || false;
    event.textContent = content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }

  // User messages
  if (role === 'user') {
    event.textContent = content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }

  return event;
}

/**
 * Extract message-type events from parsed transcript.
 */
export function getMessages(events) {
  return events.filter(e => e.type === 'message');
}

/**
 * Get assistant messages only.
 */
export function getAssistantMessages(events) {
  return events.filter(e => e.type === 'message' && e.role === 'assistant');
}

/**
 * Get tool result events.
 */
export function getToolResults(events) {
  return events.filter(e => e.type === 'message' && e.role === 'toolResult');
}

/**
 * Get user messages.
 */
export function getUserMessages(events) {
  return events.filter(e => e.type === 'message' && e.role === 'user');
}

/**
 * Compute total usage from all assistant messages.
 */
export function computeTotalUsage(events) {
  const assistantMsgs = getAssistantMessages(events);
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

  for (const msg of assistantMsgs) {
    if (msg.usage) {
      totals.input += msg.usage.input;
      totals.output += msg.usage.output;
      totals.cacheRead += msg.usage.cacheRead;
      totals.cacheWrite += msg.usage.cacheWrite;
      totals.totalTokens += msg.usage.totalTokens;
    }
  }

  return totals;
}
