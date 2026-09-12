/**
 * ROFL2 ("Replay V2") decoder — TypeScript port of the verified `.research/rofl2.mjs`.
 *
 * This is the OFFLINE FALLBACK. It must work with the League client closed, with no
 * network, and with no LCU: everything here is `fs` + `node:zlib`.
 *
 * What a `.rofl` gives you (see `.research/rofl-format.md` §0):
 *   - patch / gameVersion         (binary header)
 *   - game length in ms           (trailing JSON)
 *   - the full end-of-game scoreboard, 371 stats x 10 players, incl. every PUUID
 *   - NOT the gameId  -> parsed from the filename `<platformId>-<gameId>.rofl`
 *   - NOT positions, NOT per-minute frames, NOT events. Those come from the LCU
 *     timeline endpoint. The chunk/keyframe payloads are opaque engine netcode
 *     (proven in `.research/rofl-format.md` §4) — do not try to mine them.
 *
 * NODE ONLY. Never import this from `src/web`.
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { zstdDecompressSync } from "node:zlib"
import { REPLAY_DIR_WSL, patchOf } from "../shared/constants.ts"
import type { Role, TeamId } from "../shared/schema/domain.ts"

const MAGIC = "RIOT"
const ZSTD_MAGIC = 0xfd2fb528
/** The header is `15 + gameVersionLen` bytes and gameVersionLen is a u8, so 271 is exhaustive. */
const HEADER_PROBE_BYTES = 271
/** Sanity ceiling for the trailing JSON blob. The verified sample was 122,932 B. */
const MAX_META_BYTES = 64 * 1024 * 1024

/* ============================================================ public types */

/** Riot's own end-of-game `TEAM_POSITION`. Correct in the one file we could verify. */
export type RoflPosition = "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY" | ""

/**
 * One player's row out of `statsJson`.
 *
 * `raw` is the untouched ~371-key map — **every value in it is a string**, numbers
 * included, and the key set rotates every patch (all the `Missions_*` / `2026_S*`
 * battle-pass counters). Never index a fixed key list against `raw`; use `stat()`.
 * The typed fields below are the ones that were present and meaningful in the
 * verified sample.
 */
export interface RoflPlayerStats {
	/** Not a participantId — that concept does not exist in the file. 0-based row order. */
	index: number
	puuid: string
	summonerId: number | null
	gameName: string
	tagLine: string
	/** "Gooskaffur#NA1". `NAME` is empty on this patch; this is built from the Riot ID. */
	riotId: string
	/** Champion INTERNAL NAME (e.g. "LeeSin"). There is no numeric championId in the file. */
	championName: string
	teamId: TeamId
	win: boolean
	/** Riot's end-of-game position string, verbatim. */
	position: RoflPosition
	/** `position` mapped onto our Role union. "UNKNOWN" when absent/unmapped. */
	role: Role
	kills: number
	deaths: number
	assists: number
	/** Lane minions only, to match `ParticipantSummary.cs`. */
	cs: number
	/** Neutral (jungle) camps. Add to `cs` for a jungler's effective farm. */
	jungleCs: number
	enemyJungleCs: number
	gold: number
	goldSpent: number
	champLevel: number
	xp: number
	timePlayedSec: number
	visionScore: number
	wardsPlaced: number
	wardsKilled: number
	controlWardsBought: number
	damageToChampions: number
	damageTaken: number
	damageToObjectives: number
	damageToTurrets: number
	healOnTeammates: number
	timeSpentDeadSec: number
	turretTakedowns: number
	dragonKills: number
	baronKills: number
	riftHeraldKills: number
	/** Voidgrubs. */
	hordeKills: number
	objectivesStolen: number
	largestMultiKill: number
	largestKillingSpree: number
	spell1Id: number | null
	spell2Id: number | null
	/** ITEM0..ITEM6, in slot order. 0 = empty slot. */
	items: number[]
	keystoneId: number | null
	perkPrimaryStyle: number | null
	perkSubStyle: number | null
	/** PERK0..PERK5. */
	perks: number[]
	/** The whole untouched row. */
	raw: Record<string, string>
}

/** One entry of the segment table. `data` is present only from `decodeRoflSegments`. */
export interface RoflSegment {
	kind: "chunk" | "keyframe" | "manifest" | string
	type: number
	id: number
	nextId: number
	decLen: number
	/** 0 means the payload was stored raw. */
	compLen: number
	descOffset: number
	dataOffset: number
	/** float32 LE at payload byte 1 — seconds of game time. Monotonic across the file. */
	gameTimeSec: number | null
	data: Buffer
}

export interface RoflFile {
	/** Absolute path we read. */
	path: string
	/**
	 * From the FILENAME, not the file. `null` when the file has been renamed — the gameId
	 * is then lost permanently, so treat `<platformId>-<gameId>.rofl` as load-bearing.
	 */
	gameId: number | null
	/** Also from the filename. */
	platformId: string | null
	/** "16.17.810.4348" */
	gameVersion: string
	/** "16.17" — what the UI groups by. */
	patch: string
	/** Milliseconds. Cross-checks against each player's TIME_PLAYED (seconds). */
	gameLengthMs: number
	formatVersion: number
	/** The client<->replay compatibility gate. Both renderings; the engine's endianness is UNVERIFIED. */
	networkProtocolDigestHex: string
	networkProtocolDigestLE: string
	lastGameChunkId: number
	lastKeyFrameId: number
	stats: RoflPlayerStats[]
	/** Byte offset of the trailing JSON blob. */
	metaOffset: number
	metaLength: number
	fileBytes: number
	/** File mtime — a weak proxy for when the game was played (the file carries no timestamp). */
	mtimeMs: number
	/** Bytes actually read off disk. The fast path reads ~0.8% of a 15 MB file. */
	bytesRead: number
}

export interface RoflFileWithSegments extends RoflFile {
	segments: RoflSegment[]
	/** `metaOffset - endOfLastSegment`. 256 (RSA-2048) in the verified sample; computed, not assumed. */
	signatureBytes: number
}

export class RoflError extends Error {
	override name = "RoflError"
	readonly path: string
	constructor(path: string, message: string) {
		super(`${basename(path)}: ${message}`)
		this.path = path
	}
}

/* ============================================================ filename */

const FILENAME_RE = /^([A-Za-z0-9]+)-(\d+)\.rofl$/i

/**
 * `NA1-5631300987.rofl` -> `{ platformId: "NA1", gameId: 5631300987 }`.
 * Returns nulls rather than throwing — a renamed replay is still readable, it just has no id.
 */
export const parseRoflFilename = (
	filePath: string
): { platformId: string | null; gameId: number | null } => {
	const m = FILENAME_RE.exec(basename(filePath))
	if (!m?.[1] || !m[2]) return { platformId: null, gameId: null }
	const gameId = Number(m[2])
	return {
		platformId: m[1].toUpperCase(),
		gameId: Number.isSafeInteger(gameId) ? gameId : null
	}
}

/** The canonical name the client would give this game. */
export const roflFileName = (platformId: string, gameId: number): string =>
	`${platformId}-${gameId}.rofl`

/* ============================================================ stat coercion */

const int = (raw: Record<string, string>, key: string, fallback = 0): number => {
	const v = raw[key]
	if (v === undefined || v === "") return fallback
	const n = Number(v)
	return Number.isFinite(n) ? n : fallback
}

const nullableInt = (raw: Record<string, string>, key: string): number | null => {
	const v = raw[key]
	if (v === undefined || v === "") return null
	const n = Number(v)
	return Number.isFinite(n) ? n : null
}

const text = (raw: Record<string, string>, key: string): string => raw[key] ?? ""

const POSITION_TO_ROLE: Record<string, Role> = {
	TOP: "TOP",
	JUNGLE: "JGL",
	MIDDLE: "MID",
	BOTTOM: "ADC",
	UTILITY: "SUP"
}

/** Read any of the 371 fields by name, without pretending to know the key set. */
export const stat = (p: RoflPlayerStats, key: string): string | undefined => p.raw[key]

const toPlayer = (raw: Record<string, string>, index: number): RoflPlayerStats => {
	const gameName = text(raw, "RIOT_ID_GAME_NAME")
	const tagLine = text(raw, "RIOT_ID_TAG_LINE")
	const position = text(raw, "TEAM_POSITION") as RoflPosition
	const teamRaw = int(raw, "TEAM", 100)
	return {
		index,
		puuid: text(raw, "PUUID"),
		summonerId: nullableInt(raw, "SUMMONER_ID"),
		gameName,
		tagLine,
		riotId: gameName ? (tagLine ? `${gameName}#${tagLine}` : gameName) : "",
		championName: text(raw, "SKIN"),
		teamId: teamRaw === 200 ? 200 : 100,
		// `WIN` is the STRING "Win"/"Fail", not a boolean.
		win: text(raw, "WIN") === "Win",
		position,
		role: POSITION_TO_ROLE[position] ?? "UNKNOWN",
		kills: int(raw, "CHAMPIONS_KILLED"),
		deaths: int(raw, "NUM_DEATHS"),
		assists: int(raw, "ASSISTS"),
		cs: int(raw, "MINIONS_KILLED"),
		jungleCs: int(raw, "NEUTRAL_MINIONS_KILLED"),
		enemyJungleCs: int(raw, "NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE"),
		gold: int(raw, "GOLD_EARNED"),
		goldSpent: int(raw, "GOLD_SPENT"),
		champLevel: int(raw, "LEVEL"),
		xp: int(raw, "EXP"),
		timePlayedSec: int(raw, "TIME_PLAYED"),
		visionScore: int(raw, "VISION_SCORE"),
		wardsPlaced: int(raw, "WARD_PLACED"),
		wardsKilled: int(raw, "WARD_KILLED"),
		controlWardsBought: int(raw, "VISION_WARDS_BOUGHT_IN_GAME"),
		damageToChampions: int(raw, "TOTAL_DAMAGE_DEALT_TO_CHAMPIONS"),
		damageTaken: int(raw, "TOTAL_DAMAGE_TAKEN"),
		damageToObjectives: int(raw, "TOTAL_DAMAGE_DEALT_TO_OBJECTIVES"),
		damageToTurrets: int(raw, "TOTAL_DAMAGE_DEALT_TO_TURRETS"),
		healOnTeammates: int(raw, "TOTAL_HEAL_ON_TEAMMATES"),
		timeSpentDeadSec: int(raw, "TOTAL_TIME_SPENT_DEAD"),
		turretTakedowns: int(raw, "TURRET_TAKEDOWNS"),
		dragonKills: int(raw, "DRAGON_KILLS"),
		baronKills: int(raw, "BARON_KILLS"),
		riftHeraldKills: int(raw, "RIFT_HERALD_KILLS"),
		hordeKills: int(raw, "HORDE_KILLS"),
		objectivesStolen: int(raw, "OBJECTIVES_STOLEN"),
		largestMultiKill: int(raw, "LARGEST_MULTI_KILL"),
		largestKillingSpree: int(raw, "LARGEST_KILLING_SPREE"),
		spell1Id: nullableInt(raw, "SUMMONER_SPELL_1"),
		spell2Id: nullableInt(raw, "SUMMONER_SPELL_2"),
		items: [0, 1, 2, 3, 4, 5, 6].map(i => int(raw, `ITEM${i}`)),
		keystoneId: nullableInt(raw, "KEYSTONE_ID"),
		perkPrimaryStyle: nullableInt(raw, "PERK_PRIMARY_STYLE"),
		perkSubStyle: nullableInt(raw, "PERK_SUB_STYLE"),
		perks: [0, 1, 2, 3, 4, 5].map(i => int(raw, `PERK${i}`)),
		raw
	}
}

/* ============================================================ core parse */

interface RawMeta {
	gameLength: number
	lastGameChunkId: number
	lastKeyFrameId: number
	statsJson?: string
}

const parseHeader = (
	path: string,
	head: Buffer
): { formatVersion: number; gameVersion: string; digest: Buffer; segStart: number } => {
	if (head.length < 16) throw new RoflError(path, "file is too small to be a replay")
	if (head.subarray(0, 4).toString("latin1") !== MAGIC)
		throw new RoflError(path, "not a RIOT replay (bad magic)")
	const formatVersion = head.readUInt16LE(4)
	// ROFL1 used magic "RIOT\0\0"; the \x02\x00 at 0x04 is the discriminator.
	if (formatVersion !== 2)
		throw new RoflError(path, `unsupported ROFL format version ${formatVersion} (expected 2)`)
	const digest = Buffer.from(head.subarray(6, 14))
	const gameVersionLen = head[14] ?? 0
	if (gameVersionLen === 0 || 15 + gameVersionLen > head.length)
		throw new RoflError(path, `implausible gameVersion length ${gameVersionLen}`)
	return {
		formatVersion,
		gameVersion: head.subarray(15, 15 + gameVersionLen).toString("latin1"),
		digest,
		// NOT a fixed offset: the header is 15 + gameVersionLen bytes.
		segStart: 15 + gameVersionLen
	}
}

const parseMeta = (path: string, json: Buffer): { meta: RawMeta; stats: RoflPlayerStats[] } => {
	let meta: RawMeta
	try {
		meta = JSON.parse(json.toString("utf8")) as RawMeta
	} catch (e) {
		throw new RoflError(path, `trailing metadata is not valid JSON: ${(e as Error).message}`)
	}
	if (typeof meta.gameLength !== "number")
		throw new RoflError(path, "trailing metadata has no numeric gameLength")

	// `statsJson` is a JSON *string* that must be parsed a second time. Missing/garbled stats
	// are survivable — patch + length are still worth having — so degrade rather than throw.
	let stats: RoflPlayerStats[] = []
	if (typeof meta.statsJson === "string" && meta.statsJson.length > 0) {
		try {
			const rows: unknown = JSON.parse(meta.statsJson)
			if (Array.isArray(rows))
				stats = rows.map((row, i) => toPlayer((row ?? {}) as Record<string, string>, i))
		} catch {
			stats = []
		}
	}
	return { meta, stats }
}

/**
 * Read a `.rofl`'s header + trailing metadata WITHOUT loading the file.
 *
 * This is the 99% path and the one the ingest fallback should call: it reads ~123 KB off a
 * 15 MB file (0.8%) and needs no zstd. Cheap enough to run over a whole replay folder.
 */
export const decodeRofl = (path: string): RoflFile => {
	if (!existsSync(path)) throw new RoflError(path, "file does not exist")
	const st = statSync(path)
	const size = st.size
	if (size < 32) throw new RoflError(path, `file is only ${size} bytes`)

	const fd = openSync(path, "r")
	let bytesRead = 0
	try {
		const head = Buffer.alloc(Math.min(HEADER_PROBE_BYTES, size))
		bytesRead += readSync(fd, head, 0, head.length, 0)
		const { formatVersion, gameVersion, digest, segStart } = parseHeader(path, head)

		const tail = Buffer.alloc(4)
		bytesRead += readSync(fd, tail, 0, 4, size - 4)
		const metaLength = tail.readUInt32LE(0)
		if (metaLength <= 0 || metaLength > MAX_META_BYTES || metaLength > size - 4 - segStart)
			throw new RoflError(path, `implausible metadata length ${metaLength} (file ${size} B)`)

		const metaOffset = size - 4 - metaLength
		const json = Buffer.alloc(metaLength)
		bytesRead += readSync(fd, json, 0, metaLength, metaOffset)
		const { meta, stats } = parseMeta(path, json)

		const { platformId, gameId } = parseRoflFilename(path)
		return {
			path,
			gameId,
			platformId,
			gameVersion,
			patch: patchOf(gameVersion),
			gameLengthMs: meta.gameLength,
			formatVersion,
			networkProtocolDigestHex: digest.toString("hex"),
			networkProtocolDigestLE: digest.readBigUInt64LE(0).toString(16).padStart(16, "0"),
			lastGameChunkId: meta.lastGameChunkId ?? 0,
			lastKeyFrameId: meta.lastKeyFrameId ?? 0,
			stats,
			metaOffset,
			metaLength,
			fileBytes: size,
			mtimeMs: st.mtimeMs,
			bytesRead
		}
	} finally {
		closeSync(fd)
	}
}

/** Never throws. Use when scanning a folder that may contain partial downloads. */
export const tryDecodeRofl = (path: string): RoflFile | null => {
	try {
		return decodeRofl(path)
	} catch {
		return null
	}
}

/* ============================================================ segment table */

/**
 * Walk one zstd frame per RFC 8878 and return the byte offset just past it.
 *
 * We do not strictly need this — the descriptor carries `compressedLength` — but walking the
 * frame independently is what proved the descriptor honest across all 94 compressed segments,
 * and it is the only way to re-sync if a descriptor is ever wrong.
 */
export const zstdFrameEnd = (buf: Buffer, off: number): number => {
	if (off + 4 > buf.length || buf.readUInt32LE(off) !== ZSTD_MAGIC)
		throw new Error(`no zstd frame at ${off}`)
	let p = off + 4
	const fhd = buf[p++] ?? 0
	const fcsFlag = (fhd >> 6) & 3
	const singleSegment = (fhd >> 5) & 1
	const hasChecksum = (fhd >> 2) & 1
	const dictIdFlag = fhd & 3
	if (!singleSegment) p += 1 // Window_Descriptor
	p += [0, 1, 2, 4][dictIdFlag] ?? 0 // Dictionary_ID
	let fcsSize = [0, 2, 4, 8][fcsFlag] ?? 0
	if (fcsFlag === 0 && singleSegment) fcsSize = 1
	p += fcsSize // Frame_Content_Size
	for (;;) {
		// eslint-disable-next-line no-bitwise
		const h = (buf[p] ?? 0) | ((buf[p + 1] ?? 0) << 8) | ((buf[p + 2] ?? 0) << 16)
		const last = h & 1
		const type = (h >> 1) & 3
		const size = h >>> 3
		p += 3
		p += type === 1 ? 1 : size // an RLE block is a single byte
		if (last) break
		if (p > buf.length) throw new Error(`zstd frame at ${off} runs past EOF`)
	}
	if (hasChecksum) p += 4
	return p
}

const SEG_TYPE: Record<number, RoflSegment["kind"]> = {
	1: "chunk",
	2: "keyframe",
	3: "manifest",
	4: "chunk"
}

export interface DecodeSegmentsOptions {
	/** Decompress payloads. Off = walk the table only (fast, no zstd). Default true. */
	decompress?: boolean
	/** Cross-check every descriptor's compressedLength against an RFC 8878 frame walk. Default true. */
	verifyFrames?: boolean
}

/**
 * Full parse: header + segment table + trailing metadata.
 *
 * This loads the whole file (15 MB for a 31-minute game) and, with `decompress`, inflates
 * ~39 MB of payload. You almost certainly want `decodeRofl` instead — the payloads are
 * opaque engine netcode with no strings, no floats at any stable alignment, and nothing
 * you can use (`.research/rofl-format.md` §4). This exists to validate files and to keep
 * the door open, not because the payloads are useful.
 */
export const decodeRoflSegments = (
	path: string,
	options: DecodeSegmentsOptions = {}
): RoflFileWithSegments => {
	const { decompress = true, verifyFrames = true } = options
	const base = decodeRofl(path)
	// readFileSync only after decodeRofl has proven the file is a well-formed ROFL2.
	const buf = readWhole(path)

	const gameVersionLen = buf[14] ?? 0
	const segStart = 15 + gameVersionLen
	const segments: RoflSegment[] = []
	let p = segStart
	let sawLastChunk = false
	let sawLastKeyframe = false

	while (p + 17 <= base.metaOffset && !(sawLastChunk && sawLastKeyframe)) {
		const id = buf.readUInt32LE(p)
		const nextId = buf.readUInt32LE(p + 4)
		const type = buf[p + 8] ?? 0
		const decLen = buf.readUInt32LE(p + 9)
		const compLen = buf.readUInt32LE(p + 13)
		const dataOffset = p + 17

		let payloadEnd: number
		let data: Buffer
		if (compLen === 0) {
			// Stored raw. Observed exactly once (type 4, the 17-byte startup chunk).
			payloadEnd = dataOffset + decLen
			if (payloadEnd > base.metaOffset)
				throw new RoflError(path, `raw segment at ${p} runs past the metadata blob`)
			data = buf.subarray(dataOffset, payloadEnd)
		} else {
			payloadEnd = dataOffset + compLen
			if (verifyFrames) {
				const walked = zstdFrameEnd(buf, dataOffset)
				if (walked !== payloadEnd)
					throw new RoflError(
						path,
						`compressedLength mismatch at descriptor ${p}: header says ${compLen}, frame is ${walked - dataOffset}`
					)
			}
			if (decompress) {
				data = zstdDecompressSync(buf.subarray(dataOffset, payloadEnd)) as Buffer
				if (data.length !== decLen)
					throw new RoflError(
						path,
						`decompressedLength mismatch at descriptor ${p}: header says ${decLen}, got ${data.length}`
					)
			} else data = Buffer.alloc(0)
		}

		// Payload byte 0 is a record tag; bytes 1..4 are a float32 LE game time in seconds.
		const gameTimeSec = data.length >= 5 ? data.readFloatLE(1) : null
		segments.push({
			kind: SEG_TYPE[type] ?? `unknown(${type})`,
			type,
			id,
			nextId,
			decLen,
			compLen,
			descOffset: p,
			dataOffset,
			gameTimeSec,
			data
		})

		if ((type === 1 || type === 4) && id === base.lastGameChunkId) sawLastChunk = true
		if (type === 2 && id === base.lastKeyFrameId) sawLastKeyframe = true
		p = payloadEnd
	}

	return {
		...base,
		bytesRead: buf.length,
		segments,
		// Computed, not hardcoded — §1.3 flags 256 as a single-sample observation.
		signatureBytes: base.metaOffset - p
	}
}

// Split out so `decodeRoflSegments` reads top-down; also the only whole-file read in this module.
const readWhole = (path: string): Buffer => {
	const st = statSync(path)
	const fd = openSync(path, "r")
	try {
		const buf = Buffer.alloc(st.size)
		readSync(fd, buf, 0, st.size, 0)
		return buf
	} finally {
		closeSync(fd)
	}
}

/* ============================================================ folder helpers */

export interface ReplayFileEntry {
	path: string
	fileName: string
	platformId: string | null
	gameId: number | null
	bytes: number
	mtimeMs: number
}

/** List `.rofl` files newest-first. Does not open them. Returns [] if the folder is missing. */
export const listReplays = (dir: string = REPLAY_DIR_WSL): ReplayFileEntry[] => {
	if (!existsSync(dir)) return []
	const out: ReplayFileEntry[] = []
	for (const fileName of readdirSync(dir)) {
		if (!fileName.toLowerCase().endsWith(".rofl")) continue
		const path = join(dir, fileName)
		let st
		try {
			st = statSync(path)
		} catch {
			continue
		}
		if (!st.isFile()) continue
		const { platformId, gameId } = parseRoflFilename(fileName)
		out.push({ path, fileName, platformId, gameId, bytes: st.size, mtimeMs: st.mtimeMs })
	}
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** The user's own row, matched on PUUID (the only reliable key — `NAME` is "" on this patch). */
export const findPlayerByPuuid = (file: RoflFile, puuid: string): RoflPlayerStats | null =>
	file.stats.find(p => p.puuid === puuid) ?? null

/* ============================================================ CLI */

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length))

/** Human-readable scoreboard, used by the CLI and by `pnpm doctor`. */
export const formatScoreboard = (file: RoflFile): string => {
	if (file.stats.length === 0) return "  (no statsJson in this file)"
	return file.stats
		.map(p => {
			const farm = `cs=${p.cs + p.jungleCs}`
			return (
				`  ${pad(p.riotId, 24)} ${pad(p.championName, 14)} ` +
				`team=${p.teamId} ${pad(p.position || "?", 8)} ` +
				`${pad(`${p.kills}/${p.deaths}/${p.assists}`, 8)} ${pad(farm, 11)} ` +
				`gold=${pad(String(p.gold), 6)} vs=${pad(String(p.visionScore), 3)} ` +
				`${p.win ? "Win" : "Fail"}`
			)
		})
		.join("\n")
}

const cli = (): void => {
	const args = process.argv.slice(2)
	const path = args.find(a => !a.startsWith("--"))
	if (!path) {
		console.error("usage: node --experimental-strip-types src/rofl/decode.ts <file.rofl> [--full]")
		process.exit(2)
	}
	const full = args.includes("--full")
	const parsed: RoflFileWithSegments | null = full ? decodeRoflSegments(path) : null
	const file: RoflFile = parsed ?? decodeRofl(path)

	console.log(`${file.path}`)
	console.log(
		[
			`  gameId          ${file.gameId ?? "(unknown — filename does not match <platform>-<id>.rofl)"}`,
			`  platformId      ${file.platformId ?? "(unknown)"}`,
			`  gameVersion     ${file.gameVersion}   patch ${file.patch}`,
			`  formatVersion   ${file.formatVersion}`,
			`  protocolDigest  ${file.networkProtocolDigestHex} (u64 LE 0x${file.networkProtocolDigestLE})`,
			`  gameLength      ${file.gameLengthMs} ms  (${(file.gameLengthMs / 60000).toFixed(2)} min)`,
			`  lastChunk/KF    ${file.lastGameChunkId} / ${file.lastKeyFrameId}`,
			`  metadata        ${file.metaLength} B at offset ${file.metaOffset}`,
			`  file            ${file.fileBytes} B, read ${file.bytesRead} B (${((100 * file.bytesRead) / file.fileBytes).toFixed(1)}%)`,
			`  players         ${file.stats.length}${file.stats[0] ? `, ${Object.keys(file.stats[0].raw).length} stat fields each` : ""}`
		].join("\n")
	)

	if (parsed) {
		const segs = parsed.segments
		const n = (k: string): number => segs.filter(s => s.kind === k).length
		console.log(
			`  segments        ${segs.length} (${n("chunk")} chunks, ${n("keyframe")} keyframes, ${n("manifest")} manifest)`
		)
		console.log(`  signature       ${parsed.signatureBytes} B`)
		const last = segs[segs.length - 1]
		if (last?.gameTimeSec !== null && last?.gameTimeSec !== undefined)
			console.log(`  last segment t  ${last.gameTimeSec.toFixed(2)} s`)
	}

	console.log("\nScoreboard:")
	console.log(formatScoreboard(file))
}

// `node --experimental-strip-types src/rofl/decode.ts <file>` runs the CLI; importing does not.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) cli()
