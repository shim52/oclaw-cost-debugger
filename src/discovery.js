import { readdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { glob } from 'glob';

const DEFAULT_OPENCLAW_DIR = join(homedir(), '.openclaw', 'agents');

/**
 * Discover all OpenClaw sessions from the filesystem.
 * @param {string} [customPath] — explicit path override
 * @returns {Promise<Array<{agentId: string, sessionKey: string, sessionId: string, meta: object}>>}
 */
export async function discoverSessions(customPath) {
  const sessionsMap = new Map();

  if (customPath) {
    await loadFromPath(customPath, sessionsMap);
  } else {
    await loadFromDefaultPath(sessionsMap);
  }

  return [...sessionsMap.values()];
}

/**
 * Load sessions from an explicit path.
 * The path may be:
 * - A directory containing sessions.json + .jsonl files
 * - A directory of agent dirs (each with sessions/)
 * - A single sessions.json file
 */
async function loadFromPath(inputPath, sessionsMap) {
  const s = await stat(inputPath).catch(() => null);
  if (!s) return;

  if (s.isFile() && inputPath.endsWith('.json')) {
    const dir = join(inputPath, '..');
    await loadSessionsJson(inputPath, dir, 'unknown', sessionsMap);
    await discoverOrphanJsonl(dir, sessionsMap);
    return;
  }

  if (s.isDirectory()) {
    const directJson = join(inputPath, 'sessions.json');
    const djStat = await stat(directJson).catch(() => null);
    if (djStat) {
      await loadSessionsJson(directJson, inputPath, basename(join(inputPath, '..')), sessionsMap);
      await discoverOrphanJsonl(inputPath, sessionsMap);
      return;
    }

    // Check if it's an agents-level dir (has subdirs with sessions/)
    const entries = await readdir(inputPath, { withFileTypes: true });
    let foundSubdirs = false;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sessDir = join(inputPath, entry.name, 'sessions');
        const sjPath = join(sessDir, 'sessions.json');
        const sjStat = await stat(sjPath).catch(() => null);
        if (sjStat) {
          await loadSessionsJson(sjPath, sessDir, entry.name, sessionsMap);
          await discoverOrphanJsonl(sessDir, sessionsMap);
          foundSubdirs = true;
        }
      }
    }

    // If no subdirs found, try discovering orphan .jsonl files directly
    if (!foundSubdirs) {
      await discoverOrphanJsonl(inputPath, sessionsMap);
    }
  }
}

/**
 * Load from the default ~/.openclaw/agents/ path
 */
async function loadFromDefaultPath(sessionsMap) {
  const agentsDir = DEFAULT_OPENCLAW_DIR;
  const s = await stat(agentsDir).catch(() => null);
  if (!s) return;

  const entries = await readdir(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sessDir = join(agentsDir, entry.name, 'sessions');
      const sjPath = join(sessDir, 'sessions.json');
      const sjStat = await stat(sjPath).catch(() => null);
      if (sjStat) {
        await loadSessionsJson(sjPath, sessDir, entry.name, sessionsMap);
        await discoverOrphanJsonl(sessDir, sessionsMap);
      }
    }
  }
}

/**
 * Parse a sessions.json file and register sessions.
 */
async function loadSessionsJson(jsonPath, sessionsDir, agentId, sessionsMap) {
  try {
    const raw = await readFile(jsonPath, 'utf-8');
    const data = JSON.parse(raw);

    for (const [key, meta] of Object.entries(data)) {
      const sessionId = meta.sessionId;
      if (!sessionId) continue;

      // Resolve transcript path — handle Docker/remote paths by extracting filename
      const transcriptPath = resolveTranscriptPath(meta.sessionFile, sessionId, sessionsDir);

      sessionsMap.set(sessionId, {
        agentId: meta.agentId || agentId,
        sessionKey: key,
        sessionId,
        transcriptPath,
        meta: {
          model: meta.model || 'unknown',
          modelProvider: meta.modelProvider || 'unknown',
          inputTokens: meta.inputTokens || 0,
          outputTokens: meta.outputTokens || 0,
          totalTokens: meta.totalTokens || 0,
          contextTokens: meta.contextTokens || 0,
          cacheRead: meta.cacheRead || 0,
          cacheWrite: meta.cacheWrite || 0,
          compactionCount: meta.compactionCount || 0,
          chatType: meta.chatType || 'unknown',
          kind: meta.kind || 'unknown',
          status: meta.status || 'unknown',
          updatedAt: meta.updatedAt ? new Date(meta.updatedAt) : null,
          startedAt: meta.startedAt ? new Date(meta.startedAt) : null,
          endedAt: meta.endedAt ? new Date(meta.endedAt) : null,
          runtimeMs: meta.runtimeMs || null,
          estimatedCostUsd: meta.estimatedCostUsd ?? null,
          origin: meta.origin || null,
          deliveryContext: meta.deliveryContext || null,
        },
      });
    }
  } catch (err) {
    // Silently skip malformed files — we're read-only and graceful
  }
}

/**
 * Resolve a transcript file path, handling Docker/remote paths.
 * Tries: (1) original path, (2) filename extracted from remote path in local dir,
 * (3) sessionId.jsonl in local dir.
 */
function resolveTranscriptPath(sessionFile, sessionId, sessionsDir) {
  const candidates = [];

  if (sessionFile) {
    candidates.push(sessionFile);
    // Extract just the filename from potentially remote/Docker paths
    const filename = basename(sessionFile);
    candidates.push(join(sessionsDir, filename));
  }

  candidates.push(join(sessionsDir, `${sessionId}.jsonl`));

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* continue */ }
  }

  return null;
}

/**
 * Discover .jsonl files in a directory that aren't already in sessionsMap.
 * These are "orphan" transcripts — we parse their header to get metadata.
 */
async function discoverOrphanJsonl(dir, sessionsMap) {
  try {
    const entries = await readdir(dir);
    const knownTranscripts = new Set(
      [...sessionsMap.values()].map(s => s.transcriptPath).filter(Boolean)
    );

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const fullPath = join(dir, entry);
      if (knownTranscripts.has(fullPath)) continue;

      // Extract session ID from filename
      const fileSessionId = entry.replace('.jsonl', '');
      if (sessionsMap.has(fileSessionId)) continue;

      // Parse first few lines to get session header and model info
      try {
        const raw = await readFile(fullPath, 'utf-8');
        const lines = raw.split('\n').filter(l => l.trim()).slice(0, 10);
        let model = 'unknown';
        let provider = 'unknown';
        let sessionTimestamp = null;

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'session' && obj.timestamp) {
              sessionTimestamp = new Date(obj.timestamp);
            }
            if (obj.type === 'model_change') {
              model = obj.modelId || model;
              provider = obj.provider || provider;
            }
          } catch { /* skip */ }
        }

        const fileStat = await stat(fullPath);

        sessionsMap.set(fileSessionId, {
          agentId: 'unknown',
          sessionKey: fileSessionId,
          sessionId: fileSessionId,
          transcriptPath: fullPath,
          meta: {
            model,
            modelProvider: provider,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            contextTokens: 0,
            cacheRead: 0,
            cacheWrite: 0,
            compactionCount: 0,
            chatType: 'unknown',
            kind: 'unknown',
            status: 'unknown',
            updatedAt: fileStat.mtime,
            startedAt: sessionTimestamp,
            endedAt: null,
            runtimeMs: null,
            estimatedCostUsd: null,
            origin: null,
            deliveryContext: null,
          },
        });
      } catch { /* skip unreadable files */ }
    }
  } catch { /* dir not readable */ }
}
