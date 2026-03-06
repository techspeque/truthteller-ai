/**
 * Lightweight structured logger for the frontend.
 *
 * Outputs JSON-ish structured messages via console methods so they're
 * filterable in browser devtools and visible in Tauri's stderr log.
 *
 * Usage:
 *   import { log } from '@/lib/logger';
 *   log.info('Sending message', { conversationId, fileCount: 3 });
 *   log.warn('Title update failed', { conversationId, error: err.message });
 *   log.error('Stream failed', { error: err.message });
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

// In production builds, suppress debug; otherwise show everything.
const minLevel =
  typeof process !== 'undefined' && process.env.NODE_ENV === 'production'
    ? LEVELS.info
    : LEVELS.debug;

function emit(level, message, context) {
  if (LEVELS[level] < minLevel) return;

  const entry = { ts: new Date().toISOString(), level, message, ...context };

  switch (level) {
    case 'error':
      console.error(`[${level}] ${message}`, entry);
      break;
    case 'warn':
      console.warn(`[${level}] ${message}`, entry);
      break;
    case 'debug':
      console.debug(`[${level}] ${message}`, entry);
      break;
    default:
      console.log(`[${level}] ${message}`, entry);
  }
}

export const log = {
  debug: (message, context = {}) => emit('debug', message, context),
  info: (message, context = {}) => emit('info', message, context),
  warn: (message, context = {}) => emit('warn', message, context),
  error: (message, context = {}) => emit('error', message, context),
};
