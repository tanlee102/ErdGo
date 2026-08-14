# Architecture

ERD Go is a browser-only React application with a minimal homepage and one route-owned feature: the SQL-to-ERD Editor. Route pages compose behavior; engines live behind stable facades; browser persistence is treated as a compatibility boundary.

## Runtime flow

```text
BrowserRouter -> providers -> / -> HomePage
                           -> /e/:index -> EditorPage

SQL tabs -> combined SQL -> sqlToErdSchema -> schemaRef -> ERD renderer
                         -> Data View executor -> Query View executor

Save/open/delete -> localFileStore -> localStorage
```

`/` renders the homepage, `/e/new` lazy-loads a fresh local editor, and unknown routes return to the homepage. A saved route `/e/:id` loads only the matching local document. It never attempts an authenticated or public network fetch. Editor-only providers and overlays live in `EditorWorkspace`, so the homepage does not eagerly load the editor runtime.

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

Other keys:

- `erdgo:theme` stores `light` or `dark`.
- `gemini_api_key` and `gemini_api_key_enabled` belong to the optional BYO-key AI editor.

## Network boundary

The repository has no account, share, cloud-file, analytics, or application API modules. The only optional network feature is an explicit user-initiated Gemini request made with the user’s own key. Removing the AI UI must not affect SQL parsing, ERD rendering, Data View, Query View, or local documents.

## Quality gate

`npm run check` runs ESLint and creates a production bundle. Manual review should cover SQL-to-ERD conversion, local save/open behavior, Data View, Query View, exports, responsive layout, and both color themes when the affected boundary changes.
