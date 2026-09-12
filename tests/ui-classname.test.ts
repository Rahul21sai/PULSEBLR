/* eslint-disable react/no-children-prop --
 * `react/no-children-prop` exists to stop `<div children={x} />` in JSX, where `<div>{x}</div>` is
 * always available. This file has no JSX, and for a component whose props DECLARE `children` as
 * required, TypeScript's `createElement` overload will not accept it as the third argument:
 *
 *     createElement(ui.Card, { className: SENTINEL }, 'body')
 *     → TS2769: Property 'children' is missing in type '{ className: string; }'
 *
 * Measured, not assumed — reverting one case to that form and running `tsc --noEmit` bare reproduces
 * it. So children-in-props is the only form that typechecks here, and the rule is a false positive
 * for this file. Disabled at file scope rather than on seven lines because every occurrence has the
 * identical justification.
 *
 * The alternative was a `.tsx` test using JSX, which would need `tests/**` + `.test.tsx` added to
 * `vitest.config.mts`'s include. Rejected: that config's scope statement ("PURE functions only") is
 * quoted in CLAUDE.md and load-bearing, and widening it for every future test file is a larger
 * change than suppressing one rule in one file.
 */
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import * as ui from '@/app/components/ui';
import { cn } from '@/lib/cn';

/**
 * EVERY PRIMITIVE MUST COMPOSE A PASSED `className`, AND THE SECOND HALF OF EACH ASSERTION IS THE
 * IMPORTANT HALF.
 *
 * The shipped bug was not that `className` was ignored — it was that `className` sits in
 * `ButtonHTMLAttributes`, so `...rest` captured it and `{...rest}` spread AFTER the styling, which
 * REPLACED the base classes rather than appending to them. `<Button className="mt-2">` rendered a
 * button with no height, no radius and no tone. `Chip` had the identical defect, and the two were
 * fixed separately, in two sessions, with two different inline expressions.
 *
 * So a test that only looked for the caller's class would PASS on the bug: the sentinel is present
 * in exactly the broken rendering. Each case therefore asserts the sentinel AND a class the
 * component contributes itself. That pair is the contract `cn()` exists to hold.
 *
 * Rendered through `react-dom/server` rather than a DOM library on purpose. `ui.tsx`'s docblock
 * states it is server-safe — no hooks, no `'use client'` — so `renderToStaticMarkup` exercises the
 * real components with no jsdom, no `@testing-library/react`, and no change to
 * `vitest.config.mts`'s `environment: 'node'`. The file is `.ts` rather than `.tsx` for the same
 * reason: that config's `include` glob ends in `.test.ts`, so a `.tsx` test would be collected by
 * nothing and would "pass" by never running. Hence `createElement` instead of JSX.
 */

const SENTINEL = 'zz-caller-sentinel';

/** Each case: the element, plus one class the primitive itself must still contribute. */
const CASES: Array<{ name: string; el: () => ReactElement; base: string }> = [
  {
    name: 'PageHeader',
    el: () => createElement(ui.PageHeader, { title: 'Events', className: SENTINEL }),
    base: 'flex-wrap',
  },
  {
    name: 'SectionTitle',
    el: () => createElement(ui.SectionTitle, { title: 'Similar events', className: SENTINEL }),
    base: 'pb-3',
  },
  {
    name: 'Card',
    el: () => createElement(ui.Card, { className: SENTINEL, children: 'body' }),
    base: 'rule-y',
  },
  {
    name: 'Well',
    el: () => createElement(ui.Well, { className: SENTINEL, children: 'body' }),
    base: 'leading-relaxed',
  },
  {
    name: 'Button',
    el: () => createElement(ui.Button, { className: SENTINEL, children: 'Save changes' }),
    base: 'r-touch',
  },
  {
    name: 'ButtonLink',
    el: () => createElement(ui.ButtonLink, { href: '/events', className: SENTINEL, children: 'Register' }),
    base: 'r-touch',
  },
  {
    name: 'Chip',
    el: () => createElement(ui.Chip, { className: SENTINEL, children: 'This week' }),
    base: 'r-touch',
  },
  {
    // Stat's root carried no classes of its own, so its contribution is measured on the label it
    // renders. Without that arm the case would pass on a component that emitted nothing but the
    // caller's class.
    name: 'Stat',
    el: () => createElement(ui.Stat, { label: 'Upcoming', value: 12, className: SENTINEL }),
    base: 't-label',
  },
  {
    name: 'Field',
    el: () => createElement(ui.Field, { label: 'Venue', className: SENTINEL, children: 'Indiranagar' }),
    base: 'py-2.5',
  },
  {
    name: 'Banner',
    el: () => createElement(ui.Banner, { className: SENTINEL, children: 'Could not load events.' }),
    base: 'border-l-2',
  },
  {
    name: 'EmptyState',
    el: () =>
      createElement(ui.EmptyState, { icon: 'search', title: 'No events', className: SENTINEL }),
    base: 'rule-y',
  },
  {
    name: 'Skeleton',
    el: () => createElement(ui.Skeleton, { className: SENTINEL }),
    base: 'skeleton',
  },
];

describe('every ui.tsx primitive composes a passed className', () => {
  it('covers every exported primitive, so a new one cannot be added untested', () => {
    const exported = Object.keys(ui).filter((k) => typeof (ui as never as Record<string, unknown>)[k] === 'function');
    const covered = CASES.map((c) => c.name);
    expect([...exported].sort()).toEqual([...covered].sort());
  });

  for (const { name, el, base } of CASES) {
    it(`${name} keeps the caller's class AND its own`, () => {
      const html = renderToStaticMarkup(el());
      expect(html, `${name} dropped the caller's class`).toContain(SENTINEL);
      expect(html, `${name} REPLACED its base classes with the caller's — the shipped bug`).toContain(base);
    });
  }
});

describe('cn', () => {
  it('is last-wins in source order, because that is what the cascade does', () => {
    expect(cn('p-2', 'p-4')).toBe('p-2 p-4');
  });

  it('drops every falsy branch rather than emitting empty slots', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b');
  });

  it('returns an empty string when given nothing, so it is safe on an optional prop', () => {
    expect(cn(undefined)).toBe('');
  });
});
