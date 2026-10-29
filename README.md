# The IT Study Hall

Learning paths, practice questions and timed exams for IT, Linux and healthcare administration certifications, live at **The IT Study Hall**, https://it-study-hall.vercel.app
(the older it-learn-and-practice, it-exam-simulator and az104-exam-simulator-drab `.vercel.app` addresses forward there; see `redirects` in `vercel.json`). Currently includes:

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
| AAPC Certified Professional Coder (CPC) | `exams/cpc` | 152 | 70% to pass (real exam is open-book) |
| NHA Certified Billing and Coding Specialist (CBCS) · beginner | `exams/cbcs` | 106 | 390 on 200–500 to pass |
| NHA Certified Medical Administrative Assistant (CMAA) · beginner | `exams/cmaa` | 109 | 390 on 200–500 to pass |
| LPI Linux Essentials (010-200) · beginner | `exams/linux-essentials` | 110 | 500 on 200–800 to pass |
| CompTIA Linux+ (XK0-006) · intermediate | `exams/linux-plus` | 148 | 720 on 100–900 to pass |
| Red Hat RHCSA (EX200, RHEL 10) · advanced | `exams/rhcsa` | 106 | 210 of 300 to pass (real exam is hands-on) |

Open the site to pick an exam, or go straight to one at `/<folder>` (e.g. `/az-104`, `/network-plus`, `/security-plus`, `/ccna`, `/aws-saa`, `/ai-901`, `/aws-aif`, `/google-gail`, `/cpc`, `/cbcs`, `/cmaa`, `/linux-essentials`, `/linux-plus`, `/rhcsa`). Each exam keeps its own progress and history.

## Modes

- **Practice** – answer at your own pace. Each answer is checked instantly, with an explanation and a note on why every other option is wrong.
  - Questions are shuffled by default (switch Order to "In order" if you prefer); **Reshuffle** re-randomizes question order and answer letters.
  - **Try again** (or `R`) clears a question and reshuffles its options; **Retry missed** re-drills everything you got wrong.
  - Filter by domain, or show only unanswered, incorrect, or flagged questions. The list stays put while you answer.
- **Exam** – pick how many questions you want. Questions are drawn in proportion to the exam's official domain weights, preferring ones you've seen least, so a big bank rotates instead of repeating. Timer, shuffled questions and options, no feedback until you submit. Results show a scaled score, a domain breakdown with "Practice this domain" links, and recent attempts. Afterwards you can review missed questions or all questions.

- **Learn** – training content for exams that have it (AZ-104, A+ Core 1, and A+ Core 2). One module per exam domain, each with:
  - a **study guide** (sections, exam tips, key terms, and a link to practice that domain),
  - a **slideshow** (arrow keys, speaker notes, full screen), and
  - a **video lesson**: the slides animate with prerecorded narration in Azure Speech's Andrew voice, with captions. Record a new or edited course with `npm run speech` (see `docs/azure-speech.md`); until a course is recorded it falls back to the device's built-in voice.

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

For every new learning path, include at least one free, exam-specific YouTube video or playlist when one is available. Verify that it targets the active exam code/version and compare its topics with the current official exam objectives. Add the video link to `sources` with a short note stating its format, exam version, and the date you checked it. Do not link an older version as if it were current; if no current video can be verified, leave it out and say so.

```jsonc
{
  "intro": "One line shown above the modules",
  "narration": { "src": "media/{id}.mp3", "credit": "Andrew (standard Neural)" },  // optional: prerecorded audio per module
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

CPT is a registered trademark of the American Medical Association. The CPC, CBCS and CMAA banks and lessons paraphrase CPT concepts in their own words and don't reproduce CPT code descriptors.

Visual types: `flow` (`steps`), `tree` (`levels`: array of rows), `cards` (`items` of `{t, d}`), `table` (`head`, `rows`), `code` (`lang`, `text`), `layers` (`items`, top to bottom). Video length is roughly script words ÷ 150 minutes.

## Labs (hands-on simulations)

Create `exams/<folder>/labs.json` and a **Labs** tab appears for that exam (signed-in users only; guests see a preview list). Labs run entirely in the browser and are graded by checking the simulated state, so there's no backend or cloud cost. Code: `js/labs.js` (UI, grading), `js/labs-ios.js` (Cisco IOS-style CLI), `js/labs-win.js` (Windows command prompt), `js/labs-linux.js` (Linux shell with users, permissions, systemctl, apt and ufw), `js/labs-az.js` (Azure CLI / Cloud Shell), `js/labs-net.js` (network model: VLANs, trunks, subinterfaces, static routes, OSPF, standard ACLs, ping/traceroute).

Three kinds of lab:

- `cli`: `devices` (`platform`: `ios` router/switch, `windows`, or `host`), `links` (`["R1 g0/0", "SW1 g0/1"]`), optional `topology.nodes` (grid `x`/`y` for the diagram). IOS devices take `interfaces` and an optional starting `state`; Windows PCs take an `adapter` and a `network` model (subnet, gateway, DHCP, DNS servers, records, reachable hosts).
- `tasks`: `activities` of type `match` (drag items into categories), `order`, `fill` (accepted answers), or `rules` (ordered firewall rules graded against test packets).
- `portal`: a generic admin console (`portal.pages` with `sections`/`fields` and editable `tables`); only saved values count.

Every lab has `tasks: [{ text, check }]`. Checks include `{dev, path, eq|ne|in|re|minLen|exists|nonEmpty}`, `{iface: "SW1 f0/1", is: {mode, accessVlan, up, ...}}`, `{ping: [from, to], expect}`, `{route: [dev, "10.0.0.0/24"], code}`, `{ospfNbr: [a, b]}`, `{saved: dev}`, `{ran: [dev, regex]}`, `{sshReady: dev}`, `{lookup: [pc, name]}`, `{q: id, eq}` (with `questions`), `{activity: n}`, `{field: "page.field", ...}`, `{rows: "page.table", has|none|count}`, `{file: [dev, path], mode|owner|group|contains|notContains}`, `{items: [dev, path], has|none|count}`, `{before: [dev, path, A, B]}` (an item matching A comes before one matching B, e.g. firewall rule order), combined with `all`/`any`/`not`. Optional: `hints`, `solution` (shown after a first check), `review`.

Current labs: Network+ (8), CCNA (8), A+ Core 1 (6), A+ Core 2 (6), Security+ (6) and AZ-104 (7). Device platforms for CLI labs: `ios`, `windows`, `linux`, `az`. `scripts/stamp-updated.mjs` records the lab count in `exams/index.json`.

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

## "Updated" dates and question counts

`updated` in `exams/index.json` records when each exam's files last changed.
After committing question changes, run `node scripts/stamp-updated.mjs` and commit `exams/index.json`. It also records each bank's question count (`"questions"`), which the home page shows without downloading every bank; `validate-questions.mjs` fails if a count is out of date.

## Admins

Admins have a flag in `invited_emails`. They see an "Admin" badge on the header Account button and get the admin panels on the Account page. In **People and admins** an admin can make any invited person an admin or remove admin access (via the `set_admin()` database function, which refuses removing your own admin role or the last admin).

## Access requests

When someone who isn't invited tries to sign in (email link, Google or Microsoft), the invite-only hook still refuses them but records an access request in `access_requests` and tells them it was sent to the site owner. Admins approve or deny requests on the Account page (`/account#requests`); approving adds the email to `invited_emails` and emails them a sign-in link.

Admins are also emailed about each new request through [Resend](https://resend.com) once a key is stored in Supabase Vault (capped at 20 emails a day; without a key, requests only appear on the Account page). To turn it on, create a free Resend account with the admin email address, create an API key, and run this once in the Supabase SQL editor:

```sql
select vault.create_secret('re_your_key_here', 'resend_api_key');
```

## Feature requests

Signed-in users can suggest site features from the home page ("Have an idea for the site?") or the Account page. Requests go to the `feature_requests` table: people see only their own, with its status (Submitted, Planned, In progress, Done, Not planned) and any note from the site owner; admins see everyone's on the Account page and update status/notes there. Limited to 10 requests per person per day.

## Light and dark mode

The theme is Monokai Pro (dark) with Monokai Pro Light. The sun/moon button in the header switches between them, and the Account page has System / Light / Dark. The choice is saved per device (`itsh:theme` in localStorage, kept on sign-out); by default the site follows the device setting. `js/theme.js` runs in `<head>` so the right theme is applied before the page draws. Colors live in the `:root` and `:root[data-theme="light"]` blocks at the top of `css/styles.css`.

## Guest mode

The sign-in screen has **Continue as guest**. Guests get a preview: a fixed sample of 20 practice questions per exam (spread across domains by weight, `GUEST_QUESTIONS` in `js/app.js`), the first module of each learning path, and no timed exams, question reports or feature requests. Locked content shows a sign-in prompt. This is a client-side limit (the question files themselves are public). Nothing is saved to an account: progress is kept in `sessionStorage` for that tab only and is cleared when the tab closes. A banner reminds guests of this, with a link to sign in (which discards the guest progress). Guests can read the Most popular ranking but don't add views.

## Home page: Recents and Most popular

- **Recents** lists the exams a signed-in person has started (learning parts completed, practice questions answered, timed exams), most recently opened first. New users see the learning paths instead.
- **Most popular** is an open folder above the vendor folders (which start collapsed). It ranks exams by views from all users over the last 30 days. Opening an exam page logs an anonymous view (exam slug + time, no user id; at most once an hour per exam per device) to the `exam_views` table; the `popular_exams()` function returns only aggregated counts. The folder is hidden until there are views.

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
