# RPG HUD (SillyTavern Extension)

Shows an RPG HUD panel that reads a single <rpg_state> JSON block from chat and renders stats, party/enemy summaries, meters, and an editor.

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
- If you're using this with Dankholme RPG, simply make a copy of the current RPG Toggle, disable it, then replace the copy with this guideline (there are two, the first one will work with Gemini, however the second one may be more coherent for any other model):

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
Second Variation:
```
<RPG Guidlines>
I. RPG_STATE JSON (MANDATORY OUTPUT)
At the absolute end of every response, output exactly one <rpg_state> block.

Safety: Do NOT use markdown code blocks (e.g., ` ` `). No "player" wrapper.

Types: world_time MUST be an object. meters is optional (omit or use []).

Placeholders: Use "???" for any unknown numeric value (Stats, HP/MP Caps). Do not omit the field.

Nesting: party, enemies, and npcs are arrays of character objects (same shape as player, minus recursive party/enemies/npcs fields). vehicle is null or a character-shaped object.

SCHEMA (STRICT ADHERENCE): <rpg_state>{"name":"{{user}}","hp_curr":0,"hp_max":0,"mp_curr":0,"mp_max":0,"meters":[],"stats":{"atk":0,"matk":0,"def":0,"satk":0,"sdef":0},"inventory":[],"skills":[],"passives":[],"masteries":[],"quests":[],"env_effects":[],"status_effects":[],"dankcoin":0,"location":"","world_time":{"month":"Jan","day":1,"clock":"10:00"},"combat":{"active":false,"round":1},"vehicle":null,"party":[],"enemies":[],"npcs":[]}</rpg_state>

II. NPC STAT VISIBILITY & PERSISTENCE
Visibility: NPCs (excluding Party/Enemies) default to "???" for all stats, caps, and meters until revealed. Do not invent values prematurely.

Reveal Triggers: Generate/fill NPC stats ONLY if:

The NPC enters combat or joins the Party.

An effect directly changes their values (Damage, Healing, Buffs/Debuffs).

The narrative explicitly reveals a value.

Bond: If a "Bond" system is active for an NPC, always include the Bond stat.

Partial Tracking: If an NPC is damaged without a known Max HP, track hp_curr and keep hp_max as "???".

Persistence: Once revealed, stats are locked. Do not re-randomize or "level up" unless narratively justified.

Cleanup: Remove any NPCs from the npcs array if they are no longer in the current scene.

III. STRING FORMATTING & FLAT ARCHITECTURE
Flat String Constraint: Every entry in inventory, skills, passives, masteries, and quests MUST be a single-line string.

Prohibited Structure: DO NOT use nested objects, separate fields (name, cost, effect), or line breaks within these arrays.

Standard Format: "Name (Cost) Effect [X]" (Use [X] only for equipped).

Execution Examples:

"Analyze (MP-10) Reveals Weakness"

"Healing Whispers (MP-15) Heals MATK*1 and restores 15 Sanity"

"Iron Soul Orb (Absorb) Permanent +25 DEF"

"Book of Heavy Strike (Reading) Teaches 'Heavy Strike (MP-20) ATK*1.5'"

"Iron Sword +10 ATK [X]"

IV. CORE GAME MECHANICS & PHYSICS
Death Loop: If {{user}} reaches 0 HP, they immediately respawn in Purgatory (an empty, endless, gloomy land).

Progression Logic: There is NO Leveling or EXP system. Stats increase exclusively via:

Equipment: Items tagged with [X].

Permanent Buffs: Consumables or story events.

Special Modifiers:

M.HP and M.MP tags on equipment modify the Maximum HP/MP of the wearer.

The Authority Rule: HP and MP are authoritative. Do NOT infer, regenerate, or "hand-wave" recovery. Values only change during explicit narrative events (damage, healing, regen ticks).

Meters (Dynamic Stats):

Store shields, Sanity, hunger, etc., in the meters array.

Format: {"name":"Shield","curr":30,"max":80}.

max values are not capped at 100. Add/remove meters as the narrative dictates.

Critical State: If hp_curr < 25, you MUST append "Last Stand" or "Critical Condition" to the status_effects array.

Placeholder Integrity: Never omit a field. If a value is unknown, use the "???" placeholder exactly.

V. BASE/MOD/BUFF MATH (STAT CALCULATION)
Scope: Apply this logic ONLY to hp_max, mp_max, and all fields within the stats object. Keep hp_curr and mp_curr as pure integers.

Output Format: Use the string pattern: "TOTAL (Base+Mod+Buff)" or "TOTAL ((Base+Mod)*Mult)".

Logic: * Mod: Sum all modifiers from currently equipped [X] items (e.g., +50 ATK, +25 M.HP).

Buff: Total of all active temporary status effects or passives.

Base: The raw stat without gear/buffs. (Formula: Base = TOTAL - Mod - Buff).

Unknowns: If the TOTAL is hidden, use: "??? (???+Mod+Buff)".

Example: * Character has 160 raw ATK and is wearing an item with +50 ATK [X].

Result: "atk": "210 (160+50+0)"

VI. COMBAT TRACKING & DATA INTEGRITY
Combat State: Upon entering battle, you MUST:

Set combat.active: true and initialize/increment combat.round: N.

Explicitly narrate the transition into combat (refer to UI section for headers).

Turn Pacing: Each response represents EXACTLY ONE ROUND.

Limit output to a single exchange of actions between all combatants (unless a specific skill grants extra actions). Do not skip ahead or conclude the battle prematurely.

Schema Uniformity: All entities (Player, Party, Enemies, NPCs) must share the same "Character Shape" (HP/MP, Stats, Meters, Skills, etc.).

Data Persistence: You are responsible for maintaining the following arrays in every <rpg_state>:

party: Active companions.

enemies: Populated ONLY during active combat.

npcs: Characters present in the scene but not in the party/enemy arrays.

Environmental Data: Use env_effects to track battlefield conditions (e.g., "Smoke Screen," "Rain," "Zero Gravity").

Constraint: Do NOT invent top-level JSON keys. Keep the output minified, parseable, and consistent.

VII. SPACESHIP & VEHICLE OVERLAYS
State Trigger: When the party enters a ship or vehicle, set vehicle.active: true.

Ship Schema: Use the vehicle object with the character shape.

Map: EN (Energy) is tracked in the mp_curr/max fields.

Type: Set "type": "ship" within the vehicle object.

Combat Focus (Shift): During ship-to-ship combat, you MUST Disable (but do NOT remove) the party's individual stats/skills focus.

All damage, skill costs, and actions must be calculated using the Vehicle's HP, MP (EN), and Stats.

Individual pilot data remains in the JSON for persistence but is ignored for combat math unless an entity exits the vehicle mid-combat.

Compaction Rule: For the vehicle summary in <rpg_state>, prioritize Name, HP, and EN (MP) for HUD clarity.

VIII. MECHA & EXOSUIT PROTOCOLS
State Trigger: When an entity enters a mecha or exosuit, set that entity's vehicle.active: true and vehicle.type: "mecha".

The "Pilot" Override: * Calculations: Immediately shift all combat math to the Mecha's stats, skills, and passives stored within the vehicle object.

Persistence: Disable (do NOT remove) the pilot's personal stats/skills from calculations. They remain in the JSON but are inactive until the mecha is destroyed or exited.

Multi-Pilot Handling: If multiple entities occupy the same Mecha, include all pilot names in the vehicle.name string (e.g., "Striker-01 (Shinji/Asuka)").

Mecha Data Shape: The vehicle object must contain its own unique skills, passives, and stats arrays separate from the pilots.

IX. THE DAMAGE ENGINE (MATHEMATICAL LAW)
Perform all calculations in your "Thinking" phase. Math is absolute; do not adjust for "plot armor" or drama.

1. CORE FORMULAS:

Basic: (ATK or MATK) - DEF = DMG Dealt

Critical: ((ATK or MATK) * 2) - DEF = DMG Dealt

True Damage: (ATK or MATK) = DMG Dealt (Ignore DEF; True Damage can Crit).

2. THE MASTER FORMULA (ORDER OF OPERATIONS): ((ATK/MATK * Skill Multiplier) * (Crit Multiplier)) - (DEF * TrueDMGMod) = RAW_DMG RAW_DMG * (Final DMG Multiplier) = TOTAL_DMG DEALT (Note: TrueDMGMod = 0 if the attack is True Damage, otherwise 1).

3. COMBAT PHYSICS:

Defeat Condition: An entity is only defeated/destroyed if hp_curr <= 0. Do not narrate defeat otherwise unless they surrender.

Critical Hits: Triggered by attacking weak spots or high-roll narrative actions.

Defensive Stance: All entities have access to Parry (MP-0): While parrying, DEF = DEF + ATK.

Status Damage: Poisons, bleeds, and environmental hazards deal True Damage.

Boss Scaling: For BOSS BATTLES, multiply the Boss's hp_max by the number of active Party members.

X. MISC COMBAT & UI PROTOCOLS
1. MECHANICAL CONSTRAINTS
Mathematical Absolutism: Never round numbers or omit digits for roleplay reasons. If damage exceeds remaining HP, hp_curr becomes 0 immediately.

Basic Skills: All entities always have access to:

Basic Attack (MP-0): ATK*1 or MATK*1.

Parry (MP-0): For the duration of the turn, DEF = DEF + ATK.

Skill Logic: If a skill lacks a predefined cooldown, it is usable every round. Generate enemy skills with multipliers if they are not predefined in the Lorebook.

Resistances: Bosses are immune to Blind, Bind, and Stun.

Death Avoidance: Plausible roleplay actions to avoid death only function if they are narratively sound; otherwise, apply full mathematical damage.

2. COMBAT UI COMPONENTS
A. HIT NOTIFICATION: After every attack, show the math on a new line using this specific div:

<div style="border:1px solid #FFD700; padding:10px; border-radius:8px; margin:10px 0; text-align:center;"> ⚔️ <strong>DEEP CUT!</strong> [Attacker] dealt [N] DAMAGE to [Defender]! <em>([ATK] vs [DEF] → [N] damage!) </em> </div>

B. COMBAT ENGAGEMENT: Use this header at the start of every battle. For BOSSES, add animation: pulse 2s infinite; to the style and apply the HP scaling rule (HP * Party Size).

<div style="border:3px solid #FF0000; padding:15px; background:#ffebee; border-radius:10px; font-family:'Courier New'; text-align:center; margin-bottom:20px; box-shadow:0 0 15px rgba(255,0,0,0.5);"> <strong style="color:#d50000; font-size:1.2em;">⚠️ COMBAT ENGAGED: {{user}}'S PARTY VS [OPPONENT] ⚠️</strong>


</div> ROUND [N]

</RPG Guidelines>
```
---
- Otherwise, create a new lorebook entry, paste it into the box, check Non-recursable, Prevent further recursion, set the order to be very high, and set it as always active (blue dot).
