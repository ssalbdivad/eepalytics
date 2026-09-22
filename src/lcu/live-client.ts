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

import type { LiveAllGameData as LiveAllGameDataType } from "../shared/schema/live.ts"
import { parseAllGameData } from "../shared/schema/live.ts"
import type { HttpMethod, LcuResponse, LcuTransport, RequestOptions } from "./transport.ts"
import { expectOk, isClientClosed, jsonOf } from "./transport.ts"

/** The game process is either up or it is not; every call degrades to `null` rather than throwing. */
const LIVE: RequestOptions = { target: "live" }

/**
 * How long a repeat of the SAME schema complaint waits before it is allowed to speak again.
 *
 * Not a volume preference — a measurement. The one evening this boundary has ever failed put
 * **6,415 lines** into the journal in eighteen minutes (363 warning headers and 6,052
 * continuation lines; `journalctl --user -u eepalytics | grep -c "WARN  \[lcu\] allgamedata did
 * not match"`), and they were 363 copies of the same two sentences at about thirty a minute,
 * because the client is polled every two seconds and the fault was a property of the game mode
 * rather than of the moment. Every one of those lines said the same thing and the wall of them is
 * what made the fault look like noise instead of a game being discarded.
 *
 * So: the FIRST occurrence of a distinct complaint is logged in full, immediately, with
 * everything needed to diagnose it. A repeat of that same complaint is counted silently and
 * reported once a minute with the count attached, which is strictly louder than a wall — "x 30 in
 * the last 60s" is the scale of the problem, and 30 identical lines are not. A complaint nobody
 * has seen before is never delayed by this.
 */
export const WARN_REPEAT_EVERY_MS = 60_000

export interface LiveClientOptions {
	onWarn?: (message: string) => void
	/** Injected in tests so the repeat window can be exercised without waiting a minute. */
	now?: () => number
}

export class LiveClient {
	readonly transport: LcuTransport
	#warn: (message: string) => void
	#now: () => number
	/** signature -> when it was last spoken, and how many have been swallowed since. */
	#warnedAt = new Map<string, { at: number; since: number }>()

	constructor(transport: LcuTransport, opts: LiveClientOptions = {}) {
		this.transport = transport
		this.#warn = opts.onWarn ?? (msg => console.warn(`[live] ${msg}`))
		this.#now = opts.now ?? Date.now
	}

	/**
	 * Warn about `signature`, in full the first time and at most once a minute after that.
	 *
	 * `signature` is the part that identifies the FAULT — the field path and what was wrong with
	 * it — with nothing per-poll in it, so 356 polls of one broken game collapse to one line and a
	 * counter, while a second field going wrong is a new signature and speaks at once.
	 */
	#warnThrottled(signature: string, message: string): void {
		const now = this.#now()
		/*
		 * A ceiling on the memory, because a signature carries an array index.
		 *
		 * `drop:allPlayers[7].items:an array` is one entry per ROW per FIELD, so a genuinely novel
		 * feed could mint a few hundred. It cannot mint thousands — the paths come from a fixed
		 * schema over a roster of at most eighteen — but this process runs for weeks and an
		 * unbounded map inside a two-second poll is not a thing to leave to arithmetic. Clearing
		 * wholesale rather than evicting one: at this size the map is already telling us the feed
		 * has changed shape completely, and the honest response is to start the count over and let
		 * everything speak once more.
		 */
		if (this.#warnedAt.size > 512) this.#warnedAt.clear()
		const seen = this.#warnedAt.get(signature)
		if (seen && now - seen.at < WARN_REPEAT_EVERY_MS) {
			seen.since += 1
			return
		}
		const repeats = seen?.since ?? 0
		this.#warnedAt.set(signature, { at: now, since: 0 })
		this.#warn(repeats > 0 ? `${message} (x${repeats + 1} in the last ${Math.round((now - (seen?.at ?? now)) / 1000)}s)` : message)
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
	 * One call, everything: ~32 KB in ~28 ms. This is what the in-game sampler polls.
	 *
	 * DEGRADES TO LESS, NOT TO NOTHING. A field the feed got wrong is removed and named in the
	 * log; the rest of the payload is returned. `null` now means the payload could not be repaired
	 * into something valid at all. Measured: zero of the 20,067 recorded samples need a repair, and
	 * BOTH faults the journal recorded — the Arena `runes: null` and the practice-tool `items: {}`,
	 * injected onto all 19,564 recorded payloads that carry a roster — are kept rather than
	 * discarded (`data/eval/live-schema-audit-20260922.md`). See `parseAllGameData` for why the
	 * granularity is the field rather than the player row, and for what is still rejected outright.
	 */
	async allGameData(sinceEventId?: number): Promise<LiveAllGameDataType | null> {
		const query = sinceEventId === undefined ? "" : `?eventID=${Math.max(0, Math.floor(sinceEventId))}`
		let res: LcuResponse
		try {
			res = await this.request("GET", `/liveclientdata/allgamedata${query}`)
		} catch (err) {
			if (isClientClosed(err)) return null
			throw err
		}
		if (res.status === 404) return null
		expectOk(res, "allgamedata")
		const parsed = parseAllGameData(jsonOf(res, "allgamedata"))
		if (!parsed.ok) {
			/*
			 * The payload is gone. `parsed.dropped` is NOT logged here on purpose: on a rejection
			 * those removals were attempts that did not work, and saying "dropped X, the rest of
			 * the payload is being used" one line above "ignoring the whole payload" is two
			 * statements that contradict each other in the one place a person goes to find out
			 * what happened. How many were tried goes in this line instead.
			 *
			 * Report WHICH field disagreed, not just "it did not validate" — a schema surprise
			 * from a patch has to be diagnosable from the log alone.
			 */
			this.#warnThrottled(
				`reject:${parsed.summary}`,
				`allgamedata did not match its schema and could not be repaired (${parsed.dropped.length} field${parsed.dropped.length === 1 ? "" : "s"} removed and it still did not validate); ignoring the whole payload. ${parsed.summary}`
			)
			return null
		}
		for (const d of parsed.dropped)
			/*
			 * One line per distinct bad field, naming the PLAYER and the value that arrived.
			 *
			 * The value is in the line on purpose. The sampler records the object that comes back
			 * out of here, and that object no longer contains the bad field, so the journal is the
			 * only place the evidence can live — and the journal is exactly where the one real
			 * instance of this was found. A warning that says `must be an object (was null)` is
			 * enough to know a shape is wrong and not enough to know whose row it was, which is
			 * why `who` is here.
			 */
			this.#warnThrottled(
				`drop:${d.path}:${d.errorPath}:${d.expected}`,
				`allgamedata: dropped ${d.path}${d.who === "" ? "" : ` [${d.who}]`} because ${d.errorPath} expected ${d.expected} and got ${d.actual}. The rest of the payload is being used.`
			)
		return parsed.data
	}
}
