# Recording course narration (Andrew voice)

Every video lesson on the site uses the same prerecorded voice: Azure Speech's standard Neural voice **Andrew** (`en-US-AndrewNeural`). The recordings are made on your computer with your own Azure Speech key; the key is read from the terminal and never written to a file or the repository.

## Requirements

- Node.js 18 or newer
- An Azure Speech resource on the **Free F0** tier (about 500,000 characters of Neural speech a month; a whole course is roughly 10,000–30,000 characters)
- The resource key and region (for example, `eastus`)

## Record on GitHub (automatic)

The **Record narration** workflow (`.github/workflows/narration.yml`) records on GitHub, so nothing needs to run on your computer:

1. In the repository on GitHub, open **Settings → Secrets and variables → Actions → New repository secret**.
2. Add `AZURE_SPEECH_KEY` (your key) and `AZURE_SPEECH_REGION` (for example `eastus`).
3. Open **Actions → Record narration → Run workflow** to record now (otherwise it runs within a day).

After that it runs by itself whenever a `learn.json` changes on `main` (and once a day as a catch-up), records only new or changed modules, and commits the MP3s; Vercel then redeploys. Without the secrets it skips quietly.

## Record on your computer (PowerShell)

From the repository folder, get the latest version first, then set the key for this window only:

```powershell
git pull
$env:AZURE_SPEECH_KEY = "your-key"
$env:AZURE_SPEECH_REGION = "eastus"
npm run speech
```

`npm run speech` records every course that has a `learn.json`, skipping modules that already have audio for their current script. Other forms:

```powershell
npm run speech -- a-plus-core1   # just one course (or several, separated by spaces)
npm run speech -- --force        # re-record everything, e.g. after changing the voice
```

To use another standard Neural voice, set `$env:AZURE_SPEECH_VOICE = "en-US-AvaNeural"` before running (this re-records all modules). Don't choose an HD voice if you want to stay within the free tier.

## What it changes

- `exams/<course>/media/<module>.mp3`: one recording per module
- `exams/<course>/media/narration.json`: which script each recording was made from, so unchanged modules are skipped next time
- `exams/<course>/learn.json`: gains a `"narration"` block once every module has audio, which switches that course's videos from the browser's voice to the recording

Then commit and push those files (for example `git add exams` then `git commit -m "Record narration"` then `git push`). The site updates when Vercel finishes deploying.

## When to re-run

Run `npm run speech` after adding a new learning path or editing any slide's `script` lines; only the new or changed modules are recorded.
