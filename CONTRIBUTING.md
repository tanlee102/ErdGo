# Contributing

Thank you for helping improve ERD Go.

## Development workflow

1. Fork and clone the repository.
2. Install dependencies with `npm install`.
3. Create a focused branch.
4. Run `npm run check` before opening a pull request.

Keep route code compositional and put behavior in the owning feature or library. Preserve the public parser, renderer, Data View, and Query View facades described in `docs/architecture.md`. Do not edit generated `dist/` or `coverage/` output.

## Local-first boundary

This repository intentionally has no accounts, cloud file API, or share links. A proposal that adds a backend, telemetry, authentication, public sharing, or third-party persistence should begin as an issue and must include a clear privacy and maintenance design. Do not silently send diagram SQL or browser-stored documents over the network.

Changes to stored document shapes must keep old, missing, malformed, and unavailable storage readable. Update the persistence contract and validation notes in the same pull request.

## Pull requests

- Explain the user-visible outcome and why the owning layer is correct.
- Include screenshots for material UI changes.
- Document new workflows, limitations, persistence keys, or dependency directions.
- Avoid unrelated formatting or generated-file churn.
- Confirm lint, build, and relevant manual validation results in the description.

By contributing, you agree that your contribution is licensed under the MIT License.
