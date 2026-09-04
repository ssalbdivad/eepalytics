/**
 * Settings.
 *
 * Two of these knobs have real consequences and are labelled as such: `captureEnabled`
 * hands your League client to a background process, and `coachIntensity` changes the
 * persona but is explicitly documented as never changing what the numbers say.
 *
 * The save is a PATCH of only the fields you actually touched, clamped client-side with the
 * same `clampSettings` the daemon uses, so the two can never disagree about what "valid"
 * means.
 */

import { useEffect, useMemo, useState } from "react"
import type { HealthResponse } from "../../shared/schema/api.ts"
import type { Settings, SettingsPatch } from "../../shared/schema/settings.ts"
import { MODEL_CHOICES, clampSettings } from "../../shared/schema/settings.ts"
import { api } from "../lib/api.ts"
import { useAction, useNow, useResource } from "../lib/hooks.ts"
import { cls, fmtAgo } from "../lib/format.ts"

export interface SettingsPageProps {
	health: HealthResponse | null
	onSaved: () => void
}

export const SettingsPage = ({ health, onSaved }: SettingsPageProps) => {
	const loaded = useResource(signal => api.settings(signal), [])
	const [draft, setDraft] = useState<Settings | null>(null)
	const now = useNow(30_000)

	useEffect(() => {
		if (loaded.data) setDraft(loaded.data)
	}, [loaded.data])

	const changed = useMemo<SettingsPatch>(() => {
		if (!draft || !loaded.data) return {}
		const clamped = clampSettings(draft)
		const patch: Record<string, unknown> = {}
		for (const key of Object.keys(clamped) as (keyof Settings)[])
			if (clamped[key] !== loaded.data[key]) patch[key] = clamped[key]
		return patch as SettingsPatch
	}, [draft, loaded.data])

	const dirty = Object.keys(changed).length > 0

	const save = useAction(async () => {
		const next = await api.saveSettings(changed)
		setDraft(next)
		loaded.reload()
		onSaved()
	})

	if (!draft)
		return (
			<div className="page">
				<div className="page-head">
					<h1>Settings</h1>
				</div>
				{loaded.error ?
					<div className="notice bad">
						<span className="icon">✗</span>
						<div>
							<strong>Couldn't load settings.</strong> {loaded.error}
							<div style={{ marginTop: 8 }}>
								<button onClick={loaded.reload}>Retry</button>
							</div>
						</div>
					</div>
				:	<div className="skeleton" style={{ height: 320 }} />}
			</div>
		)

	const set = <K extends keyof Settings>(key: K, value: Settings[K]): void =>
		setDraft(d => (d === null ? d : { ...d, [key]: value }))

	const knownModel = MODEL_CHOICES.some(m => m.id === draft.model)

	return (
		<div className="page">
			<div className="page-head">
				<h1>Settings</h1>
				<div className="sub">stored in the daemon's database, not in this browser</div>
			</div>

			<div className="settings-grid">
				{/* -------------------------------------------------------- coach */}
				<div className="panel panel-pad">
					<div className="section-title">
						The coach <span className="rule" />
					</div>

					<div className="field">
						<div className="label">Model</div>
						<div className="control">
							<select
								value={knownModel ? draft.model : "__custom"}
								onChange={e =>
									set("model", e.target.value === "__custom" ? draft.model : e.target.value)
								}
							>
								{MODEL_CHOICES.map(m => (
									<option key={m.id} value={m.id}>
										{m.label}
									</option>
								))}
								<option value="__custom">Custom…</option>
							</select>
						</div>
						{!knownModel ?
							<div className="control" style={{ gridColumn: "1 / -1", justifySelf: "stretch" }}>
								<input
									type="text"
									value={draft.model}
									onChange={e => set("model", e.target.value)}
									style={{ width: "100%" }}
								/>
							</div>
						:	null}
						<div className="help">
							Runs through the Claude Agent SDK on your existing <code className="mono">claude</code>{" "}
							CLI login — there's no API key on this machine, so nothing is billed separately.
						</div>
					</div>

					<div className="field wide">
						<div className="label">Coach intensity</div>
						<div className="control">
							<div className="slider-row">
								<span className="ends">clinical</span>
								<input
									type="range"
									min={0}
									max={1}
									step={0.05}
									value={draft.coachIntensity}
									onChange={e => set("coachIntensity", Number(e.target.value))}
								/>
								<span className="ends">meme goblin</span>
								<span className="mono" style={{ width: 34, textAlign: "right" }}>
									{draft.coachIntensity.toFixed(2)}
								</span>
							</div>
						</div>
						<div className="help">
							Scales the persona only. At 0 you get dry notes; at 1 you get the full
							Faker-invoking treatment. It never changes a number, a timestamp or a verdict.
						</div>
					</div>

					<div className="field">
						<div className="label">Auto-review new games</div>
						<div className="control">
							<input
								type="checkbox"
								checked={draft.autoReviewNewGames}
								onChange={e => set("autoReviewNewGames", e.target.checked)}
							/>
						</div>
						<div className="help">
							Queue a review as soon as a finished game is ingested and analyzed.
						</div>
					</div>

					<div className="field">
						<div className="label">Games in the trend window</div>
						<div className="control">
							<input
								type="number"
								min={3}
								max={200}
								value={draft.gamesForTrends}
								onChange={e => set("gamesForTrends", Number(e.target.value))}
							/>
						</div>
						<div className="help">
							How many recent games the cross-game review reads. Fewer than about 10 and most
							series will honestly report themselves as noise.
						</div>
					</div>

					<div className="field">
						<div className="label">Max moments per game</div>
						<div className="control">
							<input
								type="number"
								min={1}
								max={50}
								value={draft.maxMomentsPerGame}
								onChange={e => set("maxMomentsPerGame", Number(e.target.value))}
							/>
						</div>
						<div className="help">
							Hard cap on how many timestamped moments analysis will keep, however rough the
							game was.
						</div>
					</div>
				</div>

				{/* ------------------------------------------------------ capture */}
				<div className="panel panel-pad">
					<div className="section-title">
						Replay capture <span className="rule" />
					</div>

					<div className="notice warn" style={{ marginBottom: 8 }}>
						<span className="icon">⚠</span>
						<div>
							Capture <strong>takes over your League client</strong> to launch a replay and
							record it. It only ever runs while you're out of a game, and it's off by
							default. With it off, every moment still gets a rendered map image.
						</div>
					</div>

					<div className="field">
						<div className="label">Enable automatic capture</div>
						<div className="control">
							<input
								type="checkbox"
								checked={draft.captureEnabled}
								onChange={e => set("captureEnabled", e.target.checked)}
							/>
						</div>
						<div className="help">
							You can always trigger a supervised one-off from a game's page instead.
						</div>
					</div>

					<div className="field">
						<div className="label">Max clips per game</div>
						<div className="control">
							<input
								type="number"
								min={0}
								max={30}
								value={draft.captureMaxPerGame}
								onChange={e => set("captureMaxPerGame", Number(e.target.value))}
							/>
						</div>
					</div>

					<div className="field">
						<div className="label">Clip length</div>
						<div className="control">
							<input
								type="number"
								min={5}
								max={120}
								value={draft.clipSeconds}
								onChange={e => set("clipSeconds", Number(e.target.value))}
							/>
						</div>
						<div className="help">
							Seconds, centred on the moment — {Math.round(draft.clipSeconds / 2)}s before and
							after.
						</div>
					</div>

					<div className="field">
						<div className="label">Quiet time before capturing</div>
						<div className="control">
							<input
								type="number"
								min={0}
								max={60}
								value={Math.round(draft.idleGraceMs / 60_000)}
								onChange={e => set("idleGraceMs", Number(e.target.value) * 60_000)}
							/>
						</div>
						<div className="help">
							Minutes the client must sit idle first, so capture can't grab it in the gap
							between two queue dodges.
						</div>
					</div>

					<div className="field">
						<div className="label">Keep replays for</div>
						<div className="control">
							<input
								type="number"
								min={0}
								max={365}
								value={draft.retentionDays}
								onChange={e => set("retentionDays", Number(e.target.value))}
							/>
						</div>
						<div className="help">
							Days. <code className="mono">.rofl</code> files are about 15 MB each and dominate
							disk use. Reviews, metrics and moments are kept forever regardless. Only replays
							this app downloaded are pruned — files the League client put in your own Replays
							folder are never touched.
						</div>
					</div>

					<div className="field">
						<div className="label">Replay folder</div>
						<div className="control">
							<input
								type="text"
								spellCheck={false}
								placeholder="/mnt/c/Users/<you>/Documents/League of Legends/Replays"
								value={draft.replayFolder}
								onChange={e => set("replayFolder", e.target.value)}
								style={{ width: "100%", fontFamily: "var(--mono)", fontSize: 12 }}
							/>
						</div>
						<div className="help">
							Where to look for <code className="mono">.rofl</code> files on the{" "}
							<a href="#/replays">Replays</a> screen. Leave blank for the client's default.
							Point it at an archive to coach games that have already fallen out of match
							history — those reviews get end-of-game stats but no timeline, so no moments or
							map positions.
						</div>
					</div>
				</div>

				{/* ------------------------------------------------------- daemon */}
				<div className="panel panel-pad">
					<div className="section-title">
						League client link <span className="rule" />
					</div>

					<div className="field">
						<div className="label">Transport</div>
						<div className="control">
							<div className="seg">
								{(["bridge", "curl"] as const).map(t => (
									<button
										key={t}
										className={cls(draft.transport === t && "active")}
										onClick={() => set("transport", t)}
									>
										{t}
									</button>
								))}
							</div>
						</div>
						<div className="help">
							WSL2 can't reach the Windows client over TCP, so everything goes through Windows
							interop. <strong>bridge</strong> is a long-lived <code className="mono">node.exe</code>{" "}
							over stdio (~2 ms); <strong>curl</strong> shells out per request (~88 ms). The
							daemon falls back to curl on its own if the bridge won't start.
						</div>
					</div>

					<div className="field">
						<div className="label">Idle poll</div>
						<div className="control">
							<input
								type="number"
								min={1000}
								max={60000}
								step={500}
								value={draft.pollIdleMs}
								onChange={e => set("pollIdleMs", Number(e.target.value))}
							/>
						</div>
						<div className="help">Milliseconds between phase checks while you're not in a game.</div>
					</div>

					<div className="field">
						<div className="label">In-game poll</div>
						<div className="control">
							<input
								type="number"
								min={500}
								max={30000}
								step={250}
								value={draft.pollInGameMs}
								onChange={e => set("pollInGameMs", Number(e.target.value))}
							/>
						</div>
						<div className="help">
							Milliseconds between Live Client Data samples during a game. This is the only
							source that can't be recovered afterwards.
						</div>
					</div>
				</div>

				{/* ------------------------------------------------------- status */}
				<div className="panel panel-pad">
					<div className="section-title">
						Daemon <span className="rule" />
					</div>
					{health ?
						<dl className="kv">
							<dt>status</dt>
							<dd className={cls(health.daemon === "ok" ? "band-good" : "band-bad")}>
								{health.daemon}
							</dd>
							<dt>version</dt>
							<dd>{health.version}</dd>
							<dt>league client</dt>
							<dd className={cls(health.lcu === "connected" ? "band-good" : "band-bad")}>
								{health.lcu}
								{health.gameflowPhase ? ` · ${health.gameflowPhase}` : ""}
							</dd>
							<dt>transport in use</dt>
							<dd>{health.bridge}</dd>
							<dt>queue depth</dt>
							<dd>{health.queueDepth}</dd>
							{typeof health.gameCount === "number" ?
								<>
									<dt>games stored</dt>
									<dd>{health.gameCount}</dd>
								</>
							:	null}
							{health.dbPath ?
								<>
									<dt>database</dt>
									<dd>{health.dbPath}</dd>
								</>
							:	null}
							{typeof health.analysisVersion === "number" ?
								<>
									<dt>versions</dt>
									<dd>
										analysis v{health.analysisVersion} · review v{health.reviewVersion ?? "?"}
									</dd>
								</>
							:	null}
							{health.lastSyncMs !== undefined && health.lastSyncMs !== null ?
								<>
									<dt>last sync</dt>
									<dd>{fmtAgo(health.lastSyncMs, now)}</dd>
								</>
							:	null}
						</dl>
					:	<div className="notice bad">
							<span className="icon">✗</span>
							<div>The daemon isn't answering, so its status is unknown.</div>
						</div>
					}

					{health?.warnings && health.warnings.length > 0 ?
						<div className="notice warn" style={{ marginTop: 12 }}>
							<span className="icon">⚠</span>
							<div>
								<strong>Warnings</strong>
								<ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
									{health.warnings.map((w, i) => (
										<li key={i}>{w}</li>
									))}
								</ul>
							</div>
						</div>
					:	null}

					<div className="faint" style={{ fontSize: 11.5, marginTop: 12 }}>
						Logs: <code className="mono">journalctl --user -u fawnsei -f</code> · doctor:{" "}
						<code className="mono">pnpm doctor</code>
					</div>
				</div>
			</div>

			<div className="save-bar">
				<span className={cls(dirty ? "band-ok" : "faint")} style={{ fontSize: 12.5 }}>
					{dirty ?
						`${Object.keys(changed).length} unsaved change${Object.keys(changed).length === 1 ? "" : "s"}`
					: save.done ?
						"Saved."
					:	"No changes."}
				</span>
				{save.error ? <span className="band-bad" style={{ fontSize: 12.5 }}>{save.error}</span> : null}
				<span className="spacer" />
				<button onClick={() => loaded.data && setDraft(loaded.data)} disabled={!dirty}>
					Discard
				</button>
				<button className="btn-primary" onClick={save.run} disabled={!dirty || save.pending}>
					{save.pending ? "Saving…" : "Save"}
				</button>
			</div>

		</div>
	)
}
