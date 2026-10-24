# Architecture

ERD Go is a browser-only SQL-to-ERD application. Its open-source scope is the SQL editor, canvas, Data View, Query View, local documents, and SQL guide. Other hosted diagram and conversion tools are outside this repository.

## Routes and runtime

```text
BrowserRouter -> ThemeProvider -> / -> HomePage
                              -> /docs, /docs/:guide -> SQL guide
                              -> EditorWorkspace -> /e/:index -> EditorPage

SQL tabs -> combined SQL -> sqlToErdSchema -> schemaRef -> ERD renderer
                         -> Data View executor -> Query View executor

Save/open/delete -> localFileStore -> localStorage
```

`/e/new` opens a new document. Each deliberate New navigation has its own router entry key, so it resets the starter chooser even when the previous URL was already `/e/new`. Ordinary rerenders preserve unsaved SQL. `/e/:id` reads only the matching local SQL document. Unknown routes return to the homepage. Keep `public/_redirects` so saved links work on static hosts.

The lazy `EditorWorkspace` owns notifications, confirmations, navigation guards, root editor state, Add Table, and the local file dialog. `EditorPage` composes feature hooks and views. It does not own parser, renderer, sample-data, or persistence engines.

## Owners and facades

| Concern | Public owner |
| --- | --- |
| Routes and providers | `src/App.jsx`, `src/pages/EditorWorkspace.jsx` |
| Homepage and SQL guide | `src/pages/HomePage.jsx`, `src/pages/DocsPage.jsx` |
| Editor composition | `src/pages/EditorPage.jsx` |
| SQL tabs/import and revision guards | `src/features/editor/hooks/useSqlTabs.js` |
| SQL parser | `src/lib/parse-ast/parseAst.js` |
| SQL-to-ERD conversion | `src/lib/erdJsonSchema.js` |
| ERD renderer | `src/lib/genErdScript.js` |
| Renderer integration and table groups | `useErdRendering.js`, `ErdTableGroupsControl/` |
| Data View | `src/features/data-view/lib/sqlExecutor.js` |
| Query View | `src/features/query-view/lib/queryExecutor.js` |
| Local sample data | `src/features/data-view/lib/sampleData.js`, `SampleDataDialog/` |
| Deferred code editor | `src/components/CodeEditor/`, `scripts/code-editor-runtime.js` |
| Browser documents | `src/features/files/lib/localFileStore.js` |

UI must use parser, renderer, Data View, and Query View facades rather than private runtime modules.

## Persistence compatibility

`erdgo:documents:v1` retains its version 1 envelope:

```json
{
  "version": 1,
  "documents": [
    {
      "id": "browser-local-id",
      "name": "diagram name",
      "sql": "CREATE TABLE ...",
      "context": {},
      "createdAt": "ISO timestamp",
      "updatedAt": "ISO timestamp"
    }
  ]
}
```

Readers accept older bare arrays, missing optional fields, malformed JSON, and invalid records. Returned values are cloned. Writers preserve creation timestamps, commit source/name/context together, report quota failures, and notify in-window observers. Storage events, including a cleared key, refresh local lists.

The previous multi-tool release could store records with `kind: "prisma-erd"` or `kind: "erd-builder"` and a `payload`. `fileDocuments.js` retains those legacy identifiers and metadata for storage compatibility. SQL lists filter them out. SQL loading and saving reject another document kind; saving or deleting a SQL record preserves other stored records. This version does not migrate or delete their payloads.

Saved renderer context remains backward-compatible. It includes coordinates, colors, viewport, SQL tabs, Query text, display preferences, inference decisions, and optional `tableGroups`. SQL remains the semantic schema source of truth. Missing groups retain the previous ungrouped canvas. Groups change presentation only; they never change SQL or relationships.

Other browser keys remain `erdgo:theme`, `gemini_api_key`, `gemini_api_key_enabled`, `addTable.dialect`, and `addTable.dialect.version`. Sample generation and code-editor fallback add no storage keys.

## SQL and rendering workflows

Canvas table/column edits and relationship creation/reconnection pass through the registered SQL-tab operation bridge. Its owning libraries validate current tab revisions and update source SQL and supported dependent statements. Unsafe changes require SQL editing. Destructive changes require review.

The renderer paints independently of Monaco readiness. It owns host resize observation, device-pixel-ratio sizing, visibility culling, and canvas text rasterization. Splitter drags coalesce pointer updates and commit the final width on release, blur, or cancellation. A delayed indicator appears only for longer-running rendering. ELK layout and PDF export load on demand.

Data and Query views mount on first use and remain hidden across switches to retain selection, scrolling, and results. A different document resets their owning state. Their executors run a supported in-memory SQL subset and surface diagnostics for unsupported behavior.

Data View opens sample generation in a worker. Preparation reads enabled SQL tabs, supported constraints, and current data. Local dictionaries and generators create candidate values; the Data View executor validates generated rows. The dialog supports column choices, preview, cancellation, SQL copying/downloading, and insertion into a new tab. Insertion checks the originating tab/document revision so stale results cannot modify a newer workspace. Generation performs no AI or service request.

`CodeEditor` exposes a controlled plain-source fallback while editor tools load. Its deferred runtime configures Monaco and a local worker. The Vite plugin emits the production URL/style manifest; development uses a Vite URL import. Keep preload/CommonJS helpers outside the Monaco chunk, and JSX runtime with shared React, so pages and fallback source do not wait for the engine. Retries preserve the document and successfully loaded resources. No Monaco CDN is used.

## Network boundary

There are no account, cloud-file, sharing, analytics, or application API modules. The only optional external service is an explicit Gemini request using the user's own key. Removing AI must not affect SQL parsing, diagrams, sample generation, Data/Query views, exports, or local saves.

## Validation

`npm run check` runs ESLint, Vitest tests, and the production build. `npm run test:e2e` runs Playwright against a production preview; CI runs both gates. Install Chromium first or use `PLAYWRIGHT_CHANNEL=chrome` for installed Chrome. `PLAYWRIGHT_PORT` selects the preview port.

Tests cover SQL parsing/conversion/execution, geometry and text, group persistence, sample generation and stale insertion, storage compatibility, source fallback/retry, splitter cleanup, and saved-editor/browser workflows. Tests are source; generated `dist/`, `coverage/`, `test-results/`, and `playwright-report/` stay ignored.
