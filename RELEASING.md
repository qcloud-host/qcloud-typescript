# Release guide

Version 0.3.0 is a source release candidate. GitHub source and built archives are separate from an npm publication; no registry release or release tag is implied by this version.

Before publishing, confirm ownership of the registry name, review the exact commit, run all checks, and verify one authenticated inference request with a QCloud API key and an active catalog model. Mock tests do not establish live model access.

## TypeScript / npm

1. Sign in to the npm account that will own `qcloud-ai`, and confirm that the name is still available.
2. On the designated release host, run `npm ci`, `npm run check`, and `npm run check:package`. The last command packs the package and its installed, pinned runtime dependency, installs both into a clean consumer offline, checks contents and dependencies, then imports ESM and CommonJS and makes mocked HTTP requests. It does not depend on cached registry metadata. Offline operators can alternatively supply reviewed dependency tarballs using the JSON array `QCLOUD_NPM_DEPENDENCY_ARCHIVES`.
3. Run `npm pack --ignore-scripts`, retain the tarball and its SHA-256 with the tested source commit, and inspect its contents. Publish that exact reviewed archive through the authenticated npm release process. Prefer npm Trusted Publishing once an authorized publisher is configured. Do not commit registry tokens.
4. After the release exists on npm, install it by exact version in a clean consumer, update installation instructions to `npm install qcloud-ai`, remove the candidate marker in the changelog, and tag the released commit `v0.3.0`.

Source repositories and package registries are separate: a GitHub organization does not automatically create an npm account or reserve a package name.

The app's `sdks/node` tree is canonical. Promote the complete tested subtree to `qcloud-host/qcloud-typescript` and verify the Git tree matches before publication. Do not include application settings, provider credentials or release-host caches. Public queue capabilities and model admission remain server decisions; passing SDK tests does not activate billing or inference.
