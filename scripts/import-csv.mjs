// Import questions from a CSV file (e.g. exported from Excel or Google Sheets) into data/questions.json.
//
//   node scripts/import-csv.mjs path/to/questions.csv            # append new questions
//   node scripts/import-csv.mjs path/to/questions.csv --dry-run  # check only, write nothing
//
// Columns (header row required, order doesn't matter, names are case-insensitive):
//   domain       D1–D5 or 1–5 (see js/domains.js)
//   scenario     question text; HTML allowed, e.g. <code>rg-prod</code>
//   code         optional snippet (JSON, KQL, PowerShell…) shown as plain text
//   option_a … option_f   answer options (at least 2; blank ones are skipped)
//   note_a … note_f       optional "why this is wrong" note for each option
//   answer       letter of the correct option (A–F)
//   explanation  why the correct answer is right
//
// Rows whose scenario text already exists in the bank are skipped, so re-importing is safe.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS } from '../js/domains.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bankPath = path.join(root, 'data', 'questions.json');
const [csvPath, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');

if (!csvPath) {
  console.error('Usage: node scripts/import-csv.mjs <file.csv> [--dry-run]');
  process.exit(1);
}

// RFC 4180 CSV parser: quoted fields, escaped quotes, commas and newlines inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/^﻿/, ''); // strip Excel's BOM
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const normalize = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
if (rows.length < 2) { console.error('CSV has no data rows.'); process.exit(1); }
const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
const col = (r, name) => (r[header.indexOf(name)] ?? '').trim();
for (const required of ['domain', 'scenario', 'option_a', 'option_b', 'answer', 'explanation']) {
  if (!header.includes(required)) { console.error(`Missing required column: ${required}`); process.exit(1); }
}

const bank = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
const existing = new Set(bank.map((q) => normalize(q.scenario)));
let nextId = Math.max(0, ...bank.map((q) => q.id)) + 1;

const added = [], errors = [];
let skipped = 0;
rows.slice(1).forEach((r, i) => {
  const line = i + 2;
  let domain = col(r, 'domain').toUpperCase();
  if (/^\d$/.test(domain)) domain = `D${domain}`;
  const scenario = col(r, 'scenario');
  const options = [];
  const letters = [];
  for (const L of 'abcdef') {
    const text = col(r, `option_${L}`);
    if (text) { options.push({ text, note: col(r, `note_${L}`) }); letters.push(L.toUpperCase()); }
  }
  const answer = letters.indexOf(col(r, 'answer').toUpperCase().replace(/[^A-F]/g, ''));
  const explanation = col(r, 'explanation');

  const problems = [];
  if (!DOMAINS[domain]) problems.push(`unknown domain "${col(r, 'domain')}"`);
  if (!scenario) problems.push('empty scenario');
  if (options.length < 2) problems.push('needs at least 2 options');
  if (answer < 0) problems.push(`answer "${col(r, 'answer')}" doesn't match a filled-in option`);
  if (!explanation) problems.push('empty explanation');
  if (problems.length) { errors.push(`Row ${line}: ${problems.join('; ')}`); return; }

  if (existing.has(normalize(scenario))) { skipped++; return; }
  existing.add(normalize(scenario));
  const q = { id: nextId++, domain, scenario, options, answer, explanation };
  const code = col(r, 'code');
  if (code) q.code = code;
  added.push(q);
});

if (errors.length) {
  console.error(`Fix these rows and run again (nothing was written):\n  ${errors.join('\n  ')}`);
  process.exit(1);
}

const byDomain = Object.keys(DOMAINS).map((d) => `${d} +${added.filter((q) => q.domain === d).length}`).join(', ');
console.log(`${added.length} new question(s) (${byDomain}); ${skipped} duplicate(s) skipped.`);
if (dryRun) { console.log('Dry run: no changes written.'); process.exit(0); }
if (added.length) {
  fs.writeFileSync(bankPath, JSON.stringify([...bank, ...added], null, 2) + '\n');
  console.log(`Bank now has ${bank.length + added.length} questions → ${path.relative(root, bankPath)}`);
}
