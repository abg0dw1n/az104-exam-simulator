# Exam Simulator

Practice questions and timed exams for IT certifications, live at https://it-exam-simulator.vercel.app
(the original https://az104-exam-simulator-drab.vercel.app address still works). Currently includes:

| Exam | Folder | Questions | Scoring |
|---|---|---|---|
| Microsoft Azure Fundamentals (AZ-900) · beginner | `exams/az-900` | 127 | 700 / 1000 to pass |
| AWS Certified Cloud Practitioner (CLF-C02) · beginner | `exams/aws-clf` | 130 | 700 on 100–1000 to pass |
| CompTIA A+ Core 1 (220-1201) · beginner | `exams/a-plus-core1` | 128 | 675 on 100–900 to pass |
| CompTIA A+ Core 2 (220-1202) · beginner | `exams/a-plus-core2` | 127 | 700 on 100–900 to pass |
| Microsoft Security, Compliance, and Identity Fundamentals (SC-900) · beginner | `exams/sc-900` | 92 | 700 / 1000 to pass |
| Microsoft Azure Data Fundamentals (DP-900) · beginner | `exams/dp-900` | 87 | 700 / 1000 to pass |
| CompTIA Tech+ (FC0-U71) · beginner | `exams/tech-plus` | 93 | 650 on 100–900 to pass |
| Cisco CCST Networking (100-150) · beginner | `exams/ccst-networking` | 91 | ~70% (Cisco doesn't publish a cut score) |
| Cisco CCST Cybersecurity (100-160) · beginner | `exams/ccst-cybersecurity` | 83 | ~70% (Cisco doesn't publish a cut score) |
| Cisco CCST IT Support (100-140) · beginner | `exams/ccst-it-support` | 90 | ~70% (Cisco doesn't publish a cut score) |
| Cisco CCNA Cybersecurity (200-201) | `exams/ccna-cyber` | 99 | ~825 / 1000 (Cisco doesn't publish a cut score) |
| AWS Certified Developer – Associate (DVA-C02) | `exams/aws-dva` | 93 | 720 on 100–1000 to pass |
| AWS Certified CloudOps Engineer – Associate (SOA-C03) | `exams/aws-soa` | 92 | 720 on 100–1000 to pass |
| Google Cloud Digital Leader · beginner | `exams/google-cdl` | 88 | ~70% (Google doesn't publish a cut score) |
| Google Associate Cloud Engineer | `exams/google-ace` | 89 | ~70% (Google doesn't publish a cut score) |
| Google Associate Data Practitioner | `exams/google-adp` | 85 | ~70% (Google doesn't publish a cut score) |
| Google Professional Cloud Architect | `exams/google-pca` | 88 | ~70% (Google doesn't publish a cut score) |
| CompTIA Data+ (DA0-002) | `exams/data-plus` | 95 | 675 on 100–900 to pass |
| Tableau Desktop Foundations (Analytics-101) · beginner | `exams/tableau-foundations` | 80 | 48% to pass |
| Microsoft Azure Administrator (AZ-104) | `exams/az-104` | 198 | 700 / 1000 to pass |
| CompTIA Network+ (N10-009) | `exams/network-plus` | 237 | 720 on 100–900 to pass |
| CompTIA Security+ (SY0-701) | `exams/security-plus` | 195 | 750 on 100–900 to pass |
| Cisco CCNA (200-301 v2.0) | `exams/ccna` | 200 | ~825 / 1000 (Cisco doesn't publish a cut score) |
| AWS Solutions Architect – Associate (SAA-C03) | `exams/aws-saa` | 197 | 720 on 100–1000 to pass |
| Microsoft Azure AI Fundamentals (AI-901) | `exams/ai-901` | 100 | 700 / 1000 to pass |
| AWS Certified AI Practitioner (AIF-C01) | `exams/aws-aif` | 132 | 700 on 100–1000 to pass |
| Google Cloud Generative AI Leader | `exams/google-gail` | 110 | ~70% (Google doesn't publish a cut score) |

Open the site to pick an exam, or go straight to one at `/<folder>` (e.g. `/az-104`, `/network-plus`, `/security-plus`, `/ccna`, `/aws-saa`, `/ai-901`, `/aws-aif`, `/google-gail`). Each exam keeps its own progress and history.

## Modes

- **Practice** – answer at your own pace. Each answer is checked instantly, with an explanation and a note on why every other option is wrong.
  - Questions are shuffled by default (switch Order to "In order" if you prefer); **Reshuffle** re-randomizes question order and answer letters.
  - **Try again** (or `R`) clears a question and reshuffles its options; **Retry missed** re-drills everything you got wrong.
  - Filter by domain, or show only unanswered, incorrect, or flagged questions. The list stays put while you answer.
- **Exam** – pick how many questions you want. Questions are drawn in proportion to the exam's official domain weights, preferring ones you've seen least, so a big bank rotates instead of repeating. Timer, shuffled questions and options, no feedback until you submit. Results show a scaled score, a domain breakdown with "Practice this domain" links, and recent attempts. Afterwards you can review missed questions or all questions.

- **Learn** – training content for exams that have it (AZ-104, A+ Core 1, and A+ Core 2). One module per exam domain, each with:
  - a **study guide** (sections, exam tips, key terms, and a link to practice that domain),
  - a **slideshow** (arrow keys, speaker notes, full screen), and
  - a **video lesson** – AZ-104 slides animate with prerecorded Andrew Neural narration and captions; other courses use the device's built-in text-to-speech voice until recordings are added.

  Module progress (guide read, slides finished, video watched) is saved with the rest of your progress.

Progress, flags, and exam history are saved in your browser (localStorage), and the exam timer survives refreshes. The site works offline and can be installed to a phone or desktop home screen.

**Keyboard:** `A`–`F` (or `1`–`6`) answer · `←` `→` navigate · `F` flag · `R` try again (practice).

## Project structure

```
index.html              page shell + inline SVG icons
css/styles.css          all styles (no CSS framework at runtime)
js/app.js               app logic (exam picker, state, rendering, timer, question selection)
js/learn.js             Learn tab: study guides, slideshow and narrated video player
exams/index.json        list of exams shown on the home screen
exams/<folder>/exam.json       exam settings: name, domains + weights, scoring, timing
exams/<folder>/questions.json  the exam's question bank
exams/<folder>/learn.json      optional training content (enables the Learn tab)
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
3. Add the exam to `exams/index.json`, with `"level"` set to `beginner`, `intermediate` or `advanced` (shown as a difficulty meter on its card). The home page groups exams into a folder per `vendor`, easiest first.
4. Import questions (below), run `node scripts/validate-questions.mjs`, commit and push.

## Add training content (Learn tab)

Create `exams/<folder>/learn.json`. The Learn tab appears automatically for that exam.

```jsonc
{
  "intro": "One line shown above the modules",
  "sources": [{ "title": "Official study guide", "url": "https://..." }],
  "modules": [{
    "id": "D1",                       // matches a domain in exam.json
    "title": "Full module title", "short": "Short name", "summary": "One or two sentences",
    "guide": [{ "h": "Section heading", "html": "<p>Section body (HTML)</p>" }],
    "tips":  ["Exam tip (HTML)"],
    "terms": [["Term", "Definition (HTML)"]],
    "slides": [{
      "layout": "title",              // optional; for the opening slide
      "kicker": "Optional label", "title": "Slide title",
      "bullets": ["Bullet (HTML)"],
      "visual": { "type": "flow", "steps": [{ "t": "Step", "d": "Detail" }] },
      "script": ["Narration sentence one.", "Sentence two."]   // read aloud in the video
    }]
  }]
}
```

Visual types: `flow` (`steps`), `tree` (`levels`: array of rows), `cards` (`items` of `{t, d}`), `table` (`head`, `rows`), `code` (`lang`, `text`), `layers` (`items`, top to bottom). Video length is roughly script words ÷ 150 minutes.

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

## "Updated" dates

Each exam card shows when its questions last changed, from `updated` in `exams/index.json`.
After committing question changes, run `node scripts/stamp-updated.mjs` and commit `exams/index.json`.

## Weak spots and reports

- Every answer (practice and exams) updates a per-question spaced-repetition box. **Order → Weak spots first**
  puts missed and due questions at the top, and **Review N weak spots** starts a round of just those.
  "Mastered" counts questions in box 3+ (right several times, spaced over days).
- Signed-in users can **Report** a question; reports go to `public.question_reports`, and admins see and
  resolve them on the home page. `/<exam>?q=<id>` opens a single question.
- `.github/workflows/keepalive.yml` reads the database twice a week so the free Supabase project doesn't pause;
  `validate.yml` checks the question banks on every push.

## Accounts and sync (optional)

`js/auth.js` adds invite-only sign-in (email link, Google, Microsoft) and syncs each person's progress
through Supabase (project `exam-simulator`). It's off until `AUTH_ENABLED` is set to `true`.

- Invites live in `public.invited_emails`; a Postgres "Before User Created" auth hook (`public.hook_invite_only`)
  rejects anyone not on the list. Admins can add or remove invites from the home page.
- Progress is stored per user and exam in `public.progress`, protected by row-level security.
- OAuth buttons are listed in `PROVIDERS` in `js/auth.js`; enable each provider in the Supabase dashboard first.
