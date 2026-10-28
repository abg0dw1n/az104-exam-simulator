// Renders narrated video lessons for every course with Azure Speech, so all courses use the
// same prerecorded voice (default: Andrew, en-US-AndrewNeural, a standard Neural voice).
//
//   npm run speech                 # every course that has exams/<slug>/learn.json
//   npm run speech -- a-plus-core1 # one or more courses by folder name
//   npm run speech -- --force      # re-record modules even if their script hasn't changed
//
// Needs AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in the environment (never written to disk).
// Writes exams/<slug>/media/<module>.mp3, records what was rendered in media/narration.json
// (so unchanged modules are skipped next time), and adds the "narration" block to learn.json
// once every module of a course has audio, which switches the site from the browser's voice
// to the recording.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examsDir = path.join(root, 'exams');
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));

const key = process.env.AZURE_SPEECH_KEY;
const region = process.env.AZURE_SPEECH_REGION;
const voice = process.env.AZURE_SPEECH_VOICE || 'en-US-AndrewNeural';
if (!key || !region) {
  console.error('Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in this terminal first (see docs/azure-speech.md).');
  process.exit(1);
}
// "en-US-AndrewNeural" -> "Andrew (standard Neural)"
const credit = `${voice.replace(/^[a-z]{2}-[A-Z]{2}-/, '').replace(/Neural$/, '')} (standard Neural)`;

const xmlEscape = (v) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const narrationOf = (module) => (module.slides || [])
  .flatMap((slide) => (Array.isArray(slide.script) ? slide.script : []))
  .map((line) => line.trim())
  .filter(Boolean);

async function synthesize(lines) {
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${xmlEscape(voice)}">${lines.map((l) => `<p>${xmlEscape(l)}</p>`).join('')}</voice></speak>`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'it-study-hall-narration',
      },
      body: ssml,
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status === 429 && attempt < 5) { await sleep(15000 * attempt); continue; } // free-tier rate limit
    throw new Error(`Azure Speech failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}

const slugs = only.length ? only : (await readdir(examsDir, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && existsSync(path.join(examsDir, d.name, 'learn.json')))
  .map((d) => d.name);

let rendered = 0;
for (const slug of slugs) {
  const learnPath = path.join(examsDir, slug, 'learn.json');
  if (!existsSync(learnPath)) { console.warn(`Skipping ${slug}: no learn.json`); continue; }
  const lesson = JSON.parse(await readFile(learnPath, 'utf8'));
  const mediaDir = path.join(examsDir, slug, 'media');
  const manifestPath = path.join(mediaDir, 'narration.json');
  await mkdir(mediaDir, { recursive: true });
  const manifest = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : { voice, modules: {} };
  if (manifest.voice !== voice) manifest.modules = {}; // a different voice re-records everything
  manifest.voice = voice;

  let complete = true;
  for (const module of lesson.modules || []) {
    const lines = narrationOf(module);
    if (!lines.length) { console.warn(`${slug} ${module.id}: no narration script, skipped`); complete = false; continue; }
    const hash = createHash('sha256').update(`${voice}\n${lines.join('\n')}`).digest('hex').slice(0, 16);
    const mp3 = path.join(mediaDir, `${module.id}.mp3`);
    // Audio recorded before this manifest existed is treated as current unless --force.
    if (!force && existsSync(mp3) && !manifest.modules[module.id]) manifest.modules[module.id] = hash;
    if (!force && existsSync(mp3) && manifest.modules[module.id] === hash) {
      console.log(`${slug} ${module.id}: up to date`);
      continue;
    }
    process.stdout.write(`${slug} ${module.id}: recording ${lines.length} lines... `);
    await writeFile(mp3, await synthesize(lines));
    manifest.modules[module.id] = hash;
    rendered++;
    console.log('done');
    await sleep(1500);
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  if (complete) {
    const narration = { src: 'media/{id}.mp3', credit };
    if (JSON.stringify(lesson.narration) !== JSON.stringify(narration)) {
      // Put "narration" right after "intro", keeping the other keys in order.
      const out = {};
      for (const [k, v] of Object.entries(lesson)) {
        if (k === 'narration') continue;
        out[k] = v;
        if (k === 'intro') out.narration = narration;
      }
      if (!out.narration) out.narration = narration;
      await writeFile(learnPath, JSON.stringify(out, null, 2) + '\n');
      console.log(`${slug}: learn.json now uses the recorded narration`);
    }
  } else {
    console.warn(`${slug}: not every module has audio, so the site keeps the browser voice for this course`);
  }
}
console.log(`Done. Voice: ${voice}. Recorded ${rendered} module(s). No key was written to disk.`);
