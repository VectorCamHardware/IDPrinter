/** @OnlyCurrentDoc */

/**
 * ID Printer — print log backend.
 *
 * A Google Apps Script web app bound to a Google Sheet. Every sheet printed from the
 * ID Printer is recorded as one row in the "Log" tab. Sheets printed before the ID
 * Printer existed are imported as rows with source "sync" (see importSyncedSheets).
 *
 * Prefix modes:
 *   auto  The server assigns the first three-letter prefix, in alphabetical order
 *         (AAA, AAB, ..., ZZZ), that does not appear anywhere in the log and is not in
 *         RESERVED_PREFIXES. Codes run from 001. Each prefix is used by one print only.
 *   test  Prefix TST. Any range may be printed, including ranges already printed;
 *         repeated ranges are logged with reprint TRUE.
 *
 * Endpoints (all responses are JSON unless noted):
 *   GET  ?action=next&mode=auto            Prefix the next auto print will receive.
 *   GET  ?action=next&mode=test            Next unprinted TST start number.
 *   GET  ?action=csv&token=<EXPORT_TOKEN>  Full log as CSV (text/csv). Used by the GitHub Action.
 *   POST {"action":"reserve","mode":...}   Checks and records a print. Body is sent as text/plain.
 *
 * Setup: see README.md, section "Print log".
 */

const SHEET_NAME = 'Log';

// Column order of the Log tab, data/printed_sheets.csv and data/synced_sheets.csv. Do not reorder.
const HEADERS = [
  'print_id', 'timestamp_utc', 'name', 'program', 'prefix', 'start', 'end',
  'first_code', 'last_code', 'codes', 'pages', 'paper', 'reprint', 'source', 'note'
];

// Prefix used in test mode. Test ranges may be printed more than once.
const TEST_PREFIX = 'TST';

// Prefixes that auto mode never assigns, in addition to every prefix in the log.
// AEM and AEN: the archived file VCI_Perforated_AEM_AEN.docx holds ADM/ADN codes, so
// it is not known whether AEM or AEN labels were ever printed.
const RESERVED_PREFIXES = ['TST', 'AEM', 'AEN'];

// Auto codes keep three digits (AAA001-AAA992).
const AUTO_MAX_END = 992;
const MAX_NUMBER = 99999;
const MAX_TEXT = 60;
const PAPER_SIZES = ['A4', 'Letter'];

// Rows imported by the sheet menu. Same columns as HEADERS.
const SYNC_CSV_URL = 'https://raw.githubusercontent.com/VectorCamHardware/IDPrinter/main/data/synced_sheets.csv';

// ── Entry points ──

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'next') {
      const rows = readLog_();
      if (p.mode === 'auto') {
        return json_({ ok: true, mode: 'auto', prefix: nextAutoPrefix_(rows), next_start: 1, max_end: AUTO_MAX_END });
      }
      if (p.mode === 'test') {
        return json_({ ok: true, mode: 'test', prefix: TEST_PREFIX, next_start: nextStart_(rows, TEST_PREFIX) });
      }
      return json_({ ok: false, error: 'bad_request', message: 'Mode must be auto or test. Reload the ID Printer.' });
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

    let prefix, start;
    if (req.mode === 'auto') {
      prefix = nextAutoPrefix_(rows);
      if (!prefix) {
        return json_({ ok: false, error: 'exhausted', message: 'No unused prefix remains.' });
      }
      start = 1;
    } else {
      prefix = TEST_PREFIX;
      start = req.start;
    }
    const end = req.end;

    // An auto prefix is unused by construction; the check guards against any other case.
    const overlaps = rows.filter(r => r.prefix === prefix && start <= r.end && end >= r.start);
    if (overlaps.length && req.mode !== 'test') {
      const c = overlaps[0];
      return json_({
        ok: false,
        error: 'overlap',
        message: 'Part of this range has already been printed.',
        conflict: {
          print_id: c.print_id, timestamp_utc: c.timestamp_utc, name: c.name,
          program: c.program, first_code: c.first_code, last_code: c.last_code, source: c.source
        },
        prefix: nextAutoPrefix_(rows)
      });
    }

    const digits = Math.max(3, String(end).length);
    const record = {
      print_id: 'P-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase(),
      timestamp_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      name: req.name,
      program: req.program,
      prefix: prefix,
      start: start,
      end: end,
      first_code: prefix + pad_(start, digits),
      last_code: prefix + pad_(end, digits),
      codes: end - start + 1,
      pages: req.pages,
      paper: req.paper,
      reprint: overlaps.length ? 'TRUE' : 'FALSE',
      source: 'print',
      note: ''
    };

    appendRecords_([record]);
    rows.push(record);

    return json_({
      ok: true,
      record: record,
      mode: req.mode,
      prefix: req.mode === 'auto' ? nextAutoPrefix_(rows) : TEST_PREFIX,
      next_start: req.mode === 'auto' ? 1 : nextStart_(rows, TEST_PREFIX)
    });
  } finally {
    lock.releaseLock();
  }
}

// ── Sheet menu ──

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ID Printer')
    .addItem('Import synced sheets from repository', 'importSyncedSheets')
    .addToUi();
}

/**
 * Appends the rows of data/synced_sheets.csv (in the repository) that are not yet in the
 * Log tab, matched by print_id. Running it again adds only new rows.
 */
function importSyncedSheets() {
  const ui = SpreadsheetApp.getUi();
  const res = UrlFetchApp.fetch(SYNC_CSV_URL, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    ui.alert('Import failed', 'The file could not be downloaded (HTTP ' + res.getResponseCode() + '):\n' + SYNC_CSV_URL, ui.ButtonSet.OK);
    return;
  }

  let result;
  try {
    result = importSyncedCsv_(res.getContentText());
  } catch (err) {
    ui.alert('Import failed', String(err.message || err), ui.ButtonSet.OK);
    return;
  }
  ui.alert('Import complete',
    result.added + ' rows added. ' + result.skipped + ' rows were already in the log.',
    ui.ButtonSet.OK);
}

function importSyncedCsv_(text) {
  const data = Utilities.parseCsv(text);
  if (!data.length || data[0].join(',') !== HEADERS.join(',')) {
    throw new Error('The file header does not match the Log columns.');
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('The print log is busy. Try again.');
  try {
    const existing = {};
    readLog_().forEach(r => { existing[r.print_id] = true; });

    const records = [];
    let skipped = 0;
    data.slice(1).forEach((row, i) => {
      if (!row.join('').trim()) return;
      if (row.length !== HEADERS.length) throw new Error('Line ' + (i + 2) + ': wrong number of columns.');
      const r = {};
      HEADERS.forEach((h, j) => { r[h] = row[j]; });
      if (!/^S-[0-9A-F]{8}$/.test(r.print_id)) throw new Error('Line ' + (i + 2) + ': print_id must have the form S-XXXXXXXX.');
      if (r.source !== 'sync') throw new Error('Line ' + (i + 2) + ': source must be sync.');
      if (!/^[A-Z]{3}$/.test(r.prefix)) throw new Error('Line ' + (i + 2) + ': prefix must be three letters.');
      if (existing[r.print_id]) { skipped++; return; }
      existing[r.print_id] = true;
      records.push(r);
    });

    appendRecords_(records);
    return { added: records.length, skipped: skipped };
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

  const mode = b.mode;
  if (mode !== 'auto' && mode !== 'test') throw new Error('Mode must be auto or test. Reload the ID Printer.');

  const end = toInt_(b.end, 'End number');
  let start = 1;
  if (mode === 'test') {
    start = toInt_(b.start, 'Start number');
    if (start < 1 || start % 8 !== 1) throw new Error('Start number must be of the form 8n+1.');
  }
  if (end % 8 !== 0) throw new Error('End number must be a multiple of 8.');
  if (end < start + 7) throw new Error('End number must be at least start number + 7.');
  const max = mode === 'auto' ? AUTO_MAX_END : MAX_NUMBER;
  if (end > max) throw new Error('End number must not exceed ' + max + '.');

  const pages = toInt_(b.pages, 'Pages');
  if (pages < 1) throw new Error('Pages must be at least 1.');
  const paper = PAPER_SIZES.indexOf(b.paper) !== -1 ? b.paper : null;
  if (!paper) throw new Error('Paper must be A4 or Letter.');

  return { mode: mode, name: name, program: program, start: start, end: end, pages: pages, paper: paper };
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
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(label + ' must be a whole number.');
  return n;
}

// ── Log access ──

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getMaxColumns() < HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());
  }
  if (sheet.getLastRow() === 0) {
    // Plain-text format keeps timestamps and codes exactly as written.
    sheet.getRange(1, 1, sheet.getMaxRows(), HEADERS.length).setNumberFormat('@');
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    return sheet;
  }
  upgradeHeader_(sheet);
  return sheet;
}

// Adds the source and note columns to a log created before they existed.
// Existing rows are marked as source "print".
function upgradeHeader_(sheet) {
  const header = sheet.getRange(1, 1, 1, HEADERS.length).getDisplayValues()[0];
  if (header.join(',') === HEADERS.join(',')) return;
  const old = HEADERS.slice(0, 13);
  if (header.slice(0, 13).join(',') !== old.join(',')) {
    throw new Error('The Log tab header does not match the expected columns.');
  }
  sheet.getRange(1, 1, sheet.getMaxRows(), HEADERS.length).setNumberFormat('@');
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  const last = sheet.getLastRow();
  if (last >= 2) {
    const range = sheet.getRange(2, 14, last - 1, 1);
    const values = range.getDisplayValues();
    const ids = sheet.getRange(2, 1, last - 1, 1).getDisplayValues();
    range.setValues(values.map((v, i) => [v[0] || (ids[i][0] ? 'print' : '')]));
  }
  SpreadsheetApp.flush();
}

// Writes rows as plain text, so the sheet does not convert timestamps or numbers.
function appendRecords_(records) {
  if (!records.length) return;
  const sheet = getSheet_();
  const row = sheet.getLastRow() + 1;
  const needed = row + records.length - 1 - sheet.getMaxRows();
  if (needed > 0) sheet.insertRowsAfter(sheet.getMaxRows(), Math.max(needed, 100));
  sheet.getRange(row, 1, records.length, HEADERS.length)
    .setNumberFormat('@')
    .setValues(records.map(rec => HEADERS.map(h => String(rec[h] == null ? '' : rec[h]))));
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
      r.prefix = String(r.prefix).trim().toUpperCase();
      r.source = r.source || 'print';
      r.start = parseInt(r.start, 10);
      r.end = parseInt(r.end, 10);
      return r;
    })
    .filter(r => !isNaN(r.start) && !isNaN(r.end));
}

// First prefix in alphabetical order that is not in the log and not reserved.
function nextAutoPrefix_(rows) {
  const used = {};
  rows.forEach(r => { used[r.prefix] = true; });
  RESERVED_PREFIXES.forEach(p => { used[p] = true; });
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < 26 * 26 * 26; i++) {
    const p = A[Math.floor(i / 676)] + A[Math.floor(i / 26) % 26] + A[i % 26];
    if (!used[p]) return p;
  }
  return null;
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
