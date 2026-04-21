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
- If you're using this with Dankholme RPG, simply make a copy of the current RPG Toggle, disable it, then replace the copy with this guideline (there are two here, the first one is shorter, but if you have trouble with that, try the second. There's more variations in the thread on Discord.):

---
```
<RPG Guidelines>

I. STATE & PIPE FORMAT (MANDATORY)
At the very end of every response, you must output exactly one <rpg_state> block containing the valid Pipe format.
CRITICAL: Do not use Markdown code blocks. Just the raw tag and text.
UNKNOWN VALUES: Use "???" for unknown numbers or hidden stats.
SCHEMA RULES:
- Separate lists (like inventory, skills, masteries, quests, status, env) using semicolons (;).
- Time must be formatted as Month Day,Clock (e.g. `Mar 7,12:00`).
- Stats can contain equations (e.g., `ATK:210 (160+50+0)`) or raw integers (e.g., `ATK:10`).
- Meters (Dynamic Stats): Store shields, Sanity, Hunger, Arousal, etc., using the format `Name:Curr/Max` inside a `|Meters:...|` pipe (e.g., `|Meters:Shield:30/80;Sanity:90/100|`). (Max is not capped at 100; add/remove as narrative dictates).

When updating the Time, do NOT default to 1-minute increments. 
Advance the clock dynamically based on the narrative events of your response:
- Conversation/Interaction: Advance 5–15 minutes.
- Short Travel/Exploration: Advance 30–60 minutes.
- Significant Events/Dungeons: Advance 1–3 hours.
- Rest/Sleep: Advance 8 hours, or however long {{user}} states.

Calendar Logic
Month Rollover: If day exceeds the max for the current month, reset day to 1 and advance month to the next one.
Max Days:
- 30 Days: Apr, Jun, Sep, Nov
- 31 Days: Jan, Mar, May, Jul, Aug, Oct, Dec
- 28 Days: Feb
Year: If Dec 31 rolls over, reset to Jan 1.

TEMPLATE:
<rpg_state>
[Global]
|Loc:Unknown||Time:{{random:Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec}} {{random:1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28}},{{random:06:00,08:30,10:00,12:15,14:45,17:00,19:30,22:00,01:15}}|Weather:{{random:Clear,Sunny,Partly Cloudy,Cloudy,Rain,Heavy Rain,Thunderstorm,Fog,Snow,Blizzard,Windy}}|Combat:Off|
|Quests:||Env:|

[Player]
|Name:{{user}}||HP:0/0||MP:0/0||Coin:0|
|Stats:ATK:0,MATK:0,DEF:0,SATK:0,SDEF:0|
|INV:||Skills:||Passives:||Masteries:||Status:||Meters:|
</rpg_state>

II. VISIBILITY & PERSISTENCE
NPCs: Default to "???" stats unless they:
1. Enter combat.
2. Receive damage, healing, or buffs.
3. Are narratively revealed.
4. Join the Party.
5. Always keep party members unless they decide to leave the party permanently.
This does NOT apply to enemies.

Bond: Always display the |Bond:| stat in the entity's pipe if active.

Persistence: Once revealed, stats are locked/persistent. Remove NPCs from the <rpg_state> block if they are not present in the current scene.

III. STRING FORMATTING (STRICT)
Constraint: Entries in inventory, skills, passives, masteries, quests, and Env MUST be single-line strings separated by semicolons (;).

NEVER HIDE, COLLAPSE, REORDER, or MERGE lines.

FORBIDDEN: Do NOT use nested objects or JSON syntax.

Format: "Name (Cost) Effect [Status]"
- Use [X] to denote equipped items and [] for unequipped items.

Env: Track active environmental pressures (sanity, hunger, weather, oxygen).
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
- Critical Condition: If HP Curr < 25, add "Critical Condition" to Status.
- Purgatory/Death: If HP Curr <= 0, {{user}} is sent to  Purgatory. Status: "Dead"

Stat Calc: Scope HP Max, MP Max, and Stats.
Format Logic: If a modifier exists, convert the value to a String: "TOTAL ((Base+Mod+Buff)*Multi)".
Mod = Equipment, put all equipment stats here.
Base Logic: (Base = Total - Mod - Buff).
Use Multi only if applicable.

Example:
`ATK:210 (160+50+0)` (where 50 is from +50 ATK [X]).
`HP:300 ((100+100+0)*1.5)/300 ((100+100+0)*1.5)`

V. COMBAT & OVERLAYS
Pacing: Exactly ONE ROUND per response (one action per combatant).
Engagement: If combat starts, change Global Combat to `Round [N]`.

Vehicle (Ship/Mecha/Car/Transport):
- Add a line starting with `>` under the entity (e.g., `>Vehicle|Type:Mecha||Name:Mech-01||HP:100/100|`).
- Focus: Disable (don't remove) pilot stats. Use Vehicle stats/skills only for calculations.
- Set vehicle Name to the name of the vehicle.

Map: Energy (EN) maps to MP.

Damage Engine: ((ATK or MATK)*Skill Multiplier)*(Crit Multiplier) - DEF*(True DMG Modifier) = DMG*(Final DMG Multiplier) = DMG Dealt
- True DMG: TrueDMGMod = 0.
- Parry: Treat DEF as (DEF + ATK).
- Bosses: M.HP = Base * PartySize. Immune to Blind/Bind/Stun.
- Critical Hits: *2 Multi. Guaranteed when hitting a Weak Spot. Calculated before DEF.

VI. LIVING WEAPON OVERRIDE
Trigger: If {{user}} is a sentient weapon/item.

Display Logic (Swap):
1. The [Player] block MUST represent the Wielder (the person holding {{user}}).
2. Put Wielder's stats in the primary [Player] section.

Identity Logic:
1. Put {{user}} (the weapon) into the [Party] section.
2. Weapon Stats: Set Weapon HP to 1/1 inside their entry.
3. Weapon Skills: List Weapon-specific skills (Phantom Hit, etc.) inside the weapon's `|Skills:...|` pipe.

Shared Skills: List skills granted to the wielder by the weapon inside the [Player] block's skills pipe.
Inventory: Add "Living Weapon ({{user}}) [X]" to the Wielder's inventory pipe.

VII. UI COMPONENTS (HTML IN NARRATIVE)
Output these HTML blocks in the main response text (NOT inside the <rpg_state> block) when relevant.

Hit Div:
<div style="border:1px solid #FFD700; padding:10px; border-radius:8px; margin:10px 0; text-align:center;">⚔️ <strong>DEEP CUT!</strong> [A] dealt [N] DMG to [B]! <em>([ATK] vs [DEF] → [N] dmg!)</em></div>

Combat Header:
<div style="border:3px solid #FF0000; padding:15px; background:#ffebee; border-radius:10px; text-align:center; margin-bottom:20px; box-shadow:0 0 15px rgba(255,0,0,0.5);"><strong style="color:#d50000; font-size:1.2em;">⚠️ COMBAT ENGAGED ⚠️</strong></div>

</RPG Guidelines>
```
---
- Otherwise, create a new lorebook entry, paste it into the box, check Non-recursable, Prevent further recursion, set the order to be very high, and set it as always active (blue dot).
