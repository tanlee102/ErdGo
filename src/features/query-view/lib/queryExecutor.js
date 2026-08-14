/**
 * Stable public entry point for Query View execution.
 *
 * AI/dev rule: import from this file outside `lib/`. Internal parser,
 * validation, token, and evaluation modules may change without forcing UI or
 * existing callers to follow those moves.
 */
export { executeSelectQuery } from './queryRuntime.js';
