# AZ-104 Exam Simulator

Practice and timed-exam simulator for the Microsoft Azure Administrator (AZ-104) certification.

## Modes

- **Practice** – answer at your own pace. Each answer is checked instantly, with an explanation and a note on why every other option is wrong. Filter by domain, or show only unanswered, incorrect, or flagged questions.
- **Exam** – 45 questions, 100-minute timer, shuffled questions and options, no feedback until you submit. Results show a scaled score (700 to pass), a domain breakdown and your recent attempts. Afterwards you can review missed questions or all questions.

Progress, flags, and exam history are saved in your browser (localStorage), and the exam timer survives refreshes.

**Keyboard:** `A`–`D` (or `1`–`4`) answer · `←` `→` navigate · `F` flag.

## Project structure

```
index.html              page shell + inline SVG icons
css/styles.css          all styles (no CSS framework at runtime)
js/app.js               app logic (state, rendering, timer)
js/questions.js         question bank and domain list
scripts/validate-questions.mjs   sanity checks for the question bank
vercel.json             caching + security headers
```

It is a static site with no build step and no dependencies.

## Run locally

```bash
python3 -m http.server 4173   # or: npx serve .
# open http://localhost:4173
```

## Add or edit questions

Edit `js/questions.js`. Each question looks like:

```js
{
  id: 46, domain: 'D2',
  scenario: 'Question text (HTML allowed, e.g. <code>name</code>)',
  code: null,                      // optional code/JSON/KQL snippet (shown as plain text)
  options: [
    { text: 'Option text', note: 'Why this is wrong (shown after answering)' },
    { text: 'Correct option', note: '' },
  ],
  answer: 1,                       // index of the correct option above
  explanation: 'Why the correct answer is right.',
}
```

Then run `node scripts/validate-questions.mjs`. Options are shuffled at runtime, so explanations should describe options by content, not by letter.

## Deploy

Hosted on Vercel; every push to `main` deploys automatically. No build settings needed (Framework preset: **Other**).
