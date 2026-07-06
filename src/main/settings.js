'use strict';

const fs = require('fs');
const path = require('path');
const { TRACKING_DEFAULTS } = require('./defaults');
const log = require('./util/logger');

/**
 * The only things the user actually chooses, persisted to userData/settings.json.
 * Everything else (base id, table ids, field ids) is baked into defaults.js.
 *
 *   {
 *     airtableToken: string,
 *     timeflipRecordId: string,   // which TimeFlip record is "this" device/person
 *     useProduction: boolean,     // false = write to Hours Testing (default)
 *     bleNamePrefix: string,      // device advert name filter (default "TimeFlip")
 *     pauseFaces, minSessionSeconds, reconcileIntervalMinutes, historyDurationLittleEndian
 *   }
 */
const DEFAULTS = {
  airtableToken: '',
  timeflipRecordId: '',
  useProduction: false,
  bleNamePrefix: 'TimeFlip',
  // The exact paired device, learned on first successful connect (or set via the
  // "Choose device" picker). Once set, the app reconnects to this exact device
  // regardless of its advertised name. Web Bluetooth ids are stable per machine.
  bleDeviceId: '',
  bleDeviceName: '',
  ...TRACKING_DEFAULTS,
};

function filePath(userDataDir) {
  return path.join(userDataDir, 'settings.json');
}

function load(userDataDir) {
  const p = filePath(userDataDir);
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { ...DEFAULTS, ...data };
    }
  } catch (err) {
    log.error('settings: failed to load, using defaults', err.message);
  }
  return { ...DEFAULTS };
}

function save(userDataDir, settings) {
  const merged = { ...DEFAULTS, ...settings };
  const p = filePath(userDataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(merged, null, 2));
  log.info('settings: saved', p);
  return merged;
}

/** True once the app has enough to actually run. */
function isComplete(settings) {
  return !!(settings && settings.airtableToken && settings.timeflipRecordId);
}

module.exports = { DEFAULTS, load, save, isComplete, filePath };
