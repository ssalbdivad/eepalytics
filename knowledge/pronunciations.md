---
patch: durable
sourcedAt: 2026-09-04
source: model-knowledge
---

# How to say the names out loud

The live coach speaks through a native-audio model, which pronounces what it is handed. Champion
names are mostly invented words, and it says a lot of them wrongly — badly enough that the player
cannot tell who is being talked about, which makes an otherwise correct sentence useless.

**This file is the fix, and it is meant to be edited.** If a name still sounds wrong in game, change
the respelling here and it takes effect on the next game with no code change. Only names that are
actually spoken wrongly need an entry; anything absent is left alone.

## Where this goes, and where it must never go

It goes in the **system prompt**, as a rule about the coach's voice, rendered by
`renderPronunciationGuide` in `src/shared/pronounce.ts`.

It went in the **per-turn ground-truth block** once, and the model read the respellings out loud —
*"BRY-er is still at 0 CS"*, to the player, in a real game, repeatedly. That was not disobedience.
The block is CONTENT: every other line in it is a fact the coach may speak, so a line shaped like
data was treated as data. An instruction about how to say something cannot live in the content.

The turn-based providers do not use this list in a prompt at all. They return text, the browser
speaks it with `speechSynthesis`, and `respellForSpeech` in `src/web/lib/turnCoach.ts` swaps the
respelling in during the last milliseconds before the speaker — after the transcript is written, so
the log keeps the normal spelling and no prompt can ever see a respelling.

Whole file, every game: the guide is sent once per socket and cached, so filtering it to the roster
would save nothing and would need a roster at champ select, before the client reports one.

## Format

One name per line, `Name = respelling`. Capitals mark the stressed syllable. Write it the way you
would say it to a person, not in IPA — the model reads this aloud rather than parsing it.

Everything below is a best effort at the community pronunciation. **Correct anything that sounds
wrong when you hear it** — you have the game running and this file exists precisely so that
judgement is yours rather than mine.

## Names

Aatrox = AY-trox
Ahri = AH-ree
Akali = uh-KAH-lee
Akshan = AK-shan
Alistar = AL-ih-star
Amumu = ah-MOO-moo
Anivia = uh-NIV-ee-uh
Aphelios = uh-FEE-lee-os
Aurelion Sol = aw-REE-lee-on SOL
Aurora = uh-ROR-uh
Azir = AH-zeer
Bel'Veth = BELL-veth
Briar = BRY-er
Camille = kuh-MEEL
Cassiopeia = cass-ee-oh-PEE-uh
Cho'Gath = CHO-gath
Dr. Mundo = doctor MUN-doh
Elise = eh-LEESE
Evelynn = EV-uh-lin
Ezreal = EZ-ree-al
Fiora = fee-OR-uh
Gnar = NAR
Gragas = GRAH-gas
Hecarim = HEK-uh-rim
Heimerdinger = HY-mer-ding-er
Hwei = HWAY
Illaoi = ill-AH-oy
Irelia = eye-REE-lee-uh
Ivern = EYE-vern
Jarvan IV = JAR-van the fourth
Jhin = JIN
Kai'Sa = KY-suh
Kalista = kuh-LIS-tuh
Karthus = KAR-thus
Kassadin = KAS-uh-din
Kayn = KANE
Kha'Zix = kah-ZIKS
Kog'Maw = KOG-maw
K'Sante = kuh-SAHN-tay
LeBlanc = luh-BLONK
Lillia = LILL-ee-uh
Lissandra = lih-SAN-druh
Lucian = LOO-shun
Malzahar = MAL-zuh-har
Maokai = mah-OH-kai
Milio = MEE-lee-oh
Mordekaiser = MOR-deh-kai-zer
Naafiri = nah-FEER-ee
Nasus = NAY-sus
Nautilus = NAW-tih-lus
Nidalee = NID-uh-lee
Nilah = NEE-lah
Nunu & Willump = NOO-noo and WILL-umb
Orianna = or-ee-AH-nuh
Qiyana = kee-YAH-nuh
Rakan = RAH-kahn
Rek'Sai = reck-SIGH
Renata Glasc = reh-NAH-tuh GLASK
Renekton = REN-ek-ton
Rengar = REN-gar
Ryze = RIZE
Samira = suh-MEE-ruh
Sejuani = seh-JWAH-nee
Seraphine = SER-uh-feen
Shaco = SHAH-ko
Shyvana = shih-VAH-nuh
Singed = SINJD
Sion = SY-on
Sivir = SIH-veer
Skarner = SKAR-ner
Soraka = so-RAH-kuh
Sylas = SY-lus
Syndra = SIN-druh
Tahm Kench = TAHM KENCH
Taliyah = TAH-lee-yah
Taric = TAR-ik
Tristana = tris-TAH-nuh
Trundle = TRUN-dul
Tryndamere = TRIN-duh-meer
Udyr = YOO-deer
Urgot = UR-got
Varus = VAIR-us
Veigar = VAY-gar
Vel'Koz = VEL-koz
Viego = vee-AY-go
Vladimir = VLAD-ih-meer
Volibear = VOL-ee-bair
Wukong = WOO-kong
Xayah = ZY-uh
Xerath = ZEER-ath
Xin Zhao = SHIN ZOW
Yasuo = yah-SOO-oh
Yone = YO-neh
Yorick = YOR-ik
Yuumi = YOO-mee
Zeri = ZEH-ree
Zilean = ZY-lee-un
Zoe = ZO-ee
Zyra = ZY-ruh
