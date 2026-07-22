const { runHttpUploadFlow } = require("./src/core/upload-http-flow");
const { runBrowserUploadFlow } = require("./src/core/upload-browser-flow");
const { createUploader, upload } = require("./src/core/create-uploader");

module.exports = {
  createUploader,
  upload,
  uploadHttp: runHttpUploadFlow,
  uploadBrowser: runBrowserUploadFlow,
};
