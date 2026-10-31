#!/usr/bin/env node
// Validate exam JSON files against their schemas
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = join(dirname(fileURLToPath(import.meta.url)), '..');

// Simple JSON Schema validator (no external dependencies)
async function validate(instance, schema) {
  const errors = [];

  if (schema.type) {
    const actualType = Array.isArray(instance) ? 'array' : typeof instance;
    if (actualType !== schema.type) {
      errors.push(`Expected ${schema.type}, got ${actualType}`);
      return errors;
    }
  }

  if (schema.required && typeof instance === 'object' && instance !== null) {
    for (const prop of schema.required) {
      if (!(prop in instance)) {
        errors.push(`Missing required property: ${prop}`);
      }
    }
  }

  if (schema.properties && typeof instance === 'object' && instance !== null) {
    for (const [key, value] of Object.entries(instance)) {
      if (schema.properties[key]) {
        const subErrors = await validate(value, schema.properties[key]);
        errors.push(...subErrors.map(e => `${key}.${e}`));
      }
    }
  }

  if (schema.items && Array.isArray(instance)) {
    for (let i = 0; i < instance.length; i++) {
      const subErrors = await validate(instance[i], schema.items);
      errors.push(...subErrors.map(e => `[${i}].${e}`));
    }
  }

  return errors;
}

async function main() {
  const examsDir = join(__dirname, 'exams');
  const examFolders = readdirSync(examsDir).filter(f =>
    !f.startsWith('.') && !f.includes('.') && readdirSync(join(examsDir, f)).length > 0
  );

  let totalErrors = 0;
  let filesChecked = 0;

  for (const folder of examFolders) {
    const folderPath = join(examsDir, folder);
    const files = readdirSync(folderPath);

    // Check exam.json
    if (files.includes('exam.json')) {
      filesChecked++;
      try {
        const data = JSON.parse(readFileSync(join(folderPath, 'exam.json'), 'utf8'));
        const schema = JSON.parse(readFileSync(join(__dirname, 'schemas', 'exam.schema.json'), 'utf8'));
        const errors = await validate(data, schema);
        if (errors.length > 0) {
          console.error(`❌ ${folder}/exam.json: ${errors.join(', ')}`);
          totalErrors++;
        }
      } catch (e) {
        console.error(`❌ ${folder}/exam.json: parse error - ${e.message}`);
        totalErrors++;
      }
    }

    // Check questions.json
    if (files.includes('questions.json')) {
      filesChecked++;
      try {
        const data = JSON.parse(readFileSync(join(folderPath, 'questions.json'), 'utf8'));
        const schema = JSON.parse(readFileSync(join(__dirname, 'schemas', 'questions.schema.json'), 'utf8'));
        const errors = await validate(data, schema);
        if (errors.length > 0) {
          console.error(`❌ ${folder}/questions.json: ${errors.slice(0, 3).join(', ')}`);
          totalErrors++;
        }
      } catch (e) {
        console.error(`❌ ${folder}/questions.json: parse error - ${e.message}`);
        totalErrors++;
      }
    }

    // Check learn.json
    if (files.includes('learn.json')) {
      filesChecked++;
      try {
        const data = JSON.parse(readFileSync(join(folderPath, 'learn.json'), 'utf8'));
        const schema = JSON.parse(readFileSync(join(__dirname, 'schemas', 'learn.schema.json'), 'utf8'));
        const errors = await validate(data, schema);
        if (errors.length > 0) {
          console.error(`❌ ${folder}/learn.json: ${errors.join(', ')}`);
          totalErrors++;
        }
      } catch (e) {
        console.error(`❌ ${folder}/learn.json: parse error - ${e.message}`);
        totalErrors++;
      }
    }

    // Check labs.json
    if (files.includes('labs.json')) {
      filesChecked++;
      try {
        const data = JSON.parse(readFileSync(join(folderPath, 'labs.json'), 'utf8'));
        const schema = JSON.parse(readFileSync(join(__dirname, 'schemas', 'labs.schema.json'), 'utf8'));
        const errors = await validate(data, schema);
        if (errors.length > 0) {
          console.error(`❌ ${folder}/labs.json: ${errors.slice(0, 3).join(', ')}`);
          totalErrors++;
        }
      } catch (e) {
        console.error(`❌ ${folder}/labs.json: parse error - ${e.message}`);
        totalErrors++;
      }
    }
  }

  console.log(`\n✓ Validated ${filesChecked} JSON files across ${examFolders.length} exams`);
  if (totalErrors > 0) {
    console.log(`❌ Found ${totalErrors} validation error(s)`);
    process.exit(1);
  } else {
    console.log('✓ All files pass basic validation');
  }
}

main().catch(e => { console.error(e); process.exit(1); });