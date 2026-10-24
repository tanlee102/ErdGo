# Changelog

Notable changes to ERD Go are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Named SQL canvas table groups with saved membership and group movement.
- Local sample-data generation with worker preparation, dictionaries, constraint validation, previews, and insertion into a new SQL tab.
- A locally bundled Monaco runtime and worker, with immediate plain-source editing and retry after loading failures.
- Regression coverage for first paint, canvas text and sizing, group persistence, sample generation, splitter cleanup, and SQL save lifetimes.

### Changed

- Updated renderer first paint, device-pixel-ratio text, visibility culling, minimap, export bounds, panel resizing, and Data View INSERT caching from the read-only reference.
- Reset each deliberate New SQL navigation and reject save callbacks belonging to unloaded or replaced documents.
- Focused routes, navigation, source, dependencies, and guides on SQL to ERD with its Data/Query workflows.
- Preserved the existing local store and renderer context, including older non-SQL records that are hidden from SQL lists.
- Patched Vite, Vitest, and transitive dependency audit findings.

### Removed

- Prisma, conceptual Builder, and spreadsheet workspaces from this SQL-only open-source application. Class and Sequence workspaces are not included.

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
