# CFX Portal UI Exploration

Exploration date: 2026-06-08

Target URL:

```text
https://portal.cfx.re/assets/created-assets?page=1&sort=asset.id&direction=desc
```

Scope:

- Explore the new CFX Portal `Created Assets` interface.
- Capture selectors, visible labels, DOM structure, action flow, loading behavior, and modal details useful for future Puppeteer automation.
- Initially avoid destructive actions; final submit was later explicitly allowed by the user and executed once for `jo_chest 2`.

Authentication notes:

- Chrome MCP required the forum email-login flow once.
- After the email login was confirmed, clicking `SIGN IN WITH` on `portal.cfx.re/login` redirected through `/authenticate?...sso=...` and landed on `Created Assets`.
- Puppeteer/passkey remains the more reliable automation path, but MCP is useful to inspect the current UI.

## Created Assets Page

Page title:

```text
Created Assets - Cfx.re Portal
```

Main heading:

```text
Created Assets
```

Visible summary:

```text
Manage your created assets here. You currently have 4 assets.
```

Visible controls:

- Search input accessible as `searchbox " Search by asset name"`.
- `ADD ASSET` button.
- Per-asset checkbox.
- Per-asset `DOWNLOAD` button.
- Per-asset `View versions` button.
- Global bottom actions:
  - `DEPRECATE`
  - `UPLOAD NEW VERSION`

Important UI change from old automation:

- The old flow expected a `RE-UPLOAD` button after selecting an asset.
- The new visible action is `UPLOAD NEW VERSION`.
- Assets are not exposed in the accessibility tree as a classic table. They appear as repeated card/list blocks with repeated labels (`ASSET ID`, `ASSET NAME`, `LAST UPDATED`) and controls.

Observed assets:

| Asset ID | Asset Name | Last Updated | Status |
|---:|---|---|---|
| 944872 | test other script name | 03/04/2026 15:38:16 | ACTIVE |
| 944844 | jo_chest 3 | 03/04/2026 15:03:52 | ACTIVE |
| 944842 | jo_chest 2 | 03/04/2026 18:19:59 | ACTIVE |
| 944602 | jo_chest | 03/04/2026 17:04:14 | ACTIVE |

Accessibility tree excerpt:

```text
heading "Created Assets" level="3"
searchbox " Search by asset name"
button "ADD ASSET"
checkbox
StaticText "ASSET ID"
StaticText "944872"
StaticText "ASSET NAME"
StaticText "test other script name"
StaticText "LAST UPDATED"
StaticText "03/04/2026 15:38:16"
button "DOWNLOAD"
button "View versions"
StaticText "ACTIVE"
...
button "DEPRECATE"
button "UPLOAD NEW VERSION"
```

## DOM Structure And Responsive Behavior

Runtime body class:

```text
body.cfxui-theme-cfx
```

The UI uses CSS-module-like hashed classes. These are useful for orientation, but should not be the primary selectors unless there is no better option.

Main observed layout classes:

```text
layout_layout__sPD1H
layout_page__hupER
createdAssets_root__3qKg0
CreatedAssetsTable_table__HRv5q
createdAssets_table__CWPxo
createdAssets_cards__jhGwp
ListCard_root__ThgNO
CreatedAssetsCards_card__x8ZTv
```

At the observed MCP viewport (`932x866`):

- The desktop table exists in the DOM but is hidden:

```text
div.CreatedAssetsTable_table__HRv5q.createdAssets_table__CWPxo
display: none
visible: false
```

- The responsive cards are visible:

```text
div.createdAssets_cards__jhGwp
display: block
visible: true
```

Visible card class:

```text
ListCard_root__ThgNO CreatedAssetsCards_card__x8ZTv cfxui__Interactive__root__83e14
```

Each visible card has text in this shape:

```text
ASSET ID 944842 ASSET NAME jo_chest 2 LAST UPDATED 03/04/2026 18:19:59 DOWNLOAD ACTIVE
```

Each card contains:

- A `button[role="checkbox"]`.
- A `DOWNLOAD` button.
- An icon-only secondary button. In the accessibility tree, this is exposed as `View versions`.

The desktop table rows still exist in the DOM:

```text
table > tbody > tr.cfxui__DataTable__pointer__91cb4
```

Each hidden desktop row contains:

- A `button[role="checkbox"][aria-label="0"]` style checkbox, where the label maps to row index.
- A `Download` button.
- An icon-only button with class `CreatedAssetsTable_modalButton__kWkoL`, likely the desktop `View versions` button.

Automation implication:

- A robust automation should not rely only on `table tbody tr` if the click target must be visible.
- The current Puppeteer viewport is `1280x800`, so it may see/click the desktop table instead of cards. This should be verified in Puppeteer.
- Better asset matching strategy:
  - Find visible cards by text at mobile/tablet widths.
  - Find `table tbody tr` by exact asset name at desktop widths.
  - Prefer matching exact asset name and nearest checkbox/button in the same row/card.

Visible global actions at `932x866`:

```text
ADD ASSET
DEPRECATE
UPLOAD NEW VERSION
```

The visible `DEPRECATE` and `UPLOAD NEW VERSION` actions were at the bottom of the viewport and appear fixed/sticky:

```text
DEPRECATE rect: x=0 y=866 width=452 height=46
UPLOAD NEW VERSION rect: x=472 y=866 width=452 height=46
```

One desktop/header `DEPRECATE` button is present but hidden and disabled:

```text
class: PageHeader_hideOnMobile__blRWn
disabled: true
visible: false
```

## Selecting An Asset

Clicking `UPLOAD NEW VERSION` with no selected asset:

- No modal opened.
- No useful URL change occurred.
- The visible mobile/sticky button does not necessarily have `disabled`, so the disabled attribute alone is not enough to infer readiness.

Selecting `jo_chest 2` by clicking its card checkbox:

```text
card text:
ASSET ID 944842 ASSET NAME jo_chest 2 LAST UPDATED 03/04/2026 18:19:59 DOWNLOAD ACTIVE
```

Checkbox state after click:

```text
aria-checked="true"
class includes cfxui__Checkbox__isChecked__e5d94
```

Selection is mirrored in both hidden desktop table checkbox and visible card checkbox:

```text
hidden table row checkbox index 2: aria-checked="true"
visible card checkbox index 6: aria-checked="true"
```

After selection, a header/page action `UPLOAD NEW VERSION` becomes visible near the top controls as well as the bottom mobile action.

## Opening New Version Modal

Clicking visible `UPLOAD NEW VERSION` after selecting `jo_chest 2` changed the URL:

```text
https://portal.cfx.re/assets/created-assets?page=1&sort=asset.id&direction=desc&row=2&id=944842&name=jo_chest+2&modal=reupload
```

Important automation implication:

- The modal state is URL-backed.
- Future automation may be able to navigate directly to:

```text
/assets/created-assets?page=1&sort=asset.id&direction=desc&row=<rowIndex>&id=<assetId>&name=<urlEncodedAssetName>&modal=reupload
```

This should still be treated carefully because the selected row state and modal state may be tied to client-side route data.

Modal accessibility snapshot:

```text
StaticText "New Asset Version"
StaticText "ASSET NAME"
StaticText "*"
StaticText "jo_chest 2"
generic
  StaticText "Drag and Drop file here or"
  StaticText "Choose file."
StaticText "ASSET VERSION TYPE"
StaticText "*"
button "Full Release"
button "Release Candidate / Beta"
StaticText "ASSET VERSION"
StaticText "*"
StaticText "No versions detected"
button "Select..." disabled expandable haspopup="menu"
button "CANCEL"
button "NEXT" disabled
```

Overlay/modal DOM:

```text
#overlay-outlet
  div.cfxui__Overlay__root__7221c
    div.cfxui__Overlay__content__002f3
      div.cfxui__Modal__root__53283
```

Modal text:

```text
New Asset Version ASSET NAME * jo_chest 2 Drag and Drop file here orChoose file. ASSET VERSION TYPE * Full Release Release Candidate / Beta ASSET VERSION * No versions detected Select... CANCEL NEXT
```

File input:

```html
<input multiple="" tabindex="-1" type="file" style="display: none;">
```

File dropzone:

```text
div.cfxui__InputDropzone__dropzone__bde8d
role="presentation"
tabindex="0"
text: Drag and Drop file here orChoose file.
```

Version type toggle:

```text
Full Release
class includes cfxui__ToggleGroup__active__84da0

Release Candidate / Beta
class does not include active class initially
```

Version dropdown before file selection:

```text
button text: Select...
id: radix-_r_0_
aria-haspopup="menu"
aria-expanded="false"
data-state="closed"
disabled
class includes:
  cfxui__DropdownSelect__trigger__c03df
  cfxui__DropdownSelect__placeholder__e0d89
  cfxui__DropdownSelect__fullWidth__dce56
```

Footer:

```text
div.cfxui__ButtonBar__bar__cf894.cfxui__Modal__footer__bb2fc.ModalResponsiveFooter_root__NGQnZ.ModalResponsiveFooter_initialOrderReverse__YQNN_
button CANCEL enabled
button NEXT disabled
```

Pre-file state:

- `NEXT` is disabled.
- Version dropdown is disabled.
- Body text says `No versions detected`.
- Default version type is `Full Release`.

## File Selection Behavior

MCP detail:

- The visible dropzone did not accept `upload_file` directly.
- The actual file input is hidden and not exposed as a normal accessibility node.
- To test with MCP, the input was temporarily made visible with:

```js
const input = document.querySelector('#overlay-outlet input[type="file"]');
input.id = 'codex-upload-input';
input.setAttribute('aria-label', 'Codex upload input');
input.style.display = 'block';
input.style.position = 'fixed';
input.style.zIndex = '2147483647';
input.style.left = '20px';
input.style.top = '20px';
input.style.width = '300px';
input.style.height = '40px';
input.tabIndex = 0;
```

For Puppeteer, this workaround should not be necessary. Use:

```js
const input = await page.$('#overlay-outlet input[type="file"]');
await input.uploadFile(zipPath);
```

Uploaded test file:

```text
releases/jo_chest.zip
size: 514675 bytes
browser file type: application/x-zip-compressed
browser value: C:\fakepath\jo_chest.zip
```

Immediate/transient state observed right after file selection:

```text
jo_chest.zip
GAME VERSION
No games detected - upload a zip with an fxmanifest.lua
ASSET VERSION
No versions detected
Version is required. Please specify a version in your fxmanifest.lua.
NEXT disabled
```

Stable state shortly afterward:

```text
jo_chest.zip
GAME VERSION
RedM
ASSET VERSION TYPE
Full Release
Release Candidate / Beta
ASSET VERSION
1 version found
1.1.2
CANCEL
NEXT
```

Stable button state:

```text
NEXT disabled: false
version dropdown disabled: false
version dropdown text: 1.1.2
Full Release active: true
```

Duplicate version state observed after uploading the same ZIP again:

```text
GAME VERSION
RedM
ASSET VERSION
1 version found
1.1.2
This version already exists. Please update your fxmanifest.lua version to a unique version.
NEXT disabled
```

Automation implication:

- If `NEXT` stays disabled, inspect modal text before timing out generically.
- If modal text contains `This version already exists`, fail with a clear duplicate-version error.
- CFX appears to require a unique `fxmanifest.lua` version for each new asset version.

Automation implication:

- After uploading the file, wait for `NEXT` to become enabled.
- Do not fail immediately if the modal briefly shows `No games detected` or `No versions detected`; this can be a transient parsing state.
- A robust wait condition is probably:

```js
await page.waitForFunction(() => {
  const modal = document.querySelector('#overlay-outlet');
  if (!modal) return false;
  const next = Array.from(modal.querySelectorAll('button'))
    .find((button) => button.textContent.trim().toLowerCase() === 'next');
  return next && !next.disabled;
});
```

Network around file selection:

- No upload request was observed after choosing the file.
- Opening the modal triggered:

```text
GET https://portal-api.cfx.re/v1/assets/944842
```

- File parsing appears client-side.

## Release Notes Step

Clicking `NEXT` after file parsing did not upload immediately. It moved to a second modal step:

```text
New Asset Version
RELEASE NOTES
*
textarea placeholder: Describe what changed in this version
BACK
UPLOAD FILE
```

Textarea DOM:

```html
<textarea
  class="cfxui__StyledTextarea__root__8c3b9 cfxui__Textarea__textarea__8ab29 cfxui__StyledTextarea__resize-none__e5b55"
  id="_r_2_"
  rows="5"
  placeholder="Describe what changed in this version"
></textarea>
```

Pre-release-notes state:

```text
UPLOAD FILE disabled: true
BACK disabled: false
textarea disabled: false
```

After entering release notes:

```text
UPLOAD FILE disabled: false
```

The final submit button:

```html
<button class="cfxui__Button__unsetAll__44b96 cfxui__Button__root__e2ace cfxui__Button__primary__1c59f cfxui__Button__fullWidth__f61d9" title="" type="button" aria-label="">Upload File</button>
```

Automation implication:

- The new upload flow is two-step:
  1. Choose ZIP, wait for parsed game/version and enabled `NEXT`.
  2. Fill release notes, wait for enabled `UPLOAD FILE`, then submit.
- Existing automation that clicked `Upload File` immediately after selecting a file is now incomplete.

## Final Submit Behavior

Test submit was allowed and executed against asset `944842` (`jo_chest 2`) with:

```text
version: 1.1.2
release_candidate: false
changelog: Automation exploration test note - do not submit
file: jo_chest.zip
```

Immediate UI after clicking `UPLOAD FILE`:

```text
textarea disabled
BACK disabled
UPLOAD FILE disabled
UPLOADING... 0%
```

The selected asset row/card changed immediately:

```text
LAST UPDATED 08/06/2026 17:27:05
status CREATED
visible animated loader dots: . . .
```

The modal then closed automatically and URL changed from:

```text
...?row=2&id=944842&name=jo_chest+2&modal=reupload
```

to:

```text
...?row=2
```

Network sequence:

1. Create upload/version:

```text
POST https://portal-api.cfx.re/v1/assets/944842/re-upload
```

Request body:

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

Response:

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

Observed 4 chunk uploads for the 514675 byte ZIP.

Chunk request details:

- `content-type: multipart/form-data`
- form field `chunk_id`, starting at `0`
- form field `chunk`, filename `blob`
- first response:

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

4. Refresh/poll:

```text
GET https://portal-api.cfx.re/v1/assets/944842
GET https://portal-api.cfx.re/v1/me/assets?page=1&search=&sort=asset.id&direction=desc
GET https://portal-api.cfx.re/v1/me/notifications
```

Post-upload asset detail shortly after submit:

```json
{
  "id": 944842,
  "name": "jo_chest 2",
  "state": "created",
  "chunk_status": [true, true, true, true],
  "updated_at": "2026-06-08T15:27:05Z",
  "versions": [
    {
      "id": 1436406,
      "version": "1.1.2",
      "state": "created",
      "created_at": "2026-06-08T15:27:04Z",
      "changelog": "Automation exploration test note - do not submit",
      "is_release_candidate": false,
      "packs": []
    },
    {
      "id": 1261185,
      "version": "0.0.0",
      "state": "active",
      "created_at": "2026-04-03T16:19:59Z",
      "changelog": "",
      "is_release_candidate": false,
      "packs": [
        {
          "id": 1129734,
          "game": ""
        }
      ]
    }
  ]
}
```

Final visible page state after additional polling:

```text
ASSET ID 944842
ASSET NAME jo_chest 2
LAST UPDATED 08/06/2026 17:27:05
DOWNLOAD
ACTIVE
```

Automation implication:

- The current code can still delete the ZIP after the final upload click, but it should wait until the final `UPLOAD FILE` click, not the first modal step.
- A stronger success check can watch for:
  - modal disappears,
  - URL no longer includes `modal=reupload`,
  - target asset status becomes `ACTIVE`,
  - or `GET /v1/assets/<assetId>` reports the new version and chunk_status all true.

## Asset Versions Modal

Clicking `View versions` on `jo_chest 2` changed the URL:

```text
https://portal.cfx.re/assets/created-assets?page=1&sort=asset.id&direction=desc&row=2&assetId=944842&modal=asset-version
```

Modal text after the test upload:

```text
jo_chest 2 Asset Versions 2/5 V 1.1.2 Uploaded: 6/8/2026 Release Notes DOWNLOAD INITIAL VERSION Uploaded: 4/3/2026 DOWNLOAD CLOSE UPLOAD NEW VERSION
```

Meaning:

- `2/5` indicates 2 versions out of a maximum of 5.
- Latest version appears first as `V 1.1.2`.
- Initial version appears as `INITIAL VERSION`.

Buttons in version modal:

- close icon button
- `Release Notes`
- per-version `DOWNLOAD`
- several icon-only buttons, likely version actions
- `CLOSE`
- `UPLOAD NEW VERSION`

Version modal classes:

```text
AssetVersionModal_releaseNotes__u8_Vx
AssetVersionModal_closeButton___k2Iq
```

Clicking `Release Notes` for `V 1.1.2` changes the modal body to:

```text
Release Notes
V 1.1.2
Automation exploration test note - do not submit
Updated: 08/06/2026 17:27:04
```

Network for opening versions:

```text
GET https://portal.cfx.re/assets/created-assets.txt?page=1&sort=asset.id&direction=desc&row=2&assetId=944842&modal=asset-version&_rsc=...
GET https://portal-api.cfx.re/v1/assets/944842
```

Automation implication:

- `View versions` can be used as an optional verification path after upload.
- API verification is cleaner and less fragile than parsing this modal.

## Desktop Viewport Verification

Desktop verification date: 2026-06-08

Viewport:

```text
1440x951
```

Result:

- The same upload flow and modal behavior were observed.
- The main difference is layout: desktop exposes the table visibly, while responsive cards are hidden.

Visible desktop accessibility tree shape:

```text
tab "Assets" selected
tab "Created Assets" selected
heading "Created Assets"
searchbox " Search by asset name"
button "DEPRECATE" disabled
button "ADD ASSET"
columnheader "Select Row"
StaticText "ASSET ID"
StaticText "ASSET NAME"
StaticText "LAST UPDATED"
StaticText "STATUS"
StaticText "DOWNLOAD"
checkbox "0"
StaticText "944872"
StaticText "test other script name"
...
checkbox "2"
StaticText "944842"
StaticText "jo_chest 2"
StaticText "08/06/2026 17:27:05"
StaticText "ACTIVE"
button "DOWNLOAD"
button "View versions"
```

Desktop DOM visibility:

```text
div.CreatedAssetsTable_table__HRv5q.createdAssets_table__CWPxo
display: block
visible: true
rect: x=72 y=397 width=1296 height=350

div.createdAssets_cards__jhGwp
display: none
visible: false
```

Visible desktop rows:

```text
table > tbody > tr.cfxui__DataTable__pointer__91cb4
```

Row cells at desktop:

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
button role="checkbox" aria-label="<rowIndex>" aria-checked="false"
button text="DOWNLOAD"
icon-only button exposed as "View versions"
```

Before selecting an asset:

```text
DEPRECATE visible: true, disabled: true
ADD ASSET visible: true
UPLOAD NEW VERSION mobile/sticky button exists in DOM but visible: false
```

After selecting row `2` / asset `944842`:

```text
checkbox "2" checked
DEPRECATE visible and enabled
ADD ASSET is replaced by UPLOAD NEW VERSION
```

Opening `UPLOAD NEW VERSION` on desktop:

```text
URL:
https://portal.cfx.re/assets/created-assets?page=1&sort=asset.id&direction=desc&row=2&id=944842&name=jo_chest+2&modal=reupload
```

Desktop modal:

```text
modal rect: x=417 y=155 width=600 height=643
overlay root: cfxui__Overlay__root__7221c
overlay backdrop: cfxui__Overlay__backdrop__bc193 cfxui__Interactive__root__83e14
modal root: cfxui__Modal__root__53283
```

Desktop modal text:

```text
New Asset Version ASSET NAME * jo_chest 2 Drag and Drop file here orChoose file. ASSET VERSION TYPE * Full Release Release Candidate / Beta ASSET VERSION * No versions detected Select... CANCEL NEXT
```

Desktop modal file input:

```html
<input multiple="" tabindex="-1" type="file" style="display: none;">
```

Desktop modal buttons:

```text
close icon button
Full Release enabled active
Release Candidate / Beta enabled
Select... disabled
CANCEL enabled
NEXT disabled
```

Desktop conclusion:

- The notes from the first exploration are accurate for the actual flow.
- For Puppeteer's current `1280x800` viewport, automation should expect the desktop table path, not the responsive card path.
- The most robust implementation should still support both layouts by detecting the visible container.

## Asset Version Cap And Delete Flow

Exploration date: 2026-06-10

Target asset:

```text
Asset name: CFX Uploader Test
Asset id: 1016632
```

Observed cap:

```text
Maximum versions: 5
```

When the asset has 5 versions, CFX rejects HTTP upload creation:

```text
POST https://portal-api.cfx.re/v1/assets/1016632/re-upload
409 {"error":"asset has reached the maximum number of versions","error_code":"MAX_VERSIONS_REACHED"}
```

In the UI version modal:

```text
Asset Versions 5/5
UPLOAD NEW VERSION disabled
```

Hover tooltip observed on disabled upload button:

```text
This asset has reached the maximum of 5 versions.
Delete an existing version to upload a new one.
```

### Asset Details Shape

`GET /v1/assets/:assetId` returns versions sorted newest-first.

Relevant response shape:

```json
{
  "id": 1016632,
  "name": "CFX Uploader Test",
  "state": "active",
  "chunk_status": [true, true, true, true],
  "updated_at": "2026-06-10T12:18:27Z",
  "is_disabled": false,
  "disabled_reason": null,
  "versions": [
    {
      "id": 1440896,
      "version": "1.0.3",
      "state": "active",
      "created_at": "2026-06-10T12:18:27Z",
      "changelog": "Release 1.0.3",
      "is_release_candidate": false,
      "packs": [{ "id": 1278197, "game": "" }]
    }
  ]
}
```

Observed versions before deletion:

| Order | Version | Version ID | Created At | Release Candidate |
|---:|---|---:|---|---|
| 1 | 1.0.3 | 1440896 | 2026-06-10T12:18:27Z | false |
| 2 | 1.0.2 | 1440894 | 2026-06-10T12:16:25Z | false |
| 3 | 1.0.2.beta | 1440888 | 2026-06-10T12:12:26Z | true |
| 4 | 1.0.1 | 1440727 | 2026-06-10T09:54:11Z | false |
| 5 | 1.0.0 | 1438376 | 2026-06-09T12:26:32Z | false |

Automation should pick the oldest version by the lowest `created_at`. The current API order also places oldest last, but `created_at` is the safer rule.

### Version Modal DOM

Open version modal from the created-assets table using the icon-only button:

```html
<button title="View versions" class="... CreatedAssetsTable_modalButton__kWkoL ...">
```

Modal text at cap:

```text
CFX Uploader Test
Asset Versions
5/5
V 1.0.3
Uploaded: 6/10/2026
Release Notes
DOWNLOAD
...
V 1.0.0
Uploaded: 6/9/2026
DOWNLOAD
CLOSE
UPLOAD NEW VERSION
```

Each version row uses:

```text
AssetVersionModal_versionRow__8UHJ0
```

Inside a row:

```text
button text="Download"
icon-only button: delete/trash
icon-only button: edit pencil
```

The delete/trash button has no stable text, title, or aria-label. It can be identified by the SVG path prefix:

```text
M13 4.25H10.75V3C10.75...
```

The edit pencil button has SVG path prefix:

```text
M2.99002 13.76C2.79002...
```

For browser automation, the robust approach is:

1. Open the versions modal.
2. Find a row containing exact text `V <version>`.
3. Find closest `[class*="AssetVersionModal_versionRow"]`.
4. Click the icon button whose `path[d]` starts with `M13 4.25`.

### Delete Confirmation

Clicking the trash button opens a confirmation modal:

```text
Delete version?
Are you sure you want to delete version 1.0.0?
This action cannot be undone.
CANCEL
DELETE
```

Confirmation buttons:

```text
Cancel
Delete
```

The `Delete` button is a normal text button:

```html
<button class="... cfxui__Button__primary__1c59f ...">Delete</button>
```

### Delete HTTP Endpoint

Deleting version `1.0.0` from asset `1016632` called:

```http
DELETE https://portal-api.cfx.re/v1/assets/1016632/versions/1438376
```

Request body:

```text
none
```

Observed browser network:

```text
OPTIONS /v1/assets/1016632/versions/1438376 -> 204
DELETE  /v1/assets/1016632/versions/1438376 -> 200 {}
GET     /v1/assets/1016632                 -> 200 updated asset details
```

The existing CFX HTTP session headers used for upload should be valid for this endpoint:

```text
origin: https://portal.cfx.re
referer: https://portal.cfx.re/
cookie: <portal cookies>
user-agent: <browser UA>
```

### Post Delete State

After deleting oldest version `1.0.0`:

```text
Asset Versions 4/5
UPLOAD NEW VERSION enabled
```

`GET /v1/assets/1016632` returned:

| Order | Version | Version ID | Created At | Release Candidate |
|---:|---|---:|---|---|
| 1 | 1.0.3 | 1440896 | 2026-06-10T12:18:27Z | false |
| 2 | 1.0.2 | 1440894 | 2026-06-10T12:16:25Z | false |
| 3 | 1.0.2.beta | 1440888 | 2026-06-10T12:12:26Z | true |
| 4 | 1.0.1 | 1440727 | 2026-06-10T09:54:11Z | false |

### Automation Notes

Recommended option name:

```text
deleteOldestVersionWhenCapped
```

Default should be `false` because deleting versions is destructive.

HTTP mode recommended behavior:

1. Attempt normal `POST /v1/assets/:assetId/re-upload`.
2. If response is not `MAX_VERSIONS_REACHED`, keep current behavior.
3. If response is `MAX_VERSIONS_REACHED` and `deleteOldestVersionWhenCapped !== true`, fail clearly.
4. If enabled:
   - fetch latest `GET /v1/assets/:assetId`;
   - select oldest version by `created_at`;
   - `DELETE /v1/assets/:assetId/versions/:versionId`;
   - refetch asset details until version count decreases;
   - retry `POST /re-upload` once.

Browser mode recommended behavior:

1. Detect disabled `UPLOAD NEW VERSION` in versions modal.
2. If auto-delete is disabled, fail with tooltip/cap message.
3. If enabled, delete the oldest row using the trash icon path.
4. Confirm `Delete`.
5. Wait for `Asset Versions 4/5` or enabled `UPLOAD NEW VERSION`.
6. Continue upload flow.
