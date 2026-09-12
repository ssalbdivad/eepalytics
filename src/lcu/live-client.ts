/**
 * Client for the game process's own Live Client Data API on `127.0.0.1:2999`.
 *
 * Registered during a live game AND during replay playback. No auth, self-signed cert. Fully
 * verified against a running game. It fills the LCU timeline's biggest gaps: live item builds
 * (diff `items` between polls to reconstruct purchases), ability levels, rune shards, and a
 * RELIABLE `position` role. It cannot give you x/y coordinates for anybody — those only come
 * from the post-game timeline, one frame per minute.
 *
 * Same WSL2 constraint as the LCU: every request goes through the Windows-side transport with
 * `target: "live"`. There is no Authorization header on this port.
 *
 * **One method, on purpose.** The port also serves `/liveclientdata/gamestats`, `/playerlist`,
 * `/eventdata`, `/activeplayer` and four per-player endpoints, and this file used to wrap all of
 * them. Every one is a SUBSET of `allgamedata`, which is a single ~32 KB round trip in ~28 ms,
 * and `allgamedata` is the only call this app has ever made in anger. The wrappers were deleted
 * rather than kept as documentation: a second way to fetch the same field is a second thing that
 * can disagree with the ground-truth block.
 *
 * The `/replay/*` half of this port — playback, camera, recording, scene objects — went with the
 * replay-capture feature it existed for (`dcf3ad0`). It is registered only while a replay is
 * playing, and nothing plays replays any more.
 */

import { type as arkType } from "arktype"
import type { Type } from "arktype"
import type { LiveAllGameData as LiveAllGameDataType } from "../shared/schema/live.ts"
import { LiveAllGameData } from "../shared/schema/live.ts"
import type { HttpMethod, LcuResponse, LcuTransport, RequestOptions } from "./transport.ts"
import { expectOk, isClientClosed, jsonOf } from "./transport.ts"

/** The game process is either up or it is not; every call degrades to `null` rather than throwing. */
const LIVE: RequestOptions = { target: "live" }

export interface LiveClientOptions {
	onWarn?: (message: string) => void
}

export class LiveClient {
	readonly transport: LcuTransport
	#warn: (message: string) => void

	constructor(transport: LcuTransport, opts: LiveClientOptions = {}) {
		this.transport = transport
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

	/** One call, everything: ~32 KB in ~28 ms. This is what the in-game sampler polls. */
	async allGameData(sinceEventId?: number): Promise<LiveAllGameDataType | null> {
		const query = sinceEventId === undefined ? "" : `?eventID=${Math.max(0, Math.floor(sinceEventId))}`
		return this.#get(`/liveclientdata/allgamedata${query}`, LiveAllGameData, "allgamedata")
	}

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
}
