'use strict';

const $ = (id) => document.getElementById(id);
let snapshot = null;
let pairedName = '';
let devices = [];

// Friendly names for the two Hours tables (ids baked into the app).
const TABLE_LABELS = {
  tbll6GJlXkJyjhPom: 'Hours Testing',
  tblOtz0vowbHJnuAG: 'Hours',
};

function show(view) {
  $('setupView').classList.toggle('hidden', view !== 'setup');
  $('statusView').classList.toggle('hidden', view !== 'status');
  // The header's action slot: Settings on the tracking screen, Save on setup.
  $('settingsBtn').classList.toggle('hidden', view !== 'status');
  $('saveBtn').classList.toggle('hidden', view !== 'setup');
}

// ---------- status view ----------

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString();
}

function render(s) {
  snapshot = s || snapshot;
  if (!snapshot) return;
  const s2 = snapshot;

  $('conn').textContent = s2.connected ? 'Connected' : s2.bleState || 'disconnected';

  $('deviceName').textContent = s2.connected
    ? pairedName || 'Connected'
    : pairedName
      ? `${pairedName} (offline)`
      : 'Not paired';
  $('deviceHint').textContent = s2.connected
    ? `Connected to ${pairedName || 'your TimeFlip'}`
    : pairedName
      ? 'Reconnecting to your TimeFlip…'
      : 'Searching for your TimeFlip…';

  const faceEl = $('faceBig');
  const face = s2.currentFacet > 0 ? s2.currentFacet : s2.deviceFacet;
  if (s2.tracking) {
    // Actually logging time — show the Adventure assigned to this face.
    faceEl.textContent = s2.adventureName || `Face ${s2.currentFacet}`;
    faceEl.className = 'face' + (s2.adventureName ? ' name' : '');
    $('faceLabel').textContent = `Tracking · face ${s2.currentFacet}`;
  } else if (face > 0) {
    // A face is up but we are NOT logging it — say exactly why.
    faceEl.textContent = `Face ${face}`;
    faceEl.className = 'face idle';
    $('faceLabel').textContent = s2.notTrackingReason || 'This face isn’t set to track time';
  } else {
    faceEl.textContent = '–';
    faceEl.className = 'face idle';
    $('faceLabel').textContent = s2.connected ? 'No face detected' : 'Looking for your TimeFlip…';
  }

  // Practice mode — make it obvious this time won't reach payroll.
  $('testingNotice').classList.toggle('hidden', !s2.isTestingTarget);

  // Using someone else's device — time still logs as you, but faces are theirs.
  const ownerWarn = $('ownerWarn');
  if (s2.ownerWarning) {
    ownerWarn.textContent = '⚠ ' + s2.ownerWarning;
    ownerWarn.classList.remove('hidden');
  } else {
    ownerWarn.classList.add('hidden');
  }

  // Billable role — the same person can hold several roles on one Adventure,
  // so this is what distinguishes two faces pointing at the same project.
  const roleChip = $('roleChip');
  if (s2.tracking && s2.billableRoleName) {
    roleChip.textContent = s2.billableRoleName;
    roleChip.classList.remove('hidden');
  } else {
    roleChip.classList.add('hidden');
  }
  $('billableRole').textContent = s2.billableRoleName || '—';

  $('trackState').textContent = s2.tracking ? 'Yes' : 'No';
  $('sessionStart').textContent = fmtTime(s2.sessionStartMs);
  $('faceCount').textContent = s2.faceCount != null ? s2.faceCount : '—';
  $('hoursTable').textContent = TABLE_LABELS[s2.hoursTable] || s2.hoursTable || '—';

  if (s2.error) showFatal('Heads up: ' + s2.error);
}

function tickElapsed() {
  if (snapshot && snapshot.tracking && snapshot.sessionStartMs) {
    const sec = Math.floor((Date.now() - snapshot.sessionStartMs) / 1000);
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    $('elapsed').textContent = `${h}:${m}:${s}`;
  } else {
    $('elapsed').textContent = '';
  }
}

function showFatal(msg) {
  $('fatal').textContent = msg;
  $('fatal').classList.remove('hidden');
}

// ---------- setup view ----------

let people = []; // [{userId, name}] for the "your name" dropdown

function prefillSetup(settings) {
  if (!settings) return;
  $('token').value = settings.airtableToken || '';
  window.__savedUserId = settings.selectedUserId || '';
  window.__savedRecordId = settings.timeflipRecordId || '';
  $('manualDevice').checked = !!settings.timeflipRecordId;
  $('bleName').value = settings.bleNamePrefix || 'TimeFlip';
  $('minSession').value = settings.minSessionSeconds ?? 30;
  $('pauseFaces').value = (settings.pauseFaces || []).join(', ');
  const target = settings.useProduction ? 'production' : 'testing';
  document.querySelector(`input[name="target"][value="${target}"]`).checked = true;
  $('prodWarn').classList.toggle('hidden', target !== 'production');
  updateOverrideVisibility();
}

function setMsg(el, text, kind) {
  el.textContent = text;
  el.className = 'msg ' + (kind || '');
  el.classList.remove('hidden');
}

/** Load the "select your name" list (and the override device list) via the shared token. */
async function loadPeople() {
  const btn = $('connectBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Connecting…';
  }
  const sel = $('personSelect');
  sel.disabled = true;
  sel.innerHTML = '<option value="">Loading names…</option>';
  try {
    const res = await window.timeflip.loadPeople($('token').value.trim());
    if (!res.ok) {
      sel.innerHTML = '<option value="">Couldn’t load names</option>';
      setMsg($('testMsg'), res.error, 'error');
      return;
    }
    people = res.people || [];
    sel.innerHTML = '<option value="">Select your name…</option>';
    for (const p of people) {
      const o = document.createElement('option');
      o.value = p.userId;
      o.textContent = p.name;
      sel.appendChild(o);
    }
    if (window.__savedUserId) sel.value = window.__savedUserId;
    sel.disabled = false;

    // Override device list (Advanced → "use a specific TimeFlip setup").
    const dsel = $('deviceSelect');
    dsel.innerHTML = '<option value="">Choose a TimeFlip setup…</option>';
    window.__deviceAssignee = {};
    for (const d of res.devices || []) {
      const o = document.createElement('option');
      o.value = d.recordId;
      o.textContent = d.label;
      dsel.appendChild(o);
      window.__deviceAssignee[d.recordId] = d.assigneeUserId || null;
    }
    if (window.__savedRecordId) dsel.value = window.__savedRecordId;

    $('testMsg').classList.add('hidden');
    refreshDeviceWarning();
    refreshSaveEnabled();
  } catch (err) {
    setMsg($('testMsg'), err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  }
}

function updateOverrideVisibility() {
  $('deviceSelect').classList.toggle('hidden', !$('manualDevice').checked);
  refreshDeviceWarning();
}

function refreshSaveEnabled() {
  // The only thing required to start is having picked a name.
  $('saveBtn').disabled = !$('personSelect').value;
}

/** Warn when the manual override points at a setup belonging to someone else. */
function refreshDeviceWarning() {
  const el = $('deviceWarn');
  const rec = $('manualDevice').checked ? $('deviceSelect').value : '';
  const assignee = (window.__deviceAssignee || {})[rec];
  const me = $('personSelect').value;
  if (rec && assignee && me && assignee !== me) {
    el.innerHTML =
      "⚠ That setup belongs to someone else. Your time still logs under <b>your own name</b>, " +
      "but its faces' Adventures and Billable Roles are theirs.";
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

async function saveSettings() {
  const useProduction = document.querySelector('input[name="target"]:checked').value === 'production';
  const pauseFaces = $('pauseFaces')
    .value.split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n));
  const nameSel = $('personSelect');
  const settings = {
    selectedUserId: nameSel.value,
    selectedPersonName: nameSel.selectedIndex > 0 ? nameSel.options[nameSel.selectedIndex].text : '',
    airtableToken: $('token').value.trim(),
    // A value = deliberately use a specific setup; empty = the one assigned to me.
    timeflipRecordId: $('manualDevice').checked ? $('deviceSelect').value : '',
    useProduction,
    bleNamePrefix: $('bleName').value.trim() || 'TimeFlip',
    minSessionSeconds: parseInt($('minSession').value, 10) || 30,
    pauseFaces,
  };
  const btn = $('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  setMsg($('saveMsg'), 'Saving and connecting…', '');
  try {
    const res = await window.timeflip.saveSettings(settings);
    if (res && res.ok) {
      $('fatal').classList.add('hidden');
      show('status');
    } else {
      setMsg($('saveMsg'), (res && res.error) || 'Something went wrong.', 'error');
    }
  } catch (err) {
    setMsg($('saveMsg'), err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & start tracking';
    refreshSaveEnabled();
  }
}

// ---------- device picker ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function renderDevices(list) {
  if (list) devices = list;
  const el = $('deviceList');
  if (!devices.length) {
    el.innerHTML = '<div class="muted-row">Scanning… flip the die to wake it.</div>';
    return;
  }
  // Show likely-TimeFlip devices first.
  const sorted = [...devices].sort((a, b) => (/timeflip/i.test(b.name || '') ? 1 : 0) - (/timeflip/i.test(a.name || '') ? 1 : 0));
  el.innerHTML = '';
  for (const d of sorted) {
    const row = document.createElement('button');
    row.className = 'device-row';
    const likely = /timeflip/i.test(d.name || '');
    row.innerHTML =
      `<span class="dn">${escapeHtml(d.name || '(unnamed device)')}${likely ? ' <span class="tag">TimeFlip?</span>' : ''}</span>` +
      `<span class="di">${escapeHtml((d.id || '').slice(0, 8))}…</span>`;
    row.addEventListener('click', () => pickDevice(d.id));
    el.appendChild(row);
  }
}

function pickerMsg(text, isError) {
  const el = $('pickerMsg');
  el.textContent = text;
  el.className = isError ? 'msg error' : 'hint';
}

async function openPicker() {
  $('devicePicker').classList.remove('hidden');
  pickerMsg('Don’t see it? Flip the die to wake it, and make sure it isn’t connected to the phone app or another program.', false);
  renderDevices(await window.timeflip.listDevices());
}
function closePicker() {
  $('devicePicker').classList.add('hidden');
}
async function pickDevice(id) {
  const res = await window.timeflip.chooseDevice(id);
  if (res && res.ok) pickerMsg('Connecting…', false);
  else pickerMsg((res && res.error) || 'Could not select that device.', true);
}

window.timeflip.onDevices(renderDevices);
window.timeflip.onPaired((d) => {
  pairedName = (d && d.deviceName) || pairedName;
  closePicker();
  render(snapshot);
});
window.timeflip.onWrongDevice((d) => {
  pickerMsg(`“${(d && d.deviceName) || 'That device'}” isn’t a TimeFlip — pick another.`, true);
});

$('chooseDeviceBtn').addEventListener('click', openPicker);
$('cancelPickBtn').addEventListener('click', async () => {
  await window.timeflip.cancelPairing();
  closePicker();
});
$('forgetBtn').addEventListener('click', async () => {
  pairedName = '';
  await window.timeflip.forgetDevice();
  openPicker();
});

// ---------- wiring ----------

window.timeflip.onSnapshot(render);
window.timeflip.onFatal(showFatal);
window.timeflip.onShowSetup(() => show('setup'));

$('settingsBtn').addEventListener('click', () => show('setup'));
$('connectBtn').addEventListener('click', loadPeople);
$('personSelect').addEventListener('change', () => {
  refreshDeviceWarning();
  refreshSaveEnabled();
});
$('deviceSelect').addEventListener('change', refreshDeviceWarning);
$('manualDevice').addEventListener('change', updateOverrideVisibility);
$('saveBtn').addEventListener('click', saveSettings);
$('tokenHelp').addEventListener('click', (e) => {
  e.preventDefault();
  window.timeflip.openExternal('https://airtable.com/create/tokens');
});
document.querySelectorAll('input[name="target"]').forEach((r) =>
  r.addEventListener('change', () => {
    $('prodWarn').classList.toggle('hidden', document.querySelector('input[name="target"]:checked').value !== 'production');
  })
);

$('reconcileBtn').addEventListener('click', async () => {
  const btn = $('reconcileBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    render(await window.timeflip.reconcileNow());
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync past time';
  }
});

// Re-read the face setup from Airtable (after editing faces mid-session).
$('resyncBtn').addEventListener('click', async () => {
  const btn = $('resyncBtn');
  btn.disabled = true;
  btn.textContent = 'Reloading…';
  try {
    const res = await window.timeflip.resyncFaces();
    if (res && res.ok) {
      render(res.snapshot);
      const n = res.snapshot && res.snapshot.faceCount;
      setMsg($('actionMsg'), `Faces reloaded from Airtable${n != null ? ` (${n} faces)` : ''}.`, 'ok');
    } else {
      setMsg($('actionMsg'), (res && res.error) || 'Reload failed.', 'error');
    }
  } catch (err) {
    setMsg($('actionMsg'), err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Resync faces';
    setTimeout(() => $('actionMsg').classList.add('hidden'), 6000);
  }
});

(async function boot() {
  const state = await window.timeflip.getState();
  pairedName = (state.settings && state.settings.bleDeviceName) || '';
  prefillSetup(state.settings);

  // Hide the token field entirely when a token is baked into the build.
  $('tokenRow').classList.toggle('hidden', !!state.hasEmbeddedToken);

  // Load the name list right away if we already have a usable token.
  const haveToken = state.hasEmbeddedToken || (state.settings && state.settings.airtableToken);
  if (haveToken) loadPeople();

  refreshSaveEnabled();
  if (state.configured) {
    render(state.snapshot);
    show('status');
  } else {
    show('setup');
  }
})();

setInterval(tickElapsed, 1000);
