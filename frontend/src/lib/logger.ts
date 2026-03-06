type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const minLevel: number =
  typeof process !== 'undefined' && process.env.NODE_ENV === 'production'
    ? LEVELS.info
    : LEVELS.debug;

function emit(level: LogLevel, message: string, context: Record<string, unknown>) {
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
  debug: (message: string, context: Record<string, unknown> = {}) => emit('debug', message, context),
  info: (message: string, context: Record<string, unknown> = {}) => emit('info', message, context),
  warn: (message: string, context: Record<string, unknown> = {}) => emit('warn', message, context),
  error: (message: string, context: Record<string, unknown> = {}) => emit('error', message, context),
};
