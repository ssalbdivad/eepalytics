/**
 * League vocabulary, defined for someone who does not have it yet.
 *
 * The coach talks like a coach — cs, gank, prio, tempo, scuttle. That is correct: dumbing the
 * language down would make the advice useless the moment the reader hears it anywhere else, and
 * it would patronise the reader who already knows it. The answer is not simpler words, it is
 * words you can ask about.
 *
 * ## Rules these definitions follow
 *
 * - **One sentence, no jargon inside the jargon.** A definition that needs another definition
 *   has failed. If a term genuinely depends on another, it names it in plain words instead.
 * - **Say why it matters**, not just what it is. "Camps respawn on a timer" is a fact; "if you
 *   are not clearing them they are rotting, which is the most common way a jungler falls behind"
 *   is a reason to care.
 * - **No strategy advice.** The coach gives that, grounded in the player's own game. A glossary
 *   that starts giving opinions competes with it and will contradict it.
 *
 * Keys are lowercase. Matching is case-insensitive and word-boundary-anchored, so "prio" does
 * not match inside "priority" and "cs" does not match inside "css".
 */

export interface GlossaryEntry {
	/** Extra spellings that mean the same thing. */
	aliases?: string[]
	/** One sentence. See the rules above. */
	definition: string
}

export const GLOSSARY: Record<string, GlossaryEntry> = {
	cs: {
		aliases: ["creep score", "farm"],
		definition:
			"Creep score — how many minions and jungle monsters you have killed. It is the steadiest source of gold in the game, so it is the clearest measure of whether you are keeping up."
	},
	camps: {
		aliases: ["camp", "jungle camps"],
		definition:
			"The groups of monsters in the jungle. They come back on a timer, so a camp you are not killing is gold quietly going to waste."
	},
	gank: {
		aliases: ["ganks", "ganking", "ganked"],
		definition:
			"Leaving the jungle to surprise an enemy in a lane, usually to get a kill. It costs you the time you would have spent farming, so it is only worth it if it actually achieves something."
	},
	prio: {
		aliases: ["priority", "lane prio"],
		definition:
			"Priority — having your lane pushed so you can leave it and help elsewhere before the enemy can. Whoever has prio gets to show up to a fight first."
	},
	tempo: {
		definition:
			"How much useful stuff you are getting done per minute. You lose tempo by standing still, walking somewhere for nothing, or dying — all of which cost time you cannot get back."
	},
	scuttle: {
		aliases: ["scuttle crab", "crab"],
		definition:
			"The crab in the river. Killing it gives vision and a speed boost, and it is often the first real fight of the game because both junglers want it."
	},
	drake: {
		aliases: ["dragon", "dragons", "drakes"],
		definition:
			"The dragon in the bottom half of the river. Each one your team kills gives a permanent buff, so they stack up over a game."
	},
	baron: {
		aliases: ["baron nashor"],
		definition:
			"The big monster in the top half of the river, available from 20 minutes. Killing it makes your minions much stronger for a few minutes and is usually how teams end games."
	},
	herald: {
		aliases: ["rift herald"],
		definition:
			"An early-game monster in the top half of the river. You release it to charge a tower, which is the fastest way to turn a lead into structures."
	},
	grubs: {
		aliases: ["voidgrubs", "horde"],
		definition:
			"Small early monsters in the top river. Taking them helps your team break towers faster."
	},
	objective: {
		aliases: ["objectives", "elite objectives"],
		definition:
			"The neutral monsters and towers both teams want — dragons, baron, herald, grubs, turrets. Games are usually decided by these rather than by kills."
	},
	"full clear": {
		aliases: ["full-clear", "clear"],
		definition:
			"Killing every camp in your own jungle in one route before doing anything else. It is the safest way to keep your gold and level up with the enemy jungler."
	},
	pathing: {
		aliases: ["path", "route"],
		definition:
			"The order you move around the jungle in. Good pathing means each camp leads naturally to the next thing you want to be near."
	},
	"vision score": {
		aliases: ["vision"],
		definition:
			"A number summarising how much your wards helped your team see, and how much enemy vision you removed. Higher usually means you were harder to ambush."
	},
	ward: {
		aliases: ["wards", "warding"],
		definition:
			"An item you place that watches a patch of the map for a while. Most surprise deaths happen where nobody had one."
	},
	kda: {
		definition:
			"Kills, deaths and assists. Useful as a rough shape of a game, but it hides whether those kills mattered."
	},
	int: {
		aliases: ["inting", "ints", "feeding", "feed"],
		definition:
			"Dying repeatedly in ways that hand the enemy free gold. Usually not deliberate — it is what happens when you keep taking fights you cannot win."
	},
	"over-extension": {
		aliases: ["overextension", "overextended", "over-extended"],
		definition:
			"Being further into dangerous territory than your team can support. It is the position most deaths happen from."
	},
	"counter-jungle": {
		aliases: ["counterjungle", "counter-jungling", "invade", "invading"],
		definition:
			"Taking camps in the enemy jungler's half of the map. It is strong when you know where they are and risky when you do not."
	},
	smite: {
		definition:
			"The jungler's summoner spell, used to kill monsters instantly. Whoever lands it on a dragon or baron takes it, however close the other team was."
	},
	recall: {
		aliases: ["back", "backing"],
		definition:
			"Teleporting back to base to spend gold and heal. Gold in your pocket does nothing, so timing this well matters more than it sounds."
	},
	spike: {
		aliases: ["power spike", "spikes"],
		definition:
			"A point where your champion suddenly gets much stronger — usually a level or a finished item. Fighting just before yours is how even games get lost."
	},
	kite: {
		aliases: ["kiting", "kited"],
		definition:
			"Moving between attacks so you keep hitting something while it struggles to hit you back. It is how a jungler clears camps without ending up at low health."
	},
	teamfight: {
		aliases: ["teamfights", "fight", "skirmish", "skirmishes"],
		definition:
			"A fight with several players on each side. Who wins usually comes down to who arrived in a better position, not who is mechanically better."
	},
	tilt: {
		aliases: ["tilted"],
		definition:
			"Playing worse because you are frustrated. It is the single most common reason a bad game turns into a bad night."
	}
}

/** Every term and alias, longest first so "full clear" wins over "clear". */
export const GLOSSARY_TERMS: { term: string; key: string }[] = Object.entries(GLOSSARY)
	.flatMap(([key, entry]) => [key, ...(entry.aliases ?? [])].map(term => ({ term, key })))
	.sort((a, b) => b.term.length - a.term.length)

export const defineTerm = (key: string): string => GLOSSARY[key]?.definition ?? ""
