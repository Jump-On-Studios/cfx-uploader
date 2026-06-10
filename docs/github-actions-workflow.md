# GitHub Actions CFX Upload Workflow

This document describes the target CI flow for uploading a CFX asset from a product repository such as `RedM-jo_chest`.

## Repository Setup

Each product repository must contain `cfx_uploader.json` at its root:

```json
{
  "portalName": "jo_chest 2",
  "foldersToZip": ["jo_chest"]
}
```

The resource version must be bumped in `fxmanifest.lua` before creating the GitHub Release.

## Organization Secrets

Create these secrets at the GitHub organization level:

```text
CFX_UPLOADER_CREDENTIAL_ID
CFX_UPLOADER_RP_ID
CFX_UPLOADER_PRIVATE_KEY
CFX_UPLOADER_USER_HANDLE
CFX_UPLOADER_SIGN_COUNT
```

These values replace `passkey-credential.json` in CI. Keep `passkey-credential.json` for local development only. No repository token is needed to checkout `Jump-On-Studios/cfx-uploader` while it is public.

If these secrets are missing in GitHub Actions, the upload fails before CFX authentication with a clear missing credentials error. The local `passkey-credential.json` fallback is intentionally not used in CI.

## Release Flow

1. Work on the product repository, for example `RedM-jo_chest`.
2. Bump the version in `fxmanifest.lua`.
3. Create a GitHub Release with the matching version tag.
4. The release workflow runs.
5. The workflow checks out the product repository.
6. The workflow clones `cfx-uploader`.
7. The workflow installs `cfx-uploader` dependencies.
8. The workflow runs HTTP mode.

`cfx-uploader` then uses:

- `GITHUB_REPOSITORY` to identify the product repo.
- `github.event.release.tag_name` or the manual `release_tag` input to download the exact release tag, with `/latest` fallback when no tag is provided.
- `cfx_uploader.json` from the downloaded release.
- `CFX_UPLOADER_*` secrets for passkey auth.

Release tags can be written with or without a leading `v`. If `1.0.0` is requested and only `v1.0.0` exists, the uploader tries the alternate form automatically, and vice versa. After downloading the release, the resolved tag is compared to `fxmanifest.lua` `version`; `v1.0.0` and `1.0.0` are considered equal.

GitHub pre-releases are uploaded to CFX as `Release Candidate / Beta` versions. Normal GitHub releases are uploaded as CFX full releases. The CLI can override this with `--release-candidate` or `--full-release` when needed.

## Example Workflow

```yaml
name: CFX Upload

on:
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      release_tag:
        description: Release tag to upload, defaults to latest if empty
        required: false
        type: string

permissions:
  contents: read

jobs:
  upload-cfx:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout product repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Checkout CFX uploader
        uses: actions/checkout@v4
        with:
          repository: Jump-On-Studios/cfx-uploader
          path: .cfx-uploader

      - name: Install CFX uploader dependencies
        working-directory: .cfx-uploader
        run: npm ci

      - name: Upload CFX asset
        working-directory: .cfx-uploader
        env:
          GITHUB_TOKEN: ${{ github.token }}
          CFX_UPLOADER_RELEASE_TAG: ${{ github.event.release.tag_name || inputs.release_tag }}
          CFX_UPLOADER_CREDENTIAL_ID: ${{ secrets.CFX_UPLOADER_CREDENTIAL_ID }}
          CFX_UPLOADER_RP_ID: ${{ secrets.CFX_UPLOADER_RP_ID }}
          CFX_UPLOADER_PRIVATE_KEY: ${{ secrets.CFX_UPLOADER_PRIVATE_KEY }}
          CFX_UPLOADER_USER_HANDLE: ${{ secrets.CFX_UPLOADER_USER_HANDLE }}
          CFX_UPLOADER_SIGN_COUNT: ${{ secrets.CFX_UPLOADER_SIGN_COUNT }}
        run: npm run orchestrate-http
```

## Local Development

Local runs can still use:

```bash
npm run orchestrate-http
```

Local fallback behavior:

- `src/config/mock-config.js` provides `githubRepository`.
- `passkey-credential.json` provides the CFX passkey if `CFX_UPLOADER_*` secrets are not set.
- `/releases/latest` is used if no release tag is provided.

To test a specific tag locally:

```bash
npm run orchestrate-http -- --release-tag=v1.1.2
```

If the release tag and `fxmanifest.lua` version do not match, the uploader fails before CFX authentication or upload.

To force the CFX release type locally:

```bash
npm run orchestrate-http -- --release-tag=v1.1.2 --release-candidate
npm run orchestrate-http -- --release-tag=v1.1.2 --full-release
```
