# Changelog

Notable changes to ERD Go are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Prisma-to-ERD workbench with source diagnostics, model/field/relation search, diagram exports, and local documents.
- Visual ERD Builder with conceptual shapes, semantic checks, undo/redo, selection tools, graph layout, and reviewed SQL transfer to the editor.
- Spreadsheet-to-SQL conversion for CSV, TSV, text, and XLSX, including type overrides, previews, and issue downloads.
- Canvas table/column editing, foreign-key creation and reconnection, dialect-aware Add Table validation, and export options.
- Browser tool guides, homepage tool links and recent local documents, and unit/browser regression test commands.

### Changed

- Updated SQL parsing, schema conversion, Data/Query semantics, renderer geometry, and lazy layout from the current browser implementation.
- Extended the existing local document store with Prisma and Builder payloads while preserving legacy SQL records and renderer context.
- Retained Data and Query workbench state across view switches; restored reactive Monaco theme handling.
- Updated transitive dependencies to resolve the dependency audit findings.

## [0.1.0] - 2026-08-15

### Added

- Local-first SQL editor with PostgreSQL, MySQL, SQLite, and SQL Server support.
- Interactive ER diagrams with automatic layout, relationship editing, colors, minimap, and export.
- Data View for replaying supported schema and sample-data SQL.
- Read-only Query View for supported `SELECT` queries.
- Browser-local diagram creation, save, open, rename, and delete workflows.
- Optional Gemini-assisted SQL editing with a user-provided API key.
- Light and dark themes, responsive homepage, and installable web-app metadata.

[Unreleased]: https://github.com/tanlee102/ErdGo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tanlee102/ErdGo/releases/tag/v0.1.0
