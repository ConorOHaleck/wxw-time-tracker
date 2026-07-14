'use strict';

/**
 * Baked-in mapping for the WxW Delivery base. These IDs are stable and are NOT
 * something an end user should ever have to see or type — the setup screen only
 * asks for an Airtable token and which TimeFlip record is theirs. Everything
 * else is assembled from here.
 */

const BASE_ID = 'appOa0ZMtkRoHMSW3';

const TABLES = {
  timeflip: 'tblJR92EMiEcdKcpN',
  faces: 'tblVakgKaD6vfNj8l',
  adventures: 'tblCSJIhA8QpXVfsl',
  hoursTesting: 'tbll6GJlXkJyjhPom',
  hoursProduction: 'tblOtz0vowbHJnuAG',
};

const FIELDS = {
  timeflip: {
    currentFace: 'fldwteQGbq6dpvWVi',
    faces: 'fldo9LOadiUJYhdaA',
    airtableUserFromAssignee: 'fldbkpJV5rBUcEVyj',
  },
  faces: {
    faceNumber: 'fldfI8hgi4cLeVh1e',
    adventures: 'fldOijNaTKvKnbpS1',
    billableRole: 'fld6ZQVSWeLR8vght',
    hourType: 'fldnXNSvcDUKepKjA',
    timeflipLink: 'fldzgh2sV2Yb6eQ33',
    status: 'fldd1XT4ShFX3Q6SF',
  },
  adventures: {
    // Resolve the display name for a face's linked Adventure. Prefer the plain
    // "Project Name"; fall back to the "Project" primary formula (id + name).
    projectName: 'fldqG21IJZ9BXDIVw',
    project: 'fldpeovVxIjgfrxJq',
  },
  // The two Hours tables have different field IDs; the active set is chosen by
  // the "use production" toggle.
  hoursTesting: {
    name: 'fldcn8Q3TOc63sYcS',
    billableRole: 'fldEpwHqXxMTVsSj0',
    adventure: 'fld5MuswbMcdFTZd7',
    start: 'fldIOHHxPcKAunfEJ',
    end: 'fldL4XntzyJGMUcrX',
    type: 'fldD3jhBMxIZbeoGF',
  },
  hoursProduction: {
    name: 'fldFK17dk0EftyDoc',
    billableRole: 'fld7MpYAoJe2lyxvk',
    adventure: 'fldy9nJGCYEm5ZEpr',
    start: 'fldbbAYHgocJUtUQ3',
    end: 'flderQED0KbPc0RDh',
    type: 'fld6qcyLdJa8Bk3SZ',
  },
};

const TRACKING_DEFAULTS = {
  pauseFaces: [],
  minSessionSeconds: 30,
  reconcileIntervalMinutes: 15,
  historyDurationLittleEndian: true,
};

module.exports = { BASE_ID, TABLES, FIELDS, TRACKING_DEFAULTS };
