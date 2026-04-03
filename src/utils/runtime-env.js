const path = require('path');
const dotenv = require('dotenv');

function loadProjectEnv(projectRoot) {
  dotenv.config({
    path: path.join(projectRoot, '.env'),
    quiet: true,
  });
}

module.exports = {
  loadProjectEnv,
};
