/** @OnlyCurrentDoc */
/**
 * VCID Generator — VCID log backend.
 *
 * A Google Apps Script web app bound to a Google Sheet. Every batch of VCIDs reserved
 * in the VCID Generator is recorded as one row in the "Log" tab. A batch whose unit
 * numbers overlap a logged batch with the same prefix, manufacturer, year, month and
 * model is refused, so no VCID can be issued twice.
 *
 * Endpoints (all responses are JSON unless noted):
 *   GET  ?action=next&prefix=VC&manufacturer=JHU&year=26&month=10&model=001
 *                                          Next free unit number for that combination.
 *   GET  ?action=csv&token=<EXPORT_TOKEN>  Full log as CSV (text/csv). Used by the GitHub Action.
 *   POST {"action":"reserve", ...}         Checks and records a batch. Body is sent as text/plain.
 *
 * Setup: see README.md, section "VCID log".
 */

const SHEET_NAME = 'Log';

// Column order of the Log tab and of data/vcid_log.csv. Do not reorder.
const HEADERS = [
  'batch_id', 'timestamp_utc', 'name', 'prefix', 'manufacturer', 'year', 'month',
  'model', 'start', 'end', 'first_id', 'last_id', 'count'
];

const PREFIXES = ['VC', 'VT', 'VP'];
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
      return json_({ ok: true, key: keyString_(key), next_start: nextStart_(readLog_(), key) });
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
    const rows = readLog_();
    const key = keyString_(req);
    const overlaps = rows.filter(r => keyString_(r) === key && req.start <= r.end && req.end >= r.start);

    if (overlaps.length) {
      const c = overlaps[0];
      return json_({
        ok: false,
        error: 'overlap',
        message: 'Part of this batch has already been issued.',
        conflict: {
          batch_id: c.batch_id, timestamp_utc: c.timestamp_utc, name: c.name,
          first_id: c.first_id, last_id: c.last_id
        },
        next_start: nextStart_(rows, req)
      });
    }

    const record = {
      batch_id: 'B-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase(),
      timestamp_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      name: req.name,
      prefix: req.prefix,
      manufacturer: req.manufacturer,
      year: req.year,
      month: req.month,
      model: req.model,
      start: req.start,
      end: req.end,
      first_id: vcid_(req, req.start),
      last_id: vcid_(req, req.end),
      count: req.end - req.start + 1
    };

    appendRecord_(record);

    rows.push(record);
    return json_({ ok: true, record: record, next_start: nextStart_(rows, req) });
  } finally {
    lock.releaseLock();
  }
}

// ── Validation ──

// Prefix, manufacturer, year, month and model: the fields that share one unit-number sequence.
function validateKey_(b) {
  const prefix = String(b.prefix == null ? '' : b.prefix).trim().toUpperCase();
  if (PREFIXES.indexOf(prefix) === -1) throw new Error('Prefix must be VC, VT or VP.');

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

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    // Plain-text format keeps timestamps, codes and leading zeros exactly as written.
    sheet.getRange(1, 1, sheet.getMaxRows(), HEADERS.length).setNumberFormat('@');
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Writes one row as plain text, so the sheet does not convert timestamps or numbers.
function appendRecord_(record) {
  const sheet = getSheet_();
  const row = sheet.getLastRow() + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 100);
  sheet.getRange(row, 1, 1, HEADERS.length)
    .setNumberFormat('@')
    .setValues([HEADERS.map(h => String(record[h]))]);
  SpreadsheetApp.flush();
}

function readLog_() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, HEADERS.length).getDisplayValues();
  return values
    .filter(row => row[0] !== '')
    .map(row => {
      const r = {};
      HEADERS.forEach((h, i) => { r[h] = String(row[i]).trim(); });
      // Rows typed by hand may have lost leading zeros; normalize them for comparison.
      r.prefix = r.prefix.toUpperCase();
      r.manufacturer = r.manufacturer.toUpperCase();
      r.year = pad_(parseInt(r.year, 10), 2);
      r.month = pad_(parseInt(r.month, 10), 2);
      r.model = pad_(parseInt(r.model, 10), 3);
      r.start = parseInt(r.start, 10);
      r.end = parseInt(r.end, 10);
      return r;
    })
    .filter(r => !isNaN(r.start) && !isNaN(r.end));
}

// The unit number after the highest logged end for the combination, or 1 if none is logged.
function nextStart_(rows, key) {
  const k = keyString_(key);
  let maxEnd = 0;
  rows.forEach(r => { if (keyString_(r) === k && r.end > maxEnd) maxEnd = r.end; });
  return maxEnd + 1;
}

function toCsv_() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  const rows = last >= 2
    ? sheet.getRange(2, 1, last - 1, HEADERS.length).getDisplayValues().filter(r => r[0] !== '')
    : [];
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
