/**
 * The shell: a status bar that never lies about what the daemon is doing, a hash router,
 * and an error boundary so one bad render cannot take the whole tool down mid-game.
 */

import { Component, useCallback, useMemo, useState } from "react"
import type { ErrorInfo, ReactNode } from "react"
import { api } from "./lib/api.ts"
import { href, useNow, useResource, useRoute, useScrollReset } from "./lib/hooks.ts"
import { reconnectSse, sseLastEventId, useSse } from "./lib/sse.ts"
import type { SseStatus } from "./lib/sse.ts"
import { cls } from "./lib/format.ts"
import { ClientOffline } from "./components/ClientOffline.tsx"
import { GameList } from "./pages/GameList.tsx"
import { GameReview } from "./pages/GameReview.tsx"
import { Live } from "./pages/Live.tsx"
import { Replays } from "./pages/Replays.tsx"
import { Debrief } from "./pages/Debrief.tsx"
import { Trends } from "./pages/Trends.tsx"
import { Queue } from "./pages/Queue.tsx"
import { SettingsPage } from "./pages/Settings.tsx"

/* ======================================================= error boundary */

interface BoundaryProps {
	children: ReactNode
	resetKey: string
}
interface BoundaryState {
	error: Error | null
}

class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
	state: BoundaryState = { error: null }

	static getDerivedStateFromError(error: Error): BoundaryState {
		return { error }
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("eepalytics: render failed", error, info.componentStack)
	}

	componentDidUpdate(prev: BoundaryProps): void {
		if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
	}

	render(): ReactNode {
		const { error } = this.state
		if (!error) return this.props.children
		return (
			<div className="page">
				<div className="notice bad">
					<span className="icon">✗</span>
					<div>
						<strong>This screen crashed.</strong> That is a bug in eepalytics, not in your
						data — nothing was lost.
						<pre>{error.stack ?? error.message}</pre>
						<div style={{ marginTop: 10, display: "flex", gap: 8 }}>
							<button onClick={() => this.setState({ error: null })}>Try again</button>
							<a className="btn" href={href.games}>
								Back to games
							</a>
						</div>
					</div>
				</div>
			</div>
		)
	}
}

/* =============================================================== status */

const SSE_LABEL: Record<SseStatus, string> = {
	open: "live",
	connecting: "connecting…",
	reconnecting: "reconnecting…",
	closed: "offline"
}

const daemonTone = (daemon: string): string =>
	daemon === "ok" ? "ok"
	: daemon === "starting" ? "warn"
	: daemon === "degraded" ? "warn"
	: "bad"

/* ================================================================== app */

export const App = () => {
	const route = useRoute()
	const [eventTick, setEventTick] = useState(0)

	const onSseMessage = useCallback(() => setEventTick(t => t + 1), [])
	const sseStatus = useSse(onSseMessage)

	// A slow heartbeat so the header stays honest even if the event stream is wedged.
	const heartbeat = Math.floor(useNow(20_000) / 20_000)
	const health = useResource(signal => api.health(signal), [heartbeat, eventTick])

	const routeKey = useMemo(
		() => (route.name === "game" ? `game:${route.gameId}` : route.name),
		[route]
	)
	useScrollReset(routeKey)

	const h = health.data
	const offline = health.error !== null && h === null

	/*
	 * `#/live` is the SAME coach as `#/`, served without the app around it: no nav, no status
	 * bar, no health poll. That is the whole difference, and it is worth a route because a
	 * narrow window parked beside the game should not be mostly chrome, and should not poll
	 * /api/health every 20s behind a running match.
	 *
	 * It used to also be a separate always-on-top Electron window. That window is gone: it
	 * rendered this identical component, and on the machine it was written for — Electron under
	 * WSLg, which sees only Linux windows and never the League client — it could not run the
	 * screen share the coach exists for. A second UI that structurally cannot do the main thing
	 * is not a feature. A Windows install could now run it; that removes the second reason, not
	 * the first, and duplicating this component into another window is still not worth it.
	 */
	if (route.name === "live") {
		document.body.classList.add("is-live")
		return <Live />
	}
	document.body.classList.remove("is-live")

	return (
		<div className="app">
			<header className="topbar">
				<div className="brand">
					<img className="brand__mark" src="/icons/icon-128.png" alt="" width={26} height={26} />
					eepalytics <small>Gooskaffur#NA1</small>
				</div>

				<nav className="nav">
					<a className={cls(route.name === "home" && "active")} href={href.home}>
						Coach
					</a>
					<a className={cls(route.name === "games" && "active")} href={href.games}>
						History
					</a>
					<a className={cls(route.name === "trends" && "active")} href={href.trends}>
						Trends
					</a>
					<a className={cls(route.name === "queue" && "active")} href={href.queue}>
						Queue
						{h && h.queueDepth > 0 ?
							<span className="count">{h.queueDepth}</span>
						:	null}
					</a>
					<a className={cls(route.name === "settings" && "active")} href={href.settings}>
						Settings
					</a>
					{/*
					 * The coach is the page you are already on, so this is not a link to it — it
					 * opens the same coach chrome-free, for parking in a narrow window beside the
					 * game. Labelled for what it does rather than where it goes.
					 */}
					<a
						className="nav-live"
						href={href.live}
						target="_blank"
						rel="noreferrer"
						title="Open the coach on its own, without the app around it — sized for a narrow window beside the game."
					>
						↗ Pop out
					</a>
				</nav>

				<div className="topbar-right">
					{offline ?
						<span className="status-pill bad" title={health.errorDetail ?? undefined}>
							<span className="dot" /> daemon unreachable
						</span>
					:	<>
							<span
								className={cls("status-pill", h ? daemonTone(h.daemon) : "warn")}
								title={
									h?.warnings && h.warnings.length > 0 ?
										h.warnings.join("\n")
									:	`daemon ${h?.daemon ?? "?"}`
								}
							>
								<span className="dot" /> daemon {h?.daemon ?? "…"}
								{h?.warnings && h.warnings.length > 0 ? ` · ${h.warnings.length}⚠` : ""}
							</span>
							<span
								className={cls("status-pill", h?.lcu === "connected" ? "ok" : "warn")}
								title={
									h?.lcu === "connected" ? `League client connected via ${h.bridge}`
									: h?.vanguard?.problems.length ?
										h.vanguard.problems.join("\n")
									:	"League client is closed — see the note on the Games screen"
								}
							>
								<span className="dot" /> LCU {h?.lcu ?? "…"}
								{h?.gameflowPhase ? ` · ${h.gameflowPhase}` : ""}
							</span>
						</>
					}
					<button
						className={cls("status-pill", sseStatus === "open" ? "ok live" : "warn")}
						title={`Event stream from the daemon — last event #${sseLastEventId()}. Click to reconnect now.`}
						onClick={reconnectSse}
					>
						<span className="dot" /> {SSE_LABEL[sseStatus]}
					</button>
				</div>
			</header>

			<ErrorBoundary resetKey={routeKey}>
				{/*
				 * Shown once, above whatever page is open. A closed client is the single most
				 * common "why is nothing happening", and the answer is usually Vanguard rather
				 * than anything this app did.
				 */}
				{h && h.lcu !== "connected" && route.name !== "settings" && (
					<div className="page" style={{ paddingBottom: 0 }}>
						<ClientOffline health={h} />
					</div>
				)}
				{/*
				 * The coach is MOUNTED ON EVERY ROUTE and merely hidden off its own screen.
				 *
				 * `<Live>` owns `<ScreenCoach>`, which owns the `MediaStream` and the Gemini socket.
				 * Rendering it only on `home` meant a click on History or Trends unmounted the whole
				 * chain: the screen-share tracks were stopped, the socket closed, and coming back
				 * needed a fresh trip through the OS screen picker. Looking up last game's numbers
				 * between queues is a completely reasonable thing to do mid-session, and it should
				 * not cost him the share.
				 *
				 * `display: none` rather than a conditional, which is the technique this app already
				 * uses one level down for the compact coach — same reason, same trade. It keeps the
				 * 3s `/api/live` poll running while hidden, which is not waste: it is what lets the
				 * journal keep recording and the coach keep talking while he reads a review.
				 *
				 * `contents` rather than `block` when visible: `.app` is a flex column and `.live` is
				 * sized as one of its items (`min-height: 100vh`). A wrapper that generated a box
				 * would become the flex item instead and quietly resize the coach. `contents` keeps
				 * the layout identical to rendering `<Live>` here directly — this wrapper exists to
				 * hold a `display` toggle, not to participate in layout.
				 *
				 * ErrorBoundary's three children — banner, this, the route — are a FIXED-ARITY list,
				 * so React reconciles them by position and this element never moves. That is
				 * load-bearing: a shifting index is exactly how the coach used to get unmounted on
				 * the idle -> in-game flip.
				 */}
				<div style={{ display: route.name === "home" ? "contents" : "none" }}>
					<Live />
				</div>
				{route.name === "home" ?
					null
				: route.name === "debrief" ?
					<Debrief gameId={route.gameId} />
				: route.name === "games" ?
					<GameList health={h} eventTick={eventTick} />
				: route.name === "game" ?
					<GameReview gameId={route.gameId} eventTick={eventTick} health={h} />
				: route.name === "replays" ?
					<Replays eventTick={eventTick} />
				: route.name === "trends" ?
					<Trends eventTick={eventTick} />
				: route.name === "queue" ?
					<Queue health={h} eventTick={eventTick} />
				: route.name === "settings" ?
					<SettingsPage health={h} onSaved={() => setEventTick(t => t + 1)} />
				:	<div className="page">
						<div className="empty">
							<h2>No such screen</h2>
							<p>
								<code className="mono">#/{route.path}</code> isn't a route in this build.
							</p>
							<div className="actions">
								<a className="btn btn-primary" href={href.games}>
									Go to games
								</a>
							</div>
						</div>
					</div>
				}
			</ErrorBoundary>
		</div>
	)
}
