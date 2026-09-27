/**
 * Thin on purpose. Next type-checks what a route file may export against an allow-list of HTTP
 * methods and segment config, so a handler FACTORY exported from here fails `next build` (plain
 * `tsc` does not catch it). The handler, its dependency seam and its tests live in
 * `lib/notifications/push-test-handler.ts`.
 */
export { POST } from '@/lib/notifications/push-test-handler';
