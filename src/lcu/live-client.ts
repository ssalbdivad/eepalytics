/**
 * Client for the game process's own HTTP API on `127.0.0.1:2999`.
 *
 * **Live Client Data** (`/liveclientdata/*`) — registered during a live game. No auth,
 * self-signed cert. Fully verified against a running game. It fills the LCU timeline's biggest
 * gaps: live item builds (diff `items` between polls to reconstruct purchases), ability levels,
 * rune shards, and a RELIABLE `position` role. It cannot give you x/y coordinates for anybody —
 * those only come from the post-game timeline, one frame per minute.
 *
 * The game process also serves a **Replay API** (`/replay/*`) while a replay is playing, which
 * can seek, move the camera and record PNGs and webm. This file used to wrap all of it. That
 * wrapper existed for one caller, replay capture, which was removed after never completing a
 * single job in the app's history — its central defect was a camera that would not follow the
 * player, and the axis mapping it needed was never calibrated. The findings are preserved in
 * `.research/replay-capture.md`; the client code is gone rather than sitting here inviting a
 * second attempt at driving the user's game client.
 *
 * Same WSL2 constraint as the LCU: every request goes through the Windows-side transport with
 * `target: "live"`. There is no Authorization header on this port.
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
	 * Is the game process answering? True while a game is in progress. Never throws: a closed
	 * game is the normal case.
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

	/** `gameTime` is SECONDS as a float — the clock the journal stamps its frames with. */
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
	 * `/liveclientdata`; during a replay it gains the whole `/replay` group. Nothing in this app
	 * plays a replay any more, so in practice this returns the live-data half.
	 */
	async openapi(): Promise<unknown> {
		return this.#getRaw("/swagger/v3/openapi.json", 30_000)
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

/** Unused import guard is deliberate: re-export the error type callers will want to catch. */
export { LcuTransportError }
