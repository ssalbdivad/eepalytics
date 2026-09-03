-- Rank feedback by what it is worth acting on, and demote what is merely interesting.
--
-- Five items in the order the model happened to emit them makes the reader do the triage. These
-- three axes let the app do it:
--
--   impact         how much the play plausibly cost, grounded in a real figure (gold swing,
--                  objectives conceded, death cost). NOT a win-rate delta -- this data cannot
--                  support one, and a number that looks computed but is not is exactly the
--                  fabrication the rest of the app exists to prevent.
--   actionability  whether the fix is a rule he can follow mid-game, or a vibe.
--   confidence     whether the read is solid enough to change behaviour over. Interpolated
--                  positions and one-game samples are not.
--
-- `priority` is DERIVED from the three by `rankItems()` and stored so the UI, the API and any
-- later analysis all sort identically instead of each re-deriving it.
ALTER TABLE feedback_item ADD COLUMN impact TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE feedback_item ADD COLUMN actionability TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE feedback_item ADD COLUMN confidence TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE feedback_item ADD COLUMN priority REAL NOT NULL DEFAULT 0;
