# Contributor Map

## Non-negotiable boundaries

- Keep the app local-first: no account, cloud-file, sharing, or analytics APIs.
- Treat `erdgo:documents:v1` and saved renderer context as backward-compatible data.
- Keep `src/pages/EditorPage.jsx` as a composer; behavior belongs to its owning feature or library.
- Import parser, renderer, Data View, and Query View facades rather than private runtimes.
- Never edit generated `dist/` or `coverage/` output.
- Keep `public/_redirects`; static hosts use it to serve saved `/e/:id` routes through the SPA.
- Update README or `docs/architecture.md` when a workflow, limitation, persistence key, route, or boundary changes.
- Run focused validation while iterating and `npm run check` before release.

## Find the owner

| Task | Start here |
| --- | --- |
| Routes/providers | `src/App.jsx` |
| Editor composition | `src/pages/EditorPage.jsx` |
| SQL tabs/import | `src/features/editor/hooks/useSqlTabs.js` |
| Load/save/local list | `src/features/files/lib/localFileStore.js`, editor data/save hooks |
| SQL parsing | `src/lib/parse-ast/parseAst.js` |
| SQL-to-ERD | `src/lib/erdJsonSchema.js` |
| Rendering/layout | `src/lib/genErdScript.js`, then `src/lib/erd-renderer/` |
| Data View | `src/features/data-view/lib/sqlExecutor.js` |
| Query View | `src/features/query-view/lib/queryExecutor.js` |

When a symptom crosses layers, prove the first incorrect boundary value and fix the owning layer rather than compensating downstream.
