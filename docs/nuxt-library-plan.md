# CFX Uploader - Nuxt Library Integration Plan

## Context

GitHub organization secrets for private repositories require a paid GitHub Team plan. Until that is enabled, CFX uploads should not depend on GitHub Actions secrets duplicated across every product repository.

The short-term plan is to keep `cfx-uploader` usable as a CLI, but also expose it as an installable npm library used by the Nuxt shop backend.

Target Nuxt project:

```text
C:\Users\brice\Documents\workspace\tebex-nuxt
```

Current webhook entrypoint:

```text
server/api/webhooks/github_update.js
```

This webhook already receives GitHub release events and sends Discord update notifications.

## Target Flow

1. A developer updates a resource repository, for example `jo_chest`.
2. The developer bumps the version in `fxmanifest.lua`.
3. The developer creates a GitHub Release with the matching version tag.
4. GitHub calls the existing Nuxt webhook.
5. The webhook validates the release payload and finds the matching shop script.
6. Before sending the Discord notification, the webhook calls `cfx-uploader` as a library.
7. `cfx-uploader` downloads the GitHub release, reads `cfx_uploader.json`, rebuilds the ZIP, validates the manifest version, authenticates to CFX, uploads via HTTP, and returns a result.
8. The webhook sends the Discord notification after the upload attempt.

## Library API Direction

Expose a package entrypoint from `index.js`.

Recommended usage:

```js
import { createUploader } from 'cfx-uploader';

const uploader = createUploader({
  githubToken: process.env.GITHUB_TOKEN,
  passkey: {
    credentialId: process.env.CFX_UPLOADER_CREDENTIAL_ID,
    rpId: process.env.CFX_UPLOADER_RP_ID,
    privateKey: process.env.CFX_UPLOADER_PRIVATE_KEY,
    userHandle: process.env.CFX_UPLOADER_USER_HANDLE,
    signCount: Number(process.env.CFX_UPLOADER_SIGN_COUNT),
  },
  headless: true,
  workDir: '/tmp/cfx-uploader',
});

await uploader.upload({
  repository,
  releaseTag: payload.release?.tag_name,
});
```

The library should also support a direct helper:

```js
import { upload } from 'cfx-uploader';

await upload({
  repository,
  releaseTag,
  githubToken,
  passkey,
});
```

## Required Refactor

- Keep the existing CLI modes:
  - `npm run orchestrate`
  - `npm run orchestrate-http`
- Reuse the HTTP upload core from `src/core/upload-http-flow.js`.
- The reusable core must accept explicit options instead of relying on CLI args and `process.env`:
  - `repository`
  - `releaseTag`
  - `githubToken`
  - `passkey`
  - `headless`
  - optional working directories
- Keep CLI behavior as a thin wrapper around the library core.
- Keep local dev fallbacks for CLI only:
  - `.env`
  - `mock-config.js`
  - `passkey-credential.json`
- Library mode should not rely on `mock-config.js`.

## Upload Behavior

The library upload flow should match the current HTTP mode:

1. Resolve the requested GitHub release.
2. Support tags with or without leading `v`.
3. Download the release ZIP.
4. Unzip the release.
5. Read `cfx_uploader.json` at the extracted repo root.
6. Rebuild the filtered ZIP from `foldersToZip`.
7. Read `fxmanifest.lua`.
8. Compare release tag and manifest version, ignoring only a leading `v`.
9. Authenticate to CFX with the provided passkey.
10. Upload the ZIP through `portal-api.cfx.re`.
11. Poll until the CFX asset returns to `ACTIVE`.
12. Delete downloaded archives, temporary extraction folders, and generated upload ZIPs after every run, including failed runs.

## Nuxt Environment Variables

Secrets live on the VPS in the Nuxt `.env`:

```env
GITHUB_TOKEN=...
CFX_UPLOADER_CREDENTIAL_ID=...
CFX_UPLOADER_RP_ID=forum.cfx.re
CFX_UPLOADER_PRIVATE_KEY=...
CFX_UPLOADER_USER_HANDLE=...
CFX_UPLOADER_SIGN_COUNT=1
```

These replace GitHub Actions secrets for the short-term VPS-driven workflow.

## Notes

- The GitHub Actions workflow remains documented for future use after upgrading GitHub to Team.
- The recommended short-term trigger is the existing Nuxt release webhook.
- The Nuxt server must be able to run Puppeteer/Chromium in headless mode.
- If the VPS is a minimal Linux install, Chromium system dependencies may need to be installed.
- The CFX passkey exposed during development should be rotated before long-term production use.
