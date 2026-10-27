# Exam Simulator

Practice questions and timed exams for IT certifications. Currently includes:

| Exam | Folder | Questions | Scoring |
|---|---|---|---|
| Microsoft Azure Administrator (AZ-104) | `exams/az-104` | 198 | 700 / 1000 to pass |
| CompTIA Network+ (N10-009) | `exams/network-plus` | 237 | 720 on 100–900 to pass |
| CompTIA Security+ (SY0-701) | `exams/security-plus` | 195 | 750 on 100–900 to pass |
| Cisco CCNA (200-301 v2.0) | `exams/ccna` | 200 | ~825 / 1000 (Cisco doesn't publish a cut score) |
| AWS Solutions Architect – Associate (SAA-C03) | `exams/aws-saa` | 197 | 720 on 100–1000 to pass |

Open the site to pick an exam, or go straight to one at `/<folder>` (e.g. `/az-104`, `/network-plus`, `/security-plus`, `/ccna`, `/aws-saa`). Each exam keeps its own progress and history.

## Modes

- **Practice** – answer at your own pace. Each answer is checked instantly, with an explanation and a note on why every other option is wrong.
  - Questions are shuffled by default (switch Order to "In order" if you prefer); **Reshuffle** re-randomizes question order and answer letters.
  - **Try again** (or `R`) clears a question and reshuffles its options; **Retry missed** re-drills everything you got wrong.
  - Filter by domain, or show only unanswered, incorrect, or flagged questions. The list stays put while you answer.
- **Exam** – pick how many questions you want. Questions are drawn in proportion to the exam's official domain weights, preferring ones you've seen least, so a big bank rotates instead of repeating. Timer, shuffled questions and options, no feedback until you submit. Results show a scaled score, a domain breakdown with "Practice this domain" links, and recent attempts. Afterwards you can review missed questions or all questions.

Progress, flags, and exam history are saved in your browser (localStorage), and the exam timer survives refreshes. The site works offline and can be installed to a phone or desktop home screen.

**Keyboard:** `A`–`F` (or `1`–`6`) answer · `←` `→` navigate · `F` flag · `R` try again (practice).

## Project structure

```
index.html              page shell + inline SVG icons
css/styles.css          all styles (no CSS framework at runtime)
js/app.js               app logic (exam picker, state, rendering, timer, question selection)
exams/index.json        list of exams shown on the home screen
exams/<folder>/exam.json       exam settings: name, domains + weights, scoring, timing
exams/<folder>/questions.json  the exam's question bank
exams/question-template.csv    spreadsheet template for bulk imports
scripts/import-csv.mjs         CSV → questions.json importer
scripts/validate-questions.mjs sanity checks for all question banks
sw.js                   service worker (offline support)
manifest.webmanifest    install metadata; icons/ holds the app icons
vercel.json             exam URL rewrite, caching + security headers
```

It is a static site with no build step and no dependencies.

## Add a new certification

1. Create `exams/<folder>/exam.json` (copy an existing one) and set:
   - `slug` (same as the folder name; lowercase letters, numbers and hyphens), `code`, `name`, `vendor`
   - `domains` – `D1`, `D2`, … each with `name`, `weight` (display text) and `pct` (used to balance exams)
   - `scoring` – `min`, `max`, `pass` (e.g. 100 / 900 / 720 for CompTIA, 0 / 1000 / 700 for Microsoft)
   - `minutesPerQuestion`, `defaultSize`, `sizeOptions`, and optional `realExamNote` / `scoreNote`
2. Create `exams/<folder>/questions.json` containing `[]`.
3. Add the exam to `exams/index.json`.
4. Import questions (below), run `node scripts/validate-questions.mjs`, commit and push.

## Add questions in bulk (spreadsheet)

1. Open `exams/question-template.csv` in Excel or Google Sheets. One row per question:

   | column | what goes in it |
   |---|---|
   | `domain` | `D1`, `D2`, … (or `1`, `2`, …) as defined in that exam's `exam.json` |
   | `scenario` | the question; HTML allowed, e.g. `<code>rg-prod</code>` |
   | `code` | optional snippet (JSON, KQL, CLI output) |
   | `option_a` … `option_f` | answer options (2–6; leave unused ones blank) |
   | `note_a` … `note_f` | optional "why this is wrong" for each option |
   | `answer` | letter of the correct option |
   | `explanation` | why the correct answer is right |

2. Export as CSV and run:

   ```bash
   node scripts/import-csv.mjs --exam network-plus my-questions.csv --dry-run   # check for errors first
   node scripts/import-csv.mjs --exam network-plus my-questions.csv             # append to the bank
   ```

   IDs are assigned automatically, questions already in the bank (same scenario text) are skipped, and if any row has a problem nothing is written and you get the row numbers to fix.

3. Commit and push. Vercel redeploys in a few seconds.

Options are shuffled at runtime, so write notes and explanations about option content, not letters. Keep correct answers about the same length as the wrong ones so length doesn't give the answer away.

## Run locally

```bash
python3 -m http.server 4173   # then open http://localhost:4173/?exam=az-104
# (?exam= works anywhere; /az-104 style URLs need the Vercel rewrite or a similar local server)
```

## Deploy

Hosted on Vercel; every push to `main` deploys automatically. No build settings needed (Framework preset: **Other**).
