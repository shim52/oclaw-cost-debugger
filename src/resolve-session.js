import { discoverSessions } from './discovery.js';
import { estimateSessionCostFromMeta } from './estimator.js';
import chalk from 'chalk';

/**
 * Resolve a session from CLI arguments (positional ID, --session, or --rank).
 * Returns { session, sessions } or exits/returns null on failure.
 *
 * @param {string|undefined} sessionKeyOrId — positional argument
 * @param {{ session?: string, path?: string, rank?: string, sort?: string }} opts
 * @returns {Promise<{ session: object, sessions: Array } | null>}
 */
export async function resolveSession(sessionKeyOrId, opts) {
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
        return null;
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
    return null;
  }

  return { session, sessions };
}

/**
 * Get a display label for a session (prefer sessionKey over sessionId).
 */
export function sessionLabel(session) {
  return session.sessionKey && session.sessionKey !== 'unknown'
    ? session.sessionKey
    : session.sessionId;
}
