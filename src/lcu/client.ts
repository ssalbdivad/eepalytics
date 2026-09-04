/**
 * The typed LCU API. Every method validates its response with the ArkType schemas in
 * `src/shared/schema/lcu.ts` and throws a message that names the endpoint and the field.
 *
 * ## Conventions
 * - **404 is a state, not an error.** `/lol-replays/v1/metadata/{id}` 404s because the client
 *   has never created *local* metadata for that game — not because the replay expired.
 *   `/lol-champ-select/v1/session` 404s with `"No active delegate"` whenever you are not in
 *   draft. Methods that model such a state return `null`; the rest throw `LcuHttpError`.
 * - **Client closed is not an error either.** Anything reaching the transport while League is
 *   shut down rejects with an `LcuTransportError` whose `code` passes `isClientClosed()`.
 * - **Nothing here mutates the client except the four methods marked MUTATES.**
 */

import type { Type } from "arktype"
import { PLATFORM_ID, USER_PUUID } from "../shared/constants.ts"
import type {
	ChampionSummary as ChampionSummaryType,
	CurrentSummoner as CurrentSummonerType,
	GameflowPhase as GameflowPhaseType,
	GameflowSession as GameflowSessionType,
	GameflowWatchPhase as GameflowWatchPhaseType,
	LcuGame as LcuGameType,
	LcuMatchHistory as LcuMatchHistoryType,
	LcuTimeline as LcuTimelineType,
	ReplayConfiguration as ReplayConfigurationType,
	ReplayMetadata as ReplayMetadataType,
	SummonerSpellSummary as SummonerSpellSummaryType
} from "../shared/schema/lcu.ts"
import {
	ChampionSummary,
	CurrentSummoner,
	GameflowPhase,
	GameflowSession,
	GameflowWatchPhase,
	LcuGame,
	LcuMatchHistory,
	LcuTimeline,
	ReplayConfiguration,
	ReplayMetadata,
	SummonerSpellSummary,
	parseOrThrow
} from "../shared/schema/lcu.ts"
import type { HttpMethod, LcuResponse, LcuTransport, RequestOptions } from "./transport.ts"
import { LcuTransportError, expectOk, isOk, jsonOf } from "./transport.ts"

export interface LcuClientOptions {
	/** Whose match history we read. Defaults to the configured user. */
	puuid?: string
	/** Where non-fatal surprises are reported (an unrecognised gameflow phase, say). */
	onWarn?: (message: string) => void
}

/** Body of `POST /lol-replays/v2/metadata/{gameId}/create`, from the client's own type table. */
export interface ReplayCreateMetadata {
	gameVersion: string
	gameType: string
	queueId: number
	/** Epoch **ms** of game end. `LolReplaysReplayCreateMetadata.gameEnd` is a uint64. */
	gameEnd: number
}

export class LcuClient {
	readonly transport: LcuTransport
	readonly puuid: string
	#warn: (message: string) => void

	constructor(transport: LcuTransport, opts: LcuClientOptions = {}) {
		this.transport = transport
		this.puuid = opts.puuid ?? USER_PUUID
		this.#warn = opts.onWarn ?? (msg => console.warn(`[lcu] ${msg}`))
	}

	/** Escape hatch for endpoints this class does not wrap. */
	request(
		method: HttpMethod,
		path: string,
		body?: unknown,
		opts?: RequestOptions
	): Promise<LcuResponse> {
		return this.transport.request(method, path, body, opts)
	}

	/* -------------------------------------------------------------- identity */

	async currentSummoner(): Promise<CurrentSummonerType> {
		return this.#getJson("/lol-summoner/v1/current-summoner", CurrentSummoner, "current-summoner")
	}

	/** True when the client answers at all. Used by health checks; never throws. */
	async ping(): Promise<boolean> {
		try {
			const res = await this.transport.request("GET", "/lol-summoner/v1/current-summoner")
			return isOk(res)
		} catch {
			return false
		}
	}

	/* -------------------------------------------------------------- gameflow */

	/**
	 * `GET /lol-gameflow/v1/gameflow-phase` returns a BARE JSON STRING like `"InProgress"`.
	 *
	 * An unrecognised value (Riot adds a phase) is warned about and returned as-is rather than
	 * thrown: `isIdlePhase()` fails closed on anything it does not know, so an unknown phase
	 * makes the intrusive-job gate *more* conservative, which is the safe direction.
	 */
	async gameflowPhase(): Promise<GameflowPhaseType> {
		const res = expectOk(
			await this.transport.request("GET", "/lol-gameflow/v1/gameflow-phase"),
			"gameflow-phase"
		)
		const value = jsonOf(res, "gameflow-phase")
		if (typeof value !== "string")
			throw new LcuTransportError("PROTOCOL", `gameflow-phase was not a string: ${res.body}`)
		// ArkType returns either the validated value (a string here) or a `type.errors` array.
		const checked = GameflowPhase(value)
		if (typeof checked === "string") return checked
		this.#warn(`unknown gameflow phase ${JSON.stringify(value)} — treating it as "busy"`)
		return value as GameflowPhaseType
	}

	/** `"None"` unless a REPLAY is playing. This is how you tell a replay from a live game. */
	async gameflowWatch(): Promise<GameflowWatchPhaseType> {
		const res = expectOk(
			await this.transport.request("GET", "/lol-gameflow/v1/watch"),
			"gameflow-watch"
		)
		const value = jsonOf(res, "gameflow-watch")
		const checked = GameflowWatchPhase(value)
		if (typeof checked === "string") return checked
		this.#warn(`unknown watch phase ${JSON.stringify(value)} — treating it as "busy"`)
		return value as GameflowWatchPhaseType
	}

	/**
	 * The single best "what is happening right now" call: phase, the CURRENT gameId (available
	 * mid-game, which nothing else gives you), both rosters with puuids, and `selectedPosition`.
	 */
	async gameflowSession(): Promise<GameflowSessionType | null> {
		return this.#getJsonOrNull(
			"/lol-gameflow/v1/session",
			GameflowSession,
			"gameflow-session"
		)
	}

	/** `gameData.gameId` from the live session, or `null` when no game is running. */
	async currentGameId(): Promise<number | null> {
		const session = await this.gameflowSession()
		const id = session?.gameData?.gameId
		return typeof id === "number" && id > 0 ? id : null
	}

	/* --------------------------------------------------------- match history */

	/**
	 * `GET /lol-match-history/v1/products/lol/{puuid}/matches`.
	 *
	 * **`begIndex`/`endIndex` are silently ignored on 16.17** — every range returns the same
	 * server-chosen recent window (observed 5, 20 and 21 games at different moments, and it can
	 * SHRINK under you mid-session). There is no pagination and no backfill. The only way to
	 * build deep history is to poll this, union the gameIds into SQLite, and hydrate each one
	 * through `game()` / `timeline()`, which accept arbitrary ids for at least 21 days.
	 *
	 * Entries here carry only ONE participant (the queried summoner). Call `game()` for the
	 * other nine.
	 */
	async matchHistory(puuid = this.puuid): Promise<LcuMatchHistoryType> {
		return this.#getJson(
			`/lol-match-history/v1/products/lol/${encodeURIComponent(puuid)}/matches`,
			LcuMatchHistory,
			`match-history ${puuid}`,
			{ timeoutMs: 30_000 }
		)
	}

	/** Newest-first gameIds from the current history window. Convenience over `matchHistory`. */
	async recentGameIds(puuid = this.puuid): Promise<number[]> {
		const history = await this.matchHistory(puuid)
		return history.games.games
			.map(g => g.gameId)
			.filter(id => Number.isFinite(id))
			.sort((a, b) => b - a)
	}

	/** Full 10-participant match. `null` on 404, which means "no such gameId", not "expired". */
	async game(gameId: number): Promise<LcuGameType | null> {
		return this.#getJsonOrNull(
			`/lol-match-history/v1/games/${gameId}`,
			LcuGame,
			`game ${gameId}`,
			{ timeoutMs: 30_000 }
		)
	}

	/**
	 * One frame per minute, three event types, no `frameInterval` field.
	 * `frames.length === floor(gameDuration / 60) + 2` held on 22/22 games.
	 */
	async timeline(gameId: number): Promise<LcuTimelineType | null> {
		return this.#getJsonOrNull(
			`/lol-match-history/v1/game-timelines/${gameId}`,
			LcuTimeline,
			`timeline ${gameId}`,
			{ timeoutMs: 30_000 }
		)
	}

	/* ---------------------------------------------------------------- ranked */

	/** Raw because the shape is 10 KB of queue maps we only cherry-pick from. */
	async rankedStats(): Promise<unknown> {
		const res = await this.transport.request("GET", "/lol-ranked/v1/current-ranked-stats")
		if (res.status === 404) return null
		return jsonOf(expectOk(res, "ranked-stats"), "ranked-stats")
	}

	/* --------------------------------------------------------------- replays */

	/**
	 * The gate for everything replay-related: `isPlayingGame`, `isPlayingReplay`, `isPatching`,
	 * and `minutesUntilReplayConsideredLost` (30 when measured — read it, do not hardcode it).
	 */
	async replayConfiguration(): Promise<ReplayConfigurationType> {
		return this.#getJson(
			"/lol-replays/v1/configuration",
			ReplayConfiguration,
			"replay-configuration"
		)
	}

	/**
	 * `null` means the client has no LOCAL metadata record for this game yet — POST
	 * `createReplayMetadata()` first, then this becomes the download-progress poll.
	 * It does NOT mean the replay expired; that is `state: "missingOrExpired"`.
	 */
	async replayMetadata(gameId: number): Promise<ReplayMetadataType | null> {
		return this.#getJsonOrNull(
			`/lol-replays/v1/metadata/${gameId}`,
			ReplayMetadata,
			`replay-metadata ${gameId}`
		)
	}

	/** Where the client writes `.rofl` files, as a WINDOWS path. */
	async roflPath(): Promise<string> {
		const res = expectOk(
			await this.transport.request("GET", "/lol-replays/v1/rofls/path"),
			"rofls-path"
		)
		const value = jsonOf(res, "rofls-path")
		if (typeof value !== "string")
			throw new LcuTransportError("PROTOCOL", `rofls/path was not a string: ${res.body}`)
		return value
	}

	/** @deprecated Spelling kept only because an early contract named it this. Use `roflPath`. */
	rooflPath(): Promise<string> {
		return this.roflPath()
	}

	async roflPathDefault(): Promise<string> {
		const res = expectOk(
			await this.transport.request("GET", "/lol-replays/v1/rofls/path/default"),
			"rofls-path-default"
		)
		const value = jsonOf(res, "rofls-path-default")
		return typeof value === "string" ? value : ""
	}

	/**
	 * MUTATES (client-local only). Create the local metadata record a download needs.
	 *
	 * `gameVersion`, `gameType` and `queueId` come straight off the match-history entry;
	 * `gameEnd` is `gameCreation + gameDuration * 1000`.
	 */
	async createReplayMetadata(gameId: number, meta: ReplayCreateMetadata): Promise<void> {
		expectOk(
			await this.transport.request(
				"POST",
				`/lol-replays/v2/metadata/${gameId}/create`,
				meta,
				{ timeoutMs: 20_000 }
			),
			`create replay metadata ${gameId}`
		)
	}

	/**
	 * MUTATES. Ask the client to fetch the `.rofl` from Riot. Non-intrusive: it downloads in
	 * the background and does not take over the client — but it is URGENT, because replays are
	 * gone ~30 minutes after the game ends.
	 *
	 * `componentType` is telemetry only; the client logs it and never branches on it.
	 * `graceful` uses `/download/graceful`, which is what the client's own UI calls.
	 */
	async downloadReplay(
		gameId: number,
		opts: { componentType?: string; graceful?: boolean } = {}
	): Promise<void> {
		const suffix = opts.graceful === false ? "download" : "download/graceful"
		expectOk(
			await this.transport.request(
				"POST",
				`/lol-replays/v1/rofls/${gameId}/${suffix}`,
				{ componentType: opts.componentType ?? "fawnsei" },
				{ timeoutMs: 20_000 }
			),
			`download replay ${gameId}`
		)
	}

	/**
	 * MUTATES, INTRUSIVELY. **Launches the League game client into replay playback**, taking
	 * over the user's machine for 15-30 s of load plus however long the capture runs.
	 *
	 * Written here so the capture unit has one correct implementation. It must only ever be
	 * called behind the daemon's idle gate (client idle, `isPlayingGame:false`,
	 * `isPlayingReplay:false`, gameflow `None`/`Lobby`, watch `None`). Nothing in the LCU unit
	 * calls it, and nothing verified it — the research phase deliberately issued no POSTs.
	 */
	async watchReplay(gameId: number, componentType = "fawnsei"): Promise<void> {
		expectOk(
			await this.transport.request(
				"POST",
				`/lol-replays/v1/rofls/${gameId}/watch`,
				{ componentType },
				{ timeoutMs: 30_000 }
			),
			`watch replay ${gameId}`
		)
	}

	/** MUTATES (client-local). Rescan the replays folder so on-disk files are recognised. */
	async scanReplays(): Promise<void> {
		expectOk(
			await this.transport.request("POST", "/lol-replays/v1/rofls/scan", undefined, {
				timeoutMs: 20_000
			}),
			"scan replays"
		)
	}

	/* ----------------------------------------------------------- static data */

	/**
	 * `/lol-game-data/assets/...` — champion/item/rune JSON and icons, served locally.
	 *
	 * These require auth (an unauthenticated GET 401s) and the paths are already rooted at
	 * `/lol-game-data/assets/`, so prepend nothing. **Never hand-build an item icon path**:
	 * item 3047 is "Plated Steelcaps" but its file is `3047_Class_T2_NinjaTabi.png`, and a
	 * wrong-cased path 400s. Read `iconPath` out of `items.json`.
	 */
	async asset(assetPath: string): Promise<Buffer> {
		const res = expectOk(
			await this.transport.request("GET", assetPath, undefined, {
				binary: true,
				timeoutMs: 30_000
			}),
			`asset ${assetPath}`
		)
		return res.buffer ?? Buffer.from(res.body, "utf8")
	}

	/** Stream an asset straight to a WSL path (icons, splash art). */
	async assetToFile(assetPath: string, destWslPath: string): Promise<number> {
		const res = expectOk(
			await this.transport.request("GET", assetPath, undefined, {
				toFile: destWslPath,
				timeoutMs: 60_000
			}),
			`asset ${assetPath} -> ${destWslPath}`
		)
		return res.bytes
	}

	/** A JSON asset, optionally validated. `items.json` is 683 KB; `skins.json` is 5.9 MB. */
	async assetJson<t>(
		assetPath: string,
		validator?: Type<t>,
		timeoutMs = 60_000
	): Promise<t | unknown> {
		const res = expectOk(
			await this.transport.request("GET", assetPath, undefined, { timeoutMs }),
			`asset ${assetPath}`
		)
		const parsed = jsonOf(res, `asset ${assetPath}`)
		return validator ? parseOrThrow(validator, parsed, `asset ${assetPath}`) : parsed
	}

	/** 237 entries. `alias` is the Data Dragon key (`MonkeyKing` for Wukong). */
	async championSummary(): Promise<ChampionSummaryType> {
		return (await this.assetJson(
			"/lol-game-data/assets/v1/champion-summary.json",
			ChampionSummary
		)) as ChampionSummaryType
	}

	/** 420 entries — the authoritative queue table, far better than any hardcoded map. */
	async queues(): Promise<unknown> {
		return this.assetJson("/lol-game-data/assets/v1/queues.json")
	}

	async items(): Promise<unknown> {
		return this.assetJson("/lol-game-data/assets/v1/items.json")
	}

	async perks(): Promise<unknown> {
		return this.assetJson("/lol-game-data/assets/v1/perks.json")
	}

	async summonerSpells(): Promise<unknown> {
		return this.assetJson("/lol-game-data/assets/v1/summoner-spells.json")
	}

	/**
	 * The same file, validated: `id` -> Flash / Smite / Teleport / … .
	 *
	 * Pre-game coaching needs spell NAMES, and the alternative to reading them is a table typed
	 * from memory — a fabrication that happens to be usually right, which is not a standard this
	 * app holds anywhere else.
	 */
	async summonerSpellSummary(): Promise<SummonerSpellSummaryType> {
		return (await this.assetJson(
			"/lol-game-data/assets/v1/summoner-spells.json",
			SummonerSpellSummary
		)) as SummonerSpellSummaryType
	}

	/** `NA1-5631300987.rofl` — the on-disk filename convention. */
	roflFileName(gameId: number, platformId = PLATFORM_ID): string {
		return `${platformId}-${gameId}.rofl`
	}

	/* ---------------------------------------------------------------- inner */

	async #getJson<t>(
		path: string,
		validator: Type<t>,
		context: string,
		opts?: RequestOptions
	): Promise<t> {
		const res = expectOk(await this.transport.request("GET", path, undefined, opts), context)
		return parseOrThrow(validator, jsonOf(res, context), context)
	}

	/** As `#getJson`, but a 404 (a modelled "not here yet" state) yields `null`. */
	async #getJsonOrNull<t>(
		path: string,
		validator: Type<t>,
		context: string,
		opts?: RequestOptions
	): Promise<t | null> {
		const res = await this.transport.request("GET", path, undefined, opts)
		if (res.status === 404) return null
		expectOk(res, context)
		return parseOrThrow(validator, jsonOf(res, context), context)
	}
}
