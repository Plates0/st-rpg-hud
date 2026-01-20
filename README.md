# RPG HUD (SillyTavern Extension)

Shows an RPG HUD panel that reads a single <rpg_state> JSON block from chat and renders stats, party/enemy summaries, meters, and an editor.

## Install
SillyTavern → Extensions → Install extension → paste this repo URL:
https://github.com/Plates0/st-rpg-hud

(Optional) specify a branch or tag (e.g. v1.0.0).

## IMPORTANT
**MAKE SURE TO DOWNLOAD AND ENABLE THE REGEX SCRIPTS TO HIDE THE JSON AND SAVE TOKENS**
Go into the regex folder → install it → go back to SillyTavern → Extensions → Regex → import → select the installed file (enable them if they aren't already enabled).

## Usage
- Ensure your character / system prompt outputs exactly one <rpg_state>...</rpg_state> block at the end of each assistant reply.
- Open the ⚙️ settings on the HUD for Scan/Edit/Reset and appearance options.

## Enabling/Disabling
- I got too lazy to create a menu directly in the extensions tab, so you'll just have to enable/disable it via extensions → manage extension → uncheck/check RPG HUD.

## RPG Guideline
- If you're using this with Dankholme RPG, simply make a copy of the current RPG Toggle, disable it, then replace the copy with this guideline:

---
```
<RPG Guidelines>

<RPG_STATE FORMAT (REQUIRED)>
- At the VERY END of every response, output EXACTLY ONE <rpg_state>...</rpg_state> block.
- Do NOT wrap the player inside "player": { ... }.
- Do NOT rename keys or invent new top-level formats.
- world_time MUST be an object (NOT a string).

Required format example (minified; spacing not required):
<rpg_state>{"name":"{{user}}","hp_curr":0,"hp_max":0,"mp_curr":0,"mp_max":0,"meters":[],"stats":{"atk":0,"matk":0,"def":0,"satk":0,"sdef":0},"inventory":[],"skills":[],"passives":[],"masteries":[],"quests":[],"env_effects":[],"status_effects":[],"dankcoin":0,"location":"","world_time":{"month":"Jan","day":1,"clock":"10:00"},"combat":{"active":false,"round":1},"vehicle":null,"party":[],"enemies":[],"npcs":[]}</rpg_state>

Notes:
- meters is OPTIONAL; omit or use [] if none.
- vehicle is either null OR an object with the SAME shape as a character (name/hp/mp/meters/stats/inventory/skills/passives/status_effects/dankcoin).
- party/enemies/npcs are arrays of character objects (same shape as player, minus party/enemies/npcs fields).
</RPG_STATE FORMAT (REQUIRED)>

<NPC Stat Visibility Rule>
NPCs are NOT guaranteed to have revealed stats unless explicitly observed in the story or directly present in-context. Therefore:
- NPCs ONLY (not party members, not enemies):
  - Default their stats to unknown placeholders until revealed.
  - Use "???" for unknown numeric values (hp_curr, hp_max, mp_curr, mp_max, meters curr/max, and all stats).
  - Do NOT invent ATK/MATK/DEF/SATK/SDEF, HP/MP caps, meters, skills, passives, inventory, or resistances.
- You MAY fill in (or start generating) NPC stats ONLY if at least one happens (Excluding bond: always include bond if you are using bond on that NPC):
  1) NPC enters combat (listed as participant or takes/receives a combat action),
  2) Something directly changes NPC values (HP/MP drain, healing, shields/temp HP meters, buffs/debuffs, etc),
  3) The story explicitly reveals a value,
  4) NPC becomes a party member (then follow party member rules).
- If NPC takes damage/healing without known max values: track only what is known (e.g., hp_curr changes) and keep max as "???".
- If NPC stats were previously revealed: keep/update exact values; do not re-randomize or “upgrade” unless story causes it.
  5) Remove NPC's not currently in the scene.
</NPC Stat Visibility Rule>

## Skills, Items & Effects (VERY IMPORTANT)

When listing skills, items, or passives, ALWAYS include their effects inline.
Equippable items should have [] appended at the end. When equipped, change to [X] (e.g. Iron Sword +10 ATK [X]).

Examples:
- Simple Skill:
  "Heavy Strike (MP-20) ATK*1.5"
- Healing Skill:
  "Healing Whispers (MP-15) Heal MATK*1, restores 15 Sanity"
- Skill Book:
  "Book of Heavy Strike (Reading teaches 'Heavy Strike (MP-20) ATK*1.5)'"
- Consumable:
  "Minor Health Potion (Restores 50 HP)"

Do NOT list names alone without effects.

## Skill, Item & Passive Formatting

Skills, items, passives, consumables, and equipment MUST be represented as single-line strings.

DO NOT use objects with separate fields (name, cost, effect).

Required format:
"Name (Cost) Effect"

Examples:
- "Analyze (MP-10) Reveals Weakness"
- "Healing Whispers (MP-15) Heals MATK*1 and restores 15 Sanity"
- "Iron Soul Orb (Absorb to gain permanent +25 DEF)"
- "Book of Heavy Strike (Reading teaches 'Heavy Strike (MP-20) ATK*1.5')"

All information must be contained in ONE line.
No nested objects.
No separate cost/effect fields.

## Game Rules

If {{user}} dies in combat or anywhere else, they will wake up in Purgatory a seemingly empty, endless, gloomy land.

There is NO level or EXP in this RPG.
Instead, stats increase via equipment and permanent stat buffs from various sources.

Equipment max modifiers:
- M.MP / M.HP increase maximum MP/HP of the equipped person.

Unknown values:
- If a value is unknown, keep the placeholder exactly: "???". Do not omit the field if it exists in the required format.

Low HP condition:
- If hp_curr < 25, include "Last Stand" or "Critical Condition" in status_effects.

Meters (shields/temp HP/sanity/hunger/stamina/etc):
- Store in meters: [{"name":"Shield","curr":30,"max":80}, ...] for each entity (and vehicle if relevant).
- meters max can exceed 100; do not clamp.
- Add/remove meters as the scene requires.

- HP/MP are authoritative. Do not infer or regenerate them. Only change HP/MP when an explicit event occurs (damage, heal, regen tick), and reflect the change in <rpg_state>.

## Base/Mod/Buff Math (REQUIRED)

If any [X] gear modifies a stat/max, output it as:
- "TOTAL (Base+Mod+Buff)" or "TOTAL ((Base+Mod)*Mult)".
Only count mods from [X] item text (e.g. "+50 ATK", "+25 M.HP", "+10 M.MP").
Back-calc Base: Base=TOTAL-Mod-BuffFlat. Example: atk 210 with +50 ATK [X] -> "210 (160+50+0)".
If TOTAL unknown: "??? (???+Mod+0)".
Only enforce for stats.* and hp_max/mp_max; keep hp_curr/mp_curr numeric.

## Combat tracking (REQUIRED)

- Make it very clear when entering combat.
- When in combat, set combat.active=true and combat.round=N inside <rpg_state>.
- Each response in battle should only have a single round featuring one action between all combatants.
  Certain skills may ignore this limitation.

Data you must keep inside <rpg_state>:
- Player: name, hp/mp, stats, meters, inventory/skills/passives/masteries, status_effects, dankcoin, location, world_time, combat, vehicle, quests, env_effects (note: env_effects = environment effects)
- Party members: same shape in party array.
- Enemies: same shape in enemies array during combat.
- NPCs: same shape in npcs array.
Do not invent new top-level formats. Keep everything consistent and parseable JSON.

<Spaceship Guidelines>
Spaceships and other vehicles should be compacted to just their name, HP and EN.
During spaceship combat, disable (DON'T REMOVE) the entire party's stats/skills focus and use only the vehicle’s stats/skills unless someone exits mid-combat.

HUD adaptation:
- Represent ships as vehicle {"active":true,"type":"ship","name":...,"hp_curr":...,"hp_max":...,"mp_curr":...,"mp_max":...}
- EN maps to MP.
- During ship combat, keep combat on the vehicle (and keep pilots minimal unless they exit).
</Spaceship Guidelines>

<Mecha Guidelines>
If a party member is in a mecha/exosuit, disable (DON'T REMOVE) their personal skills/other stats focus and use the Mecha's stats/skills instead.

HUD adaptation:
- Set that entity’s vehicle.active=true and vehicle.type="mecha"
- Put the mecha’s skills/passives/stats under vehicle.
- If multiple pilots, include them in the vehicle name string.
</Mecha Guidelines>

<Damage Formula>
Basic: (ATK or MATK) - DEF = DMG dealt
- Note: ATK/MATK includes skill multipliers.
Critical: ((ATK or MATK)*2) - DEF = DMG dealt

True DMG:
- Ignores defenses: (ATK or MATK) = DMG dealt
- True DMG can crit.

Final DMG Multiplier:
- Final: ((ATK or MATK) - DEF) = DMG * (Final DMG Multiplier) = DMG dealt

Full formula:
((ATK or MATK)*Skill Multiplier)*(Crit Multiplier) - DEF*(True DMG Modifier) = DMG*(Final DMG Multiplier) = DMG dealt
True DMG Modifier = 0 if active.
</Damage Formula>

<Misc Combat Guidelines>
1. Always perform accurate mathematics in combat. Math is absolute. Do not round or remove a zero for roleplay reasons. No plot armor. If damage exceeds max HP, HP goes straight to 0.
2. An enemy is defeated ONLY if HP is at 0 or lower. Do not narrate defeat otherwise. They may still surrender earlier.
3. Attacking an obvious weak spot may cause a critical.
4. Roleplay actions that could avoid death ONLY work if explicitly attempted and plausible. Otherwise, apply full accurate math.
5. All entities always have access to these two basic skills (do not add to lists if not already there):
   - Basic Attack (MP-0) ATK*1 or MATK*1
   - Parry (MP-0) While parrying, DEF = DEF + ATK
6. Skills without explicit cooldowns have no cooldowns.
7. Each battle response should only have a single round featuring one action between all combatants (unless a skill says otherwise).
8. DEF is usually determined by gear, but some may have innate defenses.
9. Poisons and similar effects do True DMG.
10. Generate enemy skills (with multipliers/abilities) if they lack predefined skills/stats.
11. Bosses are immune to blinds, binds, and stun.
</Misc Combat Guidelines>

Show the math on a new line for each attack after describing it in a similar style below:

<div style="border:1px solid #FFD700; padding:10px; border-radius:8px; margin:10px 0; text-align:center;">
⚔️ <strong>DEEP CUT!</strong> X dealt 25 DAMAGE to Y!
<em>(30 ATK vs 5 DEF → 25 damage!) </em>
</div>

Begin all combat with the following (edit party and opponent as required).
For BOSS BATTLES only: multiply boss maximum HP by the amount of party members and add to the boss div style: animation: pulse 2s infinite

<div style="border:3px solid #FF0000; padding:15px; background:#ffebee; border-radius:10px; font-family:'Courier New'; text-align:center; margin-bottom:20px; box-shadow:0 0 15px rgba(255,0,0,0.5);">
<strong style="color:#d50000; font-size:1.2em;">⚠️ COMBAT ENGAGED, {{USER}}'s PARTY VS OPPONENT⚠️</strong><br>
</div>
**ROUND 1**

</RPG Guidelines>
```
---
- Otherwise, create a new lorebook entry, paste it into the box, check Non-recursable, Prevent further recursion, set the order to be very high, and set it as always active (blue dot).
