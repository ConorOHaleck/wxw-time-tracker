'use strict';

/**
 * Writes src/generated/token.json from the AIRTABLE_TOKEN env var so the shared
 * token can be baked into a build. Run automatically before packaging.
 *
 *  - If AIRTABLE_TOKEN is set (e.g. a GitHub Actions secret), the app ships with
 *    that token embedded and employees only pick their name.
 *  - If it's unset, an empty file is written and the app falls back to a token an
 *    admin enters once in setup.
 *
 * The output file is gitignored — it must never be committed.
 */
const fs = require('fs');
const path = require('path');

const token = process.env.AIRTABLE_TOKEN || '';
const outDir = path.join(__dirname, '..', 'src', 'generated');
const outFile = path.join(outDir, 'token.json');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ token }, null, 2) + '\n');

// eslint-disable-next-line no-console
console.log(
  token
    ? `embed-token: embedded a shared token (${token.length} chars) into the build`
    : 'embed-token: no AIRTABLE_TOKEN set — app will use an admin-entered token'
);
