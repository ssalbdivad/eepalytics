/**
 * What the coach has already watched, and what it has already said.
 *
 * The live coach holds ONE socket per game, so a thread exists — but `beat()` re-sends the whole
 * brief as a fresh user message every turn, so after twelve turns the thread is twelve
 * near-identical 4.6k dumps and the model's own replies came back as audio. Measured over the
 * capped run of game 5635467422: 41% of every brief is byte-identical across all twelve turns
 * (27 lines, 1937 chars), and "clear / camps / tempo" is the object of 9 of the 12 lines it spoke.
 * Nothing anywhere recorded what it had already advised, so it could not build on itself and it
 * could not say "you are STILL low on mana" — it did not know it had mentioned mana.
 *
 * This module is that missing record. It is arithmetic over the sample stream plus a log of the
 * utterances. NO MODEL CALL ANYWHERE.
 *
 * ## The three things it does not do
 *
 * 1. **It does not rank, gate or veto.** It emits text. Nothing here says what to say or when —
 *    it says what has happened and what you already said, which is context, not a guardrail. The
 *    standing no-guardrails rule survives intact.
 *
 * 2. **It does not fix the "red buff" failure.** At 1:37 the coach named a camp the player was not
 *    standing on. NO CHANNEL IN THIS APP HAS POSITIONS — not the live feed, not this module. A
 *    future reader must not assume memory covers identity. What memory does do is give the model
 *    non-visual material to talk about, which is the only honest way to reduce the pressure to
 *    narrate pixels.
 *
 * 3. **It does not own the socket.** `beat()` renders it; the daemon feeds it.
 *
 * ## Pure, and therefore replayable
 *
 * No fs, no db, no network, no `Date.now()` — every clock is a game clock passed in. So it lives
 * beside `live-facts.ts` and `speak-pace.ts` and the browser imports it exactly as `geminiLive.ts`
 * already imports `speak-pace.ts`. `scripts/lib/stream.ts` constructs its own `MemoryState` and
 * steps it from its segment's first line; because the state is a plain object and the module is
 * pure, a replay is byte-identical to the live path.
 *
 * ## Where the instance lives
 *
 * The DAEMON owns one `MemoryState` per game; the browser owns none. The supervisor's poll samples
 * `allgamedata` every 5s of game clock whether or not the page is open, and that poll calls
 * `observeLiveSample()` in `server/routes/live.ts`, which calls `observe()` here — a browser-owned
 * memory would miss the back that happened between two turns, and at 3:33 of the verified replay
 * exactly one such six-second window is the whole difference between "back now" and "you did back,
 * now…". The browser POSTs each spoken line back, which calls `noteSaid()`, because the socket
 * transcript is only knowable in the page.
 *
 * That claim was WRONG in this comment for the module's whole first life: nothing outside the
 * ground-truth handler called `observe`, so the memory ran at browser TURN cadence, and `beat()`
 * returns on the pace floor before that fetch — a paced-out beat fed it nothing. The constants
 * below assume the dense grid; see `BACK_COALESCE_SEC` for what a sparse one did to them.
 *
 * Reset: a new `MemoryState` at `ChampSelect`, the same lifecycle as the socket. One per game,
 * never per session — a memory spanning two games carries game one's roster into game two, which
 * is the hallucination this app's whole design fights.
 */

import { premiseOf, speechDurationSec } from "./timeliness.ts"
import type { PremiseKind } from "./timeliness.ts"
import { topicOfText } from "./useful.ts"
import type { Topic } from "./useful.ts"
import { dragonPhrase } from "../shared/dragons.ts"
/* `csGap`/`csGapWorthSaying` are gone from this module. They compare two floored CS figures and one
 * of the two — the enemy jungler's — is not a CS figure; see `renderRace`. `csPhrase` stays: it
 * words HIS OWN floored farm, which is his farm, floored. */
import { csPhrase } from "../shared/live-state.ts"
import { clock } from "../shared/live-brief.ts"
import type { DeathSeen } from "../shared/live-brief.ts"

/* ================================================================ narrowing
 *
 * `live-brief.ts` has these four and its `readPlayer`/`readEvents`, but they are module-private
 * there. They are duplicated here rather than re-narrowed differently: when they are exported,
 * delete this block and import them, because a second copy of a READER drifts. These four are
 * primitives with no domain knowledge in them, which is why they are the acceptable half to copy.
 */

const rec = (v: unknown): Record<string, unknown> | null =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)

/** "13s ago" / "2m11s ago", the same shape the brief's event log uses. */
const age = (sec: number): string => {
	const s = Math.max(0, Math.round(sec))
	return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s ago`
}

const r0 = (n: number): string => String(Math.round(n))
const pct = (n: number, of: number): string => `${Math.round((100 * n) / (of || 1))}%`

/* ================================================================ ingest */

/**
 * One sample, distilled. This is the ONLY shape the follow-through checks read, so a check can
 * never reach past it into the raw payload and quietly depend on a field nothing else narrows.
 */
export interface Snapshot {
	tSec: number
	/** Floored to tens by the client. His own, and genuinely his farm. Never subtract two — see `csGap`. */
	cs: number
	level: number
	/** His current gold. The only current gold anywhere in the feed. */
	gold: number
	hp: number
	maxHp: number
	mana: number
	maxMana: number
	k: number
	d: number
	a: number
	dead: boolean
	respawnSec: number
	ward: number
	/** `displayName`, in slot order. */
	items: string[]
	/**
	 * The counterpart's `creepScore` — RECORDED, and rendered nowhere.
	 *
	 * It is a count of the farm your client witnessed, not his farm (`renderRace` carries the audit).
	 * Kept because it is a stored measurement and because its DERIVATIVE is the feed's only sighting
	 * signal, which `renderCounterpart` uses. Anything that renders it as a farm figure, or subtracts
	 * it from his, is re-introducing the app's most expensive measured lie.
	 */
	cpCs: number | null
	cpLevel: number | null
	cpItems: string[]
	cpDead: boolean
	cpKda: readonly [number, number, number] | null
	/**
	 * Every champion the feed reports DEAD in this sample.
	 *
	 * The alive->dead EDGE is the fallback source for `MemoryState.deadAt`, and an edge needs both
	 * sides. This module keeps samples and not payloads, so the set has to be stored beside the
	 * sample it was read from or the diff has nothing to compare against.
	 */
	deadChamps: string[]
}

const itemNames = (v: unknown): string[] =>
	arr(v)
		.map(raw => str(rec(raw)?.displayName ?? null))
		.filter((n): n is string => n !== null)

/** Consumables and trinkets churn every back; a beat for each would bury the completed items. */
const CHURN = /Trinket|Ward|Potion|Refillable|Elixir|Biscuit/i

const spellNames = (p: Record<string, unknown>): string[] => {
	const spells = rec(p.summonerSpells) ?? {}
	return [str(rec(spells.summonerSpellOne)?.displayName ?? null), str(rec(spells.summonerSpellTwo)?.displayName ?? null)]
		.filter((s): s is string => s !== null)
}

/** The payload, whether it arrived as a raw `allgamedata` or as a journalled `{gameTime, data}`. */
const dataOf = (raw: unknown): Record<string, unknown> | null => {
	const outer = rec(raw)
	if (!outer) return null
	return rec(outer.data) ?? outer
}

const myRowOf = (data: Record<string, unknown>): Record<string, unknown> | null => {
	const active = rec(data.activePlayer)
	if (!active) return null
	const mine = str(active.riotIdGameName) ?? str(active.summonerName) ?? str(active.riotId)?.split("#")[0] ?? null
	if (!mine) return null
	const players = arr(data.allPlayers).map(rec)
	return (
		players.find(p => p !== null && (str(p.riotIdGameName) === mine || str(p.summonerName) === mine)) ?? null
	)
}

/**
 * The enemy jungler, by the live feed's own `position` — which is a different source from the
 * post-game `timeline.role` this repo does not trust — with Smite as the fallback and the tiebreak.
 * Identical rule to `live-brief`'s, deliberately: two modules that disagree about who the
 * counterpart is would put two different champions in one payload.
 */
const counterpartOf = (data: Record<string, unknown>, me: Record<string, unknown>): Record<string, unknown> | null => {
	const enemies = arr(data.allPlayers)
		.map(rec)
		.filter((p): p is Record<string, unknown> => p !== null && str(p.team) !== str(me.team))
	return (
		enemies.find(p => str(p.position) === "JUNGLE") ??
		enemies.find(p => spellNames(p).some(s => s.toLowerCase().includes("smite"))) ??
		null
	)
}

const scoresOf = (p: Record<string, unknown>): Record<string, unknown> => rec(p.scores) ?? {}

const readSnapshot = (raw: unknown, tSec: number): Snapshot | null => {
	const data = dataOf(raw)
	if (!data) return null
	const active = rec(data.activePlayer)
	const me = myRowOf(data)
	if (!active || !me) return null
	const cp = counterpartOf(data, me)
	const stats = rec(active.championStats) ?? {}
	const s = scoresOf(me)
	const cs = scoresOf(cp ?? {})
	return {
		tSec,
		cs: num(s.creepScore) ?? 0,
		level: num(me.level) ?? 0,
		gold: num(active.currentGold) ?? 0,
		hp: num(stats.currentHealth) ?? 0,
		maxHp: num(stats.maxHealth) ?? 0,
		mana: num(stats.resourceValue) ?? 0,
		maxMana: num(stats.resourceMax) ?? 0,
		k: num(s.kills) ?? 0,
		d: num(s.deaths) ?? 0,
		a: num(s.assists) ?? 0,
		dead: me.isDead === true,
		respawnSec: num(me.respawnTimer) ?? 0,
		ward: num(s.wardScore) ?? 0,
		items: itemNames(me.items),
		cpCs: cp ? num(cs.creepScore) ?? 0 : null,
		cpLevel: cp ? num(cp.level) ?? 0 : null,
		cpItems: cp ? itemNames(cp.items) : [],
		cpDead: cp ? cp.isDead === true : false,
		cpKda: cp ? [num(cs.kills) ?? 0, num(cs.deaths) ?? 0, num(cs.assists) ?? 0] : null,
		deadChamps: arr(data.allPlayers)
			.map(raw => rec(raw))
			.filter((row): row is Record<string, unknown> => row !== null && row.isDead === true)
			.map(row => str(row.championName))
			.filter((c): c is string => c !== null)
	}
}

/* ================================================================ the narrative */

export type BeatKind =
	| "kill"
	| "my-kill"
	| "my-death"
	| "objective"
	| "tower"
	| "back"
	| "respawn-buy"
	| "buy"
	| "level"
	| "cp-kill"
	| "cp-death"
	| "cp-buy"
	| "cp-level"

/**
 * One thing that happened. Past tense, one clause, NO leading clock — the renderer adds it, so a
 * beat can be re-rendered against a different `now` without reparsing its own text.
 *
 * `weight` decides what survives compaction: 2 forever, 1 for seven minutes, 0 for four. It is not
 * a ranking of what to SAY — everything that survives is rendered, in time order, undifferentiated.
 * It is only how long a fact stays worth carrying: a death matters at 30:00; who hit level 3 does
 * not.
 */
export interface Beat {
	tSec: number
	kind: BeatKind
	text: string
	weight: 0 | 1 | 2
	/**
	 * Whether HE is the actor. Discriminated on the EVENT, never on the prose.
	 *
	 * `namer()` maps every player to a CHAMPION name, including him, so an objective beat reads
	 * "Lillia took Ocean drake" and never "you took". The objective follow-through used to test
	 * `text.startsWith("you")`, which is structurally false for every objective beat — replayed
	 * against the real feed, the Ocean drake HE took at 30:43 closed as
	 * `NOT OBSERVED — Lillia took Ocean drake`, a verdict contradicting its own evidence in the
	 * same line, and a false accusation about the player is the exact class this module exists to
	 * refuse. Prose is a rendering; this is the fact.
	 */
	mine: boolean
}

/**
 * The race, sampled coarsely so it can be described as a MOVEMENT rather than a value.
 *
 * The uncapped run cited the lead on six separate turns and it never once became a decision,
 * because a lead quoted as a number is the same sentence every time. A lead that has been shrinking
 * for three minutes is a different sentence.
 *
 * `cpCs` is still RECORDED and is no longer RENDERED — see `renderRace`. It is kept because it is a
 * measurement and because its derivative is the only sighting signal in the feed, and deleting a
 * stored measurement to make a story cleaner is not something this repo does.
 */
export interface RacePoint {
	tSec: number
	myCs: number
	cpCs: number | null
	myLevel: number
	cpLevel: number | null
}

/* ================================================================ the utterance log */

export type ActionKind = "back" | "buy" | "farm" | "objective" | "gank" | "disengage" | "ward" | "none"

export interface AdvisedAction {
	kind: ActionKind
	/** Item name, camp name, objective name, lane. Null when the kind carries no object. */
	target: string | null
}

/**
 * `not-observed` is not "he disobeyed" — it is "the feed did not show it". `overtaken` is the case
 * where the game moved on before the window closed. `unknown` is the honest verdict whenever the
 * feed CANNOT settle it, and the checks below are written so that unmeasurable never renders as
 * did-not: a gank is always `unknown` because there are no positions, and farm advice inside one
 * floored CS step is `unknown` because a whole camp hides inside it.
 */
export type FollowVerdict = "followed" | "not-observed" | "overtaken" | "unknown"

export interface FollowThrough {
	verdict: FollowVerdict
	/** The OBSERVATION, in the words the renderer speaks. A state movement, never an intention. */
	why: string
	closedAtSec: number
}

export interface Utterance {
	/** Game clock of the brief the line was built from. */
	atSec: number
	/** `atSec` + latency + `speechDurationSec(text)`: when the last syllable lands. */
	endSec: number
	text: string
	topic: Topic
	/**
	 * From `premiseOf`. MEASURED: it returns `unknown` on 24 of 24 trusted-mode lines across both
	 * runs, because its regexes are anchored to the old ranker's own sentence templates
	 * ("X is down N seconds") which the trusted prompt never produces. Stored as a secondary signal
	 * for the arms that DO use those templates. Nothing here depends on it.
	 */
	premise: PremiseKind
	action: AdvisedAction
	/** Null until the window closes. Never mutated after. */
	follow: FollowThrough | null
}

/* ================================================================ the state */

export interface MemoryState {
	/** His champion. */
	me: string
	/** The enemy jungler's champion. */
	counterpart: string | null
	lastSec: number
	/** Client `EventID`s are monotonic; this is the exact, cheap dedupe. */
	lastEventId: number
	beats: Beat[]
	race: RacePoint[]
	/** Ring of the last `RECENT_KEEP` snapshots. The follow-through window reads only this. */
	recent: Snapshot[]
	said: Utterance[]
	/**
	 * When the counterpart's row last CHANGED — the only honest clock on any enemy figure.
	 *
	 * The enemy rows in this feed are FOG-GATED: they freeze while the player is out of vision and
	 * jump when he is seen again. Verified on `data/live-samples/split-03.ndjson`: Briar reads
	 * level 1 and 0 CS from 0:00 to 2:44, then jumps 1->3 skipping 2, and still reads 0 CS at
	 * level 4 at 5:59 — impossible for a jungler. Ornn's row on the same team updates at 2:01,
	 * 2:26 and 2:44, so this is PER ROW visibility and not a whole-team artefact.
	 *
	 * A figure read off a frozen row is a LAST-KNOWN value of unknown age, and the gap between
	 * these two clocks is the only thing in the feed that says how old. Without it the coach said
	 * "Briar is still level one" at 2:19 about a jungler who was level 3.
	 */
	cpSeen: { level: number | null; cs: number | null; items: number }
	/**
	 * WHEN EACH CHAMPION WAS OBSERVED TO GO DOWN, keyed by champion name. The other half of the
	 * dead clock, and the half no channel in this app carried until now.
	 *
	 * The feed states a death as `respawnTimer` — time REMAINING. The sentence a coach reaches for
	 * is the ELAPSED one ("he has been down for half a minute"), and with only the remaining figure
	 * in front of it the model converted one into the other. Measured across the 28 stored games,
	 * 153 spoken lines state an elapsed death time and 71 of them contradict the client's own kill
	 * log; the error is one-sided — 101 overstate against 4 that understate — and 101 of 115 spoke
	 * a number within ten seconds of the `back in N` figure sitting in the payload. The model was
	 * not inventing. It was reading the only number it had been given.
	 *
	 * So the instant is OBSERVED and never computed. A respawn interval is a patch value that grows
	 * with game time; subtracting one from the other would put a hardcoded schedule behind a
	 * sentence the listener hears as a measurement, which is the same class of error as the item
	 * prices this file's sibling deleted.
	 *
	 * Two sources, and the record says which:
	 *  - the client's own `ChampionKill` log, whose `EventTime` is the death itself (`exact`), and
	 *    which the first `observe` of a session ingests in full, so a death from before the coach
	 *    started is usually still dated exactly;
	 *  - the alive->dead edge between two samples, which bounds the death at the poll gap and is
	 *    therefore a LOWER bound on the elapsed time. The brief renders it as "at least".
	 *
	 * A champion with no entry has not been watched going down, and the elapsed figure for him is
	 * NOT KNOWN. That is a rendered state, not a gap to fill.
	 */
	deadAt: Record<string, DeathSeen>
	/**
	 * The game clock of the FIRST sample this memory ever saw, or null before there is one.
	 *
	 * `cpSeen` can only report a change it watched happen, so it stays null until the counterpart's
	 * row moves AFTER the memory was created. The brief renders that null as "his row has NEVER
	 * moved in ${dur(now)}" — and `now` is the GAME clock, so a memory created at 6:40 by a daemon
	 * restart or a roster-triggered `newMemory()` reports twenty minutes of not-watching as twenty
	 * minutes of a frozen row. Replayed on the real samples with the memory started at 400s, the
	 * brief at 7:23 said "his row has NEVER moved in 7m23s" after watching for 43 seconds.
	 *
	 * So the age of the WATCH is stored beside the age of the ROW, and a clause that means "I have
	 * not seen it move" can say how long it has been looking.
	 */
	observedFrom: number | null
}

/* ---------------------------------------------------------------- constants */

/** One race point a minute: enough to show a trend, few enough to render all of them late-game. */
export const RACE_EVERY_SEC = 60

/** 40 x 5s ~ 3m20s of history: longer than the longest follow-through window. */
export const RECENT_KEEP = 40

/**
 * Gold falling this far is the ONLY honest back signal in the feed. There are no positions, so
 * "he is in the fountain" is unknowable; a 250g drop is a purchase, and a purchase happens in a
 * shop. Below this, a rune or a consumable refund produces false backs.
 */
export const BACK_GOLD_DROP = 250

/** Fountain shopping writes several drops in a row; inside this they are one back. */
export const BACK_COALESCE_SEC = 20

/**
 * Below this, unmoved floored CS proves nothing — a whole camp fits inside one ten-step, so
 * "he did not farm" would be a fabrication dressed as an observation.
 */
export const QUANTUM_HIDES_SEC = 60

/** Camps spawn at 1:30. Farm advice whose window closes before this could not have been followed. */
export const CAMPS_SPAWN_SEC = 90

/** How long a beat of each weight stays in the narrative. */
export const BEAT_TTL_SEC: Record<0 | 1 | 2, number> = { 0: 240, 1: 420, 2: Infinity }

/** Beats rendered at once. The measured narrative peaks at 710 chars on a 36:49 game. */
export const NARRATIVE_MAX_BEATS = 14

/** Utterances rendered at once. */
export const SAID_MAX_LINES = 6

/**
 * How long after the last syllable lands the feed is given to show the advice being taken.
 *
 * These are the intervals over which the FEED can settle the question, not a judgement about how
 * fast he should move. A buy needs to survive a back; a disengage is answered in seconds.
 */
export const WINDOW_SEC: Record<ActionKind, number> = {
	back: 45,
	buy: 90,
	/*
	 * Farm's window MUST exceed `QUANTUM_HIDES_SEC` or the `not-observed` branch below is
	 * structurally unreachable and every unmoved-CS line reads as a did-not. The window caps the
	 * span the check can look at, so a 60s window against a 60s quantum guard measures nothing and
	 * then reports it as disobedience — the exact failure this module is written to avoid. Two
	 * floored steps is the shortest span over which an unmoved figure is evidence rather than
	 * rounding.
	 */
	farm: 120,
	objective: 60,
	gank: 45,
	disengage: 25,
	ward: 60,
	none: 0
}

/**
 * How big a level difference has to be before it is a lead.
 *
 * Enemy levels are 94.5% exact over the recorded game and the errors are ±1 and transient, so a
 * one-level gap is inside the measurement. It is still printed — the two numbers are printed either
 * way — but it is not called a lead.
 */
export const LEVEL_NOISE = 1

/** Levels worth a beat: the ones that change what he can do, not every level-up. */
const LEVEL_SPIKES = new Set([2, 3, 5, 6, 9, 11, 16])

export const newMemory = (): MemoryState => ({
	me: "",
	counterpart: null,
	lastSec: 0,
	lastEventId: -1,
	beats: [],
	race: [],
	recent: [],
	said: [],
	cpSeen: { level: null, cs: null, items: 0 },
	deadAt: {},
	observedFrom: null
})

/* ================================================================ ingest */

/** Event participants are SUMMONER names; every line is mapped to a champion before it is stored. */
const namer = (data: Record<string, unknown>) => {
	const byName = new Map<string, string>()
	for (const raw of arr(data.allPlayers)) {
		const p = rec(raw)
		const champ = p && str(p.championName)
		if (!p || !champ) continue
		const n = str(p.riotIdGameName) ?? str(p.summonerName) ?? champ
		byName.set(n, champ)
	}
	return (v: unknown): string => {
		const s = str(v)
		if (!s) return "someone"
		return byName.get(s) ?? (s.startsWith("Minion_") || s.startsWith("Turret_") ? "minions/turret" : s)
	}
}

/**
 * Feed EVERY sample, in order. A repeated or out-of-order `tSec` is ignored, so a replay that
 * re-sends a line and the live sampler's occasional duplicate both land on the same state.
 *
 * Mutates and returns the same object. The state is a growing log and every caller holds exactly
 * one of them for a game; copying it on every 5s poll would be churn for no isolation anybody uses.
 */
export const observe = (s: MemoryState, raw: unknown, gameTimeSec: number): MemoryState => {
	if (s.recent.length > 0 && gameTimeSec <= s.recent.at(-1)!.tSec) return s
	const data = dataOf(raw)
	if (!data) return s
	const snap = readSnapshot(raw, gameTimeSec)
	if (!snap) return s

	// The first sample this memory ever accepted. See `observedFrom`.
	if (s.observedFrom === null) s.observedFrom = gameTimeSec
	const me = myRowOf(data)!
	s.me = str(me.championName) ?? s.me
	const cp = counterpartOf(data, me)
	s.counterpart = (cp && str(cp.championName)) ?? s.counterpart

	const prev = s.recent.at(-1) ?? null
	const push = (tSec: number, kind: BeatKind, text: string, weight: 0 | 1 | 2, mine = false): void => {
		s.beats.push({ tSec, kind, text, weight, mine })
	}

	/* --- what the client's own event log says, deduped on the monotonic EventID.
	 *
	 * Beats are kept AFTER the event scrolls out of `events.Events`, which is the point: the brief
	 * re-reads that array every turn and so forgets a kill the moment the client stops sending it.
	 */
	const who = namer(data)
	for (const rawEv of arr(rec(data.events)?.Events)) {
		const e = rec(rawEv)
		const id = e && num(e.EventID)
		const name = e && str(e.EventName)
		if (!e || id === null || !name || id <= s.lastEventId) continue
		s.lastEventId = id
		const t = num(e.EventTime) ?? gameTimeSec
		switch (name) {
			case "ChampionKill": {
				const killer = who(e.KillerName)
				const victim = who(e.VictimName)
				const assists = arr(e.Assisters).map(who)
				/*
				 * THE DEATH INSTANT, from the line that states it. `EventTime` is the kill, not the
				 * reading of it, so this is the exact half of `MemoryState.deadAt`. Recorded for
				 * everyone on the roster — half of the inverted lines named somebody other than the
				 * enemy jungler — and unconditionally, because the log is ordered and a later kill
				 * on the same victim is a later death.
				 */
				if (victim !== "someone") s.deadAt[victim] = { atSec: t, exact: true }
				if (victim === s.me)
					push(t, "my-death", `${killer} killed you${assists.length > 0 ? ` (assists ${assists.join(", ")})` : ""}`, 2, true)
				else if (killer === s.me) push(t, "my-kill", `you killed ${victim}`, 2, true)
				else if (assists.includes(s.me)) push(t, "my-kill", `you assisted the kill on ${victim}`, 2, true)
				else if (killer === s.counterpart) push(t, "cp-kill", `${killer} killed ${victim}`, 1)
				else if (victim === s.counterpart) push(t, "cp-death", `${victim} died to ${killer}`, 1)
				else push(t, "kill", `${killer} killed ${victim}`, 0)
				break
			}
			/*
			 * `mine` is the KILLER, resolved through `who` exactly as the text is, so the flag and
			 * the prose can never disagree about who acted. See `Beat.mine`.
			 */
			case "DragonKill":
				push(t, "objective", `${who(e.KillerName)} took ${dragonPhrase(str(e.DragonType))}${e.Stolen === "True" ? " (stolen)" : ""}`, 2, who(e.KillerName) === s.me)
				break
			case "HordeKill":
				push(t, "objective", `${who(e.KillerName)} took a voidgrub`, 1, who(e.KillerName) === s.me)
				break
			case "HeraldKill":
				push(t, "objective", `${who(e.KillerName)} took Rift Herald`, 2, who(e.KillerName) === s.me)
				break
			case "BaronKill":
				push(t, "objective", `${who(e.KillerName)} took Baron`, 2, who(e.KillerName) === s.me)
				break
			case "TurretKilled":
				push(t, "tower", `${who(e.KillerName)} took a turret`, 1, who(e.KillerName) === s.me)
				break
			default:
				break
		}
	}

	/* --- beats only a sample-to-sample diff can see. None of these is an event. */
	if (prev) {
		const dGold = snap.gold - prev.gold
		const lastBack = [...s.beats].reverse().find(b => b.kind === "back" || b.kind === "respawn-buy")
		if (dGold <= -BACK_GOLD_DROP && (!lastBack || gameTimeSec - lastBack.tSec > BACK_COALESCE_SEC)) {
			/*
			 * CADENCE-FREE. This used to scan `s.recent` for a sample inside `BACK_COALESCE_SEC`
			 * that showed him dead, which is a question about the SAMPLE GRID rather than about
			 * the game: stepped at 25s instead of the real ~6s, all six of split-03's
			 * `respawn-buy` beats degraded to plain `back`, so the narrative would have told the
			 * model "you backed and spent 1038 gold" about a moment he had just been killed. The
			 * previous sample and the respawn timer answer it at any cadence.
			 */
			const respawning =
				prev.dead || snap.respawnSec > 0 || s.recent.some(x => x.tSec >= gameTimeSec - BACK_COALESCE_SEC && x.dead)
			push(
				gameTimeSec,
				respawning ? "respawn-buy" : "back",
				`you ${respawning ? "respawned and" : "backed and"} spent ${r0(-dGold)} gold`,
				1
			)
		}
		for (const i of snap.items.filter(i => !prev.items.includes(i)))
			if (!CHURN.test(i)) push(gameTimeSec, "buy", `you finished ${i}`, 1)
		/*
		 * The counterpart's beats are SIGHTINGS, not events, and they are worded as sightings.
		 *
		 * His row is fog-gated (see `MemoryState.cpSeen`), so the clock on a change to it is the
		 * moment the app SAW the change, not the moment it happened. Stepping the real samples
		 * through the old wording emitted `2:44 Briar hit level 3` for a level she reached around
		 * 1:45 and `5:59 Briar finished Vampiric Scepter` for a purchase minutes older — reveal
		 * times stamped as event times, kept in the narrative afterwards, and indistinguishable
		 * from his own beats, whose clocks are exact. The fact is worth keeping; the false
		 * precision is not, so the beat says when it was seen.
		 */
		const cpName = s.counterpart ?? "the enemy jungler"
		for (const i of snap.cpItems.filter(i => !prev.cpItems.includes(i)))
			if (!CHURN.test(i)) push(gameTimeSec, "cp-buy", `${cpName} was seen holding ${i}`, 1)
		if (snap.level > prev.level && LEVEL_SPIKES.has(snap.level))
			push(gameTimeSec, "level", `you hit level ${snap.level}`, 0, true)
		if (
			snap.cpLevel !== null &&
			prev.cpLevel !== null &&
			snap.cpLevel > prev.cpLevel &&
			LEVEL_SPIKES.has(snap.cpLevel)
		)
			push(gameTimeSec, "cp-level", `${cpName} was seen at level ${snap.cpLevel}`, 0)

		/*
		 * THE EDGE, for a death the log did not carry.
		 *
		 * It bounds the death inside one poll gap, so the elapsed time it yields is a LOWER bound
		 * and the brief says "at least". It only writes when the record is OLDER than this window:
		 * a death the kill log dated a moment ago is the better figure and survives, while a stale
		 * entry from an earlier death cannot date this one.
		 */
		const wasDown = new Set(prev.deadChamps)
		for (const champ of snap.deadChamps) {
			if (wasDown.has(champ)) continue
			const known = s.deadAt[champ]
			if (!known || known.atSec <= prev.tSec) s.deadAt[champ] = { atSec: gameTimeSec, exact: false }
		}
		/*
		 * A RESPAWN ENDS THE DEATH THIS CLOCK MEASURES, so the entry goes. Keeping it would leave a
		 * dated instant standing behind a LATER death that nothing watched, which is the one way
		 * this record could state a confident wrong number instead of NOT KNOWN.
		 */
		const nowDown = new Set(snap.deadChamps)
		for (const champ of prev.deadChamps) {
			const known = s.deadAt[champ]
			if (!nowDown.has(champ) && known && known.atSec <= prev.tSec) delete s.deadAt[champ]
		}

		/* The last time each of his figures actually MOVED, which is the only age they have. */
		if (snap.cpLevel !== null && snap.cpLevel !== prev.cpLevel) s.cpSeen.level = gameTimeSec
		if (snap.cpCs !== null && snap.cpCs !== prev.cpCs) s.cpSeen.cs = gameTimeSec
		if (snap.cpItems.length !== prev.cpItems.length) s.cpSeen.items = gameTimeSec
	}

	const lastRace = s.race.at(-1)
	if (!lastRace || gameTimeSec - lastRace.tSec >= RACE_EVERY_SEC)
		s.race.push({
			tSec: gameTimeSec,
			myCs: snap.cs,
			cpCs: snap.cpCs,
			myLevel: snap.level,
			cpLevel: snap.cpLevel
		})

	s.recent.push(snap)
	while (s.recent.length > RECENT_KEEP) s.recent.shift()
	s.lastSec = gameTimeSec

	closeWindows(s, gameTimeSec)
	return s
}

/* ================================================================ what was advised */

/**
 * The action a spoken line asked for, parsed out of the sentence.
 *
 * Parsed from TEXT for the same reason `premiseOf` is: what reaches the player is a string, the
 * model rephrases everything, and a recorded transcript is a list of strings. A parser that needed
 * a structured object from the ranker could not be pointed at the run that failed.
 *
 * ORDERED, and the order carries the meaning:
 *  - `disengage` before `back`, because "back off" is not a recall;
 *  - `objective` needs a VERB pointing at it, or "they got the drake" becomes advice to take drake;
 *  - the bare verb "reset" is refused; "reset your tempo" is not a trip to the fountain.
 *
 * A line matching nothing is `none`, which closes as `unknown` and is never counted against him.
 */
const ACTION_PATTERNS: readonly [ActionKind, RegExp, (m: RegExpExecArray) => string | null][] = [
	[
		"disengage",
		/\b(back off|back away|don'?t (?:fight|duel|contest|take|force)|do not even think about duel\w*|walk away|disengage|leave it|get out)\b/i,
		() => null
	],
	[
		"back",
		/\b(back now|go back and buy|recall|go reset|reset and buy|reset now|go home|head back|base up|finish the recall)\b/i,
		() => null
	],
	/*
	 * The target must be a NOUN PHRASE, and the capital is most of what marks one — "finish this
	 * camp" and "finish Liandry's Torment" are the same verb and different advice. But the
	 * capital is not the whole of it: the real transcripts say "buy your jungle item", lowercase,
	 * which the capital-only form missed, so the common generic objects are named as an
	 * alternative rather than left to fall through to `none`.
	 */
	[
		"buy",
		/\b(?:[Bb]uy|[Gg]rab|[Pp]ick up|[Ff]inish|[Cc]omplete|[Ss]tart on|[Ss]pend your gold on)\s+(?:your |that |the |a |an )?(jungle item|jungle pet|boots|[A-Z][\w']*(?: [A-Z][\w']*)*)/,
		m => m[1] ?? null
	],
	[
		"objective",
		/\b(?:take|contest|set ?up|go(?:ing)? for|look(?:ing)? (?:to|towards)|path(?:ing)? (?:to|towards)|check|sneak|secure)\s+(?:\w+ )??(?:the |your |those |these |some |far |that )?(?:\w+ )??(drakes?|dragons?|grubs?|voidgrubs?|herald|baron|nashor|crab|scuttle|pit)/i,
		m => m[1]!.toLowerCase()
	],
	["gank", /\b(?:gank|collapse on|dive|go help)\b|\bpath(?:ing)? (?:to|towards) (top|mid|bot)\b/i, m => m[1] ?? null],
	["ward", /\b(ward|sweep)\b/i, () => null],
	/*
	 * STEMS, not exact forms. The trailing `\b` on `keep (?:that|the|this )?clear` could not match
	 * "Keep clearing", which is what the trusted coach actually says; `clear\w*` can. The
	 * determiner list gained an ADJECTIVE slot for the same reason — "the safe crab" defeated a
	 * fixed determiner alternation, and "safe" is the kind of word this coach uses constantly.
	 */
	[
		"farm",
		/\b(?:take|clear\w*|finish|kite|head (?:straight )?(?:to|towards)|get(?: to)?|path(?:ing)? (?:to|towards))\s+(?:your |the |that |this |those |[A-Z]\w+'s )?(?:\w+ )??(?:first |next |own )?(raptors|krugs|wolves|gromp|blue buff|red buff|blue|red|camps?|camp|crab)\b/i,
		m => m[1]!.toLowerCase()
	],
	[
		"farm",
		/\b(powerfarm|power ?farm\w*|full clear|keep\w* (?:that |the |this |your )?clear\w*|clear back|farm your camps|keep farming|clear speed|keep running that clear|clearing your camps|start your route|route moving|keep your route|your clear)\b/i,
		() => null
	]
]

/**
 * The action a spoken line asked for, parsed out of the sentence.
 *
 * Parsed from TEXT for the same reason `premiseOf` is: what reaches the player is a string, the
 * model rephrases everything, and a recorded transcript is a list of strings. A parser that needed
 * a structured object from the ranker could not be pointed at the run that failed.
 *
 * ## EARLIEST IN THE SENTENCE WINS, not first in the list
 *
 * The list used to be scanned in priority order over the whole string, so the classification came
 * from whichever pattern sat highest rather than from the primary imperative. Measured over the 43
 * real non-mock lines in the three stored runs, that mislabelled multi-clause advice by its coda:
 * "Another trade in mid... finish this camp, hit level 5, and keep pathing bot... Don't take any
 * risks" classified as `disengage` and then rendered `FOLLOWED — he survived`, telling the model it
 * had advised a disengage it never advised. The advice is in the opening clause; a caveat trailing
 * it is a caveat. So every pattern is matched, and the one that matches EARLIEST wins, with the
 * list's own order kept only as the tiebreak at equal offset.
 *
 * Two coda-only phrasings (`don't take any risks`, `head back after`) were dropped from the
 * patterns outright rather than ranked, because they are never the primary imperative of a line
 * this coach speaks.
 *
 * A line matching nothing is `none`. `renderSaid` then prints the line and NO verdict — see there.
 */
export const actionOf = (text: string): AdvisedAction => {
	let best: { at: number; order: number; action: AdvisedAction } | null = null
	for (let i = 0; i < ACTION_PATTERNS.length; i++) {
		const [kind, re, pick] = ACTION_PATTERNS[i]!
		const m = re.exec(text)
		if (!m) continue
		const at = m.index
		if (best !== null && (at > best.at || (at === best.at && i >= best.order))) continue
		best = { at, order: i, action: { kind, target: pick(m) } }
	}
	return best?.action ?? { kind: "none", target: null }
}

/**
 * Feed every line the coach speaks. PASS and empty strings are dropped, not logged — a turn that
 * chose silence is not something he heard, and recording it would make "you already said this"
 * count sentences nobody said.
 *
 * `latencySec` is the measured wall-clock from the brief being built to the first syllable; it is
 * what makes `endSec` the moment the advice actually LANDED rather than the moment it was thought.
 */
export const noteSaid = (s: MemoryState, text: string, atSec: number, latencySec: number): MemoryState => {
	const t = text.trim()
	if (t === "" || t.toUpperCase() === "PASS") return s
	s.said.push({
		atSec,
		endSec: atSec + Math.max(0, latencySec) + speechDurationSec(t),
		text: t,
		topic: topicOfText(t),
		premise: premiseOf(t).kind,
		action: actionOf(t),
		follow: null
	})
	return s
}

/** The last snapshot at or before `t`. */
const snapAt = (s: MemoryState, t: number): Snapshot | null => {
	let best: Snapshot | null = null
	for (const x of s.recent) if (x.tSec <= t && (best === null || x.tSec > best.tSec)) best = x
	return best
}

const snapsBetween = (s: MemoryState, a: number, b: number): Snapshot[] =>
	s.recent.filter(x => x.tSec >= a && x.tSec <= b)

const close = (u: Utterance, verdict: FollowVerdict, why: string, now: number): void => {
	u.follow = { verdict, why, closedAtSec: now }
}

/**
 * Settle every advice window that has run out.
 *
 * The invariant this whole function is written around: **unmeasurable never becomes did-not.** The
 * feed has no positions, so "did he walk to mid" is not a question it can answer, and a ledger that
 * scored it as disobedience would be inventing the most damaging kind of stat there is — one about
 * the player himself.
 */
const closeWindows = (s: MemoryState, now: number): void => {
	for (const u of s.said) {
		if (u.follow !== null) continue
		const kind = u.action.kind
		/*
		 * NOTHING is written for an unparsed line. `renderSaid` prints the line alone in that case;
		 * the old `UNKNOWN — no action was advised` was a statement ABOUT THE COACH'S OWN SENTENCE
		 * and it was false on 21 of the 43 real spoken lines, printed directly beneath a quoted
		 * imperative. See `actionOf`.
		 */
		if (kind === "none") continue
		const window = WINDOW_SEC[kind]
		if (now < u.endSec + window) continue

		const at = snapAt(s, u.endSec)
		const after = snapsBetween(s, u.endSec, u.endSec + window)
		if (!at || after.length === 0) {
			close(u, "unknown", "the feed has no samples inside that window", now)
			continue
		}
		const last = after.at(-1)!
		const died = after.some(x => x.d > at.d)
		/* A death ends the question for everything except a disengage, where it IS the answer. */
		if (died && kind !== "disengage") {
			close(u, "overtaken", "he died inside the window, so the advice stopped being live", now)
			continue
		}

		switch (kind) {
			case "back": {
				/*
				 * A TRANSITION, never a state. `refilled` used to be "HP and mana both above 95% at
				 * any sample", with no requirement that anything moved, so "go back and buy" said
				 * to a man already at full HP who never left the camp closed as FOLLOWED. And the
				 * `why` was written from the wrong pair: at 3:33 of the verified replay it printed
				 * `he backed: gold 19 to 189` — gold RISING, which is income, about a man who had
				 * already spent 906g BEFORE the line landed. That sentence reaches the model
				 * verbatim and it can quote it back at him.
				 *
				 * So: a gold DROP inside the window, or HP/mana that ROSE to full from below it.
				 * Neither observable and nothing to spend is `unknown`, not a did-not.
				 */
				const floorGold = Math.min(...after.map(x => x.gold))
				const spent = floorGold <= at.gold - BACK_GOLD_DROP
				const full = (x: Snapshot): boolean =>
					x.maxHp > 0 && x.hp / x.maxHp > 0.95 && (x.maxMana === 0 || x.mana / x.maxMana > 0.95)
				const healed = !full(at) && after.some(full)
				const couldSpend = at.gold >= BACK_GOLD_DROP
				close(
					u,
					spent ? "followed"
					: healed ? "followed"
					: couldSpend ? "not-observed"
					: "unknown",
					spent ? `he spent: gold ${r0(at.gold)} down to ${r0(floorGold)}`
					: healed ? `he refilled: health ${pct(at.hp, at.maxHp)} to ${pct(last.hp, last.maxHp)}, mana ${pct(at.mana, at.maxMana)} to ${pct(last.mana, last.maxMana)}`
					: couldSpend ?
						`no back inside ${window}s: gold never fell below ${r0(floorGold)} of his ${r0(at.gold)}, health still ${pct(last.hp, last.maxHp)}`
					:	`he had ${r0(at.gold)} gold, too little to have anything to buy, and he was already at ${pct(at.hp, at.maxHp)} health — this feed cannot tell whether he went`,
					now
				)
				break
			}
			case "buy": {
				/*
				 * A NEW item, not a held one. The old check searched only `last.items`, so an item
				 * he already owned when the advice landed read as FOLLOWED, and an item he simply
				 * could not afford read as `NOT OBSERVED — X is not in his items 90s later`. Both
				 * are statements the feed does not support.
				 */
				const want = (u.action.target ?? "").toLowerCase()
				/*
				 * A GENERIC target cannot be checked, so it is never a did-not.
				 *
				 * "buy your jungle item" is real advice and is classified as one, but the feed
				 * lists item DISPLAY NAMES and there is no row called "jungle item" — the thing he
				 * actually bought is a Mosstomper Seedling. Matching on the head word would then
				 * report `he finished Mosstomper Seedling instead of jungle pet`, which is a
				 * did-not about a man who did exactly as he was told. The module's own invariant
				 * settles it: unmeasurable never becomes did-not.
				 */
				if (/^(jungle item|jungle pet|boots)$/.test(want)) {
					close(u, "unknown", `"${u.action.target}" is a category, not an item name, and this feed lists only item names`, now)
					break
				}
				const head = want.split(" ")[0] ?? ""
				const fresh = last.items.filter(i => !at.items.includes(i))
				const got = head === "" ? undefined : fresh.find(i => i.toLowerCase().includes(head))
				const held = head === "" ? undefined : at.items.find(i => i.toLowerCase().includes(head))
				const other = fresh.filter(i => !CHURN.test(i))
				close(
					u,
					got ? "followed"
					: held ? "unknown"
					: other.length > 0 ? "not-observed"
					: "unknown",
					got ? `he bought ${got} inside the window`
					: held ? `he was already holding ${held} when that landed, so there was nothing to buy`
					: other.length > 0 ? `he finished ${other.join(", ")} instead of ${u.action.target}`
					: `nothing new appeared in his items in ${window}s — he had ${r0(at.gold)} gold, and this feed does not say what anything costs him`,
					now
				)
				break
			}
			case "farm": {
				const moved = last.cs - at.cs
				const span = last.tSec - at.tSec
				close(
					u,
					moved > 0 ? "followed"
					: u.endSec < CAMPS_SPAWN_SEC ? "unknown"
					: span < QUANTUM_HIDES_SEC ? "unknown"
					: "not-observed",
					moved > 0 ? `his reported farm moved ${at.cs} to ${last.cs}`
					: u.endSec < CAMPS_SPAWN_SEC ?
						`the camps had not spawned when that landed, so there was nothing to clear before ${clock(CAMPS_SPAWN_SEC)}`
					: span < QUANTUM_HIDES_SEC ?
						`his reported farm is still ${at.cs}, but farm is floored to tens and a whole camp hides inside one step`
					:	`his reported farm has not moved off ${at.cs} in ${r0(span)}s, longer than one floored step can hide`,
					now
				)
				break
			}
			case "objective": {
				/*
				 * On `mine`, not on the prose. `namer()` gives him his CHAMPION name, so the old
				 * `text.startsWith("you")` was false for every objective beat ever written and the
				 * drake he took at 30:43 of the verified replay closed as
				 * `NOT OBSERVED — Lillia took Ocean drake`.
				 */
				const fell = s.beats.find(b => b.kind === "objective" && b.tSec >= u.endSec && b.tSec <= u.endSec + window)
				close(
					u,
					!fell ? "unknown" : fell.mine ? "followed" : "not-observed",
					!fell ? `no objective fell in the ${window}s after` : fell.text,
					now
				)
				break
			}
			case "disengage": {
				/*
				 * CLAMPED, and HP loss is not evidence.
				 *
				 * `lost` went negative whenever his health only rose across the window, and
				 * `he survived and lost only -6% of his bar` is in the real replay of the recorded
				 * uncapped transcript, on its way into the model's context.
				 *
				 * The verdict itself was worse. There are no positions and no combat flag in this
				 * feed, so an HP drop with no death is ordinary camp damage — measured over
				 * split-03, 31 of 362 25-second windows (9%) show more than 35% max-HP loss with
				 * nobody dying. Only a DEATH settles a disengage; anything else is `unknown`.
				 */
				const floor = Math.min(...after.map(x => x.hp))
				const lost = Math.max(0, at.maxHp > 0 ? (at.hp - floor) / at.maxHp : 0)
				close(
					u,
					died ? "not-observed" : "unknown",
					died ? "he died inside the window"
					:	`he did not die; his health fell ${Math.round(100 * lost)}% of his bar, which this feed cannot separate from clearing a camp`,
					now
				)
				break
			}
			case "ward": {
				close(
					u,
					last.ward > at.ward ? "followed" : "not-observed",
					last.ward > at.ward ?
						`ward score ${at.ward.toFixed(1)} to ${last.ward.toFixed(1)}`
					:	`ward score unchanged at ${at.ward.toFixed(1)}`,
					now
				)
				break
			}
			case "gank": {
				/* There are NO POSITIONS. A kill is evidence he got there; nothing is evidence he
				 * did not, so the absence of one cannot be a verdict. */
				const kill = s.beats.find(b => b.kind === "my-kill" && b.tSec >= u.endSec && b.tSec <= u.endSec + window)
				close(
					u,
					kill ? "followed" : "unknown",
					kill ? kill.text : "nothing in this feed says whether he walked there — there are no positions",
					now
				)
				break
			}
		}
	}
}

/* ================================================================ rendering
 *
 * Nothing prose-shaped is stored. Every sentence below is recomputed on every render, so a wording
 * change takes effect on the next turn with no migration and no stale text in a live game.
 */

/**
 * The race as a MOVEMENT — and it is the LEVEL race now, not the CS race.
 *
 * ## What this used to render, and why it was a fabrication
 *
 * It rendered `csGap(myCs, cpCs)` at each point: `5:00 you at least +10 -> 10:00 you at least +20`.
 * `csGap` is careful about the client's flooring, so the sentence LOOKS like a measurement with its
 * uncertainty attached. The premise underneath it is false. The enemy jungler's `creepScore` in
 * this feed is not his farm — it is the part of his farm YOUR CLIENT WITNESSED, which for a jungler
 * is most of it missing. Audited against the post-game timeline of game 5639406342:
 *
 *     minute      feed   truth     what this line said
 *      5:00          0      32     you at least +28
 *     10:00         20      58     you at least +48
 *     14:00         30      84     you at least +50
 *     20:00         50     125     you at least +71
 *     25:00         60     156     you at least +92
 *     28:00         70     183     you at least +95
 *
 * He was level on farm all game. The coach told him he was up ninety-five and told him to keep
 * stealing Kayn's farm, and both FALSE cards in the blinded post-game grading of that game trace to
 * this one field. Widening the interval cannot fix it: the flooring is an error of at most nine and
 * this is an omission of a hundred and thirteen.
 *
 * ## Level is the same race and it is real
 *
 * Levels are exact for him and 94.5% exact for enemies over that game (93.5-97.0% across fourteen),
 * worst error two and every error transient. A jungler two levels down has lost the race a jungler
 * fifty CS down has lost, and it is a figure he cannot read off his HUD without clicking a portrait.
 *
 * Rendered as an interval of ONE, because the enemy level can be off by one either way in normal
 * operation: a one-level difference is not called a lead.
 */
export const renderRace = (s: MemoryState): string => {
	const pts = s.race.filter((r): r is RacePoint & { cpLevel: number } => r.cpLevel !== null)
	if (pts.length === 0) return ""
	/*
	 * PAIRS, and the caveat once at the end.
	 *
	 * The first draft appended "(one level is inside this read's own error)" to every point and ran
	 * 480 characters, which inside `renderNarrativeWithin`'s budget evicted three beats — including
	 * the counterpart's build, the one thing in the section he cannot see. A caveat repeated five
	 * times is the same caveat and it costs a fact each time.
	 */
	const phrase = (r: RacePoint & { cpLevel: number }): string => `${clock(r.tSec)} ${r.myLevel}-${r.cpLevel}`
	const shown = pts.length <= 5 ? pts : [pts[0]!, ...pts.slice(-4)]
	return `The LEVEL race against ${s.counterpart ?? "the enemy jungler"}, you-him: ${shown.map(phrase).join(" -> ")}. One level is inside the enemy-level read's own error. There is no CS race here: his farm figure counts sightings, not farm.`
}

/**
 * How old the enemy jungler's figures are, which is the only thing that makes them safe to quote.
 *
 * His row is FOG-GATED — it freezes while he is out of vision and jumps when he is seen. So every
 * enemy level, farm and item is a LOWER BOUND of unknown age, and the age is the gap between now
 * and the last time the row moved. Without this line the coach said "Briar is still level one" at
 * 2:19 about a jungler who had been level 3 for half a minute, and called a lead "massive" off a
 * farm figure that had not refreshed in four minutes.
 */
/**
 * The last game clock at which ANYTHING on the counterpart's row moved, or null if nothing ever has.
 *
 * `cpSeen` has been computed on every `observe` since this file was written and NOTHING READ IT into
 * a payload. `buildBrief` takes exactly this number as `counterpartSeenSec` and documents that null
 * "renders as no age this turn rather than as freshness" — so with no caller passing it, every turn
 * of every game asserted the enemy jungler's row was current, which is the precise opposite of what
 * the field exists to say.
 *
 * Measured on game 5639406342: at 2:06 the feed's Kayn row still read level 1, frozen since the
 * loading screen, while the post-game timeline has him at level 2. The coach was handed "Kayn:
 * alive, lvl 1 — 2 levels BELOW you ... his row carries no age this turn" and said "you are two
 * whole levels up on Kayn". One level of that was fog, presented as measurement. This is the same
 * shape as the enemy-CS defect and it survived the fix for it, because that fix removed CS from the
 * payload and left LEVEL — which is exact at the checkpoints and stale early — behind it.
 *
 * The MAXIMUM of the three, not the level's own clock: the question the brief asks is how old the
 * row is, and any of the three moving is evidence the row was refreshed. Taking the level's clock
 * alone would call a row stale while his item list was updating in front of us.
 */
export const cpSeenAt = (s: MemoryState): number | null => {
	const items = s.cpSeen.items === 0 ? null : s.cpSeen.items
	const clocks = [s.cpSeen.level, s.cpSeen.cs, items].filter((n): n is number => n !== null)
	return clocks.length === 0 ? null : Math.max(...clocks)
}

/**
 * The observed death instants, for `buildBrief`'s `deathsSeen`.
 *
 * Read-only by contract and handed over without a copy: the brief renders it and computes one
 * subtraction from it. See `MemoryState.deadAt` for why the instant is watched rather than derived.
 */
export const deathsSeen = (s: MemoryState): Readonly<Record<string, DeathSeen>> => s.deadAt

export const renderCounterpart = (s: MemoryState, now: number): string => {
	const last = s.recent.at(-1)
	if (!last || last.cpCs === null || last.cpLevel === null) return ""
	const name = s.counterpart ?? "the enemy jungler"
	const seen = (at: number | null): string => (at === null ? "never moved" : age(now - at))
	/*
	 * TWO LINES. What the freezing MEANS is a paragraph of the system prompt, paid once at socket
	 * setup; what this has to carry every turn is the ages, which nothing else in the app knows.
	 * An earlier draft spent 250 characters restating the property and squeezed the beat log it
	 * shares a budget with down to a single beat.
	 */
	/*
	 * HIS FARM FIGURE IS GONE FROM THIS LINE, and its DERIVATIVE has replaced it.
	 *
	 * The figure itself is a sightings count and was rendered as `50 farm` about a jungler on 125 —
	 * see `renderRace` for the audited table. But the moment that counter MOVES is real information
	 * and nothing else in the feed carries it: it only advances on farm your own team witnessed, so
	 * a tick is a confirmed sighting of him. It fires seven times in a 28-minute game, because it is
	 * floored to tens and only crosses a boundary every tenth witnessed kill.
	 *
	 * That asymmetry is stated rather than glossed. A recent tick PROVES he was seen; a stale tick
	 * proves nothing at all, because nine witnessed minions and a fully-watched gank both leave it
	 * where it was. Written the other way round — "not seen for 4m" — it would be a fabrication, and
	 * it is exactly the sentence a reader would otherwise construct from a bare age.
	 */
	const tick = s.cpSeen.cs
	return [
		`${name.toUpperCase()}, LAST SEEN`,
		`lvl ${last.cpLevel} (${seen(s.cpSeen.level)}), ${last.cpItems.length} items (${seen(s.cpSeen.items === 0 ? null : s.cpSeen.items)})${
			last.cpItems.length === 0 ? " — an empty list means he has not been seen, not that he has bought nothing" : `: ${last.cpItems.join(", ")}`
		}.`,
		tick === null ?
			"His farm counter has never moved, and that counter is a sightings count rather than his farm, so it says nothing about how much he has cleared."
		:	`His farm counter last ticked ${age(now - tick)}; it only advances on farm your team witnessed, so he was certainly seen then. A stale one is NOT evidence he is unseen.`
	].join("\n")
}

/**
 * Everything that has happened, in time order, compacted by age.
 *
 * "accumulated, not a fresh reading" is in the heading on purpose: the rest of the payload is a
 * snapshot of the client and this section is the only part that outlives the client's own event
 * array, so a reader has to be told the difference.
 */
export const renderNarrative = (s: MemoryState, now: number, maxBeats: number = NARRATIVE_MAX_BEATS): string => {
	const kept = s.beats.filter(b => now - b.tSec < BEAT_TTL_SEC[b.weight])
	const lines = kept.slice(-maxBeats).map(b => `${clock(b.tSec)} ${b.text}`)
	const last = s.recent.at(-1)
	const head =
		last ? `You are ${s.me}, level ${last.level}, ${last.k}/${last.d}/${last.a}, ${csPhrase(last.cs)}.` : ""
	return ["THE GAME SO FAR (accumulated, not a fresh reading)", head, renderRace(s), ...lines]
		.filter(x => x !== "")
		.join("\n")
}

/**
 * The narrative, fitted to a byte budget by dropping the OLDEST beats.
 *
 * This is the half of the memory the owner actually asked for — "some context maintained in the
 * model as the game progresses". The client's own `events.Events` array scrolls, and the delta
 * only ever carries the gap since the last look, so without this a kill is gone from the thread
 * forever the moment the client stops sending it: at 6:42 of the stored run the payload held three
 * events from the last 37 seconds and the Hextech drake taken at 6:04 had already fallen out.
 */
export const renderNarrativeWithin = (s: MemoryState, now: number, budget: number): string => {
	for (let n = NARRATIVE_MAX_BEATS; n >= 1; n--) {
		const text = renderNarrative(s, now, n)
		if (text.length <= budget) return text
	}
	return renderNarrative(s, now, 1)
}

/**
 * THE GAME SO FAR, exactly as every caller sends it: the beat log and how stale his opponent's row
 * is, composed here so the route and the bench cannot compose it differently.
 *
 * A bench that assembles the payload from the same parts in a different order is measuring a
 * fourth architecture, which is the failure `coachTurn`'s single-path design exists to prevent.
 * `renderCounterpart` shares the budget rather than getting its own: it is three lines, and it is
 * about the one player the whole coach is a comparison against.
 */
export const renderGameSoFar = (s: MemoryState, now: number, budget: number): string => {
	const cp = renderCounterpart(s, now)
	const story = renderNarrativeWithin(s, now, Math.max(120, budget - cp.length - 2))
	return [story, cp].filter(x => x !== "").join("\n\n")
}

const verdictLine = (f: FollowThrough | null): string =>
	f === null ? "still open"
	: f.verdict === "followed" ? `FOLLOWED — ${f.why}`
	: f.verdict === "not-observed" ? `NOT OBSERVED — ${f.why}`
	: f.verdict === "overtaken" ? `OVERTAKEN — ${f.why}`
	: `UNKNOWN — ${f.why}`

/**
 * What the coach already said, with what the feed did next.
 *
 * The topic tally at the foot is the cheapest cure for the measured monoculture: it makes "clear /
 * camps / tempo x9" a visible number rather than something only a transcript reader could notice.
 */
export const renderSaid = (s: MemoryState, now: number, maxLines: number = SAID_MAX_LINES): string => {
	if (s.said.length === 0)
		return "WHAT YOU HAVE ALREADY SAID THIS GAME\nNothing yet — this is your first line of the game."
	const rows = s.said.slice(-maxLines).map(u => {
		const head = `${clock(u.atSec)} (${age(now - u.atSec)}) "${u.text}"`
		/*
		 * An unparsed line renders as the QUOTED LINE ALONE.
		 *
		 * `actionOf` still returns `none` on 16% of the real spoken lines (down from 49%, measured
		 * over the same 43), and a line it could not parse is a line about which this module knows
		 * nothing beyond the fact that it was said. Printing `[topic/none] -> UNKNOWN — no action
		 * was advised` under a quoted imperative told the model something false about its own
		 * transcript. The quote alone is honest, and it is all the anti-repetition value needs.
		 */
		if (u.action.kind === "none" || u.follow === null) return head
		const tag = `${u.topic}/${u.action.kind}${u.action.target !== null ? `:${u.action.target}` : ""}`
		return `${clock(u.atSec)} (${age(now - u.atSec)}) [${tag}] "${u.text}"\n    -> ${verdictLine(u.follow)}`
	})
	const topics = s.said.map(u => u.topic)
	const counts = [...new Set(topics)]
		.map(t => [t, topics.filter(x => x === t).length] as const)
		.sort((a, b) => b[1] - a[1])
	/*
	 * The heading is a HEADING. It used to end "(do not say it again unless it has changed)", which
	 * is an instruction about what to say and therefore a guardrail — the one thing this module
	 * promises not to be. Nothing shipped it only because both callers happened to strip line 1.
	 * The section is context; the model decides what to do with it.
	 */
	return [
		"WHAT YOU HAVE ALREADY SAID THIS GAME",
		...rows,
		`Topics so far: ${counts.map(([t, n]) => `${t} x${n}`).join(", ")}. Total lines: ${s.said.length}.`
	].join("\n")
}

/**
 * The same log, fitted to a byte budget by dropping the OLDEST rows.
 *
 * `buildDelta` gave this section rank 0 and no budget of its own, and its rows grow as verdict text
 * is appended, so from about 3:00 of the stored run it plateaued above the 1,500-char cap and
 * evicted CLOCKS and then MOVED from every remaining turn — permanently, not transiently. What was
 * evicted at 274.1s is verbatim `Voidgrubs: up at 5:00, in 26s.` and every enemy's purchases, which
 * are precisely the not-visible facts this coach exists to say. The coach then improvised about
 * grubs at 5:22 and 6:05 with the grub timer removed from its payload.
 *
 * Newest rows are kept because the anti-repetition value is in what was said RECENTLY; the topic
 * tally at the foot still counts the whole game, so a monoculture stays visible even when its rows
 * have scrolled off.
 */
export const renderSaidWithin = (s: MemoryState, now: number, budget: number): string => {
	for (let n = SAID_MAX_LINES; n >= 1; n--) {
		const text = renderSaid(s, now, n)
		if (text.length <= budget) return text
	}
	return renderSaid(s, now, 1)
}

/*
 * `renderSinceLastLook` and `renderMemory` USED TO LIVE HERE and have been deleted.
 *
 * Both were exported, both were tested, and neither was ever called outside the test file — the
 * only renderer the model has ever seen is `renderSaid`, and now `renderGameSoFar`. Their doc
 * comments described a payload the model never received, which is how a later reader concludes the
 * game history is already covered and stops looking.
 *
 * `renderSinceLastLook` was also redundant by the time it would have shipped: the delta's own
 * `sinceBlock` diffs against the previous TURN, which is the same interval, and `newEventsBlock`
 * plus the narrative carry the beats in between. `lastLookSec` and `markLooked` went with it,
 * because nothing else read them.
 */
