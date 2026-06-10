/**
 * Module responsibility:
 * Find target asset on CFX portal and execute the new upload-version modal flow.
 */
const fs = require('fs/promises');

const DEFAULT_RELEASE_NOTES = 'Automated upload from cfx-uploader.';
const MAX_VERSIONS_MESSAGE = 'CFX asset has reached the maximum of 5 versions. Enable deleteOldestVersionWhenCapped to delete the oldest version automatically.';
const TRASH_ICON_PATH_PREFIX = 'M13 4.25H10.75V3C10.75';

/**
 * Helper wait used for client-side table filtering/render refresh.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect transient Puppeteer errors caused by navigation replacing the execution context.
 * @param {unknown} error
 * @returns {boolean}
 */
function isNavigationContextError(error) {
  const message = String(error && error.message ? error.message : error).toLowerCase();
  return (
    message.includes('execution context was destroyed') ||
    message.includes('most likely because of a navigation') ||
    message.includes('cannot find context with specified id') ||
    message.includes('detached frame')
  );
}

/**
 * Retry operation when navigation temporarily invalidates Puppeteer execution context.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{ retries?: number, retryDelayMs?: number }} [options]
 * @returns {Promise<T>}
 */
async function retryOnNavigationContext(operation, options = {}) {
  const { retries = 4, retryDelayMs = 250 } = options;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isNavigationContextError(error) || attempt === retries) {
        throw error;
      }
      await sleep(retryDelayMs);
    }
  }

  throw new Error('Unexpected retry flow termination.');
}

/**
 * Type into "Search by asset name".
 * @param {{ page: import('puppeteer').Page, assetName: string }} options
 * @returns {Promise<void>}
 */
async function filterByAssetName(options) {
  const { page, assetName } = options;
  const searchInputSelector = 'input[placeholder*="Search by asset name"]';

  const hasSearchInput = await retryOnNavigationContext(() =>
    page.waitForFunction(() => {
      const inputs = document.querySelectorAll('input[placeholder]');
      for (const input of inputs) {
        const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
        if (placeholder.includes('search by asset name')) return true;
      }
      return false;
    }, { timeout: 30000 })
  )
    .then(() => true)
    .catch(() => false);

  if (!hasSearchInput) {
    throw new Error('Search input not found on CFX asset page.');
  }

  let input = await page.$(searchInputSelector);
  if (!input) {
    // Fallback tag if direct selector misses due to transient rerender.
    const tagged = await retryOnNavigationContext(() =>
      page.evaluate(() => {
        const inputs = document.querySelectorAll('input[placeholder]');
        for (const el of inputs) {
          const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
          if (placeholder.includes('search by asset name')) {
            el.setAttribute('data-codex-search-input', 'true');
            return true;
          }
        }
        return false;
      })
    );

    if (tagged) {
      input = await page.$('input[data-codex-search-input="true"]');
    }
  }

  if (!input) {
    throw new Error('Search input handle could not be created.');
  }

  await input.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await input.type(assetName);

  // Filtering is async and can lag behind text input updates.
  await sleep(5000);
}

/**
 * Select the exact asset in either desktop table or responsive cards.
 * @param {{ page: import('puppeteer').Page, assetName: string }} options
 * @returns {Promise<void>}
 */
async function selectAssetByName(options) {
  const { page, assetName } = options;

  const found = await retryOnNavigationContext(() =>
    page.waitForFunction(
      (expectedName) => {
        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const getText = (element) => normalize(element.innerText || element.textContent || '');
        const getCardAssetName = (card) => {
          const match = getText(card).match(/ASSET NAME\s+(.+?)\s+LAST UPDATED/i);
          return match ? normalize(match[1]) : '';
        };
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          );
        };

        const rows = Array.from(document.querySelectorAll('table tbody tr')).filter(isVisible);
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 3 && normalize(cells[2].textContent) === expectedName) {
            return true;
          }
        }

        const cards = Array.from(
          document.querySelectorAll('.ListCard_root__ThgNO, .CreatedAssetsCards_card__x8ZTv')
        ).filter(isVisible);

        for (const card of cards) {
          if (getCardAssetName(card) === expectedName) {
            return true;
          }
        }

        return false;
      },
      { timeout: 30000 },
      assetName
    )
  )
    .then(() => true)
    .catch(() => false);

  if (!found) {
    throw new Error(`Asset "${assetName}" not found after filtering.`);
  }

  const selected = await retryOnNavigationContext(() =>
    page.evaluate((expectedName) => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const getText = (element) => normalize(element.innerText || element.textContent || '');
      const getCardAssetName = (card) => {
        const match = getText(card).match(/ASSET NAME\s+(.+?)\s+LAST UPDATED/i);
        return match ? normalize(match[1]) : '';
      };
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      };
      const selectCheckbox = (container) => {
        const checkbox = Array.from(container.querySelectorAll('button,[role="checkbox"]')).find(
          (element) => element.getAttribute('role') === 'checkbox'
        );
        if (!checkbox) return false;
        if (checkbox.getAttribute('aria-checked') !== 'true') {
          checkbox.click();
        }
        return true;
      };

      const rows = Array.from(document.querySelectorAll('table tbody tr')).filter(isVisible);
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3 && normalize(cells[2].textContent) === expectedName) {
          return selectCheckbox(row);
        }
      }

      const cards = Array.from(
        document.querySelectorAll('.ListCard_root__ThgNO, .CreatedAssetsCards_card__x8ZTv')
      ).filter(isVisible);

      for (const card of cards) {
        if (getCardAssetName(card) === expectedName) {
          return selectCheckbox(card);
        }
      }

      return false;
    }, assetName)
  );

  if (!selected) {
    throw new Error(`Failed to select asset "${assetName}".`);
  }
}

/**
 * Click the UPLOAD NEW VERSION action button shown after selecting an asset.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<void>}
 */
async function getUploadNewVersionButtonState(page) {
  return retryOnNavigationContext(() =>
    page.evaluate(() => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      const buttons = Array.from(document.querySelectorAll('button'));
      const button = buttons.find((candidate) =>
        normalize(candidate.textContent).toLowerCase() === 'upload new version' &&
        isVisible(candidate)
      );

      if (!button) {
        return { found: false, enabled: false, text: '' };
      }

      const modal = document.querySelector('#overlay-outlet');
      return {
        found: true,
        enabled: !button.disabled && !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true',
        text: modal ? normalize(modal.innerText || modal.textContent || '') : normalize(document.body.innerText || ''),
      };
    })
  );
}

async function waitForUploadNewVersionButtonEnabled(page) {
  return retryOnNavigationContext(() =>
    page.waitForFunction(() => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      const buttons = Array.from(document.querySelectorAll('button'));
      return buttons.some((button) =>
        normalize(button.textContent) === 'upload new version' &&
        isVisible(button) &&
        !button.disabled &&
        !button.hasAttribute('disabled') &&
        button.getAttribute('aria-disabled') !== 'true' &&
        !button.className.includes('disabled')
      );
    }, { timeout: 30000 })
  );
}

async function deleteOldestVisibleVersionFromModal(page) {
  const deletionTarget = await retryOnNavigationContext(() =>
    page.evaluate((trashIconPathPrefix) => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const parseUploadedDate = (text) => {
        const match = text.match(/Uploaded:\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})/i);
        if (!match) return Number.NaN;
        const [month, day, year] = match[1].split('/').map(Number);
        return new Date(year, month - 1, day).getTime();
      };
      const extractVersion = (text) => {
        const match = text.match(/\bV\s+([^\s]+)/i);
        return match ? match[1] : 'unknown';
      };
      const rows = Array.from(document.querySelectorAll('[class*="AssetVersionModal_versionRow"]'))
        .filter(isVisible)
        .map((row, index) => ({
          row,
          index,
          text: normalize(row.innerText || row.textContent || ''),
          uploadedAt: parseUploadedDate(row.innerText || row.textContent || ''),
        }));

      if (rows.length === 0) {
        return { clicked: false, reason: 'No visible asset version rows found.' };
      }

      rows.sort((a, b) => {
        const aTime = Number.isNaN(a.uploadedAt) ? Number.POSITIVE_INFINITY : a.uploadedAt;
        const bTime = Number.isNaN(b.uploadedAt) ? Number.POSITIVE_INFINITY : b.uploadedAt;
        if (aTime !== bTime) return aTime - bTime;
        return b.index - a.index;
      });

      const target = rows[0];
      const buttons = Array.from(target.row.querySelectorAll('button'));
      const deleteButton = buttons.find((button) => {
        const path = button.querySelector('svg path');
        return path && (path.getAttribute('d') || '').startsWith(trashIconPathPrefix);
      });

      if (!deleteButton) {
        return { clicked: false, reason: `Delete button not found for row: ${target.text}` };
      }

      deleteButton.click();
      return {
        clicked: true,
        version: extractVersion(target.text),
        rowText: target.text,
      };
    }, TRASH_ICON_PATH_PREFIX)
  );

  if (!deletionTarget.clicked) {
    throw new Error(`Failed to delete oldest CFX version in browser flow: ${deletionTarget.reason}`);
  }

  const confirmReady = await retryOnNavigationContext(() =>
    page.waitForFunction(() => {
      const overlay = document.querySelector('#overlay-outlet');
      if (!overlay) return false;
      const text = (overlay.innerText || overlay.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return text.includes('delete version?') && text.includes('this action cannot be undone');
    }, { timeout: 10000 })
  )
    .then(() => true)
    .catch(() => false);

  if (!confirmReady) {
    throw new Error(`Delete confirmation modal did not open for CFX version ${deletionTarget.version}.`);
  }

  const confirmed = await retryOnNavigationContext(() =>
    page.evaluate(() => {
      const overlay = document.querySelector('#overlay-outlet');
      if (!overlay) return false;
      const buttons = Array.from(overlay.querySelectorAll('button'));
      const deleteButton = buttons.find((button) =>
        (button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase() === 'delete'
      );
      if (!deleteButton || deleteButton.disabled) return false;
      deleteButton.click();
      return true;
    })
  );

  if (!confirmed) {
    throw new Error(`Failed to confirm deletion for CFX version ${deletionTarget.version}.`);
  }

  await retryOnNavigationContext(() =>
    page.waitForFunction(
      (deletedVersion) => {
        const overlay = document.querySelector('#overlay-outlet');
        if (!overlay) return false;

        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const text = normalize(overlay.innerText || overlay.textContent || '');
        const uploadButtonEnabled = Array.from(overlay.querySelectorAll('button')).some((button) =>
          normalize(button.textContent) === 'upload new version' &&
          !button.disabled &&
          !button.hasAttribute('disabled') &&
          button.getAttribute('aria-disabled') !== 'true' &&
          !button.className.includes('disabled')
        );

        return text.includes('asset versions 4/5') || (uploadButtonEnabled && !text.includes('maximum of 5 versions'));
      },
      { timeout: 30000 },
      deletionTarget.version
    )
  ).catch(async (error) => {
    const modalText = await page
      .evaluate(() => {
        const overlay = document.querySelector('#overlay-outlet');
        return overlay ? (overlay.innerText || overlay.textContent || '').replace(/\s+/g, ' ').trim() : '';
      })
      .catch(() => '');
    throw new Error(`Timed out waiting for CFX version deletion in browser flow. Deleted version: ${deletionTarget.version}. Modal text: ${modalText || error.message}`);
  });

  await waitForUploadNewVersionButtonEnabled(page).catch(async (error) => {
    const modalText = await page
      .evaluate(() => {
        const overlay = document.querySelector('#overlay-outlet');
        return overlay ? (overlay.innerText || overlay.textContent || '').replace(/\s+/g, ' ').trim() : '';
      })
      .catch(() => '');
    throw new Error(`Timed out waiting for UPLOAD NEW VERSION to become enabled after deletion. Modal text: ${modalText || error.message}`);
  });
  await sleep(3000);
  return deletionTarget;
}

async function handleCappedUploadModalIfNeeded(page, options = {}) {
  const { deleteOldestVersionWhenCapped = false } = options;
  const cappedModal = await retryOnNavigationContext(() =>
    page.evaluate(() => {
      const overlay = document.querySelector('#overlay-outlet');
      if (!overlay) {
        return { capped: false, text: '' };
      }

      const text = (overlay.innerText || overlay.textContent || '').replace(/\s+/g, ' ').trim();
      const normalized = text.toLowerCase();

      return {
        capped: normalized.includes('this asset has reached the maximum of 5 versions'),
        text,
      };
    })
  );

  if (!cappedModal.capped) {
    return false;
  }

  if (!deleteOldestVersionWhenCapped) {
    throw new Error(`${MAX_VERSIONS_MESSAGE} Modal text: ${cappedModal.text}`);
  }

  const openedVersions = await retryOnNavigationContext(() =>
    page.evaluate(() => {
      const overlay = document.querySelector('#overlay-outlet');
      if (!overlay) return false;

      const buttons = Array.from(overlay.querySelectorAll('button'));
      const viewVersionsButton = buttons.find((button) =>
        (button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase() === 'view versions'
      );

      if (!viewVersionsButton || viewVersionsButton.disabled) {
        return false;
      }

      viewVersionsButton.click();
      return true;
    })
  );

  if (!openedVersions) {
    throw new Error(`CFX asset is capped, but the VIEW VERSIONS button could not be clicked. Modal text: ${cappedModal.text}`);
  }

  await retryOnNavigationContext(() =>
    page.waitForFunction(() => {
      const overlay = document.querySelector('#overlay-outlet');
      if (!overlay) return false;
      const text = (overlay.innerText || overlay.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return text.includes('asset versions');
    }, { timeout: 30000 })
  ).catch(async (error) => {
    const modalText = await page
      .evaluate(() => {
        const overlay = document.querySelector('#overlay-outlet');
        return overlay ? (overlay.innerText || overlay.textContent || '').replace(/\s+/g, ' ').trim() : '';
      })
      .catch(() => '');
    throw new Error(`Timed out waiting for CFX versions modal after VIEW VERSIONS. Modal text: ${modalText || error.message}`);
  });

  const deletedVersion = await deleteOldestVisibleVersionFromModal(page);
  console.log(`Deleted oldest CFX version in browser flow before retry: version=${deletedVersion.version}`);

  return true;
}

async function clickUploadNewVersionButton(page, options = {}) {
  const { deleteOldestVersionWhenCapped = false } = options;
  const found = await retryOnNavigationContext(() =>
    page.waitForFunction(() => {
      const buttons = document.querySelectorAll('button');
      for (const button of buttons) {
        const label = (button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const visible =
          !!button &&
          button.getClientRects().length > 0 &&
          getComputedStyle(button).visibility !== 'hidden' &&
          getComputedStyle(button).display !== 'none';
          const enabled = !button.disabled && !button.hasAttribute('disabled');
        if (label === 'upload new version' && visible && enabled && button.getAttribute('aria-disabled') !== 'true' && !button.className.includes('disabled')) return true;
      }
      return false;
    }, { timeout: 30000 })
  )
    .then(() => true)
    .catch(() => false);

  if (!found) {
    const buttonState = await getUploadNewVersionButtonState(page);

    if (buttonState.found && !buttonState.enabled) {
      if (!deleteOldestVersionWhenCapped) {
        throw new Error(`${MAX_VERSIONS_MESSAGE} Modal text: ${buttonState.text}`);
      }

      const deletedVersion = await deleteOldestVisibleVersionFromModal(page);
      console.log(`Deleted oldest CFX version in browser flow before retry: version=${deletedVersion.version}`);
    } else {
      throw new Error('UPLOAD NEW VERSION button not found after selecting asset.');
    }
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const clicked = await retryOnNavigationContext(() =>
      page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const button of buttons) {
          const label = (button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const visible =
            !!button &&
            button.getClientRects().length > 0 &&
            getComputedStyle(button).visibility !== 'hidden' &&
            getComputedStyle(button).display !== 'none';
          const enabled = !button.disabled && !button.hasAttribute('disabled');
          if (label === 'upload new version' && visible && enabled && button.getAttribute('aria-disabled') !== 'true' && !button.className.includes('disabled')) {
            button.click();
            return true;
          }
        }
        return false;
      })
    );

    if (!clicked) {
      throw new Error('Failed to click UPLOAD NEW VERSION button.');
    }

    // Modal is URL-backed and can open with slight delay after route update.
    const modalOpened = await page
      .waitForSelector('#overlay-outlet .cfxui__Modal__root__53283, #overlay-outlet input[type="file"]', {
        timeout: 5000,
      })
      .then(() => true)
      .catch(() => false);

    if (modalOpened) {
      return;
    }

    await sleep(600);
  }

  throw new Error('UPLOAD NEW VERSION clicked but upload modal did not open.');
}

/**
 * Select CFX version type in the new-version modal.
 * @param {{ page: import('puppeteer').Page, releaseCandidate: boolean }} options
 * @returns {Promise<void>}
 */
async function selectReleaseTypeInModal(options) {
  const { page, releaseCandidate } = options;
  const expectedLabel = releaseCandidate ? 'release candidate / beta' : 'full release';

  const found = await retryOnNavigationContext(() =>
    page.waitForFunction(
      (label) => {
        const modal = document.querySelector('#overlay-outlet');
        if (!modal) return false;

        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };

        const candidates = modal.querySelectorAll('button,[role="button"],[role="radio"],[role="tab"],label');
        for (const candidate of candidates) {
          if (isVisible(candidate) && normalize(candidate.textContent) === label) {
            return true;
          }
        }

        return false;
      },
      { timeout: 30000 },
      expectedLabel
    )
  )
    .then(() => true)
    .catch(() => false);

  if (!found) {
    const modalText = await page
      .evaluate(() => {
        const modal = document.querySelector('#overlay-outlet');
        return modal ? (modal.innerText || modal.textContent || '').replace(/\s+/g, ' ').trim() : '';
      })
      .catch(() => '');
    throw new Error(`CFX release type option "${expectedLabel}" not found in upload modal. Modal text: ${modalText}`);
  }

  const clicked = await retryOnNavigationContext(() =>
    page.evaluate((label) => {
      const modal = document.querySelector('#overlay-outlet');
      if (!modal) return false;

      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      const candidates = Array.from(
        modal.querySelectorAll('button,[role="button"],[role="radio"],[role="tab"],label')
      );

      const target = candidates.find((candidate) => isVisible(candidate) && normalize(candidate.textContent) === label);
      if (!target) return false;
      target.click();
      return true;
    }, expectedLabel)
  );

  if (!clicked) {
    throw new Error(`Failed to select CFX release type "${expectedLabel}".`);
  }
}

/**
 * Upload local ZIP path into the file input in the new-version modal.
 * @param {{ page: import('puppeteer').Page, zipPath: string }} options
 * @returns {Promise<void>}
 */
async function uploadZipInModal(options) {
  const { page, zipPath } = options;

  try {
    await fs.access(zipPath);
  } catch {
    throw new Error(`Release zip not found: ${zipPath}`);
  }

  const inputHandle = await page.waitForSelector('#overlay-outlet input[type="file"]', {
    timeout: 30000,
  });

  if (!inputHandle) {
    throw new Error('File input not found in upload modal.');
  }

  await inputHandle.uploadFile(zipPath);
}

/**
 * Wait for enabled NEXT button in modal and click it.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<void>}
 */
async function clickModalNextButton(page) {
  const enabled = await retryOnNavigationContext(() =>
    page.waitForFunction(() => {
      const modal = document.querySelector('#overlay-outlet');
      if (!modal) return false;

      const buttons = modal.querySelectorAll('button');
      for (const button of buttons) {
        const label = (button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (label === 'next') return !button.disabled;
      }
      return false;
    }, { timeout: 60000 })
  )
    .then(() => true)
    .catch(() => false);

  if (!enabled) {
    const modalText = await page
      .evaluate(() => {
        const modal = document.querySelector('#overlay-outlet');
        return modal ? (modal.innerText || modal.textContent || '').replace(/\s+/g, ' ').trim() : '';
      })
      .catch(() => '');

    if (modalText.toLowerCase().includes('this version already exists')) {
      throw new Error(
        `CFX rejected ZIP version as duplicate. Update fxmanifest.lua to a unique version. Modal text: ${modalText}`
      );
    }

    throw new Error(`NEXT button did not become enabled after ZIP parsing. Modal text: ${modalText}`);
  }

  const clicked = await retryOnNavigationContext(() =>
    page.evaluate(() => {
      const modal = document.querySelector('#overlay-outlet');
      if (!modal) return false;

      const buttons = modal.querySelectorAll('button');
      for (const button of buttons) {
        const label = (button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (label === 'next' && !button.disabled) {
          button.click();
          return true;
        }
      }
      return false;
    })
  );

  if (!clicked) {
    throw new Error('Failed to click NEXT button in modal.');
  }
}

/**
 * Fill required release notes in the second modal step.
 * @param {{ page: import('puppeteer').Page, releaseNotes: string }} options
 * @returns {Promise<void>}
 */
async function fillReleaseNotes(options) {
  const { page, releaseNotes } = options;

  const textarea = await page.waitForSelector(
    '#overlay-outlet textarea[placeholder*="Describe what changed"]',
    { timeout: 30000 }
  );

  if (!textarea) {
    throw new Error('Release notes textarea not found.');
  }

  await textarea.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await textarea.type(releaseNotes);
}

/**
 * Wait for enabled "Upload File" button in modal and click it.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<void>}
 */
async function clickModalUploadButton(page) {
  const enabled = await retryOnNavigationContext(() =>
    page.waitForFunction(() => {
      const modal = document.querySelector('#overlay-outlet');
      if (!modal) return false;

      const buttons = modal.querySelectorAll('button');
      for (const button of buttons) {
        const label = (button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (label === 'upload file') return !button.disabled;
      }
      return false;
    }, { timeout: 30000 })
  )
    .then(() => true)
    .catch(() => false);

  if (!enabled) {
    throw new Error('Upload File button did not become enabled.');
  }

  const clicked = await retryOnNavigationContext(() =>
    page.evaluate(() => {
      const modal = document.querySelector('#overlay-outlet');
      if (!modal) return false;

      const buttons = modal.querySelectorAll('button');
      for (const button of buttons) {
        const label = (button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (label === 'upload file' && !button.disabled) {
          button.click();
          return true;
        }
      }
      return false;
    })
  );

  if (!clicked) {
    throw new Error('Failed to click Upload File button in modal.');
  }
}

/**
 * Wait until the modal closes and the selected asset returns to ACTIVE.
 * @param {{ page: import('puppeteer').Page, assetName: string }} options
 * @returns {Promise<void>}
 */
async function waitForUploadSettled(options) {
  const { page, assetName } = options;

  await page
    .waitForFunction(() => !document.querySelector('#overlay-outlet .cfxui__Modal__root__53283'), {
      timeout: 60000,
    })
    .catch(() => undefined);

  const active = await retryOnNavigationContext(() =>
    page.waitForFunction(
      (expectedName) => {
        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const getText = (element) => normalize(element.innerText || element.textContent || '');
        const getCardAssetName = (card) => {
          const match = getText(card).match(/ASSET NAME\s+(.+?)\s+LAST UPDATED/i);
          return match ? normalize(match[1]) : '';
        };
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          );
        };

        const rows = Array.from(document.querySelectorAll('table tbody tr')).filter(isVisible);
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 5 && normalize(cells[2].textContent) === expectedName) {
            return normalize(cells[4].textContent).toLowerCase() === 'active';
          }
        }

        const cards = Array.from(
          document.querySelectorAll('.ListCard_root__ThgNO, .CreatedAssetsCards_card__x8ZTv')
        ).filter(isVisible);

        for (const card of cards) {
          if (getCardAssetName(card) === expectedName) {
            const text = getText(card);
            return text.toLowerCase().includes('active');
          }
        }

        return false;
      },
      { timeout: 120000 },
      assetName
    )
  )
    .then(() => true)
    .catch(() => false);

  if (!active) {
    throw new Error(`Upload did not settle to ACTIVE for asset "${assetName}".`);
  }
}

/**
 * Full upload flow once user is authenticated and on the Created Assets page.
 * @param {{ page: import('puppeteer').Page, portalName: string, zipPath: string, releaseNotes?: string, releaseCandidate?: boolean, deleteOldestVersionWhenCapped?: boolean }} options
 * @returns {Promise<void>}
 */
async function uploadZipToCfxAsset(options) {
  const {
    page,
    portalName,
    zipPath,
    releaseNotes = DEFAULT_RELEASE_NOTES,
    releaseCandidate = false,
    deleteOldestVersionWhenCapped = false,
  } = options;

  await filterByAssetName({ page, assetName: portalName });
  await selectAssetByName({ page, assetName: portalName });
  await clickUploadNewVersionButton(page, { deleteOldestVersionWhenCapped });
  const cappedModalHandled = await handleCappedUploadModalIfNeeded(page, { deleteOldestVersionWhenCapped });
  if (cappedModalHandled) {
    await clickUploadNewVersionButton(page, { deleteOldestVersionWhenCapped });
  }
  await selectReleaseTypeInModal({ page, releaseCandidate });
  await uploadZipInModal({ page, zipPath });
  await clickModalNextButton(page);
  await fillReleaseNotes({ page, releaseNotes });
  await clickModalUploadButton(page);
  await waitForUploadSettled({ page, assetName: portalName });
}

module.exports = {
  uploadZipToCfxAsset,
};
