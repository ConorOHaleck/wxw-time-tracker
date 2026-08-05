'use strict';

const log = require('./util/logger');

/**
 * The single shared Airtable token that connects the whole team.
 *
 * Two delivery avenues, same code:
 *  - Embedded at build time: `tools/embed-token.js` writes src/generated/token.json
 *    from the AIRTABLE_TOKEN build secret. Employees never see or enter a token.
 *  - Entered once by an admin: stored in settings.airtableToken.
 *
 * The embedded token wins when present. The generated file is gitignored (never
 * committed) but IS bundled into the packaged app, so treat a build that embeds
 * it as sensitive.
 */
let embedded;
function embeddedToken() {
  if (embedded === undefined) {
    try {
      // token.js is src/main/token.js; the generated file is src/generated/token.json.
      // eslint-disable-next-line global-require
      const data = require('../generated/token.json');
      embedded = (data && typeof data.token === 'string' && data.token) || '';
      if (embedded) log.info('token: using build-time embedded shared token');
    } catch {
      embedded = ''; // no embedded token — fall back to the entered one
    }
  }
  return embedded;
}

/** The token to actually use: embedded if built in, otherwise the entered one. */
function resolveToken(settings) {
  return embeddedToken() || (settings && settings.airtableToken) || '';
}

/** True when the token is baked into the build (so the UI can hide the field). */
function hasEmbeddedToken() {
  return !!embeddedToken();
}

module.exports = { resolveToken, hasEmbeddedToken };
