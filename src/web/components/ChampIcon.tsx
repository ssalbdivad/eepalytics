/**
 * ChampIcon — a champion portrait by numeric id.
 *
 * The browser cannot reach the LCU (WSL2 cannot talk to Windows' loopback), so the local
 * client's own asset endpoints are not an option from here. Community Dragon serves square
 * icons keyed by the same numeric championId the match history uses, which is the only
 * id-keyed public source; DDragon needs the champion's *key string*, which we do not always
 * have. If the network is unavailable — offline, or the user simply is not online — the
 * component degrades to a legible placeholder rather than a broken-image glyph.
 */

import { useEffect, useState } from "react"
import "./components.css"

export interface ChampIconProps {
	championId: number
	size?: number
	/** Optional: shown in the placeholder and used as the alt text when we have it. */
	championName?: string
	title?: string
}

/**
 * Community Dragon's square portrait, by numeric id.
 *
 * The previous path (`.../rcp-be-lol-game-data/.../champion-icons/<id>.png`) now 404s — verified
 * against a live request, which is why every row was rendering a bare number. This endpoint is
 * the current one and is version-agnostic, so it does not go stale on a patch.
 */
export const champIconUrl = (championId: number): string =>
	`https://cdn.communitydragon.org/latest/champion/${championId}/square`

/**
 * Data Dragon's portrait, by champion KEY string ("Lillia").
 *
 * Needed because a game adopted from a `.rofl` has no numeric championId — the file names
 * champions by internal string only — so those rows have nothing to look up by id. Riot's own
 * CDN, so it is the more authoritative of the two when we have the name.
 */
export const champIconUrlByName = (championName: string, patch = "16.17.1"): string =>
	`https://ddragon.leagueoflegends.com/cdn/${patch}/img/champion/${championName.replace(/[^A-Za-z]/g, "")}.png`

export const ChampIcon = ({ championId, size = 28, championName, title }: ChampIconProps) => {
	const [failed, setFailed] = useState(false)
	const valid = Number.isFinite(championId) && championId > 0

	// a new champion means a new chance for the image to load
	useEffect(() => setFailed(false), [championId])

	const label = championName ?? (valid ? `Champion ${championId}` : "Unknown champion")
	/*
	 * Never the raw championId. "876" means nothing to anyone — it was on screen for every row
	 * when the icon URL broke, and it reads as a bug rather than as a missing picture. Two
	 * letters of the champion's name degrade gracefully instead.
	 */
	const initials = championName ? championName.slice(0, 2).toUpperCase() : "?"

	// A .rofl-sourced game has a name but no numeric id, so fall back to Riot's name-keyed CDN
	// before giving up on a picture entirely.
	const src =
		valid ? champIconUrl(championId)
		: championName ? champIconUrlByName(championName)
		: null

	return (
		<span
			className="csk-champ"
			style={{ width: size, height: size }}
			title={title ?? label}
			aria-label={label}
			role="img"
		>
			{src !== null && !failed ?
				<img
					src={src}
					alt=""
					width={size}
					height={size}
					loading="lazy"
					decoding="async"
					onError={() => setFailed(true)}
				/>
			:	<span
					className="csk-champ__fallback"
					style={{ fontSize: Math.max(8, Math.round(size * 0.34)) }}
				>
					{initials}
				</span>
			}
		</span>
	)
}

export default ChampIcon
