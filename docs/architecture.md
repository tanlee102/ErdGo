# Architecture

ERD Go is a browser-only React application with SQL, Prisma, conceptual ERD Builder, and spreadsheet workflows. Route pages compose behavior; engines live behind stable facades; browser persistence is treated as a compatibility boundary.

## Runtime flow

```text
BrowserRouter -> providers -> / -> HomePage
                           -> /e/:index -> EditorPage
                           -> /prisma-to-erd/:index -> PrismaToErdPage
                           -> /erd-builder/:index -> ErdDraftPage
                           -> /spreadsheet-to-sql -> SpreadsheetToSqlPage
                           -> /docs, /docs/:guide -> DocsPage

SQL tabs -> combined SQL -> sqlToErdSchema -> schemaRef -> ERD renderer
                         -> Data View executor -> Query View executor

Save/open/delete -> localFileStore -> localStorage
```

`/` renders the homepage, `/e/new` lazy-loads a fresh local editor, and unknown routes return to the homepage. Saved SQL, Prisma, and Builder routes load only the matching browser document and reject a document from a different tool. They never attempt an authenticated or public network fetch. Workspace providers and overlays live in the nested `EditorWorkspace` route; each tool page loads independently. The homepage does not eagerly load the editor runtime.

The bare `/prisma-to-erd` and `/erd-builder` routes redirect to their `/new` workspace. `/erd-designer` and `/erd-draft` also redirect to `/erd-builder/new`. Keep `public/_redirects` so static hosts serve all workspace routes through the SPA.

## Owners and facades

| Concern | Public owner |
| --- | --- |
| Routes and providers | `src/App.jsx` |
| Homepage | `src/pages/HomePage.jsx` |
| Page composition | `src/pages/EditorPage.jsx` |
| Editor route boundary and overlays | `src/pages/EditorWorkspace.jsx` |
| Editor tabs/import/review | `src/features/editor/` |
| SQL parsing | `src/lib/parse-ast/parseAst.js` |
| SQL-to-ERD conversion | `src/lib/erdJsonSchema.js` |
| ERD rendering | `src/lib/genErdScript.js` |
| Data View | `src/features/data-view/lib/sqlExecutor.js` |
| Query View | `src/features/query-view/lib/queryExecutor.js` |
| Local documents | `src/features/files/lib/localFileStore.js` |
| Local document kinds/routes | `src/features/files/lib/fileDocuments.js` |
| Prisma parsing/conversion | `src/features/prisma-erd/lib/prismaToSql.js` |
| Builder graph/SQL mapping | `src/features/erd-draft/lib/` |
| Spreadsheet decoding/SQL generation | `src/features/spreadsheet-to-sql/lib/spreadsheetImport.js` |

UI code should import these facades instead of private runtimes such as `erdRendererRuntime.js`, `dataViewRuntime.js`, or `queryRuntime.js`.

## Persistence contract

`erdgo:documents:v1` stores an envelope:

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

Readers tolerate a missing key, malformed JSON, an older bare-array envelope, invalid records, and missing optional fields. Returned records are cloned so UI code cannot mutate stored state accidentally. Writers preserve `createdAt`, update `updatedAt`, surface storage quota errors, and emit an in-window change event for the local file dialog.

The saved `context` remains backward-compatible data. It includes renderer layout/color/viewport state, SQL-tab metadata, Query View text, display preferences, and relationship-inference decisions. SQL remains the schema-semantic source of truth.

Missing document kinds mean legacy SQL documents. SQL writers retain the original record shape. Prisma records additionally have `kind: "prisma-erd"` and a `payload` containing `schemaVersion: 1`, Prisma `source`, and `rendererContext`. Builder records have `kind: "erd-builder"` and a `payload` containing `schemaVersion: 3`, persisted `nodes`, `edges`, and `viewport`. These additions retain the version 1 envelope and all existing SQL/context data. Local writes commit name and payload together, preserve timestamps, and refuse to overwrite a record belonging to another tool. No old tool storage is deleted as part of loading.

`useLocalDocumentState` owns the dirty baseline and exclusive-save guard for the new workspaces. Renderer hydration finishes before a saved diagram becomes the clean baseline. The local file dialog routes each record to its owning tool; Prisma and Builder can filter the list to their document kind. Cross-tab storage changes, including clearing storage, refresh the list.

Other keys:

- `erdgo:theme` stores `light` or `dark`.
- `gemini_api_key` and `gemini_api_key_enabled` belong to the optional BYO-key AI editor.
- `addTable.dialect` and `addTable.dialect.version` store a manual Add Table dialect preference. Current SQL detection remains the default when no manual override is chosen.

## Editing and conversion boundaries

Canvas schema edits, relationship creation, and reconnection pass through the SQL-tab operation bridge registered by `useSqlTabs`. The owning libraries validate tab revisions and update source SQL, including dependent statements. The renderer does not become a second semantic schema store. Destructive changes require review. Prisma shares diagram appearance controls while hiding SQL-specific mutation buttons.

ERD Builder has its own graph/history/semantic libraries. SQL conversion presents diagnostics and mapping choices. Opening its output in `/e/new` uses a validated `sqlEditorTransfer` object in router history state; the editor initializes that document once and skips the starter chooser. Browser reload can restore this unsaved transfer without adding a storage key.

Spreadsheet import runs in memory, supports CSV/TSV/text/XLSX, and bounds compressed input and archive expansion. SQL generation defaults to SQLite and offers PostgreSQL, MySQL, and SQL Server. It uses cached formula results rather than evaluating formulas. The tool does not save a workbook; users copy or download SQL and issue reports.

Data and Query views mount on first use and remain hidden across view switches to retain selection, scrolling, and results. Saved document changes still reset their owning state. Shared ELK layout and PDF export libraries load when requested.

## Network boundary

The repository has no account, share, cloud-file, analytics, or application API modules. The only optional service request is an explicit user-initiated Gemini request made with the user’s own key. Monaco's default loader fetches editor code from its public CDN; document content stays in browser memory. Removing the AI UI must not affect parsing, rendering, conversions, Data View, Query View, or local documents.

## Quality gate

`npm run check` runs ESLint, Vitest regression tests, and a production bundle. `npm run test:e2e` uses Playwright against a local production preview; CI runs both gates. Install Chromium first or use `PLAYWRIGHT_CHANNEL=chrome` for an installed Chrome. Browser checks cover legacy SQL/context loading, canvas edits, Data/Query view switching, Prisma/Builder local saves, SQL handoff, spreadsheet downloads, and mobile/theme behavior. Tests are repository source, while generated reports, `dist/`, and `coverage/` remain ignored.
