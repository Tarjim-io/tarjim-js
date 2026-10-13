// Prints the subresource-integrity value for a file: node scripts/sri.mjs <file>
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/sri.mjs <file>');
  process.exit(2);
}
console.log(`sha384-${createHash('sha384').update(readFileSync(file)).digest('base64')}`);
