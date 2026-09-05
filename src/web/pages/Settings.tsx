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
import { LIVE_COACH_MODES } from "../../shared/live-coach-mode.ts"
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
	/** Typed but not yet saved. Never populated from the server — keys are write-only. */
	const [providerKeyDraft, setProviderKeyDraft] = useState("")
	const providers = useResource(
		signal =>
			fetch("/api/live/coach/providers", { signal }).then(
				r =>
					r.json() as Promise<{
						providers: { id: string; label: string; available: boolean; note: string; defaultModel: string }[]
					}>
			),
		[]
	)
	/*
	 * Checking the key is a live call to Google, so it is a button rather than something that
	 * fires on every keystroke. Someone pasting a bad key should find out here, not mid-game.
	 */
	const [gemini, setGemini] = useState<{
		ok: boolean
		error?: string | null
		hint?: string
		configured?: boolean
	} | null>(null)
	/*
	 * Held apart from `draft` because the key does not live in settings — it is written straight
	 * to a 0600 file by its own write-only endpoint, so it never comes back in `GET /api/settings`
	 * and never sits in this page's state after a reload.
	 */
	const [geminiKeyInput, setGeminiKeyInput] = useState("")

	const readGemini = async () => {
		try {
			const r = await fetch("/api/live/gemini/status")
			setGemini((await r.json()) as { ok: boolean; error?: string | null; hint?: string })
		} catch (e) {
			setGemini({ ok: false, error: e instanceof Error ? e.message : String(e) })
		}
	}
	useEffect(() => {
		void readGemini()
	}, [])

	const saveGeminiKey = async (key: string) => {
		setGemini(null)
		try {
			const r = await fetch("/api/live/gemini/key", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ key })
			})
			const j = (await r.json()) as { configured?: boolean; works?: boolean; error?: string | null }
			setGeminiKeyInput("")
			setGemini({ ok: Boolean(j.works), error: j.error, configured: j.configured })
			if (j.configured) await readGemini()
		} catch (e) {
			setGemini({ ok: false, error: e instanceof Error ? e.message : String(e) })
		}
	}
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

					{/*
					 * The LIVE coach's model, which is a different thing from the reviewer's above.
					 * The trade between the two shapes is stated here rather than left for him to
					 * discover in a game: only Gemini Live speaks natively and can be interrupted.
					 */}
					<div className="field wide">
						<div className="label">Live coach model</div>
						<div className="control" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
							<select
								value={draft.liveProvider}
								onChange={e => set("liveProvider", e.currentTarget.value)}
							>
								<option value="gemini-live">Gemini Live — speaks itself, ~1s, interruptible</option>
								{/*
								 * NOT disabled when a key is missing, which it was.
								 *
								 * The key box only appears once a provider is selected, so disabling the
								 * keyless ones made them unreachable: you could not select the thing you
								 * needed to select in order to give it a key. An option that says "needs a
								 * key" and then shows you where to put one is the whole flow.
								 */}
								{providers.data?.providers.map(p => (
									<option key={p.id} value={p.id}>
										{p.label}
										{p.available ? "" : " — needs a key"}
									</option>
								))}
							</select>
							{draft.liveProvider !== "gemini-live" && (
								<input
									type="text"
									placeholder={
										providers.data?.providers.find(p => p.id === draft.liveProvider)
											?.defaultModel ?? "model id"
									}
									value={draft.liveModel}
									onChange={e => set("liveModel", e.currentTarget.value)}
									style={{ minWidth: 220 }}
								/>
							)}
						</div>
						<div className="help">
							{draft.liveProvider === "gemini-live" ?
								"A held-open socket: it speaks in its own voice, answers in about a second, and can be cut off mid-sentence."
							:	<>
									An HTTPS turn spoken by your system voice — slower (a few seconds), it cannot be
									usefully interrupted because the sentence is already paid for, and it does not
									sound like her.{" "}
									{providers.data?.providers.find(p => p.id === draft.liveProvider)?.note}
								</>
							}
						</div>
						<div className="help">
							Model id is free text on purpose — ids change faster than this app does, and a
							stale dropdown is a bug that looks like a limitation. Leave it blank for the
							provider's default. Pick a model that accepts images, and a fast one: a
							reasoning model took fifteen seconds to answer, which is useless in a fight.
						</div>
					</div>

					{draft.liveProvider !== "gemini-live" && (
						<div className="field wide">
							<div className="label">
								Key for {providers.data?.providers.find(p => p.id === draft.liveProvider)?.label}
							</div>
							<div className="control" style={{ display: "flex", gap: 8 }}>
								<input
									type="password"
									autoComplete="off"
									placeholder="paste a key — it is written to a 0600 file and never read back"
									value={providerKeyDraft}
									onChange={e => setProviderKeyDraft(e.currentTarget.value)}
									style={{ flex: 1 }}
								/>
								<button
									className="btn"
									onClick={() => {
										void fetch(`/api/live/coach/key/${draft.liveProvider}`, {
											method: "PUT",
											headers: { "content-type": "application/json" },
											body: JSON.stringify({ key: providerKeyDraft })
										}).then(() => {
											setProviderKeyDraft("")
											providers.reload()
										})
									}}
								>
									Save
								</button>
							</div>
							<div className="help">
								Stored on this machine only, like the Gemini key — the daemon holds it and the
								browser never sees it. An empty save clears it.
							</div>
						</div>
					)}

					<div className="field wide">
						<div className="label">Gemini key — live voice coach</div>
						<div className="control">
							<input
								type="password"
								autoComplete="off"
								spellCheck={false}
								placeholder={
									gemini?.hint ? `saved (${gemini.hint}) — paste a new one to replace` : (
										"paste an AI Studio API key"
									)
								}
								value={geminiKeyInput}
								onChange={e => setGeminiKeyInput(e.target.value)}
								style={{ width: "100%" }}
							/>
							<div style={{ display: "flex", gap: 6, marginTop: 6 }}>
								<button
									className="btn"
									type="button"
									disabled={geminiKeyInput.trim() === ""}
									onClick={() => void saveGeminiKey(geminiKeyInput)}
								>
									Save &amp; test
								</button>
								{gemini?.hint && (
									<button className="btn" type="button" onClick={() => void saveGeminiKey("")}>
										Clear
									</button>
								)}
							</div>
							{gemini !== null && (
								<div className={gemini.ok ? "ok" : "warn"} style={{ marginTop: 6 }}>
									{gemini.ok ?
										`Working${gemini.hint ? ` (${gemini.hint})` : ""}.`
									:	`Not working: ${gemini.error ?? "no key set"}`}
								</div>
							)}
						</div>
						<div className="help">
							Powers <b>Live voice</b> on the live page — a held-open connection that watches your
							screen continuously and answers out loud in about 0.8s, against ~3s for glances.
							Get one free at{" "}
							<code className="mono">aistudio.google.com/apikey</code>. The key stays on this
							machine: the daemon swaps it for a short-lived token and only that reaches the
							browser.
							<br />
							There is no "sign in with Google" here because there cannot be — the Live API takes
							an API key, and a consumer Gemini subscription grants no API access.
						</div>
					</div>

					{/*
					 * WHICH ARCHITECTURE she runs on, with the measurement printed beside each choice.
					 *
					 * This is the one setting on this page that changes what she is ALLOWED to say, so it
					 * is the one place a bare label would be worst. He has turned this coach off mid-game
					 * more than once and has learned to discount an unevidenced claim about it; "we changed
					 * the architecture, trust us" is exactly that sentence. So each option carries its own
					 * numbers from the same blind run, including the fence's — the argument for the option
					 * he is not on has to be visible too, or this is marketing rather than a choice.
					 */}
					<div className="field wide">
						<div className="label">How she decides what to say</div>
						<div className="control" style={{ display: "grid", gap: 8 }}>
							{LIVE_COACH_MODES.map(m => {
								const on = draft.liveCoachMode === m.id
								return (
									<label
										key={m.id}
										style={{
											display: "grid",
											gridTemplateColumns: "auto 1fr",
											gap: "0 10px",
											alignItems: "start",
											padding: "10px 12px",
											borderRadius: 8,
											cursor: "pointer",
											border: `1px solid ${on ? "var(--gold-dim)" : "var(--line-soft)"}`,
											background: on ? "var(--panel-2)" : "transparent"
										}}
									>
										<input
											type="radio"
											name="liveCoachMode"
											checked={on}
											onChange={() => set("liveCoachMode", m.id)}
											style={{ marginTop: 3 }}
										/>
										<div>
											<div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
												{m.label}
											</div>
											<div
												style={{
													fontSize: 11.5,
													color: "var(--dim)",
													marginTop: 3,
													maxWidth: "62ch"
												}}
											>
												{m.blurb}
											</div>
											<div
												style={{
													fontSize: 11.5,
													color: "var(--faint)",
													marginTop: 4,
													maxWidth: "62ch"
												}}
											>
												<b style={{ color: "var(--gold-dim)" }}>Measured:</b> {m.evidence}
											</div>
										</div>
									</label>
								)
							})}
						</div>
						<div className="help">
							Both were run on the same model against the same 363 recorded samples from four of
							your own games, replayed in order, and every line was judged with the labels
							stripped so the judge could not tell which arm it was reading. Neither one lets her
							say a number that is not in the block — that rule is what keeps her honest, and it
							is in both. What changes is how much she is allowed to notice for herself.
						</div>
						<div className="help">
							Takes effect at the start of the next game: one socket is opened per game and the
							instructions go in when it opens, so changing this mid-game does nothing until the
							next one.
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
							How often the daemon checks the League client while a game is running.
							Lower means the live overlay and voice coach see changes sooner; higher is
							gentler on the client.
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
						Logs: <code className="mono">journalctl --user -u eepalytics -f</code> · doctor:{" "}
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
