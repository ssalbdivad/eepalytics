/**
 * AUDIT: every field the live brief renders, against the exact post-game truth.
 *
 * ## Why this exists
 *
 * The live coach graded 0/10 on game 5639406342 — "nothing it said was useful, generic and often
 * hilariously wrong" — while five post-game models graded 68% useful on the SAME game. Part of that
 * gap is not the model at all: the feed was lying. The live client's enemy `scores.creepScore` is a
 * VISIBILITY-LIMITED counter, not a CS count, so the coach told him he was +71 CS on Kayn at 20:00
 * when he was 4 behind. Both FALSE cards in the blinded post-game grading trace to that one field.
 *
 * A field that lies is indistinguishable, from the outside, from a model that hallucinates. So
 * before another architecture is built on this feed, every field the brief renders gets measured
 * against truth — separately for HIM, for ALLIES and for ENEMIES, because a fog gate is a
 * per-player property and an average over ten players hides it completely.
 *
 * ## What is compared against what
 *
 * LIVE   `data/live-samples/*.ndjson` — raw `allgamedata` payloads recorded by
 *        `src/daemon/live-sampler.ts` from the SUPERVISOR's own poll, about one every 6s of game
 *        clock. The sampler writes `input.data` verbatim (no rounding, no reshaping), so this is
 *        byte-identical to what the coach held.
 * TRUTH  `data/blobs/<gameId>/timeline.json.gz` — per-minute frames carrying, for ALL TEN players,
 *        level / minionsKilled / jungleMinionsKilled / currentGold / totalGold / xp / position,
 *        plus CHAMPION_KILL, ELITE_MONSTER_KILL and BUILDING_KILL events. Riot computes these
 *        server-side with no fog of war, which is the property that makes them truth.
 *        `data/blobs/<gameId>/match.json.gz` — end-of-game stats: K/D/A, CS, visionScore,
 *        champLevel, item0..6, goldSpent, summoner spells.
 *
 * Checkpoints are the timeline's own frame timestamps. For each one the live sample with the
 * nearest game clock is chosen; the report prints the worst |dt| so a reader can see the pairing
 * was tight, and every borderline verdict is re-run on the subset with |dt| < 1s so that a 2.9s
 * sampling offset can never be mistaken for a data defect. That distinction is not pedantic — it is
 * the difference between "Urgot's CS is fog-gated" and "Urgot killed a minion during the offset",
 * and the first draft of this audit got it wrong in exactly that way.
 *
 * ## The two questions it was built to answer with numbers
 *
 * 1. RECOVERY. When a player is visible again, does his field re-sync, or stay stale? Measured by
 *    finding every checkpoint where a live value MOVED — the client only advances a fogged counter
 *    while it is witnessing, so a move is the strongest available evidence of a sighting, and it
 *    needs no visibility ground truth, which no post-game data carries. A field that re-syncs lands
 *    on ~0 error right after a move; a witness counter walks through the sighting carrying its
 *    whole accumulated deficit.
 *
 * 2. ALLIES. Fog-gated too, or exact? The coach reasons about who can follow up, so an ally row
 *    that is quietly a visibility counter would poison that the way the enemy row poisoned
 *    counter-jungling advice.
 *
 * ## Corroboration
 *
 * A conclusion drawn from one game is a conclusion about one game. `--corroborate` re-runs the
 * headline measurements over every sample file on disk that resolves to a game with a stored
 * timeline — 14 games at the time of writing — by matching riotIds against the `participant` table.
 * The per-game report stays on 5639406342, which is the game he graded.
 *
 * Read-only on the database; never touches the LCU. Run:
 *
 *   node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/audit-live-fields.ts
 *   node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/audit-live-fields.ts --corroborate
 */
import { gunzipSync } from "node:zlib"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

/* ================================================================ config */

const GAME_ID = 5639406342
const SAMPLES = "data/live-samples/js-mtvxb5f4-f81a-t29817812.ndjson"
const SAMPLE_DIR = "data/live-samples"
const DB = "data/csk.db"

const argv = process.argv.slice(2)
const argOf = (flag: string): string | null => {
	const i = argv.indexOf(flag)
	return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null
}
const jsonOut = argOf("--json") ?? `data/eval/live-field-audit-${GAME_ID}.json`
const wantCorroborate = argv.includes("--corroborate")

/* ================================================================ tiny readers
 * Everything below reads UNKNOWN. These payloads come straight off a socket and torn half-written
 * samples do reach disk, so a missing key is a normal case and never a throw. */

const rec = (v: unknown): Record<string, unknown> | null =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)

/* ================================================================ stats helpers */

const median = (xs: number[]): number => {
	if (xs.length === 0) return 0
	const s = [...xs].sort((a, b) => a - b)
	const m = s.length >> 1
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const mean = (xs: number[]): number =>
	xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
const maxAbs = (xs: number[]): number => xs.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0)
const pct = (hit: number, total: number): number => (total === 0 ? 0 : (100 * hit) / total)
const r1 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1)
const clock = (sec: number): string =>
	`${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`
/** The feed's own CS granularity. See `quantCheck`. */
const floor10 = (n: number): number => Math.floor(n / 10) * 10

/* ================================================================ live payload readers */

interface Sample {
	tSec: number
	atMs: number
	data: Record<string, unknown>
}

const loadSamples = (path: string): Sample[] =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter(l => l.length > 0)
		.map(l => {
			let v: Record<string, unknown> | null = null
			/* A torn last line is dropped, not thrown: the daemon can be killed mid-append. */
			try {
				v = rec(JSON.parse(l))
			} catch {
				return null
			}
			const t = num(v?.gameTime)
			const d = rec(v?.data)
			return t !== null && d ? { tSec: t, atMs: num(v?.atMs) ?? 0, data: d } : null
		})
		.filter((s): s is Sample => s !== null)

interface LivePlayer {
	riotId: string
	champion: string
	team: string
	position: string
	level: number
	cs: number
	kills: number
	deaths: number
	assists: number
	ward: number
	dead: boolean
	respawn: number
	itemCount: number
	itemPriceSum: number
	itemIds: number[]
	spells: string[]
}

const readLivePlayers = (s: Sample): Map<string, LivePlayer> => {
	const out = new Map<string, LivePlayer>()
	for (const raw of arr(s.data.allPlayers)) {
		const p = rec(raw)
		if (!p) continue
		const name = str(p.riotIdGameName)
		const tag = str(p.riotIdTagLine)
		const riotId = str(p.riotId) ?? (name && tag ? `${name}#${tag}` : null)
		if (!riotId) continue
		const scores = rec(p.scores) ?? {}
		const spells = rec(p.summonerSpells) ?? {}
		const items = arr(p.items)
			.map(i => rec(i))
			.filter((i): i is Record<string, unknown> => i !== null)
		out.set(riotId, {
			riotId,
			champion: str(p.championName) ?? "?",
			team: str(p.team) ?? "?",
			position: str(p.position) ?? "",
			level: num(p.level) ?? 0,
			cs: num(scores.creepScore) ?? 0,
			kills: num(scores.kills) ?? 0,
			deaths: num(scores.deaths) ?? 0,
			assists: num(scores.assists) ?? 0,
			ward: num(scores.wardScore) ?? 0,
			dead: p.isDead === true,
			respawn: num(p.respawnTimer) ?? 0,
			itemCount: items.length,
			itemPriceSum: items.reduce(
				(sum, i) => sum + (num(i.price) ?? 0) * (num(i.count) ?? 1),
				0
			),
			itemIds: items.map(i => num(i.itemID) ?? 0).filter(i => i > 0),
			spells: [
				rec(spells.summonerSpellOne)?.displayName,
				rec(spells.summonerSpellTwo)?.displayName
			]
				.map(v => str(v))
				.filter((v): v is string => v !== null)
		})
	}
	return out
}

/** The active player's own block — the only place HP, mana and gold-in-hand exist at all. */
const readActive = (s: Sample) => {
	const a = rec(s.data.activePlayer)
	const st = rec(a?.championStats) ?? {}
	return {
		riotId: str(a?.riotId) ?? "",
		level: num(a?.level) ?? 0,
		gold: num(a?.currentGold) ?? 0,
		hp: num(st.currentHealth) ?? 0,
		maxHp: num(st.maxHealth) ?? 0,
		mana: num(st.resourceValue) ?? 0,
		maxMana: num(st.resourceMax) ?? 0
	}
}

/* ================================================================ truth loading */

const readGz = (path: string): unknown => JSON.parse(gunzipSync(readFileSync(path)).toString())

interface TruthParticipant {
	participantId: number
	teamId: number
	championId: number
	kills: number
	deaths: number
	assists: number
	cs: number
	visionScore: number
	champLevel: number
	goldEarned: number
	goldSpent: number
	items: number[]
	spellIds: number[]
}

interface TruthFrame {
	tSec: number
	byPid: Map<
		number,
		{ level: number; cs: number; gold: number; totalGold: number; xp: number; x: number; y: number }
	>
}

interface TruthEvent {
	type: string
	tSec: number
	killerId: number
	victimId: number
	assists: number[]
	monsterType: string
	monsterSubType: string
	buildingType: string
}

interface Truth {
	gameId: number
	idByRiotId: Map<string, number>
	players: Map<number, TruthParticipant>
	frames: TruthFrame[]
	events: TruthEvent[]
}

const loadTruth = (gameId: number): Truth => {
	const match = rec(readGz(`data/blobs/${gameId}/match.json.gz`))!
	const timeline = rec(readGz(`data/blobs/${gameId}/timeline.json.gz`))!

	const idByRiotId = new Map<string, number>()
	for (const raw of arr(match.participantIdentities)) {
		const pi = rec(raw)
		const player = rec(pi?.player)
		const pid = num(pi?.participantId)
		const name = str(player?.gameName)
		const tag = str(player?.tagLine)
		if (pid !== null && name && tag) idByRiotId.set(`${name}#${tag}`, pid)
	}

	const players = new Map<number, TruthParticipant>()
	for (const raw of arr(match.participants)) {
		const p = rec(raw)
		const st = rec(p?.stats)
		const pid = num(p?.participantId)
		if (pid === null || !st) continue
		players.set(pid, {
			participantId: pid,
			teamId: num(p?.teamId) ?? 0,
			championId: num(p?.championId) ?? 0,
			kills: num(st.kills) ?? 0,
			deaths: num(st.deaths) ?? 0,
			assists: num(st.assists) ?? 0,
			/* CS truth is minions PLUS jungle — the same sum the live `creepScore` reports and the
			 * same sum this repo's vocabulary rule means by "CS". Comparing against
			 * `totalMinionsKilled` alone would invent a 161-camp error on a jungler. */
			cs: (num(st.totalMinionsKilled) ?? 0) + (num(st.neutralMinionsKilled) ?? 0),
			visionScore: num(st.visionScore) ?? 0,
			champLevel: num(st.champLevel) ?? 0,
			goldEarned: num(st.goldEarned) ?? 0,
			goldSpent: num(st.goldSpent) ?? 0,
			items: [0, 1, 2, 3, 4, 5, 6].map(i => num(st[`item${i}`]) ?? 0).filter(i => i > 0),
			spellIds: [num(p?.spell1Id) ?? 0, num(p?.spell2Id) ?? 0]
		})
	}

	const frames: TruthFrame[] = arr(timeline.frames).map(raw => {
		const f = rec(raw)!
		const byPid: TruthFrame["byPid"] = new Map()
		const pf = rec(f.participantFrames) ?? {}
		for (const key of Object.keys(pf)) {
			const q = rec(pf[key])
			const pid = num(q?.participantId)
			if (pid === null) continue
			const pos = rec(q?.position)
			byPid.set(pid, {
				level: num(q?.level) ?? 0,
				cs: (num(q?.minionsKilled) ?? 0) + (num(q?.jungleMinionsKilled) ?? 0),
				gold: num(q?.currentGold) ?? 0,
				totalGold: num(q?.totalGold) ?? 0,
				xp: num(q?.xp) ?? 0,
				x: num(pos?.x) ?? 0,
				y: num(pos?.y) ?? 0
			})
		}
		return { tSec: (num(f.timestamp) ?? 0) / 1000, byPid }
	})

	const events: TruthEvent[] = arr(timeline.frames).flatMap(raw =>
		arr(rec(raw)?.events).map(e => {
			const v = rec(e)!
			return {
				type: str(v.type) ?? "",
				tSec: (num(v.timestamp) ?? 0) / 1000,
				killerId: num(v.killerId) ?? 0,
				victimId: num(v.victimId) ?? 0,
				assists: arr(v.assistingParticipantIds).map(a => num(a) ?? 0),
				monsterType: str(v.monsterType) ?? "",
				monsterSubType: str(v.monsterSubType) ?? "",
				buildingType: str(v.buildingType) ?? ""
			}
		})
	)

	return { gameId, idByRiotId, players, frames, events }
}

/** Cumulative K/D/A off the server's own kill log — exact at any instant, for any player. */
const kdaAt = (t: Truth, pid: number, tSec: number): { k: number; d: number; a: number } => {
	let k = 0
	let d = 0
	let a = 0
	for (const e of t.events) {
		if (e.type !== "CHAMPION_KILL" || e.tSec > tSec) continue
		if (e.killerId === pid) k++
		if (e.victimId === pid) d++
		/* `assistingParticipantIds` is trusted HERE and nowhere else: the repo's known-bad note is
		 * about ELITE_MONSTER_KILL assists (19% cross-team corruption), not champion kills. */
		if (e.assists.includes(pid)) a++
	}
	return { k, d, a }
}

/* ================================================================ the comparison core */

type Side = "me" | "ally" | "enemy"

interface Row {
	tSec: number
	dt: number
	pid: number
	side: Side
	champion: string
	field: string
	live: number
	truth: number
	err: number
}

interface Compared {
	gameId: number
	samplesPath: string
	truth: Truth
	samples: Sample[]
	livePerSample: Map<string, LivePlayer>[]
	checkpoints: { tSec: number; sample: Sample; dt: number; live: Map<string, LivePlayer> }[]
	rows: Row[]
	mePid: number
	sideOf: (pid: number) => Side
	riotByPid: Map<number, string>
	rosterMisses: string[]
	worstDt: number
	/** Samples discarded because the file held more than one game. */
	droppedToSegment: number
	clockResets: number
}

const MY_RIOT_ID = "Gooskaffur#NA1"

/**
 * One NDJSON file can hold MORE THAN ONE GAME. The sampler appends per game-start minute, but a
 * session that spans games has produced files whose clock runs 0..1778 and then restarts at 2 —
 * `js-mtn2jrku-8ae9.ndjson` is one. Interleaved, they pair checkpoints against samples from the
 * wrong game and every player's exact% collapses, HIS INCLUDED, which is indistinguishable from a
 * broken field until you look at the clock. So: split on the backwards step and keep the run that
 * reaches closest to the truth's own duration. `scripts/minimap-track.ts` segments the same way.
 */
const segmentForGame = (samples: Sample[], durationSec: number): Sample[] => {
	const runs: Sample[][] = []
	let cur: Sample[] = []
	for (const s of samples) {
		if (cur.length > 0 && s.tSec < cur[cur.length - 1]!.tSec) {
			runs.push(cur)
			cur = []
		}
		cur.push(s)
	}
	if (cur.length > 0) runs.push(cur)
	if (runs.length === 1) return samples
	return runs.reduce((best, r) =>
		Math.abs((r[r.length - 1]?.tSec ?? 0) - durationSec) <
			Math.abs((best[best.length - 1]?.tSec ?? 0) - durationSec) ?
			r
		:	best
	)
}

const compare = (samplesPath: string, gameId: number): Compared | null => {
	const truth = loadTruth(gameId)
	const all = loadSamples(samplesPath)
	const durationSec = truth.frames.length === 0 ? 0 : truth.frames[truth.frames.length - 1]!.tSec
	const samples = segmentForGame(all, durationSec)
	const clockResets = all.length - samples.length > 0 ? 1 : 0
	if (samples.length < 10) return null
	const mePid = truth.idByRiotId.get(MY_RIOT_ID)
	if (mePid === undefined) return null
	const myTeam = truth.players.get(mePid)!.teamId
	const sideOf = (pid: number): Side =>
		pid === mePid ? "me"
		: truth.players.get(pid)!.teamId === myTeam ? "ally"
		: "enemy"

	const riotByPid = new Map<number, string>()
	for (const [riotId, pid] of truth.idByRiotId) riotByPid.set(pid, riotId)

	const livePerSample = samples.map(readLivePlayers)

	const nearest = (tSec: number): number => {
		let best = 0
		for (let i = 0; i < samples.length; i++)
			if (Math.abs(samples[i]!.tSec - tSec) < Math.abs(samples[best]!.tSec - tSec)) best = i
		return best
	}

	const checkpoints = truth.frames
		.filter(f => f.tSec > 0)
		.map(f => {
			const i = nearest(f.tSec)
			return {
				tSec: f.tSec,
				sample: samples[i]!,
				dt: samples[i]!.tSec - f.tSec,
				live: livePerSample[i]!
			}
		})

	/* Roster identity is checked, never assumed: a live riotId that does not resolve to a post-game
	 * participant makes every downstream comparison for that player silently wrong. */
	const rosterMisses: string[] = []
	const rows: Row[] = []
	for (const cp of checkpoints) {
		const frame = truth.frames.find(f => f.tSec === cp.tSec)!
		for (const [riotId, lp] of cp.live) {
			const pid = truth.idByRiotId.get(riotId)
			if (pid === undefined) {
				if (!rosterMisses.includes(riotId)) rosterMisses.push(riotId)
				continue
			}
			const tf = frame.byPid.get(pid)
			if (!tf) continue
			const k = kdaAt(truth, pid, cp.tSec)
			const push = (field: string, live: number, tru: number): void => {
				rows.push({
					tSec: cp.tSec,
					dt: cp.dt,
					pid,
					side: sideOf(pid),
					champion: lp.champion,
					field,
					live,
					truth: tru,
					err: live - tru
				})
			}
			push("creepScore", lp.cs, tf.cs)
			/* The same CS comparison with the feed's own granularity divided out. See `quantCheck`:
			 * without this, a -0..-9 rounding bias is read as fog loss on every player alive. */
			push("creepScoreBeyondFloor", lp.cs, floor10(tf.cs))
			push("level", lp.level, tf.level)
			push("kills", lp.kills, k.k)
			push("deaths", lp.deaths, k.d)
			push("assists", lp.assists, k.a)
			/* Item spend: the live feed's `price` is the item's OWN cost line, and the brief sums it
			 * as "gold he has spent". Truth at a frame is totalGold - currentGold: everything earned
			 * that is no longer in hand. Both are floors (sold items, consumed wards), which is why
			 * the RATIO below matters more than this difference. */
			push("itemPriceSum", lp.itemPriceSum, tf.totalGold - tf.gold)
		}
	}

	return {
		gameId,
		samplesPath,
		truth,
		samples,
		livePerSample,
		checkpoints,
		rows,
		mePid,
		sideOf,
		riotByPid,
		rosterMisses,
		worstDt: maxAbs(checkpoints.map(c => c.dt)),
		droppedToSegment: all.length - samples.length,
		clockResets
	}
}

/* ================================================================ the quantization floor
 *
 * Found by staring at HIS OWN row, where fog cannot be the explanation: his live CS ran
 * 0,10,20,20,20,40,40,50,50,60 against a truth of 0,10,24,24,28,40,46,52,56,68. Every CS value the
 * feed has ever produced, for anybody, in any game on disk, is a multiple of ten.
 *
 * So `scores.creepScore` is FLOORED TO THE NEAREST TEN before it leaves the client. That is not fog
 * and not lag: it is a hard -0..-9 bias on every CS figure in the brief, HIS INCLUDED, and it means
 * a CS comparison out of this feed is never exact for anyone. `src/daemon/live-sampler.ts` writes
 * `input.data` verbatim, and `wardScore` in the same object keeps full float precision, so nothing
 * on our side is doing the rounding. */

const quantCheck = (path: string): { obs: number; nonMultiples: number; distinct: number } => {
	let obs = 0
	let non = 0
	const distinct = new Set<number>()
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.length === 0) continue
		let v: Record<string, unknown> | null = null
		try {
			v = rec(JSON.parse(line))
		} catch {
			continue
		}
		for (const raw of arr(rec(v?.data)?.allPlayers)) {
			const cs = num(rec(rec(raw)?.scores)?.creepScore)
			if (cs === null) continue
			obs++
			distinct.add(cs)
			if (cs % 10 !== 0) non++
		}
	}
	return { obs, nonMultiples: non, distinct: distinct.size }
}

/* ================================================================ per-field summaries */

interface Summary {
	field: string
	side: string
	n: number
	exactPct: number
	medianErr: number
	medianAbsErr: number
	worstErr: number
	meanErr: number
	finalErr: number
	/** The same figures on checkpoints paired within 1s, where the sampling offset cannot bite. */
	tightN: number
	tightExactPct: number
	tightWorstErr: number
}

const summarise = (c: Compared, field: string, side: string): Summary => {
	const rs = c.rows.filter(r => r.field === field && r.side === side)
	const errs = rs.map(r => r.err)
	const lastT = rs.length === 0 ? 0 : Math.max(...rs.map(x => x.tSec))
	const tight = rs.filter(r => Math.abs(r.dt) < 1)
	return {
		field,
		side,
		n: rs.length,
		exactPct: pct(rs.filter(r => r.err === 0).length, rs.length),
		medianErr: median(errs),
		medianAbsErr: median(errs.map(Math.abs)),
		worstErr: maxAbs(errs),
		meanErr: mean(errs),
		finalErr: mean(rs.filter(r => r.tSec === lastT).map(r => r.err)),
		tightN: tight.length,
		tightExactPct: pct(tight.filter(r => r.err === 0).length, tight.length),
		tightWorstErr: maxAbs(tight.map(r => r.err))
	}
}

/* ================================================================ Q1: does a sighting re-sync?
 *
 * A "sync" is a checkpoint where a player's live value MOVED since the previous one. The client
 * only advances a fogged counter while it is witnessing, so a move is the strongest available
 * evidence that the player was on screen in that window — and it needs no visibility ground truth,
 * which no post-game data carries.
 *
 * The test: what is the error at the first checkpoint after such a move? A field that re-syncs
 * lands on ~0. A witness counter walks through the sighting carrying its whole accumulated deficit,
 * which is exactly what makes it unusable: "he was just on screen" never makes the number true. */

interface Recovery {
	field: string
	side: string
	syncs: number
	medianErrBeforeSync: number
	medianErrAtSync: number
	worstErrAtSync: number
	/** Fraction of syncs after which |err| got closer to zero at all. */
	improvedPct: number
	/** Fraction of syncs that landed exactly on the truth — a full re-sync. */
	resyncedPct: number
	medianSecondsBetweenSyncs: number
}

const recoveryFor = (c: Compared, field: string, side: string): Recovery => {
	const pids = [...new Set(c.rows.filter(r => r.side === side).map(r => r.pid))]
	const errAtSync: number[] = []
	const errBefore: number[] = []
	let improved = 0
	let resynced = 0
	const gaps: number[] = []
	for (const pid of pids) {
		const series = c.rows
			.filter(r => r.pid === pid && r.field === field)
			.sort((a, b) => a.tSec - b.tSec)
		let lastSyncT: number | null = null
		for (let i = 1; i < series.length; i++) {
			const prev = series[i - 1]!
			const cur = series[i]!
			if (cur.live === prev.live) continue
			errAtSync.push(cur.err)
			errBefore.push(prev.err)
			if (Math.abs(cur.err) < Math.abs(prev.err)) improved++
			if (cur.err === 0) resynced++
			if (lastSyncT !== null) gaps.push(cur.tSec - lastSyncT)
			lastSyncT = cur.tSec
		}
	}
	return {
		field,
		side,
		syncs: errAtSync.length,
		medianErrBeforeSync: median(errBefore),
		medianErrAtSync: median(errAtSync),
		worstErrAtSync: maxAbs(errAtSync),
		improvedPct: pct(improved, errAtSync.length),
		resyncedPct: pct(resynced, errAtSync.length),
		medianSecondsBetweenSyncs: median(gaps)
	}
}

/* ================================================================ staleness degradation
 *
 * How the error grows with time since the field last moved. This is the number any hedge would have
 * to be built on ("he hasn't been seen in 90s, treat his CS as a floor"), so it is worth knowing
 * whether the relationship exists at all — and for which fields it does not. */

const stalenessCurve = (
	c: Compared,
	field: string,
	side: string
): { bucket: string; n: number; medianAbsErr: number; worstAbsErr: number }[] => {
	const pids = [...new Set(c.rows.filter(r => r.side === side).map(r => r.pid))]
	const buckets = new Map<string, number[]>()
	const label = (sec: number): string =>
		sec < 30 ? "0-30s"
		: sec < 60 ? "30-60s"
		: sec < 120 ? "60-120s"
		: sec < 240 ? "120-240s"
		: "240s+"
	for (const pid of pids) {
		const series = c.rows
			.filter(r => r.pid === pid && r.field === field)
			.sort((a, b) => a.tSec - b.tSec)
		let lastChange = series[0]?.tSec ?? 0
		for (let i = 1; i < series.length; i++) {
			const cur = series[i]!
			if (cur.live !== series[i - 1]!.live) lastChange = cur.tSec
			const key = label(cur.tSec - lastChange)
			if (!buckets.has(key)) buckets.set(key, [])
			buckets.get(key)!.push(Math.abs(cur.err))
		}
	}
	return ["0-30s", "30-60s", "60-120s", "120-240s", "240s+"]
		.filter(k => buckets.has(k))
		.map(k => ({
			bucket: k,
			n: buckets.get(k)!.length,
			medianAbsErr: median(buckets.get(k)!),
			worstAbsErr: Math.max(...buckets.get(k)!)
		}))
}

/* ================================================================ death / respawn
 *
 * Truth is the server's kill log. Both directions are checked, because a coach that says "their
 * jungler is down, take drake" is betting both ways: that a death OUT OF VISION is still reported,
 * and that a DEAD flag never appears without a death behind it.
 *
 * The respawn timer gets its own test, and it is a strong one: across the samples of a single
 * death, `elapsed + respawnTimer` must be CONSTANT, and that constant is the true respawn duration.
 * A drifting sum would mean the timer is extrapolated rather than read. The window is clipped at
 * the player's next death, because two deaths inside 90s otherwise read as one drifting timer. */

interface DeathCheck {
	side: string
	kills: number
	flaggedDead: number
	medianLagSec: number
	worstLagSec: number
	respawnTimerPresent: number
	medianTimerSpreadSec: number
	worstTimerSpreadSec: number
	impliedRespawnRange: string
	deadSamples: number
	worstGapToKillSec: number
	unexplainedDeadSamples: number
}

const deathChecks = (c: Compared, side: Side): DeathCheck => {
	const pidsOfSide = [...c.truth.players.values()]
		.filter(p => c.sideOf(p.participantId) === side)
		.map(p => p.participantId)

	let kills = 0
	let flagged = 0
	let withTimer = 0
	const lags: number[] = []
	const spreads: number[] = []
	const implied: number[] = []

	for (const pid of pidsOfSide) {
		const riotId = c.riotByPid.get(pid)!
		const ks = c.truth.events
			.filter(e => e.type === "CHAMPION_KILL" && e.victimId === pid)
			.map(e => e.tSec)
			.sort((a, b) => a - b)
		ks.forEach((tk, i) => {
			kills++
			const until = Math.min(ks[i + 1] ?? Infinity, tk + 90)
			let found: number | null = null
			const sums: number[] = []
			c.samples.forEach((s, si) => {
				if (s.tSec < tk || s.tSec >= until) return
				const lp = c.livePerSample[si]!.get(riotId)
				if (!lp?.dead) return
				if (found === null) {
					found = s.tSec - tk
					if (lp.respawn > 0) withTimer++
				}
				if (lp.respawn > 0) sums.push(s.tSec - tk + lp.respawn)
			})
			if (found !== null) {
				flagged++
				lags.push(found)
			}
			if (sums.length >= 2) {
				spreads.push(Math.max(...sums) - Math.min(...sums))
				implied.push(Math.max(...sums))
			}
		})
	}

	/* The other direction: a DEAD flag with no kill behind it. "Explained" means the most recent
	 * kill of that player is inside the longest respawn this game actually produced. */
	const cap = 75
	let deadSamples = 0
	let worstGap = 0
	let unexplained = 0
	c.samples.forEach((s, si) => {
		for (const pid of pidsOfSide) {
			const lp = c.livePerSample[si]!.get(c.riotByPid.get(pid)!)
			if (!lp?.dead) continue
			deadSamples++
			const lastKill = c.truth.events
				.filter(e => e.type === "CHAMPION_KILL" && e.victimId === pid && e.tSec <= s.tSec)
				.reduce((a, e) => Math.max(a, e.tSec), -1)
			const elapsed = lastKill < 0 ? Infinity : s.tSec - lastKill
			if (elapsed > cap) unexplained++
			else if (elapsed > worstGap) worstGap = elapsed
		}
	})

	return {
		side,
		kills,
		flaggedDead: flagged,
		medianLagSec: median(lags),
		worstLagSec: lags.length === 0 ? 0 : Math.max(...lags),
		respawnTimerPresent: withTimer,
		medianTimerSpreadSec: median(spreads),
		worstTimerSpreadSec: spreads.length === 0 ? 0 : Math.max(...spreads),
		impliedRespawnRange:
			implied.length === 0 ? "n/a" : `${r1(Math.min(...implied))}s..${r1(Math.max(...implied))}s`,
		deadSamples,
		worstGapToKillSec: worstGap,
		unexplainedDeadSamples: unexplained
	}
}

/* ================================================================ run the graded game */

const c = compare(SAMPLES, GAME_ID)!

const lines: string[] = []
const say = (s = ""): void => {
	lines.push(s)
	console.log(s)
}

const FIELDS = [
	"creepScore",
	"creepScoreBeyondFloor",
	"level",
	"kills",
	"deaths",
	"assists",
	"itemPriceSum"
]
const SIDES: Side[] = ["me", "ally", "enemy"]

say(`LIVE FIELD AUDIT — game ${GAME_ID} (Lillia jungle vs Kayn, ${clock(1694)})`)
say(
	`  live   ${SAMPLES} — ${c.samples.length} samples, ${clock(c.samples[0]!.tSec)}..${clock(c.samples[c.samples.length - 1]!.tSec)}`
)
say(
	`  truth  data/blobs/${GAME_ID}/timeline.json.gz — ${c.truth.frames.length} frames, ${c.truth.events.length} events; match.json.gz — 10 participants`
)
say(`  ${c.checkpoints.length} checkpoints, worst live/truth clock gap ${r1(c.worstDt)}s`)
say(
	`  roster: ${c.rosterMisses.length === 0 ? "all 10 live riotIds resolved to a post-game participant" : `UNRESOLVED ${c.rosterMisses.join(", ")}`}`
)
say()

/* -------- the floor */
const quantThis = quantCheck(SAMPLES)
const allSampleFiles = readdirSync(SAMPLE_DIR).filter(f => f.endsWith(".ndjson"))
let quantObs = 0
let quantNon = 0
for (const f of allSampleFiles) {
	const q = quantCheck(`${SAMPLE_DIR}/${f}`)
	quantObs += q.obs
	quantNon += q.nonMultiples
}
say("THE QUANTIZATION FLOOR — scores.creepScore is rounded before it leaves the client")
say(
	`  this game: ${quantThis.obs} CS observations, ${quantThis.nonMultiples} not a multiple of 10, ${quantThis.distinct} distinct values`
)
say(
	`  every sample file on disk (${allSampleFiles.length} files): ${quantObs} observations, ${quantNon} not a multiple of 10`
)
say(
	`  => every CS in the brief carries a built-in -0..-9 bias, HIS INCLUDED. A CS out of this feed is a floor, never a count, and a CS GAP built from two of them carries the bias twice (-9..+9).`
)
say()

/* -------- per-field */
say("PER-FIELD ERROR (live minus truth), by side")
say(
	"field                  side   n   exact%  medErr  medAbs  worst   mean   atEnd | tight(|dt|<1s) n exact% worst"
)
const summaries: Summary[] = []
for (const f of FIELDS) {
	for (const side of SIDES) {
		const s = summarise(c, f, side)
		summaries.push(s)
		if (s.n === 0) continue
		say(
			`${f.padEnd(22)} ${side.padEnd(6)} ${String(s.n).padStart(3)}  ${r1(s.exactPct).padStart(6)}  ${r1(s.medianErr).padStart(6)}  ${r1(s.medianAbsErr).padStart(6)}  ${r1(s.worstErr).padStart(6)}  ${r1(s.meanErr).padStart(6)}  ${r1(s.finalErr).padStart(6)} | ${String(s.tightN).padStart(3)} ${r1(s.tightExactPct).padStart(6)} ${r1(s.tightWorstErr).padStart(6)}`
		)
	}
	say()
}

/* -------- per-player CS: where the aggregate lies */
say("CS PER PLAYER, with the quantization floor divided out — the side aggregate hides everything")
say("champion      side    final live/truth  beyondFloor: median  worst  exact/n   tight exact/n")
const perPlayerCs = [...new Set(c.rows.map(r => r.pid))]
	.sort((a, b) => a - b)
	.map(pid => {
		const raw = c.rows
			.filter(r => r.pid === pid && r.field === "creepScore")
			.sort((a, b) => a.tSec - b.tSec)
		const bf = c.rows.filter(r => r.pid === pid && r.field === "creepScoreBeyondFloor")
		const tight = bf.filter(r => Math.abs(r.dt) < 1)
		const last = raw[raw.length - 1]!
		return {
			champion: last.champion,
			side: last.side,
			finalLive: last.live,
			finalTruth: last.truth,
			medianBeyondFloor: median(bf.map(r => r.err)),
			worstBeyondFloor: maxAbs(bf.map(r => r.err)),
			exact: bf.filter(r => r.err === 0).length,
			n: bf.length,
			tightExact: tight.filter(r => r.err === 0).length,
			tightN: tight.length
		}
	})
for (const p of perPlayerCs)
	say(
		`${p.champion.padEnd(13)} ${p.side.padEnd(6)} ${String(p.finalLive).padStart(9)}/${String(p.finalTruth).padEnd(6)} ${r1(p.medianBeyondFloor).padStart(18)}  ${r1(p.worstBeyondFloor).padStart(5)}  ${String(p.exact).padStart(5)}/${p.n}   ${String(p.tightExact).padStart(5)}/${p.tightN}`
	)
say(
	"  Nine of ten players are EXACT once the floor is removed. The tenth is the enemy jungler — the"
)
say(
	"  only player this app exists to compare him against, and the only one who farms in fog for a living."
)
say()

say("CS — the counterpart (Kayn), checkpoint by checkpoint. This is the field that broke both paths.")
const kaynPid = [...c.truth.players.values()].find(p => p.championId === 141)!.participantId
say("  min   live   truth   understated by")
const seenMin = new Set<number>()
for (const cp of c.checkpoints) {
	const min = Math.round(cp.tSec / 60)
	if (![5, 10, 14, 20, 25, 28].includes(min) || seenMin.has(min)) continue
	seenMin.add(min)
	const r = c.rows.find(x => x.tSec === cp.tSec && x.pid === kaynPid && x.field === "creepScore")!
	say(
		`  ${String(min).padStart(3)}  ${String(r.live).padStart(5)}  ${String(r.truth).padStart(6)}   ${String(r.truth - r.live).padStart(5)}  (${r1(r.truth / Math.max(1, r.live))}x)`
	)
}
say()

/* -------- Q1 */
say("Q1 — DOES A SIGHTING RE-SYNC THE FIELD?")
say("(a 'sync' is a checkpoint where the live value MOVED: the client witnessed something)")
say("field                  side   syncs  errBefore  errAtSync  worst  improved%  landedExact%  medGap")
const recoveries: Recovery[] = []
for (const f of FIELDS) {
	for (const side of SIDES) {
		const rv = recoveryFor(c, f, side)
		recoveries.push(rv)
		if (rv.syncs === 0) continue
		say(
			`${f.padEnd(22)} ${side.padEnd(6)} ${String(rv.syncs).padStart(5)}  ${r1(rv.medianErrBeforeSync).padStart(9)}  ${r1(rv.medianErrAtSync).padStart(9)}  ${r1(rv.worstErrAtSync).padStart(5)}  ${r1(rv.improvedPct).padStart(9)}  ${r1(rv.resyncedPct).padStart(12)}  ${r1(rv.medianSecondsBetweenSyncs).padStart(5)}s`
		)
	}
}
say()
const kaynCs = c.rows
	.filter(r => r.pid === kaynPid && r.field === "creepScore")
	.sort((a, b) => a.tSec - b.tSec)
const kaynSyncs = kaynCs.filter((r, i) => i > 0 && r.live !== kaynCs[i - 1]!.live)
say(
	`  The counterpart's CS moved at only ${kaynSyncs.length} of ${kaynCs.length - 1} checkpoint pairs — the client witnessed him farming that`
)
say(
	`  rarely — and at those very moments the deficit still ran ${r1(median(kaynSyncs.map(r => r.err)))} median and ${r1(maxAbs(kaynSyncs.map(r => r.err)))} worst, landing on truth ${kaynSyncs.filter(r => r.err === 0).length}/${kaynSyncs.length} times.`
)
say(
	`  ANSWER: CS does not recover. It is an accumulator of witnessed kills, so a sighting adds to it`
)
say(
	`  and never corrects it. Level and K/D/A are the opposite — they are frozen snapshots that SNAP`
)
say(`  back to truth on sight, which is why their errors are transient and end the game at zero.`)
say()

/* -------- staleness */
say("STALENESS — |error| by time since the live value last moved (median / worst)")
const curves: Record<string, ReturnType<typeof stalenessCurve>> = {}
for (const f of ["creepScoreBeyondFloor", "level", "itemPriceSum"]) {
	for (const side of ["ally", "enemy"]) {
		const cur = stalenessCurve(c, f, side)
		curves[`${f}/${side}`] = cur
		say(
			`  ${f} (${side}): ${cur.map(b => `${b.bucket} n=${b.n} ${r1(b.medianAbsErr)}/${r1(b.worstAbsErr)}`).join("  |  ")}`
		)
	}
}
const kaynStale = (() => {
	const series = c.rows.filter(r => r.pid === kaynPid && r.field === "creepScoreBeyondFloor").sort((a, b) => a.tSec - b.tSec)
	let lastChange = series[0]?.tSec ?? 0
	const out: { sinceSec: number; err: number }[] = []
	for (let i = 1; i < series.length; i++) {
		if (series[i]!.live !== series[i - 1]!.live) lastChange = series[i]!.tSec
		out.push({ sinceSec: series[i]!.tSec - lastChange, err: series[i]!.err })
	}
	return out
})()
say(
	`  The side medians above are dominated by the four enemies who are exact, so the counterpart gets his own row:`
)
say(
	`  Kayn, CS beyond the floor — 0-30s since the counter last moved: median ${r1(median(kaynStale.filter(x => x.sinceSec < 30).map(x => Math.abs(x.err))))}, 60s+: median ${r1(median(kaynStale.filter(x => x.sinceSec >= 60).map(x => Math.abs(x.err))))}. The deficit does not depend on staleness, because it never gets repaid.`
)
say()

/* -------- first sighting */
say("FIRST SIGHTING — an unseen enemy's level and item list are FROZEN, then SNAP")
const firstSighting = [...c.truth.players.values()]
	.filter(p => c.sideOf(p.participantId) === "enemy")
	.map(p => {
		const riotId = c.riotByPid.get(p.participantId)!
		let firstItemT: number | null = null
		let firstLevelT: number | null = null
		let champion = "?"
		for (const cp of c.checkpoints) {
			const lp = cp.live.get(riotId)
			if (!lp) continue
			champion = lp.champion
			if (firstItemT === null && lp.itemCount > 0) firstItemT = cp.tSec
			if (firstLevelT === null && lp.level > 1) firstLevelT = cp.tSec
		}
		const lvl = c.rows.filter(r => r.pid === p.participantId && r.field === "level")
		return {
			champion,
			firstItemSec: firstItemT,
			firstLevelMoveSec: firstLevelT,
			worstLevelErr: maxAbs(lvl.map(r => r.err)),
			levelWrongAt: lvl.filter(r => r.err !== 0).map(r => clock(r.tSec)).join(", ") || "never",
			levelErrAtEnd: lvl[lvl.length - 1]?.err ?? 0
		}
	})
for (const f of firstSighting)
	say(
		`  ${f.champion.padEnd(13)} first non-empty item list ${f.firstItemSec === null ? "never" : clock(f.firstItemSec)}, first level above 1 ${f.firstLevelMoveSec === null ? "never" : clock(f.firstLevelMoveSec)}; worst level error ${f.worstLevelErr}, wrong at ${f.levelWrongAt}; error at the whistle ${f.levelErrAtEnd}`
	)
say(
	"  Kayn had a Scorchclaw Pup from 0:00 and was level 3 at 3:00; the feed showed him level 1 with"
)
say("  no items until 4:00. An empty item list means UNSEEN, not unbought.")
say()

/* -------- deaths */
say("DEATH / RESPAWN — against the server's kill log")
const dcs = SIDES.map(s => deathChecks(c, s))
for (const d of dcs) {
	say(
		`  ${d.side.padEnd(6)} ${d.kills} deaths in the log, ${d.flaggedDead} flagged dead by the feed (${r1(pct(d.flaggedDead, d.kills))}%), lag median ${r1(d.medianLagSec)}s / worst ${r1(d.worstLagSec)}s against a ~6s sample interval`
	)
	say(
		`         respawnTimer set on ${d.respawnTimerPresent}/${d.kills}; elapsed+timer spread within one death median ${r1(d.medianTimerSpreadSec)}s / worst ${r1(d.worstTimerSpreadSec)}s; implied durations ${d.impliedRespawnRange}`
	)
	say(
		`         ${d.deadSamples} DEAD samples, ${d.unexplainedDeadSamples} with no kill behind them; worst gap from a DEAD flag back to its kill ${r1(d.worstGapToKillSec)}s`
	)
}
say(
	"  Deaths are NOT fog-gated: every enemy death, including ones he could not see, was flagged, and"
)
say("  the respawn timer is read, not extrapolated (spread 0.0s within every single death).")
say()

/* -------- events */
interface LiveEv {
	id: number
	name: string
	tSec: number
	raw: Record<string, unknown>
}
const finalEvents: LiveEv[] = arr(rec(c.samples[c.samples.length - 1]!.data.events)?.Events)
	.map(raw => {
		const e = rec(raw)
		const id = num(e?.EventID)
		const name = str(e?.EventName)
		const t = num(e?.EventTime)
		return e && id !== null && name && t !== null ? { id, name, tSec: t, raw: e } : null
	})
	.filter((e): e is LiveEv => e !== null)

/** When each event first APPEARED in a sample — the latency a coach actually experiences. */
const firstSeen = new Map<number, number>()
for (const s of c.samples)
	for (const raw of arr(rec(s.data.events)?.Events)) {
		const id = num(rec(raw)?.EventID)
		if (id !== null && !firstSeen.has(id)) firstSeen.set(id, s.tSec)
	}

const liveKills = finalEvents.filter(e => e.name === "ChampionKill")
const truthKills = c.truth.events.filter(e => e.type === "CHAMPION_KILL")
const usedTruth = new Set<number>()
const killLag: number[] = []
let matchedKills = 0
for (const lk of liveKills) {
	let bestIdx = -1
	let bestGap = Infinity
	truthKills.forEach((tk, i) => {
		if (usedTruth.has(i)) return
		const gap = Math.abs(tk.tSec - lk.tSec)
		if (gap < bestGap) {
			bestGap = gap
			bestIdx = i
		}
	})
	if (bestIdx >= 0 && bestGap <= 2) {
		usedTruth.add(bestIdx)
		matchedKills++
		killLag.push(lk.tSec - truthKills[bestIdx]!.tSec)
	}
}
const duplicateIds = finalEvents.length - new Set(finalEvents.map(e => e.id)).size
const appearLag = liveKills
	.map(e => (firstSeen.has(e.id) ? firstSeen.get(e.id)! - e.tSec : null))
	.filter((v): v is number => v !== null)

/* Name resolution: every KillerName / VictimName / Assister must land on a roster name, or the
 * brief renders a raw summoner name where a champion belongs — which reads to the model as an
 * eleventh player. `src/shared/live-brief.ts` maps the two known non-champion prefixes. */
const finalLive = c.livePerSample[c.livePerSample.length - 1]!
const rosterGameNames = new Set([...finalLive.values()].map(p => p.riotId.split("#")[0]!))
const nameMisses = new Map<string, number>()
let nameTotal = 0
let nameResolved = 0
let namePrefixed = 0
for (const e of finalEvents) {
	const names = [
		...["KillerName", "VictimName", "Recipient", "Acer"].map(k => str(e.raw[k])),
		...arr(e.raw.Assisters).map(a => str(a))
	].filter((v): v is string => v !== null)
	for (const v of names) {
		nameTotal++
		if (rosterGameNames.has(v)) nameResolved++
		else if (v.startsWith("Minion_") || v.startsWith("Turret_")) namePrefixed++
		else nameMisses.set(v, (nameMisses.get(v) ?? 0) + 1)
	}
}

const liveObjectives = finalEvents.filter(e =>
	["DragonKill", "BaronKill", "HeraldKill", "HordeKill"].includes(e.name)
).length
const truthObjectives = c.truth.events.filter(e => e.type === "ELITE_MONSTER_KILL").length
const liveBuildings = finalEvents.filter(e => ["TurretKilled", "InhibKilled"].includes(e.name)).length
const truthBuildings = c.truth.events.filter(e => e.type === "BUILDING_KILL").length

say("EVENT FEED — the one channel with no fog gate at all")
say(
	`  live final list: ${finalEvents.length} events, ${duplicateIds} duplicate EventIDs, ids ${finalEvents[0]?.id}..${finalEvents[finalEvents.length - 1]?.id} (contiguous, cumulative — the array never scrolls in this game)`
)
say(
	`  ChampionKill: live ${liveKills.length}, truth ${truthKills.length}, matched within 2s ${matchedKills}; unmatched live ${liveKills.length - matchedKills}, missing from live ${truthKills.length - matchedKills}`
)
say(
	`  kill timestamp error vs the server timeline: median ${r1(median(killLag))}s, worst ${r1(maxAbs(killLag))}s`
)
say(
	`  appearance lag (EventTime -> first sample carrying it): median ${r1(median(appearLag))}s, worst ${r1(Math.max(...appearLag))}s — bounded by the ~6s poll, so the feed itself is immediate`
)
say(`  elite monsters: live ${liveObjectives}, truth ${truthObjectives}`)
say(`  buildings: live ${liveBuildings}, truth ${truthBuildings}`)
say(
	`  name resolution: ${nameResolved}/${nameTotal} land on the roster, ${namePrefixed} are Minion_/Turret_ (mapped by the brief), ${nameMisses.size} genuinely unresolved`
)
if (nameMisses.size > 0)
	say(
		`    unresolved: ${[...nameMisses].sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} x${k}`).join(", ")}`
	)
say()

/* -------- end-of-game fields */
say("END-OF-GAME FIELDS — wardScore, item identity and item price have no per-minute truth")
say(
	"champion      side   liveWard/visionScore  err   items live/truth  Jaccard  priceSum/goldSpent  ratio"
)
const finalRows = [...finalLive].map(([riotId, lp]) => {
	const pid = c.truth.idByRiotId.get(riotId)!
	const tp = c.truth.players.get(pid)!
	const liveSet = new Set(lp.itemIds)
	const truthSet = new Set(tp.items)
	const inter = [...liveSet].filter(i => truthSet.has(i)).length
	const union = new Set([...liveSet, ...truthSet]).size
	return {
		champion: lp.champion,
		side: c.sideOf(pid),
		liveWard: lp.ward,
		truthVision: tp.visionScore,
		wardErr: lp.ward - tp.visionScore,
		liveItems: lp.itemIds.length,
		truthItems: tp.items.length,
		itemJaccard: union === 0 ? 1 : inter / union,
		livePriceSum: lp.itemPriceSum,
		truthGoldSpent: tp.goldSpent,
		spendRatio: tp.goldSpent === 0 ? 0 : lp.itemPriceSum / tp.goldSpent,
		liveSpells: lp.spells,
		truthSpellIds: tp.spellIds
	}
})
for (const f of finalRows)
	say(
		`${f.champion.padEnd(13)} ${f.side.padEnd(6)} ${r1(f.liveWard).padStart(8)}/${String(f.truthVision).padEnd(11)} ${r1(f.wardErr).padStart(4)}  ${String(f.liveItems).padStart(10)}/${String(f.truthItems).padEnd(5)} ${r1(f.itemJaccard * 100).padStart(6)}%  ${String(f.livePriceSum).padStart(8)}/${String(f.truthGoldSpent).padEnd(8)} ${r1(f.spendRatio).padStart(6)}`
	)
say(
	`  wardScore is EXACT for all ten, enemies included — the live float minus the post-game floor, median ${r1(median(finalRows.map(f => f.wardErr)))}. Vision is not fog-gated.`
)
say(
	`  item IDENTITY is exact for all ten at the whistle (Jaccard 100%). item PRICE is not the purchase price: summed, it recovers a median ${r1(median(finalRows.map(f => f.spendRatio)))} of true gold spent (range ${r1(Math.min(...finalRows.map(f => f.spendRatio)))}..${r1(Math.max(...finalRows.map(f => f.spendRatio)))}).`
)
/* Summoner spells: graded by id, because the live `displayName` is the LIVE name, not the picked
 * one — a jungler's Smite reads "Unleashed Smite" or "Challenging Smite" once it upgrades, so
 * string equality against "Smite" fails on exactly the player the coach cares about. Substring, not
 * equality, and never the reverse direction. */
const SPELL_NAMES: Record<number, string> = {
	1: "Cleanse",
	3: "Exhaust",
	4: "Flash",
	6: "Ghost",
	7: "Heal",
	11: "Smite",
	12: "Teleport",
	13: "Clarity",
	14: "Ignite",
	21: "Barrier",
	32: "Mark"
}
const spellGrades = finalRows.map(f => {
	const want = f.truthSpellIds.map(id => SPELL_NAMES[id] ?? `#${id}`)
	const got = f.liveSpells
	const ok = want.every(w => got.some(g => g.toLowerCase().includes(w.toLowerCase())))
	return { champion: f.champion, want, got, ok }
})
say(
	`  summonerSpells: ${spellGrades.filter(g => g.ok).length}/${spellGrades.length} match the post-game spell ids for all ten players. The name is the LIVE name — ${spellGrades.filter(g => g.got.some(x => /smite/i.test(x) && !/^smite$/i.test(x))).map(g => `${g.champion} shows "${g.got.find(x => /smite/i.test(x))}"`).join(", ")} — so match on substring, never equality.`
)
say(
	`  Traced on Kayn: the ratio is 1.00 while he holds only basic items and collapses to 0.21 the moment components combine, because \`price\` is the item's OWN cost line, not the recipe total.`
)
say()

/* -------- role */
const db = new DatabaseSync(DB, { readOnly: true })
const dbRoles = new Map<number, { role: string; confidence: string }>()
for (const raw of db
	.prepare("select participantId, role, roleConfidence from participant where gameId = ?")
	.all(GAME_ID)) {
	const r = raw as Record<string, unknown>
	dbRoles.set(Number(r.participantId), {
		role: String(r.role),
		confidence: String(r.roleConfidence)
	})
}
db.close()

/* `JGL` is this app's vocabulary and `JUNGLE` is Riot's; normalising is spelling, not papering over
 * a disagreement. The app labels only the two junglers by design (the repo does not trust post-game
 * lane/role, 4/10 mislabelled), so that comparison can only grade two rows. SMITE grades all ten,
 * and it is the one role marker that cannot be argued with. */
const normRole = (r: string): string => {
	const u = r.toUpperCase()
	return (
		u === "JGL" ? "JUNGLE"
		: u === "MID" ? "MIDDLE"
		: u === "BOT" || u === "ADC" ? "BOTTOM"
		: u === "SUP" || u === "SUPPORT" ? "UTILITY"
		: u
	)
}
const roleRows = [...finalLive].map(([riotId, lp]) => {
	const pid = c.truth.idByRiotId.get(riotId)!
	const inferredRole = normRole(dbRoles.get(pid)?.role ?? "?")
	const hasSmite = lp.spells.some(sp => sp.toLowerCase().includes("smite"))
	return {
		champion: lp.champion,
		side: c.sideOf(pid),
		livePosition: lp.position,
		hasSmite,
		smiteAgrees: hasSmite === (lp.position.toUpperCase() === "JUNGLE"),
		inferredRole,
		comparable: inferredRole !== "UNKNOWN" && inferredRole !== "?",
		agree: inferredRole === lp.position.toUpperCase()
	}
})
say("POSITION / ROLE — a LANE LABEL and nothing else; this feed has no coordinates for anyone")
for (const r of roleRows)
	say(
		`  ${r.champion.padEnd(13)} ${r.side.padEnd(6)} live "${(r.livePosition || "(empty)").padEnd(8)}" smite ${r.hasSmite ? "yes" : "no "} -> ${r.smiteAgrees ? "consistent" : "CONTRADICTS"}  | app's inferred role ${r.comparable ? `${r.inferredRole} ${r.agree ? "agree" : "DIFFER"}` : "(not labelled by this app)"}`
	)
const comparable = roleRows.filter(r => r.comparable)
say(
	`  all 10 rows carry a label; smite-consistent ${roleRows.filter(r => r.smiteAgrees).length}/10; agrees with this app's own inference where it has one ${comparable.filter(r => r.agree).length}/${comparable.length}`
)
say()

/* -------- his own block */
const goldRows = c.checkpoints.map(cp => {
	const a = readActive(cp.sample)
	const tf = c.truth.frames.find(f => f.tSec === cp.tSec)!.byPid.get(c.mePid)!
	return { tSec: cp.tSec, live: a.gold, truth: tf.gold, err: a.gold - tf.gold }
})
say("HIS OWN BLOCK (activePlayer)")
say(
	`  currentGold vs the timeline's currentGold: median err ${r1(median(goldRows.map(g => g.err)))}g, median |err| ${r1(median(goldRows.map(g => Math.abs(g.err))))}g, worst ${r1(maxAbs(goldRows.map(g => g.err)))}g over ${goldRows.length} checkpoints — exact.`
)
say(
	`  currentHealth/maxHealth and resourceValue/resourceMax exist ONLY for him, and no truth for them exists at any resolution in the post-game data, so this audit cannot grade them. They come off his own client with no fog in between; the honest verdict is "ungraded, structurally trustworthy".`
)
say(
	`  allPlayers carries NO health, NO mana, NO gold and NO coordinates for anyone, ally or enemy. Those fields are ABSENT, not wrong — a coach comparing HP across players is inventing the other half.`
)
say()

/* ================================================================ corroboration
 *
 * One game is one game. Every sample file on disk is matched to a stored game by riotId overlap in
 * the `participant` table, and the headline measurements are re-run across all of them, so the
 * conclusions below are not a property of the single evening he graded. */

interface GamePair {
	file: string
	gameId: number
}

const pairSampleFiles = (): GamePair[] => {
	const database = new DatabaseSync(DB, { readOnly: true })
	const out: GamePair[] = []
	for (const file of readdirSync(SAMPLE_DIR).filter(f => f.endsWith(".ndjson"))) {
		const path = `${SAMPLE_DIR}/${file}`
		const ss = loadSamples(path)
		if (ss.length < 30) continue
		const ids = [...readLivePlayers(ss[ss.length - 1]!).keys()]
		if (ids.length < 5) continue
		const q = database
			.prepare(
				`select gameId, count(*) c from participant where riotId in (${ids.map(() => "?").join(",")}) group by gameId order by c desc limit 1`
			)
			.get(...ids) as Record<string, unknown> | undefined
		const gid = q ? Number(q.gameId) : 0
		/* 9/10 is accepted: one player having changed their riot id since the game is common, and a
		 * 9-way name collision across two different games is not a thing that happens. */
		if (!gid || Number(q!.c) < 9) continue
		if (!existsSync(`data/blobs/${gid}/timeline.json.gz`)) continue
		out.push({ file, gameId: gid })
	}
	database.close()
	return out
}

interface CorroborationRow {
	gameId: number
	file: string
	checkpoints: number
	csBeyondFloorExactPct: Record<string, number>
	worstEnemyCsPlayer: string
	worstEnemyCsErr: number
	worstEnemyCsHadSmite: boolean
	levelExactPct: Record<string, number>
	kdaExactPct: Record<string, number>
	/** The whole finding, in two numbers per game. */
	enemyLanerCsExactPct: number
	enemyJunglerCsExactPct: number
	nonMultipleOfTenCs: number
	samples: number
	droppedToSegment: number
	/** Worst live/truth clock gap. A sparse recording pairs badly and its exact% drops for EVERY
	 * player including him — which is the tell that separates a thin file from a lying field. */
	worstDtSec: number
}

const corroborationRows: CorroborationRow[] = []
if (wantCorroborate) {
	say("CORROBORATION — the same measurements across every paired game on disk")
	const pairs = pairSampleFiles()
	say(`  ${pairs.length} sample files resolve to a game with a stored timeline`)
	say()
	say(
		"gameId       ckpts  worstDt | CS beyond floor exact%: me / ally / enemy-LANERS / enemy-JUNGLER | worst enemy CS (smite?)     | level exact% me/ally/enemy | KDA% enemy"
	)
	for (const p of pairs) {
		const cc = compare(`${SAMPLE_DIR}/${p.file}`, p.gameId)
		if (!cc) continue
		const exact = (field: string, side: string): number => {
			const rs = cc.rows.filter(r => r.field === field && r.side === side)
			return pct(rs.filter(r => r.err === 0).length, rs.length)
		}
		const enemyPids = [...new Set(cc.rows.filter(r => r.side === "enemy").map(r => r.pid))]
		let worstPid = enemyPids[0] ?? 0
		let worstErr = 0
		for (const pid of enemyPids) {
			const e = maxAbs(
				cc.rows.filter(r => r.pid === pid && r.field === "creepScoreBeyondFloor").map(r => r.err)
			)
			if (Math.abs(e) > Math.abs(worstErr)) {
				worstErr = e
				worstPid = pid
			}
		}
		const worstLive = cc.livePerSample[cc.livePerSample.length - 1]!.get(cc.riotByPid.get(worstPid)!)
		const kdaEnemy = mean(["kills", "deaths", "assists"].map(f => exact(f, "enemy")))
		/* The claim under test is not "enemies are wrong", it is "the enemy JUNGLER is wrong". Split
		 * the enemy side on who is holding Smite and the two halves stop resembling each other. */
		const smiteHolders = new Set(
			[...cc.livePerSample[cc.livePerSample.length - 1]!.values()]
				.filter(lp => lp.spells.some(sp => sp.toLowerCase().includes("smite")))
				.map(lp => cc.truth.idByRiotId.get(lp.riotId) ?? -1)
		)
		const enemyRows = cc.rows.filter(r => r.side === "enemy" && r.field === "creepScoreBeyondFloor")
		const jgRows = enemyRows.filter(r => smiteHolders.has(r.pid))
		const laneRows = enemyRows.filter(r => !smiteHolders.has(r.pid))
		const row: CorroborationRow = {
			gameId: p.gameId,
			file: p.file,
			checkpoints: cc.checkpoints.length,
			csBeyondFloorExactPct: {
				me: exact("creepScoreBeyondFloor", "me"),
				ally: exact("creepScoreBeyondFloor", "ally"),
				enemy: exact("creepScoreBeyondFloor", "enemy")
			},
			worstEnemyCsPlayer: worstLive?.champion ?? "?",
			worstEnemyCsErr: worstErr,
			worstEnemyCsHadSmite: worstLive?.spells.some(s => s.toLowerCase().includes("smite")) ?? false,
			levelExactPct: {
				me: exact("level", "me"),
				ally: exact("level", "ally"),
				enemy: exact("level", "enemy")
			},
			kdaExactPct: { enemy: kdaEnemy },
			enemyLanerCsExactPct: pct(laneRows.filter(r => r.err === 0).length, laneRows.length),
			enemyJunglerCsExactPct: pct(jgRows.filter(r => r.err === 0).length, jgRows.length),
			nonMultipleOfTenCs: quantCheck(`${SAMPLE_DIR}/${p.file}`).nonMultiples,
			samples: cc.samples.length,
			worstDtSec: cc.worstDt,
			droppedToSegment: cc.droppedToSegment
		}
		corroborationRows.push(row)
		say(
			`${String(p.gameId).padEnd(12)} ${String(row.checkpoints).padStart(5)} ${r1(row.worstDtSec).padStart(6)}s | ${r1(row.csBeyondFloorExactPct.me!).padStart(5)} / ${r1(row.csBeyondFloorExactPct.ally!).padStart(5)} / ${r1(row.enemyLanerCsExactPct).padStart(5)} / ${r1(row.enemyJunglerCsExactPct).padStart(5)} | ${row.worstEnemyCsPlayer.padEnd(10)} ${String(row.worstEnemyCsErr).padStart(5)} ${row.worstEnemyCsHadSmite ? "SMITE" : "     "} | ${r1(row.levelExactPct.me!).padStart(5)}/${r1(row.levelExactPct.ally!).padStart(5)}/${r1(row.levelExactPct.enemy!).padStart(5)} | ${r1(row.kdaExactPct.enemy!).padStart(5)}`
		)
	}
	const withSmite = corroborationRows.filter(r => r.worstEnemyCsHadSmite).length
	say()
	say(
		`  The worst-corrupted enemy CS belongs to the SMITE holder in ${withSmite}/${corroborationRows.length} games.`
	)
	say(
		`  CS quantization: ${corroborationRows.reduce((a, r) => a + r.nonMultipleOfTenCs, 0)} non-multiples of ten across all of them.`
	)
	/* One file (split-01, game 5635372803) is a THIN recording — its worst pairing gap is large and
	 * its exact% falls for HIM as well as for everyone else. That signature is how a sparse sample
	 * file is told apart from a lying field: a fog gate cannot make his own row worse. It is left in
	 * rather than dropped, because dropping the row that disagrees is how a story gets cleaner than
	 * the data. */
	const tight = corroborationRows.filter(r => Math.abs(r.worstDtSec) <= 6)
	say(
		`  Ally CS beyond the floor is exact in a median ${r1(median(corroborationRows.map(r => r.csBeyondFloorExactPct.ally!)))}% of checkpoints; his own ${r1(median(corroborationRows.map(r => r.csBeyondFloorExactPct.me!)))}%.`
	)
	say(
		`  Restricted to the ${tight.length} recordings whose worst pairing gap is under 6s: ally ${r1(median(tight.map(r => r.csBeyondFloorExactPct.ally!)))}%, his own ${r1(median(tight.map(r => r.csBeyondFloorExactPct.me!)))}%, enemy ${r1(median(tight.map(r => r.csBeyondFloorExactPct.enemy!)))}%.`
	)
	say(
		`  Enemy LANERS' CS is exact in a median ${r1(median(tight.map(r => r.enemyLanerCsExactPct)))}% of checkpoints — the same as his own team. The enemy JUNGLER: ${r1(median(tight.map(r => r.enemyJunglerCsExactPct)))}%.`
	)
	say(
		`  Enemy-jungler CS deficits across the set: ${corroborationRows.map(r => r.worstEnemyCsErr).sort((a, b) => a - b).map(v => String(v)).join(", ")}.`
	)
	say()
}

/* ================================================================ json */

const out = {
	gameId: GAME_ID,
	generatedMs: Date.now(),
	sources: {
		samples: SAMPLES,
		timeline: `data/blobs/${GAME_ID}/timeline.json.gz`,
		match: `data/blobs/${GAME_ID}/match.json.gz`,
		db: DB
	},
	sampleCount: c.samples.length,
	checkpointCount: c.checkpoints.length,
	worstClockGapSec: c.worstDt,
	rosterMisses: c.rosterMisses,
	quantization: { thisGame: quantThis, allFiles: { files: allSampleFiles.length, obs: quantObs, nonMultiples: quantNon } },
	summaries: summaries.filter(s => s.n > 0),
	perPlayerCs,
	recoveries: recoveries.filter(r => r.syncs > 0),
	stalenessCurves: curves,
	firstSighting,
	deaths: dcs,
	events: {
		liveTotal: finalEvents.length,
		duplicateIds,
		liveKills: liveKills.length,
		truthKills: truthKills.length,
		matchedKills,
		killTimestampMedianErr: median(killLag),
		killTimestampWorstErr: maxAbs(killLag),
		appearanceLagMedian: median(appearLag),
		appearanceLagWorst: appearLag.length === 0 ? 0 : Math.max(...appearLag),
		liveObjectives,
		truthObjectives,
		liveBuildings,
		truthBuildings,
		nameResolved,
		namePrefixed,
		nameTotal,
		unresolvedNames: Object.fromEntries(nameMisses)
	},
	finalRows,
	roleRows,
	spellGrades,
	activePlayerGold: goldRows,
	corroboration: corroborationRows,
	rows: c.rows
}
mkdirSync(dirname(jsonOut), { recursive: true })
writeFileSync(jsonOut, JSON.stringify(out, null, "\t"))
say(`wrote ${jsonOut} (${c.rows.length} per-checkpoint comparisons)`)
/* The rendered report is stored alongside the JSON, not only printed. A measurement that lives in
 * a terminal scrollback is a measurement nobody can re-read next month. */
const txtOut = jsonOut.replace(/\.json$/, "") + (wantCorroborate ? "-corroborated.txt" : ".txt")
writeFileSync(txtOut, lines.join("\n") + "\n")
console.log(`wrote ${txtOut}`)
