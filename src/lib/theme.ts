/** Reads a CSS custom property off the document root.
 *
 * Canvas has no access to Tailwind classes, so anything drawn there has to
 * resolve the theme's colours itself. The window guard matters because
 * this app server-renders: during SSR there is no document, and the
 * fallback stands in until hydration. */
export function readToken(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}
