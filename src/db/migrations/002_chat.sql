-- Coach chat: a conversation about ONE game.
--
-- Kept separate from `review` on purpose. A review is a generated artefact keyed by a prompt
-- hash and re-derivable from the digest; a chat is a record of what the user actually asked,
-- and it must survive a re-review, a re-analysis and a schema bump untouched. Deleting a game
-- deletes its chat (ON DELETE CASCADE) because the digest it refers to would be gone too.
--
-- `citedMomentIds` / `citedMetricKeys` are JSON arrays, matching how `feedback_item` stores
-- the same thing: the answer's citations are what let the UI put the map image and the metric
-- beside the reply instead of leaving it as unsourced prose.

CREATE TABLE IF NOT EXISTS chat_message (
	id               TEXT    PRIMARY KEY,
	gameId           INTEGER NOT NULL REFERENCES game(gameId) ON DELETE CASCADE,
	role             TEXT    NOT NULL,             -- user|coach
	content          TEXT    NOT NULL,
	-- Null on a user turn; set on a coach turn so the UI can show what answered and at what cost.
	model            TEXT,
	costUsd          REAL,
	citedMomentIds   TEXT    NOT NULL DEFAULT '[]',
	citedMetricKeys  TEXT    NOT NULL DEFAULT '[]',
	-- A coach turn that failed still gets a row, the same way a failed review does, so the user
	-- sees what went wrong instead of a question that vanished.
	status           TEXT    NOT NULL DEFAULT 'ok', -- ok|failed
	error            TEXT,
	createdMs        INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS chat_message_game ON chat_message (gameId, createdMs);
