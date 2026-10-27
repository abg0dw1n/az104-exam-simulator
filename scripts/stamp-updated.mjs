#!/usr/bin/env node
// Sets "updated" (YYYY-MM-DD) for each exam in exams/index.json from the last git commit
// that touched exams/<slug>/. Run after committing question changes, then commit index.json.
//   node scripts/stamp-updated.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../exams/index.json', import.meta.url);
const exams = JSON.parse(readFileSync(path, 'utf8'));
for (const e of exams) {
  const date = execFileSync('git', ['log', '-1', '--format=%cs', '--', `exams/${e.slug}/`], { encoding: 'utf8' }).trim();
  if (date) e.updated = date;
  console.log(`${e.slug.padEnd(16)} ${e.updated || '(no commits)'}`);
}
writeFileSync(path, JSON.stringify(exams, null, 2) + '\n');
