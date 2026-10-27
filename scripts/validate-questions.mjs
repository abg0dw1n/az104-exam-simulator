// Sanity-checks the question bank: unique ids, valid domains, valid answer index, 4 options.
import { QUESTIONS, DOMAINS } from '../js/questions.js';

const errors = [];
const ids = new Set();
const answerPositions = [0, 0, 0, 0];
for (const q of QUESTIONS) {
  if (ids.has(q.id)) errors.push(`Duplicate id ${q.id}`);
  ids.add(q.id);
  if (!DOMAINS[q.domain]) errors.push(`Q${q.id}: unknown domain ${q.domain}`);
  if (!Array.isArray(q.options) || q.options.length < 2) errors.push(`Q${q.id}: needs at least 2 options`);
  if (!(q.answer >= 0 && q.answer < q.options.length)) errors.push(`Q${q.id}: answer index out of range`);
  if (!q.scenario || !q.explanation) errors.push(`Q${q.id}: missing scenario or explanation`);
  q.options.forEach((o, i) => { if (!o.text) errors.push(`Q${q.id}: option ${i} has no text`); });
  answerPositions[q.answer]++;
}
const perDomain = Object.keys(DOMAINS).map((d) => `${d}: ${QUESTIONS.filter((q) => q.domain === d).length}`).join(', ');
console.log(`${QUESTIONS.length} questions (${perDomain})`);
console.log(`Answer index distribution in source: ${answerPositions.join(' / ')} (options are shuffled at runtime)`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('OK');
