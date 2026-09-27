'use client';
import Link from 'next/link';

import { useState, useEffect, useId, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { DesktopNav, MobileBottomNav } from '../components/NavBar';
import { Banner, Chip } from '../components/ui';
import { TAP_44 } from '../components/scan/ContactFields';
import { CATEGORY_GROUPS } from '@/lib/event-types';
import { MANUAL_EVENT_LIMITS, readSharedEvent } from '@/lib/events/manual-input';
import { fromISTInputValue } from '@/lib/ist-datetime-input';



/**
 * Categories come FROM THE SCHEMA, never from a copy.
 *
 * This list used to be hardcoded and still held six values retired in the 32 -> 22
 * taxonomy consolidation — Fintech, Government, Corporate, Summit/Conference,
 * Networking/Meetup and Career/Job Fair. Choosing any of them made the submission fail
 * enum validation, so the Add Event form could not actually add an event. Deriving it
 * from CATEGORY_GROUPS also gives the picker the same tech-first ordering as the feed's
 * filter rail. */
const CATEGORY_SECTIONS = CATEGORY_GROUPS;

const AREAS = [
  'Koramangala', 'Indiranagar', 'Whitefield', 'HSR Layout',
  'Electronic City', 'MG Road', 'Jayanagar', 'Malleshwaram',
  'BTM Layout', 'Marathahalli',
];

const FORMATS = ['offline', 'online', 'hybrid'] as const;
const FOOD = ['yes', 'no', 'unknown'] as const;
type Format = (typeof FORMATS)[number];
type Food = (typeof FOOD)[number];

interface FormState {
  title: string;
  description: string;
  imageUrl: string;
  organizer: string;
  sourceUrl: string;
  category: string[];
  format: Format;
  hasFood: Food;
  isFree: boolean;
  price: string;
  venue: string;
  area: string;
  onlineLink: string;
  /** datetime-local text, `YYYY-MM-DDTHH:mm`, read as IST. Converted to an instant only on submit. */
  startDateTime: string;
  endDateTime: string;
  registrationDeadline: string;
  applyLink: string;
}

/** A save the server (or the fallback checks below) refused, and which control it is about. */
interface FormError {
  /** The control's field name — the same string the API's `issues[].field` uses. */
  field?: string;
  message: string;
}

interface Note {
  tone: 'info' | 'ok' | 'warn';
  message: string;
}

/** What a datetime-local input can hold. Anything else would render as an empty field. */
const INPUT_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A datetime-local value → the instant to send, or the raw text when it cannot be read (so the
 * server's 400 names the field rather than the value vanishing).
 *
 * SENT WITH ITS ZONE. The form used to spread the raw `YYYY-MM-DDTHH:mm` text into the body, and the
 * server read that zone-less string in ITS zone — UTC on Vercel — so a 19:00 event was stored at
 * 00:30 the next day. `validateManualEvent` now reads zone-less text as IST (which also covers an
 * installed PWA still running an older bundle), and this makes the request unambiguous on its own:
 * `fromISTInputValue` is the same fixed +05:30 conversion the admin editors use.
 */
function toInstant(value: string): string | undefined {
  if (!value) return undefined;
  return fromISTInputValue(value) ?? value;
}

function AddEventForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  /**
   * ONE `useId`, every control's id derived from it by field name. The derived names are the SAME
   * strings the API reports in `issues[].field`, so a 400 can put focus on the control it is about
   * without a lookup table — and the ids are unique per mount, which a hand-written `id="title"`
   * would not be if this form ever rendered twice on a page.
   */
  const uid = useId();
  const idOf = (name: string) => `${uid}-${name}`;

  const [saving, setSaving] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState<Note | null>(null);
  const [error, setError] = useState<FormError | null>(null);
  /**
   * WHO THIS EVENT IS FOR — the choice this page previously could not offer.
   *
   * `POST /api/events` was admin-only while `/add-event` was merely signed-in, so for everybody
   * else this form was a dead end that 403'd on submit. Now the answer to "who is it for" decides
   * what happens: 'private' is yours alone, 'pending' goes to review before it reaches the shared
   * feed.
   *
   * DEFAULTS TO 'private', deliberately. The safe option is the one that does not publish, and it
   * is also the common case — most events somebody types in by hand are ones the scraper cannot
   * know about and nobody else needs.
   */
  const [visibility, setVisibility] = useState<'private' | 'pending'>('private');
  const [submitted, setSubmitted] = useState<null | 'private' | 'pending'>(null);
  const [formData, setFormData] = useState<FormState>({
    title: '',
    description: '',
    imageUrl: '',
    organizer: '',
    sourceUrl: '',
    category: [],
    format: 'offline',
    hasFood: 'unknown',
    isFree: true,
    price: '',
    venue: '',
    area: '',
    onlineLink: '',
    startDateTime: '',
    endDateTime: '',
    applyLink: '',
    registrationDeadline: '',
  });

  /** Set one field, and retire an error that was about it — the person is fixing it. */
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setFormData(prev => ({ ...prev, [key]: value }));
    setError(prev => (prev?.field === key ? null : prev));
  };

  /**
   * THE PWA / ANDROID SHARE TARGET: `GET /add-event?title=&text=&url=` (public/manifest.json).
   *
   * Deferred by a tick so the effect doesn't set state synchronously, which triggers a cascading
   * render. The values go through `readSharedEvent` rather than straight into the form, because an
   * Android share intent has no URL slot: Chrome maps EXTRA_SUBJECT / EXTRA_TEXT to `title` / `text`
   * and `url` usually arrives EMPTY with the link inside `text`. Reading only `url` put the bare link
   * into Description and left the importer empty. Now the link fills "Event URL" AND the import box,
   * so bringing in the page's details is one tap on Fill.
   *
   * NOT auto-imported. Running `/api/scrape-url` from a query string would make any link that
   * opens this page make the server fetch a URL of the sender's choosing; the person tapping Fill
   * is what makes that request theirs.
   */
  useEffect(() => {
    const shared = readSharedEvent({
      title: searchParams.get('title'),
      text: searchParams.get('text'),
      url: searchParams.get('url'),
    });
    if (!shared.title && !shared.description && !shared.url) return;
    const timer = setTimeout(() => {
      setFormData(prev => ({
        ...prev,
        title: shared.title || prev.title,
        description: shared.description || prev.description,
        sourceUrl: shared.url || prev.sourceUrl,
      }));
      if (shared.url) {
        setImportUrl(prev => prev || shared.url);
        setImportNote({
          tone: 'info',
          message: 'We found a link in what you shared. Tap Fill to bring in the event’s details.',
        });
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [searchParams]);

  /**
   * FOCUS FOLLOWS THE ERROR. A refused save used to be a browser `alert()` naming nothing on the
   * page, so on a long form the person had to hunt for the field. Now the control named by the
   * error takes focus — which also scrolls it into view — and its `aria-describedby` carries the
   * message, so a screen reader announces the field and the reason together.
   */
  useEffect(() => {
    if (!error?.field) return;
    document.getElementById(`${uid}-${error.field}`)?.focus();
  }, [error, uid]);

  /**
   * Record an error against a control, but only if that control is on screen. A field the page is
   * not showing (the server can name anything) falls back to the general message by the Save
   * button, rather than to an inline message nobody can see.
   */
  const showError = (field: string | undefined, message: string) => {
    const target = field && document.getElementById(idOf(field)) ? field : undefined;
    setError({ field: target, message });
  };

  const errorFor = (name: string) => (error?.field === name ? error.message : undefined);

  /** id / aria-invalid / aria-describedby for a control, wiring in its hint and any error. */
  const controlProps = (name: string, ...hints: Array<string | undefined>) => {
    const invalid = Boolean(errorFor(name));
    const describedBy = [...hints, invalid ? `${idOf(name)}-error` : undefined].filter(Boolean).join(' ');
    return {
      id: idOf(name),
      'aria-invalid': invalid || undefined,
      'aria-describedby': describedBy || undefined,
    };
  };

  const fieldMessage = (name: string) => {
    const message = errorFor(name);
    if (!message) return null;
    return (
      <p id={`${idOf(name)}-error`} className="mt-1.5 text-[12.5px] leading-snug text-[var(--live)]">
        {message}
      </p>
    );
  };

  const toggleCategory = (cat: string) => {
    setFormData(prev => ({
      ...prev,
      category: prev.category.includes(cat)
        ? prev.category.filter(c => c !== cat)
        : [...prev.category, cat],
    }));
    setError(prev => (prev?.field === 'category' ? null : prev));
  };

  const setFree = (isFree: boolean) => {
    // Switching to free clears the price, so a stale number cannot ride along with "free".
    setFormData(prev => ({ ...prev, isFree, price: isFree ? '' : prev.price }));
    setError(prev => (prev?.field === 'isFree' || prev?.field === 'price' ? null : prev));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    // `required` / `min` on the inputs catch these first; these are the fallbacks for a browser
    // that skips constraint validation. The price one is the rule the server enforces: switching
    // "Free event" off and leaving the price blank used to save the event as FREE.
    if (!formData.title.trim()) {
      showError('title', 'Add a title for the event.');
      return;
    }
    if (!formData.startDateTime) {
      showError('startDateTime', 'Add when the event starts.');
      return;
    }
    if (!formData.isFree && !(Number(formData.price) > 0)) {
      showError('price', 'Enter the ticket price, or switch “Free event” back on.');
      return;
    }

    setSaving(true);
    try {
      // `source` is NOT sent: the route forces `'manual'`, and a body that claims to be scraped
      // would make the row look like corpus data to every diagnostic in scripts/.
      const body = {
        visibility,
        title: formData.title,
        description: formData.description,
        imageUrl: formData.imageUrl,
        organizer: formData.organizer,
        sourceUrl: formData.sourceUrl,
        applyLink: formData.applyLink,
        /**
         * SENT AS-IS, EVEN WHEN EMPTY. This line used to read
         * `formData.category.length > 0 ? formData.category : ['Meetup']`, and that substitution —
         * happening in the BROWSER, before the request — is what actually produced every
         * permanently-invisible hand-added event. `'Meetup'` is excluded from
         * `TECH_FLAG_CATEGORIES` on purpose, so the server derived `isTechEvent: false` from it and
         * the unconditionally-`techOnly` feed correctly hid the row.
         *
         * It also made the server-side default unreachable: `input.category` always arrived
         * non-empty, so `manual-input.ts`'s own `if (!category.length)` never fired for a single
         * form submission. Two copies of one wrong decision, only one of which was doing anything.
         *
         * An empty array now reaches the route, which reads the title and description with the
         * keyword floor and answers 400 naming `category` if even that finds no topic. That is why
         * the submit checks above deliberately do NOT require a category: the import path cannot
         * supply one, and the floor recovers it for most events without asking the user anything.
         */
        category: formData.category,
        format: formData.format,
        hasFood: formData.hasFood,
        // Only what is ON SCREEN for the chosen format. Typing a venue and then switching to online
        // hides the venue box; sending it anyway stored a venue the form no longer showed.
        ...(formData.format !== 'online' ? { venue: formData.venue, area: formData.area } : {}),
        ...(formData.format !== 'offline' ? { onlineLink: formData.onlineLink } : {}),
        startDateTime: toInstant(formData.startDateTime),
        endDateTime: toInstant(formData.endDateTime),
        // The form always had this field; the server used to drop it. See `ManualEventFields`.
        registrationDeadline: toInstant(formData.registrationDeadline),
        // Explicit, and honoured: `isFree: false` with no price is now a 400 naming `price`.
        isFree: formData.isFree,
        ...(formData.isFree ? {} : { price: Number(formData.price) }),
      };
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        // A private event is in the feed immediately, so going there shows the result. A submission
        // is NOT, so redirecting to a feed that does not contain it reads as a failed save —
        // confirm in place instead.
        if (visibility === 'private') {
          router.push('/');
        } else {
          setSubmitted('pending');
        }
        return;
      }

      const data = await res.json().catch(() => ({}));
      /**
       * PRE-SELECT WHAT THE SERVER GUESSED, so the retry is one tap rather than a guessing game.
       *
       * The route answers 400 with `suggestedCategory` when the keyword floor DID read a topic off
       * the title but none of them is a tech topic — the `Dev Days | Bangalore` → `Community/Social`
       * case. Refusing to store that silently is the point (nobody classified it, and a wrong
       * employer-grade guess is what made these events invisible), but making the user re-derive
       * the answer we already have would be the obtuse version of being careful. Filling the picker
       * and letting them press Save again keeps the human as the one asserting it.
       */
      if (Array.isArray(data.suggestedCategory) && data.suggestedCategory.length) {
        setFormData(prev => ({ ...prev, category: data.suggestedCategory as string[] }));
      }
      if (res.status === 401) {
        showError(undefined, 'Your session has ended. Sign in again to save this event.');
        return;
      }
      const issue = Array.isArray(data.issues) ? data.issues[0] : undefined;
      showError(
        typeof issue?.field === 'string' ? issue.field : undefined,
        typeof data.error === 'string' && data.error ? data.error : 'That event could not be saved.'
      );
    } catch {
      showError(undefined, 'Could not reach PulseBLR. Nothing was saved — check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async () => {
    const target = importUrl.trim();
    if (!target) return;
    setImporting(true);
    setImportNote(null);
    try {
      const res = await fetch('/api/scrape-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target }),
      });
      const data = await res.json().catch(() => ({}));
      const imported = res.ok ? data.event : null;
      if (imported) {
        // `/api/scrape-url` returns dates as IST wall-clock text — what these inputs hold — and it
        // is checked here anyway, because a malformed value would render as an EMPTY field while
        // the state still held it, and then be sent on save.
        const start = asText(imported.startDateTime);
        const end = asText(imported.endDateTime);
        setFormData(prev => ({
          ...prev,
          title: asText(imported.title) || prev.title,
          description: asText(imported.description) || prev.description,
          // The cover. `/api/scrape-url` reads schema.org `image` first and falls back to
          // og:image — for an event page the former is the event's own artwork and the latter
          // is often a site-wide banner, so the order matters.
          imageUrl: asText(imported.imageUrl) || prev.imageUrl,
          organizer: asText(imported.organizer) || prev.organizer,
          sourceUrl: asText(imported.sourceUrl) || target,
          startDateTime: INPUT_DATE_TIME.test(start) ? start : prev.startDateTime,
          endDateTime: INPUT_DATE_TIME.test(end) ? end : prev.endDateTime,
          venue: asText(imported.venue) || prev.venue,
          format: (FORMATS as readonly string[]).includes(imported.format) ? imported.format : prev.format,
        }));
        setImportUrl('');
        setImportNote(
          INPUT_DATE_TIME.test(start)
            ? { tone: 'ok', message: 'Filled in from the link. Check the details before saving.' }
            : {
                tone: 'warn',
                message: 'Filled in from the link, but the page did not say when it starts. Add the date and time below.',
              }
        );
      } else {
        setFormData(prev => ({ ...prev, sourceUrl: target }));
        // `safeFetch`'s refusal message is written for the caller, and is the only way they learn
        // WHY a link was refused rather than merely that it was — so it is shown when present.
        const reason = typeof data.error === 'string' && res.status === 400 ? `${data.error} ` : '';
        setImportNote({
          tone: 'warn',
          message: `${reason}Could not read event details from that page. The link is saved as the event URL — fill in the rest by hand.`,
        });
      }
    } catch {
      setFormData(prev => ({ ...prev, sourceUrl: target }));
      setImportNote({
        tone: 'warn',
        message: 'Could not reach that link. It is saved as the event URL — fill in the rest by hand.',
      });
    } finally {
      setImporting(false);
    }
  };

  // `--r-touch`, because a field IS touchable — that is what the 4px radius means in this system.
  // `focus:ring-1 ... /20` is dropped for a solid 2px inset border on focus: a 20%-alpha ring is not
  // a visible focus indicator, and visible keyboard focus is a definition-of-done item here.
  const inputCls = "w-full px-4 py-3 bg-[var(--paper)] border border-[var(--rule)] rounded-[var(--r-touch)] text-[14px] text-[var(--ink)] focus:outline-none focus:border-[var(--accent)] focus:shadow-[inset_0_0_0_1px_var(--accent)] aria-[invalid=true]:border-[var(--live)] transition-colors placeholder:text-[var(--ink-2)]";

  /**
   * A segmented choice drawn over a NATIVE radio.
   *
   * These were `<button>`s under a `<label>` that labelled nothing, so a screen reader heard three
   * unrelated buttons called "offline", "online", "hybrid", with no group name and no selected
   * state. A visually-hidden `<input type="radio">` brings the group semantics, the checked state
   * and arrow-key movement for free — `OnboardingFlow`'s `RadioRow` makes the same argument — and
   * the `<fieldset>`'s `<legend>` names the group. The input is the `peer`, so the focus ring is
   * drawn on the visible segment rather than on a 1px box nobody can see.
   */
  const segmentCls = (on: boolean) =>
    `pressable flex min-h-11 cursor-pointer items-center justify-center r-touch px-2 text-label-md transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[color:var(--accent)] ${
      on
        ? 'bg-[var(--surface)] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] font-semibold'
        : 'text-[var(--ink-2)] hover:text-[var(--ink)]'
    }`;

  const dateHint = `${uid}-date-hint`;
  const showGeneralError = Boolean(error && !error.field);

  /**
   * The confirmation for a submission, shown in place.
   *
   * Not a redirect: a submitted event is `pending`, so it is NOT in the shared feed yet. Sending
   * somebody to a feed that does not contain what they just added is indistinguishable from the
   * save having failed. Their own copy IS visible to them, which is what the link offers.
   */
  if (submitted === 'pending') {
    return (
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-8 text-center">
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[32px] text-[var(--accent)]"
          style={{ fontVariationSettings: "'FILL' 1" }}
        >
          how_to_reg
        </span>
        <h2 className="mt-2 text-[19px] font-bold tracking-[-0.02em] text-[var(--ink)]">
          Sent for review
        </h2>
        <p className="mx-auto mt-2 max-w-[420px] text-[13.5px] leading-relaxed text-[var(--ink-2)]">
          It will appear in everyone&apos;s feed once an admin has looked at it. You can see it in
          your own feed straight away, and you can track it and scan people into it now — approval
          only affects who else sees it.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link
            href="/"
            className="inline-flex h-11 items-center rounded-full bg-[var(--accent)] px-6 text-[14px] font-semibold text-[var(--accent-ink)] pressable"
          >
            See it in my feed
          </Link>
          <button
            type="button"
            onClick={() => setSubmitted(null)}
            className="inline-flex h-11 items-center rounded-full bg-[var(--paper)] px-6 text-[14px] font-semibold text-[var(--ink)] pressable"
          >
            Add another
          </button>
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">

      {/*
        WHO IS IT FOR — first, because it changes what the rest of the form means.
        Putting it at the end, next to the submit button, would have people fill in twenty fields
        under one assumption and discover the choice at the moment of committing.

        A radio group, named by its heading. These were two `aria-pressed` toggle buttons, which say
        "each of these is on or off" about a choice that is one-of-two.
      */}
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6">
        <fieldset
          className="min-w-0"
          aria-labelledby={`${uid}-visibility-legend`}
          aria-describedby={`${uid}-visibility-hint`}
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded-xl bg-[var(--ink)] flex items-center justify-center shrink-0">
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[var(--accent-ink)] text-[16px]"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                visibility
              </span>
            </div>
            <div>
              <h2
                id={`${uid}-visibility-legend`}
                className="text-[14px] font-semibold text-[var(--ink)]"
                style={{ fontFamily: 'var(--font-sans)' }}
              >
                Who is this for?
              </h2>
              <p id={`${uid}-visibility-hint`} className="text-label-sm text-[var(--ink-2)]">
                You can track it and scan people into it either way
              </p>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {([
              {
                value: 'private' as const,
                icon: 'lock',
                title: 'Just for me',
                body: 'Only you can see it. Right for an internal hackathon, a reading group, or anything the scraper cannot know about.',
              },
              {
                value: 'pending' as const,
                icon: 'public',
                title: 'Add for everyone',
                body: 'Goes to an admin for review before it joins the shared feed. Yours to use immediately either way.',
              },
            ]).map(option => {
              const active = visibility === option.value;
              const optionId = `${uid}-visibility-${option.value}`;
              return (
                <label key={option.value} className="block cursor-pointer">
                  <input
                    type="radio"
                    name={`${uid}-visibility`}
                    value={option.value}
                    checked={active}
                    onChange={() => {
                      setVisibility(option.value);
                      setError(prev => (prev?.field === 'visibility' ? null : prev));
                    }}
                    // The checked radio carries the field id, so an error about `visibility`
                    // focuses the current choice rather than always the first.
                    id={active ? idOf('visibility') : undefined}
                    aria-labelledby={`${optionId}-title`}
                    aria-describedby={`${optionId}-body`}
                    className="peer sr-only"
                  />
                  <span
                    className={`pressable block h-full r-touch bg-[var(--paper)] p-4 text-left transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[color:var(--accent)] ${
                      active
                        ? 'shadow-[inset_0_0_0_2px_var(--blue)]'
                        : 'shadow-[inset_0_0_0_1px_var(--hairline)]'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={`material-symbols-outlined text-[18px] ${active ? 'text-[var(--accent)]' : 'text-[var(--ink-3)]'}`}
                      >
                        {option.icon}
                      </span>
                      <span
                        id={`${optionId}-title`}
                        className={`text-[14px] font-semibold ${active ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}`}
                      >
                        {option.title}
                      </span>
                    </span>
                    <span
                      id={`${optionId}-body`}
                      className="mt-1 block text-[12.5px] leading-relaxed text-[var(--ink-2)]"
                    >
                      {option.body}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {fieldMessage('visibility')}
        </fieldset>
      </section>

      {/* Auto-fill from URL */}
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-xl bg-[var(--accent)] flex items-center justify-center shrink-0">
            <span aria-hidden="true" className="material-symbols-outlined text-[var(--accent-ink)] text-[16px]" style={{ fontVariationSettings: "'FILL' 1" }}>link</span>
          </div>
          <div>
            <h2 id={`${uid}-import-heading`} className="text-[14px] font-semibold text-[var(--ink)]" style={{ fontFamily: 'var(--font-sans)' }}>Import from a link</h2>
            {/* The importer has NO host allowlist — `/api/scrape-url` runs safeFetch on any
                http(s) URL and reads schema.org Event JSON-LD, falling back to <time datetime>.
                The old copy named three sites, which told people not to try the many others that
                work. Measured 2026-08-24 on real event pages: Meetup, Eventbrite, Luma,
                events.canonical.com and events.linuxfoundation.org all return a usable Event node;
                wearedevelopers.com and india.droidcon.com publish no structured data at all. So
                the honest promise is "any page that publishes standard event data", not a list. */}
            <p id={`${uid}-import-hint`} className="text-label-sm text-[var(--ink-2)]">
              Paste any event URL — works when the page publishes standard event data
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <input
            id={idOf('import')}
            type="url"
            inputMode="url"
            autoComplete="off"
            value={importUrl}
            onChange={e => setImportUrl(e.target.value)}
            // Enter IMPORTS. This box sits inside the event form, so Enter used to SUBMIT the whole
            // event — "a title is required" — at the exact moment somebody had pasted a link and
            // wanted it read.
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!importing) void handleImport();
              }
            }}
            placeholder="https://…  (Luma, Meetup, Eventbrite, a conference site…)"
            aria-label="Event URL to import"
            aria-describedby={`${uid}-import-hint`}
            className={`flex-1 min-w-0 ${inputCls}`}
          />
          <button
            type="button"
            onClick={handleImport}
            disabled={importing || !importUrl.trim()}
            className="pressable shrink-0 bg-[var(--ink)] text-[var(--accent-ink)] text-[14px] font-semibold px-5 min-h-11 rounded-[var(--r-touch)] transition-colors disabled:opacity-40 flex items-center gap-2"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[16px]">auto_awesome</span>
            {importing ? 'Filling…' : 'Fill'}
          </button>
        </div>
        {importNote && (
          <Banner tone={importNote.tone} className="mt-3">
            {importNote.message}
          </Banner>
        )}
      </section>

      {/* Basic Info */}
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6 space-y-5">
        <h2 className="ty-meta">Event Details</h2>

        <div>
          <label htmlFor={idOf('title')} className="block ty-meta mb-2">
            Event title <span aria-hidden="true" className="text-[var(--live)]">*</span>
          </label>
          <input
            {...controlProps('title')}
            type="text"
            required
            maxLength={MANUAL_EVENT_LIMITS.title}
            value={formData.title}
            onChange={e => update('title', e.target.value)}
            className={inputCls}
            placeholder="e.g., AI/ML Meetup Bangalore"
          />
          {fieldMessage('title')}
        </div>

        <div>
          <label htmlFor={idOf('description')} className="block ty-meta mb-2">Description</label>
          <textarea
            {...controlProps('description')}
            value={formData.description}
            maxLength={MANUAL_EVENT_LIMITS.description}
            onChange={e => update('description', e.target.value)}
            rows={3}
            className={`${inputCls} resize-none`}
            placeholder="What's this event about?"
          />
          {fieldMessage('description')}
        </div>

        {/* Cover image. There was NO field for this at all, so even once the importer started
            returning one there was nowhere to put it, and every manually added event fell back to
            the category-tinted monogram. Editable rather than read-only: the importer gets it
            wrong sometimes — a site-wide banner instead of the event artwork — and pasting a
            better URL is faster than accepting a bad one. */}
        <div>
          <label htmlFor={idOf('imageUrl')} className="block ty-meta mb-2">
            Cover image URL
          </label>
          <input
            {...controlProps('imageUrl')}
            type="url"
            inputMode="url"
            maxLength={MANUAL_EVENT_LIMITS.url}
            value={formData.imageUrl}
            onChange={e => update('imageUrl', e.target.value)}
            className={inputCls}
            placeholder="https://… — filled automatically when you import a link"
          />
          {fieldMessage('imageUrl')}
          {formData.imageUrl && (
            <div className="mt-2.5 flex items-start gap-3">
              {/* Plain <img>, matching the feed: covers come from a long and growing list of
                  third-party CDNs, and next/image's remotePatterns would break every time a
                  source changed host. onError hides it so a dead URL shows nothing rather than a
                  browser's broken-image glyph. */}
              {/* eslint-disable-next-line @next/next/no-img-element -- third-party CDNs, same
                  reason as app/components/EventCover.tsx: remotePatterns would break whenever a
                  source changes host, and this preview accepts an arbitrary pasted URL. */}
              <img
                src={formData.imageUrl}
                alt=""
                className="h-[72px] w-[128px] shrink-0 rounded-lg object-cover bg-[var(--paper)]"
                onError={e => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
              <p className="text-[12px] leading-relaxed text-[var(--ink-2)]">
                Preview. If nothing appears the URL is not reachable or is not an image — the card
                will fall back to a category monogram.
              </p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor={idOf('organizer')} className="block ty-meta mb-2">Organizer</label>
            <input
              {...controlProps('organizer')}
              type="text"
              maxLength={MANUAL_EVENT_LIMITS.organizer}
              value={formData.organizer}
              onChange={e => update('organizer', e.target.value)}
              className={inputCls}
              placeholder="e.g., GDG Bangalore"
            />
            {fieldMessage('organizer')}
          </div>
          <div>
            <label htmlFor={idOf('sourceUrl')} className="block ty-meta mb-2">Event URL</label>
            <input
              {...controlProps('sourceUrl')}
              type="url"
              inputMode="url"
              maxLength={MANUAL_EVENT_LIMITS.url}
              value={formData.sourceUrl}
              onChange={e => update('sourceUrl', e.target.value)}
              className={inputCls}
              placeholder="https://..."
            />
            {fieldMessage('sourceUrl')}
          </div>
        </div>
      </section>

      {/* Categories, grouped exactly as the feed's filter rail groups them, so the
          vocabulary a user picks from is the vocabulary they later filter by. A fieldset, so the
          chips are announced as a group named "Category"; each sub-list is its own named group. */}
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6">
        <fieldset
          id={idOf('category')}
          // Focusable only from script: a `category` 400 moves focus here, and a screen reader
          // then announces the group, its hint and the error.
          tabIndex={-1}
          className="min-w-0 focus:outline-none"
          aria-describedby={[
            `${uid}-category-hint`,
            errorFor('category') ? `${idOf('category')}-error` : '',
          ].filter(Boolean).join(' ')}
        >
          <legend className="t-label text-[var(--ink-2)] mb-1">Category</legend>
          <p id={`${uid}-category-hint`} className="text-[13px] text-[var(--ink-2)] mb-4">
            Pick up to three.
          </p>
          {fieldMessage('category')}
          <div className="space-y-4">
            {CATEGORY_SECTIONS.map(group => (
              <div key={group.id} role="group" aria-labelledby={`${uid}-category-${group.id}`}>
                <p id={`${uid}-category-${group.id}`} className="text-[12px] font-semibold text-[var(--ink)] mb-2">
                  {group.label}
                </p>
                {/* `gap-y-2` is PART of the 44px target: `TAP_44` grows each 36px chip to 44px
                    with an overlay, and two wrapped rows overhang toward each other, so the row
                    gap must be at least 44 - 36 = 8px or a tap lands on the chip below. */}
                <div className="flex flex-wrap gap-x-1.5 gap-y-2">
                  {group.names.map(cat => {
                    const on = formData.category.includes(cat);
                    // Three is the cap the tagger and the schema both enforce.
                    const full = formData.category.length >= 3 && !on;
                    return (
                      <Chip
                        key={cat}
                        pressed={on}
                        disabled={full}
                        onClick={() => toggleCategory(cat)}
                        className={`${TAP_44} pressable disabled:cursor-not-allowed disabled:text-[var(--ink-3)] disabled:hover:bg-[var(--surface)]`}
                      >
                        {cat}
                      </Chip>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </fieldset>
      </section>

      {/* Date & Time */}
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6">
        <h2 className="ty-meta mb-1">Date & Time</h2>
        {/* SAID OUT LOUD, because it is now true by construction: every time here is read as IST
            whatever the phone or the server is set to (see `toInstant`). A traveller whose phone
            is on another zone would otherwise have no way to know which clock these boxes mean. */}
        <p id={dateHint} className="text-[12.5px] text-[var(--ink-2)] mb-4">
          Bengaluru time (IST), whatever your phone is set to.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor={idOf('startDateTime')} className="block ty-meta mb-2">
              Start <span aria-hidden="true" className="text-[var(--live)]">*</span>
            </label>
            <input
              {...controlProps('startDateTime', dateHint)}
              type="datetime-local"
              required
              value={formData.startDateTime}
              onChange={e => update('startDateTime', e.target.value)}
              className={inputCls}
            />
            {fieldMessage('startDateTime')}
          </div>
          <div>
            <label htmlFor={idOf('endDateTime')} className="block ty-meta mb-2">End</label>
            <input
              {...controlProps('endDateTime', dateHint)}
              type="datetime-local"
              min={formData.startDateTime || undefined}
              value={formData.endDateTime}
              onChange={e => update('endDateTime', e.target.value)}
              className={inputCls}
            />
            {fieldMessage('endDateTime')}
          </div>
          <div>
            <label htmlFor={idOf('registrationDeadline')} className="block ty-meta mb-2">
              Registration deadline
            </label>
            <input
              {...controlProps('registrationDeadline', dateHint)}
              type="datetime-local"
              // The server's rule, mirrored so a picker can grey out the impossible days: no later
              // than the end, or the start when there is no end. See `validateManualEvent`.
              max={formData.endDateTime || formData.startDateTime || undefined}
              value={formData.registrationDeadline}
              onChange={e => update('registrationDeadline', e.target.value)}
              className={inputCls}
            />
            {fieldMessage('registrationDeadline')}
          </div>
          <div>
            <label htmlFor={idOf('applyLink')} className="block ty-meta mb-2">Registration link</label>
            <input
              {...controlProps('applyLink')}
              type="url"
              inputMode="url"
              maxLength={MANUAL_EVENT_LIMITS.url}
              value={formData.applyLink}
              onChange={e => update('applyLink', e.target.value)}
              className={inputCls}
              placeholder="https://..."
            />
            {fieldMessage('applyLink')}
          </div>
        </div>
      </section>

      {/* Location & Format */}
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6">
        <h2 className="ty-meta mb-4">Location & Format</h2>

        <fieldset className="mb-5 min-w-0">
          <legend className="block ty-meta mb-3">Format</legend>
          <div className="flex bg-[var(--paper)] r-touch p-1 gap-1">
            {FORMATS.map(fmt => {
              const on = formData.format === fmt;
              return (
                <label key={fmt} className="flex-1 min-w-0">
                  <input
                    type="radio"
                    name={`${uid}-format`}
                    value={fmt}
                    checked={on}
                    id={on ? idOf('format') : undefined}
                    onChange={() => update('format', fmt)}
                    className="peer sr-only"
                  />
                  <span className={`${segmentCls(on)} capitalize`}>{fmt}</span>
                </label>
              );
            })}
          </div>
          {fieldMessage('format')}
        </fieldset>

        {formData.format !== 'online' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label htmlFor={idOf('venue')} className="block ty-meta mb-2">Venue</label>
              <div className="relative">
                <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ink-3)] text-[18px] pointer-events-none">location_on</span>
                <input
                  {...controlProps('venue')}
                  type="text"
                  maxLength={MANUAL_EVENT_LIMITS.venue}
                  value={formData.venue}
                  onChange={e => update('venue', e.target.value)}
                  className={`${inputCls} pl-10`}
                  placeholder="e.g., WeWork Galaxy"
                />
              </div>
              {fieldMessage('venue')}
            </div>
            <div>
              <label htmlFor={idOf('area')} className="block ty-meta mb-2">Area</label>
              <select
                {...controlProps('area')}
                value={formData.area}
                onChange={e => update('area', e.target.value)}
                className={inputCls}
              >
                <option value="">Select area</option>
                {AREAS.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              {fieldMessage('area')}
            </div>
          </div>
        )}

        {formData.format !== 'offline' && (
          <div>
            <label htmlFor={idOf('onlineLink')} className="block ty-meta mb-2">Online link</label>
            <input
              {...controlProps('onlineLink')}
              type="url"
              inputMode="url"
              maxLength={MANUAL_EVENT_LIMITS.url}
              value={formData.onlineLink}
              onChange={e => update('onlineLink', e.target.value)}
              className={inputCls}
              placeholder="Zoom / Meet / Teams URL"
            />
            {fieldMessage('onlineLink')}
          </div>
        )}
      </section>

      {/* Additional Details */}
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6">
        <h2 className="ty-meta mb-4">Additional Details</h2>

        <fieldset className="mb-5 min-w-0">
          <legend className="block ty-meta mb-3">Food provided</legend>
          <div className="flex bg-[var(--paper)] r-touch p-1 gap-1">
            {FOOD.map(opt => {
              const on = formData.hasFood === opt;
              return (
                <label key={opt} className="flex-1 min-w-0">
                  <input
                    type="radio"
                    name={`${uid}-hasFood`}
                    value={opt}
                    checked={on}
                    id={on ? idOf('hasFood') : undefined}
                    onChange={() => update('hasFood', opt)}
                    className="peer sr-only"
                  />
                  <span className={segmentCls(on)}>
                    {opt === 'unknown' ? 'Not sure' : opt.charAt(0).toUpperCase() + opt.slice(1)}
                  </span>
                </label>
              );
            })}
          </div>
          {fieldMessage('hasFood')}
        </fieldset>

        {/*
          A REAL SWITCH. This was a bare `<button>` with no text, no label and no state — a screen
          reader announced "button", and nothing said what it switched or whether it was on. It is
          now `role="switch"` with `aria-checked`, named by its visible title and described by its
          hint, and the WHOLE ROW is the target: the old 48x28 track was under the 44px floor, and a
          row is what a thumb actually aims at.
        */}
        <div className="border-t border-[var(--rule)] pt-2">
          <button
            type="button"
            role="switch"
            id={idOf('isFree')}
            aria-checked={formData.isFree}
            aria-labelledby={`${uid}-free-label`}
            aria-describedby={[
              `${uid}-free-hint`,
              errorFor('isFree') ? `${idOf('isFree')}-error` : '',
            ].filter(Boolean).join(' ')}
            onClick={() => setFree(!formData.isFree)}
            className="pressable flex w-full min-h-11 items-center justify-between gap-4 r-touch py-2 text-left"
          >
            <span>
              <span id={`${uid}-free-label`} className="block text-label-md font-medium text-[var(--ink)]">
                Free event
              </span>
              <span id={`${uid}-free-hint`} className="text-label-sm text-[var(--ink-2)]">
                {formData.isFree ? 'Switch off to set a price' : 'Switch on if there is no ticket price'}
              </span>
            </span>
            <span
              aria-hidden="true"
              className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${formData.isFree ? 'bg-[var(--accent)]' : 'bg-[var(--ink-3)]'}`}
            >
              {/* The knob KEEPS `rounded-full` — it is a circle, not a container, so the flat-container
                  rule does not reach it. Its bare Tailwind `shadow` becomes an inset hairline ring: the
                  system allows exactly one box-shadow (`--shadow-sticky`) and this was a second one. */}
              <span className={`absolute top-1 w-5 h-5 bg-[var(--surface)] rounded-full shadow-[inset_0_0_0_1px_var(--rule)] transition-transform ${formData.isFree ? 'translate-x-6' : 'translate-x-1'}`} />
            </span>
          </button>
          {fieldMessage('isFree')}
        </div>

        {!formData.isFree && (
          <div className="mt-4">
            <label htmlFor={idOf('price')} className="block ty-meta mb-2">
              Price (₹) <span aria-hidden="true" className="text-[var(--live)]">*</span>
            </label>
            <div className="relative">
              <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ink-3)] text-[18px] pointer-events-none">currency_rupee</span>
              <input
                {...controlProps('price')}
                type="number"
                inputMode="numeric"
                // A paid event needs a price: the server refuses one without, and this lets the
                // browser say so before the round trip.
                required
                min={1}
                value={formData.price}
                onChange={e => update('price', e.target.value)}
                className={`${inputCls} pl-10`}
                placeholder="e.g., 499"
              />
            </div>
            {fieldMessage('price')}
          </div>
        )}
      </section>

      {/* Anything the server refused that is not about one control on this page. */}
      {showGeneralError && error && <Banner tone="error">{error.message}</Banner>}

      {/* Submit */}
      <div className="flex gap-3 pb-6">
        <button
          type="submit" disabled={saving}
          className="flex-1 bg-[var(--accent)] text-[var(--accent-ink)] text-label-md font-semibold py-4 rounded-full hover:bg-[var(--accent)] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">save</span>
          {saving ? 'Adding Event…' : 'Save Event'}
        </button>
        <Link
          href="/"
          className="px-8 py-4 bg-[var(--paper)] text-[var(--ink)] text-label-md font-semibold rounded-full transition-colors text-center"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

export default function AddEventPage() {
  return (
    <div className="min-h-screen bg-[var(--paper)]" data-pulseblr-route="add-event">
      <DesktopNav />

      {/* Mobile Header */}
      <header className="md:hidden fixed top-0 w-full h-14 bg-[var(--surface)]/96 glass-nav z-50 border-b border-[var(--rule)] flex items-center justify-center">
        <span className="text-label-md font-bold text-[var(--ink)]">Add Event</span>
      </header>

      <main className="pt-14 pb-24 md:pb-8">
        {/*
          THE RULED HEADER, replacing a full-bleed `bg-black text-white` hero.

          CLAUDE.md §6 already records this exact pattern as a defect on `/dashboard`: a solid black
          band is the loudest possible element in a product whose whole colour budget is spent on
          cover images, and it appeared on one page, which is what made that screen read as a
          different app. This page had the same band, down to the mid-grey subtitle on it.

          What replaces it is the treatment every other surface here now uses — the page ground, a
          sans title (the app naming its own screen, so sans by the semantic rule; a serif `.ty-h1`
          is for a thing in the world, which "add an event" is not), a `.ty-meta` subtitle, and a
          single hairline to close the header. No ground, no radius, no shadow.
        */}
        <header className="rule-b px-5 md:px-8 pt-[var(--s-8)] pb-[var(--s-4)]">
          <div className="max-w-[760px] mx-auto">
            <h1 className="ty-section text-[var(--ink)]">Add an event</h1>
            <p className="ty-meta mt-[var(--s-1)]">
              Something the scraper cannot know about — an internal hackathon, a reading group, an
              invite-only evening.
            </p>
          </div>
        </header>

        <div className="max-w-[760px] mx-auto px-5 md:px-0 py-6">
          <Suspense fallback={<div className="flex justify-center py-12"><div className="spinner" /></div>}>
            <AddEventForm />
          </Suspense>
        </div>
      </main>

      <MobileBottomNav />
    </div>
  );
}
