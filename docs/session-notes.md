# CFX Uploader - Session Notes

Date: 2026-06-08

This document consolidates what was learned during the exploration and automation update session.

## Repository Purpose

This project automates the CFX Portal asset re-upload flow from a GitHub release.

Current pipeline:

1. Resolve the latest GitHub release for the configured repository.
2. Download the release ZIP.
3. Extract it locally.
4. Rebuild a filtered ZIP containing only configured folders.
5. Authenticate to CFX Portal with Puppeteer and a local WebAuthn passkey credential.
6. Find the configured CFX asset.
7. Upload the filtered ZIP as a new asset version.
8. Clean temporary files and delete the local ZIP after successful upload.

Main entrypoint:

```text
src/cli/browser-cli.js
```

Main upload module:

```text
src/cfx/browser-upload.js
```

Config file:

```text
src/config/mock-config.js
```

Current config target:

```js
module.exports = {
  portalName: 'jo_chest 2',
  githubRepository: 'Jump-On-Studios/RedM-jo_chest',
  foldersToZip: ['jo_chest'],
};
```

## Authentication

Puppeteer is the reliable automation path because the repo can inject a virtual WebAuthn authenticator from:

```text
passkey-credential.json
```

The auth module uses Chrome DevTools Protocol WebAuthn APIs:

```text
WebAuthn.enable
WebAuthn.addVirtualAuthenticator
WebAuthn.addCredential
```

Chrome MCP was useful for exploration, but not ideal for automation because:

- It cannot directly inject the repo passkey using the available MCP tools.
- Its Chrome profile was treated as a new device by CFX.
- Username/password login triggered an email-login security challenge.

After the email link was confirmed once, Chrome MCP could access the portal and was useful for DOM/UI exploration.

## CFX Portal Page

Target page:

```text
https://portal.cfx.re/assets/created-assets?page=1&sort=asset.id&direction=desc
```

Page title:

```text
Created Assets - Cfx.re Portal
```

Observed assets:

| Asset ID | Asset Name | Last Updated | Status |
|---:|---|---|---|
| 944872 | test other script name | 03/04/2026 15:38:16 | ACTIVE |
| 944844 | jo_chest 3 | 03/04/2026 15:03:52 | ACTIVE |
| 944842 | jo_chest 2 | 08/06/2026 17:27:05 | ACTIVE |
| 944602 | jo_chest | 03/04/2026 17:04:14 | ACTIVE |

The date for `jo_chest 2` changed during this session because a test upload was submitted.

## Major UI Change

The old automation expected:

```text
RE-UPLOAD
```

The current CFX Portal UI uses:

```text
UPLOAD NEW VERSION
```

The upload flow is no longer a single modal action. It is now a two-step wizard:

1. Select ZIP, wait for CFX to parse game/version, then click `NEXT`.
2. Fill release notes, wait for `UPLOAD FILE` to enable, then submit.

## Responsive Versus Desktop Layout

The UI renders both desktop table and responsive cards in the DOM. Visibility depends on viewport width.

At tablet/mobile-like viewport around `932x866`:

```text
div.CreatedAssetsTable_table__HRv5q.createdAssets_table__CWPxo
display: none

div.createdAssets_cards__jhGwp
display: block
```

At desktop viewport `1440x951`:

```text
div.CreatedAssetsTable_table__HRv5q.createdAssets_table__CWPxo
display: block

div.createdAssets_cards__jhGwp
display: none
```

Puppeteer's configured viewport is currently `1280x800`, so the automation should normally hit the desktop table. The implementation still supports both visible layouts.

Useful desktop row shape:

```text
table > tbody > tr.cfxui__DataTable__pointer__91cb4
```

Desktop row cells:

```json
[
  "",
  "944842",
  "jo_chest 2",
  "08/06/2026 17:27:05",
  "ACTIVE",
  "DOWNLOAD"
]
```

Per-row controls:

```text
button role="checkbox" aria-label="<rowIndex>"
button text="DOWNLOAD"
icon-only button exposed as "View versions"
```

Responsive card class:

```text
ListCard_root__ThgNO CreatedAssetsCards_card__x8ZTv cfxui__Interactive__root__83e14
```

Responsive card text shape:

```text
ASSET ID 944842 ASSET NAME jo_chest 2 LAST UPDATED ... DOWNLOAD ACTIVE
```

## Selection Behavior

Before selecting an asset:

- `ADD ASSET` is visible.
- `DEPRECATE` is visible but disabled in desktop.
- A mobile/sticky `UPLOAD NEW VERSION` may exist in the DOM but can be hidden.

After selecting an asset:

- The matching checkbox gets `aria-checked="true"`.
- The checkbox class includes:

```text
cfxui__Checkbox__isChecked__e5d94
```

- `ADD ASSET` is replaced by `UPLOAD NEW VERSION`.
- `DEPRECATE` becomes enabled.

Selection is mirrored across hidden/visible responsive DOM variants.

## New Version Modal

Clicking `UPLOAD NEW VERSION` changes the URL to a modal-backed route:

```text
/assets/created-assets?page=1&sort=asset.id&direction=desc&row=2&id=944842&name=jo_chest+2&modal=reupload
```

Modal root:

```text
#overlay-outlet
  div.cfxui__Overlay__root__7221c
    div.cfxui__Overlay__content__002f3
      div.cfxui__Modal__root__53283
```

Initial modal text:

```text
New Asset Version
ASSET NAME * jo_chest 2
Drag and Drop file here or Choose file.
ASSET VERSION TYPE *
Full Release
Release Candidate / Beta
ASSET VERSION *
No versions detected
Select...
CANCEL
NEXT
```

Hidden file input:

```html
<input multiple="" tabindex="-1" type="file" style="display: none;">
```

Puppeteer can upload directly to:

```js
const input = await page.$('#overlay-outlet input[type="file"]');
await input.uploadFile(zipPath);
```

Default version type:

```text
Full Release
```

The active toggle class includes:

```text
cfxui__ToggleGroup__active__84da0
```

Before file parsing completes:

- `NEXT` is disabled.
- The version dropdown is disabled.
- Modal may show `No versions detected`.

## ZIP Parsing Behavior

After uploading `jo_chest.zip`, the UI parses metadata client-side.

Transient state can show:

```text
No games detected - upload a zip with an fxmanifest.lua
No versions detected
Version is required. Please specify a version in your fxmanifest.lua.
```

This can be temporary. Do not fail immediately on this text.

Stable successful parsing state:

```text
jo_chest.zip
GAME VERSION RedM
ASSET VERSION 1 version found
1.1.2
NEXT enabled
```

Observed file details:

```text
file: jo_chest.zip
size: 514675 bytes
browser type: application/x-zip-compressed
```

No upload network request is sent during file selection. Parsing appears client-side.

Opening the modal triggers asset details:

```text
GET https://portal-api.cfx.re/v1/assets/944842
```

## Duplicate Version Behavior

After uploading `1.1.2` once, rerunning orchestration with the same GitHub release failed because CFX requires a unique `fxmanifest.lua` version.

Modal text:

```text
This version already exists. Please update your fxmanifest.lua version to a unique version.
```

In this state:

- Game is detected as `RedM`.
- Version is detected as `1.1.2`.
- `NEXT` remains disabled.

Automation now detects this case and throws a clear error:

```text
CFX rejected ZIP version as duplicate. Update fxmanifest.lua to a unique version.
```

To successfully upload again, publish a release whose ZIP contains a unique version, for example `1.1.3`.

## Release Notes Step

After `NEXT`, the modal changes to a second step:

```text
New Asset Version
RELEASE NOTES *
textarea placeholder: Describe what changed in this version
BACK
UPLOAD FILE
```

Textarea DOM:

```html
<textarea
  class="cfxui__StyledTextarea__root__8c3b9 cfxui__Textarea__textarea__8ab29 cfxui__StyledTextarea__resize-none__e5b55"
  rows="5"
  placeholder="Describe what changed in this version"
></textarea>
```

`UPLOAD FILE` stays disabled until release notes are filled.

Current automation default release notes:

```text
Automated upload from cfx-uploader.
```

## Submit And Network Flow

Final submit button:

```text
UPLOAD FILE
```

Immediate UI after clicking:

```text
UPLOADING... 0%
```

The target row/card changes to:

```text
status CREATED
animated loader dots
```

Then the modal closes automatically and the URL loses `modal=reupload`.

Observed request sequence:

1. Create upload/version:

```text
POST https://portal-api.cfx.re/v1/assets/944842/re-upload
```

Observed request body:

```json
{
  "name": "jo_chest 2",
  "chunk_count": 4,
  "chunk_size": 128669,
  "total_size": 514675,
  "original_file_name": "jo_chest.zip",
  "release_candidate": false,
  "version": "1.1.2",
  "changelog": "Automation exploration test note - do not submit"
}
```

Observed response:

```json
{
  "asset_id": 944842,
  "version_id": 1436406,
  "errors": null
}
```

2. Upload chunks:

```text
POST https://portal-api.cfx.re/v1/assets/944842/versions/1436406/upload-chunk
```

Observed details:

- 4 chunks for the 514675 byte ZIP.
- `multipart/form-data`.
- form field `chunk_id`, starting at `0`.
- form field `chunk`, filename `blob`.

Example response:

```json
{
  "errors": null,
  "all_chunks_uploaded": false
}
```

3. Complete upload:

```text
POST https://portal-api.cfx.re/v1/assets/944842/versions/1436406/complete-upload
```

Response:

```json
{}
```

4. Poll/refresh:

```text
GET https://portal-api.cfx.re/v1/assets/944842
GET https://portal-api.cfx.re/v1/me/assets?page=1&search=&sort=asset.id&direction=desc
GET https://portal-api.cfx.re/v1/me/notifications
```

Post-upload state first became:

```text
state: created
chunk_status: [true, true, true, true]
```

Final UI state returned to:

```text
ACTIVE
```

The automation waits for the modal to close and the target asset to return to `ACTIVE`.

## Asset Versions Modal

Clicking `View versions` on `jo_chest 2` changes the URL:

```text
/assets/created-assets?page=1&sort=asset.id&direction=desc&row=2&assetId=944842&modal=asset-version
```

After the successful test upload, the modal showed:

```text
jo_chest 2
Asset Versions
2/5
V 1.1.2
Uploaded: 6/8/2026
Release Notes
DOWNLOAD
INITIAL VERSION
Uploaded: 4/3/2026
DOWNLOAD
CLOSE
UPLOAD NEW VERSION
```

`2/5` means 2 versions out of a maximum of 5.

Clicking `Release Notes` for `V 1.1.2` showed:

```text
Release Notes
V 1.1.2
Automation exploration test note - do not submit
Updated: 08/06/2026 17:27:04
```

This modal is useful for manual verification, but API/UI status checks are better for automation.

## Automation Changes Made

Updated:

```text
src/cfx/browser-upload.js
README.md
docs/cfx-portal-exploration.md
```

Added:

```text
docs/session-notes.md
```

Upload module changes:

- Replaced `RE-UPLOAD` lookup with `UPLOAD NEW VERSION`.
- Split asset filtering and asset selection.
- Added support for desktop table and responsive card layouts.
- Selects the nearest checkbox for the exact asset name.
- Uses `#overlay-outlet input[type="file"]` for ZIP upload.
- Waits for `NEXT` after ZIP parsing.
- Detects duplicate version error explicitly.
- Fills required release notes.
- Clicks final `UPLOAD FILE`.
- Waits for the modal to close and the asset to return to `ACTIVE`.

Public function kept:

```js
uploadZipToCfxAsset({ page, portalName, zipPath, releaseNotes });
```

`releaseNotes` is optional.

Default:

```text
Automated upload from cfx-uploader.
```

## Verification Runs

Syntax checks passed:

```text
node --check src\cfx\browser-upload.js
node -e "require('./src/cfx/browser-upload'); console.log('browser-upload require ok')"
```

Full orchestration was run twice after code changes.

Both runs reached the modal and parsed the ZIP, then failed because version `1.1.2` already exists:

```text
orchestrator failed: CFX rejected ZIP version as duplicate. Update fxmanifest.lua to a unique version.
```

This confirms:

- GitHub release download works.
- ZIP rebuild works.
- Passkey auth works.
- Asset search/selection works.
- `UPLOAD NEW VERSION` modal opens.
- File upload into modal works.
- ZIP parsing works.
- Duplicate-version detection works.

It does not confirm a fresh successful upload after the automation change, because no newer unique version was available.

Fresh upload workflow was then verified against a different dev asset using the same ZIP:

```text
asset: jo_chest 3
asset_id: 944844
zip: releases/jo_chest.zip
release_notes: Automated workflow verification from cfx-uploader.
```

Result:

```json
{
  "ok": true,
  "result": {
    "assetId": "944844",
    "assetName": "jo_chest 3",
    "lastUpdated": "08/06/2026 17:59:04",
    "status": "active"
  }
}
```

This confirms the updated `src/cfx/browser-upload.js` flow works end to end when the target asset does not already have the ZIP's parsed version.

## Operational Notes

If orchestration fails before a successful final upload, the generated ZIP is kept:

```text
releases/jo_chest.zip
```

If upload completes, the orchestrator deletes the generated ZIP after the upload flow and stabilization wait.

The working tree already had `.gitignore` modified before these changes. Current relevant new/modified files include:

```text
README.md
docs/cfx-portal-exploration.md
src/cfx/browser-upload.js
docs/session-notes.md
```

## Next Steps

To validate the final fresh-upload path end to end:

1. Publish or point to a GitHub release whose `fxmanifest.lua` version is unique.
2. Run:

```bash
npm run orchestrate
```

Expected result:

- ZIP parses with unique version.
- `NEXT` enables.
- Release notes are filled.
- `UPLOAD FILE` submits.
- Chunks upload.
- Asset returns to `ACTIVE`.
- Local generated ZIP is deleted.
