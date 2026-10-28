import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const lessonPath = path.join(repoRoot, 'exams', 'az-104', 'learn.json');
const outputDir = path.join(repoRoot, 'exams', 'az-104', 'media');

const key = process.env.AZURE_SPEECH_KEY;
const region = process.env.AZURE_SPEECH_REGION;
const voice = process.env.AZURE_SPEECH_VOICE || 'en-US-AndrewNeural';

if (!key || !region) {
  console.error('Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in this PowerShell window first.');
  process.exit(1);
}

const lesson = JSON.parse(await readFile(lessonPath, 'utf8'));
const modules = lesson.modules || [];
if (!modules.length) {
  throw new Error(`No modules found in ${path.relative(repoRoot, lessonPath)}`);
}

function xmlEscape(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

await mkdir(outputDir, { recursive: true });

for (const module of modules) {
  const narration = (module.slides || [])
    .flatMap((slide) => Array.isArray(slide.script) ? slide.script : [])
    .map((line) => line.trim())
    .filter(Boolean);

  if (!narration.length) {
    console.warn(`Skipping ${module.id}: no slide narration found.`);
    continue;
  }

  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${xmlEscape(voice)}">${narration.map((line) => `<p>${xmlEscape(line)}</p>`).join('')}</voice></speak>`;
  const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'az104-exam-simulator-local-renderer',
    },
    body: ssml,
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Azure Speech failed for ${module.id} (${response.status}): ${detail}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  const outputPath = path.join(outputDir, `${module.id}.mp3`);
  await writeFile(outputPath, audio);
  console.log(`Rendered ${module.id}: ${path.relative(repoRoot, outputPath)}`);
}

console.log(`Done. Voice: ${voice}. Generated files are local MP3s; no key was written to disk.`);
