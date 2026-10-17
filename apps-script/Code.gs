/** @OnlyCurrentDoc */
/**
 * VCID Generator — VCID log backend.
 *
 * A Google Apps Script web app bound to a Google Sheet. Every VCID reserved in the
 * VCID Generator is recorded as one row, on the tab for its prefix:
 *   VC → "VectorCam (VC)", VT → "VectorCatch (VT)", VP → "Phone (VP)".
 * A batch that contains a VCID already on the tab is refused, so no VCID is issued twice.
 *
 * Endpoints (all responses are JSON unless noted):
 *   GET  ?action=next&prefix=VC&manufacturer=JHU&year=26&month=10&model=001
 *                                          Next free unit number for that combination.
 *   GET  ?action=csv&token=<EXPORT_TOKEN>  All tabs as one CSV (text/csv). Used by the GitHub Action.
 *   POST {"action":"reserve", ...}         Checks and records a batch. Body is sent as text/plain.
 *
 * Setup: see README.md, section "VCID log".
 */

// One tab per prefix. The tab is found by name, so rename a tab here and in the sheet together.
const TABS = {
  VC: 'VectorCam (VC)',
  VT: 'VectorCatch (VT)',
  VP: 'Phone (VP)'
};

// Column order of every prefix tab and of data/vcid_log.csv. Do not reorder.
const HEADERS = [
  'vcid', 'batch_id', 'timestamp_utc', 'name', 'prefix', 'manufacturer', 'year', 'month',
  'model', 'unit'
];

const MAX_UNIT = 9999;
const MAX_TEXT = 60;

// A batch may use the current month in any time zone, so the server accepts the month
// at UTC now, 14 hours earlier and 14 hours later.
const MONTH_TOLERANCE_HOURS = 14;

// ── Entry points ──

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'next') {
      const key = validateKey_(p);
      return json_({ ok: true, key: keyString_(key), next_start: nextStart_(readTab_(key.prefix), key) });
    }
    if (p.action === 'csv') {
      const expected = PropertiesService.getScriptProperties().getProperty('EXPORT_TOKEN');
      if (!expected || p.token !== expected) {
        return json_({ ok: false, error: 'unauthorized', message: 'A valid export token is required.' });
      }
      return ContentService.createTextOutput(toCsv_())
        .setMimeType(ContentService.MimeType.CSV);
    }
    return json_({ ok: false, error: 'bad_request', message: 'Unknown action.' });
  } catch (err) {
    return json_({ ok: false, error: 'bad_request', message: String(err.message || err) });
  }
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_request', message: 'The request body is not valid JSON.' });
  }
  if (body.action !== 'reserve') {
    return json_({ ok: false, error: 'bad_request', message: 'Unknown action.' });
  }

  let req;
  try {
    req = validateReserve_(body);
  } catch (err) {
    return json_({ ok: false, error: 'bad_request', message: String(err.message || err) });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return json_({ ok: false, error: 'busy', message: 'The VCID log is busy. Try again.' });
  }
  try {
    const rows = readTab_(req.prefix);
    const key = keyString_(req);
    const sameKey = rows.filter(r => keyString_(r) === key);
    const clash = sameKey.find(r => r.unit >= req.start && r.unit <= req.end);

    if (clash) {
      // Describe the logged batch that holds the clashing VCID.
      const batch = sameKey.filter(r => r.batch_id === clash.batch_id).sort((a, b) => a.unit - b.unit);
      return json_({
        ok: false,
        error: 'overlap',
        message: 'Part of this batch has already been issued.',
        conflict: {
          batch_id: clash.batch_id, timestamp_utc: clash.timestamp_utc, name: clash.name,
          first_id: batch[0].vcid, last_id: batch[batch.length - 1].vcid
        },
        next_start: nextStart_(rows, req)
      });
    }

    const batchId = 'B-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const devices = [];
    for (let unit = req.start; unit <= req.end; unit++) {
      devices.push({
        vcid: vcid_(req, unit),
        batch_id: batchId,
        timestamp_utc: timestamp,
        name: req.name,
        prefix: req.prefix,
        manufacturer: req.manufacturer,
        year: req.year,
        month: req.month,
        model: req.model,
        unit: pad_(unit, 4)
      });
    }

    appendRows_(req.prefix, devices);

    const record = {
      batch_id: batchId,
      timestamp_utc: timestamp,
      name: req.name,
      prefix: req.prefix,
      manufacturer: req.manufacturer,
      year: req.year,
      month: req.month,
      model: req.model,
      start: req.start,
      end: req.end,
      first_id: devices[0].vcid,
      last_id: devices[devices.length - 1].vcid,
      count: devices.length
    };
    return json_({ ok: true, record: record, next_start: Math.max(maxUnit_(sameKey), req.end) + 1 });
  } finally {
    lock.releaseLock();
  }
}

// ── Validation ──

// Prefix, manufacturer, year, month and model: the fields that share one unit-number sequence.
function validateKey_(b) {
  const prefix = String(b.prefix == null ? '' : b.prefix).trim().toUpperCase();
  if (!TABS[prefix]) throw new Error('Prefix must be VC, VT or VP.');

  const manufacturer = String(b.manufacturer == null ? '' : b.manufacturer).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(manufacturer)) throw new Error('Manufacturer must be three letters.');

  const year = toInt_(b.year, 'Year');
  const month = toInt_(b.month, 'Month');
  if (year < 0 || year > 99) throw new Error('Year must be two digits.');
  if (month < 1 || month > 12) throw new Error('Month must be from 1 to 12.');

  const model = toInt_(b.model, 'Model number');
  if (model < 1 || model > 999) throw new Error('Model number must be from 1 to 999.');

  return {
    prefix: prefix,
    manufacturer: manufacturer,
    year: pad_(year, 2),
    month: pad_(month, 2),
    model: pad_(model, 3)
  };
}

function validateReserve_(b) {
  const name = cleanText_(b.name);
  if (!name) throw new Error('Name is required.');

  const key = validateKey_(b);
  if (!isCurrentMonth_(key.year, key.month)) {
    throw new Error('Year and month must be the current month. Reload the page and try again.');
  }

  const start = toInt_(b.start, 'Start unit number');
  const end = toInt_(b.end, 'End unit number');
  if (start < 1) throw new Error('Start unit number must be at least 1.');
  if (end < start) throw new Error('End unit number must not be less than the start unit number.');
  if (end > MAX_UNIT) throw new Error('End unit number must not exceed ' + MAX_UNIT + '.');

  key.name = name;
  key.start = start;
  key.end = end;
  return key;
}

function isCurrentMonth_(yy, mm) {
  const now = Date.now();
  const offsets = [-MONTH_TOLERANCE_HOURS, 0, MONTH_TOLERANCE_HOURS];
  return offsets.some(h => {
    const d = new Date(now + h * 3600 * 1000);
    return pad_(d.getUTCFullYear() % 100, 2) === yy && pad_(d.getUTCMonth() + 1, 2) === mm;
  });
}

// Trims, collapses whitespace, removes leading characters that spreadsheets treat as formulas.
function cleanText_(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[=+\-@]+/, '')
    .trim()
    .slice(0, MAX_TEXT);
}

function toInt_(v, label) {
  const s = String(v == null ? '' : v).trim();
  const n = Number(s);
  if (s === '' || !Number.isInteger(n)) throw new Error(label + ' must be a whole number.');
  return n;
}

// ── VCIDs ──

// Damm algorithm operation table (weakly totally anti-symmetric quasigroup of order 10).
const DAMM = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2], [7, 0, 9, 2, 1, 5, 4, 8, 6, 3], [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6], [6, 1, 2, 3, 0, 4, 5, 9, 7, 8], [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4], [8, 9, 4, 5, 3, 6, 2, 0, 1, 7], [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0]
];

function damm_(digits) {
  let i = 0;
  for (let k = 0; k < digits.length; k++) i = DAMM[i][digits.charCodeAt(k) - 48];
  return i;
}

function vcid_(key, unit) {
  const body = key.year + key.month + key.model + pad_(unit, 4);
  return key.prefix + key.manufacturer + body + damm_(body);
}

function keyString_(r) {
  return [r.prefix, r.manufacturer, r.year, r.month, r.model].join('|');
}

// ── Log access ──

function getTab_(prefix) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = TABS[prefix];
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    // Plain-text format keeps timestamps, codes and leading zeros exactly as written.
    sheet.getRange(1, 1, sheet.getMaxRows(), HEADERS.length).setNumberFormat('@');
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Writes one row per device as plain text, so the sheet does not convert timestamps or numbers.
function appendRows_(prefix, devices) {
  const sheet = getTab_(prefix);
  const first = sheet.getLastRow() + 1;
  const needed = first + devices.length - 1 - sheet.getMaxRows();
  if (needed > 0) sheet.insertRowsAfter(sheet.getMaxRows(), needed + 100);
  sheet.getRange(first, 1, devices.length, HEADERS.length)
    .setNumberFormat('@')
    .setValues(devices.map(d => HEADERS.map(h => String(d[h]))));
  SpreadsheetApp.flush();
}

function readTab_(prefix) {
  const sheet = getTab_(prefix);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, HEADERS.length).getDisplayValues();
  return values
    .filter(row => row[0] !== '')
    .map(row => {
      const r = {};
      HEADERS.forEach((h, i) => { r[h] = String(row[i]).trim(); });
      // Rows typed by hand may have lost leading zeros; normalize them for comparison.
      r.prefix = (r.prefix || prefix).toUpperCase();
      r.manufacturer = r.manufacturer.toUpperCase();
      r.year = pad_(parseInt(r.year, 10), 2);
      r.month = pad_(parseInt(r.month, 10), 2);
      r.model = pad_(parseInt(r.model, 10), 3);
      r.unit = parseInt(r.unit, 10);
      return r;
    })
    .filter(r => !isNaN(r.unit));
}

function maxUnit_(rows) {
  let max = 0;
  rows.forEach(r => { if (r.unit > max) max = r.unit; });
  return max;
}

// The unit number after the highest logged unit for the combination, or 1 if none is logged.
function nextStart_(rows, key) {
  const k = keyString_(key);
  return maxUnit_(rows.filter(r => keyString_(r) === k)) + 1;
}

// Every prefix tab, in the order of TABS, as one CSV with a single header row.
function toCsv_() {
  let rows = [];
  Object.keys(TABS).forEach(prefix => {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS[prefix]);
    if (!sheet || sheet.getLastRow() < 2) return;
    rows = rows.concat(sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length)
      .getDisplayValues().filter(r => r[0] !== ''));
  });
  return [HEADERS].concat(rows).map(r => r.map(csvCell_).join(',')).join('\n') + '\n';
}

function csvCell_(v) {
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ── Helpers ──

function pad_(n, digits) {
  let s = String(n);
  while (s.length < digits) s = '0' + s;
  return s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
