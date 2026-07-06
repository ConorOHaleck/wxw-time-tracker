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
  $('settingsBtn').classList.toggle('hidden', view !== 'status');
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

  const dot = $('dot');
  const connecting = ['connecting', 'scanning', 'authenticating'].includes(s2.bleState);
  dot.className = 'dot ' + (s2.connected ? 'online' : connecting ? 'connecting' : 'offline');
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
  if (s2.currentFacet > 0) {
    // A trackable face is up — show the Adventure assigned to it.
    faceEl.textContent = s2.adventureName || `Face ${s2.currentFacet}`;
    faceEl.className = 'face' + (s2.adventureName ? ' name' : '');
    $('faceLabel').textContent = `Tracking · face ${s2.currentFacet}`;
  } else if (face > 0) {
    faceEl.textContent = `Face ${face}`;
    faceEl.className = 'face idle';
    $('faceLabel').textContent = 'This face isn’t set to track time';
  } else {
    faceEl.textContent = '–';
    faceEl.className = 'face idle';
    $('faceLabel').textContent = s2.connected ? 'No face detected' : 'Looking for your TimeFlip…';
  }

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

function prefillSetup(settings) {
  if (!settings) return;
  $('token').value = settings.airtableToken || '';
  $('bleName').value = settings.bleNamePrefix || 'TimeFlip';
  $('minSession').value = settings.minSessionSeconds ?? 30;
  $('pauseFaces').value = (settings.pauseFaces || []).join(', ');
  const target = settings.useProduction ? 'production' : 'testing';
  document.querySelector(`input[name="target"][value="${target}"]`).checked = true;
  $('prodWarn').classList.toggle('hidden', target !== 'production');
}

function setMsg(el, text, kind) {
  el.textContent = text;
  el.className = 'msg ' + (kind || '');
  el.classList.remove('hidden');
}

async function testConnection() {
  const token = $('token').value.trim();
  const btn = $('testBtn');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  setMsg($('testMsg'), 'Checking your token…', '');
  try {
    const res = await window.timeflip.testConnection(token);
    if (!res.ok) {
      setMsg($('testMsg'), res.error, 'error');
      return;
    }
    const sel = $('deviceSelect');
    sel.innerHTML = '';
    if (!res.devices.length) {
      sel.innerHTML = '<option value="">No TimeFlip records found in the base</option>';
    } else {
      sel.innerHTML = '<option value="">Choose your device…</option>';
      for (const d of res.devices) {
        const opt = document.createElement('option');
        opt.value = d.recordId;
        opt.textContent = d.label;
        sel.appendChild(opt);
      }
      // Pre-select the previously chosen device if present.
      if (window.__savedRecordId) sel.value = window.__savedRecordId;
    }
    sel.disabled = false;
    $('deviceStep').setAttribute('aria-disabled', 'false');
    setMsg($('testMsg'), `Connected ✓  Found ${res.devices.length} device(s).`, 'ok');
    refreshSaveEnabled();
  } catch (err) {
    setMsg($('testMsg'), err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test connection';
  }
}

function refreshSaveEnabled() {
  const ready = $('token').value.trim() && $('deviceSelect').value;
  $('saveBtn').disabled = !ready;
}

async function saveSettings() {
  const useProduction = document.querySelector('input[name="target"]:checked').value === 'production';
  const pauseFaces = $('pauseFaces')
    .value.split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n));
  const settings = {
    airtableToken: $('token').value.trim(),
    timeflipRecordId: $('deviceSelect').value,
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
$('testBtn').addEventListener('click', testConnection);
$('token').addEventListener('input', refreshSaveEnabled);
$('deviceSelect').addEventListener('change', refreshSaveEnabled);
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
    btn.textContent = 'Sync past time now';
  }
});

(async function boot() {
  const state = await window.timeflip.getState();
  window.__savedRecordId = state.settings && state.settings.timeflipRecordId;
  pairedName = (state.settings && state.settings.bleDeviceName) || '';
  prefillSetup(state.settings);
  if (state.configured) {
    render(state.snapshot);
    show('status');
  } else {
    show('setup');
  }
})();

setInterval(tickElapsed, 1000);
