'use strict';

const log = require('../util/logger');

/**
 * Reads the device's configuration out of Airtable and turns a facet number
 * into a ready-to-write Hours record payload.
 *
 * Resolves:
 *   - the TimeFlip record for this install (by the record chosen in setup)
 *   - the assignee's Airtable user (for the Hours "Name" collaborator field)
 *   - each TimeFlip Face -> { adventureId, adventureName, billableRoleId, hourType, status }
 */
class FaceMapper {
  constructor(airtable, cfg) {
    this.at = airtable;
    this.cfg = cfg;
    this.f = cfg.airtable.fields;
    this.tables = cfg.airtable.tables;

    this.timeflipRecordId = null;
    this.assigneeUserId = null;
    this.faceMap = new Map(); // faceNumber -> mapping
  }

  /** Load everything. Call on startup and whenever the mapping might have changed. */
  async load() {
    const tf = await this._loadTimeflipRecord();
    this.timeflipRecordId = tf.id;

    const userLookup = tf.fields[this.f.timeflip.airtableUserFromAssignee];
    this.assigneeUserId = this._firstUserId(userLookup);
    if (!this.assigneeUserId) {
      log.warn(
        'mapper: no Airtable user resolved from Assignee; Hours "Name" will be left blank. ' +
          'Set an Assignee with a linked Airtable User on the TimeFlip record.'
      );
    }

    const faceLinks = tf.fields[this.f.timeflip.faces] || [];
    await this._loadFaces(faceLinks);
    log.info(
      `mapper: loaded TimeFlip ${this.timeflipRecordId} with ${this.faceMap.size} faces, ` +
        `assignee user ${this.assigneeUserId || '(none)'}`
    );
    return this;
  }

  async _loadTimeflipRecord() {
    const { timeflipRecordId } = this.cfg.device;
    if (!timeflipRecordId) {
      throw new Error('mapper: no TimeFlip device selected. Open setup and choose your device.');
    }
    return this.at.getRecord(this.tables.timeflip, timeflipRecordId);
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
        adventureName: null, // filled in by _resolveAdventureNames
        billableRoleId: this._firstLink(rec.fields[ff.billableRole]),
        hourType: rec.fields[ff.hourType] || null,
        status: rec.fields[ff.status] || null,
      });
    }
    await this._resolveAdventureNames();
  }

  /**
   * Linked-record fields come back from the REST API as bare record ids, so we
   * fetch each unique linked Adventure once to get its display name (for the UI).
   */
  async _resolveAdventureNames() {
    const ids = [
      ...new Set([...this.faceMap.values()].map((m) => m.adventureId).filter(Boolean)),
    ];
    const af = this.f.adventures;
    const names = new Map();
    for (const id of ids) {
      try {
        const rec = await this.at.getRecord(this.tables.adventures, id);
        names.set(id, rec.fields[af.projectName] || rec.fields[af.project] || null);
      } catch (err) {
        log.warn('mapper: could not load adventure', id, err.message);
      }
    }
    for (const m of this.faceMap.values()) {
      m.adventureName = m.adventureId ? names.get(m.adventureId) || null : null;
    }
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

  /** Build the Hours create payload for a session on `facet` starting at startMs. */
  buildHoursFields(facet, startMs) {
    const m = this.forFacet(facet);
    const hf = this.f.hours;
    const fields = {};
    if (this.assigneeUserId) fields[hf.name] = { id: this.assigneeUserId };
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
}

module.exports = { FaceMapper };
