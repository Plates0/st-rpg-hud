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
- If you're using this with Dankholme RPG, simply make a copy of the current RPG Toggle, disable it, then replace the copy with this guideline (there are two here, the first one is shorter, but if you have trouble with that, try the second. There's more variations in the thread on Discord.):

---
```
<RPG Guidelines>

I. STATE & JSON SCHEMA (MANDATORY)
At the very end of every response, you must output exactly one <rpg_state> block containing a valid JSON object.
CRITICAL: Do not use Markdown code blocks (```json). Just the raw tag and text.
UNKNOWN VALUES: Use "???" (string) for unknown numbers or hidden stats.
SCHEMA RULES:
- No nested objects
- "world_time" must be an object.
- "stats" values must be STRINGS if they contain equations, or INTEGERS if raw.
- No "player" root key. The root is the object itself.
- Meters (Dynamic Stats): Store shields, Sanity, Hunger, Arousal, etc., in the "meters" array.
  Format: {"name":"Shield","curr":30,"max":80} (Max is not capped at 100; add/remove as narrative dictates).

TEMPLATE:
<rpg_state>{"name":"{{user}}","hp_curr":0,"hp_max":0,"mp_curr":0,"mp_max":0,"meters":[],"stats":{"atk":0,"matk":0,"def":0,"satk":0,"sdef":0},"inventory":[],"skills":[],"passives":[],"masteries":[],"quests":[],"env_effects":[],"status_effects":[],"dankcoin":0,"location":"","world_time":{"month":"Jan","day":1,"clock":"10:00"},"combat":{"active":false,"round":1},"vehicle":null,"party":[],"enemies":[],"npcs":[]}</rpg_state>

II. VISIBILITY & PERSISTENCE
NPCs: Default to "???" stats unless they:
1. Enter combat.
2. Receive damage, healing, or buffs.
3. Are narratively revealed.
4. Join the Party.

Bond: Always display the "bond" stat in the list if active.

Persistence: Once revealed, stats are locked/persistent. Remove NPCs from the JSON if they are not present in the current scene. Does not apply to party members.

III. STRING FORMATTING (STRICT)
Constraint: Entries in inventory, skills, passives, masteries, quests, and env_effects MUST be single-line strings.
FORBIDDEN: Do NOT use nested objects inside these arrays (except "meters").

Format: "Name (Cost) Effect [Status]"
- Use [X] to denote equipped items.

Environmental Effects: Track active environmental pressures (sanity, hunger, weather, oxygen).
- Format: "Name - Effect Per Turn"
- Example: "Dungeon Corruption -4 Sanity/Hunger Per Turn" or "Sandstorm -10 HP Per Turn"

Examples (Inventory/Skills):
- "Heavy Strike (MP-20) ATK*1.5"
- "Iron Sword +10 ATK [X]"
- "Healing Whispers (MP-15) Heal target MATK*1, recovers 15 Sanity"

IV. MECHANICS & MATH
Definitions: M.HP = Max HP; M.MP = Max MP.
Progression: No Levels/EXP. Stats increase only via [X] gear or permanent buffs.
Authority: No auto-regen. HP/MP only change via explicit events, items, skills or passives that grant regeneration.

States:
- Critical Condition: If hp_curr < 25, add "Critical Condition" to status_effects.
- Purgatory/Death: If hp_curr <= 0, {{user}} is sent to  Purgatory. Status: "Dead"

Stat Calc: Scope hp_max, mp_max, and stats.
Format Logic: If a modifier exists, convert the value to a String: "TOTAL (Base+Mod+Buff)".
Base Logic: (Base = Total - Mod - Buff).

Example:
"atk": "210 (160+50+0)" (where 50 is from +50 ATK [X]).

V. COMBAT & OVERLAYS
Pacing: Exactly ONE ROUND per response (one action per combatant).
Engagement: If combat starts, set combat.active: true and increment round.

Vehicle (Ship/Mecha/Car/Transport):
- Set vehicle.active: true and vehicle.type.
- Focus: Disable (don't remove) pilot stats. Use Vehicle stats/skills only for calculations.
- Set vehicle.name to the name of the vehicle.

Map: Energy (EN) maps to mp_curr/max.

Damage Engine: ((ATK/MATK * SkillMult) * Crit) - (DEF * TrueDMGMod) = RAW_DMG.
- True DMG: TrueDMGMod = 0.
- Parry: Treat DEF as (DEF + ATK).
- Bosses: M.HP = Base * PartySize. Immune to Blind/Bind/Stun.
- Critical Hits: Guaranteed when hitting a Weak Spot.

VI. LIVING WEAPON OVERRIDE
Trigger: If {{user}} is a sentient weapon/item.

Display Logic (Swap):
1. The Main Block ("name", "hp", "mp") MUST represent the Wielder (the person holding {{user}}).
2. Puts Wielder's stats in the primary JSON keys.

Identity Logic:
1. Put {{user}} (the weapon) into the party[] array.
2. Weapon Stats: Set Weapon HP to 1/1 inside the party[] entry.
3. Weapon Skills: List Weapon-specific skills (Phantom Hit, etc.) inside the weapon's party[N].skills array.

Shared Skills: List skills granted to the wielder by the weapon inside the Main Block's (Wielder's) skills array.
Inventory: Add "Living Weapon ({{user}}) [X]" to the Wielder's inventory.

VII. UI COMPONENTS (HTML IN NARRATIVE)
Output these HTML blocks in the main response text (NOT inside the JSON) when relevant.

Hit Div:
<div style="border:1px solid #FFD700; padding:10px; border-radius:8px; margin:10px 0; text-align:center;">⚔️ <strong>DEEP CUT!</strong> [A] dealt [N] DMG to [B]! <em>([ATK] vs [DEF] → [N] DMG!)</em></div>

Combat Header:
<div style="border:3px solid #FF0000; padding:15px; background:#ffebee; border-radius:10px; text-align:center; margin-bottom:20px; box-shadow:0 0 15px rgba(255,0,0,0.5);"><strong style="color:#d50000; font-size:1.2em;">⚠️ COMBAT ENGAGED ⚠️</strong></div>

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
