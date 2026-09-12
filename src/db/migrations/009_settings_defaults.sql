-- Settings rows that were never a user's choice.
--
-- `PUT /api/settings` used to persist the WHOLE merged settings object on every save, not the
-- keys the patch carried. So one save of one field froze all seventeen keys into the table at
-- that instant — after which a code default could never reach this install again, silently.
--
-- The evidence is in the table itself: every row on this machine carries the same `updatedMs`
-- (1788567498183 — 2026-09-05T00:18:18Z), which is one write, not seventeen decisions.
--
-- The visible cost was `autoReviewNewGames`. Its code default has been `true` since the first
-- commit and README documents it as `true`; the stored `false` from that write switched the
-- post-game path off on 2026-09-04 and nothing has re-run it since. 0 of the following 30 games
-- got a review, and the per-game review is the only tier of this product a human has graded
-- (68% useful over 37 blinded items).
--
-- Deleting the row is the durable fix rather than writing `true` into it: an absent row FOLLOWS
-- the code default forever, so the two cannot disagree again. A later save from the Settings
-- screen writes the row back, and that one really is a choice.
DELETE FROM settings WHERE key = 'autoReviewNewGames';

-- Keys that no longer exist in `Settings`. The intrusive replay-capture gate was deleted, but
-- its rows stayed behind and `getSettings()` merges every stored row over the defaults, so a
-- dead key is a value the app carries around and nothing reads.
DELETE FROM settings WHERE key IN (
	'captureEnabled',
	'captureMaxPerGame',
	'clipSeconds',
	'idleGraceMs',
	'captureRequestTtlMin'
);
