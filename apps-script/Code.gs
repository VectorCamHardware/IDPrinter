/**
 * ID Printer — print log backend.
 *
 * A Google Apps Script web app bound to a Google Sheet. Every sheet printed from the
 * ID Printer is recorded as one row in the "Log" tab. A range that overlaps a logged
 * range for the same prefix is refused, except for prefixes in REPRINT_ALLOWED.
 *
 * Endpoints (all responses are JSON unless noted):
 *   GET  ?action=next&prefix=UGA          Next free start number for a prefix.
 *   GET  ?action=csv&token=<EXPORT_TOKEN> Full log as CSV (text/csv). Used by the GitHub Action.
 *   POST {"action":"reserve", ...}        Checks and records a print. Body is sent as text/plain.
 *
 * Setup: see README.md, section "Print log".
 */

const SHEET_NAME = 'Log';

// Column order of the Log tab and of data/printed_sheets.csv. Do not reorder.
const HEADERS = [
  'print_id', 'timestamp_utc', 'name', 'program', 'prefix', 'start', 'end',
  'first_code', 'last_code', 'codes', 'pages', 'paper', 'reprint'
];

// Prefixes that are logged but may be printed more than once.
const REPRINT_ALLOWED = ['TST'];

const MAX_NUMBER = 99999;
const MAX_TEXT = 60;
const PAPER_SIZES = ['A4', 'Letter'];

// ── Entry points ──

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'next') {
      const prefix = cleanPrefix_(p.prefix);
      return json_({ ok: true, prefix: prefix, next_start: nextStart_(readLog_(), prefix) });
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
    return json_({ ok: false, error: 'busy', message: 'The print log is busy. Try again.' });
  }
  try {
    const rows = readLog_();
    const overlaps = rows.filter(r => r.prefix === req.prefix && req.start <= r.end && req.end >= r.start);
    const reprintAllowed = REPRINT_ALLOWED.indexOf(req.prefix) !== -1;

    if (overlaps.length && !reprintAllowed) {
      const c = overlaps[0];
      return json_({
        ok: false,
        error: 'overlap',
        message: 'Part of this range has already been printed.',
        conflict: {
          print_id: c.print_id, timestamp_utc: c.timestamp_utc, name: c.name,
          program: c.program, first_code: c.first_code, last_code: c.last_code
        },
        next_start: nextStart_(rows, req.prefix)
      });
    }

    const digits = Math.max(3, String(req.end).length);
    const record = {
      print_id: 'P-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase(),
      timestamp_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      name: req.name,
      program: req.program,
      prefix: req.prefix,
      start: req.start,
      end: req.end,
      first_code: req.prefix + pad_(req.start, digits),
      last_code: req.prefix + pad_(req.end, digits),
      codes: req.end - req.start + 1,
      pages: req.pages,
      paper: req.paper,
      reprint: overlaps.length ? 'TRUE' : 'FALSE'
    };

    appendRecord_(record);

    rows.push(record);
    return json_({ ok: true, record: record, next_start: nextStart_(rows, req.prefix) });
  } finally {
    lock.releaseLock();
  }
}

// ── Validation ──

function validateReserve_(b) {
  const name = cleanText_(b.name);
  const program = cleanText_(b.program);
  if (!name) throw new Error('Name is required.');
  if (!program) throw new Error('Program is required.');

  const prefix = cleanPrefix_(b.prefix);
  const start = toInt_(b.start, 'Start number');
  const end = toInt_(b.end, 'End number');
  if (start < 1 || start % 8 !== 1) throw new Error('Start number must be of the form 8n+1.');
  if (end % 8 !== 0) throw new Error('End number must be a multiple of 8.');
  if (end < start + 7) throw new Error('End number must be at least start number + 7.');
  if (end > MAX_NUMBER) throw new Error('End number must not exceed ' + MAX_NUMBER + '.');

  const pages = toInt_(b.pages, 'Pages');
  if (pages < 1) throw new Error('Pages must be at least 1.');
  const paper = PAPER_SIZES.indexOf(b.paper) !== -1 ? b.paper : null;
  if (!paper) throw new Error('Paper must be A4 or Letter.');

  return { name: name, program: program, prefix: prefix, start: start, end: end, pages: pages, paper: paper };
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

function cleanPrefix_(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) throw new Error('Prefix must be three letters.');
  return s;
}

function toInt_(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(label + ' must be a whole number.');
  return n;
}

// ── Log access ──

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    // Plain-text format keeps timestamps and codes exactly as written.
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
      HEADERS.forEach((h, i) => { r[h] = row[i]; });
      r.start = parseInt(r.start, 10);
      r.end = parseInt(r.end, 10);
      return r;
    })
    .filter(r => !isNaN(r.start) && !isNaN(r.end));
}

// First 8n+1 number after the highest logged end for the prefix.
function nextStart_(rows, prefix) {
  let maxEnd = 0;
  rows.forEach(r => { if (r.prefix === prefix && r.end > maxEnd) maxEnd = r.end; });
  return Math.ceil(maxEnd / 8) * 8 + 1;
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
