'use strict';

const { BASE_ID, TABLES, FIELDS } = require('./defaults');

/**
 * Assembles the full runtime config the rest of the app expects from the small
 * set of user settings plus the baked-in WxW Delivery schema (defaults.js).
 *
 * The production-vs-testing toggle automatically swaps both the target table
 * and its field-id set — the user never touches a field id.
 */
function buildConfig(settings) {
  const useProd = !!settings.useProduction;
  return {
    airtable: {
      token: settings.airtableToken,
      baseId: BASE_ID,
      tables: {
        timeflip: TABLES.timeflip,
        faces: TABLES.faces,
        adventures: TABLES.adventures,
        hoursTarget: useProd ? TABLES.hoursProduction : TABLES.hoursTesting,
      },
      fields: {
        timeflip: FIELDS.timeflip,
        faces: FIELDS.faces,
        adventures: FIELDS.adventures,
        hours: useProd ? FIELDS.hoursProduction : FIELDS.hoursTesting,
      },
    },
    device: {
      timeflipRecordId: settings.timeflipRecordId,
      // peripheralId (the exact paired device) takes precedence over the name
      // prefix. Once a device is paired/learned, connection no longer depends on
      // the advertised name at all.
      bleMatch: {
        namePrefix: settings.bleNamePrefix || 'TimeFlip',
        peripheralId: settings.bleDeviceId || '',
      },
      password: '000000',
    },
    tracking: {
      pauseFaces: settings.pauseFaces || [],
      minSessionSeconds: settings.minSessionSeconds ?? 30,
      reconcileIntervalMinutes: settings.reconcileIntervalMinutes ?? 15,
      historyDurationLittleEndian: settings.historyDurationLittleEndian ?? true,
    },
  };
}

module.exports = { buildConfig };
