// Sanity-checks data/questions.json: unique ids, valid domains, valid answer index, required fields.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS } from '../js/domains.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(root, 'data', 'questions.json'), 'utf8'));

const errors = [];
const ids = new Set();
const scenarios = new Set();
for (const q of QUESTIONS) {
  if (!Number.isInteger(q.id)) errors.push(`Question with non-integer id: ${JSON.stringify(q.id)}`);
  if (ids.has(q.id)) errors.push(`Duplicate id ${q.id}`);
  ids.add(q.id);
  const key = String(q.scenario).replace(/\s+/g, ' ').trim().toLowerCase();
  if (scenarios.has(key)) errors.push(`Q${q.id}: duplicate scenario text`);
  scenarios.add(key);
  if (!DOMAINS[q.domain]) errors.push(`Q${q.id}: unknown domain ${q.domain}`);
  if (!Array.isArray(q.options) || q.options.length < 2) errors.push(`Q${q.id}: needs at least 2 options`);
  else q.options.forEach((o, i) => { if (!o.text) errors.push(`Q${q.id}: option ${i} has no text`); });
  if (!(q.answer >= 0 && q.answer < (q.options?.length || 0))) errors.push(`Q${q.id}: answer index out of range`);
  if (!q.scenario || !q.explanation) errors.push(`Q${q.id}: missing scenario or explanation`);
}
const perDomain = Object.keys(DOMAINS).map((d) => `${d}: ${QUESTIONS.filter((q) => q.domain === d).length}`).join(', ');
console.log(`${QUESTIONS.length} questions (${perDomain})`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('OK');
