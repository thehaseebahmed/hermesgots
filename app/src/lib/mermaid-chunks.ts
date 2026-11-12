/**
 * The one declaration of where the build puts mermaid's chunks. Three places spell it: the build
 * names every chunk of mermaid's under that path and leaves it out of the install's precache, the
 * service worker holds the path in one cache-first route, and `scripts/check-mermaid-chunks.mjs`
 * reads the built worker to hold both — a hashed file name changes with every mermaid release, so
 * nothing but the directory can name these files.
 */
export const MERMAID = "assets/mermaid/"
