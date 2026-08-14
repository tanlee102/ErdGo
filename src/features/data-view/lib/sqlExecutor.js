/**
 * Stable public entry point for the in-memory Data View engine.
 *
 * AI/dev rule: keep UI and cross-feature imports pointed here. Dialect,
 * validation, value, and statement-execution internals belong beside the
 * runtime and must not expand this facade.
 */
export { createSqlExecutor } from './dataViewRuntime.js';
