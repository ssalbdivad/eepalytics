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

export const champIconUrl = (championId: number): string =>
	`https://raw.communitydragon.org/latest/plugin/rift/rcp-be-lol-game-data/global/default/v1/champion-icons/${championId}.png`

export const ChampIcon = ({ championId, size = 28, championName, title }: ChampIconProps) => {
	const [failed, setFailed] = useState(false)
	const valid = Number.isFinite(championId) && championId > 0

	// a new champion means a new chance for the image to load
	useEffect(() => setFailed(false), [championId])

	const label = championName ?? (valid ? `Champion ${championId}` : "Unknown champion")
	const initials = championName
		? championName.slice(0, 2).toUpperCase()
		: valid
			? String(championId)
			: "?"

	return (
		<span
			className="csk-champ"
			style={{ width: size, height: size }}
			title={title ?? label}
			aria-label={label}
			role="img"
		>
			{valid && !failed ?
				<img
					src={champIconUrl(championId)}
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
