# Release guide

Version 0.2.0 is prepared from tested source. Installing from GitHub or a locally built archive works before registry publication.

Before publishing, confirm ownership of the registry name, review the exact commit, run all checks, and verify one authenticated inference request with a QCloud API key and an active catalog model. Mock tests do not establish live model access.

## TypeScript / npm

1. Sign in to the npm account that will own `qcloud-ai`, and confirm that the name is still available.
2. Run `npm ci`, `npm run check`, and `npm pack --dry-run`.
3. Inspect the package archive, then publish through the authenticated npm release process. Prefer npm Trusted Publishing once an authorized publisher is configured. Do not commit registry tokens.
4. After the release exists on npm, update installation instructions to `npm install qcloud-ai` and tag the released commit `v0.2.0`.

Source repositories and package registries are separate: a GitHub organization does not automatically create an npm account or reserve a package name.
