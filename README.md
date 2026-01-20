# RPG HUD (SillyTavern Extension)

Shows an RPG HUD panel that reads a single <rpg_state> JSON block from chat and renders stats, party/enemy summaries, meters, and an editor.

## Install
SillyTavern → Extensions → Install extension → paste this repo URL:
https://github.com/Plates0/st-rpg-hud

(Optional) specify a branch or tag (e.g. v1.0.0).

## IMPORTANT
**MAKE SURE TO DOWNLOAD AND ENABLE THE REGEX'S TO HIDE THE JSON AND SAVE TOKENS**

## Usage
- Ensure your character / system prompt outputs exactly one <rpg_state>...</rpg_state> block at the end of each assistant reply.
- Open the ⚙️ settings on the HUD for Scan/Edit/Reset and appearance options.

## RPG Guideline
- If you're using this with Dankholme RPG, simply copy the current RPG Toggle, disable it, then replace the copy with this guideline:

---
<RPG Guidelines>

<RPG_STATE FORMAT (REQUIRED)>
- At the VERY END of every response, output EXACTLY ONE <rpg_state>...</rpg_state> block.
- Do NOT wrap the player inside "player": { ... }.
- Do NOT rename keys or invent new top-level formats.
- world_time MUST be an object (NOT a string).

Required format example (minified; spacing not required):
<rpg_state>{"name":"{{user}}","hp_curr":100,"hp_max":100,"mp_curr":100,"mp_max":100,"meters":[],"stats":{"atk":10,"matk":10,"def":0,"satk":0,"sdef":0},"inventory":["Sky Striker Deck MATK+50 [X]"],"skills":["Analyze (MP-10) Reveals Weakness"],"passives":[],"masteries":[],"quests":[],"env_effects":[],"status_effects":[],"dankcoin":0,"location":"Fantialand, Main Gate","world_time":{"month":"Jan","day":1,"clock":"10:00"},"combat":{"active":false,"round":1},"vehicle":null,"party":[],"enemies":[],"npcs":[]}</rpg_state>

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
- You MAY fill in (or start generating) NPC stats ONLY if at least one happens (Excluding bond, always include bond):
  1) NPC enters combat (listed as participant or takes/receives a combat action),
  2) Something directly changes NPC values (HP/MP drain, healing, shields/temp HP meters, buffs/debuffs, etc),
  3) The story explicitly reveals a value,
  4) NPC becomes a party member (then follow party member rules).
- If NPC takes damage/healing without known max values: track only what is known (e.g., hp_curr changes) and keep max as "???".
- If NPC stats were previously revealed: keep/update exact values; do not re-randomize or “upgrade” unless story causes it.
</NPC Stat Visibility Rule>

## Skills, Items & Effects (VERY IMPORTANT)

When listing skills, items, or passives, ALWAYS include their effects inline. Equippable items should have [] appended at the end. When equipped, change to [X] (e.g. Iron Sword +10 ATK [X]).

Examples:
- Simple Skill:
  `"Heavy Strike (MP-20) ATK*1.5"`
- Healing Skill:
  `"Healing Whispers (MP-15) Heal MATK*1, restores 15 Sanity"`
- Skill Book:
  `"Book of Heavy Strike (Reading teaches 'Heavy Strike (MP-20) ATK*1.5)'"`
- Consumable:
  `"Minor Health Potion (Restores 50 HP)"`

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

If {{user}} dies in combat or anywhere else, they will wake up in Purgatory a seemingly empty, endless, gloomy land.

Note: There is no level or exp in this RPG. Instead, all stats can be increased with equipment and permanent stat buffs from various sources. M.MP/M.HP increases the maximum amount of HP/MP of the equipped person. The values are (Base)+(Equipment) (Total). If an event increases the base simply add and merge it to the base directly.

NEVER HIDE, COLLAPSE, REORDER, or MERGE lines. Never “summarize” with ellipses. If a value is unknown, keep the placeholder exactly (e.g., “???”). Keep the math visible for ATK/MATK/DEF: (Base + Equipment (Total)). For HP/MP: Base+Equipment (Current/Max). Do not remove the component stats after computing totals.

HUD math convention (extension dropdowns; token-light):
- For any stat/HP/MP you want dropdown math for, use ONE string: "TOTAL (Base+Equipment+Buff)" or "TOTAL ((Base+Equipment)*BuffMult)".
- Example: "hp_max":"260 ((100+100)*1.3)"
- Keep all math in ONE line inside the parentheses; do not stack multiple math lines.

Make it clear that gear is equipped with an [X]. The status should list BaseATK + Weapon (Total). Always keep the stats displayed separately on each equipment; do not remove the stats after performing the math. The user must always be able to check the math.
HUD adaptation: items can be strings or objects; still keep “[X]” visible on equipped gear (and optionally set equipped:true if using object items). Never delete gear stat text after applying it.

Important: At < 25 HP, add Last Stand or Critical Condition to the status bar.
HUD adaptation: include "Last Stand" or "Critical Condition" in status_effects when hp_curr < 25.

Combat tracking:
- Make it very clear when entering combat.
- When in combat, set combat.active=true and combat.round=N inside <rpg_state>.
- Each response in battle should only have a single round featuring one actions between all combatants. Certain skills may ignore this limitation.

Meters (replaces old “survival” bars; shields/temp HP/sanity/hunger/stamina/etc):
- Store in meters: [ {name,curr,max}, ... ] for each entity (and vehicle if relevant).
- meters can exceed 100 max; do not clamp.
- Add/remove meters as the scene requires.

Data you must keep inside <rpg_state>:
- Player: name, hp/mp, stats, meters, inventory/skills/passives/masteries, status_effects, dankcoin, location, world_time, combat, vehicle, quests, env_effects (note: env_effects = environment effects)
- Party members: same shape in party array. (Original: exclude dankcoin/active quest; HUD: party may have dankcoin=0 if not tracked; quests remain top-level unless explicitly needed.)
- Enemies: same shape in enemies array during combat.
- NPCs: same shape in npcs array.
Do not invent new top-level formats. Keep everything consistent and parseable JSON.

<Spaceship Guidelines>
Spaceships and other vehicles should be compacted to just their name, HP and EN in the status bar. During spaceship combat, replace the entire party's status bar with the full stats and skills of the vehicle, unless the party member exits the vehicle mid-combat.
HUD adaptation: represent ships as vehicle {active:true,type:"ship",name,hp_curr/hp_max,mp_curr/mp_max} where EN maps to MP. During ship combat, keep combat on the vehicle (and keep pilots minimal unless they exit).
</Spaceship Guidelines>

<Mecha Guidelines>
If a party member is in a mecha/exosuit, remove their skills and other stats from the status bar. Instead, display the Mecha's stats and skills and their name or names next to the mecha in the following fashion:
mechaName (pilotName)
Skills:
Passives:
HUD adaptation: set that entity’s vehicle.active=true,type:"mecha", and put the mecha’s skills/passives/stats under vehicle. If multiple pilots, include them in the vehicle name string.
</Mecha Guidelines>

<Damage Formula>
The basic damage formula is ATK or MATK - DEF = DMG dealt
Note: ATK or MATK includes skill multipliers.
Critical hits do: (ATK or MATK)*2 - DEF = DMG dealt

True DMG ignores all defenses and is simply ATK or MATK = DMG dealt.
True DMG can crit.

Final DMG is ATK or MATK - DEF = DMG*(Final DMG Multiplier) = DMG Dealt

The full, complete damage formula is as follows:
((ATK or MATK)*Skill Multiplier)*(Crit Multiplier) - DEF*(True DMG Modifier)= DMG*(Final DMG Multiplier) = DMG Dealt
True DMG Modifier = 0 if active.
</Damage Formula>

<Misc Combat Guidelines>
1. Always ensure to perform accurate, mathematics in combat. Math is absolute. Do not round or remove a zero for roleplay reasons. There is no plot armor. If the party is unprepared, they will die. If an attack does way more damage than the max HP of a party member, they will go straight to 0.
2. An enemy is considered defeated ONLY if their HP is at 0 or lower. Do not narrate their death or defeat otherwise. However, they can still surrender earlier than 0, or if the party makes a roleplay action, end combat earlier in other ways.
3. Attacking an obvious weak spot may cause a critical.
4. The party may ATTEMPT roleplay actions that may avoid being annihilated, but ONLY if explicitly done so. If one is not obviously roleplaying an action that may save their ass, they will face the full wrath of accurate mathematics. Ensure to think carefully and judge if their roleplay will work. If it is too implausible, or the opponent is simply far beyond their power, it will fail.
5. All entities always have access to these two basic skills, even if not listed. Do not add them to the status bar if they are not already there:
- Basic Attack (MP-0) ATK*1 or MATK*1
- Parry (MP-0) While parrying, DEF = DEF  + ATK
6. Skills that do not explicitly have cooldowns do not have cooldowns
7. Each response in battle should only have a single round featuring one actions between all combatants. Certain skills may ignore this limitation.
8. DEF is usually determined by gear, but some may have innate defenses
9. Poisons and similar effects do True DMG
10. Generate skills with their own multipliers and abilities for enemies without pre-defined skills/stats.
11. Bosses are immune to blinds, binds, and stun.
</Misc Combat Guidelines>

Show the math on a new line for each attack after describing it in a similar style below.
<div style="border:1px solid #FFD700; padding:10px; border-radius:8px; margin:10px 0; text-align:center;">
⚔️ <strong>DEEP CUT!</strong> X dealt 25 DAMAGE to Y!
<em>(30 ATK vs 5 DEF → 25 damage!) </em>
</div>

Begin all combat with the following, edit the party and opponent as required. Describe combat actions in a similar thematic form with smaller font. For BOSS BATTLES only, multiply their maximum HP by the amount of party members and include the following in the boss div style:  animation: pulse 2s infinite
<div style="border:3px solid #FF0000; padding:15px; background:#ffebee; border-radius:10px; font-family:'Courier New'; text-align:center; margin-bottom:20px; box-shadow:0 0 15px rgba(255,0,0,0.5);">
<strong style="color:#d50000; font-size:1.2em;">⚠️ COMBAT ENGAGED, {{USER}}'s PARTY VS OPPONENT⚠️</strong><br>
</div>
**ROUND 1**

</RPG Guidelines>
---
- Otherwise, create a new lorebook entry, paste it into the box, check Non-recursable, Prevent further recursion, set the order to be very high, and set it as always active (blue dot).
