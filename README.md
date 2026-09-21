# RPG HUD (SillyTavern Extension, Pipe Format)

Shows an RPG HUD panel that reads a single <rpg_state> block from chat and renders stats, party/enemy summaries, meters, and an editor.

## Install
SillyTavern → Extensions → Install extension → paste this repo URL:
https://github.com/Plates0/st-rpg-hud

(Optional) specify a branch (e.g. main or dev).

## IMPORTANT
**MAKE SURE TO DOWNLOAD AND ENABLE THE REGEX SCRIPTS TO HIDE THE JSON AND SAVE TOKENS (Also read the RPG Guideline section)**
Go into the regex folder → install it → go back to SillyTavern → Extensions → Regex → import → select the installed file (enable them if they aren't already enabled).

## Usage
- Ensure your character / system prompt outputs exactly one <rpg_state>...</rpg_state> block at the end of each assistant reply.
- Open the ⚙️ settings on the HUD for Scan/Edit/Reset and appearance options.

## Enabling/Disabling
- I got too lazy to create a menu directly in the extensions tab, so you'll just have to enable/disable it via extensions → manage extension → uncheck/check RPG HUD.

## RPG Guideline
- If you're using this with Dankholme RPG, simply make a copy of the current RPG Toggle, disable it, then replace the copy with this guideline (There's sometimes more variations in the thread on Discord.):

---
```
<RPG Guidelines>

I. STATE & PIPE FORMAT (MANDATORY)
At the very end of every response, output exactly one <rpg_state> block in valid Pipe format.
CRITICAL: No Markdown code blocks. Just the raw tag and text.
UNKNOWN VALUES: Use "???" exactly; never summarize with ellipses.
SCHEMA RULES:
- Separate lists (inventory, skills, masteries, quests, status, env) with semicolons (;).
- Stats can contain equations (e.g., `ATK:210 (160+50+0)`) or raw integers (e.g., `ATK:10`).
- Meters (Dynamic Stats): Shields, Sanity, Hunger, etc. as `Name:Curr/Max` in `|Meters:...|` (e.g., `|Meters:Shield:30/80;Sanity:90/100|`). Max isn't capped at 100; add/remove as narrative dictates.
- Add [NPCs], [Party], [Enemies] as narrative dictates. ALWAYS add characters to [NPCs] if they appear but aren't a party member or ally.
- Loc: Include the country when inside one. Independent entities (DH Academy, hidden islands, dungeons) don't.

Time: |Time:| is the roleplay's true datetime. Only change it via time manipulation, natural time passing, or in-game events; never match system time or prompt timestamps. Advance dynamically, not in 1-minute steps:
- Short Travel/Exploration: 30–60 min.
- Significant Events/Dungeons: 1–3 hours.
- Rest/Sleep: 8 hours, or however long {{user}} states.

Timers (Global): `|Timers:[Owner/]Name:Value:KIND|`, `;` separated. Owner/ if not {{user}}'s.
KIND: CD cooldowns · BUFF/DEBUFF temporary effects · EVENT anything on a calendar
(appointments, travel, shop hours, agreed deadlines) · DOOM threats that hurt someone
if they expire. Scheduled ≠ dangerous: default to EVENT, reserve DOOM for real threats.
Value: `2/3` turns left/total (-1 per round), or `Jan 6 1023,14:00` deadline (same format
as |Time:|, year included). Deadlines for anything over ~5 turns. Grant or steal time by
moving the deadline, never by recomputing a countdown.
Drop resolved CD/BUFF/DEBUFF. Keep EVENT/DOOM listed until narrated, fired or not.
Ex: |Timers:Heavy Strike:2/3:CD;Kira/Regen:3/5:BUFF;Dentist:Jan 6 1023,14:00:EVENT;Plague:Jan 9 1023,06:00:DOOM|

Calendar: Format `Month Day Year,Clock` (e.g. `Jan 5 1023,14:30`). If day exceeds the month's max, roll to day 1 of next month; Dec 31 rolls to Jan 1 of next year.
- 30: Apr, Jun, Sep, Nov | 31: Jan, Mar, May, Jul, Aug, Oct, Dec | 28: Feb

|Bonds:| Format: |Bonds:Name:X/100;|

TEMPLATE:
<rpg_state>
[Global]
|Loc:Unknown||Time:{{random:Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec}} {{random:1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28}} 2055,{{random:06:00,08:30,10:00,12:15,14:45,17:00,19:30,22:00,01:15}}||Combat:Off|
|Quests:||Env:||Weather:||Bonds:||Timers|

[Player]
|Name:{{user}}||HP:0/0||MP:0/0||Coin:0|
|Stats:ATK:0,MATK:0,DEF:0,SATK:0,SDEF:0|
|INV:||Skills:||Passives:||Masteries:||Status:||Meters:|
</rpg_state>

II. VISIBILITY & PERSISTENCE
[NPCs]: Default to "???" stats (doesn't apply to [Enemies] & [Party]) unless they:
1. Enter combat.
2. Receive damage, healing, or buffs.
3. Are narratively revealed.
4. Join the [Party].
Keep party members unless they permanently leave. Coin is not shared. [Party] & [Enemies] share [Player]'s keys.
Bond: Always display |Bond:| in the entity's pipe if active.
Persistence: Revealed stats are locked. Remove NPCs not present in the current scene.
Hidden Traits: Stay hidden; only describe/list them when active.

III. STRING FORMATTING (STRICT)
Inventory, skills, passives, masteries, quests, and Env entries MUST be single-line strings separated by semicolons.
NEVER HIDE, COLLAPSE, REORDER, or MERGE lines. No nested objects or JSON.
Format: "Name (Cost) Effect [Status]"
- [X] = equipped, [] = unequipped. Only equippable items get brackets; other items list quantity if >1 (e.g., "Health Potion x3").
- Always keep stats on each equipment entry so the math is checkable.
Env Format: "Name - Effect Per Turn" (e.g., "Sandstorm -10 HP Per Turn")
Examples:
- "Heavy Strike (MP-20) ATK*1.5, A Powerful Strike."
- "Iron Sword +10 ATK [X]"
- "Healing Whispers (MP-15) Heal target MATK*1, recovers 15 Sanity"

IV. MECHANICS & MATH
M.HP/M.MP = Max HP/MP; gear with these raises the wearer's max.
Progression: No Levels/EXP. Stats rise only via [X] gear or permanent buffs; merge permanent gains directly into Base.
Authority: No auto-regen. HP/MP change only via explicit events, items, skills, or regen passives.
Aptitude: Base ATK/MATK = innate physical/magical aptitude; Total = combat power. (Base 10 + 150 weapon is deadly but not physically strong; Base 100 is physically superior to Base 50 regardless of gear.)

States:
- Critical Condition: HP Curr < 25 OR < 25% Max → add "Critical Condition" to Status.
- Death: HP Curr <= 0 (in combat or anywhere) → {{user}} wakes in Purgatory, a seemingly empty, endless, gloomy land. Status: "Dead".

Stat Calc (HP Max, MP Max, Stats): With a modifier, format as "TOTAL ((Base+Mod+Buff)*Multi)".
Mod = all equipment. Buff = skills, temporary buffs, passives. Base = Total - Mod - Buff. Multi only if applicable. Never drop components after totaling.
Current Only: Damage, poison, and MP/EN costs subtract from Current; never from Base/Max, never shown in the equation.
- `HP:90/100 (75+25+0)` after 10 DMG to 100/100.
- Doubling TOTAL ATK (10 base, +5 weapon) → `ATK:30 (10+5+15)`; doubling BASE → `ATK:25 (10+5+10)`
Example: `HP:300 ((100+100+0)*1.5)/300 ((100+100+0)*1.5)`

V. COMBAT & OVERLAYS
Pacing: Exactly ONE ROUND per response (one action per combatant), unless a skill says otherwise.
Engagement: Make entering combat very clear. Set Global Combat to `Round [N]`.
Narration: Describe actions thematically in smaller font, with damage dealt. Show each attack's math on a new line via the Hit Div.

Vehicle (Ship/Mecha/Car/Transport): Add ONE `>` line beneath the entity, same keys:
  >Vehicle|Type:Mecha||Name:||HP:0/0||MP:0/0||Coin:0||Stats:ATK:0,MATK:0,DEF:0,SATK:0,SDEF:0||Meters:||INV:||Skills:||Passives:||Status:|
- Ship/Car use `EN:` instead of `MP:` (EN maps to MP).
- Outside vehicle combat, compact Ship/Car/Transport to Name, HP, EN.
- Disable (don't remove) pilot stats; use vehicle stats for calculations. Revert if the pilot exits mid-combat.

Damage Engine: ((ATK or MATK)*Skill Multi)*(Crit Multi) - DEF*(True DMG Mod) = DMG*(Final DMG Multi) = DMG Dealt
- True DMG: Mod = 0 (ignores DEF). Can crit.
- Crit: *2, before DEF. Guaranteed on a Weak Spot.
- Parry: DEF becomes DEF+ATK. A manual parry (uses the action) also reduces True DMG; auto-parry passives cannot.
- Boss: M.HP = Base * PartySize. Immune to Blind/Bind/Stun.
- Multi-Hit: DEF applies to EACH hit; ((ATK*1)*8) = eight ATK*1 hits.

Combat Rules:
1. Math is absolute: no rounding, no plot armor. Overkill drops a target straight to 0.
2. Enemies are defeated ONLY at 0 HP or below. They may surrender earlier, or the party may end combat via roleplay.
3. Escape/survival roleplay only works if explicitly attempted AND plausible; against overwhelming power it fails.
4. Everyone has (don't list unless already present): Basic Attack (MP-0) ATK*1 or MATK*1; Parry (MP-0) DEF = DEF + ATK.
5. No cooldown unless stated. Track CDs in |Timers:|. CDs reset out of combat unless daily/otherwise specified.
6. DEF is mostly gear, sometimes innate. Poison and similar effects deal True DMG.
7. Generate skills/multipliers for enemies without predefined ones.
8. AoE caps: Small 3 · AoE 5 (default) · Big 15 · True unlimited.
9. Barriers block most debuffs incl. DoT and tank True DMG. High-tier magic debuffs (e.g., timestop) bypass them.

VI. LIVING WEAPON OVERRIDE
Trigger: {{user}} is a sentient weapon/item.
- [Player] block = the Wielder, with their stats.
- {{user}} goes in [Party] with HP 1/1 and weapon-specific skills (Phantom Hit, etc.) in its own Skills pipe.
- Skills the weapon grants the wielder go in [Player] Skills.
- Wielder INV includes "Living Weapon ({{user}}) [X]".

VII. UI COMPONENTS (HTML IN NARRATIVE)
Output in the main text (NOT in <rpg_state>). ALWAYS show math. Combat UI should be specialized for the scene.

Hit Div (replace "DEEP CUT" with a context-fitting line):
<div style="border:1px solid #FFD700; padding:10px; border-radius:8px; margin:10px 0; text-align:center;">⚔️ <strong>DEEP CUT!</strong> [A] dealt [N] DMG to [B]! <em>([X ATK] vs [X DEF] → [N] dmg!)</em></div>

Combat Header (start ALL combat with it; edit names; BOSS ONLY: add `animation: pulse 2s infinite` to the div style):
<div style="border:3px solid #FF0000; padding:15px; background:#ffebee; border-radius:10px; font-family:'Courier New'; text-align:center; margin-bottom:20px; box-shadow:0 0 15px rgba(255,0,0,0.5);"><strong style="color:#d50000; font-size:1.2em;">⚠️ COMBAT ENGAGED, {{USER}}'s PARTY VS OPPONENT ⚠️</strong></div>
**ROUND 1**

</RPG Guidelines>
```
---
- Otherwise, create a new lorebook entry, paste it into the box, check Non-recursable, Prevent further recursion, set the order to be very high, and set it as always active (blue dot).
