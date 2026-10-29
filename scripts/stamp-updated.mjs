#!/usr/bin/env node
// Sets "updated" (YYYY-MM-DD) for each exam in exams/index.json from the last git commit
// that touched exams/<slug>/, and "questions" (the bank size shown on the home page, so the
// home page doesn't download every bank), "learningModules" for courses with learn.json, and "labs" for exams with labs.json. Run after committing question changes, then commit index.json.
//   node scripts/stamp-updated.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../exams/index.json', import.meta.url);
const exams = JSON.parse(readFileSync(path, 'utf8'));
for (const e of exams) {
  const date = execFileSync('git', ['log', '-1', '--format=%cs', '--', `exams/${e.slug}/`], { encoding: 'utf8' }).trim();
  if (date) e.updated = date;
  try {
    const learn = JSON.parse(readFileSync(new URL(`../exams/${e.slug}/learn.json`, import.meta.url), 'utf8'));
    e.learningModules = learn.modules?.length || 0;
  } catch { delete e.learningModules; }
  try {
    const labs = JSON.parse(readFileSync(new URL(`../exams/${e.slug}/labs.json`, import.meta.url), 'utf8'));
    e.labs = labs.labs?.length || 0;
  } catch { delete e.labs; }
  e.questions = JSON.parse(readFileSync(new URL(`../exams/${e.slug}/questions.json`, import.meta.url), 'utf8')).length;
  console.log(`${e.slug.padEnd(20)} ${String(e.questions).padStart(4)} questions  ${e.updated || '(no commits)'}`);
}
writeFileSync(path, JSON.stringify(exams, null, 2) + '\n');
