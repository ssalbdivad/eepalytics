/**
 * Shared constants. Imported by BOTH the daemon (Node) and the web bundle (browser),
 * so this file must contain NO node-only imports and must not touch `process` unguarded.
 */

const env: Record<string, string | undefined> =
	typeof process !== "undefined" && process.env ? process.env : {}

/** Bump to invalidate derived metrics + moments for every game. */
export const ANALYSIS_VERSION = 1

/** Bump to invalidate every Claude review. */
export const REVIEW_VERSION = 3

/** Migration file set currently shipped. openDb() refuses to run against a newer DB. */
export const SCHEMA_VERSION = 2

/** Hono listens here; vite dev proxies /api + /media to it. */
export const SERVER_PORT = Number(env.CSK_PORT ?? 7700)
export const SERVER_HOST = env.CSK_HOST ?? "127.0.0.1"

/** Everything we write lives on ext4. /mnt/c is read-only territory (26x slower for SQLite). */
export const DATA_DIR = env.CSK_DATA_DIR ?? "/home/ssalb/coachskaffur/data"
export const DB_PATH = `${DATA_DIR}/csk.db`
export const BLOBS_DIR = `${DATA_DIR}/blobs`
export const MEDIA_DIR = `${DATA_DIR}/media`
export const REPLAYS_DIR = `${DATA_DIR}/replays`
export const LOGS_DIR = `${DATA_DIR}/logs`

/** League install (Windows, reached through /mnt/c). */
export const LEAGUE_DIR = env.CSK_LEAGUE_DIR ?? "/mnt/c/Games/Riot Games/League of Legends"
/** NOTE: this file has NO trailing newline. `name:pid:PORT:PASSWORD:https` */
export const LOCKFILE_PATH = `${LEAGUE_DIR}/lockfile`

/** Where the client puts .rofl files. Both spellings of the same directory. */
export const REPLAY_DIR_WIN = "C:/Users/ssalb/Documents/League of Legends/Replays"
export const REPLAY_DIR_WSL = "/mnt/c/Users/ssalb/Documents/League of Legends/Replays"

/** WSL2 cannot reach Windows 127.0.0.1 over TCP; all League traffic goes through interop. */
export const WIN_CURL = "/mnt/c/WINDOWS/system32/curl.exe"
export const WIN_NODE_CANDIDATES = [
	"/mnt/c/Program Files/nodejs/node.exe",
	"/mnt/c/Program Files (x86)/nodejs/node.exe"
] as const

/** LCU basic-auth username is literally "riot"; the password comes from the lockfile. */
export const LCU_AUTH_USER = "riot"
/** The in-game Live Client Data API. No auth, self-signed cert, only up while InProgress. */
export const LIVE_CLIENT_PORT = 2999
export const LIVE_CLIENT_ORIGIN = `https://127.0.0.1:${LIVE_CLIENT_PORT}`

/** The user. Verified this session. */
export const USER_PUUID = env.CSK_PUUID ?? "188dee22-18d6-5752-ba7f-b69cf3d2506e"
export const USER_RIOT_ID = env.CSK_RIOT_ID ?? "Gooskaffur#NA1"
export const USER_GAME_NAME = "Gooskaffur"
export const USER_TAG_LINE = "NA1"
export const USER_SUMMONER_ID = 122474706
export const PLATFORM_ID = "NA1"

/**
 * `minutesUntilReplayConsideredLost: 30` — verified from /lol-replays/v1/configuration.
 * A replay download must be triggered inside this window or the game is gone forever.
 */
export const REPLAY_EXPIRY_MS = 30 * 60 * 1000
/** Start a download job this long before the deadline at the latest; below it, don't bother. */
export const REPLAY_DOWNLOAD_MIN_SLACK_MS = 60 * 1000

/** Job kinds, in dependency order. Mirrors the JobKind union in schema/domain.ts. */
export const JOB_KINDS = [
	"match-ingest",
	"replay-download",
	"analysis-run",
	"review-game",
	"review-trend",
	"replay-capture",
	"media-generate"
] as const
export type JobKindConst = (typeof JOB_KINDS)[number]

/** Lower number runs first. */
export const JOB_PRIORITY: Record<JobKindConst, number> = {
	"match-ingest": 10,
	"replay-download": 20,
	"analysis-run": 30,
	"review-game": 40,
	"review-trend": 50,
	"replay-capture": 90,
	"media-generate": 95
}

/**
 * Only `replay-capture` takes over the user's client. `replay-download` is NOT intrusive —
 * it asks the client to fetch the .rofl in the background — and it is the urgent one.
 */
export const JOB_INTRUSIVE: Record<JobKindConst, boolean> = {
	"match-ingest": false,
	"replay-download": false,
	"analysis-run": false,
	"review-game": false,
	"review-trend": false,
	"replay-capture": true,
	"media-generate": false
}

export const JOB_MAX_ATTEMPTS: Record<JobKindConst, number> = {
	"match-ingest": 5,
	"replay-download": 4,
	"analysis-run": 3,
	"review-game": 3,
	"review-trend": 3,
	"replay-capture": 2,
	"media-generate": 3
}

/** How long a worker may hold a claimed job before another worker may steal it. */
export const JOB_LEASE_MS = 10 * 60 * 1000
/** Backoff between attempts: attempt n waits BASE * 2^(n-1), capped. */
export const JOB_RETRY_BASE_MS = 15 * 1000
export const JOB_RETRY_MAX_MS = 10 * 60 * 1000

/** Gameflow phases in which an intrusive job may start (allowlist — unknown phases fail closed). */
export const IDLE_PHASES = ["None", "Lobby"] as const
export const IDLE_GRACE_MS = 120_000

/** Summoner's Rift world bounds. */
export const MAP = {
	/** Riot's canonical bounds. UNVERIFIED numerically (+/- ~150 units); observed span below. */
	minX: -120,
	minY: -120,
	maxX: 14870,
	maxY: 14980,
	/** What we actually measured across 6880 participant frames + 1928 events. */
	observed: { minX: 130, minY: 135, maxX: 14589, maxY: 14673 },
	/** Rotated basis: u = (x+y)/2 (blue->red progression), v = (y-x)/2 (lane offset). */
	centerU: 7420,
	midV: 0,
	innerV: 2650,
	outerV: 4750,
	inhibV: 1150,
	/** Calibrated zone-classifier tuning constants (not physical — tune freely). */
	baseRadius: 2600,
	pitRadius: 1100,
	laneHalfWidth: 1100,
	riverHalfU: 900,
	/** |u - centerU| below this counts as neutral ground rather than own/enemy half. */
	neutralU: 900
} as const

/** Timeline frames arrive once per minute. Interpolation between them is mandatory. */
export const FRAME_INTERVAL_MS = 60_000
/** Median inter-frame displacement measured at 4082 units (~28% of the map). */
export const FRAME_MEDIAN_DISPLACEMENT = 4082

/** Laning-phase sampling window used by role inference and early-game metrics. */
export const LANING_START_SEC = 120
export const LANING_END_SEC = 570

/** Summoner spell id 11 = Smite. Exactly one holder per team in 44/44 team-games. */
export const SMITE_SPELL_ID = 11

/** participantId 1-5 => team 100, 6-10 => team 200. Verified 220/220. */
export const TEAM_BLUE = 100
export const TEAM_RED = 200

/** Human labels for the queues we actually see. Fall back to `Queue ${id}`. */
export const QUEUE_NAMES: Record<number, string> = {
	400: "Normal Draft",
	420: "Ranked Solo/Duo",
	430: "Normal Blind",
	440: "Ranked Flex",
	450: "ARAM",
	490: "Quickplay",
	700: "Clash",
	1700: "Arena",
	1900: "URF"
}

export const queueName = (queueId: number): string =>
	QUEUE_NAMES[queueId] ?? `Queue ${queueId}`

/**
 * "16.17.810.4348" -> "16.17". Patch is what the UI groups by; the full gameVersion is
 * what /lol-replays/v2/metadata/{id}/create needs.
 */
export const patchOf = (gameVersion: string): string =>
	gameVersion.split(".").slice(0, 2).join(".")

/** DDragon minimap for Summoner's Rift. Verified 200 OK, 512x512. */
export const MINIMAP_URL = "https://ddragon.leagueoflegends.com/cdn/16.17.1/img/map/map11.png"
