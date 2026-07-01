// Generates test-index.html from index.html with non-placeholder credentials so
// cloudEnabled() returns true.  The JSONBin API is fully mocked in the tests;
// the values chosen here ("test-bin-id" / "test-api-key") are never actually sent.
const path = require('path');
const fs = require('fs');

module.exports = async function globalSetup() {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace("'YOUR_BIN_ID_HERE'", "'test-bin-id'")
    .replace("'YOUR_API_KEY_HERE'", "'test-api-key'");
  fs.writeFileSync(path.join(root, 'test-index.html'), html);
};
