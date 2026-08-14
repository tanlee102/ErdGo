# Contributing

Thank you for helping improve ERD Go. Contributions of every size are welcome—from clearer documentation and accessibility fixes to parser and editor improvements.

## Before you begin

- Search existing issues before opening a new one.
- Use the bug or feature issue form so the report has enough context.
- Keep proposals aligned with the project’s local-first, browser-only scope.
- Never include private schemas, production data, credentials, or API keys.

## Development workflow

1. Fork and clone the repository.
2. Use Node.js 20 or newer and install dependencies with `npm ci`.
3. Create a focused branch from `main`.
4. Start the app with `npm run dev`.
5. Make one coherent change and update affected documentation.
6. Run `npm run check` before opening a pull request.

```bash
git clone https://github.com/YOUR_USERNAME/ErdGo.git
cd ErdGo
npm ci
npm run dev
```

Read [`AGENTS.md`](AGENTS.md) for the contributor map and [`docs/architecture.md`](docs/architecture.md) for the runtime and persistence contracts. Keep route code compositional and put behavior in the owning feature or library. Preserve the public parser, renderer, Data View, and Query View facades. Do not edit generated output.

## Local-first boundary

This repository intentionally has no accounts, cloud file API, or share links. A proposal that adds a backend, telemetry, authentication, public sharing, or third-party persistence should begin as an issue and must include a clear privacy and maintenance design. Do not silently send diagram SQL or browser-stored documents over the network.

Changes to stored document shapes must keep old, missing, malformed, and unavailable storage readable. Update the persistence contract and validation notes in the same pull request.

## Pull requests

- Keep the change focused and use a clear, imperative title.
- Explain the user-visible outcome and why the owning layer is correct.
- Include screenshots for material UI changes.
- Document new workflows, limitations, persistence keys, or dependency directions.
- Avoid unrelated formatting or generated-file churn.
- Confirm lint, build, and relevant manual validation results in the description.
- Respond constructively to review and keep the branch mergeable.

Maintainers may close proposals that conflict with the project scope, duplicate existing work, or cannot be supported responsibly. This is a scope decision, not a judgment on the effort behind a contribution.

By contributing, you agree that your contribution is licensed under the MIT License.
