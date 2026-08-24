/**
 * vCard parsing, for the QR codes that carry a full contact rather than a profile link.
 *
 * A vCard is the richest payload you can be handed: unlike a LinkedIn QR it can include
 * a phone number and an employer, so it fills the capture card without you asking.
 *
 * Modelled on ZXing's `VCardResultParser`, which is the reference implementation every
 * phone camera effectively behaves like. The traps below are the reason this is 200
 * lines rather than a `split('\n')` — each one silently corrupts or truncates data
 * rather than failing loudly:
 *
 *   1. UNFOLD BEFORE PARSING. A line beginning with space or tab continues the previous
 *      one. vCard 2.1 permits MULTIPLE leading whitespace characters, 3.0/4.0 exactly
 *      one, and real payloads use bare \n or bare \r as line endings.
 *
 *   2. QUOTED-PRINTABLE SOFT LINE BREAKS. In vCard 2.1 — still emitted by older Android
 *      and Nokia-lineage generators — a property may be ENCODING=QUOTED-PRINTABLE, and
 *      a trailing `=` is a soft line break, NOT part of the value. Unfolding on
 *      whitespace alone truncates the value at the first wrap.
 *
 *   3. SPLIT COMPOUND VALUES ON UNESCAPED SEMICOLONS ONLY. `ORG:ABC\, Inc.;North
 *      American Division` has an escaped comma; `N` may contain an escaped semicolon.
 *      A naive split(';') mangles both. We scan honouring backslash escapes rather than
 *      using a `(?<!\\);` lookbehind, because the lookbehind is itself wrong for the
 *      `a\\;b` case (escaped backslash followed by a real delimiter).
 *
 *   4. APPLE GROUPED PROPERTIES. iOS Contacts emits `item1.URL:https://…` paired with
 *      `item1.X-ABLabel:LinkedIn`. Without stripping the `group.` prefix the property
 *      name is unrecognisable and the URL is dropped on the floor.
 *
 *   5. CASE-INSENSITIVITY. Property names, parameter names AND parameter values are all
 *      case-insensitive.
 *
 *   6. CHARSET. Decode QUOTED-PRINTABLE bytes with the declared charset and fall back
 *      to UTF-8 on failure. CHARSET=SHIFT_JIS still turns up.
 *
 * Scope is deliberately ZXing's field set — FN, N, NICKNAME, TEL, EMAIL, NOTE, ORG,
 * TITLE, ROLE, URL, IMPP — plus the social-profile properties. PHOTO is skipped: a QR
 * caps at ~2,953 bytes, so a photo-bearing vCard does not fit in one anyway.
 */
import type { ParsedPerson } from './types';
import { classifyUrlInto } from './urls';

interface VLine {
  name: string;
  group?: string;
  params: Map<string, string[]>;
  /** Decoded and charset-corrected, but NOT yet unescaped or split. */
  value: string;
}

/** True when the payload looks like a vCard at all. Tolerates a BOM and leading space. */
export function looksLikeVCard(raw: string): boolean {
  return /^[\s﻿]*BEGIN\s*:\s*VCARD/i.test(raw);
}

/**
 * Parse a vCard into the fields the capture card needs.
 *
 * Returns null when the payload yields nothing usable, so the caller can fall through
 * to treating it as plain text rather than storing an empty contact.
 */
export function parseVCard(raw: string): ParsedPerson | null {
  const lines = unfold(raw);
  if (!lines.length) return null;

  const single = new Map<string, string>();
  const tel: VLine[] = [];
  const email: VLine[] = [];
  const urls: VLine[] = [];
  const social: VLine[] = [];
  /** Apple's `item1.X-ABLabel` → the label for the property in that group. */
  const labels = new Map<string, string>();

  for (const line of lines) {
    switch (line.name) {
      case 'tel':
        tel.push(line);
        break;
      case 'email':
        email.push(line);
        break;
      case 'url':
      case 'impp':
        urls.push(line);
        break;
      case 'socialprofile':
      case 'x-socialprofile':
        social.push(line);
        break;
      case 'x-ablabel':
        if (line.group) labels.set(line.group, unescapeValue(line.value).toLowerCase());
        break;
      default:
        // First occurrence wins, matching ZXing.
        if (!single.has(line.name)) single.set(line.name, line.value);
    }
  }

  const person: ParsedPerson = {};

  /* ── Name ──────────────────────────────────────────────────────────────────
     FN is required in 3.0/4.0 and is the display form, so prefer it. N is required in
     2.1 and optional in 4.0; its five components are
     family;given;additional;prefixes;suffixes. Prefixes and suffixes ("Mr.", "Esq.")
     are dropped — they are noise in a contact list. */
  const fn = single.get('fn');
  if (fn) person.name = collapse(unescapeValue(fn));
  if (!person.name && single.has('n')) {
    const [family, given, additional] = splitUnescaped(single.get('n')!, ';').map(c =>
      collapse(unescapeValue(c))
    );
    person.name = collapse([given, additional, family].filter(Boolean).join(' '));
  }
  if (!person.name && single.has('nickname')) {
    person.name = collapse(unescapeValue(splitUnescaped(single.get('nickname')!, ',')[0] ?? ''));
  }

  /* ── Employer and role ──────────────────────────────────────────────────
     ORG is semicolon-separated: organisation name, then organisational units. For a
     contact tracker only component 0 is the company. */
  if (single.has('org')) {
    const org = collapse(unescapeValue(splitUnescaped(single.get('org')!, ';')[0] ?? ''));
    if (org) person.company = org;
  }
  const title = single.get('title') ?? single.get('role');
  if (title) person.role = collapse(unescapeValue(title));

  if (single.has('note')) {
    const note = collapse(unescapeValue(single.get('note')!));
    if (note) person.note = note;
  }

  /* ── Phone and email: preference-aware, because cardinality is unbounded ── */
  const bestTel = pickPreferred(tel, ['cell', 'mobile', 'voice']);
  if (bestTel) {
    const value = collapse(unescapeValue(bestTel.value)).replace(/^tel:/i, '');
    if (value) person.phone = value;
  }
  const bestEmail = pickPreferred(email, ['internet', 'work', 'home']);
  if (bestEmail) {
    const value = collapse(unescapeValue(bestEmail.value)).replace(/^mailto:/i, '');
    if (value) person.email = value;
  }

  /* ── URLs: classify by HOST, which beats trusting a label ─────────────────
     In practice a LinkedIn link arrives as a bare `URL:` line far more often than as
     any social-profile property, so every URL-bearing property funnels through here. */
  for (const line of [...urls, ...social]) {
    const value = collapse(unescapeValue(line.value));
    if (!value) continue;
    classifyUrlInto(value, person);
  }

  // Only if host classification found no LinkedIn do Apple's labels get a say — this
  // catches `item1.URL` + `item1.X-ABLabel:LinkedIn` pointing at a shortener.
  if (!person.linkedin) {
    for (const line of urls) {
      const label = line.group ? labels.get(line.group) : undefined;
      if (label?.includes('linkedin')) {
        person.linkedin = collapse(unescapeValue(line.value));
        break;
      }
    }
  }

  const hasAnything =
    person.name || person.email || person.phone || person.linkedin || person.website;
  return hasAnything ? person : null;
}

/**
 * Fold a raw payload into logical lines, then parse each into name/params/value.
 *
 * Handles both continuation mechanisms in one pass, which is necessary: whichever you
 * apply second sees lines the other has already joined.
 */
function unfold(raw: string): VLine[] {
  const normalised = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const logical: string[] = [];

  for (const rawLine of normalised.split('\n')) {
    const last = logical.length - 1;

    // Trap 1: leading whitespace continues the previous line. 2.1 allows several.
    if (last >= 0 && /^[ \t]/.test(rawLine)) {
      logical[last] += rawLine.replace(/^[ \t]+/, '');
      continue;
    }

    // Trap 2: a trailing '=' on a QUOTED-PRINTABLE property is a soft line break.
    if (last >= 0 && logical[last].endsWith('=') && isQuotedPrintable(logical[last])) {
      logical[last] = logical[last].slice(0, -1) + rawLine;
      continue;
    }

    logical.push(rawLine);
  }

  const out: VLine[] = [];
  for (const line of logical) {
    const parsed = parseLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseLine(line: string): VLine | null {
  const split = splitAtColon(line);
  if (!split) return null;
  const [left, rawValue] = split;

  const parts = splitUnescaped(left, ';');
  let name = (parts.shift() ?? '').trim();
  if (!name) return null;

  // Trap 4: strip Apple's `group.` prefix, or the property is unrecognisable.
  let group: string | undefined;
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    group = name.slice(0, dot).toLowerCase();
    name = name.slice(dot + 1);
  }
  name = name.trim().toLowerCase();
  if (name === 'begin' || name === 'end' || name === 'version') return null;

  const params = new Map<string, string[]>();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      // vCard 2.1 nameless parameter: `TEL;WORK;VOICE` means TYPE=WORK,VOICE.
      push(params, 'type', part.trim().toLowerCase());
      continue;
    }
    const key = part.slice(0, eq).trim().toLowerCase();
    // 3.0/4.0 allow a comma list and permit the value to be double-quoted.
    for (const v of part.slice(eq + 1).split(',')) {
      push(params, key, v.trim().replace(/^"|"$/g, '').toLowerCase());
    }
  }

  const encoding = params.get('encoding')?.[0];
  const charset = params.get('charset')?.[0];
  const value =
    encoding === 'quoted-printable'
      ? decodeQuotedPrintable(rawValue, charset)
      : rawValue;

  return { name, group, params, value };
}

/** Find the first `:` that is not inside a double-quoted parameter value. */
function splitAtColon(line: string): [string, string] | null {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ':' && !inQuotes) return [line.slice(0, i), line.slice(i + 1)];
  }
  return null;
}

function isQuotedPrintable(logicalLine: string): boolean {
  const colon = logicalLine.indexOf(':');
  const head = colon === -1 ? logicalLine : logicalLine.slice(0, colon);
  return /encoding\s*=\s*quoted-printable/i.test(head);
}

/**
 * Trap 6: decode `=XX` byte escapes, then interpret the bytes with the declared
 * charset, falling back to UTF-8 — exactly what ZXing does.
 */
function decodeQuotedPrintable(input: string, charset?: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(input.slice(i + 1, i + 3))) {
      bytes.push(parseInt(input.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code <= 0xff) bytes.push(code);
    else for (const b of new TextEncoder().encode(ch)) bytes.push(b);
  }
  const arr = new Uint8Array(bytes);
  try {
    return new TextDecoder(charset || 'utf-8').decode(arr);
  } catch {
    return new TextDecoder('utf-8').decode(arr);
  }
}

/**
 * Trap 3: split on delimiters that are not backslash-escaped.
 *
 * Exported because MECARD needs the same scan with different delimiters.
 */
export function splitUnescaped(value: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      cur += ch + value[i + 1];
      i++;
      continue;
    }
    if (ch === delim) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Unescape `\\`, `\,`, `\;`, `\:` and `\n`/`\N`. Must run AFTER splitting. */
export function unescapeValue(value: string): string {
  return value.replace(/\\([nN,;:\\])/g, (_m, c: string) =>
    c === 'n' || c === 'N' ? '\n' : c
  );
}

/** Pick the PREF-marked entry, else the first matching a preferred TYPE, else the first. */
function pickPreferred(lines: VLine[], preferredTypes: string[]): VLine | undefined {
  if (!lines.length) return undefined;

  const isPref = (l: VLine) =>
    l.params.get('pref')?.some(v => v === '1' || v === '') ||
    l.params.get('type')?.includes('pref');
  const pref = lines.find(isPref);
  if (pref) return pref;

  for (const type of preferredTypes) {
    const match = lines.find(l => l.params.get('type')?.includes(type));
    if (match) return match;
  }
  return lines[0];
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
