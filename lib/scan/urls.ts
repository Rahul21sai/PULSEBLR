/**
 * Routing a URL found in a payload into the right contact field.
 *
 * Shared by the vCard and MECARD parsers and by the top-level cascade, because all
 * three meet the same question: this is a link, whose link is it?
 *
 * Classification is by HOST, never by a label the payload supplies. Apple's
 * `X-ABLabel:LinkedIn` is a hint used only as a last resort, because a label is
 * free-text written by whoever generated the card while a host is a fact.
 */
import type { ParsedPerson } from './types';
import { parseLinkedInUrl } from './linkedin';

/** Hosts that mean "this is a link-in-bio page", not a person's own site. */
const BIO_LINK_HOSTS = new Set([
  'linktr.ee',
  'bio.link',
  'beacons.ai',
  'carrd.co',
  'about.me',
  'linkin.bio',
  'komi.io',
  'solo.to',
  'campsite.bio',
]);

/**
 * Write `value` into whichever field of `person` it belongs to. First writer wins, so
 * an earlier, more specific property is never overwritten by a later generic one.
 */
export function classifyUrlInto(value: string, person: ParsedPerson): void {
  const li = parseLinkedInUrl(value);
  if (li) {
    if (!person.linkedin) person.linkedin = li.url;
    if (li.slug && !person.linkedinSlug) person.linkedinSlug = li.slug;
    return;
  }

  const host = hostOf(value);
  if (!host) return; // Not a URL — an `xmpp:` IMPP value or a bare handle.

  if (host === 'x.com' || host === 'twitter.com') {
    if (!person.x) person.x = handleFromUrl(value);
  } else if (host === 'github.com') {
    if (!person.github) person.github = handleFromUrl(value);
  } else if (!person.website) {
    person.website = value;
  }
}

/** Lowercased hostname with a leading `www.` removed, or '' when not a URL. */
export function hostOf(value: string): string {
  try {
    return new URL(value.trim()).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function isBioLinkHost(value: string): boolean {
  return BIO_LINK_HOSTS.has(hostOf(value));
}

/** First path segment as a handle: `https://x.com/@foo/status/1` → `foo`. */
export function handleFromUrl(value: string): string | undefined {
  try {
    const seg = new URL(value.trim()).pathname.split('/').filter(Boolean)[0];
    return seg ? seg.replace(/^@/, '') : undefined;
  } catch {
    return undefined;
  }
}
