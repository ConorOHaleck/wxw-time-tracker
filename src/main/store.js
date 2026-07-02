'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./util/logger');

/**
 * Durable local state, persisted as JSON. Survives app restarts so we never
 * double-write history and can finalize a session that was open when the app
 * was last closed.
 *
 * Shape:
 *   {
 *     lastEventNumber: number,   // high-water mark of handled device history events
 *     openSession: {             // the currently-open Hours record, or null
 *       airtableRecordId, facet, startMs, billableRoleId, adventureId, type
 *     } | null
 *   }
 */
class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { lastEventNumber: -1, openSession: null };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.data = Object.assign(this.data, JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
        log.info('store: loaded', this.filePath);
      }
    } catch (err) {
      log.error('store: failed to load, starting fresh', err.message);
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      log.error('store: failed to save', err.message);
    }
  }

  get lastEventNumber() {
    return this.data.lastEventNumber;
  }

  setLastEventNumber(n) {
    if (n > this.data.lastEventNumber) {
      this.data.lastEventNumber = n;
      this._save();
    }
  }

  get openSession() {
    return this.data.openSession;
  }

  setOpenSession(session) {
    this.data.openSession = session;
    this._save();
  }

  clearOpenSession() {
    this.data.openSession = null;
    this._save();
  }
}

module.exports = { Store };
