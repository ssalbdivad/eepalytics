-- The rest of the 2026-09-04 freeze.
--
-- `009` removed the one row that was actively doing damage (`autoReviewNewGames`) and the five
-- that pointed at a feature which no longer exists. Eleven remained, and ten of those still hold
-- the exact value their code default held on the day the whole settings object was written out
-- in one transaction. They are identical to the defaults today, so deleting them changes nothing
-- an observer can see — and that is the point: while a row exists, the default is unreachable,
-- so shipping a better `pollInGameMs` or a new `model` would change this install only by
-- coincidence. Ten rows of the same landmine that cost the review path eight days.
--
-- Each row is deleted only when its stored JSON is byte-identical to the shipped default. A row
-- the user actually moved is left exactly where it is: `coachIntensity` is 0.9 against a default
-- of 0.8 on the author's machine and is deliberately NOT in this list, because it is the one
-- value in the table that somebody meant.
--
-- After this, the settings table on a long-lived install says the same thing it says on a fresh
-- one: a row here is a decision.
DELETE FROM settings WHERE key = 'model'              AND value = '"claude-sonnet-5"';
DELETE FROM settings WHERE key = 'gamesForTrends'     AND value = '20';
DELETE FROM settings WHERE key = 'retentionDays'      AND value = '14';
DELETE FROM settings WHERE key = 'replayFolder'       AND value = '""';
DELETE FROM settings WHERE key = 'coachIntensity'     AND value = '0.8';
DELETE FROM settings WHERE key = 'liveProvider'       AND value = '"gemini-live"';
DELETE FROM settings WHERE key = 'liveModel'          AND value = '""';
DELETE FROM settings WHERE key = 'transport'          AND value = '"bridge"';
DELETE FROM settings WHERE key = 'pollIdleMs'         AND value = '5000';
DELETE FROM settings WHERE key = 'pollInGameMs'       AND value = '2000';
DELETE FROM settings WHERE key = 'maxMomentsPerGame'  AND value = '12';
