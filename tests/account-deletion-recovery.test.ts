import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import * as accountDeletionSection from '../app/settings/AccountDeletionSection';

type Recovery = 'clear-site-data' | 'sign-out';
type RecoveryViewProps = {
  recovery: Recovery;
  signOutAfterDeletion(callbackUrl: string): void | Promise<unknown>;
};
type RecoveryExports = {
  committedDeletionRecovery?: (outboxPurged: boolean) => Recovery;
  AccountDeletionRecovery?: (props: RecoveryViewProps) => ReactElement;
};

function recoveryExports() {
  const exports = accountDeletionSection as unknown as RecoveryExports;
  expect(exports.committedDeletionRecovery).toBeTypeOf('function');
  expect(exports.AccountDeletionRecovery).toBeTypeOf('function');
  return exports;
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(' ');
  if (!isValidElement<{ children?: ReactNode }>(node)) return '';
  return textContent(node.props.children);
}

function findButton(node: ReactNode): ReactElement<{ onClick(): void; children?: ReactNode }> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<{ onClick?: () => void; children?: ReactNode }>(node)) return null;
  if (node.type === 'button' && textContent(node).includes('Sign out after deletion')) {
    return node as ReactElement<{ onClick(): void; children?: ReactNode }>;
  }
  return findButton(node.props.children);
}

describe('committed account-deletion recovery', () => {
  it('renders clear-site-data recovery after committed outbox purge failure', () => {
    const exports = recoveryExports();
    if (!exports.committedDeletionRecovery || !exports.AccountDeletionRecovery) return;

    const recovery = exports.committedDeletionRecovery(false);
    const html = renderToStaticMarkup(createElement(exports.AccountDeletionRecovery, {
      recovery,
      signOutAfterDeletion: vi.fn(),
    }));
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    expect(recovery).toBe('clear-site-data');
    expect(text).toMatch(/account is already deleted/i);
    expect(text).toMatch(/clear this site[^.]*stored data/i);
    expect(text).toMatch(/sign out after deletion/i);
    expect(text).not.toMatch(/delete account permanently|type DELETE/i);
  });

  it('renders separate sign-out recovery after committed sign-out failure', () => {
    const exports = recoveryExports();
    if (!exports.committedDeletionRecovery || !exports.AccountDeletionRecovery) return;

    const recovery = exports.committedDeletionRecovery(true);
    const html = renderToStaticMarkup(createElement(exports.AccountDeletionRecovery, {
      recovery,
      signOutAfterDeletion: vi.fn(),
    }));
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    expect(recovery).toBe('sign-out');
    expect(text).toMatch(/account is already deleted/i);
    expect(text).toMatch(/could not sign this browser out automatically/i);
    expect(text).toMatch(/separate sign-out action/i);
    expect(text).not.toMatch(/delete account permanently|type DELETE/i);
  });

  it('runs only the separate sign-out action from recovery', () => {
    const exports = recoveryExports();
    if (!exports.AccountDeletionRecovery) return;

    const signOutAfterDeletion = vi.fn();
    const node = exports.AccountDeletionRecovery({
      recovery: 'sign-out',
      signOutAfterDeletion,
    });
    const button = findButton(node);

    expect(button).not.toBeNull();
    button?.props.onClick();
    expect(signOutAfterDeletion).toHaveBeenCalledOnce();
    expect(signOutAfterDeletion).toHaveBeenCalledWith('/delete-account?complete=1');
  });
});
