# ERD Go

ERD Go is a local-first SQL editor that turns database schemas into interactive entity-relationship diagrams. This repository contains its focused Editor experience: SQL tabs and import, ERD rendering and layout, Data View, Query View, exports, schema diagnostics, and an optional bring-your-own-key AI editing workflow.

There is a simple homepage and one editor workspace, with no account system, cloud file API, or sharing service. Diagrams are stored in the current browser.

## Features

- Convert SQLite, PostgreSQL, MySQL, and SQL Server DDL into an interactive ERD.
- Edit SQL in Monaco with multiple named tabs, inactive drafts, formatting, and multi-file import.
- Move and color tables, inspect relationships, use automatic ELK layouts, navigate a minimap, and export PNG, SVG, or PDF.
- Replay schema and seed-data SQL in an in-browser Data View.
- Run supported read-only `SELECT` queries in Query View.
- Add tables through a dialect-aware visual form.
- Save, reopen, search, and delete diagrams locally without an account.
- Optionally edit SQL with Gemini using your own API key. The key remains in your browser storage and requests go directly to the selected provider.
- Use light and dark themes with responsive desktop/mobile layouts.
- Enter the editor from a focused, app-matched homepage at `/`.

## Privacy and local storage

ERD Go has no application backend. It does not include authentication, cloud syncing, public links, file sharing, analytics, or feedback APIs.

Saved diagrams use the versioned key `erdgo:documents:v1` in `localStorage`. A saved document contains SQL, SQL-tab metadata, diagram positions/colors, view preferences, and the persisted Query View text. Theme and optional Gemini settings use separate local keys.

Browser storage can be removed by private-browsing rules, storage quotas, cleanup tools, or browser settings. Export important work as a backup. Local URLs such as `/e/<id>` identify documents only inside the browser profile that saved them; they are not share links.

## Getting started

Requirements: Node.js 20 or newer and npm.

```bash
git clone https://github.com/tanlee102/ErdGo.git
cd ErdGo
npm install
npm run dev
```

The development server runs at `http://localhost:3001` by default.

For a production build:

```bash
npm run build
npm run preview
```

## Supported SQL

The parser targets useful schema-design SQL across SQLite, PostgreSQL, MySQL, and SQL Server. It understands common `CREATE TABLE`, keys, foreign keys, indexes, enums, composite types, views, and supported `ALTER TABLE` flows. It also recovers partial diagrams from many incomplete or messy dumps.

Data View is an in-browser SQL simulation intended for schema exploration and fixtures; it is not a full replacement for a production database engine. Query View supports the documented read-only query subset and validates unsupported semantics instead of sending SQL anywhere.

## Commands

```bash
npm run dev        # Start Vite in development mode
npm run lint       # Run ESLint
npm run build      # Create the production bundle
npm run check      # Run lint and create the production bundle
```

## Architecture

The app deliberately keeps a narrow boundary:

```text
SQL tabs -> SQL-to-ERD schema -> renderer
         -> Data View executor -> Query View executor
         -> local document repository
```

See [docs/architecture.md](docs/architecture.md) for module ownership, persistence compatibility, and the rules that keep the project local-first.

## Deployment

The output is a static Vite SPA in `dist/`. `public/_redirects` provides the `/e/*` fallback on compatible static hosts such as Cloudflare Pages and Netlify. Configure an equivalent rewrite to `index.html` on other hosts; without it, refreshing a saved local document URL can return a host-level 404.

No server secrets are required. Do not put a Gemini key in an environment variable or source file—the UI accepts each user’s key locally.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report vulnerabilities through [SECURITY.md](SECURITY.md).

## License

ERD Go is released under the [MIT License](LICENSE).
