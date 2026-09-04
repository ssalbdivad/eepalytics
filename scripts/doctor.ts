/**
 * `pnpm doctor` — the preflight you run when something is wrong.
 *
 * Design rules for this file:
 *   1. It must run when the app does not. Every League call goes through
 *      `scripts/lib/win-lcu.ts` rather than `src/lcu/`, and `node:sqlite` is imported
 *      dynamically, so a broken transport or a Node without SQLite cannot stop the doctor
 *      from telling you exactly that.
 *   2. Every failing check prints a FIX. A diagnostic that only says "✗" is a diagnostic
 *      that makes you go read the source.
 *   3. READ-ONLY with respect to League: GETs, a `tasklist.exe` liveness query, and file
 *      stats. It never launches a replay, never starts a game, never POSTs to the client.
 *      Safe to run while you are in a match.
 *   4. `--json` for machines. Exit 0 = healthy or degraded-but-usable, 1 = something
 *      critical is broken.
 */

import { spawnSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statfsSync,
	statSync,
	writeFileSync
} from "node:fs"
import { connect } from "node:net"
import { join } from "node:path"
import {
	ANALYSIS_VERSION,
	DATA_DIR,
	DB_PATH,
	LEAGUE_DIR,
	LOCKFILE_PATH,
	REPLAY_DIR_WSL,
	REVIEW_VERSION,
	SCHEMA_VERSION,
	SERVER_HOST,
	SERVER_PORT,
	WIN_CURL
} from "../src/shared/constants.ts"
import { decodeRofl, listReplays } from "../src/rofl/decode.ts"
import { fmtAgo } from "../src/shared/time.ts"
import {
	findWindowsCurl,
	findWindowsNode,
	lockfilePidAlive,
	openBridge,
	openCurl,
	readLockfile,
	type LcuTransport,
	type Lockfile
} from "./lib/win-lcu.ts"

/* ============================================================ reporting */

type Level = "ok" | "warn" | "fail" | "info" | "skip"

interface Check {
	section: string
	label: string
	level: Level
	detail?: string
	/** Extra indented lines under the check. */
	notes?: string[]
	/** What to do about it. Mandatory in spirit for `fail`, encouraged for `warn`. */
	fix?: string
	/** A `fail` here means the app cannot work. Drives the exit code. */
	critical?: boolean
}

const checks: Check[] = []
const add = (check: Check): void => {
	checks.push(check)
}

const useColor =
	!process.env.NO_COLOR && process.stdout.isTTY === true && process.env.TERM !== "dumb"
const paint = (code: string, s: string): string =>
	useColor ? `\u001b[${code}m${s}\u001b[0m` : s
const dim = (s: string): string => paint("2", s)
const bold = (s: string): string => paint("1", s)
const red = (s: string): string => paint("31", s)
const green = (s: string): string => paint("32", s)
const yellow = (s: string): string => paint("33", s)
const blue = (s: string): string => paint("36", s)

const GLYPH: Record<Level, string> = {
	ok: green("✓"),
	warn: yellow("!"),
	fail: red("✗"),
	info: blue("·"),
	skip: dim("–")
}

const LABEL_WIDTH = 26
const padEnd = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length))

const render = (): void => {
	for (const section of [...new Set(checks.map(x => x.section))]) {
		console.log(`\n  ${bold(section.toUpperCase())}`)
		for (const x of checks.filter(y => y.section === section)) {
			const detail = x.detail ?? ""
			console.log(
				`    ${GLYPH[x.level]} ${padEnd(x.label, LABEL_WIDTH)} ${x.level === "fail" ? red(detail) : detail}`
			)
			for (const note of x.notes ?? []) console.log(`        ${dim(note)}`)
			if (x.fix) console.log(`        ${yellow("fix:")} ${x.fix}`)
		}
	}
}

/* ============================================================ small helpers */

const run = (
	cmd: string,
	args: string[],
	timeout = 10_000
): { ok: boolean; stdout: string; stderr: string } => {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout })
	return {
		ok: !r.error && r.status === 0,
		stdout: (r.stdout ?? "").trim(),
		stderr: (r.stderr ?? "").trim()
	}
}

const fmtBytes = (n: number): string => {
	if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
	if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
	return `${n} B`
}

const stats = (xs: number[]): { min: number; p50: number; max: number } => {
	const s = [...xs].sort((a, b) => a - b)
	return { min: s[0] ?? 0, p50: s[Math.floor(s.length / 2)] ?? 0, max: s[s.length - 1] ?? 0 }
}

const fmtMs = (x: { min: number; p50: number; max: number }): string =>
	`p50 ${x.p50.toFixed(1)} ms  (min ${x.min.toFixed(1)}, max ${x.max.toFixed(1)})`

const tcpOpen = (host: string, port: number, timeoutMs = 1200): Promise<boolean> =>
	new Promise(resolve => {
		const sock = connect({ host, port })
		const done = (v: boolean): void => {
			sock.destroy()
			resolve(v)
		}
		sock.setTimeout(timeoutMs)
		sock.once("connect", () => done(true))
		sock.once("timeout", () => done(false))
		sock.once("error", () => done(false))
	})

const identityOf = (body: string): string => {
	try {
		const j = JSON.parse(body) as { gameName?: string; tagLine?: string; puuid?: string }
		return `${j.gameName}#${j.tagLine} (${(j.puuid ?? "").slice(0, 8)}…)`
	} catch {
		return "(unparseable response)"
	}
}

/* ============================================================ 1. runtime */

const checkRuntime = async (): Promise<void> => {
	const section = "Runtime"
	const major = Number(process.versions.node.split(".")[0] ?? 0)
	add({
		section,
		label: "Node version",
		level: major >= 25 ? "ok" : "fail",
		detail: `v${process.versions.node}${major >= 25 ? "" : "  — need >= 25"}`,
		critical: true,
		fix:
			major >= 25 ?
				undefined
			:	"nvm install 25 && nvm alias default 25 — needed for node:sqlite and type stripping."
	})

	try {
		await import("node:sqlite")
		add({ section, label: "node:sqlite", level: "ok", detail: "built in", critical: true })
	} catch {
		add({
			section,
			label: "node:sqlite",
			level: "fail",
			detail: "not available",
			critical: true,
			fix: "This Node was built without SQLite. Install an official Node 25 build."
		})
	}

	// The ROFL decoder needs zstd; it is the only path to a finished game with the client closed.
	try {
		const zlib = await import("node:zlib")
		const hasZstd = typeof zlib.zstdDecompressSync === "function"
		add({
			section,
			label: "node:zlib zstd",
			level: hasZstd ? "ok" : "fail",
			detail: hasZstd ? "zstdDecompressSync present" : "missing",
			critical: true,
			fix: hasZstd ? undefined : "Required to parse .rofl segments. Needs Node >= 23."
		})
	} catch {
		add({ section, label: "node:zlib zstd", level: "fail", detail: "node:zlib missing", critical: true })
	}

	add({
		section,
		label: "Versions",
		level: "info",
		detail: `schema v${SCHEMA_VERSION} · analysis v${ANALYSIS_VERSION} · review v${REVIEW_VERSION}`
	})
}

/* ============================================================ 2. storage */

const checkStorage = async (): Promise<void> => {
	const section = "Storage"

	let writable = false
	let writeError = ""
	try {
		mkdirSync(DATA_DIR, { recursive: true })
		const probe = mkdtempSync(join(DATA_DIR, ".doctor-"))
		writeFileSync(join(probe, "probe"), "ok")
		rmSync(probe, { recursive: true, force: true })
		writable = true
	} catch (e) {
		writeError = (e as Error).message
	}
	add({
		section,
		label: "Data directory",
		level: writable ? "ok" : "fail",
		detail: writable ? DATA_DIR : `${DATA_DIR} — ${writeError}`,
		critical: true,
		notes:
			DATA_DIR.startsWith("/mnt/") ?
				["WARNING: this lives on the Windows drive. SQLite there measured 26x slower than ext4."]
			:	undefined,
		fix: writable ? undefined : `mkdir -p ${DATA_DIR}, or point CSK_DATA_DIR somewhere writable.`
	})

	try {
		const fs = statfsSync(existsSync(DATA_DIR) ? DATA_DIR : "/")
		const free = fs.bavail * fs.bsize
		const level: Level = free < 500 * 1024 ** 2 ? "fail" : free < 2 * 1024 ** 3 ? "warn" : "ok"
		add({
			section,
			label: "Free disk space",
			level,
			detail: `${fmtBytes(free)} free`,
			critical: true,
			notes: ["a .rofl is ~15 MB; clips and screenshots stack on top of that"],
			fix:
				level === "ok" ? undefined : (
					"Free space, or lower `retentionDays` in Settings and prune old replays."
				)
		})
	} catch (e) {
		add({ section, label: "Free disk space", level: "warn", detail: (e as Error).message })
	}

	if (!existsSync(DB_PATH)) {
		add({
			section,
			label: "Database",
			level: "info",
			detail: "not created yet",
			fix: "Run `pnpm seed` (or start the daemon) to create and populate it."
		})
		return
	}

	try {
		const { DatabaseSync } = await import("node:sqlite")
		// readOnly so the doctor can never be the thing that corrupts your database.
		const db = new DatabaseSync(DB_PATH, { readOnly: true })
		const one = (sql: string): Record<string, unknown> | undefined =>
			db.prepare(sql).get() as Record<string, unknown> | undefined

		const verdict = String(one("PRAGMA integrity_check")?.integrity_check ?? "unknown")
		const version = Number(one("SELECT max(version) AS v FROM schema_version")?.v ?? 0)
		const games = Number(one("SELECT count(*) AS n FROM game")?.n ?? 0)
		const reviews = Number(one("SELECT count(*) AS n FROM review")?.n ?? 0)
		const pending = Number(
			one("SELECT count(*) AS n FROM job WHERE state IN ('queued','leased','deferred')")?.n ?? 0
		)
		const lastGame = Number(one("SELECT max(gameCreationMs) AS t FROM game")?.t ?? 0)
		db.close()

		add({
			section,
			label: "Database integrity",
			level: verdict === "ok" ? "ok" : "fail",
			detail: `${verdict} · ${fmtBytes(statSync(DB_PATH).size)}`,
			critical: true,
			fix:
				verdict === "ok" ? undefined : (
					`Corrupt. Move ${DB_PATH} aside and re-seed; blobs/ can be re-ingested.`
				)
		})
		add({
			section,
			label: "Schema version",
			level:
				version === SCHEMA_VERSION ? "ok"
				: version > SCHEMA_VERSION ? "fail"
				: "warn",
			detail: `v${version} on disk, v${SCHEMA_VERSION} in this build`,
			critical: version > SCHEMA_VERSION,
			fix:
				version === SCHEMA_VERSION ? undefined
				: version > SCHEMA_VERSION ?
					"Written by a newer build. Update the repo rather than downgrading the file."
				:	"Pending migrations will apply on the next daemon start."
		})
		add({
			section,
			label: "Contents",
			level: games > 0 ? "ok" : "info",
			detail: `${games} games · ${reviews} reviews · ${pending} jobs pending`,
			notes: lastGame > 0 ? [`most recent game ingested ${fmtAgo(lastGame)}`] : [],
			fix: games === 0 ? "`pnpm seed` ingests your recent games straight from the client." : undefined
		})
	} catch (e) {
		add({
			section,
			label: "Database",
			level: "fail",
			detail: (e as Error).message,
			critical: true,
			fix: `Could not read ${DB_PATH}. Move it aside and let the daemon recreate it.`
		})
	}
}

/* ============================================================ 3. League install */

const checkLeague = (): Lockfile | null => {
	const section = "League install"

	const dirOk = existsSync(LEAGUE_DIR)
	add({
		section,
		label: "Install directory",
		level: dirOk ? "ok" : "fail",
		detail: LEAGUE_DIR,
		fix: dirOk ? undefined : "Set CSK_LEAGUE_DIR in .env to your League folder under /mnt/c."
	})

	const lock = readLockfile()
	if (!lock) {
		add({
			section,
			label: "Lockfile",
			level: "warn",
			detail: "absent — the League client is not running",
			notes: [
				"not an error if you simply have the client closed",
				"everything already in the database still works offline"
			],
			fix: "Start the League client for live ingest, replay downloads or capture."
		})
	} else {
		const alive = lockfilePidAlive(lock)
		if (alive === false)
			add({
				section,
				label: "Lockfile",
				level: "fail",
				detail: `STALE — PID ${lock.pid} is gone (written ${fmtAgo(lock.mtimeMs)})`,
				fix: `The client exited without cleaning up. Delete "${LOCKFILE_PATH}" or restart League.`
			})
		else
			add({
				section,
				label: "Lockfile",
				level: "ok",
				detail: `port ${lock.port} · pid ${lock.pid}${alive === null ? " (liveness unknown)" : ""}`,
				notes: [
					`written ${fmtAgo(lock.mtimeMs)}`,
					"the password is read in-process and never printed or passed in argv"
				]
			})
	}

	if (!existsSync(REPLAY_DIR_WSL))
		add({
			section,
			label: "Replay folder",
			level: "warn",
			detail: `${REPLAY_DIR_WSL} does not exist`,
			fix: "League creates it on the first replay download. Check Settings > Replays in the client."
		})
	else {
		const replays = listReplays(REPLAY_DIR_WSL)
		const newest = replays[0]
		const notes: string[] = []
		if (newest) {
			notes.push(`newest ${newest.fileName} · ${fmtBytes(newest.bytes)} · ${fmtAgo(newest.mtimeMs)}`)
			try {
				const d = decodeRofl(newest.path)
				notes.push(
					`decodes ok: patch ${d.patch} · ${(d.gameLengthMs / 60000).toFixed(1)} min · ` +
						`${d.stats.length} players · read ${fmtBytes(d.bytesRead)} of ${fmtBytes(d.fileBytes)}`
				)
			} catch (e) {
				notes.push(`DECODE FAILED: ${(e as Error).message}`)
			}
		}
		add({
			section,
			label: "Replay folder",
			level: replays.length > 0 ? "ok" : "info",
			detail: `${replays.length} .rofl file${replays.length === 1 ? "" : "s"}`,
			notes,
			fix:
				replays.length === 0 ?
					"Replays expire ~30 min after a game ends; the daemon grabs them automatically while it runs."
				:	undefined
		})
	}

	return lock
}

/* ============================================================ 4. transport */

const REPS = 8
const PROBE_PATH = "/lol-summoner/v1/current-summoner"

const checkTransport = async (lock: Lockfile | null): Promise<void> => {
	const section = "Windows interop"

	const nodeExe = findWindowsNode()
	add({
		section,
		label: "Windows node.exe",
		level: nodeExe ? "ok" : "warn",
		detail: nodeExe ?? "not found",
		notes: nodeExe ? [run(nodeExe, ["--version"], 20_000).stdout || "version unknown"] : [],
		fix:
			nodeExe ? undefined : (
				"Install Node for Windows (nodejs.org). Without it we fall back to curl.exe, " +
				"which works but is ~38x slower per request."
			)
	})

	const curlExe = findWindowsCurl()
	add({
		section,
		label: "Windows curl.exe",
		level: curlExe ? "ok" : "warn",
		detail: curlExe ?? `${WIN_CURL} not found`,
		fix: curlExe ? undefined : "Ships with Windows 10 1803+. Check that /mnt/c is mounted."
	})

	// The single thing everyone gets wrong: WSL's 127.0.0.1 is not Windows' 127.0.0.1.
	if (lock) {
		const direct = await tcpOpen("127.0.0.1", lock.port, 800)
		add({
			section,
			label: "Direct TCP (expect dead)",
			level: "info",
			detail:
				direct ?
					`127.0.0.1:${lock.port} ANSWERED — you may be on networkingMode=mirrored`
				:	`127.0.0.1:${lock.port} unreachable, as expected under WSL2 NAT`,
			notes: ["WSL2 in NAT mode cannot reach the Windows loopback. That is why the bridge exists."]
		})
	}

	if (!lock) {
		for (const label of ["Bridge transport", "curl.exe transport", "Live game API (:2999)"])
			add({ section: "LCU", label, level: "skip", detail: "client not running" })
		return
	}

	let anyTransportWorked = false

	// --- bridge (the fast path) ---
	let bridge: LcuTransport | null = null
	try {
		bridge = await openBridge(lock)
		const first = await bridge.get(PROBE_PATH)
		const times: number[] = []
		for (let i = 0; i < REPS; i++) times.push((await bridge.get(PROBE_PATH)).ms)
		const ok = first.status === 200
		anyTransportWorked ||= ok
		add({
			section: "LCU",
			label: "Bridge transport",
			level: ok ? "ok" : "fail",
			detail: ok ? fmtMs(stats(times)) : `HTTP ${first.status}`,
			notes: [
				`GET ${PROBE_PATH} through Windows node.exe over stdio`,
				`first call ${first.ms.toFixed(1)} ms (TLS handshake), then keep-alive`,
				ok ? `identity: ${identityOf(first.body)}` : first.body.slice(0, 160)
			],
			fix: ok ? undefined : "The client answered but not with 200 — it may still be starting. Retry."
		})
	} catch (e) {
		add({
			section: "LCU",
			label: "Bridge transport",
			level: "warn",
			detail: (e as Error).message,
			fix: "curl.exe still works. Installing Windows Node gets you p50 ~2 ms instead of ~90 ms."
		})
	} finally {
		bridge?.close()
	}

	// --- curl fallback ---
	try {
		const curl = openCurl(lock)
		const times: number[] = []
		let status = 0
		let body = ""
		for (let i = 0; i < 3; i++) {
			const r = await curl.get(PROBE_PATH)
			times.push(r.ms)
			status = r.status
			body = r.body
		}
		const ok = status === 200
		anyTransportWorked ||= ok
		add({
			section: "LCU",
			label: "curl.exe transport",
			level: ok ? "ok" : "fail",
			detail: ok ? fmtMs(stats(times)) : `HTTP ${status || "000"}`,
			notes: [
				"one process per request; config on stdin so the password stays out of argv",
				ok ? `identity: ${identityOf(body)}` : body.slice(0, 160) || "(empty response)"
			],
			fix: ok ? undefined : "HTTP 000 means nothing answered at all. Is the client really running?"
		})
	} catch (e) {
		add({ section: "LCU", label: "curl.exe transport", level: "fail", detail: (e as Error).message })
	}

	if (!anyTransportWorked)
		add({
			section: "LCU",
			label: "Reachability",
			level: "fail",
			detail: "client is running but no transport reached it",
			critical: true,
			fix:
				"Check /mnt/c is mounted, the lockfile is fresh, and nothing blocks Windows loopback. " +
				"Then rerun `pnpm doctor`."
		})

	// --- the in-game API, port 2999. Only up mid-match; "down" is the normal state. ---
	try {
		const t = await openBridge(lock).catch(() => openCurl(lock))
		try {
			const r = await t.getLive("/liveclientdata/gamestats")
			add({
				section: "LCU",
				label: "Live game API (:2999)",
				level: "info",
				detail: r.status === 200 ? "up — you are in a game right now" : `HTTP ${r.status}`,
				notes: ["only up while a match is running; 'not up' is normal"]
			})
		} finally {
			t.close()
		}
	} catch (e) {
		const msg = (e as Error).message
		add({
			section: "LCU",
			label: "Live game API (:2999)",
			level: "info",
			detail: /ECONNREFUSED|refused/i.test(msg) ? "not in a game" : msg,
			notes: ["only up while a match is running; 'not up' is normal"]
		})
	}
}

/* ============================================================ 5. coaching */

const checkCoaching = (): void => {
	const section = "Coaching"

	const which = run("bash", ["-lc", "command -v claude"], 10_000)
	const cliPath = which.ok ? which.stdout : ""
	const version = cliPath ? run(cliPath, ["--version"], 25_000).stdout : ""
	const hasKey = Boolean(process.env.ANTHROPIC_API_KEY)

	add({
		section,
		label: "claude CLI",
		level: cliPath ? "ok" : "warn",
		detail: cliPath ? `${version || "installed"}  ${dim(cliPath)}` : "not on PATH",
		fix:
			cliPath ? undefined : (
				"Install Claude Code (claude.com/claude-code), or set ANTHROPIC_API_KEY in .env."
			)
	})

	if (cliPath) {
		// Presence of the credentials file is evidence of a completed login, NOT proof the
		// token is still valid — we deliberately do not spend a request to find out.
		const creds = join(process.env.HOME ?? "", ".claude", ".credentials.json")
		const hasCreds = existsSync(creds)
		add({
			section,
			label: "claude auth",
			level: hasCreds ? "ok" : "warn",
			detail: hasCreds ? "credentials file present" : "no credentials file",
			notes: ["presence is not validity — doctor will not spend a request to check the token"],
			fix: hasCreds ? undefined : "Run `claude` once and log in."
		})
	}

	add({
		section,
		label: "ANTHROPIC_API_KEY",
		level: hasKey ? "ok" : "info",
		detail: hasKey ? "set — reviews will be billed per token" : "not set — using your Claude login",
		notes: hasKey ? [] : ["this is the intended default; the key is only a fallback"]
	})

	if (!cliPath && !hasKey)
		add({
			section,
			label: "Review capability",
			level: "fail",
			detail: "no claude CLI and no API key — coaching cannot run at all",
			critical: true,
			fix: "Install Claude Code and log in, or put ANTHROPIC_API_KEY in .env."
		})

	// The persona is extracted from AGENTS.md between these markers at runtime. Losing them
	// silently degrades every review, so it is worth one grep.
	const agentsMd = join(process.cwd(), "AGENTS.md")
	const markers =
		existsSync(agentsMd) && run("grep", ["-c", "COACH:BEGIN", agentsMd], 5000).stdout !== "0"
	add({
		section,
		label: "Coach persona",
		level: markers ? "ok" : "warn",
		detail: markers ? "AGENTS.md carries the COACH markers" : "AGENTS.md markers missing",
		notes: ["edit AGENTS.md to change the coach — no code change needed"],
		fix: markers ? undefined : "Restore the <!-- COACH:BEGIN --> / <!-- COACH:END --> markers."
	})
}

/* ============================================================ 6. daemon */

const checkDaemon = async (): Promise<void> => {
	const section = "Daemon"

	const listening = await tcpOpen(SERVER_HOST, SERVER_PORT, 1000)
	add({
		section,
		label: "HTTP server",
		level: listening ? "ok" : "info",
		detail: `${SERVER_HOST}:${SERVER_PORT} ${listening ? "listening" : "not listening"}`,
		fix: listening ? undefined : "`pnpm dev`, or `systemctl --user start eepalytics`."
	})

	const unit = join(process.env.HOME ?? "", ".config/systemd/user/eepalytics.service")
	const installed = existsSync(unit)
	const active = run("systemctl", ["--user", "is-active", "eepalytics"], 8000).stdout
	const enabled = run("systemctl", ["--user", "is-enabled", "eepalytics"], 8000).stdout
	add({
		section,
		label: "systemd unit",
		level:
			!installed ? "info"
			: active === "active" ? "ok"
			: "warn",
		detail: installed ? `${active || "unknown"} · ${enabled || "not enabled"}` : "not installed",
		fix:
			!installed ? "`pnpm service:install` — optional; `pnpm dev` runs it in the foreground."
			: active !== "active" ? "systemctl --user start eepalytics && pnpm service:logs"
			: undefined
	})

	const user = process.env.USER ?? ""
	const lingering = user !== "" && existsSync(`/var/lib/systemd/linger/${user}`)
	add({
		section,
		label: "systemd lingering",
		level: lingering ? "ok" : "warn",
		detail: lingering ? "enabled" : "disabled",
		notes: [
			"lingering starts the unit without an interactive login, but it cannot make WSL boot",
			`for "runs while I play", add a Windows startup task: wsl.exe -d Ubuntu -u ${user || "$USER"} --exec /bin/true`
		],
		fix: lingering ? undefined : `sudo loginctl enable-linger ${user || "$USER"}`
	})
}

/* ============================================================ main */

const main = async (): Promise<void> => {
	const json = process.argv.includes("--json")

	if (!json) {
		console.log(`\n${bold("eepalytics doctor")}`)
		console.log(dim("  read-only preflight — safe to run while you are in a game"))
	}

	await checkRuntime()
	await checkStorage()
	const lock = checkLeague()
	await checkTransport(lock)
	checkCoaching()
	await checkDaemon()

	const failures = checks.filter(x => x.level === "fail")
	const critical = failures.filter(x => x.critical)
	const warnings = checks.filter(x => x.level === "warn")
	const oks = checks.filter(x => x.level === "ok")

	if (json) {
		console.log(
			JSON.stringify(
				{
					ok: critical.length === 0,
					failures: failures.length,
					warnings: warnings.length,
					checks
				},
				null,
				2
			)
		)
	} else {
		render()
		const parts = [green(`${oks.length} ok`)]
		if (warnings.length) parts.push(yellow(`${warnings.length} warning${warnings.length === 1 ? "" : "s"}`))
		if (failures.length) parts.push(red(`${failures.length} failure${failures.length === 1 ? "" : "s"}`))
		console.log(`\n  ${parts.join(dim(" · "))}`)

		if (critical.length > 0) {
			console.log(`\n  ${red("Not usable until these are fixed:")}`)
			for (const f of critical) console.log(`    ${red("✗")} ${f.section} — ${f.label}`)
		} else if (failures.length > 0 || warnings.length > 0)
			console.log(`\n  ${yellow("Usable, but degraded.")} Everything above with a fix hint is worth doing.`)
		else console.log(`\n  ${green("All good.")} Run \`pnpm dev\` and open http://127.0.0.1:7701`)
		console.log("")
	}

	process.exit(critical.length > 0 ? 1 : 0)
}

await main()
