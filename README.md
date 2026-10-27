# AZ-104 Exam Simulator

Practice and timed-exam simulator for the Microsoft Azure Administrator (AZ-104) certification.

## Modes

- **Practice** – answer at your own pace. Each answer is checked instantly, with an explanation and a note on why every other option is wrong. Filter by domain, or show only unanswered, incorrect, or flagged questions.
- **Exam** – pick how many questions you want (default 50, 2 minutes each). Questions are drawn from the bank in proportion to the AZ-104 domain weights, preferring ones you've seen least, so a big bank rotates instead of repeating. Timer, shuffled questions and options, no feedback until you submit. Results show a scaled score (700 to pass), a domain breakdown and your recent attempts. Afterwards you can review missed questions or all questions.

Progress, flags, and exam history are saved in your browser (localStorage), and the exam timer survives refreshes.

**Keyboard:** `A`–`D` (or `1`–`4`) answer · `←` `→` navigate · `F` flag.

## Project structure

```
index.html              page shell + inline SVG icons
css/styles.css          all styles (no CSS framework at runtime)
js/app.js               app logic (state, rendering, timer, question selection)
js/domains.js           exam domains and their weights
data/questions.json     the question bank
data/question-template.csv       spreadsheet template for bulk imports
scripts/import-csv.mjs           CSV → questions.json importer
scripts/validate-questions.mjs   sanity checks for the question bank
vercel.json             caching + security headers
```

It is a static site with no build step and no dependencies.

## Run locally

```bash
python3 -m http.server 4173   # or: npx serve .
# open http://localhost:4173
```

## Add questions in bulk (spreadsheet)

1. Open `data/question-template.csv` in Excel or Google Sheets. One row per question:

   | column | what goes in it |
   |---|---|
   | `domain` | `D1`–`D5` (or `1`–`5`): identities, storage, compute, networking, monitoring |
   | `scenario` | the question; HTML allowed, e.g. `<code>rg-prod</code>` |
   | `code` | optional snippet (JSON, KQL, PowerShell) |
   | `option_a` … `option_f` | answer options (2–6; leave unused ones blank) |
   | `note_a` … `note_f` | optional "why this is wrong" for each option |
   | `answer` | letter of the correct option |
   | `explanation` | why the correct answer is right |

2. Export as CSV and run:

   ```bash
   node scripts/import-csv.mjs my-questions.csv --dry-run   # check for errors first
   node scripts/import-csv.mjs my-questions.csv             # append to data/questions.json
   ```

   IDs are assigned automatically, questions already in the bank (same scenario text) are skipped, and if any row has a problem nothing is written and you get the row numbers to fix.

3. Commit and push. Vercel redeploys in a few seconds.

Options are shuffled at runtime, so write notes and explanations about option content, not letters. You can also edit `data/questions.json` directly; run `node scripts/validate-questions.mjs` afterwards.

## Deploy

Hosted on Vercel; every push to `main` deploys automatically. No build settings needed (Framework preset: **Other**).
