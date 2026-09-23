/**
 * ArkType validators for the Live Client Data API on port 2999.
 *
 * A SEPARATE HTTP service run by the GAME process, not the LCU. No authentication,
 * self-signed cert, and it only answers while `gameflow-phase === "InProgress"` (or while a
 * replay is playing — which is also how capture jobs read the replay clock).
 *
 * What it gives us that the post-game timeline cannot: live item builds (diff `items` between
 * polls to reconstruct purchases), ability levels, rune shards, live champion stats, and an
 * ACCURATE `position` per player.
 *
 * What it cannot give us: x/y coordinates for anybody. Positions only ever come from the
 * post-game timeline, at one frame per minute.
 *
 * Query parameter gotcha, contrary to every tutorial online: the per-player endpoints take
 * `riotId` (URL-encode the `#`), NOT `summonerName`.
 */

import { type } from "arktype"

/** `ORDER` is team 100 (blue), `CHAOS` is team 200 (red). */
export const LiveTeam = type("'ORDER'|'CHAOS'|'ALL'|'NEUTRAL'|'UNKNOWN'|string")
export type LiveTeam = typeof LiveTeam.infer

/** Unlike the match-history `timeline.lane`, THIS position field is reliable. */
export const LivePosition = type(
	"'TOP'|'JUNGLE'|'MIDDLE'|'BOTTOM'|'UTILITY'|''|string"
)
export type LivePosition = typeof LivePosition.infer

export const teamIdOfLiveTeam = (team: string): 100 | 200 =>
	team === "CHAOS" ? 200 : 100

/** `TOP|JUNGLE|MIDDLE|BOTTOM|UTILITY` -> our five-role vocabulary. */
export const roleOfLivePosition = (
	position: string
): "TOP" | "JGL" | "MID" | "ADC" | "SUP" | "UNKNOWN" =>
	position === "TOP" ? "TOP"
	: position === "JUNGLE" ? "JGL"
	: position === "MIDDLE" ? "MID"
	: position === "BOTTOM" ? "ADC"
	: position === "UTILITY" ? "SUP"
	: "UNKNOWN"

/* ------------------------------------------------------------------ pieces */

export const LiveScores = type({
	"kills?": "number",
	"deaths?": "number",
	"assists?": "number",
	"creepScore?": "number",
	"wardScore?": "number"
})
export type LiveScores = typeof LiveScores.infer

/** Slot 6 is the trinket. `count` matters for stacking consumables. */
export const LiveItem = type({
	"itemID?": "number",
	"slot?": "number",
	"count?": "number",
	"price?": "number",
	"displayName?": "string",
	"rawDisplayName?": "string",
	"consumable?": "boolean",
	"canUse?": "boolean"
})
export type LiveItem = typeof LiveItem.infer

export const LiveRune = type({
	"id?": "number",
	"displayName?": "string",
	"rawDisplayName?": "string",
	"rawDescription?": "string"
})
export type LiveRune = typeof LiveRune.infer

/**
 * The shape of a rune block WHEN THE FEED SENDS ONE — and it is no longer demanded anywhere.
 *
 * Kept as documentation and as a validator a future reader can point at. Both fields that used to
 * be declared as this type (`LivePlayer.runes` and `LiveActivePlayer.fullRunes`) are now `unknown`,
 * because the feed sends `null` for them in at least one game mode and NOTHING IN THIS APP READS
 * EITHER. See the comment on `LivePlayer.runes`.
 *
 * Measured over every recorded sample on disk
 * (`data/eval/live-schema-audit-20260922.json`, 20,067 samples / 195,817 player rows): a rune block
 * on an `allPlayers` row carries exactly `keystone`, `primaryRuneTree`, `secondaryRuneTree` — all
 * 195,817 of them, no exceptions. `generalRunes` and `statRunes` appear only under
 * `activePlayer.fullRunes`. That asymmetry is why this one type served both and why neither is
 * checked against it any more.
 */
export const LiveRunes = type({
	"keystone?": LiveRune,
	"primaryRuneTree?": LiveRune,
	"secondaryRuneTree?": LiveRune,
	"generalRunes?": LiveRune.array(),
	"statRunes?": LiveRune.array()
})
export type LiveRunes = typeof LiveRunes.infer

export const LiveSummonerSpell = type({
	"displayName?": "string",
	"rawDisplayName?": "string",
	"rawDescription?": "string"
})
export type LiveSummonerSpell = typeof LiveSummonerSpell.infer

export const LiveSummonerSpells = type({
	"summonerSpellOne?": LiveSummonerSpell,
	"summonerSpellTwo?": LiveSummonerSpell
})
export type LiveSummonerSpells = typeof LiveSummonerSpells.infer

/** 31 fields; all optional because none of them is load-bearing for coaching. */
export const LiveChampionStats = type({
	"abilityHaste?": "number",
	"abilityPower?": "number",
	"armor?": "number",
	"attackDamage?": "number",
	"attackRange?": "number",
	"attackSpeed?": "number",
	"critChance?": "number",
	"currentHealth?": "number",
	"maxHealth?": "number",
	"magicResist?": "number",
	"moveSpeed?": "number",
	"resourceValue?": "number",
	"resourceMax?": "number",
	"resourceType?": "string",
	"tenacity?": "number",
	"lifeSteal?": "number",
	"omnivamp?": "number",
	"spellVamp?": "number"
})
export type LiveChampionStats = typeof LiveChampionStats.infer

export const LiveAbility = type({
	"abilityLevel?": "number",
	"displayName?": "string",
	"id?": "string",
	"rawDescription?": "string"
})
export type LiveAbility = typeof LiveAbility.infer

export const LiveAbilities = type({
	"Passive?": LiveAbility,
	"Q?": LiveAbility,
	"W?": LiveAbility,
	"E?": LiveAbility,
	"R?": LiveAbility
})
export type LiveAbilities = typeof LiveAbilities.infer

/* ------------------------------------------------------------- endpoints */

/** `GET /liveclientdata/activeplayer` — only the local player has this level of detail. */
export const LiveActivePlayer = type({
	"riotId?": "string",
	"riotIdGameName?": "string",
	"riotIdTagLine?": "string",
	"summonerName?": "string",
	"level?": "number",
	"currentGold?": "number",
	"teamRelativeColors?": "boolean",
	"abilities?": LiveAbilities,
	/*
	 * `unknown` for the same reason `LivePlayer.runes` is, and NOT because a sample forced it.
	 *
	 * Said plainly so nobody quotes this as a measurement: no recorded sample has ever sent a
	 * bad `fullRunes` — all 20,065 samples that carry an `activePlayer` with keys at all carry it
	 * as an object. It is widened by SYMMETRY with the field one struct over, which the feed was
	 * observed sending as `null` on every row of every poll of a whole game, plus the fact that
	 * `grep -rn "fullRunes" src/ scripts/ --include=*.ts` returns only this declaration and the
	 * comments and tests that discuss it — no reader anywhere. A field no code reads may not be
	 * able to discard the fields every line of coaching depends on, and that argument does not get
	 * weaker because this particular one has not misbehaved yet.
	 */
	"fullRunes?": "unknown",
	"championStats?": LiveChampionStats
})
export type LiveActivePlayer = typeof LiveActivePlayer.infer

/** One entry of `GET /liveclientdata/playerlist`. */
export const LivePlayer = type({
	"riotId?": "string",
	"riotIdGameName?": "string",
	"riotIdTagLine?": "string",
	"summonerName?": "string",
	"championName?": "string",
	"rawChampionName?": "string",
	"rawSkinName?": "string",
	"skinID?": "number",
	"team?": "string",
	"position?": "string",
	"level?": "number",
	"isBot?": "boolean",
	/*
	 * REQUIRED, AND IT IS THE ONLY PLAYER FIELD THAT IS — because its ABSENCE IS AN ASSERTION.
	 *
	 * `parseAllGameData` below keeps a payload whose field arrived with the wrong type by DELETING
	 * that field, which is right for a field whose absence says "the feed did not tell us": the
	 * brief then renders nothing about it. `isDead` is not such a field. Every reader spells the
	 * test as `p.isDead === true` or `!p.isDead` — `routes/live.ts` counts `alliesAlive` and
	 * `enemiesAlive` that way and `live-brief.ts` reads the death block off it — so a MISSING
	 * `isDead` does not read as "unknown", it reads as ALIVE.
	 *
	 * Found by the adversarial pass over this same day's work, on a real payload: corrupt one
	 * player's `isDead` and the tolerant path returns ok, drops the key, and builds both a state
	 * and a brief in which a dead man is standing. Tolerance turned "the coach says nothing" into
	 * "the coach says something false", which is the one trade this repo never takes.
	 *
	 * Required makes it TERMINAL by the mechanism already in the parser rather than by a special
	 * case: a deleted required key fails the re-validation, so the payload is refused and the coach
	 * goes quiet — the behaviour the whole file had before, kept exactly where it is still right.
	 * The cost is real and bounded: a mode that omits `isDead` is now uncoachable rather than
	 * miscoached. The corpus says that mode is not Summoner's Rift — `isDead` is a boolean on
	 * 195,817 of 195,817 recorded player rows.
	 *
	 * `respawnTimer` was checked for the same asymmetry and does NOT have it: it is read as
	 * `p.respawnTimer ?? 0` and `(p.respawnTimer ?? 0) > 0`, so an absent timer says "no timer
	 * running", which is what an absent field should say.
	 */
	isDead: "boolean",
	"respawnTimer?": "number",
	"scores?": LiveScores,
	"items?": LiveItem.array(),
	/*
	 * `unknown`, AND THE REASON IS A WHOLE GAME THIS APP THREW AWAY.
	 *
	 * This key used to be `LiveRunes`, which in ArkType means "absent, or an object of this
	 * shape". The feed sends `null`. Those are different things, and the difference cost a game:
	 *
	 *     journalctl --user -u eepalytics | grep -c "WARN  \[lcu\] allgamedata did not match"
	 *     -> 363 rejected polls
	 *     journalctl --user -u eepalytics | grep -oE "allPlayers\[[0-9]+\]\.(runes|items)" \
	 *       | sort | uniq -c
	 *     -> 356 for each of allPlayers[0..17].runes, and 7 for allPlayers[1].items
	 *
	 * 356 consecutive polls of game 5645348275, 2026-09-19 21:47:55 to 21:59:55, every row of an
	 * eighteen-row lobby carrying `runes: null` at once. That game is queue 1750 / `CHERRY` / map
	 * 30 — ARENA (`select gameMode, queueId, mapId from game where gameId = 5645348275`, which is
	 * how the eighteen rows are explained). The rune block is a MODE-DEPENDENT shape and this
	 * schema was written from Summoner's Rift alone.
	 *
	 * The accounting is exact and it is the part worth keeping: 356 x 18 runes errors + 7 items
	 * errors = 6,415, against 363 header lines + 6,052 continuation lines = 6,415 in the journal.
	 * So `runes` and `items` were the ONLY two things wrong in those 363 payloads. Every other
	 * field of all eighteen rows — level, K/D/A, isDead, respawnTimer, items, summonerSpells —
	 * validated, and was thrown away with them, because `#get` in `lcu/live-client.ts` returns
	 * null for the WHOLE payload on any error. No live state, no brief, no coaching turn, and
	 * `daemon/live-sampler.ts` recorded nothing, which is why the recorded corpus contains not one
	 * Arena sample and could never have been used to find this.
	 *
	 * NOTHING READS IT. `grep -rn "\.runes\|\[\"runes\"\]\|fullRunes" src/ scripts/ --include=*.ts`
	 * returns these declarations and their comments, the two test files that assert this behaviour,
	 * `knowledge/provenance.ts`'s `meta.runes` key (an op.gg rune-page claim, a different subject
	 * entirely) and one line of `scripts/fetch-champions.ts` walking Data Dragon's rune trees for
	 * their names. Not one of them reads a player row's rune block. The live brief's own comment
	 * enumerating what an `allPlayers` row carries names `runes`, and that enumeration is the only
	 * place in the live path it has ever been mentioned.
	 *
	 * So it is `unknown`: still documented as a key the feed sends, still visible to a reader, and
	 * structurally unable to reject a payload ever again. `LiveRunes` above keeps the shape the
	 * 195,817 recorded rows do have, for anyone who later wants to read one.
	 *
	 * REFUTED, and it is the obvious repair: `"runes?": LiveRunes.or("null")`. It fixes the one
	 * value that was seen and leaves the class of defect exactly where it was — the next mode that
	 * sends `runes: []`, or a string, or an object with a shape Arena invents, discards the game
	 * again. The granularity was the bug, not the value.
	 */
	"runes?": "unknown",
	"summonerSpells?": LiveSummonerSpells
})
export type LivePlayer = typeof LivePlayer.infer

export const LivePlayerList = LivePlayer.array()
export type LivePlayerList = typeof LivePlayerList.infer

/** `GET /liveclientdata/gamestats`. `gameTime` is SECONDS as a float. */
export const LiveGameStats = type({
	"gameMode?": "string",
	"gameTime?": "number",
	"mapName?": "string",
	"mapNumber?": "number",
	"mapTerrain?": "string"
})
export type LiveGameStats = typeof LiveGameStats.infer

/**
 * The four neutral monsters, by the live feed's own event names.
 *
 * They are grouped because their `Assisters` list is the one field on a live event that is not
 * the quantity its name claims — see `assistersAreReadable`.
 */
export const NEUTRAL_OBJECTIVE_EVENTS: ReadonlySet<string> = new Set([
	"DragonKill",
	"BaronKill",
	"HeraldKill",
	"HordeKill"
])

/**
 * **May this event's `Assisters` list be read?** False for a drake, baron, herald or voidgrub, and
 * true for everything else. Call it at the point the list is read; do not read the raw field.
 *
 * `AGENTS.md` has recorded for this app's whole life that the POST-GAME timeline's
 * `ELITE_MONSTER_KILL.assistingParticipantIds` names an opposing-team player 19% of the time. The
 * live feed's `Assisters` is a DIFFERENT field arriving over a different channel, so it was
 * measured separately rather than assumed guilty, over every recorded `allgamedata` sample in
 * `data/live-samples` (36 games, 322 neutral-objective events, 236 of them carrying a non-empty
 * list):
 *
 *     channel                              assisted events   naming the other team
 *     live feed Assisters                        236          54 = 22.9% [18.0-28.6]
 *     timeline assistingParticipantIds           791         183 = 23.1% [20.3-26.2]   (112 games)
 *
 * The same defect, at the same rate, in both channels. It is also confined to the neutrals in
 * both: `ChampionKill` was clean in 0 of 2,289 live events and 0 of 5,633 timeline kills, and
 * structures in 0 of 550 and 0 of 786. The list on a neutral is evidently everyone who DAMAGED the
 * monster — which is why it reached seven names live and nine in the timeline, on teams of five.
 *
 * There is no gate that repairs it. A list of four same-team names can still be wrong, because the
 * enemy who chipped the drake is simply absent from the visible half of the error; gating on
 * "more than four" or "both teams" would catch 54 of the 236 and silently pass the rest as fact.
 * So the field is not read at all here, exactly as `truthEvents` already refuses the timeline's.
 * Credit on a neutral means the KILLER, which both channels get right.
 */
export const assistersAreReadable = (eventName: string): boolean =>
	!NEUTRAL_OBJECTIVE_EVENTS.has(eventName)

/**
 * One entry of `GET /liveclientdata/eventdata`. Names are riotIds, not participantIds —
 * join to the post-game timeline on riotId.
 *
 * `EventID` increases monotonically; poll with `?eventID=N` and dedupe on it.
 *
 * `Assisters` IS NOT READABLE ON A NEUTRAL OBJECTIVE — 22.9% of them name the other team. Go
 * through `assistersAreReadable` above, which carries the measurement.
 */
export const LiveEvent = type({
	EventID: "number",
	EventName: "string",
	"EventTime?": "number",
	"KillerName?": "string",
	"VictimName?": "string",
	"Assisters?": "string[]",
	"Recipient?": "string",
	"TurretKilled?": "string",
	"InhibKilled?": "string",
	"DragonType?": "string",
	"Stolen?": "string",
	"KillStreak?": "number",
	"Acer?": "string",
	"AcingTeam?": "string"
})
export type LiveEvent = typeof LiveEvent.infer

export const LiveEventData = type({ "Events?": LiveEvent.array() })
export type LiveEventData = typeof LiveEventData.infer

/** `GET /liveclientdata/allgamedata` — one call, everything. ~32 KB, ~28 ms. */
export const LiveAllGameData = type({
	"gameData?": LiveGameStats,
	"activePlayer?": LiveActivePlayer,
	"allPlayers?": LivePlayer.array(),
	"events?": LiveEventData
})
export type LiveAllGameData = typeof LiveAllGameData.infer

/* ------------------------------------------------- the boundary, at the right granularity
 *
 * ## One unread field must not be able to discard the whole lobby
 *
 * Widening `runes` above fixes the value that was seen. This fixes the SHAPE of the failure, which
 * is the thing that will happen again: `allGameData` in `lcu/live-client.ts` validates the payload
 * and used to return `null` for all of it on any error, so one wrong key on one player row cost the
 * coach every field of every player, the clock, the event feed and the sampler's record of the
 * game.
 * Measured: 363 polls lost that way in one evening (see `LivePlayer.runes`), and in 356 of them
 * the only thing wrong was a key nothing in this app reads.
 *
 * ## Why FIELD-level and not ROW-level, which is what it looks like it should be
 *
 * Dropping the failing ROW is the obvious answer and it is measurably worse here, for a reason
 * that has nothing to do with the schema. `rosterKey` in `server/routes/live.ts` is
 * `allPlayers.map(p => p.championName).join("|")` and it is the app's only game identity: when it
 * changes, `observeLiveSample` throws the coach's whole memory away, `resetFrameState()` runs, and
 * the next turn is treated as the first turn of a new game. So a row dropped for the seven polls
 * the practice-tool `items` fault lasted would have wiped the game's memory twice — once when the
 * row went and once when it came back — and re-sent a full brief each time. A game's memory is
 * exactly what this app spent months building; trading it to survive a bad `items` key is a worse
 * deal than the rejection it replaces.
 *
 * Field-level tolerance keeps `championName`, so the roster key does not move at all.
 *
 * ## Why it introduces no state the app has not already declared
 *
 * EVERY key on `LivePlayer`, `LiveActivePlayer`, `LiveGameStats`, `LiveScores`, `LiveItem` and
 * `LiveChampionStats` is optional. Every consumer therefore already has an absent-path for every
 * one of them, written before this existed. Removing a key that arrived wrong lands the payload in
 * a state the type system and the renderers already handle — it does not invent a value, it does
 * not coerce, and it does not put a number in front of the coach that the feed did not send.
 * `allPlayers` being SHORT is likewise not new: of the 20,067 recorded samples, 501 carry one row,
 * 54 carry four and 2 carry none. Every one of them was accepted by this boundary and passed
 * downstream, which is the sense in which a short roster is an ordinary state rather than an
 * invented one — it is not a claim that a coaching line was produced from each.
 *
 * REFUTED, with its reason, because it is the repair someone will draft next: coercing a malformed
 * `items` to `[]` instead of removing the key. `[]` is not a neutral value in this feed — the live
 * brief renders an empty item list as UNSEEN, which is a claim about fog, and AGENTS.md records
 * that reading. Removing the key says "the feed did not tell us"; writing `[]` says "the client
 * could not see his items", and only one of those is true. Worse, `daemon/live-sampler.ts` records
 * the PARSED object, so a coercion would write the invented value into the corpus and destroy the
 * only evidence that the field ever misbehaved. The dropped field's real value therefore travels
 * in the log line instead, which is where this defect was found in the first place.
 *
 * ## What is still rejected, on purpose
 *
 * A key is only removed if it is actually PRESENT on its parent. A REQUIRED key that arrives wrong
 * is removed once, immediately fails again as missing, is not present to remove a second time, and
 * the payload is rejected — which is what should happen to an event row with no `EventID`, since
 * that field is the dedupe key for the whole event feed. That falls out of the present-check
 * rather than a hand-maintained list of required names, so a required key added later is covered
 * without anyone remembering this paragraph.
 *
 * An error INSIDE an array is charged to the array's own key, not to the element: `items[2]` being
 * a string costs that player his `items`, because splicing element 2 out would renumber the list
 * and a renumbered item list is a different claim rather than a smaller one. A player ROW that is
 * a string walks up to `allPlayers`, which is a top-level section, and is rejected — the row-drop
 * this section already refused, arriving by another door and blocked by the same rule.
 *
 * And a TOP-LEVEL SECTION is never removed, even though the four of them are declared optional.
 * `gameData`, `activePlayer`, `allPlayers` and `events` are not fields, they are the four quarters
 * of the feed, and all four are read. Dropping `allPlayers` would empty the roster, which takes
 * `rosterKey` to `""` and wipes the coach's memory — the exact harm that made this per-field
 * rather than per-row, at four times the size. A payload whose whole roster is the wrong type is a
 * payload, not a field, and it is rejected. Measured cost of this line: the test
 * `rejects an error that names a container rather than a field` passed without it only because the
 * repair had silently deleted the entire lobby.
 */

/** One field the tolerant parse removed, for the log line that has to name it. */
export interface DroppedLiveField {
	/** The KEY that was removed: `allPlayers[1].items`. */
	path: string
	/**
	 * Where the schema actually complained, which is `path` in the common case and DEEPER when the
	 * fault was inside an array: `allPlayers[1].items[2]`. See `parseAllGameData`.
	 */
	errorPath: string
	/** What the schema demanded at `errorPath`, in ArkType's own words: `an array`. */
	expected: string
	/** What arrived AT `errorPath`, JSON-encoded and cut to 120 characters: `null`, `{}`, `"3"`. */
	actual: string
	/** `Kayn (CHAOS)` when the path is a player row, `""` when it is not. */
	who: string
}

export type LiveParse =
	| { ok: true; data: LiveAllGameData; dropped: DroppedLiveField[] }
	| { ok: false; summary: string; dropped: DroppedLiveField[] }

/**
 * How many remove-and-revalidate rounds before giving up and rejecting.
 *
 * ArkType reports every error at once, so one round removes every wrong key the first pass found
 * and the second round is the one that confirms. More than two rounds only happens if removing a
 * key exposes an error that was previously masked, which nothing in this schema can do. Four is a
 * ceiling on a pathological payload, not an expectation; a payload that has not converged by then
 * is rejected exactly as it would have been before any of this existed.
 */
export const MAX_TOLERANCE_ROUNDS = 4

/** `["allPlayers", 1, "items"]` -> `allPlayers[1].items`, the form the journal already uses. */
const renderFieldPath = (path: readonly (string | number)[]): string =>
	path.reduce<string>(
		(acc, seg) =>
			typeof seg === "number" ? `${acc}[${seg}]`
			: acc === "" ? seg
			: `${acc}.${seg}`,
		""
	)

const valueAt = (root: unknown, path: readonly (string | number)[]): unknown => {
	let cur = root
	for (const seg of path) {
		if (cur === null || typeof cur !== "object") return undefined
		cur = (cur as Record<string, unknown>)[String(seg)]
	}
	return cur
}

/**
 * WHO the bad field belonged to, so a log line names a player rather than an array index.
 *
 * Read off the ORIGINAL payload, not the copy being repaired, because by the time this is called
 * the copy may already have lost keys — and a row whose `championName` was itself the bad field
 * should still be identified by the index it arrived at.
 */
const playerAt = (input: unknown, path: readonly (string | number)[]): string => {
	if (path[0] !== "allPlayers" || typeof path[1] !== "number") return ""
	const row = valueAt(input, ["allPlayers", path[1]])
	if (row === null || typeof row !== "object") return `allPlayers[${path[1]}]`
	const r = row as Record<string, unknown>
	const name = typeof r.championName === "string" && r.championName !== "" ? r.championName : "?"
	const team = typeof r.team === "string" && r.team !== "" ? r.team : "?"
	return `${name} (${team})`
}

/** The value as the feed sent it, short enough for a log line and long enough to diagnose. */
const renderActual = (value: unknown): string => {
	let text: string
	try {
		text = value === undefined ? "undefined" : JSON.stringify(value)
	} catch {
		// A cyclic value cannot come out of JSON.parse, but the boundary is not the place to bet.
		text = String(value)
	}
	// TypeScript types `JSON.stringify` as returning a string; at RUNTIME it returns `undefined`
	// for a function or a symbol. Nothing that came out of `JSON.parse` can be either, but this is
	// the one function in the file whose only job is to survive a value nobody expected.
	if (typeof text !== "string") text = String(text)
	return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

/**
 * Validate `allgamedata`, removing individual fields the feed got wrong rather than losing the game.
 *
 * The happy path is one validation and no copy: 20,067 of 20,067 recorded samples take it
 * (`data/eval/live-schema-audit-20260922.json`). Everything below the first line runs only on a
 * payload that was already going to be thrown away.
 *
 * The input is never mutated — `structuredClone` first — because the caller may still want to see
 * what actually arrived, and because `daemon/live-sampler.ts` records whatever object comes back
 * out of here.
 */
export const parseAllGameData = (input: unknown): LiveParse => {
	const first = LiveAllGameData(input)
	if (!(first instanceof type.errors)) return { ok: true, data: first, dropped: [] }

	let work: unknown
	try {
		work = structuredClone(input)
	} catch {
		// Not clonable means not JSON, which means this was never a live payload.
		return { ok: false, summary: first.summary, dropped: [] }
	}
	const dropped: DroppedLiveField[] = []
	let errors = first
	for (let round = 0; round < MAX_TOLERANCE_ROUNDS; round++) {
		let removed = false
		for (const err of errors) {
			const errorPath = err.path as readonly (string | number)[]
			/*
			 * An error INSIDE an array is charged to the array's own key.
			 *
			 * `allPlayers[0].items[2]` being a string names nothing removable at its own depth:
			 * splicing element 2 out would renumber the list, and a renumbered item list is a
			 * different claim about his build rather than a smaller one. So the nearest ancestor
			 * that IS a key is what goes — `items` — and the log says both paths, because
			 * "dropped his items" and "one of his item rows was a string" are different sentences
			 * and a person reading the journal needs the second one.
			 *
			 * This is also what keeps the row-drop refusal intact rather than reintroducing it by
			 * accident: `allPlayers[3]` being a string walks up to `allPlayers`, which is a
			 * top-level section, and is blocked by the length check below.
			 *
			 * `events.Events` is the one case where this drops something large, and it is the case
			 * that makes the rule safe rather than the exception to it: the supervisor and the
			 * journal both call `allGameData()` with no `eventID`, so the feed re-sends the WHOLE
			 * event list on every poll two seconds later. Losing one poll's copy of a cumulative
			 * list costs nothing that the next poll does not return.
			 */
			let path = errorPath
			while (path.length > 0 && typeof path[path.length - 1] !== "string") path = path.slice(0, -1)
			// A quarter of the feed is not a field. See the section note above.
			if (path.length < 2) continue
			const key = path[path.length - 1] as string
			const parent = valueAt(work, path.slice(0, -1))
			if (parent === null || typeof parent !== "object") continue
			// PRESENT, not merely named: this is what makes a missing required key terminal.
			if (!(key in (parent as Record<string, unknown>))) continue
			dropped.push({
				path: renderFieldPath(path),
				errorPath: renderFieldPath(errorPath),
				expected: String(err.expected),
				actual: renderActual(valueAt(input, errorPath)),
				who: playerAt(input, path)
			})
			delete (parent as Record<string, unknown>)[key]
			removed = true
		}
		if (!removed) break
		const again = LiveAllGameData(work)
		if (!(again instanceof type.errors)) return { ok: true, data: again, dropped }
		errors = again
	}
	return { ok: false, summary: errors.summary, dropped }
}

/**
 * One line of `data/live-samples/<gameId>-t<stamp>.ndjson` — a timestamped sample of
 * `allgamedata`, appended by `daemon/live-sampler.ts` every 5s of game clock.
 * `atMs` is our wall clock (so we can align to the LCU), `gameTime` is the game's own.
 */
export const LiveSample = type({
	atMs: "number",
	"gameTime?": "number",
	data: LiveAllGameData
})
export type LiveSample = typeof LiveSample.infer

