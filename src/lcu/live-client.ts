/**
 * Client for the game process's own HTTP API on `127.0.0.1:2999`.
 *
 * Two distinct APIs live behind that port:
 *
 * 1. **Live Client Data** (`/liveclientdata/*`) — registered during a live game AND during
 *    replay playback. No auth, self-signed cert. Fully verified against a running game.
 *    It fills the LCU timeline's biggest gaps: live item builds (diff `items` between polls to
 *    reconstruct purchases), ability levels, rune shards, and a RELIABLE `position` role.
 *    It cannot give you x/y coordinates for anybody — those only come from the post-game
 *    timeline (one frame per minute) or from `/replay/objects` during playback.
 * 2. **Replay API** (`/replay/*`) — registered ONLY while a replay is playing. Verified 404 on
 *    every path during a live game, which is exactly how you detect that you are not in a
 *    replay. Its field names come from the signed binary; its response shapes are unverified.
 *
 * Same WSL2 constraint as the LCU: every request goes through the Windows-side transport with
 * `target: "live"`. There is no Authorization header on this port.
 *
 * **Nothing in this file is invoked by the LCU unit.** The capture unit drives it, behind the
 * daemon's idle gate.
 */

import { type as arkType } from "arktype"
import type { Type } from "arktype"
import { USER_RIOT_ID } from "../shared/constants.ts"
import type {
	LiveActivePlayer as LiveActivePlayerType,
	LiveAllGameData as LiveAllGameDataType,
	LiveEventData as LiveEventDataType,
	LiveGameStats as LiveGameStatsType,
	LivePlayerList as LivePlayerListType
} from "../shared/schema/live.ts"
import {
	LiveActivePlayer,
	LiveAllGameData,
	LiveEventData,
	LiveGameStats,
	LivePlayer,
	LivePlayerList
} from "../shared/schema/live.ts"
import { parseOrNull } from "../shared/schema/lcu.ts"
import type {
	ReplayGameInfo as ReplayGameInfoType,
	ReplayObject as ReplayObjectType,
	ReplayPlayback as ReplayPlaybackType,
	ReplayPlaybackPatch,
	ReplayRecordRequest,
	ReplayRecording as ReplayRecordingType,
	ReplayRender as ReplayRenderType,
	ReplayRenderPatch,
	ReplaySequence,
	Vector3f
} from "./replay-schema.ts"
import {
	ReplayGameInfo,
	ReplayObject,
	ReplayPlayback,
	ReplayRecording,
	ReplayRender
} from "./replay-schema.ts"
import type { HttpMethod, LcuResponse, LcuTransport, RequestOptions } from "./transport.ts"
import { LcuTransportError, expectOk, isClientClosed, isOk, jsonOf } from "./transport.ts"

/** The game process is either up or it is not; every call degrades to `null` rather than throwing. */
const LIVE: RequestOptions = { target: "live" }

export interface LiveClientOptions {
	/** Default riotId for the per-player endpoints. */
	riotId?: string
	onWarn?: (message: string) => void
}

export class LiveClient {
	readonly transport: LcuTransport
	readonly riotId: string
	#warn: (message: string) => void

	constructor(transport: LcuTransport, opts: LiveClientOptions = {}) {
		this.transport = transport
		this.riotId = opts.riotId ?? USER_RIOT_ID
		this.#warn = opts.onWarn ?? (msg => console.warn(`[live] ${msg}`))
	}

	/** Escape hatch for endpoints this class does not wrap (e.g. `/swagger/v3/openapi.json`). */
	request(
		method: HttpMethod,
		path: string,
		body?: unknown,
		opts?: RequestOptions
	): Promise<LcuResponse> {
		return this.transport.request(method, path, body, { ...LIVE, ...opts })
	}

	/**
	 * Is the game process answering? True during a live game AND during replay playback.
	 * Never throws: a closed game is the normal case.
	 */
	async isAlive(): Promise<boolean> {
		try {
			const res = await this.request("GET", "/liveclientdata/gamestats", undefined, {
				timeoutMs: 3000
			})
			return isOk(res)
		} catch {
			return false
		}
	}

	/* --------------------------------------------------- live client data */

	/** One call, everything: ~32 KB in ~28 ms. This is what the in-game sampler polls. */
	async allGameData(sinceEventId?: number): Promise<LiveAllGameDataType | null> {
		const query = sinceEventId === undefined ? "" : `?eventID=${Math.max(0, Math.floor(sinceEventId))}`
		return this.#get(`/liveclientdata/allgamedata${query}`, LiveAllGameData, "allgamedata")
	}

	/** `gameTime` is SECONDS as a float, on the same clock as replay `Playback.time`. */
	async gameStats(): Promise<LiveGameStatsType | null> {
		return this.#get("/liveclientdata/gamestats", LiveGameStats, "gamestats")
	}

	/**
	 * All ten players, or one team when `teamId` is given. `position` here is RELIABLE, unlike
	 * the match-history `timeline.lane`.
	 *
	 * Validated PER PLAYER: one odd entry (a practice-tool bot, a champion whose payload gained
	 * a field shape we did not anticipate) drops that entry with a warning instead of throwing
	 * the whole roster away. Observed live on 16.17 in a PRACTICETOOL game, where the whole-array
	 * validation failed — hence this belt and braces.
	 */
	async playerList(teamId?: 100 | 200): Promise<LivePlayerListType | null> {
		const query = teamId === undefined ? "" : `?teamID=${teamId === 200 ? "CHAOS" : "ORDER"}`
		const raw = await this.#getRaw(`/liveclientdata/playerlist${query}`)
		if (raw === null) return null
		if (!Array.isArray(raw)) {
			this.#warn(`playerlist was not an array: ${JSON.stringify(raw).slice(0, 200)}`)
			return null
		}
		const players: LivePlayerListType = []
		let dropped = 0
		for (const entry of raw) {
			const parsed = LivePlayer(entry)
			if (parsed instanceof arkType.errors) {
				dropped += 1
				this.#warn(`playerlist entry rejected: ${parsed.summary}`)
			} else players.push(parsed as LivePlayerListType[number])
		}
		if (dropped) this.#warn(`playerlist: kept ${players.length}, dropped ${dropped}`)
		return players
	}

	/**
	 * `allgamedata` with NO validation.
	 *
	 * The in-game sampler journals every poll to `live.ndjson.gz`, and that journal is the only
	 * unrecoverable data source this app has — a game that has ended can never be re-sampled.
	 * So the sampler should persist THIS, and use `allGameData()` for anything it reasons about.
	 * Never let a schema surprise cost us a sample we can never take again.
	 */
	async allGameDataRaw(sinceEventId?: number): Promise<unknown> {
		const query = sinceEventId === undefined ? "" : `?eventID=${Math.max(0, Math.floor(sinceEventId))}`
		return this.#getRaw(`/liveclientdata/allgamedata${query}`)
	}

	/**
	 * `EventID` increases monotonically; pass the next id you expect and dedupe on it.
	 * `EventTime` is the calibration source for seeking a replay to a known moment.
	 */
	async eventData(sinceEventId?: number): Promise<LiveEventDataType | null> {
		const query = sinceEventId === undefined ? "" : `?eventID=${Math.max(0, Math.floor(sinceEventId))}`
		return this.#get(`/liveclientdata/eventdata${query}`, LiveEventData, "eventdata")
	}

	/**
	 * The local player's stats/runes/abilities.
	 *
	 * Expect this to be **unavailable during replay playback** — the binary carries an explicit
	 * refusal string ("Spectator mode and replay mode don't currently support this feature")
	 * next to this handler, because a replay has no single active player. `playerlist`,
	 * `gamestats` and `eventdata` should still answer.
	 */
	async activePlayer(): Promise<LiveActivePlayerType | null> {
		return this.#get("/liveclientdata/activeplayer", LiveActivePlayer, "activeplayer")
	}

	/**
	 * Per-player endpoints take `riotId` in `Name#TAG` form — **not** `summonerName`, which
	 * now 400s. The `#` must be URL-encoded.
	 */
	async playerScores(riotId = this.riotId): Promise<unknown> {
		return this.#getRaw(`/liveclientdata/playerscores?riotId=${encodeURIComponent(riotId)}`)
	}

	async playerItems(riotId = this.riotId): Promise<unknown> {
		return this.#getRaw(`/liveclientdata/playeritems?riotId=${encodeURIComponent(riotId)}`)
	}

	async playerSummonerSpells(riotId = this.riotId): Promise<unknown> {
		return this.#getRaw(
			`/liveclientdata/playersummonerspells?riotId=${encodeURIComponent(riotId)}`
		)
	}

	async playerMainRunes(riotId = this.riotId): Promise<unknown> {
		return this.#getRaw(`/liveclientdata/playermainrunes?riotId=${encodeURIComponent(riotId)}`)
	}

	/**
	 * The game client's own OpenAPI document. During a live game this describes only
	 * `/liveclientdata`; **during a replay it gains the whole `/replay` group**, which is the
	 * authoritative source for everything marked UNVERIFIED in `replay-schema.ts`.
	 * Fetch and store it the first time a replay session comes up.
	 */
	async openapi(): Promise<unknown> {
		return this.#getRaw("/swagger/v3/openapi.json", 30_000)
	}

	/* ---------------------------------------------------------- replay API */

	/**
	 * `GET /replay/game`. A 404 here is the definitive "we are not in a replay" signal — the
	 * `/replay/*` handlers are registered only during playback (verified 404 on all six paths
	 * during a live game).
	 */
	async replayGame(): Promise<ReplayGameInfoType | null> {
		return this.#get("/replay/game", ReplayGameInfo, "replay/game")
	}

	/** True when the Replay API is registered, i.e. a replay is actually playing. */
	async replayApiUp(): Promise<boolean> {
		return (await this.replayGame()) !== null
	}

	async playback(): Promise<ReplayPlaybackType | null> {
		return this.#get("/replay/playback", ReplayPlayback, "replay/playback")
	}

	/**
	 * Seek / play / pause. All fields optional.
	 *
	 * `time` is game-clock **seconds** — `timelineEvent.timestamp / 1000`. After a seek, poll
	 * `playback()` until `seeking === false` and `|time - target|` is small; do not sleep a
	 * fixed amount. Order a capture list by ascending time so every seek is a short forward
	 * scrub rather than a rewind from a keyframe.
	 */
	async setPlayback(patch: ReplayPlaybackPatch): Promise<ReplayPlaybackType | null> {
		return this.#post("/replay/playback", patch, ReplayPlayback, "replay/playback")
	}

	async render(): Promise<ReplayRenderType | null> {
		return this.#get("/replay/render", ReplayRender, "replay/render")
	}

	/**
	 * Camera and scene. All fields optional; send only what you want changed.
	 *
	 * `cameraMode`, `cameraAttached`, `fogOfWar` and every `interface*` / `healthBar*` toggle
	 * are NOT animatable through `/replay/sequence`, so they must be set here before recording.
	 */
	async setRender(patch: ReplayRenderPatch): Promise<ReplayRenderType | null> {
		return this.#post("/replay/render", patch, ReplayRender, "replay/render")
	}

	async recording(): Promise<ReplayRecordingType | null> {
		return this.#get("/replay/recording", ReplayRecording, "replay/recording")
	}

	/**
	 * Start a recording, then poll `recording()` until `recording === false`
	 * ("Poll this resource for progress on the output").
	 *
	 * `path` must be a **Windows** path. For `codec: "png"` it is a DIRECTORY — the codec
	 * writes one PNG per frame — so a screenshot is a one-frame window whose single file you
	 * then pick out of that directory. There is no `jpg` codec in 16.17.
	 */
	async record(opts: ReplayRecordRequest): Promise<ReplayRecordingType | null> {
		return this.#post(
			"/replay/recording",
			{
				framesPerSecond: 30,
				enforceFrameRate: true,
				replaySpeed: 1,
				...opts
			},
			ReplayRecording,
			"replay/recording",
			30_000
		)
	}

	async sequence(): Promise<ReplaySequence | null> {
		const value = await this.#getRaw("/replay/sequence")
		return value && typeof value === "object" ? (value as ReplaySequence) : null
	}

	/** POST an empty object to remove the current sequence. */
	async setSequence(sequence: ReplaySequence): Promise<unknown> {
		const res = await this.request("POST", "/replay/sequence", sequence)
		if (res.status === 404) return null
		return jsonOf(expectOk(res, "replay/sequence"), "replay/sequence")
	}

	/**
	 * Live world coordinates for everything in the scene at the current replay time — far
	 * better than interpolating the 60-second-granularity match timeline.
	 *
	 * Use it to resolve `selectionName`: fetch `types: ["hero"]`, find the object whose
	 * `characterName` matches the champion you want to discuss, and feed that exact string to
	 * `setRender({ selectionName })`. Whether `selectionName` matches on champion name,
	 * summoner name or object name is unverified — this round trip removes the guesswork.
	 */
	async objects(
		opts: { types?: readonly string[]; detail?: boolean } = {}
	): Promise<ReplayObjectType[] | null> {
		const params: string[] = []
		if (opts.types?.length) params.push(`types=${encodeURIComponent(opts.types.join(","))}`)
		if (opts.detail) params.push("detail=true")
		const query = params.length ? `?${params.join("&")}` : ""
		const raw = await this.#getRaw(`/replay/objects${query}`)
		if (raw === null) return null
		// UNVERIFIED whether the payload is `{objects:[…]}` or a bare array. Accept both.
		const list =
			Array.isArray(raw) ? raw
			: raw && typeof raw === "object" && Array.isArray((raw as { objects?: unknown }).objects) ?
				(raw as { objects: unknown[] }).objects
			:	null
		if (!list) {
			this.#warn(`/replay/objects returned an unexpected shape: ${JSON.stringify(raw).slice(0, 200)}`)
			return null
		}
		return list.flatMap(entry => {
			const parsed = parseOrNull(ReplayObject, entry)
			return parsed ? [parsed] : []
		})
	}

	/**
	 * Hide objects by netId (`false` hides). Riot: "Hidden objects are re-applied every frame
	 * so the replay stream cannot turn them back on." Useful for decluttering a coaching shot.
	 */
	async setObjectVisibility(visibility: Record<string, boolean>): Promise<unknown> {
		const res = await this.request("POST", "/replay/objects/visibility", visibility)
		if (res.status === 404) return null
		return jsonOf(expectOk(res, "replay/objects/visibility"), "replay/objects/visibility")
	}

	/**
	 * The replay's own pre-indexed moments (kills, objectives, multikills). Undocumented by
	 * Riot and unverified — if it works as advertised it is the cheapest moment index there is.
	 */
	async replayEvents(): Promise<unknown> {
		return this.#getRaw("/replay/events")
	}

	/**
	 * Ask the game process to quit. Documented on `:2999` alongside `/Cancel` and `/Help`, but
	 * whether it cleanly ends a REPLAY is unverified. Confirm teardown by polling the LCU's
	 * `/lol-gameflow/v1/watch` until `"None"`; if it never gets there, kill the pid from
	 * `replayGame().processID` — never by image name, which would kill a live game.
	 */
	async exit(): Promise<boolean> {
		try {
			const res = await this.request("POST", "/Exit", undefined, { timeoutMs: 5000 })
			return isOk(res)
		} catch (err) {
			// The process dying mid-request is the success case here.
			return isClientClosed(err)
		}
	}

	/* ---------------------------------------------------------------- inner */

	async #get<t>(path: string, validator: Type<t>, context: string): Promise<t | null> {
		let res: LcuResponse
		try {
			res = await this.request("GET", path)
		} catch (err) {
			if (isClientClosed(err)) return null
			throw err
		}
		if (res.status === 404) return null
		expectOk(res, context)
		// Report WHICH field disagreed, not just "it did not validate" — a schema surprise from
		// a patch has to be diagnosable from the log alone.
		const parsed = validator(jsonOf(res, context))
		if (parsed instanceof arkType.errors) {
			this.#warn(`${context} did not match its schema; ignoring. ${parsed.summary}`)
			return null
		}
		return parsed as t
	}

	async #post<t>(
		path: string,
		body: unknown,
		validator: Type<t>,
		context: string,
		timeoutMs?: number
	): Promise<t | null> {
		let res: LcuResponse
		try {
			res = await this.request("POST", path, body, timeoutMs ? { timeoutMs } : undefined)
		} catch (err) {
			if (isClientClosed(err)) return null
			throw err
		}
		if (res.status === 404) return null
		expectOk(res, context)
		if (res.body === "") return null
		return parseOrNull(validator, jsonOf(res, context))
	}

	async #getRaw(path: string, timeoutMs?: number): Promise<unknown> {
		let res: LcuResponse
		try {
			res = await this.request("GET", path, undefined, timeoutMs ? { timeoutMs } : undefined)
		} catch (err) {
			if (isClientClosed(err)) return null
			throw err
		}
		if (res.status === 404) return null
		expectOk(res, path)
		return jsonOf(res, path)
	}
}

/* ------------------------------------------------------------ camera math */

/**
 * Map a match-timeline ground position onto a replay `cameraPosition`.
 *
 * Timeline `position.{x,y}` are raw engine world coordinates on the ground plane; the engine
 * is **Y-up**, so the timeline's `y` becomes the camera's `z` and the camera's `y` is height.
 *
 * **This axis mapping is UNVERIFIED** (`replay-capture.md` §5.2) and is the single
 * highest-value thing to calibrate the first time a replay runs. The recipe needs no
 * guesswork: let the directed camera follow a champion, then read `GET /replay/render` and
 * `GET /replay/objects?types=hero&detail=true` at the same instant and compare. Two or three
 * samples settle the axis order, the signs, and the game's own default height and pitch.
 * Store those measured numbers in the repo and replace the defaults below.
 */
export const groundToCamera = (
	pos: { x: number; y: number },
	height = DEFAULT_CAMERA_HEIGHT
): Vector3f => ({ x: pos.x, y: height, z: pos.y })

/** A guess, pending the calibration above. League's own top-down camera sits ~1650 units up. */
export const DEFAULT_CAMERA_HEIGHT = 1650

/** A steep look-down, in the Euler degrees `cameraRotation` wants. Also pending calibration. */
export const DEFAULT_CAMERA_ROTATION: Vector3f = { x: 60, y: 0, z: 0 }

/**
 * Render settings that turn a replay frame into a *coaching* frame.
 *
 * `fogOfWar: false` is the killer feature — it shows what the enemy was doing while you could
 * not see them, which no normal replay viewer can do. The rest is decluttering.
 */
export const COACHING_RENDER_PRESET: ReplayRenderPatch = {
	fogOfWar: false,
	interfaceAll: false,
	interfaceMinimap: true,
	interfaceScore: true,
	interfaceNeutralTimers: true,
	outlineSelect: true,
	floatingText: true,
	healthBarChampions: true,
	healthBarMinions: false,
	healthBarWards: true,
	healthBarStructures: true
}

/** Restore a normal-looking replay after a capture session. */
export const DEFAULT_RENDER_PRESET: ReplayRenderPatch = {
	fogOfWar: true,
	interfaceAll: true,
	outlineSelect: false,
	healthBarMinions: true
}

/** A raised, tilted-back framing offset for `selectionName` follow shots. */
export const DEFAULT_SELECTION_OFFSET: Vector3f = { x: 0, y: 1400, z: -900 }

/** Guard: an epsilon-wide window, because `startTime === endTime` may emit zero frames. */
export const SCREENSHOT_EPSILON_SEC = 0.04

export const screenshotRequest = (
	windowsDir: string,
	atSec: number,
	size: { width?: number; height?: number } = {}
): ReplayRecordRequest => ({
	codec: "png",
	path: windowsDir,
	startTime: atSec,
	endTime: atSec + SCREENSHOT_EPSILON_SEC,
	framesPerSecond: 30,
	enforceFrameRate: true,
	lossless: true,
	replaySpeed: 1,
	...size
})

export const clipRequest = (
	windowsFile: string,
	startSec: number,
	endSec: number,
	size: { width?: number; height?: number; framesPerSecond?: number } = {}
): ReplayRecordRequest => ({
	codec: "webm",
	path: windowsFile,
	startTime: startSec,
	endTime: endSec,
	framesPerSecond: size.framesPerSecond ?? 30,
	enforceFrameRate: true,
	lossless: false,
	replaySpeed: 1,
	width: size.width,
	height: size.height
})

/** Unused import guard is deliberate: re-export the error type callers will want to catch. */
export { LcuTransportError }
