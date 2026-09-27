/**
 * js-yaml ships no types and `@types/js-yaml` is not installed. The workflow tests use only `load`
 * to read GitHub Actions files, so this declares exactly that rather than adding a dependency.
 */
declare module 'js-yaml' {
  export function load(input: string, options?: Record<string, unknown>): unknown;
}
