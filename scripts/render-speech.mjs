// Renders narrated video lessons for every course with Azure Speech, so all courses use the
// same prerecorded voice (default: Andrew, en-US-AndrewNeural, a standard Neural voice).
//
//   npm run speech                 # every course that has exams/<slug>/learn.json
//   npm run speech -- a-plus-core1 # one or more courses by folder name
//   npm run speech -- --force      # re-record modules even if their script hasn't changed
//
// Needs AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in the environment (never written to disk).
// Writes one clip per slide, exams/<slug>/media/<module>-<n>.mp3 (n = slide number), records
// what was rendered in media/narration.json (so unchanged slides are skipped next time), and
// adds the "narration" block to learn.json once every slide of a course has audio, which
// switches the site from the browser's voice to the recording. Separate clips let the player
// change slides exactly when the narration does, with a short pause in between.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
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
// The lines spoken for a slide: its script, or its title if it has none (same as the player).
const linesOf = (slide) => {
  const lines = (Array.isArray(slide.script) ? slide.script : []).map((l) => String(l).trim()).filter(Boolean);
  return lines.length ? lines : [String(slide.title || '').trim()].filter(Boolean);
};

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
  const manifest = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : { voice, slides: {} };
  if (manifest.voice !== voice || !manifest.slides) { manifest.slides = {}; delete manifest.modules; } // new voice or old per-module format: re-record
  manifest.voice = voice;

  let complete = true;
  const keep = new Set(['narration.json']);
  for (const module of lesson.modules || []) {
    for (const [i, slide] of (module.slides || []).entries()) {
      const lines = linesOf(slide); const name = `${module.id}-${i + 1}`;
      if (!lines.length) { console.warn(`${slug} ${name}: nothing to narrate, skipped`); complete = false; continue; }
      const file = `${name}.mp3`; keep.add(file);
      const hash = createHash('sha256').update(`${voice}\n${lines.join('\n')}`).digest('hex').slice(0, 16);
      const mp3 = path.join(mediaDir, file);
      if (!force && existsSync(mp3) && manifest.slides[name] === hash) continue;
      process.stdout.write(`${slug} ${name}: recording ${lines.length} line(s)... `);
      await writeFile(mp3, await synthesize(lines));
      manifest.slides[name] = hash;
      rendered++;
      console.log('done');
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n'); // save progress as we go
      await sleep(3200); // free tier allows about 20 requests a minute
    }
  }
  // Remove clips for slides that no longer exist, and the old one-file-per-module recordings.
  for (const f of await readdir(mediaDir)) if (f.endsWith('.mp3') && !keep.has(f)) { await unlink(path.join(mediaDir, f)); delete manifest.slides[f.replace(/\.mp3$/, '')]; }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  if (complete) {
    const narration = { src: 'media/{id}-{n}.mp3', perSlide: true, credit };
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
    console.warn(`${slug}: not every slide has audio, so the site keeps the browser voice for this course`);
  }
}
console.log(`Done. Voice: ${voice}. Recorded ${rendered} slide(s). No key was written to disk.`);
