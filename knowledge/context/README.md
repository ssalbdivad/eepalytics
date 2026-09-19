# knowledge/context — generated. Do not edit by hand.

Every file here is written by `pnpm generate:context` (`scripts/generate-context.ts`) out of the
fetched `src/knowledge/champion-table.ts`, and `pnpm fetch:champions` runs it for you. Patch
16.18.1, 173 champions, 5 roles.

A hand edit here does not survive: `src/knowledge/champion-context.test.ts` regenerates the whole
tree into a temp directory and diffs it against what is committed. That test exists because the
error this directory replaced — `lillia.md` saying the Swirlseed "rolls over terrain, and grants
vision of what it rolls past", which it does neither — got in through a writable file under a
file-level provenance header that could not be wrong about a sentence.

- `champions/<key>.md` — everything fetched for that champion. Every line ends with the source,
  revision and date it was copied from.
- `champions/<key>.core.md` — the same block without the wiki's per-ability interaction notes, for
  the callers on a token budget. It may only ever drop lines, and a test asserts that.
- `roles/<role>.md` — one per role. Four of the five say there is nothing, because no source
  publishes anything about a role and nothing was written to stand in for one.
- `general.md` — the patch, the sources, and the list of what nobody publishes.
- `MANIFEST.json` — patch, counts and a sha256 over the tree.

At runtime `src/knowledge/champion-context.ts` reads these files and joins them. It cannot render,
template or compute a sentence, and that is the design rather than an accident of it.
