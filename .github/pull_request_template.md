## Summary

<!-- What does this change and why? One or two sentences a reviewer can read first. -->

## Changes

<!-- The notable changes, grouped by area (Chat, Settings, Hermes client, Storage, PWA, ...). -->

-

## Screenshots

<!-- Required for UI changes. Delete rows that don't apply. -->

|        | Light | Dark |
| ------ | ----- | ---- |
| Phone  |       |      |
| Tablet |       |      |

## How to test

<!-- Steps a reviewer can follow. `pnpm mock` starts a fake Hermes on :8642; say "clean up" to trigger an approval. -->

1. `pnpm install && pnpm mock` in one terminal, `pnpm dev` in another
2.

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm build` pass
- [ ] Checked on a phone-sized and a tablet-sized viewport, in light and dark mode
- [ ] If the IndexedDB schema changed: bumped the Dexie version in `src/lib/db.ts` and checked that existing data still loads
- [ ] Which tier does this change's test belong to — unit, component or end-to-end? The cheapest that would fail for the reason the change can fail
- [ ] New images, icons, characters and fonts are original or properly licensed (no third-party characters or brand assets)
- [ ] No secrets, API keys or personal data in code, screenshots or fixtures
- [ ] README updated if setup, configuration or behaviour changed

## Notes for reviewers

<!-- Trade-offs, known limitations, follow-ups, anything that needs a closer look. -->
