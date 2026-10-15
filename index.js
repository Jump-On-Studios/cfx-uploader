const { runHttpUploadFlow } = require("./src/core/upload-http-flow");
const { runBrowserUploadFlow } = require("./src/core/upload-browser-flow");
const { createUploader, upload } = require("./src/core/create-uploader");
const { checkAuthentication } = require("./src/core/check-authentication");
const { checkVersionStatus } = require("./src/core/check-version-status");
const { POLL_TIMEOUT_ERROR_CODE, VERSION_EXISTS_ERROR_CODE } = require("./src/cfx/http-upload");

module.exports = {
  createUploader,
  checkAuthentication,
  checkVersionStatus,
  upload,
  uploadHttp: runHttpUploadFlow,
  uploadBrowser: runBrowserUploadFlow,
  POLL_TIMEOUT_ERROR_CODE,
  VERSION_EXISTS_ERROR_CODE,
};
