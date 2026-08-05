'use strict';

const log = require('../util/logger');

/**
 * Reads the device's configuration out of Airtable and turns a facet number
 * into a ready-to-write Hours record payload.
 *
 * Resolves:
 *   - the TimeFlip record for this install (by the record chosen in setup)
 *   - the assignee's Airtable user (for the Hours "Name" collaborator field)
 *   - each TimeFlip Face -> { adventureId, adventureName, billableRoleId,
 *     billableRoleName, hourType, status }
 */
class FaceMapper {
  constructor(airtable, cfg) {
    this.at = airtable;
    this.cfg = cfg;
    this.f = cfg.airtable.fields;
    this.tables = cfg.airtable.tables;

    this.timeflipRecordId = null;
    this.assigneeUserId = null; // who the device is registered to
    this.assigneeName = null;
    this.selectedUserId = (cfg.identity && cfg.identity.userId) || null; // who WE are
    this.selectedName = (cfg.identity && cfg.identity.name) || null;
    this.hoursUserId = null; // who we log time as
    this.faceMap = new Map(); // faceNumber -> mapping
  }

  /** Load everything. Call on startup and whenever the mapping might have changed. */
  async load() {
    // Identity is the selected person (their Airtable user id), NOT the shared
    // token's owner. Time is always logged as the selected person, so the shared
    // sign-in can never misattribute hours.
    const tf = await this._loadTimeflipRecord();
    this.timeflipRecordId = tf.id;

    const userLookup = tf.fields[this.f.timeflip.airtableUserFromAssignee];
    this.assigneeUserId = this._firstUserId(userLookup);
    this.assigneeName = this._firstUserName(userLookup);
    this.hoursUserId = this.selectedUserId || this.assigneeUserId;
    if (!this.hoursUserId) {
      log.warn('mapper: no user selected; Hours "Name" will be left blank.');
    }
    if (this.deviceOwnerMismatch()) {
      log.warn(
        `mapper: this TimeFlip setup belongs to ${this.assigneeName || 'someone else'}, ` +
          `but time is logged as ${this.selectedName || this.selectedUserId}.`
      );
    }

    const faceLinks = tf.fields[this.f.timeflip.faces] || [];
    await this._loadFaces(faceLinks);
    // When we last pulled face/adventure/deliverable data from Airtable.
    this.lastLoadedMs = Date.now();
    log.info(
      `mapper: loaded TimeFlip ${this.timeflipRecordId} with ${this.faceMap.size} faces; ` +
        `logging time as ${this.selectedName || this.hoursUserId || '(nobody)'} ` +
        `(selected=${this.selectedUserId || 'none'}, device assignee=${this.assigneeUserId || 'none'})`
    );
    return this;
  }

  /**
   * Find the TimeFlip record whose setup we should use. Resolved from the
   * selected person — the face mapping belongs to the person, not the plastic
   * die, so they can pick up any TimeFlip and get their own faces. A stored
   * record id acts as a manual override.
   */
  async _loadTimeflipRecord() {
    const { timeflipRecordId } = this.cfg.device;
    if (timeflipRecordId) {
      return this.at.getRecord(this.tables.timeflip, timeflipRecordId);
    }
    if (!this.selectedUserId) {
      throw new Error(
        'No name selected. Open Settings and choose your name from the list.'
      );
    }
    const records = await this.at.listRecords(this.tables.timeflip, { maxRecords: 100 });
    const uf = this.f.timeflip.airtableUserFromAssignee;
    const mine = records.filter((r) => this._userIdsOf(r.fields[uf]).includes(this.selectedUserId));

    if (!mine.length) {
      throw new Error(
        `No TimeFlip in Airtable is assigned to ${this.selectedName || 'you'}. Ask an admin to ` +
          'set you as the Assignee on a TimeFlip record, or pick a setup manually in Settings.'
      );
    }
    if (mine.length > 1) {
      log.warn(`mapper: ${mine.length} TimeFlip records assigned to ${this.selectedName}; using the first`);
    }
    log.info('mapper: resolved TimeFlip record for', this.selectedName || this.selectedUserId, mine[0].id);
    return mine[0];
  }

  async _loadFaces(faceRecordIds) {
    this.faceMap.clear();
    for (const recId of faceRecordIds) {
      let rec;
      try {
        rec = await this.at.getRecord(this.tables.faces, recId);
      } catch (err) {
        log.warn('mapper: could not load face', recId, err.message);
        continue;
      }
      const ff = this.f.faces;
      const faceNumber = rec.fields[ff.faceNumber];
      if (faceNumber == null) continue;

      this.faceMap.set(Number(faceNumber), {
        faceRecordId: rec.id,
        faceNumber: Number(faceNumber),
        adventureId: this._firstLink(rec.fields[ff.adventures]),
        adventureName: null, // resolved by _resolveLinkedNames
        deliverableId: this._firstLink(rec.fields[ff.deliverable]),
        deliverableName: null,
        billableRoleId: this._firstLink(rec.fields[ff.billableRole]),
        billableRoleName: null,
        hourType: rec.fields[ff.hourType] || null,
        status: rec.fields[ff.status] || null,
      });
    }
    await this._resolveLinkedNames();
  }

  /**
   * Linked-record fields come back from the REST API as bare record ids, so we
   * fetch each unique linked Adventure and Billable Role once to get their
   * display names. The role matters: the same person can have two roles on the
   * same Adventure, and that's the only thing telling those two faces apart.
   */
  async _resolveLinkedNames() {
    const faces = [...this.faceMap.values()];
    const af = this.f.adventures;
    const bf = this.f.billableRoles;
    const df = this.f.deliverables;

    const advNames = await this._fetchNames(
      [...new Set(faces.map((m) => m.adventureId).filter(Boolean))],
      this.tables.adventures,
      [af.projectName, af.project]
    );
    const roleNames = await this._fetchNames(
      [...new Set(faces.map((m) => m.billableRoleId).filter(Boolean))],
      this.tables.billableRoles,
      [bf.role, bf.name]
    );
    const delNames = await this._fetchNames(
      [...new Set(faces.map((m) => m.deliverableId).filter(Boolean))],
      this.tables.deliverables,
      [df.name, df.title]
    );

    for (const m of faces) {
      m.adventureName = m.adventureId ? advNames.get(m.adventureId) || null : null;
      m.billableRoleName = m.billableRoleId ? roleNames.get(m.billableRoleId) || null : null;
      m.deliverableName = m.deliverableId ? delNames.get(m.deliverableId) || null : null;
    }
  }

  /** Fetch display names for linked records, using the first non-empty field. */
  async _fetchNames(ids, tableId, fieldIds) {
    const names = new Map();
    for (const id of ids) {
      try {
        const rec = await this.at.getRecord(tableId, id);
        const value = fieldIds.map((f) => rec.fields[f]).find((v) => v);
        names.set(id, value || null);
      } catch (err) {
        log.warn('mapper: could not load linked record', id, 'from', tableId, err.message);
      }
    }
    return names;
  }

  /** Mapping for a facet, or null if that face is not configured. */
  forFacet(facet) {
    return this.faceMap.get(Number(facet)) || null;
  }

  /**
   * Why a flip to this facet won't create an Hours record — or null if it will.
   * Returned to the UI so a face that silently isn't tracking explains itself.
   */
  trackableReason(facet) {
    if (!facet || facet < 1) return 'No face detected yet';
    if (this.cfg.tracking.pauseFaces.includes(facet)) {
      return `Face ${facet} is set as a pause face`;
    }
    const m = this.forFacet(facet);
    if (!m) return `Face ${facet} isn’t set up in TimeFlip Faces`;
    if (m.status && String(m.status).toLowerCase() === 'inactive') {
      return `Face ${facet} is marked Inactive in Airtable`;
    }
    if (!m.adventureId) return `Face ${facet} has no Adventure assigned in Airtable`;
    return null;
  }

  /** Should a flip to this facet create an Hours record? */
  isTrackable(facet) {
    return this.trackableReason(facet) === null;
  }

  /** True when the TimeFlip setup in use belongs to someone other than the selected person. */
  deviceOwnerMismatch() {
    return !!(
      this.selectedUserId &&
      this.assigneeUserId &&
      this.selectedUserId !== this.assigneeUserId
    );
  }

  /**
   * Warning for the UI when the resolved setup belongs to someone else (only via
   * a manual override). Time is still logged as the selected person, but each
   * face's Adventure and Billable Role come from the other person's setup.
   */
  ownerWarning() {
    if (!this.deviceOwnerMismatch()) return null;
    return (
      `This TimeFlip setup belongs to ${this.assigneeName || 'someone else'}. ` +
      `Time is logged as ${this.selectedName || 'you'}, but each face’s Adventure and ` +
      'Billable Role come from their setup.'
    );
  }

  /** Build the Hours create payload for a session on `facet` starting at startMs. */
  buildHoursFields(facet, startMs) {
    const m = this.forFacet(facet);
    const hf = this.f.hours;
    const fields = {};
    // Always the selected person, never the shared token's owner or the device assignee.
    if (this.hoursUserId) fields[hf.name] = { id: this.hoursUserId };
    if (m && m.billableRoleId) fields[hf.billableRole] = [m.billableRoleId];
    if (m && m.adventureId) fields[hf.adventure] = [m.adventureId];
    if (m && m.hourType) fields[hf.type] = m.hourType; // Hour Type names match Hours "Type" choices
    fields[hf.start] = new Date(startMs).toISOString();
    return fields;
  }

  endFields(endMs) {
    return { [this.f.hours.end]: new Date(endMs).toISOString() };
  }

  // ---- value extraction helpers ----

  _firstLink(value) {
    if (Array.isArray(value) && value.length) {
      return typeof value[0] === 'string' ? value[0] : value[0].id || null;
    }
    return null;
  }

  _firstUserId(value) {
    if (Array.isArray(value) && value.length) {
      const v = value[0];
      if (typeof v === 'string') return v.startsWith('usr') ? v : null;
      return v.id || null;
    }
    if (value && typeof value === 'object') return value.id || null;
    return null;
  }

  /** All Airtable user ids in a collaborator/lookup value. */
  _userIdsOf(value) {
    const list = Array.isArray(value) ? value : [value];
    return list.map((v) => (typeof v === 'string' ? v : v && v.id)).filter(Boolean);
  }

  _firstUserName(value) {
    const v = Array.isArray(value) ? value[0] : value;
    if (!v || typeof v !== 'object') return null;
    return v.name || v.email || null;
  }
}

module.exports = { FaceMapper };
