'use strict';

const log = require('../util/logger');

const API_ROOT = 'https://api.airtable.com/v0';

/**
 * Minimal Airtable REST client over the built-in fetch (Electron main / Node 18+).
 * Handles auth, JSON, and the 429 rate limit with a single backoff retry.
 */
class AirtableClient {
  constructor({ token, baseId }) {
    if (!token || !baseId) throw new Error('AirtableClient requires token and baseId');
    this.token = token;
    this.baseId = baseId;
  }

  async _request(method, urlPath, body, attempt = 0) {
    const url = `${API_ROOT}/${this.baseId}/${urlPath}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429 && attempt < 1) {
      // Airtable: 5 req/sec/base. Back off and retry once.
      await new Promise((r) => setTimeout(r, 1500));
      return this._request(method, urlPath, body, attempt + 1);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Airtable ${method} ${urlPath} -> ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : {};
  }

  /**
   * Who does this token belong to? Returns { id, email?, scopes }.
   * Not base-scoped, so it can't go through _request(). `id` (usr…) is always
   * present; `email` only if the token has the user.email:read scope.
   */
  async whoami() {
    const res = await fetch(`${API_ROOT}/meta/whoami`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Airtable whoami -> ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }

  /** List records with an optional filterByFormula and field projection. */
  async listRecords(tableId, { filterByFormula, fields, maxRecords } = {}) {
    const params = new URLSearchParams();
    // Return fields keyed by field id so callers can index by stable ids, not names.
    params.set('returnFieldsByFieldId', 'true');
    if (filterByFormula) params.set('filterByFormula', filterByFormula);
    if (maxRecords) params.set('maxRecords', String(maxRecords));
    if (Array.isArray(fields)) fields.forEach((f) => params.append('fields[]', f));
    const data = await this._request('GET', `${tableId}?${params.toString()}`);
    return data.records || [];
  }

  async getRecord(tableId, recordId) {
    return this._request(
      'GET',
      `${tableId}/${encodeURIComponent(recordId)}?returnFieldsByFieldId=true`
    );
  }

  async createRecord(tableId, fields, { typecast = true } = {}) {
    const data = await this._request('POST', tableId, { fields, typecast });
    log.debug('airtable: created', tableId, data.id);
    return data;
  }

  async updateRecord(tableId, recordId, fields, { typecast = true } = {}) {
    const data = await this._request(
      'PATCH',
      `${tableId}/${encodeURIComponent(recordId)}`,
      { fields, typecast }
    );
    log.debug('airtable: updated', tableId, recordId);
    return data;
  }
}

module.exports = { AirtableClient };
