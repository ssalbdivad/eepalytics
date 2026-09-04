/**
 * What the drakes are actually called.
 *
 * The Live Client Data API reports `DragonType` in ELEMENT words — "Fire", "Water", "Earth",
 * "Air" — and no player has ever called them that. They are Infernal, Ocean, Mountain and Cloud.
 * Passing the raw value through produced "they took the fire dragon" in a real game, which is how
 * the player found out the coach was reading strings rather than talking about League: a model
 * with any knowledge of the game knows the name, and it was never being allowed to use it.
 *
 * Kept as data rather than a prompt instruction because a name is not a judgement. The model
 * should not have to correct our vocabulary before it can coach.
 */
const DRAGON_NAMES: Record<string, string> = {
	fire: "Infernal",
	water: "Ocean",
	earth: "Mountain",
	air: "Cloud",
	hextech: "Hextech",
	chemtech: "Chemtech",
	elder: "Elder"
}

/**
 * The player-facing name for an API dragon type.
 *
 * Returns null for anything unrecognised rather than guessing — a new elemental drake would
 * otherwise be announced by whatever internal word Riot happened to ship, and "they took the
 * quantum dragon" is worse than "they took a dragon".
 */
export const dragonName = (apiType: string | undefined | null): string | null => {
	if (!apiType) return null
	return DRAGON_NAMES[apiType.trim().toLowerCase()] ?? null
}

/** How it should be said out loud: "Infernal drake", or plain "the dragon" when unknown. */
export const dragonPhrase = (apiType: string | undefined | null): string => {
	const name = dragonName(apiType)
	return name === null ? "the dragon"
		: name === "Elder" ? "Elder dragon"
		: `${name} drake`
}
