/**
 * Side-effect module: load `.env.local` into process.env.
 *
 * Standalone `tsx` scripts don't get Next.js's automatic .env loading, and
 * `lib/mongodb.ts` reads process.env.MONGODB_URI at import time (falling back to
 * localhost). So this MUST be imported BEFORE any module that touches env:
 *
 *     import './load-env';               // first — populates process.env
 *     import { runAllScrapers } from '../lib/scrapers';
 *
 * ESM evaluates imports depth-first in source order, so this runs before the
 * lib graph is evaluated. Existing process.env values are NOT overwritten, so
 * real shell/CI env vars (e.g. GitHub Actions secrets) take precedence.
 */
import * as fs from 'fs';
import * as path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      if (process.env[key] === undefined) {
        // Strip surrounding quotes if present.
        process.env[key] = match[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
}
