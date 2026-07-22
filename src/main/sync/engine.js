'use strict';

const EventEmitter = require('events');
const log = require('../util/logger');
const { TABLES } = require('../defaults');

/**
 * Ties the BLE device, the Airtable mapper, and the local store together.
 *
 * Two cooperating mechanisms, deliberately partitioned so they never
 * double-write the same session:
 *
 *  - LIVE: while connected, a flip closes the open Hours record (sets End) and,
 *    after `minSessionSeconds`, opens a new one (sets Start). Short nudges never
 *    create a record. Each close advances the history high-water mark past the
 *    just-completed event, so reconcile won't re-import it.
 *
 *  - RECONCILE: on connect and on an interval, pages the device's onboard
 *    history for events newer than the high-water mark that completed *before*
 *    live tracking began (i.e. while the app was closed or out of range) and
 *    backfills them. Going forward, live owns everything after connect.
 *
 * Emits 'update' with a snapshot for the UI.
 */
class SyncEngine extends EventEmitter {
  constructor({ device, mapper, store, airtable, cfg }) {
    super();
    this.device = device;
    this.mapper = mapper;
    this.store = store;
    this.at = airtable;
    this.cfg = cfg;
    this.hoursTable = cfg.airtable.tables.hoursTarget;
    this.histOpts = { durationLittleEndian: cfg.tracking.historyDurationLittleEndian };

    this.trackingSince = 0;
    this.current = null; // { facet, startMs, airtableRecordId, createTimer }
    this.deviceFacet = 0;
    this.connected = false;
    this._reconcileTimer = null;
    this._reconciling = false;
  }

  start() {
    this.device.on('ready', () => this._onReady().catch((e) => log.error('engine: onReady', e.message)));
    this.device.on('facet', ({ facet }) =>
      this._onFacet(facet).catch((e) => log.error('engine: onFacet', e.message))
    );
    this.device.on('status', ({ state }) => this._onStatus(state));
    this.device.on('error', (err) => this._emit({ error: err.message }));
  }

  // ---- device lifecycle ----

  async _onReady() {
    this.connected = true;
    this.trackingSince = Date.now();
    this.deviceFacet = this.device.lastFacet;

    // Recover a session that was open when the app last closed.
    await this._recoverOpenSession();

    // Backfill anything that completed while we were away.
    await this._reconcile();

    // Begin the current live session if the device is sitting on a trackable face.
    if (this.deviceFacet > 0) {
      await this._beginSession(this.deviceFacet, Date.now());
    }

    this._scheduleReconcile();
    this._emit();
  }

  _onStatus(state) {
    this.connected = state === 'ready';
    if (state === 'disconnected' || state === 'idle') {
      // Stop the live session clock; the device keeps recording onboard and we
      // backfill the gap on the next reconnect.
      this._cancelPendingCreate();
    }
    this._emit({ bleState: state });
  }

  // ---- live tracking ----

  async _onFacet(facet) {
    this.deviceFacet = facet;
    log.info('engine: facet ->', facet);
    await this._closeCurrent(Date.now());
    await this._beginSession(facet, Date.now());
    this._updateCurrentFace(facet); // fire-and-forget; for Airtable visibility
    this._emit();
  }

  /** Reflect the live face onto the TimeFlip record's Current Face field. */
  _updateCurrentFace(facet) {
    const recId = this.mapper.timeflipRecordId;
    const fieldId = this.cfg.airtable.fields.timeflip.currentFace;
    if (!recId || !fieldId) return;
    this.at
      .updateRecord(this.cfg.airtable.tables.timeflip, recId, { [fieldId]: facet })
      .catch((e) => log.warn('engine: could not update Current Face', e.message));
  }

  async _beginSession(facet, startMs) {
    if (!this.mapper.isTrackable(facet)) {
      this.current = { facet, startMs, airtableRecordId: null, tracked: false };
      log.info('engine: facet', facet, 'is not trackable (pause/idle/unmapped)');
      return;
    }
    // Defer creation until the session outlives minSessionSeconds (ignore nudges).
    this.current = { facet, startMs, airtableRecordId: null, tracked: true, createTimer: null };
    const delayMs = this.cfg.tracking.minSessionSeconds * 1000;
    this.current.createTimer = setTimeout(() => {
      this._createOpenRecord().catch((e) => log.error('engine: createOpenRecord', e.message));
    }, delayMs);
  }

  async _createOpenRecord() {
    const c = this.current;
    if (!c || !c.tracked || c.airtableRecordId) return;
    const fields = this.mapper.buildHoursFields(c.facet, c.startMs);
    const rec = await this.at.createRecord(this.hoursTable, fields);
    c.airtableRecordId = rec.id;
    c.createTimer = null;
    this.store.setOpenSession({
      airtableRecordId: rec.id,
      facet: c.facet,
      startMs: c.startMs,
    });
    log.info('engine: opened Hours', rec.id, 'face', c.facet);
    this._emit();
  }

  async _closeCurrent(endMs) {
    const c = this.current;
    this.current = null;
    if (!c) return;

    // Pending creation that never fired => nudge, write nothing.
    if (c.createTimer) {
      clearTimeout(c.createTimer);
      log.info('engine: facet', c.facet, 'was a sub-threshold nudge, discarded');
      return;
    }
    if (!c.airtableRecordId) return;

    const durationSec = (endMs - c.startMs) / 1000;
    if (durationSec < this.cfg.tracking.minSessionSeconds) {
      log.info('engine: closing short session', c.airtableRecordId, durationSec.toFixed(0), 's');
    }
    await this.at.updateRecord(this.hoursTable, c.airtableRecordId, this.mapper.endFields(endMs));
    log.info('engine: closed Hours', c.airtableRecordId, 'duration', durationSec.toFixed(0), 's');

    // This completed session is now the device's latest history event; mark it
    // handled so reconcile won't import it again.
    try {
      const head = await this.device.getLastEventNumber(this.histOpts);
      if (head >= 0) this.store.setLastEventNumber(head);
    } catch (e) {
      log.warn('engine: could not read head event after close', e.message);
    }
    this.store.clearOpenSession();
  }

  _cancelPendingCreate() {
    if (this.current && this.current.createTimer) {
      clearTimeout(this.current.createTimer);
      this.current.createTimer = null;
    }
  }

  // ---- recovery + reconcile ----

  async _recoverOpenSession() {
    const open = this.store.openSession;
    if (!open) return;

    if (open.facet === this.deviceFacet) {
      // Same face still up: resume the existing live session in place.
      this.current = {
        facet: open.facet,
        startMs: open.startMs,
        airtableRecordId: open.airtableRecordId,
        tracked: true,
        createTimer: null,
      };
      log.info('engine: resumed open session', open.airtableRecordId, 'face', open.facet);
      this.deviceFacet = 0; // prevent _onReady from opening a duplicate for this face
      return;
    }

    // Face changed while we were off: the session ended onboard. Finalize its
    // record from history if we can find the matching event, else best-effort.
    try {
      const head = await this.device.getLastEventNumber(this.histOpts);
      const recs = await this.device.readHistory(this.store.lastEventNumber + 1, this.histOpts);
      const match = recs.find(
        (r) => r.facet === open.facet && Math.abs(r.startMs - open.startMs) < 120000
      );
      const endMs = match ? match.endMs : open.startMs;
      await this.at.updateRecord(
        this.hoursTable,
        open.airtableRecordId,
        this.mapper.endFields(endMs)
      );
      if (match) this.store.setLastEventNumber(match.eventNumber);
      else if (head >= 0) this.store.setLastEventNumber(head);
      log.info('engine: finalized recovered session', open.airtableRecordId);
    } catch (e) {
      log.warn('engine: could not finalize recovered session', e.message);
    }
    this.store.clearOpenSession();
  }

  async _reconcile() {
    if (this._reconciling) return;
    this._reconciling = true;
    try {
      const head = await this.device.getLastEventNumber(this.histOpts);
      if (head < 0 || head <= this.store.lastEventNumber) {
        log.debug('engine: reconcile - nothing new (head', head, ')');
        return;
      }
      const start = this.store.lastEventNumber + 1;
      const recs = await this.device.readHistory(start, this.histOpts);
      let imported = 0;
      for (const r of recs) {
        // Live owns sessions that completed at/after we started tracking.
        if (r.endMs >= this.trackingSince) continue;
        if (r.paused) continue;
        if (r.durationSeconds < this.cfg.tracking.minSessionSeconds) continue;
        if (!this.mapper.isTrackable(r.facet)) continue;

        const fields = this.mapper.buildHoursFields(r.facet, r.startMs);
        Object.assign(fields, this.mapper.endFields(r.endMs));
        await this.at.createRecord(this.hoursTable, fields);
        imported++;
      }
      this.store.setLastEventNumber(head);
      if (imported) log.info('engine: reconcile backfilled', imported, 'sessions');
    } catch (e) {
      log.error('engine: reconcile failed', e.message);
    } finally {
      this._reconciling = false;
      this._emit();
    }
  }

  _scheduleReconcile() {
    clearInterval(this._reconcileTimer);
    const ms = this.cfg.tracking.reconcileIntervalMinutes * 60 * 1000;
    this._reconcileTimer = setInterval(() => {
      if (this.connected) this._reconcile().catch((e) => log.error('engine: reconcile', e.message));
    }, ms);
  }

  // ---- live re-read of the Airtable face setup ----

  /**
   * Re-read the TimeFlip record, faces and Adventure names from Airtable —
   * someone may have changed a face's Adventure, Billable Role, Hour Type or
   * Status while we're running.
   *
   * If the config for the face that's currently up changed materially, the open
   * Hours entry is closed at "now" and a new one started under the new mapping,
   * so time before and after the edit is billed correctly. A face that just
   * became trackable starts tracking; one that no longer is gets closed out.
   */
  async refreshMapping() {
    const facet = this.deviceFacet || (this.current ? this.current.facet : 0);
    const before = facet ? this._mappingSignature(facet) : null;

    await this.mapper.load();

    const after = facet ? this._mappingSignature(facet) : null;
    if (facet > 0 && before !== after) {
      log.info('engine: face', facet, 'config changed on resync — restarting session');
      await this._closeCurrent(Date.now());
      await this._beginSession(facet, Date.now());
    }
    this._emit();
    return this.snapshot();
  }

  /** Compact fingerprint of a face's config, to detect meaningful changes. */
  _mappingSignature(facet) {
    const m = this.mapper.forFacet(facet);
    const trackable = this.mapper.isTrackable(facet);
    if (!m) return `unmapped:${trackable}`;
    return [trackable, m.adventureId, m.billableRoleId, m.hourType, m.status].join('|');
  }

  // ---- UI snapshot ----

  snapshot(extra = {}) {
    const c = this.current;
    const map = c ? this.mapper.forFacet(c.facet) : null;
    return {
      connected: this.connected,
      deviceFacet: this.deviceFacet,
      currentFacet: c ? c.facet : 0,
      tracking: !!(c && c.tracked),
      // Why the face that's up isn't being tracked (null when it is).
      notTrackingReason: c && !c.tracked ? this.mapper.trackableReason(c.facet) : null,
      openRecordId: c ? c.airtableRecordId : null,
      sessionStartMs: c ? c.startMs : null,
      adventureId: map ? map.adventureId : null,
      adventureName: map ? map.adventureName : null,
      billableRoleName: map ? map.billableRoleName : null,
      hourType: map ? map.hourType : null,
      lastEventNumber: this.store.lastEventNumber,
      assigneeUserId: this.mapper.assigneeUserId,
      // Set when the picked device belongs to someone else (time still logs as you).
      ownerWarning: this.mapper.ownerWarning(),
      faceCount: this.mapper.faceMap.size,
      hoursTable: this.hoursTable,
      // Writing to the practice table — this time never reaches payroll.
      isTestingTarget: this.hoursTable === TABLES.hoursTesting,
      ...extra,
    };
  }

  _emit(extra = {}) {
    this.emit('update', this.snapshot(extra));
  }

  async stop() {
    clearInterval(this._reconcileTimer);
    this._cancelPendingCreate();
    // Leave the open record open; it will be finalized on next launch from history.
  }
}

module.exports = { SyncEngine };
