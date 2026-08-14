# Security Policy

## Reporting a vulnerability

Please do not open a public issue for an unpatched vulnerability. [Submit a private vulnerability report](https://github.com/tanlee102/ErdGo/security/advisories/new) with affected versions, reproduction steps, impact, and any suggested mitigation.

You should receive an acknowledgment within seven days. Maintainers will investigate, coordinate a fix and disclosure when appropriate, and credit reporters who want attribution.

## Security model

ERD Go is a static browser application. Diagrams and optional Gemini credentials are sensitive local data even though there is no application backend. Security reports are especially useful for unintended data transmission, script injection through SQL/diagram labels, unsafe exports, dependency compromise, local-storage isolation failures, and provider-key exposure.

Never include real database credentials, production schema secrets, or API keys in a report. Use minimal synthetic examples.
