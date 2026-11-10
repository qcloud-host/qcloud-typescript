# Release guide

Version 0.4.0 is a source release candidate. Nothing has been published to npm. The name `qcloud-ai` was unregistered on npm on 10 November 2026 (registry 404).

A published version is immutable: npm never accepts a changed tarball under an existing version. Mock and contract tests do not establish live model access or billing; the release is complete only after the live acceptance at the end of this guide.

## One-time setup (owner)

1. Sign in to the npm account that will own `qcloud-ai`, with two-factor authentication.
2. In `qcloud-host/qcloud-typescript` create the GitHub environment `npm`: deployment branch rule `main` only, at least one required reviewer.
3. npm can configure a trusted publisher only for a package that already exists. For the **first** version only:
   - Run **Actions → Release** with `publish: false`. It tests Node 22 and 24, packs once, writes `SHA256SUMS` and attests provenance.
   - Download the `package` artifact, check its SHA-256 against `SHA256SUMS` and the attestation (`gh attestation verify <tgz> -R qcloud-host/qcloud-typescript`), then publish **that file** from the owner's machine: `npm publish qcloud-ai-<version>.tgz --access public --tag next`.
4. On npmjs.com, package settings → Trusted Publisher: GitHub Actions, organization `qcloud-host`, repository `qcloud-typescript`, workflow `release.yml`, environment `npm`. Then set publishing access to require two-factor authentication and disallow tokens.

## Release

1. Promote the complete tested `sdks/node` tree from the backend repository to `qcloud-host/qcloud-typescript` and verify the Git trees match. Do not include application settings, provider credentials or release-host caches.
2. Confirm the version in `package.json`, `package-lock.json`, `SDK_VERSION` and `CHANGELOG.md`.
3. Run **Actions → Release** with `version`, `dist-tag` (`next` for candidates) and `publish: true`. After review, the workflow publishes the exact tested tarball with provenance, then checks that the registry's `dist.integrity` equals the tested file, and creates a draft GitHub release with the tarball and checksum.
4. Install by exact version in a clean consumer on the PVE build host, move `latest` when ready (`npm dist-tag add qcloud-ai@<version> latest`), update the README install line to `npm install qcloud-ai`, remove the candidate marker in the changelog and publish the draft release as tag `v<version>`.

## Live acceptance (required before announcing)

From a clean project on PVE, with only `QCLOUD_API_KEY` and an active `QCLOUD_MODEL`:

1. `npm install qcloud-ai@<version>` from npm.
2. One non-streaming and one streaming chat request.
3. Confirm the request's usage record (request ID, tokens) and the resulting charge in the console match the provider-reported usage.
4. Record the evidence with the exact tarball hash. Report separately which checks used mocks and which used the live provider.

Source repositories and package registries are separate: a GitHub organization does not reserve an npm name. [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) · [Provenance](https://docs.npmjs.com/generating-provenance-statements)
