// Plain Node, not tsx: this runs as part of `npm run build`, which fires from
// `prepare` during a git-based install - keeping it dependency-free avoids
// any ordering question about whether devDependencies are ready yet.
//
// inventory.ts locates collect-elements.js relative to its own compiled
// location at runtime (import.meta.url). Once compiled to dist/inventory.js,
// that resolves to dist/browser/collect-elements.js - which only exists if
// this copies it there, since tsc does not touch non-.ts files.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'src', 'browser');
const dest = join(root, 'dist', 'browser');

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true, filter: (p) => !p.endsWith('.ts') });

console.log(`Copied ${src} -> ${dest}`);
