const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Return the configured public support contact, normalized for display and mailto links. */
export function publicSupportEmail(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  const value = env.PULSEBLR_SUPPORT_EMAIL?.trim().toLowerCase() ?? '';
  if (!EMAIL.test(value)) {
    throw new Error('PULSEBLR_SUPPORT_EMAIL must be a valid public support email address');
  }
  return value;
}
