/**
 * Why the League client is not reachable, and what to do about it.
 *
 * "LCU disconnected" is accurate and unhelpful. On Windows the common cause is Riot Vanguard —
 * the kernel anti-cheat that must be running before League will start, and whose failures are
 * silent: the client either refuses to launch or closes itself seconds later behind a
 * `VAN-####` dialog nobody gets to read.
 *
 * The daemon asks Windows for the real service state rather than guessing, and this renders it.
 * The distinction that matters, and that the copy is careful about: both services reporting
 * RUNNING does NOT mean Vanguard is fine. A pending post-update reboot looks exactly like a
 * healthy machine from outside, and it is the single most common cause. Saying "Vanguard is
 * fine" would send the reader hunting somewhere else entirely.
 */

import type { HealthResponse } from "../../shared/schema/api.ts"
import "./components.css"

const STATE_LABEL: Record<string, string> = {
	running: "running",
	stopped: "STOPPED",
	"not-installed": "not installed",
	unknown: "unknown"
}

export interface ClientOfflineProps {
	health: HealthResponse | null
	/** Compact form for the top of a page; the full form is its own panel. */
	compact?: boolean
}

export const ClientOffline = ({ health, compact = false }: ClientOfflineProps) => {
	if (!health || health.lcu === "connected") return null
	const v = health.vanguard

	return (
		<div className={`csk-offline ${compact ? "csk-offline--compact" : ""}`}>
			<div className="csk-offline__head">
				<span className="icon">⚠</span>
				<div>
					<strong>The League client isn't running.</strong> Finished games can't be harvested
					and the live coach has no feed until it is. Everything already stored still works —
					reviews, trends, chat and the Replays screen all read from disk.
				</div>
			</div>

			{v?.probed && (
				<div className="csk-offline__vg">
					<div className="csk-offline__services">
						<span>Vanguard driver (vgk)</span>
						<code className={v.vgk === "running" ? "ok" : "bad"}>{STATE_LABEL[v.vgk]}</code>
						<span>Vanguard service (vgc)</span>
						<code className={v.vgc === "running" ? "ok" : "bad"}>{STATE_LABEL[v.vgc]}</code>
					</div>

					{v.problems.length > 0 && (
						<ul className="csk-offline__problems">
							{v.problems.map(p => (
								<li key={p}>{p}</li>
							))}
						</ul>
					)}

					<ol className="csk-offline__advice">
						{v.advice.map(a => (
							<li key={a}>{a}</li>
						))}
					</ol>
				</div>
			)}
		</div>
	)
}
