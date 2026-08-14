/**
 * Stable public entry point for the ERD canvas renderer.
 *
 * AI/dev rule: renderer consumers import this facade. Pure colors, layout,
 * geometry, text, and interaction rules live in `erd-renderer/`; stateful DOM
 * and canvas orchestration remains in the internal runtime.
 */
export { default } from './erdRendererRuntime.js';
export * from './erdRendererRuntime.js';
