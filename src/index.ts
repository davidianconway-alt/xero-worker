// ============================================================
// MOBILOO — Staff Cost Model + Xero Invoices
// Fetches event data from Cloudflare Worker and writes to sheet
//
// SETUP:
// 1. Create a new Google Sheet
// 2. Open Extensions → Apps Script
// 3. Paste this code into Code.gs
// 4. Run createSheets() once to set up the tabs
// 5. Use the Mobiloo menu to refresh data
// ============================================================

var WORKER_URL          = 'https://xero-worker.wiltsforester.workers.dev/api/events/all';
var XERO_INVOICES_URL   = 'https://xero-worker.wiltsforester.workers.dev/api/xero/invoices';
var XERO_OUTGOINGS_URL  = 'https://xero-worker.wiltsforester.workers.dev/api/xero/outgoings';
var XERO_PAYMENTS_URL   = 'https://xero-worker.wiltsforester.workers.dev/api/xero/payments';
var XERO_CASHFLOW_URL   = 'https://xero-worker.wiltsforester.workers.dev/api/xero/cashflow-data';
var XERO_BANKTX_DETAIL_URL = 'https://xero-worker.wiltsforester.workers.dev/api/xero/bank-transactions-detail';
var XERO_PNL_URL        = 'https://xero-worker.wiltsforester.workers.dev/api/xero/pnl-by-code';

// ── MENU ─────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Mobiloo')
    .addItem('Refresh Event Data',          'refreshEventData')
    .addItem('Refresh Xero Invoices',       'refreshXeroInvoices')
    .addItem('Refresh Xero Outgoings',      'refreshXeroOutgoings')
    .addItem('Refresh Cash Flow',           'refreshCashFlow')
    .addItem('Refresh P&L by Account Code', 'refreshPnlByCode')
    .addItem('Setup Forecast Assumptions',  'setupForecastAssumptions')
    .addItem('Seed Q4 2026 from Bookings',  'seedQ4FromBookings')
    .addItem('Seed 2027 from 2026 Actuals', 'seed2027FromActuals')
    .addSeparator()
    .addItem('Setup Sheets (run once)', 'createSheets')
    .addToUi();
}

// ── MAIN REFRESH ─────────────────────────────────────────────

function refreshEventData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var eventsResponse = UrlFetchApp.fetch(WORKER_URL, { muteHttpExceptions: true });
  if (eventsResponse.getResponseCode() !== 200) {
    SpreadsheetApp.getUi().alert('Error fetching events: HTTP ' + eventsResponse.getResponseCode());
    return;
  }

  var invoicesResponse = UrlFetchApp.fetch(XERO_INVOICES_URL, { muteHttpExceptions: true });
  if (invoicesResponse.getResponseCode() !== 200) {
    SpreadsheetApp.getUi().alert('Error fetching Xero invoices: HTTP ' + invoicesResponse.getResponseCode());
    return;
  }

  var data     = JSON.parse(eventsResponse.getContentText());
  var items    = data.events || [];
  var invData  = JSON.parse(invoicesResponse.getContentText());
  var invoices = invData.invoices || [];

  if (items.length === 0) {
    SpreadsheetApp.getUi().alert('No events found in forecast data.');
    return;
  }

  // Build SP ID → invoice totals lookup.
  // A single invoice can reference multiple UIDs (e.g. "UID: 2330679 & 2330681") —
  // when this happens the invoice amounts are split EVENLY across all referenced
  // UIDs, so summing Invoiced Total down the whole Events column gives a correct
  // portfolio total (no double-counting). This is an apportionment, not a record
  // of what was actually billed per event — for genuine per-invoice figures use
  // the Xero Invoices tab.
  // Due/paid dates: where a UID's invoice(s) include any AUTHORISED invoice the
  // latest due date is kept; the paid date is only set once ALL invoices
  // referencing that UID are fully paid (uses the latest paid date in that case).
  var invoiceLookup = {};
  invoices.forEach(function(inv) {
    var ref = inv.reference || '';
    var uids = [];
    var uidMatch;
    var re = /UID:\s*(\d+)/g;
    while ((uidMatch = re.exec(ref)) !== null) {
      uids.push(uidMatch[1]);
    }
    if (uids.length === 0) return;

    var share = 1 / uids.length;

    uids.forEach(function(uid) {
      if (!invoiceLookup[uid]) {
        invoiceLookup[uid] = {
          net: 0, vat: 0, total: 0, count: 0,
          dueDate: '', paidDate: '', allPaid: true
        };
      }
      var l = invoiceLookup[uid];
      l.net   += (inv.subTotal || 0) * share;
      l.vat   += (inv.totalTax || 0) * share;
      l.total += (inv.total    || 0) * share;
      l.count += 1;

      // Latest due date across all invoices referencing this UID
      if (inv.dueDate && (!l.dueDate || inv.dueDate > l.dueDate)) {
        l.dueDate = inv.dueDate;
      }
      // Track whether every invoice referencing this UID is PAID
      if (inv.status !== 'PAID') l.allPaid = false;
      // Latest paid date seen (only meaningful once allPaid confirmed below)
      if (inv.paidDate && (!l.paidDate || inv.paidDate > l.paidDate)) {
        l.paidDate = inv.paidDate;
      }
    });
  });
  // Clear paidDate for any UID where not every linked invoice is paid
  Object.keys(invoiceLookup).forEach(function(uid) {
    if (!invoiceLookup[uid].allPaid) invoiceLookup[uid].paidDate = '';
  });

  writeEventsSheet(ss, items, invoiceLookup);
  writeSummarySheet(ss, items);

  var rcSheet = ss.getSheetByName('Rate Card');
  if (rcSheet) {
    rcSheet.getRange('B44').setValue(new Date());
  }

  SpreadsheetApp.getUi().alert('Done — ' + items.length + ' events loaded, ' + invoices.length + ' invoices matched.');
}

// ── WRITE EVENTS SHEET ────────────────────────────────────────

function writeEventsSheet(ss, items, invoiceLookup) {
  var sheet = ss.getSheetByName('Events');
  if (!sheet) sheet = ss.insertSheet('Events');

  var unstaffedMap = {};
  var existingLastRow = sheet.getLastRow();
  if (existingLastRow > 2) {
    var existingData = sheet.getRange(3, 1, existingLastRow - 2, 6).getValues();
    existingData.forEach(function(r) {
      var id = String(r[0]).trim();
      if (id) unstaffedMap[id] = {
        unstaffed: (r[2] === 'Y' || r[2] === 'y') ? 'Y' : 'N',
        lock:      (r[3] === 'Y' || r[3] === 'y') ? 'Y' : 'N',
        volunteers: r[4] || 0,
        catering:   r[5] || 0,
      };
    });
  }

  if (existingLastRow > 2) {
    sheet.getRange(3, 1, existingLastRow - 2, sheet.getLastColumn()).clearContent();
  }

  var rcName = 'Rate Card';

  var groupHeaders = [
    ['EVENT DETAILS', '', '', '', '', '', '', '',
     'RAW DATA FROM SONDERPLAN', '', '', '', '',
     'CALCULATED COSTS', '', '', '', '', '', '', '', '',
     'FINANCIAL', '', '', '',
     'FLAGS', '']
  ];

  var colHeaders = [
    'SP ID', 'Booking ID', 'Unstaffed', 'Lock', 'Volunteers', 'Catering £/day',
    'Event Name', 'Status', 'Resources', 'Driver',
    'Event Start', 'Event End', 'Days',
    'Op Hours/Day', 'Drive Miles', 'Unit Count', 'Address', 'Op Hours Source',
    'Staff Count', 'Driving Hours', 'Setup Hours', 'Contingency', 'Total Paid Hours',
    'Est. Wages', 'Est. Mileage', 'Est. Hotel', 'Est. Subsistence', 'Est. Total Cost',
    'Quoted Price', 'Invoiced Net', 'Invoiced VAT', 'Invoiced Total',
    'Invoice Due Date', 'Invoice Paid Date',
    'Margin £', 'Margin %',
    'No Postcode', 'Data Flag'
  ];

  sheet.getRange(1, 1, 1, groupHeaders[0].length).setValues(groupHeaders);
  sheet.getRange(2, 1, 1, colHeaders.length).setValues([colHeaders]);

  var darkPurple = '#2d0a3e';
  var midPurple  = '#4a235a';
  var orange     = '#c55a11';
  var green      = '#1e4620';

  var groupRanges = [
    { range: 'A1:J1', color: darkPurple },
    { range: 'K1:R1', color: midPurple },
    { range: 'S1:AB1', color: orange },
    { range: 'AC1:AH1', color: green },
    { range: 'AI1:AJ1', color: green },
    { range: 'AK1:AL1', color: '#7f0000' }
  ];
  sheet.getRange(1, 1, 1, colHeaders.length).breakApart();
  groupRanges.forEach(function(gr) {
    var r = sheet.getRange(gr.range);
    r.setBackground(gr.color).setFontColor('#ffffff').setFontWeight('bold').setFontSize(9);
    r.merge();
    r.setHorizontalAlignment('center');
  });

  sheet.getRange(2, 1, 1, colHeaders.length)
    .setBackground('#1a1a2e')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(9)
    .setWrap(true);
  sheet.setRowHeight(2, 40);
  sheet.setFrozenRows(2);

  var rows = [];

  items.forEach(function(item, idx) {
    var row = idx + 3;
    var c = item.costs || {};

    var resourceTypes = (item.resourceTypes || []).join(', ');

    var noPostcode = (!item.address || item.costs.miles === 0) ? 'Yes' : '';
    var dataFlag   = '';
    if (item.opHoursPerDay > 100) dataFlag = '⚠ Hours anomaly (' + item.opHoursPerDay + ')';
    else if (!item.opHoursPerDay) dataFlag = 'Fallback hours used';
    if (item.priceFlag && item.priceFlag.indexOf('Shared') !== -1) dataFlag += (dataFlag ? ' | ' : '') + 'Shared op hrs';
    if (item.priceFlag === 'Multi-Price') dataFlag += (dataFlag ? ' | ' : '') + 'Multi-price';

    var manual = unstaffedMap[String(item.id)] || {};
    var unstaffed  = manual.unstaffed  || 'N';
    var lockRow    = manual.lock       || 'N';
    var volunteers = manual.volunteers || 0;
    var catering   = manual.catering   || 0;

    if (lockRow === 'Y' && unstaffedMap[String(item.id)]) {
      var m = unstaffedMap[String(item.id)];
      rows.push([
        String(item.id),
        String(item.bookingId || item.id),
        m.unstaffed || 'N',
        'Y',
        m.volunteers || 0,
        m.catering   || 0,
        item.name,
        '', '', '', '', '', '', '', '', '',
        '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
        ''
      ]);
      return;
    }

    rows.push([
      String(item.id),
      String(item.bookingId || item.id),
      unstaffed,
      lockRow,
      volunteers,
      catering,
      item.name,
      item.status,
      resourceTypes,
      '',
      item.eventStart,
      item.eventEnd,
      item.eventDays,
      item.opHoursPerDay || '',
      c.miles || 0,
      item.unitCount || 1,
      item.address || '',
      item.opHoursSource || (item.operationalHours ? 'Sonderplan' : 'Fallback'),
      '', '', '', '', '', '', '', '', '', '',
      item.price !== null && item.price !== undefined ? item.price : '', // AC=29 Quoted Price
      item.price !== null && item.price !== undefined ? ((invoiceLookup[String(item.bookingId)] || {}).net   || '') : '', // AD=30 Invoiced Net
      item.price !== null && item.price !== undefined ? ((invoiceLookup[String(item.bookingId)] || {}).vat   || '') : '', // AE=31 Invoiced VAT
      item.price !== null && item.price !== undefined ? ((invoiceLookup[String(item.bookingId)] || {}).total || '') : '', // AF=32 Invoiced Total
      item.price !== null && item.price !== undefined ? ((invoiceLookup[String(item.bookingId)] || {}).dueDate  || '') : '', // AG=33 Invoice Due Date
      item.price !== null && item.price !== undefined ? ((invoiceLookup[String(item.bookingId)] || {}).paidDate || '') : '', // AH=34 Invoice Paid Date
      '', '',                                                            // AI=35 Margin£, AJ=36 Margin%
      noPostcode,
      dataFlag
    ]);
  });

  if (rows.length > 0) {
    sheet.getRange(3, 1, rows.length, colHeaders.length).setValues(rows);
  }

  var rc = "'" + rcName + "'!";

  items.forEach(function(item, idx) {
    var r = idx + 3;

    var manual = unstaffedMap[String(item.id)] || {};
    var lockRow = manual.lock || 'N';
    if (lockRow === 'Y' && unstaffedMap[String(item.id)]) return;

    sheet.getRange(r, 19).setFormula('=P' + r);
    sheet.getRange(r, 20).setFormula(
      '=IF(O' + r + '>0, ROUND((O' + r + '*2/' + rc + 'B6)*P' + r + ', 1), 0)'
    );
    sheet.getRange(r, 21).setFormula(
      '=ROUND(' +
      '(IF(ISNUMBER(SEARCH("Trailer",I' + r + ')), ' + rc + 'B10, 0) + ' +
      'IF(ISNUMBER(SEARCH("POD",I' + r + ')), ' + rc + 'B11, 0) + ' +
      'IF(ISNUMBER(SEARCH("DayVan",I' + r + ')), ' + rc + 'B12, 0) + ' +
      'IF(ISNUMBER(SEARCH("Van (",I' + r + ')), ' + rc + 'B12, 0))' +
      ', 1)'
    );
    sheet.getRange(r, 22).setFormula('=' + rc + 'B13');
    sheet.getRange(r, 23).setFormula(
      '=ROUND(IF(C' + r + '="Y", 0, IF(N' + r + '>0, N' + r + '*M' + r + ', M' + r + '*8)) + T' + r + ' + U' + r + ' + V' + r + ', 1)'
    );
    sheet.getRange(r, 24).setFormula(
      '=ROUND(S' + r + ' * W' + r + ' * ' + rc + 'B4, 2)'
    );
    sheet.getRange(r, 25).setFormula(
      '=ROUND(O' + r + ' * IF(C' + r + '="Y", 4, 2) * P' + r + ' * ' + rc + 'B7, 2)'
    );
    sheet.getRange(r, 26).setFormula(
      '=IF(C' + r + '="Y",0,ROUND(IF(OR(M' + r + '>1, O' + r + '>' + rc + 'B8), ' +
      'MAX(M' + r + '-1, IF(O' + r + '>' + rc + 'B8, 1, 0)) * S' + r + ' * ' + rc + 'B15, 0), 2))'
    );
    sheet.getRange(r, 27).setFormula(
      '=IF(C' + r + '="Y",0,ROUND((M' + r + ' + IF(O' + r + '>' + rc + 'B8, 1, 0)) * S' + r + ' * ' + rc + 'B16 + E' + r + ' * F' + r + ' * M' + r + ', 2))'
    );
    sheet.getRange(r, 28).setFormula('=X' + r + '+Y' + r + '+Z' + r + '+AA' + r);
    sheet.getRange(r, 35).setFormula('=IF(AC' + r + '>0, AC' + r + '-AB' + r + ', "")');
    sheet.getRange(r, 36).setFormula('=IF(AC' + r + '>0, (AC' + r + '-AB' + r + ')/AC' + r + ', "")');
  });

  sheet.getRange(3, 11, rows.length, 2).setNumberFormat('dd/mm/yyyy');
  sheet.getRange(3, 24, rows.length, 9).setNumberFormat('£#,##0.00');
  sheet.getRange(3, 33, rows.length, 2).setNumberFormat('dd/mm/yyyy');  // Invoice Due/Paid Date
  sheet.getRange(3, 36, rows.length, 1).setNumberFormat('0.0%');
  sheet.getRange(3, 20, rows.length, 4).setNumberFormat('0.0');

  var marginRange = sheet.getRange(3, 36, rows.length, 1);
  var rules = sheet.getConditionalFormatRules();
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberLessThan(0.2)
    .setBackground('#fce4d6').setFontColor('#c55a11')
    .setRanges([marginRange]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberGreaterThan(0.5)
    .setBackground('#e2efda').setFontColor('#1e4620')
    .setRanges([marginRange]).build());
  var flagRange = sheet.getRange(3, 38, rows.length, 1);
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('anomaly')
    .setBackground('#fce4d6').setFontColor('#c55a11')
    .setRanges([flagRange]).build());
  sheet.setConditionalFormatRules(rules);

  if (rows.length > 0) {
    var ynValidation = SpreadsheetApp.newDataValidation()
      .requireValueInList(['Y', 'N'], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(3, 3, rows.length, 1).setDataValidation(ynValidation);
    sheet.getRange(3, 4, rows.length, 1).setDataValidation(ynValidation);
    sheet.getRange(3, 5, rows.length, 1).setNumberFormat('0');
    sheet.getRange(3, 6, rows.length, 1).setNumberFormat('£#,##0.00');
  }

  for (var i = 0; i < rows.length; i++) {
    var rowNum = i + 3;
    var isLocked     = rows[i][3] === 'Y';
    var isUnstaffed  = rows[i][2] === 'Y';
    var bg = isLocked    ? '#fff2cc' :
             isUnstaffed ? '#e8f4e8' :
             (i % 2 === 0 ? '#ffffff' : '#f5f0f8');
    sheet.getRange(rowNum, 1, 1, colHeaders.length).setBackground(bg);
  }

  var widths = [70,70,55,45,65,70,200,80,110,60,80,80,40,55,60,45,180,75,50,55,55,45,65,75,65,65,80,85,85,100,80,110,90,90,70,60,65,180];
  widths.forEach(function(w, i) {
    sheet.setColumnWidth(i + 1, w);
  });

  var totRow = rows.length + 3;
  sheet.getRange(totRow, 2).setValue('TOTALS').setFontWeight('bold');
  // X=24 Wages, Y=25 Mileage, Z=26 Hotel, AA=27 Subsistence, AB=28 Total Cost,
  // AC=29 Quoted Price, AD=30 Invoiced Net, AE=31 Invoiced VAT, AF=32 Invoiced Total
  [24, 25, 26, 27, 28, 29, 30, 31, 32].forEach(function(colIdx) {
    var colLetter = columnToLetter(colIdx);
    sheet.getRange(totRow, colIdx).setFormula('=SUM(' + colLetter + '3:' + colLetter + (totRow-1) + ')');
    sheet.getRange(totRow, colIdx).setNumberFormat('£#,##0.00').setFontWeight('bold');
  });
  // Margin £ = AI = 35, Margin % = AJ = 36
  sheet.getRange(totRow, 36).setFormula('=IF(AC' + totRow + '>0,(AC' + totRow + '-AB' + totRow + ')/AC' + totRow + ',"")');
  sheet.getRange(totRow, 35).setNumberFormat('£#,##0.00').setFontWeight('bold');
  sheet.getRange(totRow, 36).setNumberFormat('0.0%').setFontWeight('bold');
  sheet.getRange(totRow, 1, 1, colHeaders.length).setBackground('#e8e8e8');
}

// Converts a 1-indexed column number to its A1 letter (handles beyond Z safely)
function columnToLetter(colIdx) {
  var letter = '';
  while (colIdx > 0) {
    var remainder = (colIdx - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    colIdx = Math.floor((colIdx - 1) / 26);
  }
  return letter;
}

// Parses the Month cell from the Xero Outgoings Detail sheet (may arrive as
// a real Date, a dd/mm/yyyy string, or an already-formatted YYYY-MM string)
// into a consistent 'YYYY-MM' string.
function parseOutgoingsDetailMonth(rawMonth) {
  if (rawMonth instanceof Date) {
    var yr = rawMonth.getFullYear();
    var mo = rawMonth.getMonth() + 1;
    return yr + '-' + (mo < 10 ? '0' + mo : '' + mo);
  }
  var s = String(rawMonth).trim();
  var ddmmyyyy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ddmmyyyy) return ddmmyyyy[3] + '-' + ddmmyyyy[2];
  return s.substring(0, 7);
}

// Generic recurring-cost detector over Xero Outgoings Detail rows (13-col
// layout: 0 Date, 1 Month, 2 Contact, 3 Category, 4 AccountCode, 5 AccountName,
// 6 LineDescription, 7 Type, 8 Reference, 9 InvoiceNo, 10 VAT, 11 Amount, 12 Source).
// Groups rows by whatever keyFn returns (e.g. contact, or account code),
// flags a group as "recurring" if it has 3+ distinct months of history with
// coefficient of variation (stddev/mean) <= 0.60, and returns the average
// monthly amount per recurring group key. keyFn receives the raw row and
// should return null/'' to exclude a row from grouping entirely.
function detectRecurringGroups(detailData, currentMonth, keyFn) {
  var groupMonths = {};
  detailData.forEach(function(r) {
    var month = parseOutgoingsDetailMonth(r[1]);
    var type  = String(r[7]).trim();
    if (type !== 'SPEND' && type !== 'Bill' && type !== 'SPEND-OVERPAYMENT') return;
    if (!month || month >= currentMonth) return; // history only, not current/future

    var rawAmt = r[11];
    var amount = typeof rawAmt === 'number' ? rawAmt
               : parseFloat(String(rawAmt).replace(/[^0-9.-]/g, '')) || 0;
    if (amount <= 0) return;

    var key = keyFn(r);
    if (!key) return;

    if (!groupMonths[key]) groupMonths[key] = {};
    if (!groupMonths[key][month]) groupMonths[key][month] = 0;
    groupMonths[key][month] += amount;
  });

  var recurring = {};
  Object.keys(groupMonths).forEach(function(key) {
    var vals = Object.keys(groupMonths[key]).map(function(m) { return groupMonths[key][m]; });
    if (vals.length < 3) return; // need 3+ months of history

    var mean = vals.reduce(function(a, b) { return a + b; }, 0) / vals.length;
    if (mean < 10) return;

    var variance = vals.reduce(function(a, b) { return a + Math.pow(b - mean, 2); }, 0) / vals.length;
    var cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
    if (cv <= 0.60) recurring[key] = mean;
  });
  return recurring;
}

// ── WRITE SUMMARY SHEET ───────────────────────────────────────

function writeSummarySheet(ss, items) {
  var sheet = ss.getSheetByName('Summary');
  if (!sheet) sheet = ss.insertSheet('Summary');
  sheet.clearContents().clearFormats();

  var darkPurple = '#2d0a3e';
  var orange     = '#c55a11';

  function hdr(range, text, bg) {
    var r = sheet.getRange(range);
    r.setValue(text).setBackground(bg || darkPurple).setFontColor('#ffffff')
     .setFontWeight('bold').setFontSize(10);
  }
  function val(row, col, v, fmt) {
    var c = sheet.getRange(row, col);
    c.setValue(v);
    if (fmt) c.setNumberFormat(fmt);
  }
  function money(row, col, v) { val(row, col, v, '£#,##0.00'); }

  hdr('A1:F1', 'PIPELINE TOTALS', darkPurple);
  sheet.getRange('A1:F1').breakApart().merge();

  var headers1 = ['', 'Events', 'Quoted Income', 'Est. Total Cost', 'Est. Margin £', 'Est. Margin %'];
  sheet.getRange(2, 1, 1, 6).setValues([headers1]).setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');

  var confirmed   = items.filter(function(i) { return i.status === 'Confirmed'; });
  var provisional = items.filter(function(i) { return i.status === 'Provisional'; });

  function sumCosts(arr) {
    return arr.reduce(function(a, i) {
      var c = i.costs || {};
      return {
        price: a.price + (i.price || 0),
        wages: a.wages + (c.wages || 0),
        mileage: a.mileage + (c.mileage || 0),
        hotel: a.hotel + (c.hotel || 0),
        subs: a.subsistence + (c.subsistence || 0),
        total: a.total + (c.total || 0)
      };
    }, { price: 0, wages: 0, mileage: 0, hotel: 0, subs: 0, total: 0 });
  }

  var cTotals = sumCosts(confirmed);
  var pTotals = sumCosts(provisional);
  var allTotals = sumCosts(items);

  var rows = [
    ['Confirmed',   confirmed.length,   cTotals.price,  cTotals.total,  cTotals.price - cTotals.total,  cTotals.price > 0 ? (cTotals.price - cTotals.total)/cTotals.price : 0],
    ['Provisional', provisional.length, pTotals.price,  pTotals.total,  pTotals.price - pTotals.total,  pTotals.price > 0 ? (pTotals.price - pTotals.total)/pTotals.price : 0],
    ['ALL',         items.length,       allTotals.price,allTotals.total, allTotals.price-allTotals.total, allTotals.price > 0 ? (allTotals.price-allTotals.total)/allTotals.price : 0],
  ];

  rows.forEach(function(row, i) {
    var r = i + 3;
    var bg = i === 2 ? '#e8e8e8' : (i % 2 === 0 ? '#ffffff' : '#f5f0f8');
    sheet.getRange(r, 1).setValue(row[0]).setFontWeight(i===2 ? 'bold' : 'normal');
    sheet.getRange(r, 2).setValue(row[1]);
    sheet.getRange(r, 3).setValue(row[2]).setNumberFormat('£#,##0.00');
    sheet.getRange(r, 4).setValue(row[3]).setNumberFormat('£#,##0.00');
    sheet.getRange(r, 5).setValue(row[4]).setNumberFormat('£#,##0.00');
    sheet.getRange(r, 6).setValue(row[5]).setNumberFormat('0.0%');
    sheet.getRange(r, 1, 1, 6).setBackground(bg);
    if (i === 2) sheet.getRange(r, 1, 1, 6).setFontWeight('bold');
  });

  sheet.getRange('A7:F7').breakApart().merge();
  hdr('A7:F7', 'COST BREAKDOWN — ALL EVENTS', orange);
  sheet.getRange(8, 1, 1, 3).setValues([['Cost Type', 'Amount', '% of Total Cost']])
    .setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');

  var costRows = [
    ['Est. Wages',       allTotals.wages],
    ['Est. Mileage',     allTotals.mileage],
    ['Est. Hotel',       allTotals.hotel],
    ['Est. Subsistence', allTotals.subs],
    ['TOTAL',            allTotals.total],
  ];
  costRows.forEach(function(row, i) {
    var r = i + 9;
    var bg = i === 4 ? '#e8e8e8' : (i % 2 === 0 ? '#ffffff' : '#f5f0f8');
    sheet.getRange(r, 1).setValue(row[0]).setFontWeight(i===4 ? 'bold' : 'normal');
    sheet.getRange(r, 2).setValue(row[1]).setNumberFormat('£#,##0.00').setFontWeight(i===4 ? 'bold' : 'normal');
    sheet.getRange(r, 3).setValue(allTotals.total > 0 ? row[1]/allTotals.total : 0).setNumberFormat('0.0%');
    sheet.getRange(r, 1, 1, 3).setBackground(bg);
  });

  sheet.getRange('A15:F15').breakApart().merge();
  hdr('A15:F15', 'BY RESOURCE TYPE', darkPurple);
  sheet.getRange(16, 1, 1, 5).setValues([['Resource Type', 'Events', 'Quoted Income', 'Est. Cost', 'Avg Margin %']])
    .setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');

  var byType = {};
  items.forEach(function(item) {
    var types = item.resourceTypes || [];
    var seen = {};
    types.forEach(function(rt) {
      var key = rt.toUpperCase().startsWith('TRAILER') ? 'Trailer'
        : rt.toUpperCase().startsWith('POD') ? 'POD'
        : (rt.toUpperCase().startsWith('VAN') || rt.toUpperCase().startsWith('DAYVAN')) ? 'Day Van'
        : 'Other';
      if (!seen[key]) {
        seen[key] = true;
        if (!byType[key]) byType[key] = { events: 0, price: 0, cost: 0, margins: [] };
        byType[key].events++;
        byType[key].price += item.price || 0;
        byType[key].cost  += (item.costs || {}).total || 0;
        if (item.price) byType[key].margins.push((item.price - (item.costs||{}).total) / item.price);
      }
    });
  });

  var typeOrder = ['Day Van', 'Trailer', 'POD', 'Other'];
  typeOrder.forEach(function(type, i) {
    if (!byType[type]) return;
    var r = i + 17;
    var bt = byType[type];
    var avgM = bt.margins.length ? bt.margins.reduce(function(a,b){return a+b;},0)/bt.margins.length : 0;
    var bg = i % 2 === 0 ? '#ffffff' : '#f5f0f8';
    sheet.getRange(r, 1).setValue(type);
    sheet.getRange(r, 2).setValue(bt.events);
    sheet.getRange(r, 3).setValue(bt.price).setNumberFormat('£#,##0.00');
    sheet.getRange(r, 4).setValue(bt.cost).setNumberFormat('£#,##0.00');
    sheet.getRange(r, 5).setValue(avgM).setNumberFormat('0.0%');
    sheet.getRange(r, 1, 1, 5).setBackground(bg);
  });

  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 80);
  [3,4,5,6].forEach(function(c){ sheet.setColumnWidth(c, 130); });
}

// ── XERO INVOICES SHEET ───────────────────────────────────────

function refreshXeroInvoices() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var response = UrlFetchApp.fetch(XERO_INVOICES_URL, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    SpreadsheetApp.getUi().alert(
      'Error fetching Xero invoices: HTTP ' + response.getResponseCode() + '\n' +
      response.getContentText()
    );
    return;
  }

  var data     = JSON.parse(response.getContentText());
  var invoices = data.invoices || [];
  var year     = data.year || new Date().getFullYear();

  var sheet = ss.getSheetByName('Xero Invoices');
  if (!sheet) {
    sheet = ss.insertSheet('Xero Invoices');
    ss.setActiveSheet(sheet);
    var summarySheet = ss.getSheetByName('Summary');
    if (summarySheet) {
      var summaryIdx = ss.getSheets().indexOf(summarySheet);
      ss.moveActiveSheet(summaryIdx + 2);
    }
  }
  sheet.clearContents().clearFormats();

  var darkPurple = '#2d0a3e';

  var colHeaders = [
    'Invoice No', 'Reference', 'Contact', 'Invoice Date', 'Due Date', 'Paid Date', 'Status',
    'Net (ex VAT)', 'VAT', 'Total (inc VAT)', 'Amount Due', 'Amount Paid'
  ];
  var numCols = colHeaders.length;

  // Row 1: title banner
  sheet.getRange(1, 1, 1, numCols).merge()
    .setValue('XERO INVOICES — ' + year + ' (AUTHORISED & PAID)')
    .setBackground(darkPurple)
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(11)
    .setHorizontalAlignment('center');
  sheet.setRowHeight(1, 30);

  // Row 2: column headers
  sheet.getRange(2, 1, 1, numCols)
    .setValues([colHeaders])
    .setBackground('#1a1a2e')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(9)
    .setWrap(true);
  sheet.setRowHeight(2, 36);
  sheet.setFrozenRows(2);

  if (invoices.length === 0) {
    sheet.getRange(3, 1).setValue('No invoices found for ' + year);
    SpreadsheetApp.getUi().alert('No invoices found for ' + year + '.');
    return;
  }

  // Data rows
  var rows = invoices.map(function(inv) {
    return [
      inv.invoiceNumber,
      inv.reference || '',
      inv.contact,
      inv.date     || '',
      inv.dueDate  || '',
      inv.paidDate || '',
      inv.status,
      inv.subTotal,    // net ex VAT
      inv.totalTax,
      inv.total,       // inc VAT
      inv.amountDue,
      inv.amountPaid
    ];
  });

  sheet.getRange(3, 1, rows.length, numCols).setValues(rows);

  // Dates — Invoice Date, Due Date, Paid Date (cols 4–6)
  sheet.getRange(3, 4, rows.length, 3).setNumberFormat('dd/mm/yyyy');
  // Money columns H–L (8–12)
  sheet.getRange(3, 8, rows.length, 5).setNumberFormat('£#,##0.00');

  // Row shading and status colour — build arrays in memory, write once each
  var now = new Date(); now.setHours(0, 0, 0, 0);
  var invBgColors  = [];
  var statusColors = [];
  var statusWeights = [];
  for (var i = 0; i < rows.length; i++) {
    var status  = rows[i][6];
    var dueStr  = rows[i][4];
    var amtDue  = rows[i][10];
    var dueDate = dueStr ? new Date(dueStr) : null;
    var isOverdue = dueDate && dueDate < now && amtDue > 0;

    var bg = isOverdue         ? '#fff0f0' :
             status === 'PAID' ? '#f0fff0' :
             i % 2 === 0       ? '#ffffff' : '#f5f0f8';
    var rowColors = [];
    for (var c = 0; c < numCols; c++) rowColors.push(bg);
    invBgColors.push(rowColors);

    if (status === 'PAID')            { statusColors.push(['#1e4620']); statusWeights.push(['bold']); }
    else if (status === 'AUTHORISED') { statusColors.push(['#c55a11']); statusWeights.push(['bold']); }
    else                               { statusColors.push([null]);     statusWeights.push(['normal']); }
  }
  sheet.getRange(3, 1, rows.length, numCols).setBackgrounds(invBgColors);
  sheet.getRange(3, 7, rows.length, 1).setFontColors(statusColors);
  sheet.getRange(3, 7, rows.length, 1).setFontWeights(statusWeights);

  // Totals row
  var totRow = rows.length + 3;
  sheet.getRange(totRow, 1, 1, numCols).setBackground('#e8e8e8');
  sheet.getRange(totRow, 2).setValue('TOTALS').setFontWeight('bold');
  ['H','I','J','K','L'].forEach(function(col, idx) {
    var colNum = 8 + idx;
    sheet.getRange(totRow, colNum)
      .setFormula('=SUM(' + col + '3:' + col + (totRow - 1) + ')')
      .setNumberFormat('£#,##0.00')
      .setFontWeight('bold');
  });

  // PAID / AUTHORISED subtotals
  var subtotRow = totRow + 1;
  sheet.getRange(subtotRow,     2).setValue('Paid').setFontColor('#1e4620').setFontWeight('bold');
  sheet.getRange(subtotRow + 1, 2).setValue('Outstanding').setFontColor('#c55a11').setFontWeight('bold');
  sheet.getRange(subtotRow, 1, 2, numCols).setBackground('#f5f5f5');

  sheet.getRange(subtotRow, 8).setFormula(
    '=SUMIF(G3:G' + (totRow-1) + ',"PAID",H3:H' + (totRow-1) + ')'
  ).setNumberFormat('£#,##0.00').setFontColor('#1e4620').setFontWeight('bold');

  sheet.getRange(subtotRow + 1, 8).setFormula(
    '=SUMIF(G3:G' + (totRow-1) + ',"AUTHORISED",H3:H' + (totRow-1) + ')'
  ).setNumberFormat('£#,##0.00').setFontColor('#c55a11').setFontWeight('bold');

  sheet.getRange(subtotRow + 1, 11).setFormula(
    '=SUMIF(G3:G' + (totRow-1) + ',"AUTHORISED",K3:K' + (totRow-1) + ')'
  ).setNumberFormat('£#,##0.00').setFontColor('#c55a11').setFontWeight('bold');

  // Column widths
  var widths = [100, 280, 200, 90, 90, 90, 90, 100, 80, 110, 90, 90];
  widths.forEach(function(w, i) { sheet.setColumnWidth(i + 1, w); });

  // Conditional format: outstanding Amount Due > 0 → amber
  var cfRules = sheet.getConditionalFormatRules();
  cfRules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberGreaterThan(0)
    .setBackground('#fce4d6').setFontColor('#c55a11')
    .setRanges([sheet.getRange(3, 11, rows.length, 1)])
    .build());
  sheet.setConditionalFormatRules(cfRules);

  var paidCount        = invoices.filter(function(i){ return i.status === 'PAID'; }).length;
  var outstandingCount = invoices.filter(function(i){ return i.status === 'AUTHORISED'; }).length;

  SpreadsheetApp.getUi().alert(
    'Done — ' + invoices.length + ' invoices loaded for ' + year + '.\n' +
    'Paid: ' + paidCount + '   Outstanding: ' + outstandingCount
  );
}

// ── XERO OUTGOINGS SHEET (by contact) ───────────────────────────

// Pattern-based first-pass category suggestions — only applied to NEW contacts
// that don't already have a manual category saved. Edit the Category column
// directly in the sheet at any time; your edits are always preserved on refresh.
var OUTGOINGS_CATEGORY_RULES = [
  { pattern: /uk fuels|\bbp\b|rontec|droitwich sf|fuel/i,           category: 'Fuel' },
  { pattern: /hmrc/i,                                                category: 'Tax / HMRC' },
  { pattern: /people'?s pension/i,                                  category: 'Pension' },
  { pattern: /griffin chartered|reichel stohry|thomas westcott|pbs accounting|jo edwards bookkeeping/i, category: 'Accountancy / Bookkeeping' },
  { pattern: /keegan.*pennykid|direct line|aa breakdown/i,          category: 'Insurance' },
  { pattern: /^xero$|gravityflow|gravity forms|calendly|indeed|google|facebook|form-connector|help-qr-code|spike|upwork/i, category: 'Software / Subscriptions' },
  { pattern: /travelodge|travel lodge|premier inn|mercure|the bell inn|three horseshoes|the stables cafe/i, category: 'Accommodation / Subsistence' },
  { pattern: /btg eddisons/i,                                       category: 'Capital — Vehicle Purchase' },
  { pattern: /showplace/i,                                          category: 'Capital — Trailer Purchase' },
  { pattern: /companies house/i,                                    category: 'Statutory / Compliance' },
  { pattern: /sse energy|direct 365/i,                               category: 'Utilities' },
  { pattern: /dvla/i,                                               category: 'Vehicle Tax / DVLA' },
  { pattern: /close brother motor finance|propel finance/i,         category: 'Finance / Loan Repayment' },
  { pattern: /^james brown$|^john barry$/i,                          category: 'Director Remuneration' },
];

function suggestOutgoingsCategory(contactName) {
  for (var i = 0; i < OUTGOINGS_CATEGORY_RULES.length; i++) {
    if (OUTGOINGS_CATEGORY_RULES[i].pattern.test(contactName)) {
      return OUTGOINGS_CATEGORY_RULES[i].category;
    }
  }
  return '';
}

function refreshXeroOutgoings() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var response = UrlFetchApp.fetch(XERO_OUTGOINGS_URL, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    SpreadsheetApp.getUi().alert(
      'Error fetching Xero outgoings: HTTP ' + response.getResponseCode() + '\n' +
      response.getContentText()
    );
    return;
  }

  var data         = JSON.parse(response.getContentText());
  var byContact    = data.byContact || [];
  var transactions = data.transactions || [];
  var year         = data.year || new Date().getFullYear();

  var sheet = ss.getSheetByName('Xero Outgoings');
  if (!sheet) {
    sheet = ss.insertSheet('Xero Outgoings');
    ss.setActiveSheet(sheet);
    var invSheet = ss.getSheetByName('Xero Invoices');
    if (invSheet) {
      var invIdx = ss.getSheets().indexOf(invSheet);
      ss.moveActiveSheet(invIdx + 2);
    }
  }

  // Preserve manual Category column (col 2) before clearing — keyed by contact name (col 1)
  var categoryMap = {};
  var existingLastRow = sheet.getLastRow();
  if (existingLastRow > 2) {
    var existingData = sheet.getRange(3, 1, existingLastRow - 2, 2).getValues();
    existingData.forEach(function(r) {
      var name = String(r[0]).trim();
      var cat  = String(r[1]).trim();
      if (name && cat) categoryMap[name] = cat;
    });
  }

  sheet.clearContents().clearFormats();

  var darkPurple = '#2d0a3e';

  var colHeaders = [
    'Contact', 'Category', 'Bill Count', 'Bill Total',
    'Bank Spend Count', 'Bank Spend Total', 'Bank Receive Count', 'Bank Receive Total',
    'Total Outgoing'
  ];
  var numCols = colHeaders.length;

  // Row 1: title banner
  sheet.getRange(1, 1, 1, numCols).merge()
    .setValue('XERO OUTGOINGS BY CONTACT — ' + year)
    .setBackground(darkPurple)
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(11)
    .setHorizontalAlignment('center');
  sheet.setRowHeight(1, 30);

  // Row 2: column headers
  sheet.getRange(2, 1, 1, numCols)
    .setValues([colHeaders])
    .setBackground('#1a1a2e')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(9)
    .setWrap(true);
  sheet.setRowHeight(2, 36);
  sheet.setFrozenRows(2);

  if (byContact.length === 0) {
    sheet.getRange(3, 1).setValue('No outgoings found for ' + year);
    SpreadsheetApp.getUi().alert('No outgoings found for ' + year + '.');
    return;
  }

  // Data rows — preserve manual category, else suggest via pattern match.
  // This finalCategoryMap (contact → category) is reused below for the
  // transaction-level tab, so both tabs always agree on categorisation.
  var finalCategoryMap = {};
  var rows = byContact.map(function(c) {
    var category = categoryMap[c.contact] || suggestOutgoingsCategory(c.contact);
    finalCategoryMap[c.contact] = category;
    return [
      c.contact,
      category,
      c.billCount,
      c.billTotal,
      c.spendCount,
      c.spendTotal,
      c.receiveCount,
      c.receiveTotal,
      c.grandTotal
    ];
  });

  sheet.getRange(3, 1, rows.length, numCols).setValues(rows);

  // Money columns D, F, H, I (4, 6, 8, 9)
  [4, 6, 8, 9].forEach(function(col) {
    sheet.getRange(3, col, rows.length, 1).setNumberFormat('£#,##0.00');
  });

  // Category dropdown — list of known categories plus blank for uncategorised
  var categoryList = [
    'Driver Pay', 'Director Remuneration', "Director's Loan Account",
    'Fuel', 'Accommodation / Subsistence', 'Vehicle Tax / DVLA',
    'Vehicle Maintenance / Repair', 'Insurance', 'Accountancy / Bookkeeping',
    'Tax / HMRC', 'Pension', 'Software / Subscriptions', 'Utilities',
    'Statutory / Compliance', 'Finance / Loan Repayment', 'Marketing / Advertising',
    'Office / Equipment Purchase', 'Capital — Vehicle Purchase', 'Capital — Trailer Purchase',
    'Capital — Other', 'Materials / Build Costs', 'Other Overhead', 'Income / Grant (not outgoing)'
  ];
  var catValidation = SpreadsheetApp.newDataValidation()
    .requireValueInList(categoryList, true)
    .setAllowInvalid(true) // allow free text too, in case none of these fit
    .build();
  sheet.getRange(3, 2, rows.length, 1).setDataValidation(catValidation);

  // Row shading — alternating, with uncategorised rows flagged amber — batched
  var outBgColors = rows.map(function(r, i) {
    var hasCategory = r[1] !== '';
    var bg = !hasCategory ? '#fff2cc' : (i % 2 === 0 ? '#ffffff' : '#f5f0f8');
    var rowColors = [];
    for (var c = 0; c < numCols; c++) rowColors.push(bg);
    return rowColors;
  });
  sheet.getRange(3, 1, rows.length, numCols).setBackgrounds(outBgColors);

  // Totals row
  var totRow = rows.length + 3;
  sheet.getRange(totRow, 1).setValue('TOTALS').setFontWeight('bold');
  [4, 6, 8, 9].forEach(function(col) {
    var colLetter = columnToLetter(col);
    sheet.getRange(totRow, col)
      .setFormula('=SUM(' + colLetter + '3:' + colLetter + (totRow - 1) + ')')
      .setNumberFormat('£#,##0.00')
      .setFontWeight('bold');
  });
  sheet.getRange(totRow, 1, 1, numCols).setBackground('#e8e8e8');

  // Column widths
  var widths = [220, 200, 80, 100, 100, 110, 110, 110, 110];
  widths.forEach(function(w, i) { sheet.setColumnWidth(i + 1, w); });

  var uncategorisedCount = rows.filter(function(r) { return r[1] === ''; }).length;

  // Write the transaction-level tab — fetch direct bank transactions (with
  // account codes) from the dedicated bank-transactions-detail endpoint.
  // (cashflow-data no longer carries per-line account codes as of the v1.31
  // fix — that heavy fetch was moved here so it only runs when this sheet
  // is refreshed, not on every cash flow load.)
  var cfResp = UrlFetchApp.fetch(XERO_BANKTX_DETAIL_URL, { muteHttpExceptions: true });
  var cfTransactions = [];
  if (cfResp.getResponseCode() === 200) {
    var cfData = JSON.parse(cfResp.getContentText());
    // Combine bill transactions (from outgoings) with direct bank transactions
    var billTxns = transactions; // already have these from outgoings
    var directTxns = (cfData.directTransactions || []).map(function(t) {
      return {
        date: t.date, month: t.month,
        contact: t.contact, type: t.type,
        reference: t.reference, invoiceNumber: '',
        amount: t.amount, totalTax: t.totalTax || 0, status: 'AUTHORISED', source: t.source,
        accountCode: t.accountCode || '',
        accountName: t.accountName || t.accountCode || '',
        lineDescription: t.lineDescription || ''
      };
    });
    cfTransactions = billTxns.concat(directTxns).sort(function(a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
  } else {
    cfTransactions = transactions; // fall back to bills only
  }

  writeOutgoingsTransactionsSheet(ss, cfTransactions, finalCategoryMap, year);

  SpreadsheetApp.getUi().alert(
    'Done — ' + byContact.length + ' bill contacts loaded for ' + year + '.\n' +
    'Uncategorised contacts (highlighted amber): ' + uncategorisedCount + '\n' +
    'Detail tab has ' + cfTransactions.length + ' transactions (bills + direct bank spend).\n\n' +
    'Edit the Category column directly on this tab — your choices are preserved on refresh\n' +
    'and applied automatically to the Xero Outgoings Detail tab.'
  );
}

// ── XERO OUTGOINGS DETAIL SHEET (transaction-level, for monthly/category pivots) ──

function writeOutgoingsTransactionsSheet(ss, transactions, categoryMap, year) {
  var sheet = ss.getSheetByName('Xero Outgoings Detail');
  if (!sheet) {
    sheet = ss.insertSheet('Xero Outgoings Detail');
    var outSheet = ss.getSheetByName('Xero Outgoings');
    if (outSheet) {
      var outIdx = ss.getSheets().indexOf(outSheet);
      ss.setActiveSheet(sheet);
      ss.moveActiveSheet(outIdx + 2);
    }
  }
  sheet.clearContents().clearFormats();

  var darkPurple = '#2d0a3e';

  var colHeaders = [
    'Date', 'Month', 'Contact', 'Category', 'Account Code', 'Account Name',
    'Line Description', 'Type', 'Reference', 'Invoice No', 'VAT', 'Amount', 'Source'
  ];
  var numCols = colHeaders.length;

  sheet.getRange(1, 1, 1, numCols).merge()
    .setValue('XERO OUTGOINGS — ALL TRANSACTIONS WITH ACCOUNT CODES — ' + year)
    .setBackground(darkPurple)
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(11)
    .setHorizontalAlignment('center');
  sheet.setRowHeight(1, 30);

  sheet.getRange(2, 1, 1, numCols)
    .setValues([colHeaders])
    .setBackground('#1a1a2e')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(9)
    .setWrap(true);
  sheet.setRowHeight(2, 36);
  sheet.setFrozenRows(2);

  if (transactions.length === 0) {
    sheet.getRange(3, 1).setValue('No transactions found for ' + year);
    return;
  }

  // Amount is signed at source: money out is positive, money in (donations,
  // other receipts) is negative — so a plain SUM() nets correctly and
  // receipts don't read as extra spend just because both were unsigned.
  var rows = transactions.map(function(t) {
    return [
      t.date,
      t.month,
      t.contact,
      categoryMap[t.contact] || '',
      t.accountCode || '',
      t.accountName || '',
      t.lineDescription || '',
      t.type,
      t.reference || '',
      t.invoiceNumber || '',
      t.totalTax || 0,
      t.amount,
      t.source || ''
    ];
  });

  sheet.getRange(3, 1, rows.length, numCols).setValues(rows);
  sheet.getRange(3, 1, rows.length, 1).setNumberFormat('dd/mm/yyyy');
  sheet.getRange(3, 11, rows.length, 1).setNumberFormat('£#,##0.00');
  // Negative (receipt) amounts shown in red brackets — visually distinct
  // from spend even before checking the Source column or row colour.
  sheet.getRange(3, 12, rows.length, 1).setNumberFormat('£#,##0.00;[red](£#,##0.00)');

  // Colour by source — build the whole 2D colour array in memory, one write
  var bgColors = rows.map(function(r) {
    var source = r[12];
    var bg = source === 'Bill'          ? '#fff0f0' :
             source === 'DirectSpend'   ? '#fff5e6' :
             source === 'DirectReceive' ? '#f0fff0' : '#ffffff';
    var rowColors = [];
    for (var c = 0; c < numCols; c++) rowColors.push(bg);
    return rowColors;
  });
  sheet.getRange(3, 1, rows.length, numCols).setBackgrounds(bgColors);

  // Column widths
  var widths = [80, 70, 180, 120, 80, 200, 200, 100, 100, 90, 80, 90, 100];
  widths.forEach(function(w, i) { sheet.setColumnWidth(i + 1, w); });

  // Add account code summary below
  var summaryStart = rows.length + 4;
  sheet.getRange(summaryStart, 1, 1, 5).merge()
    .setValue('ACCOUNT CODE SUMMARY (net outgoing — receipts already netted off)')
    .setBackground(darkPurple).setFontColor('#ffffff').setFontWeight('bold');
  sheet.getRange(summaryStart + 1, 1, 1, 5)
    .setValues([['Account Code', 'Account Name', 'Category', 'Net Amount', 'Transactions']])
    .setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold').setFontSize(9);

  // Now that Amount is signed (spend positive, receipts negative), every
  // row can be summed together — a donation against an account code will
  // correctly reduce that code's net figure rather than needing to be
  // excluded separately.
  var byCode = {};
  rows.forEach(function(r) {
    var code = r[4] || '(no code)';
    if (!byCode[code]) byCode[code] = { name: r[5] || '', category: r[3] || '', total: 0, count: 0 };
    byCode[code].total += r[11] || 0;
    byCode[code].count++;
  });

  var summaryRows = Object.keys(byCode).sort().map(function(code) {
    return [code, byCode[code].name, byCode[code].category, byCode[code].total, byCode[code].count];
  });
  if (summaryRows.length > 0) {
    sheet.getRange(summaryStart + 2, 1, summaryRows.length, 5).setValues(summaryRows);
    sheet.getRange(summaryStart + 2, 4, summaryRows.length, 1).setNumberFormat('£#,##0.00');
    // Highlight rows with no code or no category — batched
    var summaryBg = summaryRows.map(function(r) {
      var flagged = (!r[0] || r[0] === '(no code)');
      var c = flagged ? '#fff2cc' : '#ffffff';
      return [c, c, c, c, c];
    });
    sheet.getRange(summaryStart + 2, 1, summaryRows.length, 5).setBackgrounds(summaryBg);
  }
}

// ── P&L BY ACCOUNT CODE (no budget — actuals only, all codes) ──
// Gross of VAT throughout, per David's confirmed setup: all sales income
// is coded to 200 Sales. VAT control accounts (820 VAT, 828 Error
// Correction VAT Liability) are excluded from the main code table since
// they're liabilities, not operating costs — shown separately below as
// a paid/accrued split instead.

function refreshPnlByCode() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var response = UrlFetchApp.fetch(XERO_PNL_URL + '?refresh=true', { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    SpreadsheetApp.getUi().alert('Error fetching P&L by code: HTTP ' + response.getResponseCode() + '\n' + response.getContentText());
    return;
  }
  var data = JSON.parse(response.getContentText());
  var year   = data.year;
  var months = data.months || [];
  var codes  = data.codes || [];
  var vat    = data.vat || {};
  var dataSources = data.dataSources || {};
  var missingSource = (dataSources.bills === 'missing' || dataSources.bankTransactions === 'missing');

  var currentMonth = new Date().toISOString().substring(0, 7);

  // ── Estimates for current + future months ──────────────────
  // Two sources, both reusing logic already trusted from Cash Flow:
  // 1. Per-account-code recurring cost detection (same statistics as the
  //    by-contact version used for Cash Flow, just grouped by code instead
  //    so the estimate lands in the right P&L row). Code 321 (Wages) is
  //    excluded from this generic detection since driver pay is inherently
  //    event-driven/variable, not a fixed recurring cost — Ops Manager
  //    salary is handled specifically below instead.
  // 2. Ops Manager salary, from the Rate Card, same start/contract-length
  //    logic as Cash Flow — assumed to land on code 321 Wages. If Leanne's
  //    salary is actually coded elsewhere in your chart of accounts, tell
  //    me and I'll point this at the right code.
  var rc = ss.getSheetByName('Rate Card');
  var openingBalance = rc ? (rc.getRange('B36').getValue() || 0) : 0;
  var opsSalary     = rc ? (rc.getRange('B5').getValue() || 0) : 0;
  var opsContract   = rc ? String(rc.getRange('B6').getValue() || 'Permanent').toLowerCase().trim() : 'permanent';
  var opsStartMonth = rc ? String(rc.getRange('B7').getValue() || '2026-04').trim() : '2026-04';
  var opsMonthly    = opsSalary > 0 ? Math.round(opsSalary / 12) : 0;
  var opsEndMonth   = '';
  if (opsContract.indexOf('6') !== -1 && opsStartMonth) {
    var opsYr = parseInt(opsStartMonth.substring(0, 4));
    var opsMo = parseInt(opsStartMonth.substring(5, 7)) + 5;
    if (opsMo > 12) { opsYr++; opsMo -= 12; }
    opsEndMonth = opsYr + '-' + (opsMo < 10 ? '0' + opsMo : '' + opsMo);
  }
  var OPS_MANAGER_CODE = '321';

  var estimatesByCode = {}; // code -> { month -> amount }
  function addEstimate(code, month, amount) {
    if (!estimatesByCode[code]) estimatesByCode[code] = {};
    estimatesByCode[code][month] = (estimatesByCode[code][month] || 0) + amount;
  }

  var detailSheetForEstimates = ss.getSheetByName('Xero Outgoings Detail');
  if (detailSheetForEstimates && detailSheetForEstimates.getLastRow() > 2) {
    var detailDataForEstimates = detailSheetForEstimates.getRange(3, 1, detailSheetForEstimates.getLastRow() - 2, 13).getValues();
    var recurringByCode = detectRecurringGroups(detailDataForEstimates, currentMonth, function(r) {
      var code = String(r[4]).trim();
      if (!code || code === OPS_MANAGER_CODE) return null;
      return code;
    });
    Object.keys(recurringByCode).forEach(function(code) {
      months.forEach(function(m) {
        if (m < currentMonth) return;
        addEstimate(code, m, recurringByCode[code]);
      });
    });
  }
  if (opsMonthly > 0) {
    months.forEach(function(m) {
      if (m < currentMonth) return;
      if (m < opsStartMonth) return;
      if (opsEndMonth && m > opsEndMonth) return;
      addEstimate(OPS_MANAGER_CODE, m, opsMonthly);
    });
  }

  var sheet = ss.getSheetByName('P&L by Account Code');
  if (!sheet) sheet = ss.insertSheet('P&L by Account Code');
  sheet.clearContents().clearFormats();

  var darkPurple = '#2d0a3e';
  var orange     = '#c55a11';
  var warnRow = 0;

  // Layout: Account Code | Account Name | Type | Jan..Dec (one col each) | Total | VAT
  var numFixedCols  = 3;
  var numMonthCols  = months.length;
  var totalCol      = numFixedCols + numMonthCols + 1; // annual total
  var vatCol        = totalCol + 1;                    // annual VAT
  var numCols       = vatCol;

  var monthLabels = months.map(function(m) {
    var parts = m.split('-');
    var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var mi = parseInt(parts[1], 10) - 1;
    return monthNames[mi] + '-' + parts[0].substring(2);
  });

  if (missingSource) {
    sheet.getRange(1, 1, 1, numCols).merge()
      .setValue('⚠ Bills and/or bank transaction data not cached yet — run "Refresh Xero Outgoings" first, then re-run this report for complete figures.')
      .setBackground('#c00000').setFontColor('#ffffff').setFontWeight('bold')
      .setFontSize(10).setHorizontalAlignment('center');
    sheet.setRowHeight(1, 26);
    warnRow = 1;
  }

  sheet.getRange(1 + warnRow, 1, 1, numCols).merge()
    .setValue('CASH MOVEMENT BY ACCOUNT CODE — ' + year + ' BY MONTH (ACTUALS + ESTIMATED FIXED COSTS — NO BUDGET SET)')
    .setBackground(darkPurple).setFontColor('#ffffff').setFontWeight('bold')
    .setFontSize(11).setHorizontalAlignment('center');
  sheet.setRowHeight(1 + warnRow, 30);

  var colHeaders = ['Account Code', 'Account Name', 'Type'].concat(monthLabels, ['Total (£)', 'VAT (£)']);
  sheet.getRange(2 + warnRow, 1, 1, numCols)
    .setValues([colHeaders])
    .setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold').setFontSize(9);
  sheet.setFrozenRows(2 + warnRow);
  // Not freezing columns here: the title/warning banners above are merged
  // across the full row width, and Sheets won't allow a column freeze that
  // splits a merged cell. Account Code/Name/Type just scroll with the rest.

  var dataStartRow = 3 + warnRow;

  if (codes.length === 0) {
    sheet.getRange(dataStartRow, 1).setValue('No account code data returned.');
    return;
  }

  // Group Revenue first, then Direct Costs / Expense / Overheads — so the
  // sheet reads top-to-bottom like a P&L rather than a flat code dump.
  var typeOrder = { 'REVENUE': 0, 'DIRECTCOSTS': 1, 'EXPENSE': 2, 'OVERHEADS': 3 }; // anything else (ASSET/LIABILITY/EQUITY — capital, loans, balance sheet) sorts after, bucket 9
  var sorted = codes.slice().sort(function(a, b) {
    var ta = typeOrder[(a.type || '').toUpperCase()];
    var tb = typeOrder[(b.type || '').toUpperCase()];
    ta = ta === undefined ? 9 : ta;
    tb = tb === undefined ? 9 : tb;
    if (ta !== tb) return ta - tb;
    return String(a.code).localeCompare(String(b.code));
  });

  var estimatedFlags = []; // parallel to rows — true where a cell is an estimate, not an actual
  var rows = sorted.map(function(c) {
    var rowEstFlags = [];
    var estimateTotal = 0;
    var monthVals = months.map(function(m) {
      var actual = (c.monthly && c.monthly[m]) ? c.monthly[m].gross : 0;
      if (actual === 0 && m >= currentMonth && estimatesByCode[c.code] && estimatesByCode[c.code][m]) {
        var est = estimatesByCode[c.code][m];
        rowEstFlags.push(true);
        estimateTotal += est;
        return est;
      }
      rowEstFlags.push(false);
      return actual;
    });
    estimatedFlags.push(rowEstFlags);
    // Total column now includes estimated months too, so it stays consistent
    // with what's actually summed across the row. VAT total is actuals-only —
    // not estimating VAT on projected fixed costs at this stage.
    return [c.code, c.name, c.type].concat(monthVals, [c.gross + estimateTotal, c.vat]);
  });
  sheet.getRange(dataStartRow, 1, rows.length, numCols).setValues(rows);
  sheet.getRange(dataStartRow, numFixedCols + 1, rows.length, numMonthCols + 2).setNumberFormat('£#,##0.00');

  // Shade by type so Revenue / Direct Costs / Overheads are visually
  // distinct, and flag zero-activity codes so they don't read as errors.
  // Estimated cells (projected fixed costs for months with no actual data
  // yet) get their own light-yellow/italic treatment so they're never
  // mistaken for real Xero data.
  var typeColors = { 'REVENUE': '#f0fff0', 'DIRECTCOSTS': '#fff5e6', 'EXPENSE': '#fff0f0', 'OVERHEADS': '#f5f0ff' };
  var nonPnlColor = '#eef2f7'; // capital purchases, loan repayments, director's loan, receivables etc.
  var estimateBg = '#fffde7';
  var bgColors = rows.map(function(r, ri) {
    var bg = typeColors[r[2]] || nonPnlColor;
    if (r[totalCol - 1] === 0) bg = '#f7f7f7'; // zero-activity code — greyed, not hidden
    var rowColors = [];
    for (var c = 0; c < numCols; c++) {
      var monthIdx = c - numFixedCols; // index into estimatedFlags for month columns only
      var isEstCell = monthIdx >= 0 && monthIdx < numMonthCols && estimatedFlags[ri][monthIdx];
      rowColors.push(isEstCell ? estimateBg : bg);
    }
    return rowColors;
  });
  sheet.getRange(dataStartRow, 1, rows.length, numCols).setBackgrounds(bgColors);

  // Italicise estimated cells specifically
  var fontStyles = rows.map(function(r, ri) {
    var rowStyles = [];
    for (var c = 0; c < numCols; c++) {
      var monthIdx = c - numFixedCols;
      var isEstCell = monthIdx >= 0 && monthIdx < numMonthCols && estimatedFlags[ri][monthIdx];
      rowStyles.push(isEstCell ? 'italic' : 'normal');
    }
    return rowStyles;
  });
  sheet.getRange(dataStartRow, 1, rows.length, numCols).setFontStyles(fontStyles);

  var lastDataRow  = rows.length + dataStartRow - 1;
  var typeColLetter = columnToLetter(3);

  // ── Summary rows: Total, Total Cash In, Total Cash Out, Net Cash Movement ──
  var totRow = lastDataRow + 1;
  sheet.getRange(totRow, 1).setValue('TOTAL (all codes)').setFontWeight('bold');
  for (var mc = numFixedCols + 1; mc <= vatCol; mc++) {
    var cl = columnToLetter(mc);
    sheet.getRange(totRow, mc)
      .setFormula('=SUM(' + cl + dataStartRow + ':' + cl + lastDataRow + ')')
      .setNumberFormat('£#,##0.00').setFontWeight('bold');
  }
  sheet.getRange(totRow, 1, 1, numCols).setBackground('#e8e8e8');

  var revRow = totRow + 1;
  sheet.getRange(revRow, 1).setValue('TOTAL CASH IN (Revenue codes)').setFontWeight('bold').setFontColor('#1e4620');
  for (mc = numFixedCols + 1; mc <= vatCol; mc++) {
    cl = columnToLetter(mc);
    sheet.getRange(revRow, mc)
      .setFormula('=SUMIF(' + typeColLetter + dataStartRow + ':' + typeColLetter + lastDataRow + ',"REVENUE",' + cl + dataStartRow + ':' + cl + lastDataRow + ')')
      .setNumberFormat('£#,##0.00').setFontWeight('bold').setFontColor('#1e4620');
  }
  sheet.getRange(revRow, 1, 1, numCols).setBackground('#f0fff0');

  var costRow = revRow + 1;
  sheet.getRange(costRow, 1).setValue('TOTAL CASH OUT (everything else — incl. capital, loans)').setFontWeight('bold').setFontColor('#c00000');
  for (mc = numFixedCols + 1; mc <= vatCol; mc++) {
    cl = columnToLetter(mc);
    var totCell = cl + totRow;
    var revCell = cl + revRow;
    sheet.getRange(costRow, mc)
      .setFormula('=' + totCell + '-' + revCell)
      .setNumberFormat('£#,##0.00').setFontWeight('bold').setFontColor('#c00000');
  }
  sheet.getRange(costRow, 1, 1, numCols).setBackground('#fff0f0');

  var netRow = costRow + 1;
  sheet.getRange(netRow, 1).setValue('NET CASH MOVEMENT (increase / decrease in cash)').setFontWeight('bold');
  for (mc = numFixedCols + 1; mc <= totalCol; mc++) { // net only meaningful on the gross columns, not the VAT column
    cl = columnToLetter(mc);
    sheet.getRange(netRow, mc)
      .setFormula('=' + cl + revRow + '-' + cl + costRow)
      .setNumberFormat('£#,##0.00;[red](£#,##0.00)').setFontWeight('bold');
  }
  sheet.getRange(netRow, 1, 1, numCols).setBackground('#1a1a2e');
  sheet.getRange(netRow, 1, 1, numCols).setFontColor('#ffffff');

  // ── Opening balance + running cash position ─────────────────
  // Ties the P&L to an actual bank position: Opening Balance (from Rate
  // Card) plus the cumulative Net Cash Movement through each month.
  var firstMonthCol = numFixedCols + 1;
  var firstMonthColLetter = columnToLetter(firstMonthCol);

  var openingBalRow = netRow + 2;
  sheet.getRange(openingBalRow, 1).setValue('Opening Bank Balance (Rate Card B36)').setFontWeight('bold');
  sheet.getRange(openingBalRow, firstMonthCol).setValue(openingBalance).setNumberFormat('£#,##0.00').setFontWeight('bold');

  var runningRow = openingBalRow + 1;
  sheet.getRange(runningRow, 1).setValue('RUNNING CASH POSITION').setFontWeight('bold');
  for (mc = firstMonthCol; mc <= totalCol - 1; mc++) {
    cl = columnToLetter(mc);
    var netCellRef = cl + netRow;
    var formula;
    if (mc === firstMonthCol) {
      formula = '=' + firstMonthColLetter + openingBalRow + '+' + netCellRef;
    } else {
      var prevRunningCellRef = columnToLetter(mc - 1) + runningRow;
      formula = '=' + prevRunningCellRef + '+' + netCellRef;
    }
    sheet.getRange(runningRow, mc).setFormula(formula).setNumberFormat('£#,##0.00;[red](£#,##0.00)').setFontWeight('bold');
  }
  // Total column shows year-end position (same as December's running figure)
  sheet.getRange(runningRow, totalCol)
    .setFormula('=' + columnToLetter(totalCol - 1) + runningRow)
    .setNumberFormat('£#,##0.00;[red](£#,##0.00)').setFontWeight('bold');
  sheet.getRange(openingBalRow, 1, 2, numCols).setBackground('#e8f0fe');
  sheet.getRange(runningRow, 1, 1, numCols).setFontColor('#1155cc');

  // ── VAT section — paid vs accrued, kept separate from operating codes ──
  var vatStart = runningRow + 3;
  sheet.getRange(vatStart, 1, 1, numCols).merge()
    .setValue('VAT POSITION (codes 820 + 828 — kept separate, not in the cash movement table above)')
    .setBackground(orange).setFontColor('#ffffff').setFontWeight('bold');
  sheet.getRange(vatStart + 1, 1).setValue('VAT paid to HMRC (cash, YTD)').setFontWeight('bold');
  sheet.getRange(vatStart + 1, totalCol).setValue(vat.paidCash || 0).setNumberFormat('£#,##0.00');
  sheet.getRange(vatStart + 2, 1).setValue('VAT accrued, not yet paid (est. — see note)').setFontWeight('bold');
  sheet.getRange(vatStart + 2, totalCol).setValue(vat.accruedNotPaid || 0).setNumberFormat('£#,##0.00');
  sheet.getRange(vatStart + 3, 1).setValue('TOTAL 2026 VAT POSITION').setFontWeight('bold').setBackground('#e8e8e8');
  sheet.getRange(vatStart + 3, totalCol).setValue(vat.totalYearLiability || 0).setNumberFormat('£#,##0.00').setFontWeight('bold').setBackground('#e8e8e8');
  sheet.getRange(vatStart + 5, 1, 1, numCols).merge()
    .setValue(vat.note || '')
    .setFontColor('#666666').setFontSize(9).setWrap(true);
  sheet.getRange(vatStart + 6, 1, 1, numCols).merge()
    .setValue('Italic, light-yellow cells are projected fixed costs for months with no actual data yet (recurring costs detected from history, plus Ops Manager salary from the Rate Card) — not confirmed Xero figures. Driver pay, event delivery costs, and other variable costs are not yet estimated for future months. Grey-blue rows are capital purchases, loan repayments, and other Balance Sheet-coded cash movements — included here because this tracks real cash movement, not accrual profit; VAT (820/828) is the one exception, kept in its own section above.')
    .setFontColor('#666666').setFontSize(9).setWrap(true);

  // Column widths
  sheet.setColumnWidth(1, 90);
  sheet.setColumnWidth(2, 200);
  sheet.setColumnWidth(3, 90);
  for (mc = numFixedCols + 1; mc <= numMonthCols + numFixedCols; mc++) sheet.setColumnWidth(mc, 78);
  sheet.setColumnWidth(totalCol, 100);
  sheet.setColumnWidth(vatCol, 90);

  SpreadsheetApp.getUi().alert(
    (missingSource ? '⚠ Incomplete — bills and/or bank transaction data was not cached. Run "Refresh Xero Outgoings" first, then re-run this report.\n\n' : '') +
    'Cash Movement by Account Code refreshed for ' + year + ' (monthly).\n' +
    codes.length + ' codes listed — including capital purchases, loan repayments, and other Balance Sheet-coded cash movements alongside Revenue/Expense codes.\n\n' +
    'Opening balance: £' + openingBalance.toFixed(2) + '\n' +
    'Recurring cost codes projected forward: ' + Object.keys(estimatesByCode).length + '\n\n' +
    'VAT paid (cash): £' + (vat.paidCash || 0).toFixed(2) + '\n' +
    'VAT accrued (est.): £' + (vat.accruedNotPaid || 0).toFixed(2) + '\n\n' +
    'Note: the accrued VAT figure is an estimate pending confirmation of your ' +
    'VAT scheme from your accountant — see the note on the sheet.\n\n' +
    'Revenue and true Expense codes show as positive magnitudes by design — ' +
    'read the overall picture from Net Cash Movement, not by summing a single ' +
    'column. Capital/loan/balance-sheet codes (grey-blue rows) are properly ' +
    'signed instead (negative = cash in, positive = cash out), since money can ' +
    'move either way through those.\n\n' +
    'Italic yellow cells are projected fixed costs, not actuals — driver pay ' +
    'and other variable costs are not yet estimated for future months.'
  );
}

// ── CASH FLOW 2026 ────────────────────────────────────────────

function refreshCashFlow() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // ── Read Rate Card settings ───────────────────────────────
  var rc = ss.getSheetByName('Rate Card');
  if (!rc) { SpreadsheetApp.getUi().alert('Rate Card sheet not found.'); return; }
  var openingBalance    = rc.getRange('B36').getValue() || 0;
  var driverPaymentDays = rc.getRange('B26').getValue() || 14;
  var paymentRate       = (rc.getRange('B27').getValue() || 95) / 100;
  var q2VatMonth        = rc.getRange('B38').getValue() || '';
  var q2VatAmount       = rc.getRange('B39').getValue() || 0;
  var q3VatMonth        = rc.getRange('B40').getValue() || '';
  var q3VatAmount       = rc.getRange('B41').getValue() || 0;
  var monthlyVatOnAcct  = rc.getRange('B42').getValue() || 0;
  // Fleet size for capacity check
  var currentTrailers   = rc.getRange('B29').getValue() || 0;
  var currentPods       = rc.getRange('B30').getValue() || 0;
  var currentDayVans    = rc.getRange('B31').getValue() || 0;
  // Ops Manager salary
  var opsSalary     = rc.getRange('B5').getValue() || 0;
  var opsContract   = String(rc.getRange('B6').getValue() || 'Permanent').toLowerCase().trim();
  var opsStartMonth = String(rc.getRange('B7').getValue() || '2026-04').trim();
  var opsMonthly    = opsSalary > 0 ? Math.round(opsSalary / 12) : 0;
  // 6 month contract ends 5 months after start (6 months inclusive)
  var opsEndMonth   = '';
  if (opsContract.indexOf('6') !== -1 && opsStartMonth) {
    var opsYr = parseInt(opsStartMonth.substring(0, 4));
    var opsMo = parseInt(opsStartMonth.substring(5, 7)) + 5;
    if (opsMo > 12) { opsYr++; opsMo -= 12; }
    opsEndMonth = opsYr + '-' + (opsMo < 10 ? '0' + opsMo : '' + opsMo);
  }

  // ── Fetch Xero payments (invoice receipts + bill payments) ─
  // ── Fetch all Xero cash flow data in one call ─────────────
  var cfResp = UrlFetchApp.fetch(XERO_CASHFLOW_URL, { muteHttpExceptions: true });
  if (cfResp.getResponseCode() !== 200) {
    SpreadsheetApp.getUi().alert('Error fetching cash flow data: HTTP ' + cfResp.getResponseCode() + '\n' + cfResp.getContentText());
    return;
  }
  var cfData     = JSON.parse(cfResp.getContentText());
  var payments   = cfData.payments   || [];
  var invoices   = cfData.invoices   || [];
  var directByMonth = cfData.directByMonth || {};
  var vatQuarters   = cfData.vatQuarters   || {};

  // ── Read Events sheet for future driver cost timing ────────
  var evSheet = ss.getSheetByName('Events');
  var evData  = evSheet && evSheet.getLastRow() > 2
    ? evSheet.getRange(3, 1, evSheet.getLastRow() - 2, 36).getValues()
    : [];

  // ── Monthly buckets Jan–Dec ────────────────────────────────
  var months = ['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06',
                '2026-07','2026-08','2026-09','2026-10','2026-11','2026-12',
                '2027-01','2027-02','2027-03','2027-04','2027-05','2027-06',
                '2027-07','2027-08','2027-09','2027-10','2027-11','2027-12'];

  var currentMonth = new Date().toISOString().substring(0, 7);

  // ── Detect recurring fixed costs from Outgoings Detail tab ──
  // A contact is "recurring fixed" if it appears in 3+ distinct months
  // with a coefficient of variation (stddev/mean) below 0.60 — consistent amounts.
  // Excludes contacts already categorised as Driver Pay or Fuel (variable costs).
  var detailSheet  = ss.getSheetByName('Xero Outgoings Detail');
  var recurringCosts = {};

  if (detailSheet && detailSheet.getLastRow() > 2) {
    // Current 13-column layout (since VAT column added):
    // 0 Date, 1 Month, 2 Contact, 3 Category, 4 AccountCode, 5 AccountName,
    // 6 LineDescription, 7 Type, 8 Reference, 9 InvoiceNo, 10 VAT, 11 Amount, 12 Source
    var detailData = detailSheet.getRange(3, 1, detailSheet.getLastRow() - 2, 13).getValues();

    var variableContacts = ['booking.com','travelodge','travel lodge','premier inn','b&q','toolstation','toolden','12 volt planet ltd','amazon','trainline','indeed'];
    var excludedCategories = ['Driver Pay', 'Fuel', 'Capital — Vehicle Purchase', 'Capital — Trailer Purchase',
      'Capital — Other', 'Materials / Build Costs', 'Accommodation / Subsistence',
      'Vehicle Maintenance / Repair', 'Marketing / Advertising'];

    var recurringByContact = detectRecurringGroups(detailData, currentMonth, function(r) {
      var contact  = String(r[2]).trim();
      var category = String(r[3]).trim();
      if (excludedCategories.indexOf(category) !== -1) return null;
      if (variableContacts.indexOf(contact.toLowerCase()) !== -1) return null;
      return contact;
    });

    // Project each recurring contact's average forward into current + future months
    Object.keys(recurringByContact).forEach(function(contact) {
      var mean = recurringByContact[contact];
      months.forEach(function(m) {
        if (m < currentMonth) return; // only current and future months
        if (!recurringCosts[m]) recurringCosts[m] = 0;
        recurringCosts[m] += mean;
      });
    });
  }


  // ── Helper functions ──────────────────────────────────────
  function monthOf(dateVal) {
    if (!dateVal) return null;
    var d = dateVal instanceof Date ? dateVal : new Date(dateVal);
    if (isNaN(d.getTime())) return null;
    var yr = d.getFullYear();
    var mo = d.getMonth() + 1;
    return yr + '-' + (mo < 10 ? '0' + mo : '' + mo);
  }

  function addDaysToDate(dateVal, days) {
    var d = dateVal instanceof Date ? new Date(dateVal) : new Date(dateVal);
    d.setDate(d.getDate() + Math.round(days));
    return d;
  }

  var buckets = {};
  months.forEach(function(m) {
    buckets[m] = {
      paymentsIn:        0,
      outstandingIncome: 0,
      overdueIncome:     0,
      paymentsOut:       0,
      directSpend:       0,
      directReceive:     0,
      driverCosts:       0,
      recurringFixed:    0,
      vatProvision:      0,
      forecastIncome:    0,  // from Forecast Assumptions Section 4
      forecastCost:      0,  // from Forecast Assumptions Section 4
    };
  });

  // ── Payments: invoice receipts (in) and bill payments (out) ─
  payments.forEach(function(p) {
    var m = p.month;
    if (!m || !buckets[m]) return;
    if (p.direction === 'in')       buckets[m].paymentsIn  += p.amount || 0;
    else if (p.direction === 'out') buckets[m].paymentsOut += p.amount || 0;
  });

  // ── Outstanding invoices: expected future income by due date ─
  // Only applied to current month and future — past months use actual
  // payments data only, since outstanding invoices in past months means
  // late payment which hasn't actually arrived yet.
  // Overdue invoices (due date in past, still AUTHORISED) are bucketed
  // into the CURRENT month as a separate line — flagged clearly as overdue.
  var today = new Date(); today.setHours(0,0,0,0);
  var overdueInvoices = [];

  invoices.forEach(function(inv) {
    if (inv.status !== 'AUTHORISED') return;
    var m = monthOf(inv.dueDate);
    if (!m) return;

    var dueDate = inv.dueDate ? new Date(inv.dueDate) : null;
    var isOverdue = dueDate && dueDate < today;

    if (isOverdue) {
      // Bucket into current month — overdue, chase now
      if (buckets[currentMonth]) {
        buckets[currentMonth].overdueIncome = (buckets[currentMonth].overdueIncome || 0) + (inv.total || 0);
      }
      var daysOverdue = dueDate ? Math.floor((today - dueDate) / 86400000) : 0;
      overdueInvoices.push({
        invoiceNumber: inv.invoiceNumber,
        contact:       inv.contact,
        dueDate:       inv.dueDate,
        daysOverdue:   daysOverdue,
        total:         inv.total || 0,
        reference:     inv.reference || '',
      });
    } else {
      // Future due date — bucket normally
      if (!buckets[m]) return;
      if (m < currentMonth) return;
      buckets[m].outstandingIncome += (inv.total || 0) * paymentRate;
    }
  });

  // Sort overdue by days overdue descending
  overdueInvoices.sort(function(a,b) { return b.daysOverdue - a.daysOverdue; });

  // ── Direct bank transactions (non-overlapping with payments) ─
  // Past months: use actual Xero figures
  // Future months: do NOT project direct spend forward — it's largely captured
  // in Projected Fixed Costs (recurring detection) and VAT Provision already.
  // Remaining items are too variable and small to forecast reliably.
  months.forEach(function(m) {
    var mo = directByMonth[m];
    if (!mo) return;
    buckets[m].directSpend   += mo.directSpendTotal   || 0;
    buckets[m].directReceive += mo.directReceiveTotal || 0;
  });

  var directSpendNote = 'Direct bank spend: actuals only for past months, not projected forward.';

  // ── Future driver costs from Events sheet ──────────────────
  evData.forEach(function(r) {
    var eventEnd = r[11];
    var estCost  = r[27] || 0;
    if (!eventEnd || !estCost) return;
    var payDate = addDaysToDate(eventEnd, driverPaymentDays);
    var m = monthOf(payDate);
    if (m && buckets[m] && m >= currentMonth) {
      buckets[m].driverCosts += estCost;
    }
  });

  // ── Recurring fixed costs (detected from history) ──────────
  months.forEach(function(m) {
    if (m <= currentMonth) return;
    buckets[m].recurringFixed = recurringCosts[m] || 0;
    // Add Ops Manager salary if applicable for this month
    if (opsMonthly > 0 && m >= opsStartMonth) {
      var includeOps = opsEndMonth ? m <= opsEndMonth : true;
      if (includeOps) buckets[m].recurringFixed += opsMonthly;
    }
  });

  // ── Forecast Assumptions Section 4 ────────────────────────
  // Read estimated monthly income and cost from the Forecast Assumptions tab.
  // Only applied to months in FORECAST_MONTHS (Oct 2026 onwards) where
  // director assumptions have been entered. For months with forecast income,
  // driver costs from the Events sheet are NOT added separately since Section 4
  // cost already includes them.
  var faSheet = ss.getSheetByName('Forecast Assumptions');
  var forecastVatByQuarter = {};
  if (faSheet && faSheet.getLastRow() > 2) {
    var s4Start = faSheet.getRange('N1').getValue();
    var s4End   = faSheet.getRange('O1').getValue();
    if (s4Start > 0 && s4End >= s4Start) {
      var faData = faSheet.getRange(s4Start, 1, s4End - s4Start + 1, 3).getValues();
      faData.forEach(function(r) {
        var rawMonth = r[0];
        var monthVal;
        if (rawMonth instanceof Date) {
          var yr2 = rawMonth.getFullYear();
          var mo2 = rawMonth.getMonth() + 1;
          monthVal = yr2 + '-' + (mo2 < 10 ? '0' + mo2 : '' + mo2);
        } else {
          var s2 = String(rawMonth).trim();
          if (s2.match(/^\d{4}-\d{2}$/)) monthVal = s2;
          else return;
        }
        var estIncome = typeof r[1] === 'number' ? r[1] : 0;
        var estCost   = typeof r[2] === 'number' ? r[2] : 0;

        // Bucket forecast income/cost
        if (buckets[monthVal] && (estIncome > 0 || estCost > 0)) {
          buckets[monthVal].forecastIncome += estIncome;
          buckets[monthVal].forecastCost   += estCost;
          // Only zero driver costs for Oct 2026+ (forecast months)
          // Aug/Sep have real booked events in Events sheet — keep their driver costs
          if (monthVal >= '2026-10') {
            buckets[monthVal].driverCosts = 0;
          }
        }

        // Build forecast VAT by quarter for VAT estimation
        if (estIncome > 0) {
          var vatElement = estIncome / 6; // VAT-inclusive income, std rate
          var mo3 = parseInt(monthVal.substring(5, 7));
          var yr3 = monthVal.substring(0, 4);
          var qNum = mo3 <= 3 ? 'Q1' : mo3 <= 6 ? 'Q2' : mo3 <= 9 ? 'Q3' : 'Q4';
          var qKey3 = yr3 + '-' + qNum;
          if (!forecastVatByQuarter[qKey3]) forecastVatByQuarter[qKey3] = 0;
          forecastVatByQuarter[qKey3] += vatElement;
        }
      });
    }
  }

  // ── VAT provisions — smart calculation ────────────────────
  // Cash accounting: VAT due 37 days after quarter end (Jan/Apr/Jul/Oct quarters)
  // Completed quarters: use actual calculated figures from vatQuarters
  // Incomplete quarters (current + future): estimate from:
  //   - Actual payments received/made so far in the quarter
  //   - Outstanding invoice VAT due in the quarter (AUTHORISED invoices)
  //   - Pipeline events (Events sheet quoted price × 1/6 for standard rate VAT)
  //   - Input VAT estimate: avg monthly input from completed quarters × remaining months

  // Calculate average monthly input VAT from completed quarters
  // A quarter is "complete" if the last month of the quarter is in the past
  // Q1=Jan-Mar complete after Mar, Q2=Apr-Jun complete after Jun, etc.
  var completedQuarters = Object.keys(vatQuarters).filter(function(qKey) {
    var yr   = qKey.substring(0, 4);
    var qNum = parseInt(qKey.substring(6));
    var lastMonthOfQuarter = yr + '-' + ['03','06','09','12'][qNum - 1];
    return lastMonthOfQuarter < currentMonth;
  });
  var totalInputVatCompleted = completedQuarters.reduce(function(a, qKey) {
    return a + vatQuarters[qKey].totalInputVat;
  }, 0);
  var completedMonths = completedQuarters.length * 3;
  var avgMonthlyInputVat = completedMonths > 0 ? totalInputVatCompleted / completedMonths : 0;

  // Build outstanding invoice VAT by quarter
  var invoiceVatByQuarter = {};
  invoices.forEach(function(inv) {
    if (inv.status !== 'AUTHORISED') return;
    var m = monthOf(inv.dueDate);
    if (!m) return;
    var mo = parseInt(m.substring(5, 7));
    var yr = m.substring(0, 4);
    var qNum = mo <= 3 ? 1 : mo <= 6 ? 2 : mo <= 9 ? 3 : 4;
    var qKey = yr + '-Q' + qNum;
    if (!invoiceVatByQuarter[qKey]) invoiceVatByQuarter[qKey] = 0;
    invoiceVatByQuarter[qKey] += inv.totalTax || 0;
  });

  // Build pipeline VAT by quarter from Events sheet
  // Only events without a matching Xero invoice (uninvoiced pipeline)
  var pipelineVatByQuarter = {};
  evData.forEach(function(r) {
    var eventStart  = r[10];  // col 11 Event Start
    var quotedPrice = r[28];  // col 29 Quoted Price
    var invoicedNet = r[29];  // col 30 Invoiced Net — if populated, already invoiced
    if (!eventStart || !quotedPrice || quotedPrice <= 0) return;
    if (invoicedNet && invoicedNet > 0) return; // already invoiced, covered above

    var m = monthOf(eventStart);
    if (!m) return;
    var mo = parseInt(m.substring(5, 7));
    var yr = m.substring(0, 4);
    var qNum = mo <= 3 ? 1 : mo <= 6 ? 2 : mo <= 9 ? 3 : 4;
    var qKey = yr + '-Q' + qNum;

    // VAT on pipeline: quoted price is net, VAT = quoted × 20%
    // (quoted price from Events sheet is net ex VAT)
    if (!pipelineVatByQuarter[qKey]) pipelineVatByQuarter[qKey] = 0;
    pipelineVatByQuarter[qKey] += quotedPrice * 0.20;
  });

  // Now bucket VAT for each quarter
  // Quarter definitions: Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec
  var quarterDefs = {
    'Q1': { months: ['01','02','03'], payDayOffset: 37 },
    'Q2': { months: ['04','05','06'], payDayOffset: 37 },
    'Q3': { months: ['07','08','09'], payDayOffset: 37 },
    'Q4': { months: ['10','11','12'], payDayOffset: 37 },
  };

  ['2026','2027'].forEach(function(yr) {
    Object.keys(quarterDefs).forEach(function(qNum) {
      var qKey    = yr + '-' + qNum;
      var qDef    = quarterDefs[qNum];
      var qEndMo  = parseInt(qDef.months[2]);
      var qEndDate = new Date(parseInt(yr), qEndMo, 0); // last day of quarter
      var payDate  = new Date(qEndDate);
      payDate.setDate(payDate.getDate() + qDef.payDayOffset);
      var payMonth = payDate.toISOString().substring(0, 7);

      if (!buckets[payMonth]) return; // outside our forecast window

      var existing = vatQuarters[qKey];

      if (existing && completedQuarters.indexOf(qKey) !== -1) {
        // Completed quarter — use actual calculated figure
        var net = existing.netVat;
        if (net > 0) buckets[payMonth].vatProvision += net;
        else if (net < 0) buckets[payMonth].directReceive += Math.abs(net);

      } else {
        // Incomplete or future quarter — estimate
        var actualOutputVat    = existing ? existing.outputVat : 0;
        var actualInputVat     = existing ? existing.totalInputVat : 0;
        var outstandingInvVat  = invoiceVatByQuarter[qKey] || 0;
        var pipelineVat        = pipelineVatByQuarter[qKey] || 0;

        // Count months remaining in quarter after current month
        var qMonths = qDef.months.map(function(mo) { return yr + '-' + mo; });
        var remainingMonths = qMonths.filter(function(m) { return m > currentMonth; }).length;

        var estimatedOutputVat = actualOutputVat + outstandingInvVat + pipelineVat + (forecastVatByQuarter[qKey] || 0);
        var estimatedInputVat  = actualInputVat + (avgMonthlyInputVat * remainingMonths);
        var estimatedNet       = estimatedOutputVat - estimatedInputVat;

        if (estimatedNet > 0) buckets[payMonth].vatProvision += estimatedNet;
        else if (estimatedNet < 0) buckets[payMonth].directReceive += Math.abs(estimatedNet);
      }
    });
  });

  // Manual override from Rate Card — takes precedence if set
  if (q2VatAmount > 0 && q2VatMonth && buckets[q2VatMonth]) {
    buckets[q2VatMonth].vatProvision = q2VatAmount; // override
  }
  if (q3VatAmount > 0 && q3VatMonth && buckets[q3VatMonth]) {
    buckets[q3VatMonth].vatProvision = q3VatAmount; // override
  }

  // ── Write Cash Flow sheet ──────────────────────────────────
  var cfSheet = ss.getSheetByName('Cash Flow 2026-2027') || ss.getSheetByName('Cash Flow 2026');
  if (!cfSheet) {
    cfSheet = ss.insertSheet('Cash Flow 2026-2027');
    ss.setActiveSheet(cfSheet);
    var evRef = ss.getSheetByName('Events');
    if (evRef) ss.moveActiveSheet(ss.getSheets().indexOf(evRef) + 2);
  }
  // Rename if it's still the old name
  if (cfSheet.getName() === 'Cash Flow 2026') {
    cfSheet.setName('Cash Flow 2026-2027');
  }
  cfSheet.clearContents().clearFormats();

  var darkPurple = '#2d0a3e';

  var colHeaders = [
    'Month', 'Opening Balance',
    'Invoice Receipts (Actual)', 'Outstanding Invoices (Due)', 'Overdue Invoices (Chasing)',
    'Forecast Income (Assumptions)',
    'Bill Payments Out', 'Direct Bank Receive', 'Direct Bank Spend',
    'Est. Driver Costs', 'Projected Fixed Costs', 'VAT Provision',
    'Forecast Cost (Assumptions)',
    'Total In', 'Total Out',
    'Net', 'Closing Balance',
    'Notes'
  ];
  var numCols = colHeaders.length;

  cfSheet.getRange(1, 1, 1, numCols).merge()
    .setValue('CASH FLOW 2026  —  Opening balance £' + openingBalance.toFixed(2) + ' (Rate Card B36)')
    .setBackground(darkPurple).setFontColor('#ffffff')
    .setFontWeight('bold').setFontSize(11)
    .setHorizontalAlignment('center');
  cfSheet.setRowHeight(1, 30);

  cfSheet.getRange(2, 1, 1, numCols)
    .setValues([colHeaders])
    .setBackground('#1a1a2e').setFontColor('#ffffff')
    .setFontWeight('bold').setFontSize(9).setWrap(true);
  cfSheet.setRowHeight(2, 50);
  cfSheet.setFrozenRows(2);

  var rows = [];
  var runningBalance = openingBalance;

  months.forEach(function(m) {
    var b          = buckets[m];
    var openBal    = runningBalance;
    var totalIn    = b.paymentsIn  + b.outstandingIncome + b.overdueIncome + b.directReceive + b.forecastIncome;
    var totalOut   = b.paymentsOut + b.directSpend + b.driverCosts + b.recurringFixed + b.vatProvision + b.forecastCost;
    var net        = totalIn - totalOut;
    runningBalance = openBal + net;

    var isPast    = m < currentMonth;
    var isCurrent = m === currentMonth;
    var note = isPast    ? 'Actual (Xero payments + direct spend)' :
               isCurrent ? 'Current month — actual + forecast' :
                           'Forecast';

    rows.push([
      m, openBal,
      b.paymentsIn, b.outstandingIncome, b.overdueIncome,
      b.forecastIncome,
      b.paymentsOut, b.directReceive, b.directSpend,
      b.driverCosts, b.recurringFixed, b.vatProvision,
      b.forecastCost,
      totalIn, totalOut,
      net, runningBalance,
      note
    ]);
  });

  cfSheet.getRange(3, 1, rows.length, numCols).setValues(rows);

  // Totals row
  var totRow = rows.length + 3;
  cfSheet.getRange(totRow, 1).setValue('TOTALS').setFontWeight('bold');
  for (var c = 3; c <= 17; c++) {
    var col = columnToLetter(c);
    cfSheet.getRange(totRow, c)
      .setFormula('=SUM(' + col + '3:' + col + (totRow-1) + ')')
      .setFontWeight('bold');
  }
  cfSheet.getRange(totRow, 1, 1, numCols).setBackground('#e8e8e8');
  cfSheet.getRange(totRow, 2, 1, 16).setNumberFormats([new Array(16).fill('£#,##0.00')]);

  // Number formats — set all in one call
  var fmtRow = new Array(16).fill('£#,##0.00');
  var fmtGrid = new Array(rows.length + 1).fill(fmtRow);
  cfSheet.getRange(3, 2, rows.length + 1, 16).setNumberFormats(fmtGrid);

  // Conditional format: closing balance col 17
  var balRange = cfSheet.getRange(3, 17, rows.length, 1);
  var cfRules  = cfSheet.getConditionalFormatRules();
  cfRules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberLessThan(0)
    .setBackground('#fff0f0').setFontColor('#c00000')
    .setRanges([balRange]).build());
  cfRules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberGreaterThan(0)
    .setBackground('#f0fff0').setFontColor('#1e4620')
    .setRanges([balRange]).build());
  cfSheet.setConditionalFormatRules(cfRules);

  // Row shading — batch into single call
  var bgGrid = rows.map(function(r, i) {
    var bg = r[0] < currentMonth  ? '#f5f5f5' :
             r[0] === currentMonth ? '#ffffff'  :
             (i % 2 === 0 ? '#ffffff' : '#f5f0ff');
    return new Array(numCols).fill(bg);
  });
  cfSheet.getRange(3, 1, rows.length, numCols).setBackgrounds(bgGrid);

  // Column widths — only set on first run
  if (cfSheet.getColumnWidth(1) !== 70) {
    var widths = [70,110,120,120,120,120,100,100,100,100,110,90,110,90,90,90,110,200];
    widths.forEach(function(w, i) { cfSheet.setColumnWidth(i + 1, w); });
  }

  // Quick reconciliation check
  var lastActualMonth = null;
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i][0] < currentMonth) { lastActualMonth = rows[i]; break; }
  }
  var reconcileNote = '';
  if (lastActualMonth) {
    reconcileNote = 'Last actual closing balance (' + lastActualMonth[0] + '): £' +
      lastActualMonth[16].toFixed(2);
  }

  // ── Overdue Invoice List ──────────────────────────────────
  var overdueStartRow = totRow + 3;
  cfSheet.getRange(overdueStartRow, 1, 1, 6).merge()
    .setValue('OVERDUE INVOICES — CHASE LIST (' + overdueInvoices.length + ' invoices)')
    .setBackground('#c55a11').setFontColor('#ffffff')
    .setFontWeight('bold').setFontSize(11)
    .setHorizontalAlignment('center');
  cfSheet.getRange(overdueStartRow + 1, 1, 1, 6)
    .setValues([['Invoice No', 'Contact', 'Reference / SP ID', 'Due Date', 'Days Overdue', 'Amount (inc VAT)']])
    .setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold').setFontSize(9);

  if (overdueInvoices.length === 0) {
    cfSheet.getRange(overdueStartRow + 2, 1).setValue('No overdue invoices.');
  } else {
    var overdueRows = overdueInvoices.map(function(inv) {
      return [inv.invoiceNumber, inv.contact, inv.reference, inv.dueDate, inv.daysOverdue, inv.total];
    });
    cfSheet.getRange(overdueStartRow + 2, 1, overdueRows.length, 6).setValues(overdueRows);
    cfSheet.getRange(overdueStartRow + 2, 4, overdueRows.length, 1).setNumberFormat('dd/mm/yyyy');
    cfSheet.getRange(overdueStartRow + 2, 6, overdueRows.length, 1).setNumberFormat('£#,##0.00');
    var overdueBgColors = overdueRows.map(function(r) {
      var daysOver = r[4];
      var bg = daysOver > 60 ? '#fce4d6' : daysOver > 30 ? '#fff2cc' : '#ffffff';
      return [bg, bg, bg, bg, bg, bg];
    });
    cfSheet.getRange(overdueStartRow + 2, 1, overdueRows.length, 6).setBackgrounds(overdueBgColors);
    var overdueTotRow = overdueStartRow + 2 + overdueRows.length;
    cfSheet.getRange(overdueTotRow, 1).setValue('TOTAL OVERDUE').setFontWeight('bold').setBackground('#e8e8e8');
    cfSheet.getRange(overdueTotRow, 6)
      .setFormula('=SUM(F' + (overdueStartRow+2) + ':F' + (overdueTotRow-1) + ')')
      .setNumberFormat('£#,##0.00').setFontWeight('bold').setBackground('#e8e8e8');
  }

  // Amber conditional format on Overdue Invoices column (col 5)
  var cfRules2 = cfSheet.getConditionalFormatRules();
  cfRules2.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberGreaterThan(0)
    .setBackground('#fff2cc').setFontColor('#c55a11')
    .setRanges([cfSheet.getRange(3, 5, rows.length, 1)]).build());
  cfSheet.setConditionalFormatRules(cfRules2);

  var recurringContactCount = Object.keys(recurringByContact || {}).length;

  // Build VAT summary from the actual bucket figures (enhanced estimates)
  var vatBucketSummary = [];
  var vatPayMonths = {
    '2026-Q1': '2026-05', '2026-Q2': '2026-08',
    '2026-Q3': '2026-11', '2026-Q4': '2027-02',
    '2027-Q1': '2027-05', '2027-Q2': '2027-08',
    '2027-Q3': '2027-11', '2027-Q4': '2028-02',
  };
  Object.keys(vatPayMonths).forEach(function(qKey) {
    var payMonth = vatPayMonths[qKey];
    var b = buckets[payMonth];
    if (!b) return;
    if (b.vatProvision > 0 || b.directReceive > 0) {
      var isCompleted = completedQuarters.indexOf(qKey) !== -1;
      var tag = isCompleted ? '(actual)' : '(estimated)';
      if (b.vatProvision > 0) {
        vatBucketSummary.push(qKey + ': £' + b.vatProvision.toFixed(0) + ' pay HMRC ' + tag + ' due ' + payMonth);
      } else {
        vatBucketSummary.push(qKey + ': £' + b.directReceive.toFixed(0) + ' RECLAIM ' + tag + ' due ' + payMonth);
      }
    }
  });

  SpreadsheetApp.getUi().alert(
    'Cash Flow 2026 built.\n\n' +
    'Opening balance: £' + openingBalance.toFixed(2) + '\n' +
    (reconcileNote ? reconcileNote + '\n' : '') +
    '\nOverdue invoices (chase list below cash flow): ' + overdueInvoices.length + '\n' +
    'Projected recurring fixed costs detected: ' + recurringContactCount + ' contacts\n' +
    directSpendNote + '\n\n' +
    'VAT quarters (cash accounting):\n  ' + (vatBucketSummary.join('\n  ') || 'No data') + '\n\n' +
    'Compare closing balance against Xero bank feed to verify actuals.'
  );
}

// ── CREATE SHEETS (run once) ──────────────────────────────────

function createSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var rc = ss.getSheetByName('Rate Card');
  if (!rc) rc = ss.insertSheet('Rate Card');
  rc.clearContents().clearFormats();

  var darkPurple = '#2d0a3e';
  var orange     = '#c55a11';

  rc.getRange('A1:C1').breakApart().merge().setValue('MOBILOO — STAFF COST RATE CARD')
    .setBackground(darkPurple).setFontColor('#ffffff').setFontWeight('bold').setFontSize(12);
  rc.getRange('A2').setValue('Change values in column B. All cost calculations update automatically.')
    .setFontColor('#666666').setFontSize(9);
  rc.setRowHeight(1, 32);

  var settings = [
    ['STAFF', '', ''],
    ['Hourly rate (£/hr)', 15, 'Driver pay rate — self-employed, all-in'],
    ['OPERATIONS MANAGER', '', ''],
    ['Ops Manager annual salary (£)', 44000, 'Leanne Chambers — Operations Manager'],
    ['Ops Manager contract', 'Permanent', 'Enter: Permanent OR 6 months. Permanent = ongoing from April 2026. 6 months = April-September 2026 only.'],
    ['Ops Manager start month', '2026-04', 'Month salary begins (YYYY-MM)'],
    ['TRAVEL', '', ''],
    ['Driving speed (mph)', 40, 'Used to calculate driving hours paid (van/trailer average)'],
    ['Mileage rate (£/mile)', 0.45, 'HMRC approved rate — applied to return trip × units'],
    ['Hotel threshold (miles)', 50, 'Hotel added if one-way distance exceeds this OR event is multi-day'],
    ['SETUP HOURS PER UNIT', '', ''],
    ['Trailer setup (hrs)', 4, 'Setup/breakdown time per Trailer unit'],
    ['POD setup (hrs)', 4, 'Setup/breakdown time per POD unit'],
    ['Day Van setup (hrs)', 1, 'Setup/breakdown time per Day Van unit'],
    ['Contingency (hrs/event)', 1, 'Added to every event regardless of resource type'],
    ['ACCOMMODATION', '', ''],
    ['Hotel nightly cost (£)', 80, 'Per driver per night'],
    ['Subsistence daily rate (£)', 25, 'Per driver per day (HMRC benchmark)'],
    ['Volunteer catering (£/day)', 10, 'Per volunteer per day — added to subsistence when volunteers entered'],
    ['PAYE', '', ''],
    ['PAYE mode', 'No', 'Change to Yes to add employer on-costs to wages'],
    ['PAYE on-cost multiplier', 1.258, 'Employer NI 13.8% + holiday pay 12.07% — only used when PAYE = Yes'],
    ['PAYMENT TERMS', '', ''],
    ['Driver payment (days after event end)', 14, 'Days after event end date before driver pay leaves the bank — used in cash flow timing'],
    ['Expected invoice payment rate (%)', 95, 'Conservative assumption — % of outstanding invoices expected to be paid on time. Applied to forecast months only.'],
    ['FLEET', '', ''],
    ['Trailers (current)', 4, 'Current number of trailer units owned — used for capacity gap calculation'],
    ['PODs (current)',      0, 'Current number of POD units owned'],
    ['Day Vans (current)', 0, 'Current number of Day Van units owned'],
    ['Est. build cost per Trailer (£)', 0, 'Approximate cost to build/acquire one additional trailer — from build cost analysis'],
    ['Est. build cost per POD (£)',     0, 'Approximate cost to build/acquire one additional POD'],
    ['Est. build cost per Day Van (£)', 0, 'Approximate cost to acquire one additional Day Van'],
    ['OPENING BALANCE', '', ''],
    ['Opening bank balance (£)', 0, 'Bank balance at 1 Jan 2026 — update manually from Xero bank feed'],
    ['VAT PROVISIONS', '', ''],
    ['Q2 VAT payment month', '2026-07', 'YYYY-MM — month Q2 VAT return payment expected (typically July)'],
    ['Q2 VAT provision (£)', 0, 'Expected VAT payment for Q2 (Apr-Jun) — ask your accountant'],
    ['Q3 VAT payment month', '2026-10', 'YYYY-MM — month Q3 VAT return payment expected (typically October)'],
    ['Q3 VAT provision (£)', 0, 'Expected VAT payment for Q3 (Jul-Sep) — ask your accountant'],
    ['Monthly VAT on account (£)', 0, 'If on monthly payments on account scheme — amount per month'],
    ['', '', ''],
    ['Last refreshed', '', ''],
  ];

  var row = 3;
  settings.forEach(function(s, idx) {
    var isSection = s[1] === '' && s[0] !== '' && s[0] !== 'Last refreshed';
    var isEmpty   = s[0] === '';
    var isStamp   = s[0] === 'Last refreshed';

    if (isSection) {
      rc.getRange(row, 1, 1, 3).merge()
        .setValue(s[0]).setBackground(orange).setFontColor('#ffffff')
        .setFontWeight('bold').setFontSize(9);
    } else if (!isEmpty) {
      var bg = isStamp ? '#f0f0f0' : (row % 2 === 0 ? '#ffffff' : '#faf5ff');
      rc.getRange(row, 1).setValue(s[0]).setBackground(bg).setFontWeight('bold').setFontSize(10);
      rc.getRange(row, 2).setValue(s[1]).setBackground(isStamp ? '#f0f0f0' : '#fff8e7')
        .setFontWeight('bold').setFontSize(11);
      if (typeof s[1] === 'number' && s[0].indexOf('£') !== -1) {
        rc.getRange(row, 2).setNumberFormat('£#,##0.00');
      } else if (typeof s[1] === 'number' && Number.isInteger(s[1])) {
        rc.getRange(row, 2).setNumberFormat('0');       // integer — days, mph, hours etc
      } else if (typeof s[1] === 'number') {
        rc.getRange(row, 2).setNumberFormat('0.000');   // decimal — multipliers, rates without £
      } else if (typeof s[1] === 'string' && s[1] !== 'No' && s[1] !== 'Yes') {
        rc.getRange(row, 2).setNumberFormat('@');       // force plain text for string values
      }
      if (isStamp) rc.getRange(row, 2).setNumberFormat('dd/mm/yyyy hh:mm');
      rc.getRange(row, 3).setValue(s[2]).setBackground(bg).setFontColor('#666666').setFontSize(9).setWrap(true);
    }
    row++;
  });

  rc.setColumnWidth(1, 220);
  rc.setColumnWidth(2, 140);
  rc.setColumnWidth(3, 320);
  rc.setFrozenRows(1);

  if (!ss.getSheetByName('Events'))               ss.insertSheet('Events');
  if (!ss.getSheetByName('Summary'))              ss.insertSheet('Summary');
  if (!ss.getSheetByName('Cash Flow 2026-2027'))  ss.insertSheet('Cash Flow 2026-2027');
  if (!ss.getSheetByName('Forecast Assumptions')) ss.insertSheet('Forecast Assumptions');
  if (!ss.getSheetByName('Xero Invoices'))        ss.insertSheet('Xero Invoices');
  if (!ss.getSheetByName('Xero Outgoings'))       ss.insertSheet('Xero Outgoings');
  if (!ss.getSheetByName('Xero Outgoings Detail')) ss.insertSheet('Xero Outgoings Detail');
  if (!ss.getSheetByName('Xero Account Codes'))   ss.insertSheet('Xero Account Codes');
  if (!ss.getSheetByName('P&L by Account Code'))  ss.insertSheet('P&L by Account Code');

  var order = ['Rate Card', 'Events', 'Summary', 'Cash Flow 2026-2027', 'Forecast Assumptions', 'Xero Invoices', 'Xero Outgoings', 'Xero Outgoings Detail', 'Xero Account Codes', 'P&L by Account Code'];
  order.forEach(function(name, i) {
    var s = ss.getSheetByName(name);
    if (s) { ss.setActiveSheet(s); ss.moveActiveSheet(i + 1); }
  });

  SpreadsheetApp.getUi().alert('Setup complete. Use Mobiloo menu to refresh data.');
}
