import { renderState } from "./src/shared/live-state.ts"

console.log(
	renderState({
		clock: "14:22",
		me: {
			champion: "Lillia",
			role: "JGL",
			level: 11,
			k: 3,
			d: 2,
			a: 7,
			cs: 128,
			hp: 812,
			maxHp: 1420,
			gold: 1334,
			items: [
				{ name: "Liandry's Torment" },
				{ name: "Sorcerer's Shoes" },
				{ name: "Blasting Wand", isNew: true },
				{ name: "Health Potion", count: 2 },
				{ name: "Stealth Ward" }
			]
		},
		allies: [
			{ champion: "Aatrox", role: "TOP", level: 11, k: 2, d: 3, a: 1 },
			{ champion: "Ahri", role: "MID", level: 12, k: 5, d: 2, a: 4 },
			{ champion: "Jinx", role: "ADC", level: 10, k: 1, d: 4, a: 3 },
			{ champion: "Thresh", role: "SUP", level: 9, k: 0, d: 5, a: 8 }
		],
		enemies: [
			{ champion: "Sett", role: "TOP", level: 12, k: 4, d: 1, a: 2 },
			{
				champion: "Viego",
				role: "JGL",
				level: 12,
				k: 6,
				d: 2,
				a: 3,
				cs: 142,
				counterpart: true,
				spells: ["Flash", "Smite"],
				items: [
					{ name: "Youmuu's Ghostblade" },
					{ name: "Ionian Boots of Lucidity" },
					{ name: "Serrated Dirk", isNew: true },
					{ name: "Control Ward", count: 2 }
				]
			},
			{ champion: "Syndra", role: "MID", level: 13, k: 7, d: 1, a: 5 },
			{ champion: "Caitlyn", role: "ADC", level: 11, k: 3, d: 2, a: 6, dead: true, respawnSec: 24 },
			{ champion: "Nautilus", role: "SUP", level: 10, k: 0, d: 3, a: 9 }
		],
		recentEvents: ["Viego killed Jinx"],
		unseen: ["1334g sitting unspent"]
	})
)
