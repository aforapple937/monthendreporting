'use strict';

// ============================================================
//  SHARED DATE UTILITIES (consolidated from 6+ inline implementations)
// ============================================================
const MONTH_MAP = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
const MONTH_NAMES = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// String → Date caches. The same PROC_DTE / reporting date string appears
// thousands of times per dataset; caching the regex+Date build is a measurable
// win in hot aggregation loops (Major Movement, TB recon, reversal).
// Bounded so a pathological dataset can't grow the map without limit.
const _SAS_DATE_CACHE = new Map();
const _RPT_DATE_CACHE = new Map();
const _DATE_CACHE_MAX = 5000;

/** Parse "31MAR2026:00:00:00" or "31MAR2026" (SAS-style) */
function parseSasDate(s) {
  const key = (s == null) ? '' : String(s);
  if (_SAS_DATE_CACHE.has(key)) return _SAS_DATE_CACHE.get(key);
  const m = key.match(/^(\d{2})([A-Z]{3})(\d{4})/i);
  const out = m ? new Date(+m[3], MONTH_MAP[m[2].toUpperCase()], +m[1]) : null;
  if (_SAS_DATE_CACHE.size < _DATE_CACHE_MAX) _SAS_DATE_CACHE.set(key, out);
  return out;
}

/** Parse "31-MAR-2026" or "31-MAR-26" (EGL reporting date style) */
function parseReportingDate(d) {
  if (!d) return null;
  const s = String(d).trim();
  if (_RPT_DATE_CACHE.has(s)) return _RPT_DATE_CACHE.get(s);
  let out = null;
  const m4 = s.match(/^(\d{2})-([A-Z]{3})-(\d{4})$/i);
  if (m4) out = new Date(parseInt(m4[3]), MONTH_MAP[m4[2].toUpperCase()], parseInt(m4[1]));
  else {
    const m2 = s.match(/^(\d{2})-([A-Z]{3})-(\d{2})$/i);
    if (m2) out = new Date(2000 + parseInt(m2[3]), MONTH_MAP[m2[2].toUpperCase()], parseInt(m2[1]));
  }
  if (_RPT_DATE_CACHE.size < _DATE_CACHE_MAX) _RPT_DATE_CACHE.set(s, out);
  return out;
}

/** Format Date → "MAR-2026" */
function fmtMMMyyyy(d) {
  return d ? MONTH_NAMES[d.getMonth()] + '-' + d.getFullYear() : null;
}

/** Check if two dates are in the same month */
function sameMonth(a, b) { return a && b && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear(); }

/** 30/360 year fraction */
function yrdif30_360(d1, d2) {
  const y1=d1.getFullYear(), m1=d1.getMonth()+1, day1=d1.getDate();
  const y2=d2.getFullYear(), m2=d2.getMonth()+1, day2=d2.getDate();
  const d30_1 = Math.min(day1, 30);
  const d30_2 = day1 === 31 ? Math.min(day2, 30) : day2;
  return ((y2-y1)*360 + (m2-m1)*30 + (d30_2-d30_1)) / 360;
}

// ============================================================
//  SHARED FORMAT / VALIDATE UTILITIES
// ============================================================
function fmtNum(v) {
  if (v === 0 || Math.abs(v) < 0.005) return '–';
  return v.toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const fmtN2 = v => v.toLocaleString('en-SG',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtN6 = v => typeof v==='number' ? v.toFixed(6) : v;
const roundCents = v => Math.round(v * 100) / 100;

function validateCols(data, req, name) {
  if (!data || !data.length) { alert(`Error: ${name} is empty or could not be parsed.`); return false; }
  const h = Object.keys(data[0]), miss = req.filter(c => !h.includes(c));
  if (miss.length) { alert(`Error in ${name}:\nMissing columns: ${miss.join(', ')}`); return false; }
  return true;
}

// ============================================================
//  CSV / EXCEL / EGL PARSERS
// ============================================================
function parseCSV(txt) {
  // RFC 4180-compliant: handles commas inside double-quoted fields and escaped quotes ("")
  function splitRow(line) {
    const fields = [];
    let i = 0, field = '', inQuote = false;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '\r') { i++; continue; }
      if (inQuote) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') { field += '"'; i += 2; }
          else { inQuote = false; i++; }
        } else { field += ch; i++; }
      } else {
        if (ch === '"') { inQuote = true; i++; }
        else if (ch === ',') { fields.push(field.trim()); field = ''; i++; }
        else { field += ch; i++; }
      }
    }
    fields.push(field.trim());
    return fields;
  }
  const res = [];
  let s = 0, e = txt.indexOf('\n');
  if (e === -1) e = txt.length;
  const hs = splitRow(txt.substring(s, e).replace(/\r$/, ''));
  s = e + 1;
  while (s < txt.length) {
    e = txt.indexOf('\n', s);
    if (e === -1) e = txt.length;
    const l = txt.substring(s, e).replace(/\r$/, '');
    s = e + 1;
    if (!l) continue;
    const v = splitRow(l), o = {};
    hs.forEach((h, i) => o[h] = (v[i] !== undefined ? v[i] : ''));
    res.push(o);
  }
  return res;
}

async function parseExcel(f) {
  return new Promise(res => {
    const r = new FileReader();
    r.onload = e => { const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' }); res(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })); };
    r.readAsArrayBuffer(f);
  });
}

async function parseEGL(f) {
  const txt = await f.text(), agg = {};
  let s = txt.indexOf('\n') + 1;
  let reportingDate = null;
  while (s > 0 && s < txt.length) {
    let e = txt.indexOf('\n', s); if (e === -1) e = txt.length;
    const l = txt.substring(s, e).trim(); s = e + 1; if (!l) continue;
    const v = l.split('|').map(x => x.replace(/"/g, '').trim()), desc = v[27]||'';
    if (!reportingDate && v[20]) reportingDate = v[20];
    const tag = (v[3]==='C' && desc.endsWith('IMPAIRED WRITE OFF')) ? '|ECL_WO' : (v[3]==='C' && desc.endsWith('IMPAIRED WRITE OFF UWI')) ? '|UWI_WO' : '';
    const k = `${v[5]}|${v[6]}|${v[7]}|${v[8]}|${v[9]}|${v[11]}|${v[22]}|${v[3]}${tag}`;
    agg[k] = (agg[k]||0) + parseFloat(v[21]||0);
  }
  agg.__reportingDate = reportingDate;
  return agg;
}
