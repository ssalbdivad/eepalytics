-- Split a feedback item into the part you scan and the part you read.
--
-- Items were one `body` of 400-800 characters carrying roast, number and fix as prose. Five of
-- those is a wall of text, and the only part that changes what the player does next -- the fix --
-- was buried in the middle of it. Uptake cost was high and the actionable payload was low.
--
-- `fix` is the imperative, one sentence, always visible. `title` carries the number and the wit.
-- `body` becomes optional elaboration behind a disclosure, read only when the reader wants it.
ALTER TABLE feedback_item ADD COLUMN fix TEXT NOT NULL DEFAULT '';
