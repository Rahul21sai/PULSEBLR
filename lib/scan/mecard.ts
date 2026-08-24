/**
 * MECARD parsing.
 *
 *     MECARD:N:Doe,John;TEL:13035551212;EMAIL:john.doe@example.com;;
 *
 * A compact contact format that predates widespread vCard support and is still emitted
 * by some Android and Japanese-lineage QR generators.
 *
 * Three differences from vCard that a shared parser would get wrong:
 *
 *   1. `N` is `last,first` — ZXing detects the comma and swaps to "first last".
 *   2. `ADR` components are COMMA-separated, not semicolon-separated.
 *   3. Fields are `;`-delimited and the payload is terminated by `;;`.
 *
 * There is no specification. Wikipedia states this outright: no ISO document, no RFC.
 * So the parser is deliberately lenient — in particular it never rejects a payload for
 * a missing `;;` terminator, because plenty of generators omit it.
 *
 * Following ZXing, only TEL / EMAIL / URL / ADR are collected as repeatable; for every
 * other key the first occurrence wins.
 */
import type { ParsedPerson } from './types';
import { splitUnescaped } from './vcard';

const REPEATABLE = new Set(['TEL', 'EMAIL', 'URL', 'ADR']);

export function looksLikeMeCard(raw: string): boolean {
  return /^[\s﻿]*MECARD\s*:/i.test(raw);
}

export function parseMeCard(raw: string): ParsedPerson | null {
  const body = raw.replace(/^[\s﻿]*MECARD\s*:/i, '');
  if (!body.trim()) return null;

  const fields = new Map<string, string[]>();

  for (const field of splitUnescaped(body, ';')) {
    if (!field.trim()) continue;
    const colon = indexOfUnescaped(field, ':');
    if (colon === -1) continue;

    const key = field.slice(0, colon).trim().toUpperCase();
    const value = unescapeMeCard(field.slice(colon + 1)).trim();
    if (!key || !value) continue;

    const existing = fields.get(key);
    if (!existing) fields.set(key, [value]);
    else if (REPEATABLE.has(key)) existing.push(value);
    // else: first occurrence wins, matching ZXing.
  }

  if (!fields.size) return null;

  const person: ParsedPerson = {};

  const n = fields.get('N')?.[0];
  if (n) person.name = formatMeCardName(n);
  if (!person.name) {
    const nickname = fields.get('NICKNAME')?.[0];
    if (nickname) person.name = nickname;
  }

  const org = fields.get('ORG')?.[0];
  if (org) person.company = org;

  const tel = fields.get('TEL')?.[0];
  if (tel) person.phone = tel;

  const email = fields.get('EMAIL')?.[0];
  if (email) person.email = email;

  const note = fields.get('NOTE')?.[0];
  if (note) person.note = note;

  // URLs are classified by the caller, which already owns the host-matching rules.
  const urls = fields.get('URL');
  if (urls?.length) person.website = urls[0];

  const hasAnything = person.name || person.email || person.phone || person.website;
  return hasAnything ? person : null;
}

/** Every URL in the payload, so the caller can classify each one. */
export function meCardUrls(raw: string): string[] {
  const body = raw.replace(/^[\s﻿]*MECARD\s*:/i, '');
  const out: string[] = [];
  for (const field of splitUnescaped(body, ';')) {
    const colon = indexOfUnescaped(field, ':');
    if (colon === -1) continue;
    if (field.slice(0, colon).trim().toUpperCase() !== 'URL') continue;
    const value = unescapeMeCard(field.slice(colon + 1)).trim();
    if (value) out.push(value);
  }
  return out;
}

/** `Doe,John` → `John Doe`. No comma means the value is already display-ordered. */
function formatMeCardName(value: string): string {
  const parts = splitUnescaped(value, ',').map(p => unescapeMeCard(p).trim());
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return `${parts[1]} ${parts[0]}`.replace(/\s+/g, ' ').trim();
  }
  return value.replace(/\s+/g, ' ').trim();
}

function indexOfUnescaped(value: string, needle: string): number {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\') {
      i++;
      continue;
    }
    if (value[i] === needle) return i;
  }
  return -1;
}

function unescapeMeCard(value: string): string {
  return value.replace(/\\([\\;:,])/g, '$1');
}
