-- The frame journal: what the coach actually saw, recorded while the player screen-shares.
--
-- This replaces replay capture, which never worked once — 0 completed jobs and not a single
-- screenshot in the app's entire history. The journal cannot have its predecessor's central bug
-- (a camera that would not follow the player) because the frames ARE the player's own screen.
--
-- THE SESSION IS THE PRIMARY KEY, NOT THE GAME. Frames exist before the gameId does: the id the
-- rest of the app keys on comes from match history after the game ends, and the live client may
-- be unreachable while the game is running. So a session owns its frames from the first one, and
-- the gameId is an attribute that arrives later — or never.
CREATE TABLE IF NOT EXISTS journal_session (
	id               TEXT    PRIMARY KEY,
	startedMs        INTEGER NOT NULL,
	endedMs          INTEGER,

	-- Deliberately NO foreign key. The session is written while the game is in progress, long
	-- before `game` has a row for it; `job` and `app_event` already carry gameIds the same way.
	gameId           INTEGER,

	-- How the gameId was established, and it is never guessed:
	--   'lcu'       the client told us mid-game (the normal case)
	--   'matched'   exactly one candidate game was found after ingest
	--   'manual'    the user said so
	--   'unclaimed' zero or several candidates — visible in the UI, never resolved by coin flip
	--   'no-game'   claimed an id the harvester never ingested
	claim            TEXT    NOT NULL DEFAULT 'unclaimed',

	-- Identity anchors, used by the matcher when the LCU could not tell us.
	championName     TEXT,
	riotId           TEXT,
	-- firstFrameWallMs − firstFrameGameTimeSec×1000: when the game clock read zero.
	estimatedStartMs INTEGER,

	frameCount       INTEGER NOT NULL DEFAULT 0,
	createdMs        INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS journal_session_game ON journal_session(gameId);
CREATE INDEX IF NOT EXISTS journal_session_claim ON journal_session(claim);

-- One row per frame on disk. `tSec` is the GAME clock, stamped by the daemon from the live client
-- at the moment the frame arrives — never derived from a browser timestamp, because mixing a
-- renderer's Date.now() with the daemon's is a clock boundary this repo already documents as
-- unreliable, and a frame placed at the wrong second is worse than no frame.
CREATE TABLE IF NOT EXISTS journal_frame (
	id        TEXT    PRIMARY KEY,
	sessionId TEXT    NOT NULL REFERENCES journal_session(id) ON DELETE CASCADE,
	tSec      REAL    NOT NULL,
	path      TEXT    NOT NULL,
	atMs      INTEGER NOT NULL,

	-- 'live' when the game clock was read for this frame, 'interpolated' when the read failed and
	-- the last known anchor was extended. An interpolated frame may never anchor a claim.
	clock     TEXT    NOT NULL DEFAULT 'live',

	-- The exact ground-truth block the coach was holding at this instant, when there was one. This
	-- is what lets a later visual pass say what was true as well as what was on screen.
	truthJson TEXT,

	bytes     INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS journal_frame_session ON journal_frame(sessionId, tSec);
