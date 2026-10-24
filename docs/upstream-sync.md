# Upstream synchronization notes

## October 24, 2026 — SQL-only update

This repository is SQL to ERD only. The update ports the current reference SQL editor and canvas improvements: visual table groups, locally generated sample data, worker-backed local Monaco with editable source fallback and retry, renderer startup/DPR/text/culling changes, minimap/export bounds, panel resizing, and Data View INSERT caching. Parser and schema-conversion code already matched the reference.

SQL loading and saving retain browser-local transport, add retry and per-navigation New lifetimes, and reject stale save callbacks. Previously shipped Prisma, conceptual Builder, and spreadsheet workspaces and their dependencies are removed. Class and Sequence Diagram features are outside scope. Older non-SQL records remain in the local envelope, hidden from SQL lists and protected from SQL overwrites. No account, cloud-file, sharing, analytics, or server AI code is imported.

README, SQL guide, architecture notes, contributor map, changelog, and regression/browser suites describe this SQL-only scope. The earlier multi-tool notes below are historical.

### Validation

- `npm run check`: lint, all 6,280 tests across 131 suites, and production build passed.
- Seven production-preview Chrome workflows passed: homepage/mobile/theme, group persistence without SQL changes, local sample generation/insertion, local editor fallback/retry, hidden legacy-record preservation, repeated New navigation, and saved SQL/canvas/Data/Query/PNG export.
- `npm audit --audit-level=low`: zero vulnerabilities. Dependency tree and lockfile dry-run checks passed.
- The local Monaco engine is deferred in one retryable chunk (about 3.3 MB minified), which produces Vite's large-chunk advisory. The source editor and canvas work while it downloads.
- All 943 reference files matched the pre-update fingerprint, and its Git status remained clean.

## October 14, 2026 — Historical browser feature update

This update uses the current `erd-go-v2` browser code as a read-only reference. All implementation and validation changes belong to `open-erdgo`.

## Brought across

- Parser and SQL-to-ERD correctness updates, column/type limits, and dialect detection.
- Data/Query executor fixes and cross-dialect regression fixtures.
- Canvas column/table edits, dependency-aware SQL cascades, relationship creation/reconnection, endpoint geometry, lazy ELK layout, and export controls.
- Tab-aware Add Table validation, modal keyboard behavior, ERD health/control help, and retained Data/Query views.
- Prisma conversion, diagnostics, explorer, and diagram workbench.
- Conceptual ERD Builder, graph semantics, history, layout, image export, and reviewed SQL mapping.
- Spreadsheet decoding, bounded XLSX archive expansion, preview/settings, SQL generation, and issue reports.

## Open-source adaptations

SQL, Prisma, and Builder save to the existing browser store. Typed payloads extend `erdgo:documents:v1` without replacing legacy SQL/context records. A local file list opens each document in its owning tool. The homepage and guides describe these local workflows.

The hosted app's authentication, cloud documents, public sharing, analytics, feedback API, server-hosted AI, account UI, and marketing journal are outside this repository's local-first boundary. They are not dependencies of any imported tool. Optional AI continues to use the user's own Gemini key.

The migration retains the open-source Monaco theme fix and hides SQL mutation controls in Prisma. Test infrastructure and browser checks ship with the source so future updates can verify both shared engine behavior and the local persistence adaptations.

## Validation

- `npm run check`: lint, all 6,342 unit/component tests, and the production build passed.
- Playwright against installed Chrome: all six browser workflows passed, covering mobile/theme navigation, legacy SQL loading and canvas edits, Data/Query switching and PNG export, Prisma saves, Builder SQL handoff, spreadsheet downloads, and typed local-file routing.
- `npm audit --audit-level=low`: zero vulnerabilities.
- `npm ls --depth=0` and `npm ci --dry-run`: dependency tree and lockfile checks passed.
- The reference project's file fingerprint and Git status remained unchanged.
