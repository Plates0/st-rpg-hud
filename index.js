// =====================================================================
// RPG HUD — FORMAT REFERENCE
// Last schema change: 2026-08-22 (vehicles, bonds, timers, year)
//
// This describes what the PARSER ACCEPTS. The AI guideline describes the
// narrower subset the model is told to WRITE. When they disagree, this wins.
// ---------------------------------------------------------------------
//
// BLOCK DISCOVERY
//   <rpg_state> ... </rpg_state>   case-insensitive, attributes allowed.
//   Only non-user messages are scanned; the NEWEST match wins and its index
//   is cached in lastRpgMsgIndex. Markdown code fences are stripped first.
//   State lives ONLY in the block. localStorage holds UI prefs, nothing else.
//
// LINE TYPES
//   [Header]  Section switch. FUZZY: contains "player"/"party"/"enem"/"npc";
//             anything else falls back to Global.
//   >...      Targets the CURRENT entity's .vehicle (auto-creates it and sets
//             active=true). Text between ">" and the first "|" is decorative,
//             so ">Vehicle|..." and ">|..." are identical. A vehicle may be
//             written as ONE long line or split across several ">" lines —
//             every ">" line retargets the same vehicle object.
//   |...|     Data for the current entity.
//   Blank lines are skipped. Every line first passes sanitizeBrokenPipeLine(),
//   which rewrites stray in-text "|" to the lookalike "｜".
//
// PIPE GRAMMAR      /\|([^|:]+):\s*([^|]*?)(?=\||$)/g
//   Fields are separated by "||"; the line opens and closes with "|".
//   KEY   : no "|" and no ":". Trimmed + lowercased on read.
//   VALUE : anything up to the next "|". MAY contain ":" "/" "," "(" ")".
//   Key ABSENT  -> field left unchanged.
//   Key PRESENT but empty ("|INV:|") -> field CLEARED.
//   A literal "|" inside a value will corrupt the line. Use safePipeText().
//
// GLOBAL KEYS   (read into newState regardless of which line they appear on)
//   Loc      free text
//   Time     "Month Day[ Year],HH:MM"   year optional; if omitted it is
//            CARRIED FORWARD from the previous parse rather than cleared.
//   Weather  free text (drives getWeatherEmoji)
//   Combat   contains "off" -> inactive; otherwise digits -> round number
//   Quests   ";"-separated list
//   Env      ";"-separated list
//   Bonds    permanent ledger, see below
//   Timers   cooldowns/durations/doom clocks, see below
//
// ENTITY KEYS
//   Name      In [Party]/[Enemies]/[NPCs] a NON-">" line with Name: STARTS a
//             new entity; later lines attach to it. In [Player] it renames the
//             player. On a ">" line it names the vehicle.
//   HP        "curr/max". Kept as STRINGS so "300 ((100+100)*1.5)" survives.
//             "???" -> both sides "???". Numbers >= 999999999 render as ∞.
//   MP / EN   Same shape. ship+car prefer en_*, everything else mp_*; the
//             parser MIRRORS both onto vehicles so either key works.
//             CAVEAT: target.type is read BEFORE data.type is applied, so on a
//             single-line vehicle the type is still the default when energy is
//             classified — harmless only because of the mirroring.
//   Coin      integer -> .dankcoin
//   Bond      integer; "∞" -> 101. Party/NPC only.
//             FAILSAFE: a "Bond:n" entry hiding inside Status is extracted
//             into .bond and removed from the status list.
//   Stats     "ATK:1,MATK:2,DEF:3,SATK:4,SDEF:5" — comma-separated, arbitrary
//             keys accepted, values may carry math: "210 (160+50+0)".
//   Meters    "Name:curr/max;Name:curr/max" — arbitrary count, max uncapped.
//   INV / Skills / Passives / Masteries / Status   ";"-separated lists.
//   Type      vehicle only: mecha | ship | car | transport
//
// BONDS LEDGER      |Bonds:Name:Value;Name:Value|
//   Append-only roster that outlives a character leaving the scene.
//   Name/value split on the LAST ":" so names may contain colons.
//   Keyed by BASE NAME: bondBaseName() strips "(...)", "[...]", and any
//   " - suffix", so "Alice (Battle Form)" == "Alice". Stored under the base.
//   Value "∞" -> 101. Negative values allowed.
//   MERGE ORDER on every parse: previous memory -> block -> live party/NPC
//   |Bond:| values (live wins). A name the model drops is RESTORED from memory.
//   DELTAS: bondBaseline snapshots the ledger as of the PREVIOUS message and
//   is frozen per lastRpgMsgIndex, so the observer's repeat scans of the same
//   message don't erase the ▲/▼. .prev is display-only and never written back.
//   purgeBondsFromHistory() and purgeTimersFromHistory() are the only code that
//   edits old messages: they
//   surgically rewrites just the |Bonds:| pipe in every message AND in
//   msg.swipes[]. It never touches anything else.
//
// TIMERS            |Timers:[Owner/]Name:Value[:KIND];...|
//   Name = before the FIRST ":". KIND = after the LAST ":" if it is one of
//   CD/BUFF/DEBUFF/EVENT/DOOM, else the whole remainder is the value and KIND
//   defaults to CD. That split is what lets a clock time live in the value.
//   VALUE is either:
//     "2/3"              turns remaining/total (drives the progress bar)
//     "47"               bare turn count, no bar
//     "Jan 6[ 1023],14:00"  world-time deadline (year inherited if omitted)
//     "14:00"            next occurrence of that clock time
//   AUTO-REPAIR: if combat.round increased AND a turn value is byte-identical
//   to last parse, the HUD decrements it and flags .repaired (shown as "*").
//   If the model DID update it, the HUD leaves it alone — no double-ticking.
//   KINDS: CD (cooldown) · BUFF · DEBUFF · EVENT (appointment/scheduled thing,
//   neutral, 📅) · DOOM (threat, ☠️). EVENT exists so a dentist appointment
//   doesn't get filed as a doom clock.
//   Timers the model drops are NOT restored — EXCEPT unfired EVENT/DOOM, which
//   are carried forward and marked "°", because a date three days out will go
//   unmentioned for many turns. Fired ones are released. Editor delete still
//   works (it removes from rpgState before the next merge sees it), and offers
//   to scrub the timer from |Timers:| in every earlier message + swipes, the
//   same way bond deletion does. The carry-over source is timerMemory (the
//   newest block BEFORE this message), NOT the last parse, so a swipe you
//   abandon can't leak its EVENTs into the branch you keep.
//
// PARSE PIPELINE (order matters)
//   1. fresh deep clone of defaultState
//   2. line-by-line pipe parse
//   3. bonds  = mergeBondLedger(previous, block) then live bonds overwrite
//   4. timers = mergeTimers(previous, block)  [auto-repair happens here]
//   5. world_time.year carried forward if the block omitted it
//   6. maybeReportListChanges() diffs INV/Skills/Passives/Masteries vs the
//      previous parse and toasts only SHRINKAGE (a dropped description).
//      Equip-tag-only changes are ignored; adds/removes go to console.
//
// WRITE-BACK
//   buildPipeString() rebuilds the ENTIRE block from current state and regex-
//   replaces it in chat[lastRpgMsgIndex], then saveChat().
//   Callers: saveEditor · manual ↻ scan · remove/clear character · remind ·
//            bond commit · timer commit · ⏭ advance turn.
//   The automatic observer scan NEVER writes.
//   *** NEVER run buildPipeString over an OLD message — it would stamp today's
//       state onto that message's history. Edit old messages surgically only.
//   LOSSY BY DESIGN: anything the parser doesn't read is dropped on rewrite,
//   and a vehicle is only emitted while active — unchecking Active DELETES it.
//   KNOWN GAP: resetRPG() does not write back, so a reset reverts on the next
//   scan. Left as-is intentionally; most users start a new chat instead.
//
// OBSERVER
//   MutationObserver on #chat, 1200ms debounce -> checkMessage(false).
//   Skipped entirely while bondsEditMode || timersEditMode is true so inline
//   inputs aren't wiped mid-typing.
//
// INDICATOR DOT
//   green = latest block parses · yellow = pipe/colon error (tap for caret
//   panel) · red = latest message is the user's · grey = no <rpg_state>.
//
// ADDING A NEW FIELD — touch all five:
//   1. defaultState                      2. parsePipeFormat  (read the key)
//   3. buildPipeString / buildEntity     (write the key)
//   4. the editor (render + saveEditor)  5. the AI guideline
//   Forget #3 and it silently vanishes on the next write-back. That was the
//   original vehicle bug.
// =====================================================================

console.log("RPG HUD: index.js loaded ✅", new Date().toISOString());
window.__rpgHudLoaded = true;

// =====================================================
// RPG HUD Extension for SillyTavern
// - Pipe Format Parser
// - NO prompt injection
// - NO caching/localStorage snapshots
// - Editor SAVE rewrites the actual <rpg_state> block
// - XSS-hardened rendering
// =====================================================

// --- 0. XSS SAFETY HELPERS ---
function getWeatherEmoji(weather) {
  const w = String(weather || "").toLowerCase();

  if (w.includes("blizzard") || w.includes("snow") || w.includes("sleet") || w.includes("hail")) return "❄️";
  if (w.includes("thunder") || w.includes("storm") || w.includes("lightning")) return "⛈️";
  if (w.includes("rain") || w.includes("drizzle") || w.includes("shower") || w.includes("rainy")) return "🌧️";
  if (w.includes("fog") || w.includes("mist") || w.includes("foggy")) return "🌫️";
  if (w.includes("cloud") || w.includes("overcast") || w.includes("cloudy")) return "⛅️";
  if (w.includes("sun") || w.includes("clear") || w.includes("sunny")) return "☀️";
  if (w.includes("wind") || w.includes("windy")) return "💨";

  return "🌤️";
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escAttr(s) {
  return escHtml(s).replace(/\r/g, "").replace(/\n/g, "&#10;");
}
function escTextarea(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// "400 (350+50)" -> { val: "400", math: "350+50" }, the same split
// renderInlineValue makes for the Status panel's dropdowns
function splitMathValue(raw) {
  if (typeof raw === "string" && raw.includes("(")) {
    const parts = raw.match(/^(.+?)\s*\((.*)\)$/);
    if (parts) return { val: parts[1].trim(), math: parts[2].trim() };
  }
  return { val: raw, math: null };
}

// A number beside a bar. Plain values print as they are. One with a breakdown
// shows just its value plus the same small arrow the Status panel uses, and
// is the one thing in that row you can tap: it pops the breakdown up. (A real
// dropdown can't open there: the bar stack clips anything that spills out.)
function barNum(raw) {
  const { val, math } = splitMathValue(raw);
  if (!math) return escHtml(val);
  return `<span class="rpg-mathnum" data-val="${escAttr(val)}" data-math="${escAttr(math)}"` +
    ` title="${escAttr(val)} = ${escAttr(math)}">${escHtml(val)}<i>\u25BE</i></span>`;
}

// The number a bar should use: the value in front of any "(breakdown)".
// Stripping every non-digit instead turned "400 (350+50)" into 40035050,
// which drew every bar with an equation in its max as empty.
function barValue(raw) {
  const { val } = splitMathValue(typeof raw === "string" ? raw : String(raw ?? ""));
  return parseFloat(String(val ?? "").replace(/[^\d.\-]/g, ""));
}

function barPair(curr, max) {
  if (curr === undefined || curr === null || curr === "") return "\u2013";
  return `${barNum(curr)}/${barNum(max)}`;
}

let mathPopEl = null, mathPopTimer = null;
(() => {
  const st = document.createElement("style");
  st.textContent = `.rpg-mathpop{position:fixed; z-index:2147483000; max-width:240px; padding:6px 9px;
    font:12px/1.35 system-ui, sans-serif; color:#e6e3da; background:rgba(12,14,18,.92);
    border:1px solid rgba(255,255,255,.18); border-radius:5px; box-shadow:0 4px 14px rgba(0,0,0,.45);
    pointer-events:auto; white-space:normal}
  .rpg-mathpop b{color:#fff}`;
  document.head.appendChild(st);
})();
function hideMathPop() {
  if (mathPopEl) { mathPopEl.remove(); mathPopEl = null; }
  clearTimeout(mathPopTimer);
}
function showMathPop(anchor) {
  const again = mathPopEl && mathPopEl.dataset.for === anchor.dataset.math + anchor.dataset.val;
  hideMathPop();
  if (again) return;                                   // a second tap closes it
  const pop = document.createElement("div");
  pop.className = "rpg-mathpop";
  pop.dataset.for = anchor.dataset.math + anchor.dataset.val;
  pop.innerHTML = `<b>${escHtml(anchor.dataset.val)}</b> = ${escHtml(anchor.dataset.math)}`;
  // On the page itself, not inside the HUD: the HUD redraws often and its bar
  // stack clips overflow. Fixed, so it sits by the number wherever that is.
  document.body.appendChild(pop);
  const q = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  const left = Math.max(6, Math.min(q.left + q.width / 2 - w / 2, window.innerWidth - w - 6));
  const top = q.bottom + 6 + h > window.innerHeight - 6 ? q.top - h - 6 : q.bottom + 6;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  mathPopEl = pop;
  mathPopTimer = setTimeout(hideMathPop, 6000);
}
// any tap elsewhere closes it
document.addEventListener("pointerdown", (e) => {
  if (mathPopEl && !e.target.closest?.(".rpg-mathnum, .rpg-mathpop")) hideMathPop();
}, true);

function renderInlineValue(rawValue) {
  let val = rawValue;
  let math = null;

  if (typeof rawValue === "string" && rawValue.includes("(")) {
    const parts = rawValue.match(/^(.+?)\s*\((.*)\)$/);
    if (parts) {
      val = parts[1];
      math = parts[2];
    }
  }

  const safeVal = escHtml(val);

  if (!math) return `<span>${safeVal}</span>`;

  const safeMath = escHtml(math);
  return `
    <span style="position:relative; display:inline-block;">
      <details style="display:inline; cursor:pointer;">
        <summary style="display:inline; list-style:none; outline:none; font-weight:bold; user-select:none;">
          ${safeVal} <span style="font-size:0.75em; opacity:0.7;">▼</span>
        </summary>
        <span style="position:absolute; right:0; top:1.3em; min-width:160px; max-width:240px;
                     font-size:0.75em; color:#bbb; background:rgba(0,0,0,0.85); padding:6px;
                     border-radius:4px; border:1px solid #333; z-index:999999; white-space:normal;">
          ${safeMath}
        </span>
      </details>
    </span>
  `;
}

// --- 1. STATE & DATA ---
const defaultState = {
  name: "{{user}}",

  hp_curr: 0,
  hp_max: 100,
  mp_curr: 0,
  mp_max: 100,

  meters: [],

  stats: {
    atk: 0,
    matk: 0,
    def: 0,
    satk: 0,
    sdef: 0,
  },

  inventory: ["???"],
  skills: ["???"],
  passives: ["???"],
  masteries: [],
  quests: [],
  env_effects: [],
  status_effects: [],

  dankcoin: 0,

  location: "Unknown",
  world_time: { month: "Jan", day: 1, year: "2055", clock: "12:00", weather: "Unknown" },

  combat: { active: false, round: 1 },

  vehicle: {
    active: false,
    type: "mecha",
    name: "Mech-01",
    hp_curr: 1000,
    hp_max: 1000,
    mp_curr: 100,
    mp_max: 100,
    meters: [],
    stats: { atk: 0, matk: 0, def: 0, satk: 0, sdef: 0 },
    inventory: ["Vulcan Cannon"],
    skills: [],
    passives: [],
    status_effects: [],
    dankcoin: 0,
  },

  party: [],
  enemies: [],
  npcs: [],
  bonds: [],
  timers: [],
};

let rpgState = JSON.parse(JSON.stringify(defaultState));
let activeTab = "inventory";
let bondsEditMode = false;
let timersEditMode = false;
let bondsSnapshot = [];
let timersSnapshot = [];
// The ledger as it stood in the messages BEFORE the one being parsed. Read from
// chat history, not from the last parse, so an abandoned swipe leaves no trace.
// Doubles as the baseline for the ▲/▼ deltas.
// Names the user deleted. Without this, deleting a bond just means the next
// scan re-adds it from the character's live |Bond:| value a second later.
const BOND_BLOCK_KEY = "rpg_hud_bond_block_v1";
let bondBlocklist = new Set();
let bondBlockChatKey = "";

function loadBondBlocklist(chatKey) {
  bondBlockChatKey = String(chatKey ?? "");
  try {
    const all = JSON.parse(localStorage.getItem(BOND_BLOCK_KEY) || "{}");
    const list = all[bondBlockChatKey];
    bondBlocklist = new Set(Array.isArray(list) ? list : []);
  } catch { bondBlocklist = new Set(); }
}

function saveBondBlocklist() {
  try {
    const all = JSON.parse(localStorage.getItem(BOND_BLOCK_KEY) || "{}");
    if (bondBlocklist.size) all[bondBlockChatKey] = [...bondBlocklist];
    else delete all[bondBlockChatKey];
    localStorage.setItem(BOND_BLOCK_KEY, JSON.stringify(all));
  } catch (e) { console.warn("RPG HUD: couldn't save bond blocklist", e); }
}

function blockBonds(names) {
  (names || []).forEach((n) => { const k = normBondName(n); if (k) bondBlocklist.add(k); });
  saveBondBlocklist();
}

function clearBondBlocklist() {
  bondBlocklist = new Set();
  saveBondBlocklist();
}

let bondMemory = [];
let timerMemory = [];
let historyMemoryKey = null;
let isMinimized = false;
let fogDockOpen = false;     // Gray Fog: the centred menu button's buttons are fanned out
let fogDockAnim = false;     // play the fan-out once, on the render right after a toggle
let fogDockOpenedAt = 0;     // keeps the star's slow spin continuous across re-renders
let scanTimer = null;
let charIndex = 0;
let tabStripScrollLeft = 0; 
let isSettingsOpen = false;
let lastRpgMsgIndex = -1;
let isErrorOpen = false;

let lastIndicatorStatus = null;
let hudToastArmed = false;
let autoInjectState = false;
let lastPipeError = {
  line: null,
  char: null,
  message: "",
  snippet: "",
};

// --- UI SETTINGS (font + scale) ---
const UI_SETTINGS_KEY = "rpgHud:uiSettings";
// Bump on every release. Shown at the foot of the SAO settings menu and in the
// console, so it's obvious when the browser is still serving a cached copy.
const HUD_BUILD = "2026-10-26.30";
console.log(`RPG HUD build ${HUD_BUILD}`);

const defaultUiSettings = {
  skin: "classic",
  autoAddBonds: true,     // add party/NPC |Bond:| values to the ledger automatically
  saoPanelLight: 92,      // panel lightness %, lower = dimmer but still solid
  saoCardAlpha: 11,       // % wash behind the player's HP/MP bars; higher = lighter
  saoFont: "preset",      // "preset" | "sans" | "squarish" | "saira" | "teko" | "exo" | "custom"
  saoCustomFont: "",      // with "custom": any Google Fonts family name
  saoBarStyle: "sao",     // "sao" stepped bars | "alo" arrow-ended ALfheim bars
  saoInk: 70,             // text contrast against the panel, 0 = faint, 100 = maximum
  saoAnimate: true,       // bar tweening, orb unfold, panel and clock fades
  saoPos: null,           // {vitals:[x,y], col:[x,y], clock:[x,y]} drag offsets
  saoSnap: true,          // snap a dragged piece to the others' edges and centres
  meterColors: {},        // meter name (lowercase) -> "#rrggbb", overrides the auto colour
  tileColors: {},         // ALfheim (New) tile colours you've picked: "@player" or a name key -> "#rrggbb"
  oocEditNotes: true,     // Edit state -> Save leaves an (OOC: ...) note in the block listing what you changed
  restoreLostDesc: false, // put back a description the AI dropped entirely (keeps its other changes)
  fixWeekdays: true,      // a weekday written in Time: that doesn't match the date gets corrected
  addWeekdays: true,      // a reply's Time: with no weekday gets one added (when the date can be placed)
  clockFormat: "asis",    // how times are shown: "asis" (as the story writes them) | "12" | "24"
  listEditHistory: 0,     // list edits from the Status orb also rewrite this many earlier replies (0-20)
  saoUiScale: 100,        // % size of the bar cluster; a desktop usually wants ~130
  saoTextShadow: false,   // shadow behind the text that sits straight on the chat
  saoTextBacking: false,  // translucent card behind that text instead        // "classic" | "sao"
  barsOnMin: true,        // sao skin: keep the bars visible when minimised
  sysBigSlot: "name",     // system skin: the big slot shows "name" or an analog "clock"
  sysNotices: true,       // system skin: "You have acquired..." popups when a reply adds things
  sysFont: "exo",         // system skin font: a SAO_FONTS key, or "preset" for the classic preset
  fogNumber: "auto",      // Gray Fog's tarot number: "auto" (Sequence, else the day) | "day" | "sequence" | "none"
  fogFold: true,          // Gray Fog: fold the panel into the round button and back
  fogFoldSpeed: "normal", // "slow" | "normal" | "fast" | "instant"
  fontPreset: "retro_mono",
  fontFamily: "'Courier New', Courier, monospace",
  fontScale: 1.0,
  hudWidth: 280,
  hudHeight: 0,
  changeAlerts: true,
  toastSeconds: 8,        // how long the HUD's toasts stay up; 0 = until tapped
  ignoreCountChanges: true, // Change Alerts skip a description where only amounts changed ("4 hours" -> "3.5 hours")
};

let uiSettings = (() => {
  try {
    const raw = localStorage.getItem(UI_SETTINGS_KEY);
    if (!raw) return { ...defaultUiSettings };
    const obj = JSON.parse(raw);
    return { ...defaultUiSettings, ...(obj || {}) };
  } catch {
    return { ...defaultUiSettings };
  }
})();

// Puts every HUD setting back to its default. The skin choice is kept, since
// being thrown into the other skin is rarely what "reset" is meant to do, and
// chat data (bond blocklist, state) is untouched.
function resetUiSettings(e) {
  if (e) e.stopPropagation();
  const ok = confirm(
    "Reset all HUD settings to their defaults?\n\n" +
    "Fonts, sizes, colours and toggles all go back to how they started.\n" +
    "Your current skin and your chat data are kept."
  );
  if (!ok) return;

  const skin = uiSettings.skin;
  uiSettings = { ...defaultUiSettings, skin };
  saveUiSettings();

  isSettingsOpen = false;
  saoHelpOpen = false;
  const c = document.getElementById("rpg-hud-container");
  if (c) { c.style.cssText = ""; c.className = ""; }

  renderRPG();
  if (window.toastr) hudToast.info("HUD settings reset to defaults.");
}

function saveUiSettings() {
  try {
    localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(uiSettings));
  } catch {}
}

function fontPresetToFamily(preset) {
  switch (preset) {
    case "retro_mono":
      return "'Courier New', Courier, monospace";
    case "modern_mono":
      return "Consolas, 'Lucida Console', Monaco, monospace";
    case "ui_sans":
      return "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
    case "big_sans":
      return "Verdana, Arial, sans-serif";
    case "story_serif":
      return "Georgia, 'Palatino Linotype', Palatino, serif";
    default:
      return "'Courier New', Courier, monospace";
  }
}

function applyHudTypography(container) {
  if (!container) return;
  const scale = Math.max(0.85, Math.min(1.15, Number(uiSettings.fontScale) || 1.0));
  uiSettings.fontScale = scale;

  if (uiSettings.fontPreset) {
    uiSettings.fontFamily = fontPresetToFamily(uiSettings.fontPreset);
  }

  container.style.fontFamily = isSysSkin() ? sysFontStack() : uiSettings.fontFamily;
  container.style.fontSize = `${0.9 * scale}em`;
}

// --- 2. HELPERS ---
// --- CHANGE ALERTS ---
let lastListSnapshot = null;
let lastChatKey = null;

const WATCHED_LISTS = [
  { key: "inventory", label: "Item" },
  { key: "skills", label: "Skill" },
  { key: "passives", label: "Passive" },
  { key: "masteries", label: "Mastery" },
];

function entryBaseName(s) {
  return String(s ?? "").replace(/[\(\[\{].*$/, " ").replace(/\s+/g, " ").trim();
}

function stripStatusTags(s) {
  return String(s ?? "").replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
}

function listToMap(list) {
  const m = new Map();
  (Array.isArray(list) ? list : []).forEach((i) => {
    const text = String(typeof i === "object" ? (i?.name ?? "") : (i ?? "")).trim();
    // keyed by the part before any description, so rewording "Lucky Coin, a
    // bent copper piece" reads as a change, not a removal plus an addition
    const key = entryBaseName(descSplit(text).head).toLowerCase();
    if (!key || m.has(key)) return;
    m.set(key, text);
  });
  return m;
}

function snapshotLists(ent) {
  const snap = {};
  WATCHED_LISTS.forEach(({ key }) => { snap[key] = listToMap(ent?.[key]); });
  return snap;
}

function diffLists(prev, next) {
  const out = [];
  WATCHED_LISTS.forEach(({ key, label }) => {
    const a = prev?.[key] || new Map();
    const b = next?.[key] || new Map();

    b.forEach((text, k) => {
      if (!a.has(k)) { out.push({ type: "added", label, name: text }); return; }
      const before = a.get(k);
      if (before === text) return;
      // equipping/unequipping only -> not a real change
      if (stripStatusTags(before) === stripStatusTags(text)) return;

      const shrank = text.length < before.length - 2;
      out.push({ type: shrank ? "lost" : "changed", label, name: text, before });
    });

    a.forEach((text, k) => {
      if (!b.has(k)) out.push({ type: "removed", label, name: text });
    });
  });
  return reconcileTruncations(out);
}

// An entry whose stats live in the NAME ("Iron Sword +10 ATK") changes its key
// when truncated, so it lands as removed+added instead of shortened. Pair those
// back up: if a removed entry starts with an added one, it was truncated.
function reconcileTruncations(out) {
  const consumed = new Set();
  out.filter((d) => d.type === "added").forEach((a) => {
    const an = stripStatusTags(a.name).toLowerCase();
    if (an.length < 3) return;
    const hit = out.find((r) => {
      if (r.type !== "removed" || consumed.has(r) || r.label !== a.label) return false;
      const rn = stripStatusTags(r.name).toLowerCase();
      return rn !== an && rn.startsWith(an);
    });
    if (hit) {
      consumed.add(hit);
      a.type = "lost";
      a.before = hit.name;
    }
  });
  return out.filter((d) => !consumed.has(d));
}

function currentChatKey(context) {
  return [context?.chatId, context?.characterId, context?.groupId].map((v) => String(v ?? "")).join("|");
}

// ---- word-level diff, so a change can be shown instead of hunted for ----
function wordDiff(a, b) {
  // Words are compared without trailing punctuation, so "ATK*1.4." and
  // "ATK*1.4" match when a sentence simply carries on. Shown as written.
  const tok = (t) => String(t ?? "").split(/\s+/).filter(Boolean)
    .map((w) => ({ w, k: w.replace(/[.,;:!?]+$/, "").toLowerCase() || w }));
  const A = tok(a), B = tok(b);
  if (A.length * B.length > 160000) return null;          // absurdly long: don't try
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i][j] = A[i].k === B[j].k ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i].k === B[j].k) { ops.push({ op: "=", w: B[j].w, k: B[j].k }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { ops.push({ op: "-", w: A[i].w, k: A[i].k }); i++; }
    else { ops.push({ op: "+", w: B[j].w, k: B[j].k }); j++; }
  }
  while (i < n) { ops.push({ op: "-", w: A[i].w, k: A[i].k }); i++; }
  while (j < m) { ops.push({ op: "+", w: B[j].w, k: B[j].k }); j++; }
  return ops;
}

// Only the changed stretches, with a few words either side for context.
// `style` is "toast" (inline styles, dark-on-blue) or "log" (classes).
function wordDiffHtml(a, b, style) {
  const ops = wordDiff(a, b);
  if (!ops) return `${escHtml(b)}`;
  const del = style === "toast"
    ? (w) => `<span style="text-decoration:line-through; color:#ffd6cf; background:rgba(0,0,0,.18); padding:0 2px; border-radius:2px;">${escHtml(w)}</span>`
    : (w) => `<del class="rpg-wd-del">${escHtml(w)}</del>`;
  const ins = style === "toast"
    ? (w) => `<b style="color:#e4ffd9; background:rgba(255,255,255,.14); padding:0 2px; border-radius:2px;">${escHtml(w)}</b>`
    : (w) => `<ins class="rpg-wd-ins">${escHtml(w)}</ins>`;

  const CTX = 3;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.op === "=") return;
    for (let x = Math.max(0, k - CTX); x <= Math.min(ops.length - 1, k + CTX); x++) keep[x] = true;
  });
  const parts = [];
  let gap = false;
  ops.forEach((o, k) => {
    if (!keep[k]) { gap = true; return; }
    if (gap || (k > 0 && parts.length === 0)) parts.push("\u2026");
    gap = false;
    parts.push(o.op === "=" ? escHtml(o.w) : o.op === "-" ? del(o.w) : ins(o.w));
  });
  if (!keep[ops.length - 1]) parts.push("\u2026");
  return parts.join(" ");
}

// Is this a loss worth interrupting you for? A description losing a chunk,
// or losing a number (a stat, a cost, a count), yes. A reworded phrase, no.
function isMeaningfulLoss(before, after) {
  const ops = wordDiff(before, after);
  if (!ops) return String(after).length < String(before).length * 0.85;
  const removed = ops.filter((o) => o.op === "-").map((o) => o.k);
  const added = ops.filter((o) => o.op === "+").map((o) => o.k);
  const lostChars = removed.join(" ").length - added.join(" ").length;
  const numbersLost = removed.filter((w) => /\d/.test(w)).some((w) => !added.includes(w));
  return numbersLost || lostChars >= 24 || lostChars >= String(before).length * 0.15;
}

// Compares the latest block with the block from the turn before it, not with
// whatever the last scan happened to see. Scans repeat constantly, and a
// swipe, a deletion or a reload would otherwise be read as the model editing
// descriptions. Fires at most once per message version.
let alertKey = null;
let alertSig = "";
let alertIdx = -1;

// ---- restoring descriptions the AI dropped entirely ----
// An entry is "Name (Cost) Effect, description [Status]". When a new reply
// keeps an item but its entry has no description left at all, the old
// description is put back onto the NEW head, so real changes (+10 -> +15 ATK,
// a new cost) stay. A description that's only trimmed or reworded is left to
// the alert. Masteries aren't touched: their text is a progress counter.
// Split "Name (Cost) Effect, description" at the first separator that isn't
// inside brackets: a comma, full stop, semicolon or dash followed by a space.
function descSplit(text) {
  const core = stripStatusTags(text).replace(/\s+([,.;])/g, "$1");
  let depth = 0;
  for (let i = 0; i < core.length; i++) {
    const c = core[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if ((c === ")" || c === "]" || c === "}") && depth > 0) depth--;
    else if (depth === 0) {
      if ((c === "," || c === "." || c === ";") && core[i + 1] === " ") return { head: core.slice(0, i).trim(), tail: core.slice(i) };
      if ((c === "\u2014" || c === "\u2013" || c === "-") && core[i - 1] === " " && core[i + 1] === " ") return { head: core.slice(0, i).trim(), tail: core.slice(i - 1) };
    }
  }
  return { head: core.trim(), tail: "" };
}

// Only when the new entry has no description at all and the old one did:
// the new head (name, cost, effect, tags) is kept, the old description added.
function restoredEntry(oldText, newText) {
  const o = descSplit(oldText), n = descSplit(newText);
  if (n.tail) return null;                                      // still has a description of its own
  if (o.tail.replace(/^[\s,.;\u2013\u2014-]+/, "").length < 8) return null;  // nothing worth restoring
  const tags = (String(newText).match(/\[[^\]]*\]/g) || []).join(" ");
  const head = n.head.replace(/[\s.,;:]+$/, "");
  return head + o.tail + (tags ? " " + tags : "");
}

// Everyone whose items, skills and passives are watched: the player first,
// then party, NPCs and enemies, each with an id that's stable between turns.
function listOwners(state) {
  const out = [{ id: "@player", name: "", who: null, ent: state }];
  ["party", "npcs", "enemies"].forEach((group) => (state?.[group] || []).forEach((u) => {
    const key = normBondName(u?.name);
    if (key) out.push({ id: `${group}:${key}`, name: displayName(u.name, "?"), who: { group, key }, ent: u });
  }));
  return out;
}

function findDescriptionRestores(prev, next) {
  const out = [];
  const prevOwners = new Map(listOwners(prev).map((o) => [o.id, o]));
  listOwners(next).forEach((owner) => {
    const was = prevOwners.get(owner.id);
    if (!was) return;                                   // new to the scene: nothing to compare
    WATCHED_LISTS.filter((w) => w.key !== "masteries").forEach(({ key, label }) => {
      const prevItems = (was.ent?.[key] || []).map((x) => String(x).trim()).filter(Boolean);
      const used = new Set();
      (owner.ent?.[key] || []).forEach((x) => {
        const t = String(x).trim();
        // same-name variants: pair with the closest earlier one, each only once
        const pi = bestEntryIndex(prevItems, tItemKey(t), t, used);
        if (pi >= 0) used.add(pi);
        const old = pi >= 0 ? prevItems[pi] : undefined;
        if (!old || old === t) return;
        const fixed = restoredEntry(old, t);
        if (fixed && fixed !== t) out.push({ key, label, from: t, to: fixed, who: owner.who, owner: owner.name });
      });
    });
  });
  return out;
}

// Replace exactly those entries, each only on its own character's lines,
// leaving every other byte the AI wrote as it was. Lines are walked in order,
// tracking the section ([Player], [Party], [NPCs], [Enemies]) and the current
// |Name:|, so two characters carrying the same item can't be mixed up.
// Vehicle lines (">") are skipped.
function applyDescriptionRestores(mes, fixes) {
  const blockMatch = String(mes).match(/<rpg_state\b[^>]*>[\s\S]*?<\/rpg_state>/i);
  if (!blockMatch) return { mes, done: [] };
  const block = blockMatch[0];
  const lines = block.split("\n");
  const owners = [];                      // per line: "@player", "party:kira", ... or null
  let section = null, unit = null;
  lines.forEach((ln) => {
    const h = ln.match(/^\s*\[([^\]]+)\]\s*$/);
    if (h) {
      const t = h[1].toLowerCase();
      section = /player/.test(t) ? "player" : /party/.test(t) ? "party" : /npc/.test(t) ? "npcs" : /enem/.test(t) ? "enemies" : null;
      unit = null; owners.push(null); return;
    }
    const nm = ln.match(/\|\s*Name\s*:\s*([^|]*)\|/i);
    if (nm && section && section !== "player") unit = normBondName(nm[1]);
    if (ln.trim().startsWith(">")) { owners.push(null); return; }
    owners.push(section === "player" ? "@player" : section && unit ? `${section}:${unit}` : null);
  });

  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const done = [];
  fixes.forEach((f) => {
    const id = f.who ? `${f.who.group}:${f.who.key}` : "@player";
    const re = new RegExp(`([:;][ \\t]*)${esc(f.from)}([ \\t]*)(?=[;|])`);
    for (let i = 0; i < lines.length; i++) {
      if (owners[i] !== id || !re.test(lines[i])) continue;
      lines[i] = lines[i].replace(re, (m, a, b) => a + f.to + b);
      done.push(f);
      break;
    }
  });
  if (!done.length) return { mes, done };
  return { mes: String(mes).replace(block, lines.join("\n")), done };
}

// ---- correcting a written weekday ----
// If Time: carries a weekday ("Mon Jan 7 1023,09:00") that the real calendar
// disagrees with, the right one is swapped in, in the AI's own style: "Mon"
// stays three letters, "Monday" stays whole, capitals are kept. Only when the
// date can really be placed: a Jan..Dec month and a written year. Otherwise
// it's left alone rather than "corrected" against a guess.
function weekdayFixFor(inner, opts = {}) {
  const fix = opts.fix ?? (uiSettings.fixWeekdays !== false);
  const add = opts.add ?? (uiSettings.addWeekdays !== false);
  const f = String(inner || "").match(/\|\s*Time\s*:\s*([^|]*)\|/i);
  if (!f) return null;
  const parts = f[1].split(",");
  let written = "";
  if (parts.length > 2 && WEEKDAY_RE.test(parts[0].trim())) written = parts.shift().trim();
  const dp = (parts[0] || "").trim().split(/\s+/);
  if (dp.length > 2 && WEEKDAY_RE.test(dp[0])) written = dp.shift();
  written = written.replace(/[.,]/g, "");
  const [month, day, year] = dp;
  if (!/^\d{1,4}$/.test(year || "")) return null;               // no written year: can't be sure
  const correct = worldWeekday({ month, day, year }, true);
  if (!correct) return null;                                    // not a calendar month
  if (!written) {
    // none written: add the short form in front of the month
    return add ? { from: "", to: correct.slice(0, 3), date: `${month} ${day} ${year}`, insert: true } : null;
  }
  if (!fix) return null;
  if (correct.slice(0, 3).toLowerCase() === written.slice(0, 3).toLowerCase()) return null;
  const long = /^(sun|mon|tues|wednes|thurs|fri|satur)day$/i.test(written);
  let to = long ? correct : correct.slice(0, 3);
  if (written === written.toUpperCase()) to = to.toUpperCase();
  else if (written === written.toLowerCase()) to = to.toLowerCase();
  return { from: written, to, date: `${month} ${day} ${year}` };
}

// swap just the weekday word inside Time:, nothing else
function applyWeekdayFix(mes, fix) {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let hit = false;
  const out = String(mes).replace(/<rpg_state\b[^>]*>[\s\S]*?<\/rpg_state>/i, (block) =>
    block.replace(/(\|\s*Time\s*:\s*)([^|]*)\|/i, (m0, pre, val) => {
      const nv = fix.insert
        ? val.replace(/^(\s*)/, (x, sp) => { hit = true; return sp + fix.to + " "; })
        : val.replace(new RegExp(`^(\\s*)${esc(fix.from)}(?![A-Za-z])`), (x, sp) => { hit = true; return sp + fix.to; });
      return pre + nv + "|";
    }));
  return hit ? out : mes;
}

// ---- one pass after a reply settles ----
// Restoring descriptions and correcting the weekday both edit the reply, so
// they run together: separately, whichever went first would change the
// message and make the other give up. The block can be complete while text
// after it is still streaming in, so this waits until the message has stopped
// changing. If the block itself changed meanwhile (a swipe, a regenerate),
// it's dropped: the new version gets its own check.
let restoreTimer = null;
function schedulePostReplyFixes(idx, inner, fixes, waited = 0) {
  clearTimeout(restoreTimer);
  let ctx;
  try { ctx = SillyTavern.getContext(); } catch { return; }
  const snapshot = ctx?.chat?.[idx]?.mes;
  restoreTimer = setTimeout(() => {
    const msg = ctx?.chat?.[idx];
    if (!msg || rpgInnerFromMessage(msg.mes) !== inner) return;
    if (msg.mes !== snapshot) {
      if (waited < 120000) schedulePostReplyFixes(idx, inner, fixes, waited + 1500);
      return;
    }
    const before = msg.mes;
    let mes = before;
    let weekdayDone = null;
    if (fixes.weekday) {
      const m2 = applyWeekdayFix(mes, fixes.weekday);
      if (m2 !== mes) { mes = m2; weekdayDone = fixes.weekday; }
    }
    let done = [];
    if (fixes.restores?.length) ({ mes, done } = applyDescriptionRestores(mes, fixes.restores));
    const moved = [];
    (fixes.positions || []).forEach((f) => {
      const m2 = editOwnerFieldInMes(mes, f.ownerId, POS_FIELDS[f.listKey], (items) => applyPositionLocks(items, f.locks));
      if (m2 !== mes) { mes = m2; moved.push(f); }
    });
    if (mes === before) return;
    setMessageText(msg, mes);
    afterTurnEdit(ctx, idx);
    if (!window.toastr) return;

    const lines = [];
    if (weekdayDone) lines.push(weekdayDone.insert
      ? `Weekday added: <b>${escHtml(weekdayDone.to)}</b> (${escHtml(weekdayDone.date)})`
      : `Weekday: <b>${escHtml(weekdayDone.from)}</b> \u2192 <b>${escHtml(weekdayDone.to)}</b> (${escHtml(weekdayDone.date)})`);
    done.forEach((f) => lines.push(`${f.owner ? escHtml(f.owner) + " \u00B7 " : ""}${escHtml(f.label)}: <b>${escHtml(tItemName(f.to))}</b>`));
    const LIST_LABEL = { inventory: "Items", skills: "Skills", passives: "Passives" };
    moved.forEach((f) => lines.push(`${f.owner ? escHtml(f.owner) + " \u00B7 " : ""}${LIST_LABEL[f.listKey]}: locked positions kept`));
    const kinds = [weekdayDone, done.length, moved.length].filter(Boolean).length;
    const title = kinds > 1 ? "\u{1F4DD} Fixed the reply"
      : weekdayDone ? (weekdayDone.insert ? "\u{1F4C5} Weekday added" : "\u{1F4C5} Weekday corrected")
      : moved.length ? "\u{1F512} Locked positions kept"
      : `\u{1F4DD} Restored ${done.length === 1 ? "a lost description" : done.length + " lost descriptions"}`;
    hudToast.info(`${lines.join("<br>")}<br><span style="opacity:.75">Tap to undo.</span>`, title, {
      escapeHtml: false,
      onclick: () => {
        const m = SillyTavern.getContext()?.chat?.[idx];
        if (!m || m.mes !== mes) return;                       // changed since: leave it
        setMessageText(m, before);
        afterTurnEdit(SillyTavern.getContext(), idx);
        if (window.toastr) hudToast.info("Undone: the AI's version is back.");
      },
    });
  }, 1500);
}

function maybeReportListChanges() {
  let ctx = null;
  try { ctx = SillyTavern.getContext(); } catch {}
  const chat = ctx?.chat;
  if (!Array.isArray(chat)) return;

  const key = currentChatKey(ctx);
  const idx = lastRpgMsgIndex;
  const inner = rpgInnerFromMessage(chat[idx]?.mes);
  if (!inner) return;
  const sig = `${idx}|${inner}`;

  if (key !== alertKey) {                                                           // baseline
    alertKey = key; alertSig = sig; alertIdx = idx;
    // Opening or refreshing a chat never edits old messages. But if this first
    // block is one the AI has only just written (SillyTavern says so; loading
    // a chat never does), its weekday can still be checked: there's nothing
    // earlier to compare descriptions with, but a date needs no comparison.
    if ((uiSettings.fixWeekdays !== false || uiSettings.addWeekdays !== false) && Date.now() - lastReplyAt < 15000 && idx === chat.length - 1) {
      const weekday = weekdayFixFor(inner);
      if (weekday) schedulePostReplyFixes(idx, inner, { weekday, restores: [] });
    }
    return;
  }
  if (sig === alertSig) return;                                                     // same message
  const wentBack = idx < alertIdx;                                                  // a deletion
  alertSig = sig; alertIdx = idx;
  if (wentBack) return;
  // (no early exit when the alert and fix settings are all off: position
  // locks still need this pass)

  // the weekday needs no earlier turn, so it's checked even on a first reply
  const weekday = weekdayFixFor(inner);

  let prevInner = null;
  for (let i = idx - 1; i >= 0 && !prevInner; i--) {
    const m = chat[i];
    if (m && !m.is_user) prevInner = rpgInnerFromMessage(m.mes);
  }
  const a = prevInner ? coreStateOf(prevInner) : null, b = coreStateOf(inner);

  let restoring = [];
  if (uiSettings.restoreLostDesc && a && b) restoring = findDescriptionRestores(a, b);
  const positions = b ? positionFixesFor(b) : [];
  if (weekday || restoring.length || positions.length) schedulePostReplyFixes(idx, inner, { weekday, restores: restoring, positions });
  if (!a || !b) return;
  // only for a reply that's just arrived: opening a chat, or the HUD tidying
  // an old block's format, is not something being acquired
  if (isSysSkin() && uiSettings.sysNotices !== false
      && Date.now() - lastReplyAt < 120000 && idx === chat.length - 1) {
    try { sysShowNotices(sysNoticesFor(a, b), `${key}|${idx}|${chat[idx]?.swipe_id ?? 0}`); }
    catch (e) { console.warn("RPG HUD: system notice failed", e); }
  }
  if (!uiSettings.changeAlerts) return;

  // every character, not just the player; each change carries whose it is
  const prevOwners = new Map(listOwners(a).map((o) => [o.id, o]));
  const diffs = [];
  listOwners(b).forEach((owner) => {
    const was = prevOwners.get(owner.id);
    if (!was) return;
    diffLists(snapshotLists(was.ent), snapshotLists(owner.ent)).forEach((d) => {
      // anything about to be restored isn't worth an alert
      if (restoring.some((f) => f.from === d.name && (f.who ? `${f.who.group}:${f.who.key}` : "@player") === owner.id)) return;
      diffs.push({ ...d, kind: d.label, label: owner.name ? `${owner.name} \u00B7 ${d.label}` : d.label });
    });
  });
  if (!diffs.length) return;
  console.log("RPG HUD: list changes", diffs);

  // Any description that lost or swapped even one word gets flagged. Pure
  // additions (the AI adding detail) don't lose anything, so those stay in the
  // log. A lost number or a big chunk is marked as the more serious kind.
  // Masteries exist to change: their progress ticks every turn. The same goes
  // for any "Name: 12/30" counter elsewhere. Both stay in the turn log but
  // never raise an alert.
  const progressless = (t) => String(t ?? "").replace(/:\s*-?\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/g, "").trim();
  // "Oxygen Tank (4 hours left)" -> "(3.5 hours left)", "x3" -> "x2", "60%" -> "55%":
  // amounts going up and down are the item being used, not the AI losing detail
  const countless = (t) => progressless(t).toLowerCase()
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|quarter|few|several|no)\b/g, "#")
    .replace(/\d+(?:[.,]\d+)?/g, "#")
    .replace(/(?:#\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s|days?|d|weeks?|wks?|turns?|rounds?|uses?|charges?|shots?|doses?|%|l|liters?|litres?|ml|kg|g|lbs?|oz|x)?\b\s*(?:and\s+)?)+/g, "# ")
    .replace(/\s+/g, " ").trim();
  const hits = diffs
    .filter((d) => (d.type === "lost" || d.type === "changed") && d.before)
    .filter((d) => d.kind !== "Mastery")
    .filter((d) => progressless(d.before) !== progressless(d.name))
    .filter((d) => uiSettings.ignoreCountChanges === false || countless(d.before) !== countless(d.name))
    .filter((d) => (wordDiff(d.before, d.name) || [{ op: "-" }]).some((o) => o.op === "-"))
    .map((d) => ({ ...d, serious: isMeaningfulLoss(d.before, d.name) }))
    .sort((x, y) => (y.serious ? 1 : 0) - (x.serious ? 1 : 0));
  if (!hits.length) return;

  const shown = hits.slice(0, 3);
  const body =
    shown.map((d) =>
      `${escHtml(d.label)}: <b>${escHtml(tItemName(d.name))}</b>` +
      `<br><span style="opacity:.95;">${wordDiffHtml(d.before, d.name, "toast")}</span>`
    ).join("<br><br>") +
    (hits.length > 3 ? `<br><br>(+${hits.length - 3} more in the turn log)` : "");

  const serious = hits.some((d) => d.serious);
  if (window.toastr) {
    const fn = serious ? hudToast.warning : hudToast.info;
    fn(body,
      serious ? "\u26A0\uFE0F Description lost detail" : "\u{1F4DD} Description changed",
      { escapeHtml: false });
  }
}

function sanitizeBrokenPipeLine(line) {
  const s = String(line ?? "");
  let out = "";
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    if (ch !== "|") {
      out += ch;
      i++;
      continue;
    }

    const rest = s.slice(i + 1);

    // real pipe start if next token looks like FieldName:
    if (/^\s*[A-Za-z][A-Za-z0-9_ ]*\s*:/.test(rest)) {
      out += "|";
      i++;
      continue;
    }

    // real closing pipe if followed by another real field or end of line
    if (/^\s*(\||$|>|\[)/.test(rest)) {
      out += "|";
      i++;
      continue;
    }

    // otherwise it's probably a stray text pipe inside a value
    out += "｜";
    i++;
  }

  return out;
}

function findBestPipeErrorPosition(line) {
  const s = String(line ?? "");
  const pipes = [...s.matchAll(/\|/g)].map(m => m.index ?? 0);
  if (!pipes.length) return 0;

  // 1) triple-pipe: middle pipe is usually the accidental one
  const triple = s.indexOf("|||");
  if (triple !== -1) return triple + 1;

  // 2) direct stray-pipe patterns inside text:
  //    x| x
  //    x |x
  //    x|x
  for (let i = 0; i < pipes.length; i++) {
    const p = pipes[i];
    const left = s[p - 1] ?? "";
    const right = s[p + 1] ?? "";
    const right2 = s[p + 2] ?? "";

    const leftLooksText = /\S/.test(left) && left !== "|";
    const rightLooksText = /\S/.test(right) && right !== "|";

    // x|x
    if (leftLooksText && rightLooksText) return p;

    // x| x
    if (leftLooksText && right === " " && /\S/.test(right2) && right2 !== "|") return p;

    // x |x
    if (left === " " && p >= 2) {
      const left2 = s[p - 2] ?? "";
      if (/\S/.test(left2) && left2 !== "|" && rightLooksText) return p;
    }
  }

  // 3) unmatched-pipe fallback:
  // walk pipe pairs and return first opener that never closes
  for (let i = 0; i < pipes.length; i += 2) {
    const start = pipes[i];
    const end = pipes[i + 1];
    if (end === undefined) return start;
  }

  // 4) final fallback
  return pipes[pipes.length - 1];
}

function findUnmatchedPipePosition(line) {
  const positions = [...String(line).matchAll(/\|/g)].map(m => m.index ?? 0);
  if (positions.length % 2 === 0) return positions[positions.length - 1] ?? 0;

  for (let i = 0; i < positions.length; i += 2) {
    const start = positions[i];
    const end = positions[i + 1];

    if (end === undefined) return start;

    const segment = line.slice(start + 1, end);

    if (!segment.includes(":")) return start;
  }

  return positions[positions.length - 1] ?? 0;
}

function charNumToScroll(charPos) {
  const ch = Math.max(0, Number(charPos ?? 0));
  return Math.max(0, (ch - 8) * 8);
}

function openPipeErrorPanel(e) {
  if (e) e.stopPropagation();
  isErrorOpen = true;
  isSettingsOpen = false;
  renderRPG();
}

function closePipeErrorPanel(e) {
  if (e) e.stopPropagation();
  isErrorOpen = false;
  renderRPG();
}

function buildPipeErrorPanelHtml() {
  const lineNum = lastPipeError?.line ?? "?";
  const charNum = Math.max(0, Number(lastPipeError?.char ?? 0));
  const snippet = String(lastPipeError?.snippet || "");
  const message = String(lastPipeError?.message || "No detailed pipe error is stored.");

  const displaySnippet = snippet || "(no line captured)";
  const caretLine = pipeCaretLine(charNum);

  return `
    <div id="rpg-error-overlay" style="
      position:absolute; inset:0;
      background: rgba(0,0,0,0.94);
      border: 1px solid #333;
      z-index: 100001;
      display:flex;
      flex-direction:column;
      box-sizing:border-box;
      padding:10px;
      overflow:hidden;
    ">
      <div style="
        display:flex;
        justify-content:space-between;
        align-items:center;
        margin-bottom:8px;
        border-bottom:1px solid #333;
        padding-bottom:6px;
        flex:0 0 auto;
      ">
        <div style="font-weight:bold; color:#f1c40f;">🟡 PIPE ERROR</div>
        <button id="rpg-error-close" style="
          background:#444;
          border:1px solid #777;
          color:#fff;
          cursor:pointer;
          font-size:10px;
          padding:3px 10px;
          font-weight:bold;
        ">CLOSE</button>
      </div>

      <div style="
        font-size:0.78em;
        color:#bbb;
        margin-bottom:8px;
        flex:0 0 auto;
      ">
        Line ${escHtml(lineNum)} · Char ${escHtml(charNum)}
      </div>

      <div style="
        flex:0 0 auto;
        background:rgba(255,255,255,0.04);
        border:1px solid #333;
        padding:8px;
      ">
        <div id="rpg-error-scroll" style="
          overflow-x:auto;
          overflow-y:hidden;
          -webkit-overflow-scrolling: touch;
          touch-action: pan-x;
          white-space:normal;
          min-height:72px;
          max-height:96px;
        ">
          <div style="
            display:block;
            width:max-content;
            min-width:100%;
            white-space:pre;
            font-size:0.82em;
            line-height:1.45;
            font-family:${uiSettings.fontFamily || "'Courier New', Courier, monospace"};
            color:#ddd;
          ">${escHtml(displaySnippet)}</div>

          <div style="
            display:block;
            width:max-content;
            min-width:100%;
            white-space:pre;
            font-size:0.82em;
            line-height:1.45;
            font-family:${uiSettings.fontFamily || "'Courier New', Courier, monospace"};
            color:#f1c40f;
            margin-top:2px;
          ">${escHtml(caretLine)}</div>
        </div>
      </div>

      <div style="
        margin-top:8px;
        padding:8px;
        background:rgba(255,255,255,0.04);
        border:1px solid #333;
        font-size:0.76em;
        color:#ddd;
        line-height:1.3;
        flex:1 1 auto;
        overflow:auto;
        white-space:pre-wrap;
      ">${escHtml(message)}
      </div>
    </div>
  `;
}

function makePipeError(lineNum, charPos, message, lineText) {
  return {
    line: lineNum,
    char: charPos,
    message,
    snippet: lineText || "",
  };
}

function pipeCaretLine(charPos) {
  return `${" ".repeat(Math.max(0, charPos))}^`;
}

function safePipeText(value) {
  return String(value ?? "")
    .replace(/\|/g, "｜")   // turns dangerous pipe into a safe lookalike
    .replace(/\r?\n/g, " ") // removes line breaks
    .trim();
}

function indicatorColor(status) {
  switch (status) {
    case "valid":   return "#2ecc71";
    case "invalid": return "#f1c40f";
    case "notag":   return "#bdc3c7";
    case "user":    return "#e74c3c";
    default:        return "#555";
  }
}

// Gray Fog's four-pointed star, used for the menu button, the folded-away button and the status mark
const FOG_STAR_GLYPH = (fill) => `<path d="M12 2.5 L13.6 10.4 L21.5 12 L13.6 13.6 L12 21.5 L10.4 13.6 L2.5 12 L10.4 10.4 Z" fill="${fill}"/>
  <circle cx="12" cy="12" r="6.3" fill="none" stroke="${fill}" stroke-width="1" opacity=".5"/>`;
// the dot's colours; with no chat the dot's dark grey would vanish on the dark panel, so a softer grey
function fogStatusTint(status) {
  return ["valid", "invalid", "notag", "user"].includes(status) ? indicatorColor(status) : "#8a8c96";
}
function fogStatusStarHtml(status, title) {
  return `<span class="fog-status" title="${escAttr(title || "")}" style="--orb-tint:${fogStatusTint(status)}">
    <svg viewBox="0 0 24 24" aria-hidden="true">${FOG_STAR_GLYPH("var(--orb-tint)")}</svg></span>`;
}
function renderIndicatorDotHtml(status, title) {
  const c = indicatorColor(status);
  return `
    <span
      title="${escAttr(title || "")}"
      style="
        width:12px;
        height:12px;
        border-radius:50%;
        background:${c};
        box-shadow: 0 0 0 2px rgba(0,0,0,0.65);
        display:inline-block;
        vertical-align:middle;
      "
    ></span>
  `;
}

// Closing or switching a chat changes what "latest message" means, so the
// first reading in any chat is a baseline, never an alert. A missing block is
// only worth announcing when a new message just arrived in this same chat.
// set when SillyTavern reports a freshly generated reply (MESSAGE_RECEIVED);
// replyReceivedAt is used up by the missing-block check, lastReplyAt isn't
let replyReceivedAt = 0;
let lastReplyAt = 0;
function replyEventsSupported() {
  try { return !!event_types?.MESSAGE_RECEIVED; } catch { return false; }
}

let lastIndicatorKey = null;
let lastIndicatorLen = 0;
// A streaming reply has no block until the end, so "missing" is only real once
// the message has stopped changing for a moment.
let notagWatch = null;          // { key, idx, len, since, done }
const NOTAG_SETTLE_MS = 2500;

// Every HUD toast goes through here, so the Toast duration setting covers them
// all. Options are passed per toast and never set globally: the global ones
// are SillyTavern's too, and setting them made its own toasts permanent.
function hudToastOpts(extra = {}) {
  const secs = Math.max(0, Math.min(120, Number(uiSettings.toastSeconds ?? 8)));
  return {
    timeOut: secs * 1000,
    extendedTimeOut: secs ? 1500 : 0,     // after the pointer leaves (or a tap on a phone)
    tapToDismiss: true, closeButton: true, preventDuplicates: true, newestOnTop: true,
    progressBar: secs > 0,
    ...extra,
  };
}
const hudToast = Object.fromEntries(["info", "warning", "success", "error"].map((k) => [k, (msg, title, opts) => {
  const t = window.toastr;
  if (!t) return;
  (t[k] || t.info).call(t, msg, title, hudToastOpts(opts));
}]));

function rpgToast(kind, msg) {
  if (!window.toastr) return;
  (hudToast[kind] || hudToast.info)(msg);
}

setInterval(() => {
  if (!notagWatch || notagWatch.done) return;
  try { updateLatestStatusAndToast(SillyTavern.getContext()?.chat); } catch {}
}, 1000);

function updateLatestStatusAndToast(chat) {
  const latest = getLatestRpgValidity(chat);

  let key = "";
  try { key = currentChatKey(SillyTavern.getContext()); } catch {}
  const len = Array.isArray(chat) ? chat.length : 0;

  if (key !== lastIndicatorKey) {
    lastIndicatorKey = key;
    lastIndicatorLen = len;
    lastIndicatorStatus = latest.status;
    return latest;
  }
  const grew = len > lastIndicatorLen;
  lastIndicatorLen = len;

  const prev = lastIndicatorStatus;
  const changed = prev !== latest.status;
  lastIndicatorStatus = latest.status;

  // a broken block is complete by definition, so it can be reported at once
  if (changed && latest.status === "invalid") {
    rpgToast("warning", "RPG Pipe format is broken (\u{1F7E1}). Tap the dot for details.");
  }

  // a missing block: start watching when a new AI message shows up without one
  if (latest.status === "notag") {
    const last = chat[len - 1];
    const textLen = String(last?.mes || "").length;
    // only something that just happened: a new reply, or a block that was
    // there a moment ago going missing (a swipe or regenerate without one).
    // Simply opening a chat whose last message lacks a block is neither.
    // Only a reply the AI just generated can be "missing" its block. Growth
    // alone isn't proof: opening or refreshing a chat grows it from nothing,
    // which fired this toast on every refresh. SillyTavern's MESSAGE_RECEIVED
    // fires for generated replies (swipes included) and never for messages
    // loaded from disk. Without that event, fall back to growth.
    const fresh = replyEventsSupported()
      ? (replyReceivedAt > 0 && Date.now() - replyReceivedAt < 120000)
      : (grew || (changed && prev === "valid"));
    if (fresh) {
      replyReceivedAt = 0;
      notagWatch = { key, idx: len - 1, len: textLen, since: Date.now(), done: false };
    } else if (!notagWatch || notagWatch.key !== key || notagWatch.idx !== len - 1) {
      // nothing being watched
    } else if (notagWatch.len !== textLen) {
      notagWatch.len = textLen;          // still streaming
      notagWatch.since = Date.now();
    } else if (!notagWatch.done && hudToastArmed && Date.now() - notagWatch.since >= NOTAG_SETTLE_MS) {
      notagWatch.done = true;
      rpgToast("info", "No <rpg_state> found in the latest AI message (\u26AA).");
    }
  } else {
    notagWatch = null;
    if (latest.status === "valid") replyReceivedAt = 0;   // that reply had its block
  }
  return latest;
}

function getLatestRpgValidity(chat) {
  if (!Array.isArray(chat) || chat.length === 0) {
    return { status: "nochat", label: "No chat", detail: "" };
  }

  const last = chat[chat.length - 1];

  if (last?.is_user) {
    return { status: "user", label: "Last is user", detail: "" };
  }

  const mes = String(last?.mes || "");
  const regex = /<rpg_state\b[^>]*>([\s\S]*?)<\/rpg_state>/i;
  const m = mes.match(regex);

  if (!m) {
    return { status: "notag", label: "No <rpg_state>", detail: "" };
  }

  const rawText = m[1];
  if (!rawText.includes('|')) {
    return { status: "invalid", label: "No Pipes Found", detail: "The <rpg_state> block is empty or missing pipes." };
  }

  const lines = rawText.split('\n');
  // count lines the way you'd read the block: its first written line ([Global]) is line 1
  const lead = lines.findIndex((l) => l.trim());
  let errors = [];

  lines.forEach((line, index) => {
    const t = line.trim();
    if (!t || t.startsWith('[')) return;

    // Read the line the way the parser does: a pipe that's plainly part of a
    // value ("Card [ 0 | 0 ]") isn't a field boundary, so it can't be a broken
    // field either. The swap is one character for one, so positions still line up.
    const pipeSegments = [...sanitizeBrokenPipeLine(t).matchAll(/\|([^|]+)(?=\|)/g)];
    pipeSegments.forEach(seg => {
      const content = seg[1].replace(/\uFF5C/g, "").trim();
      // If there is content inside the pipe, it MUST have a colon
      if (content && !content.includes(':')) {
        // the caret goes on the field's first letter
        const pad = seg[1].match(/^[\s\uFF5C]*/)[0].length;
        errors.push({ line: index - Math.max(0, lead) + 1, char: (seg.index ?? 0) + 1 + pad, text: t, content });
      }
    });
  });

  if (errors.length > 0) {
    const say = (e) => `Line ${e.line}: |${e.content}| has no colon. Every field is written |Name:value|, ` +
      `so this one should be |${e.content}:| (empty) or |${e.content}:something|.`;
    // the details panel shows the first problem underlined, and lists them all
    const first = errors[0];
    lastPipeError = makePipeError(first.line, first.char, errors.map(say).join("\n\n"), first.text);
    return { status: "invalid", label: "Format Warning", detail: errors.map(say).join("\n") };
  }

  return { status: "valid", label: "Latest OK", detail: "" };
}

function getEnergy(display, isVehicle) {
  if (!display) return { curr: 0, max: 0, label: isVehicle ? "EN/MP" : "MP" };

  const mpCurr = display.mp_curr ?? display.mp;
  const mpMax  = display.mp_max;

  const enCurr = display.en_curr ?? display.en ?? display.en_current;
  const enMax  = display.en_max ?? display.enMax ?? display.en_capacity;

  const hasMp = mpCurr !== undefined || mpMax !== undefined;
  const curr = hasMp ? mpCurr : enCurr;
  const max  = hasMp ? mpMax  : enMax;

  const label =
    (isVehicle && display.type === "ship") || (!hasMp && (enCurr !== undefined || enMax !== undefined))
      ? "EN"
      : "MP";

  return { curr: curr ?? 0, max: max ?? 0, label };
}

function isInfinityToken(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "∞" || s === "inf" || s === "infinity" || s === "+inf" || s === "+infinity") return true;
  return isHugeNumber(v);
}

function safeParseFloatOrInf(v, fallback = 0) {
  if (isInfinityToken(v)) return Number.POSITIVE_INFINITY;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function toNumberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function percentFrom(currRaw, maxRaw) {
  const curr = safeParseFloatOrInf(currRaw, 0);
  const max  = safeParseFloatOrInf(maxRaw, 0);

  if (!Number.isFinite(curr) || !Number.isFinite(max)) return 100;
  if (max <= 0) return 0;
  return clamp((curr / max) * 100, 0, 100);
}

const INF_THRESHOLD = 999999999; 

function isHugeNumber(v) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) && n >= INF_THRESHOLD;
}

function parseBondValue(v) {
  let s = String(v ?? "").trim();
  s = s.replace(/\/100$/i, '');
  s = s.toLowerCase();

  if (s === "∞" || s === "infinity" || s === "inf") return 101; 
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// --- BOND LEDGER ---
function bondBaseName(n) {
  return String(n ?? "")
    .replace(/[\(\[\{].*$/, " ")      // "Alice (Battle Form)" -> "Alice"
    .replace(/\s*[-–—:]\s.*$/, " ")   // "Alice - Awakened"    -> "Alice"
    .replace(/\s+/g, " ")
    .trim();
}

function normBondName(n) {
  return bondBaseName(n).toLowerCase();
}

function upsertBond(list, name, value) {
  if (!Array.isArray(list)) return;
  const key = normBondName(name);
  if (!key) return;
  const display = bondBaseName(name) || String(name).trim();
  const hit = list.find((b) => normBondName(b.name) === key);
  if (hit) {
    hit.name = display;
    hit.bond = value;
  } else {
    list.push({ name: display, bond: value });
  }
}

function parseBondLedger(str) {
  const out = [];
  if (!str) return out;
  String(str).split(";").forEach((chunk) => {
    const s = chunk.trim();
    if (!s) return;
    const idx = s.lastIndexOf(":");
    if (idx === -1) return;
    const name = s.slice(0, idx).trim();
    if (!name) return;
    upsertBond(out, name, parseBondValue(s.slice(idx + 1)));
  });
  return out;
}

function formatBondLedger(list) {
  if (!Array.isArray(list) || !list.length) return "";
  return list
    .filter((b) => b && b.name)
    .map((b) => `${safePipeText(b.name)}:${b.bond >= 101 ? "∞" : b.bond}`)
    .join(";");
}

// Rebuild the bond ledger from messages BEFORE `beforeIdx`. This is the memory
// that restores a character who has left the scene. Sourcing it from history
// rather than from the previous parse is what makes swipes clean: a character
// you met in a swipe you then abandoned never entered history, so they vanish.
function bondMemoryFromHistory(chat, beforeIdx) {
  const out = [];
  if (!Array.isArray(chat)) return out;

  const limit = Math.max(0, Math.min(beforeIdx, chat.length));
  const blockRe = /<rpg_state\b[^>]*>([\s\S]*?)<\/rpg_state>/gi;

  for (let i = 0; i < limit; i++) {
    const msg = chat[i];
    if (!msg || msg.is_user || typeof msg.mes !== "string") continue;
    if (!/<rpg_state\b/i.test(msg.mes)) continue;

    // newest block in this message wins, same rule as the live parser
    let body = null, m;
    blockRe.lastIndex = 0;
    while ((m = blockRe.exec(msg.mes)) !== null) body = m[1];
    if (body === null) continue;

    // 1. the |Bonds:| ledger pipe
    const led = body.match(/\|Bonds:([^|]*)\|/i);
    if (led) parseBondLedger(led[1]).forEach((b) => upsertBond(out, b.name, b.bond));

    // 2. live |Bond:| values on party/NPC entries overwrite it, as in the
    //    real pipeline. Walk statefully: Name and Bond may sit on separate lines.
    let curName = "";
    let inPlayer = false;
    body.split("\n").forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      if (line.startsWith("[")) {
        inPlayer = /player/i.test(line);
        curName = "";
        return;
      }
      if (line.startsWith(">")) return;           // vehicles carry no bond
      const nm = line.match(/\|Name:\s*([^|]*)/i);
      if (nm) curName = nm[1].trim();
      if (inPlayer || !curName) return;
      const bd = line.match(/\|Bond:\s*([^|]*)/i);
      if (bd && bd[1].trim()) upsertBond(out, curName, parseBondValue(bd[1]));
    });
  }
  return out;
}

// Timers are current state, not a ledger, so "memory" is simply the newest
// block BEFORE this message — no accumulation. Only the persistent kinds
// matter; a CD from two messages ago is meaningless now.
function timerMemoryFromHistory(chat, beforeIdx) {
  if (!Array.isArray(chat)) return [];
  const blockRe = /<rpg_state\b[^>]*>([\s\S]*?)<\/rpg_state>/gi;

  for (let i = Math.min(beforeIdx, chat.length) - 1; i >= 0; i--) {
    const msg = chat[i];
    if (!msg || msg.is_user || typeof msg.mes !== "string") continue;
    if (!/<rpg_state\b/i.test(msg.mes)) continue;

    let body = null, m;
    blockRe.lastIndex = 0;
    while ((m = blockRe.exec(msg.mes)) !== null) body = m[1];
    if (body === null) continue;

    const tm = body.match(/\|Timers:([^|]*)\|/i);
    if (!tm) continue;
    return parseTimers(tm[1]).filter((t) =>
      TIMER_PERSISTENT_KINDS.includes(String(t.kind || "").toUpperCase())
    );
  }
  return [];
}

function refreshHistoryMemory(chat, chatKey) {
  const key = `${chatKey}|${lastRpgMsgIndex}|${Array.isArray(chat) ? chat.length : 0}`;
  if (key === historyMemoryKey) return;
  bondMemory = bondMemoryFromHistory(chat, lastRpgMsgIndex);
  timerMemory = timerMemoryFromHistory(chat, lastRpgMsgIndex);
  historyMemoryKey = key;
}

function invalidateHistoryMemory() {
  historyMemoryKey = null;
}

function mergeBondLedger(prevList, parsedList) {
  const out = [];
  (Array.isArray(prevList) ? prevList : []).forEach((b) => upsertBond(out, b.name, b.bond));
  (Array.isArray(parsedList) ? parsedList : []).forEach((b) => upsertBond(out, b.name, b.bond));
  return out;
}

// Live party/NPC bonds are authoritative — push them into the ledger
function syncLiveBondsIntoLedger(state) {
  if (!state) return;
  if (!Array.isArray(state.bonds)) state.bonds = [];
  const live = [
    ...(Array.isArray(state.party) ? state.party : []),
    ...(Array.isArray(state.npcs) ? state.npcs : []),
  ];
  live.forEach((u) => {
    if (!u || !u.name) return;
    if (u.bond === undefined || u.bond === null || u.bond === "") return;
    // a bond you deleted stays out of the ledger even though the character
    // keeps their own |Bond:| value
    if (bondBlocklist.has(normBondName(u.name))) return;
    upsertBond(state.bonds, u.name, parseBondValue(u.bond));
  });
}

function bondLedgerToEditorText(list) {
  if (!Array.isArray(list) || !list.length) return "";
  return list
    .filter((b) => b && b.name)
    .map((b) => `${b.name} | ${b.bond >= 101 ? "∞" : b.bond}`)
    .join("\n");
}

function parseBondLedgerFromText(text) {
  const out = [];
  String(text || "").split("\n").forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    let parts = line.split("|").map((s) => s.trim());
    if (parts.length < 2) parts = line.split(":").map((s) => s.trim());
    if (parts.length < 2 || !parts[0]) return;
    upsertBond(out, parts[0], parseBondValue(parts[1]));
  });
  return out;
}

// --- TIMERS ---
const TIMER_KINDS = ["CD", "BUFF", "DEBUFF", "EVENT", "DOOM"];
const KIND_RANK = { DOOM: 0, EVENT: 1, DEBUFF: 2, BUFF: 3, CD: 4 };
// Kinds that are appointments, not combat state: they survive being dropped.
const TIMER_PERSISTENT_KINDS = ["EVENT", "DOOM"];
const TIMER_MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const TIMER_MONTH_DAYS = [31,28,31,30,31,30,31,31,30,31,30,31];
const YEAR_MINUTES = 365 * 1440;

// Day of the week for the in-story date. If the block says one ("Mon Jan 6
// 1023"), that wins: the story is the authority. Otherwise it's worked out
// from the date on the real calendar, so it always advances consistently.
// A month that isn't Jan..Dec (a fantasy calendar) gets no weekday rather
// than a wrong one.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_RE = /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?$/i;

function worldWeekday(t, long = false) {
  let i = -1;
  if (t?.weekday) i = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(String(t.weekday).slice(0, 3).toLowerCase());
  if (i < 0) {
    const y = parseInt(t?.year, 10), d = parseInt(t?.day, 10);
    const m = TIMER_MONTHS.indexOf(String(t?.month || "").trim().slice(0, 3).toLowerCase());
    if (!Number.isFinite(y) || !d || m < 0) return "";
    const dt = new Date(Date.UTC(2000, 0, 1));
    dt.setUTCFullYear(y, m, d);                // setUTCFullYear: years under 100 aren't remapped to 19xx
    i = dt.getUTCDay();
  }
  return long ? WEEKDAYS[i] : WEEKDAYS[i].slice(0, 3);
}

function monthIndex(m) {
  const i = TIMER_MONTHS.indexOf(String(m || "").trim().slice(0, 3).toLowerCase());
  return i === -1 ? 0 : i;
}

// A clock time in any of the usual ways of writing one: "14:30", "2:30 PM",
// "2:30pm", "2 p.m.", "02.30 PM", "noon", "midnight". Returns minutes after
// midnight and whether it was written as 12-hour, or null.
function parseClock(clock) {
  const s = String(clock || "").trim();
  if (/^noon$/i.test(s)) return { mins: 720, ampm: true };
  if (/^midnight$/i.test(s)) return { mins: 0, ampm: true };
  let h, mi, ap;
  let m = s.match(/(\d{1,2})\s*[:.]\s*(\d{1,2})(?:\s*([ap])\.?\s*m\.?)?/i);
  if (m) { h = +m[1]; mi = +m[2]; ap = m[3]; }
  else {
    m = s.match(/(\d{1,2})\s*([ap])\.?\s*m\.?/i);
    if (!m) return null;
    h = +m[1]; mi = 0; ap = m[2];
  }
  if (ap) h = (h % 12) + (/p/i.test(ap) ? 12 : 0);
  if (h === 24) h = 0;
  if (h > 23 || mi > 59) return null;
  return { mins: h * 60 + mi, ampm: !!ap };
}
// the same, as a pattern to embed in larger ones
const CLOCK_SRC = String.raw`(?:\d{1,2}\s*:\s*\d{1,2}(?:\s*[ap]\.?\s*m\.?)?|\d{1,2}\s*[ap]\.?\s*m\.?|noon|midnight)`;

function clockToMinutes(clock) {
  return parseClock(clock)?.mins ?? 0;
}

// minutes after midnight written out, 12- or 24-hour
function clockText(mins, twelve) {
  const h = Math.floor(mins / 60) % 24, m = mins % 60;
  const mm = String(m).padStart(2, "0");
  return twelve ? `${h % 12 || 12}:${mm} ${h >= 12 ? "PM" : "AM"}` : `${String(h).padStart(2, "0")}:${mm}`;
}
function storyUses12h() {
  return !!parseClock(rpgState?.world_time?.clock)?.ampm;
}
// times the HUD writes into a block (deadlines from "time left"): 12-hour
// when the setting says so, or, on "As written", when the story's Time: is
function writeIn12h() {
  const f = uiSettings.clockFormat;
  return f === "12" || (f !== "24" && storyUses12h());
}

function clockFormatOptions() {
  const f = uiSettings.clockFormat === "12" || uiSettings.clockFormat === "24" ? uiSettings.clockFormat : "asis";
  return [["asis", "As written"], ["12", "12-hour"], ["24", "24-hour"]]
    .map(([v, t]) => `<option value="${v}"${f === v ? " selected" : ""}>${t}</option>`).join("");
}

// a clock as shown on screen, per the Clock setting; unreadable text is left alone
function showClock(clock) {
  const f = uiSettings.clockFormat;
  if (f !== "12" && f !== "24") return String(clock ?? "");
  const p = parseClock(clock);
  return p ? clockText(p.mins, f === "12") : String(clock ?? "");
}

function worldMinutes(month, day, clock, year) {
  const mi = monthIndex(month);
  let days = 0;
  for (let i = 0; i < mi; i++) days += TIMER_MONTH_DAYS[i];
  days += Math.max(1, parseInt(day, 10) || 1) - 1;
  const y = parseInt(year, 10);
  const base = Number.isFinite(y) ? y * YEAR_MINUTES : 0;
  return base + days * 1440 + clockToMinutes(clock);
}

function nowWorldMinutes() {
  const t = rpgState.world_time || {};
  return worldMinutes(t.month, t.day, t.clock, t.year);
}

function parseDeadline(val) {
  // an optional weekday in front, like Time: ("Mon Jan 6 1023,14:00" or
  // "Mon, Jan 6 1023,14:00"): the date is what counts, so it's skipped
  const s = String(val || "").trim().replace(/^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s*,?\s+(?=[A-Za-z]{3,9}\s+\d)/i, "");
  const t = rpgState.world_time || {};

  const full = s.match(new RegExp(String.raw`^([A-Za-z]{3,9})\s+(\d{1,2})(?:\s+(\d{1,4}))?\s*,\s*(${CLOCK_SRC})$`, "i"));
  if (full) return worldMinutes(full[1], full[2], full[4], full[3] ?? t.year);

  const clockOnly = s.match(new RegExp(`^(${CLOCK_SRC})$`, "i"));
  if (clockOnly) {
    let target = worldMinutes(t.month, t.day, clockOnly[1], t.year);
    if (target <= nowWorldMinutes()) target += 1440;
    return target;
  }
  return null;
}

// ---- durations, for editing deadline timers as "time left" ----
// "1d 3h", "2h 30m", "45m", "1w", "in 2 days": minutes, or null if the text
// isn't a duration (so turns, uses and typed dates are left to the parser).
function parseDuration(text) {
  const t = String(text || "").trim().toLowerCase().replace(/^(in|\+)\s*/, "");
  if (!t) return null;
  const unit = { w: 10080, wk: 10080, wks: 10080, week: 10080, weeks: 10080,
    d: 1440, day: 1440, days: 1440, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60,
    m: 1, min: 1, mins: 1, minute: 1, minutes: 1 };
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)\s*,?\s*/g;
  let total = 0, used = 0, m;
  while ((m = re.exec(t))) {
    if (m.index !== used || !unit[m[2]]) return null;
    total += parseFloat(m[1]) * unit[m[2]];
    used = re.lastIndex;
  }
  return used === t.length && used > 0 ? Math.round(total) : null;
}

// minutes as an exact, editable duration: "1d 3h 15m"
function durationText(mins) {
  const a = Math.max(0, Math.round(mins));
  const d = Math.floor(a / 1440), h = Math.floor((a % 1440) / 60), m = a % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || !parts.length) parts.push(`${m}m`);
  return parts.join(" ");
}

// world minutes back to a deadline in Time: format ("Mon Jan 6 1023,14:00").
// A weekday is written only if the story's Time: uses one.
function deadlineText(target) {
  const t = rpgState.world_time || {};
  const hasYear = Number.isFinite(parseInt(t.year, 10));
  let rest = Math.max(0, Math.round(target));
  const year = hasYear ? Math.floor(rest / YEAR_MINUTES) : null;
  if (hasYear) rest -= year * YEAR_MINUTES;
  let day = Math.floor(rest / 1440);
  const clockMin = rest - day * 1440;
  let mi = 0;
  while (mi < 11 && day >= TIMER_MONTH_DAYS[mi]) { day -= TIMER_MONTH_DAYS[mi]; mi++; }
  const month = TIMER_MONTHS[mi][0].toUpperCase() + TIMER_MONTHS[mi].slice(1);
  const clock = clockText(clockMin, writeIn12h());
  const wd = t.weekday && hasYear ? worldWeekday({ month, day: day + 1, year }) : "";
  return `${wd ? wd + " " : ""}${month} ${day + 1}${hasYear ? " " + year : ""},${clock}`;
}

function minutesUntil(targetMin) {
  let d = targetMin - nowWorldMinutes();
  if (d < -YEAR_MINUTES / 2) d += YEAR_MINUTES; // Dec -> Jan rollover
  return d;
}

function formatMinutes(mins) {
  const a = Math.max(0, Math.round(mins));
  const d = Math.floor(a / 1440);
  const h = Math.floor((a % 1440) / 60);
  const m = a % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function timerKindStyle(kind) {
  switch (String(kind || "CD").toUpperCase()) {
    case "DOOM":   return { color: "#ff5252", icon: "☠️", zero: "TRIGGERED" };
    case "EVENT":  return { color: "#ce93d8", icon: "📅", zero: "NOW" };
    case "DEBUFF": return { color: "#ff9800", icon: "⚠️", zero: "ENDED" };
    case "BUFF":   return { color: "#69f0ae", icon: "✨", zero: "ENDED" };
    default:       return { color: "#90caf9", icon: "⏳", zero: "READY" };
  }
}

// Charges count uses, not time: "block the next 2 attacks". Written with an
// x (2/2x, 2x) or the words uses/charges. Neither the round auto-tick nor the
// manual turn button touches them, since both only match plain 2/3 and 2.
const TIMER_CHARGE_RE = /^(-?\d+)(\s*\/\s*\d+)?(\s*(?:x|\u00D7|uses?|charges?))$/i;

function timerInfo(t) {
  const kind = String(t?.kind || "CD").toUpperCase();
  const raw = String(t?.value ?? "").trim();
  const zero = timerKindStyle(kind).zero;

  const ch = raw.match(TIMER_CHARGE_RE);
  if (ch) {
    const cur = parseInt(ch[1], 10);
    const max = ch[2] ? parseInt(ch[2].replace(/[^\d]/g, ""), 10) : null;
    return { kind, mode: "charges", done: cur <= 0,
      pct: max ? clamp((cur / max) * 100, 0, 100) : null,
      label: cur <= 0 ? "USED UP" : `${cur} use${cur === 1 ? "" : "s"}`,
      sortKey: cur <= 0 ? Infinity : 0.5 + cur };
  }

  const turns = raw.match(/^(-?\d+)\s*\/\s*(\d+)$/);
  if (turns) {
    const cur = parseInt(turns[1], 10);
    const max = parseInt(turns[2], 10);
    return { kind, mode: "turns", done: cur <= 0,
      pct: max > 0 ? clamp((cur / max) * 100, 0, 100) : 0,
      label: cur <= 0 ? zero : `${cur} turn${cur === 1 ? "" : "s"}`,
      sortKey: cur <= 0 ? Infinity : cur };
  }

  const bare = raw.match(/^(-?\d+)$/);
  if (bare) {
    const cur = parseInt(bare[1], 10);
    return { kind, mode: "turns", done: cur <= 0, pct: null,
      label: cur <= 0 ? zero : `${cur} turn${cur === 1 ? "" : "s"}`,
      sortKey: cur <= 0 ? Infinity : cur };
  }

  const dl = parseDeadline(raw);
  if (dl !== null) {
    const left = minutesUntil(dl);
    return { kind, mode: "time", done: left <= 0, pct: null,
      label: left <= 0 ? zero : formatMinutes(left),
      sortKey: left <= 0 ? Infinity : left / 60 };
  }

  return { kind, mode: "raw", done: false, pct: null, label: raw || "?", sortKey: Infinity };
}

function timerDelta(t) {
  if (!t || t.prev == null) return "";
  const a = String(t.prev), b = String(t.value);
  if (a === b) return "";

  const pa = parseDeadline(a), pb = parseDeadline(b);
  if (pa !== null && pb !== null) {
    const d = pb - pa;
    return d ? `${d > 0 ? "▲" : "▼"}${formatMinutes(Math.abs(d))}` : "";
  }
  const na = a.match(/^(-?\d+)/), nb = b.match(/^(-?\d+)/);
  if (na && nb) {
    const d = parseInt(nb[1], 10) - parseInt(na[1], 10);
    return d ? `${d > 0 ? "▲" : "▼"}${Math.abs(d)}` : "";
  }
  return "";
}

function timerKey(t) {
  return `${String(t?.owner || "").trim().toLowerCase()}|${String(t?.name || "").trim().toLowerCase()}`;
}

// name = before first ":", kind = after last ":" (if recognized), value = the middle
function parseTimers(str) {
  const out = [];
  if (!str) return out;

  String(str).split(";").forEach((chunk) => {
    const s = chunk.trim();
    if (!s) return;

    const firstColon = s.indexOf(":");
    let left = firstColon === -1 ? s : s.slice(0, firstColon);
    let rest = firstColon === -1 ? "" : s.slice(firstColon + 1);

    let kind = "CD";
    const lastColon = rest.lastIndexOf(":");
    if (lastColon !== -1) {
      const cand = rest.slice(lastColon + 1).trim().toUpperCase();
      if (TIMER_KINDS.includes(cand)) { kind = cand; rest = rest.slice(0, lastColon); }
    } else if (TIMER_KINDS.includes(rest.trim().toUpperCase())) {
      kind = rest.trim().toUpperCase();
      rest = "";
    }

    let owner = "";
    let name = left.trim();
    const slash = name.indexOf("/");
    if (slash !== -1) {
      owner = name.slice(0, slash).trim();
      name = name.slice(slash + 1).trim();
    }
    if (!name) return;

    out.push({ owner, name, value: rest.trim(), kind });
  });
  return out;
}

function formatTimers(list) {
  if (!Array.isArray(list) || !list.length) return "";
  const clean = (s) => safePipeText(s).replace(/;/g, ",");
  return list
    .filter((t) => t && t.name)
    .map((t) => {
      const owner = String(t.owner || "").trim();
      const nm = clean(owner ? `${owner}/${t.name}` : t.name);
      return `${nm}:${clean(t.value || "0")}:${String(t.kind || "CD").toUpperCase()}`;
    })
    .join(";");
}

// Auto-repair: if the round advanced but the model left a turn timer untouched, tick it
function mergeTimers(prevState, nextState) {
  const prevList = Array.isArray(prevState?.timers) ? prevState.timers : [];
  const prevMap = new Map(prevList.map((t) => [timerKey(t), t]));

  const prevRound = prevState?.combat?.active ? toNumberOr(prevState?.combat?.round, 0) : 0;
  const nextRound = nextState?.combat?.active ? toNumberOr(nextState?.combat?.round, 0) : 0;
  const roundAdvanced = nextRound > prevRound;

  const merged = (Array.isArray(nextState.timers) ? nextState.timers : []).map((t) => {
    const old = prevMap.get(timerKey(t));
    const out = { ...t, prev: old ? old.value : null };

    if (roundAdvanced && old && String(old.value) === String(t.value)) {
      const m = String(t.value).match(/^(\d+)\s*\/\s*(\d+)$/);
      if (m && parseInt(m[1], 10) > 0) {
        out.value = `${parseInt(m[1], 10) - 1}/${m[2]}`;
        out.repaired = true;
      }
    }
    return out;
  });

  // EVENT/DOOM are long-lived appointments — a doctor's visit three days out
  // will go unmentioned for many turns. If one was dropped and hasn't fired,
  // carry it forward instead of losing it. Sourced from HISTORY, not the last
  // parse, so an EVENT invented in a swipe you abandoned doesn't follow you
  // into the new branch. Fired ones are released, and editor deletes still
  // work (the block is rewritten before the next merge reads it).
  const seen = new Set(merged.map(timerKey));
  (Array.isArray(timerMemory) ? timerMemory : []).forEach((old) => {
    if (!old || !old.name) return;
    if (!TIMER_PERSISTENT_KINDS.includes(String(old.kind || "").toUpperCase())) return;
    if (seen.has(timerKey(old))) return;
    if (timerInfo(old).done) return;
    merged.push({
      owner: old.owner || "",
      name: old.name,
      value: old.value,
      kind: String(old.kind).toUpperCase(),
      prev: null,
      kept: true,
    });
  });

  return merged;
}

// Spend one charge, keeping however the value was written (2/2x stays x).
function useTimerCharge(t) {
  const m = String(t?.value ?? "").trim().match(TIMER_CHARGE_RE);
  if (!m) return false;
  const cur = parseInt(m[1], 10);
  if (cur <= 0) return false;
  t.prev = t.value;
  t.value = `${cur - 1}${m[2] || ""}${m[3]}`;
  return true;
}

function spendTimerCharge(key) {
  const t = (rpgState.timers || []).find((x) => timerKey(x) === key);
  if (!t || !useTimerCharge(t)) return;
  renderRPG();
  writeStateBackToChatMessage(rpgState);
}

function advanceTimerTurn() {
  if (!Array.isArray(rpgState.timers)) return;
  rpgState.timers.forEach((t) => {
    const m = String(t.value || "").match(/^(\d+)\s*\/\s*(\d+)$/);
    if (m && parseInt(m[1], 10) > 0) {
      t.prev = t.value;
      t.value = `${parseInt(m[1], 10) - 1}/${m[2]}`;
      return;
    }
    const b = String(t.value || "").match(/^(\d+)$/);
    if (b && parseInt(b[1], 10) > 0) {
      t.prev = t.value;
      t.value = String(parseInt(b[1], 10) - 1);
    }
  });
  renderRPG();
  writeStateBackToChatMessage(rpgState);
}

function safeParseFloat(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function getActiveData() {
  let root = null;
  let type = "player";

  const party = Array.isArray(rpgState.party) ? rpgState.party : [];
  const enemies = Array.isArray(rpgState.enemies) ? rpgState.enemies : [];
  const npcs = Array.isArray(rpgState.npcs) ? rpgState.npcs : [];

  if (charIndex === 0) {
    root = rpgState;
    type = "player";
  } else {
    let pointer = charIndex - 1;
    if (pointer < party.length) {
      root = party[pointer];
      type = "party";
    } else {
      pointer -= party.length;
      if (pointer < enemies.length) {
        root = enemies[pointer];
        type = "enemy";
      } else {
        pointer -= enemies.length;
        if (pointer < npcs.length) {
          root = npcs[pointer];
          type = "npc";
        }
      }
    }
  }

  if (!root) return { root: rpgState, display: rpgState, type: "player", isVehicle: false };

  let display = root;
  let isVehicle = false;

  if (root.vehicle && root.vehicle.active) {
    display = root.vehicle;
    isVehicle = true;
  }

  return { root, display, type, isVehicle };
}

function getActivePointerInfo() {
  const party = Array.isArray(rpgState.party) ? rpgState.party : [];
  const enemies = Array.isArray(rpgState.enemies) ? rpgState.enemies : [];
  const npcs = Array.isArray(rpgState.npcs) ? rpgState.npcs : [];

  if (charIndex === 0) return { type: "player", idx: -1, name: rpgState?.name || "Player" };

  let pointer = charIndex - 1;

  if (pointer < party.length) {
    const unit = party[pointer];
    return { type: "party", idx: pointer, name: unit?.name || "Party Member" };
  }
  pointer -= party.length;

  if (pointer < enemies.length) {
    const unit = enemies[pointer];
    return { type: "enemy", idx: pointer, name: unit?.name || "Enemy" };
  }
  pointer -= enemies.length;

  if (pointer < npcs.length) {
    const unit = npcs[pointer];
    return { type: "npc", idx: pointer, name: unit?.name || "NPC" };
  }

  return { type: "player", idx: -1, name: rpgState?.name || "Player" };
}

function confirmDanger(title, detail) {
  const a = confirm(`⚠️ ${title}\n\n${detail}\n\nThis cannot be undone.`);
  if (!a) return false;
  const b = confirm(`⚠️ FINAL WARNING\n\nProceed with:\n${detail}\n\nClick OK to confirm permanently.`);
  return b;
}

// Move the selected character between Party, NPCs and Enemies: take their
// entry out of one section of the block and append it to another, then write
// the block back. The selection follows them to their new place, so the view
// doesn't land on whoever slid into their old slot. Everything on their entry
// (HP, stats, items, vehicle) moves with them. One thing the block itself
// decides: enemies carry no Bond on their line, so an enemy's bond lives only
// on the Bonds list.
const MOVE_KEYS = { party: "party", npc: "npcs", enemy: "enemies" };
const MOVE_LABELS = { party: "Party", npc: "NPCs", enemy: "Enemies" };

function moveActiveCharacter(toType) {
  const info = getActivePointerInfo();
  const fromKey = MOVE_KEYS[info.type], toKey = MOVE_KEYS[toType];
  if (!fromKey || !toKey || info.type === toType) return false;
  const from = rpgState[fromKey];
  if (!Array.isArray(from) || !from[info.idx]) return false;

  const [unit] = from.splice(info.idx, 1);
  if (!Array.isArray(rpgState[toKey])) rpgState[toKey] = [];
  rpgState[toKey].push(unit);
  charIndex = charIndexFor(toType, rpgState[toKey].length - 1);

  renderRPG();
  const wrote = writeStateBackToChatMessage(rpgState);
  if (!wrote) console.warn("RPG HUD: couldn't write back <rpg_state> after moving a character");
  if (window.toastr) hudToast.info(`${displayName(unit?.name, "Character")} moved to ${MOVE_LABELS[toType]}.`);
  return true;
}

function removeActiveCharacter(e) {
  if (e) e.stopPropagation();

  const info = getActivePointerInfo();
  if (info.type === "player") {
    alert("You can't delete the player. (Use Reset if needed.)");
    return;
  }

  const label =
    info.type === "party" ? "party member" :
    info.type === "enemy" ? "enemy" :
    "NPC";

  const ok = confirmDanger("DELETE CHARACTER", `Remove ${label} "${info.name}" from <rpg_state>?`);
  if (!ok) return;

  if (info.type === "party") rpgState.party.splice(info.idx, 1);
  if (info.type === "enemy") rpgState.enemies.splice(info.idx, 1);
  if (info.type === "npc") rpgState.npcs.splice(info.idx, 1);

  charIndex = 0;
  isSettingsOpen = false;
  renderRPG();

  const wrote = writeStateBackToChatMessage(rpgState);
  if (!wrote) console.warn("RPG HUD: couldn't write back <rpg_state> after removal");
}

function clearArray(type, e) {
  if (e) e.stopPropagation();

  const label =
    type === "party" ? "ALL party members" :
    type === "enemy" ? "ALL enemies" :
    "ALL NPCs";

  const ok = confirmDanger("CLEAR ARRAY", `Clear ${label} from <rpg_state>?`);
  if (!ok) return;

  if (type === "party") rpgState.party = [];
  if (type === "enemy") rpgState.enemies = [];
  if (type === "npc") rpgState.npcs = [];

  const info = getActivePointerInfo();
  if (info.type !== "player" && info.type === type) charIndex = 0;

  isSettingsOpen = false;
  renderRPG();

  const wrote = writeStateBackToChatMessage(rpgState);
  if (!wrote) console.warn("RPG HUD: couldn't write back <rpg_state> after clearing");
}

function charIndexFor(type, i) {
  const partyLen = Array.isArray(rpgState.party) ? rpgState.party.length : 0;
  const enemyLen = Array.isArray(rpgState.enemies) ? rpgState.enemies.length : 0;

  if (type === "player") return 0;
  if (type === "party") return 1 + i;
  if (type === "enemy") return 1 + partyLen + i;
  if (type === "npc") return 1 + partyLen + enemyLen + i;
  return 0;
}

function bindJumpLinks() {
  const els = document.querySelectorAll(".rpg-jump");
  els.forEach((el) => {
    el.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(el.dataset.idx);
      if (!Number.isFinite(idx)) return;

      charIndex = idx;
      isSettingsOpen = false; 
      renderRPG();
    };
  });
}

// SillyTavern substitutes macros in prompts, not in what the model writes back,
// so a block can contain a literal {{user}}. Resolve it for display only.
function displayName(raw, fallback) {
  let out = String(raw ?? "").trim();
  if (!out) return fallback ?? "";
  if (!out.includes("{{")) return out;
  let ctx = {};
  try { ctx = SillyTavern.getContext() || {}; } catch {}
  const user = ctx.name1 || ctx.user_name || "";
  const char = ctx.name2 || "";
  if (user) out = out.replace(/\{\{\s*user\s*\}\}/gi, user);
  if (char) out = out.replace(/\{\{\s*char\s*\}\}/gi, char);
  return out;
}

// the player also comes through as the placeholder "Player" on a fresh state
function playerDisplayName() {
  const raw = rpgState?.name;
  if (!raw || raw === "Player") {
    let ctx = {};
    try { ctx = SillyTavern.getContext() || {}; } catch {}
    return ctx.name1 || ctx.user_name || "Player";
  }
  return displayName(raw, "Player");
}

function getCharOptions() {
  const context = SillyTavern.getContext();
  const playerName = playerDisplayName();

  const fmt = (char, fallback) => {
    if (char.vehicle && char.vehicle.active) return `🤖 ${displayName(char.vehicle.name, "Vehicle")}`;
    return displayName(char.name, fallback);
  };

  const optStyle = "background: #222; color: #fff;";
  const groupStyle = "background: #333; color: #aaa; font-style: italic;";

  let mainLabel =
    rpgState.vehicle && rpgState.vehicle.active ? `🤖 ${rpgState.vehicle.name}` : `⭐ ${playerName}`;
  let mainColor =
    rpgState.vehicle && rpgState.vehicle.active
      ? rpgState.vehicle.type === "ship"
        ? "#00E5FF"
        : "#E040FB"
      : "#C0A040";

  let html = `<option value="0" style="${optStyle} color:${mainColor};">${escHtml(mainLabel)}</option>`;
  let idx = 1;

  const addGroup = (list, label, color, icon) => {
    if (Array.isArray(list) && list.length > 0) {
      html += `<optgroup label="${escAttr(label)}" style="${groupStyle}">`;
      list.forEach((c) => {
        let cColor = c.vehicle && c.vehicle.active ? "#E040FB" : color;
        const labelText = `${icon} ${fmt(c, "Unit")}`;
        html += `<option value="${idx}" style="${optStyle} color:${cColor};">${escHtml(labelText)}</option>`;
        idx++;
      });
      html += `</optgroup>`;
    }
  };

  addGroup(rpgState.party, "Party", "#C0A040", "🛡️");
  addGroup(rpgState.enemies, "Enemies", "#ff5252", "⚔️");
  addGroup(rpgState.npcs, "NPCs", "#00e5ff", "👤");

  return html;
}

function renderStatBox(label, rawValue) {
  let val = rawValue;
  let math = null;
  if (typeof rawValue === "string" && rawValue.includes("(")) {
    const parts = rawValue.match(/^(.+?)\s*\((.*)\)$/);
    if (parts) {
      val = parts[1];
      math = parts[2];
    }
  }

  const safeLabel = escHtml(label);
  const safeVal = escHtml(val);

  if (math) {
    const safeMath = escHtml(math);
    return `<div><div style="font-size:0.7em; color:#aaa;">${safeLabel}</div><details style="cursor:pointer;"><summary style="list-style:none; outline:none; font-weight:bold;">${safeVal} <span style="font-size:0.7em; opacity:0.7;">▼</span></summary><div style="font-size:0.7em; color:#bbb; background:rgba(0,0,0,0.5); padding:2px; border-radius:3px; position:absolute; z-index:10;">${safeMath}</div></details></div>`;
  }
  return `<div><div style="font-size:0.7em; color:#aaa;">${safeLabel}</div>${safeVal}</div>`;
}

function makeList(items, emptyText) {
  if (!Array.isArray(items) || items.length === 0)
    return `<div style="opacity:0.5; font-style:italic;">${escHtml(emptyText)}</div>`;

  return items
    .map((i) => {
      if (!i) return "";
      let text = "";
      let sub = "";

      if (typeof i === "string") {
        text = escHtml(i);

        const progressMatch = i.match(/:\s*(\d+)\s*\/\s*(\d+)/);
        if (progressMatch) {
          const val = parseFloat(progressMatch[1]);
          const max = parseFloat(progressMatch[2]);
          const pct = max > 0 ? (val / max) * 100 : 0;
          sub = `<div style="width:100%; background:#444; height:4px; margin-top:2px; border-radius:2px; overflow:hidden;"><div style="height:100%; background:#7e57c2; width:${pct}%"></div></div>`;
        }
      } else if (typeof i === "object") {
        const rawName = i.name || "Unknown";
        text = escHtml(rawName);

        let details = [];
        if (i.equipped) text = `<span style="color:#C0A040;">★</span> ${text}`;
        if (i.cost) details.push(`<span style="color:#90caf9;">${escHtml(i.cost)}</span>`);
        if (i.type) details.push(`<span style="color:#aaa;">${escHtml(i.type)}</span>`);
        if (i.effect) details.push(`<span style="color:#bbb; font-style:italic;">${escHtml(i.effect)}</span>`);

        if (details.length > 0) {
          sub = `<div style="font-size:0.75em; margin-left:8px; line-height:1.2; opacity:0.9;">${details.join(" | ")}</div>`;
        }
      }

      return `<div style="padding:4px 0; border-bottom:1px solid #333;">• ${text}${sub}</div>`;
    })
    .join("");
}

function renderEnemySummary() {
  if (!Array.isArray(rpgState.enemies) || rpgState.enemies.length === 0) return "";
  if (isSysSkin()) {
    return `<div class="sys-foes">${sysUnitList(rpgState.enemies, { title: "HOSTILES", jumpType: "enemy", foe: true, hpOnly: true })}</div>`;
  }

  let html =
    '<div style="border-top:1px solid #b71c1c; margin-top:5px; padding-top:5px; font-size:0.75em;">' +
    '<div style="color:#ff5252; font-weight:bold; margin-bottom:2px;">⚔️ Active Hostiles</div>';

  rpgState.enemies.forEach((enemy, idx) => {
    const target = enemy?.vehicle && enemy.vehicle.active ? enemy.vehicle : enemy;

    const hpCurr = safeParseFloat(target?.hp_curr, 0);
    const hpMax = safeParseFloat(target?.hp_max, 0);
    const hpPercent = percentFrom(target?.hp_curr, target?.hp_max);
    const barColor = enemy?.vehicle && enemy.vehicle.active ? "#AB47BC" : "#d32f2f";

    html += `
      <div style="margin-bottom:6px;">
        <div style="display:flex; justify-content:space-between; color:#aaa;">
          <span class="rpg-jump" data-idx="${charIndexFor("enemy", idx)}"
                style="cursor:pointer; text-decoration:underline; text-decoration-color:#555;">
            ${escHtml(target?.name || "Enemy")}
          </span>
          <span>${hpCurr}/${hpMax}</span>
        </div>
        <div style="width:100%; background:#333; height:4px; border-radius:2px; overflow:hidden;">
          <div style="height:100%; background:${barColor}; width:${hpPercent}%"></div>
        </div>
      </div>`;
  });

  html += "</div>";
  return html;
}

// --- PARTY TAB (mini HP/MP bars) ---
function renderMiniUnitBars(list, options = {}) {
  const {
    title = "Units",
    titleColor = "#C0A040",
    barHpColor = "#4caf50",
    barMpColor = "#1976d2",
    emptyText = "",
    jumpType = null, 
  } = options;

  if (!Array.isArray(list) || list.length === 0) {
    return `
      <div style="margin-bottom:8px;">
        <div style="color:${titleColor}; font-weight:bold; margin-bottom:4px;">${escHtml(title)}</div>
        <div style="opacity:0.5; font-style:italic;">${escHtml(emptyText)}</div>
      </div>`;
  }

  const rows = list
    .map((unit, idx) => {
      const target = unit?.vehicle && unit.vehicle.active ? unit.vehicle : unit;
      const name = escHtml(displayName(target?.name || unit?.name, "Unit"));

      const absIdx = jumpType ? charIndexFor(jumpType, idx) : null;

      const nameHtml =
        absIdx !== null
          ? `<span class="rpg-jump" data-idx="${absIdx}"
                    style="cursor:pointer; text-decoration:underline; text-decoration-color:#555;">
                 ${name}
               </span>`
          : `<span>${name}</span>`;

      const hpCurr = safeParseFloat(target?.hp_curr, 0);
      const hpMax = safeParseFloat(target?.hp_max, 0);
      const isVeh = !!(unit?.vehicle && unit.vehicle.active);
      const { curr: eCurr, max: eMax, label: eLabel } = getEnergy(target, isVeh);
      const eCurrNum = safeParseFloat(eCurr, 0);
      const eMaxNum  = safeParseFloat(eMax, 0);

      const hpPct = percentFrom(target?.hp_curr, target?.hp_max);
      const mpPct  = percentFrom(eCurr, eMax);

      const hpColor = unit?.vehicle && unit.vehicle.active ? "#AB47BC" : barHpColor;

      return `
        <div style="margin-bottom:8px;">
          <div style="display:flex; justify-content:space-between; color:#aaa; font-size:0.85em;">
            <span>${nameHtml}</span>
            <span>HP ${hpCurr}/${hpMax} · ${escHtml(eLabel)} ${eCurrNum}/${eMaxNum}</span>
          </div>

          <div style="width:100%; background:#333; height:4px; border-radius:2px; overflow:hidden; margin-top:2px;">
            <div style="height:100%; background:${hpColor}; width:${hpPct}%"></div>
          </div>

          <div style="width:100%; background:#333; height:4px; border-radius:2px; overflow:hidden; margin-top:2px;">
            <div style="height:100%; background:${barMpColor}; width:${mpPct}%"></div>
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <div style="margin-bottom:8px;">
      <div style="color:${titleColor}; font-weight:bold; margin-bottom:4px;">${escHtml(title)}</div>
      ${rows}
    </div>`;
}

function renderPartyTab() {
  const party = Array.isArray(rpgState.party) ? rpgState.party : [];
  const npcs = Array.isArray(rpgState.npcs) ? rpgState.npcs : [];
  if (isSysSkin()) {
    return sysUnitList(party, { title: "PARTY", jumpType: "party", emptyText: "No party members" })
      + sysUnitList(npcs, { title: "NPCS", jumpType: "npc", emptyText: "No NPCs" });
  }

  const partyHtml = renderMiniUnitBars(party, {
    title: "🛡️ Party",
    titleColor: "#C0A040",
    barHpColor: "#4caf50",
    barMpColor: "#1976d2",
    emptyText: "No party members",
    jumpType: "party",
  });

  const npcHtml = renderMiniUnitBars(npcs, {
    title: "👤 NPCs",
    titleColor: "#00e5ff",
    barHpColor: "#4caf50",
    barMpColor: "#1976d2",
    emptyText: "No NPCs",
    jumpType: "npc",
  });

  const divider = party.length && npcs.length ? `<div style="border-top:1px solid #444; margin:8px 0;"></div>` : "";
  return `${partyHtml}${divider}${npcHtml}`;
}

// Bond Tracker
function renderBondsTab() {
  if (!Array.isArray(rpgState.bonds)) rpgState.bonds = [];
  const list = rpgState.bonds;

  const party = Array.isArray(rpgState.party) ? rpgState.party : [];
  const npcs = Array.isArray(rpgState.npcs) ? rpgState.npcs : [];

  const jumpIdxFor = (name) => {
    const key = normBondName(name);
    let i = party.findIndex((u) => normBondName(u?.name) === key);
    if (i !== -1) return charIndexFor("party", i);
    i = npcs.findIndex((u) => normBondName(u?.name) === key);
    if (i !== -1) return charIndexFor("npc", i);
    return null;
  };

  const btn = (id, text, color) =>
    `<button id="${id}" style="background:#333; border:1px solid ${color}; color:${color};
      cursor:pointer; font-size:0.9em; padding:1px 7px; font-weight:bold;">${text}</button>`;

  const SYS = isSysSkin();
  const header = `
    <div class="${SYS ? "sys-tabhead" : ""}" style="display:flex; justify-content:space-between; align-items:center; gap:4px; margin-bottom:4px;">
      ${SYS ? `<span>${sysIcon("bond")}BONDS</span>` : `<span style="color:#f06292; font-weight:bold;">❤️ Bonds</span>`}
      <span style="display:flex; gap:4px;">
        ${bondsEditMode ? btn("rpg-bond-add", "+", "#69f0ae") : ""}
        ${bondsEditMode ? btn("rpg-bond-edit", "✓", "#69f0ae") : btn("rpg-bond-edit", "✎", "#4FC3F7")}
      </span>
    </div>`;

  if (!list.length && !bondsEditMode) {
    return header + `<div style="opacity:0.5; font-style:italic;">No bonds recorded</div>`;
  }

  if (bondsEditMode) {
    const rows = list
      .map((b, i) => {
        const val = parseBondValue(b?.bond);
        const label = val >= 101 ? "∞" : String(val);
        return `
        <div style="display:flex; gap:4px; align-items:center; padding:2px 0; border-bottom:1px solid #333;">
          <input class="rpg-bond-name" data-i="${i}" type="text" value="${escAttr(b?.name ?? "")}"
            style="flex:1 1 auto; min-width:0; background:#222; border:1px solid #555; color:#fff;
                   font-family:inherit; font-size:1em;">
          <input class="rpg-bond-val" data-i="${i}" type="text" value="${escAttr(label)}"
            style="flex:0 0 46px; width:46px; background:#222; border:1px solid #555; color:#f06292;
                   font-family:inherit; font-size:1em; text-align:center;">
          <button class="rpg-bond-del" data-i="${i}" title="Delete"
            style="flex:0 0 auto; background:#333; border:1px solid #ff5252; color:#ff5252;
                   cursor:pointer; font-size:0.85em; padding:1px 5px; font-weight:bold;">✕</button>
        </div>`;
      })
      .join("");

    return (
      header +
      rows +
      `<div style="font-size:0.7em; color:#666; margin-top:4px; line-height:1.3;">
         Blank name deletes the row. ✓ writes to the message.
       </div>`
    );
  }

  const rows = [...list]
    .sort((a, b) => parseBondValue(b.bond) - parseBondValue(a.bond))
    .map((b) => {
      const val = parseBondValue(b.bond);
      const label = val >= 101 ? "∞" : String(val);
      const pct = val >= 101 ? 100 : clamp(Math.abs(val), 0, 100);
      const color = val < 0 ? "#ff5252" : "#f06292";
      const idx = jumpIdxFor(b.name);
      const dot = idx !== null
        ? `<span title="In scene" style="color:#69f0ae;">●</span>`
        : `<span title="Away" style="color:#666;">○</span>`;
      const nameHtml = idx !== null
        ? `<span class="rpg-jump" data-idx="${idx}" style="cursor:pointer; text-decoration:underline; text-decoration-color:#555;">${escHtml(displayName(b.name))}</span>`
        : `<span>${escHtml(displayName(b.name))}</span>`;

      // Change since the previous message's block. null prev = brand new name.
      const hasBaseline = Object.prototype.hasOwnProperty.call(b, "prev");
      const prevVal = !hasBaseline || b.prev === null ? null : parseBondValue(b.prev);
      const diff = prevVal === null ? 0 : val - prevVal;
      const deltaHtml = !hasBaseline
        ? ""
        : prevVal === null
        ? `<span title="New to the ledger" style="font-size:0.75em; color:#69f0ae;"> NEW</span>`
        : diff
          ? `<span title="Was ${escAttr(prevVal >= 101 ? "∞" : String(prevVal))}"
                   style="font-size:0.75em; color:${diff > 0 ? "#69f0ae" : "#ff5252"};"> ${diff > 0 ? "▲" : "▼"}${Math.abs(diff)}</span>`
          : "";

      // Ghost segment on the bar showing where it moved from.
      const prevPct = prevVal === null ? null : (prevVal >= 101 ? 100 : clamp(Math.abs(prevVal), 0, 100));
      const ghost = prevPct === null || prevPct === pct ? "" : `
            <div style="position:absolute; top:0; height:100%; opacity:0.45;
                        left:${Math.min(pct, prevPct)}%; width:${Math.abs(pct - prevPct)}%;
                        background:${diff > 0 ? "#69f0ae" : "#ff5252"};"></div>`;

      if (SYS) {
        const tint = val < 0 ? "#ff6b6b" : "#f48fb1";
        const ghostS = prevPct === null || prevPct === pct ? "" :
          `<s style="left:${Math.min(pct, prevPct)}%; width:${Math.abs(pct - prevPct)}%; background:${diff > 0 ? "#7ef0c0" : "#ff6b6b"};"></s>`;
        return `
        <div class="sys-unit">
          <div class="sys-unit-head">
            <span class="sys-dot${idx !== null ? " on" : ""}" title="${idx !== null ? "In scene" : "Away"}"></span>
            ${idx !== null
              ? `<span class="rpg-jump" data-idx="${idx}">${escHtml(displayName(b.name))}</span>`
              : `<span class="nm">${escHtml(displayName(b.name))}</span>`}
            <span class="sys-unit-val" style="color:${tint};">${escHtml(label)}/100${deltaHtml}</span>
          </div>
          <div class="sys-cap sm tint" style="--mc:${tint}"><div class="sys-track"><i style="width:${Math.min(pct, prevPct === null ? pct : prevPct)}%"></i>${ghostS}</div></div>
        </div>`;
      }

      return `
        <div style="padding:4px 0; border-bottom:1px solid #333;">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
            <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${dot} ${nameHtml}</span>
            <span style="color:${color}; flex:0 0 auto;">${escHtml(label)}/100${deltaHtml}</span>
          </div>
          <div style="position:relative; width:100%; background:#333; height:4px; border-radius:2px; overflow:hidden; margin-top:3px;">
            <div style="height:100%; background:${color}; width:${Math.min(pct, prevPct === null ? pct : prevPct)}%"></div>${ghost}
          </div>
        </div>`;
    })
    .join("");

  return header + rows;
}

// Read the live inputs back into state WITHOUT re-rendering (keeps focus)
function readBondInputs() {
  if (!Array.isArray(rpgState.bonds)) return;
  document.querySelectorAll(".rpg-bond-name").forEach((el) => {
    const i = Number(el.dataset.i);
    if (rpgState.bonds[i]) rpgState.bonds[i].name = el.value;
  });
  document.querySelectorAll(".rpg-bond-val").forEach((el) => {
    const i = Number(el.dataset.i);
    if (rpgState.bonds[i]) {
      rpgState.bonds[i].bond = clamp(parseBondValue(el.value), Number.NEGATIVE_INFINITY, 101);
    }
  });
}

function commitBondsEdit() {
  readBondInputs();

  const cleaned = [];
  (rpgState.bonds || []).forEach((b) => {
    if (b && String(b.name || "").trim()) upsertBond(cleaned, b.name, b.bond);
  });

  const nowKeys = new Set(cleaned.map((b) => normBondName(b.name)));
  let removed = bondsSnapshot.filter((b) => !nowKeys.has(normBondName(b.name)));

  // Ask BEFORE anything is written. Cancel puts them back; the rest of the
  // edit (renames, new values) still applies.
  if (removed.length) {
    const label = removed.map((b) => b.name).join(", ");
    const sure = confirm(`Remove ${removed.length === 1 ? "this bond" : "these bonds"}?\n\n${label}\n\nCancel keeps them.`);
    if (!sure) {
      removed.forEach((b) => upsertBond(cleaned, b.name, b.bond));
      removed = [];
    }
  }

  rpgState.bonds = cleaned;

  // Party members and NPCs carry their own |Bond:| value, and the block writer
  // copies those INTO the ledger before writing. An edited value is pushed onto
  // the character's line too, or their old value would be copied straight back
  // over the edit. A removed bond leaves the character's own value alone: the
  // name is blocked instead, BEFORE writing, which keeps it out of the ledger.
  [...(rpgState.party || []), ...(rpgState.npcs || [])].forEach((u) => {
    const key = normBondName(u?.name);
    if (!key) return;
    const edited = cleaned.find((b) => normBondName(b.name) === key);
    const hasLive = u.bond !== undefined && u.bond !== null && String(u.bond).trim() !== "";
    if (edited && hasLive) u.bond = edited.bond;
  });
  const names = removed.map((b) => b.name);
  if (names.length) blockBonds(names);

  bondsEditMode = false;
  bondsSnapshot = [];
  renderRPG();

  const ok = writeStateBackToChatMessage(rpgState);
  if (!ok) console.warn("RPG HUD: couldn't write back <rpg_state> after bond edit");
  if (!removed.length) return;

  const scrub = confirm(
    `Also remove ${names.length === 1 ? "it" : "them"} from ALL earlier messages?\n\n` +
    `If you skip this, the AI can still see them in older Bonds lists. They stay blocked either way, ` +
    `and the characters keep their own Bond values.\n\n` +
    `This edits your chat history and cannot be undone.`
  );
  if (scrub) {
    const n = purgeBondsFromHistory(names);
    if (window.toastr) hudToast.info(`Scrubbed ${names.length} name(s) from ${n} message(s).`);
  } else if (window.toastr) {
    hudToast.info(`${names.length} bond(s) removed and blocked from returning.`);
  }
}

function flushBondsEdit() {
  if (bondsEditMode) commitBondsEdit();
}

function bindBondsTab() {
  const editBtn = document.getElementById("rpg-bond-edit");
  if (editBtn) {
    editBtn.onclick = (e) => {
      e.stopPropagation();
      if (bondsEditMode) {
        commitBondsEdit();
      } else {
        bondsEditMode = true;
		bondsSnapshot = (rpgState.bonds || []).filter((b) => b && b.name).map((b) => ({ ...b }));
        renderRPG();
      }
    };
  }

  const addBtn = document.getElementById("rpg-bond-add");
  if (addBtn) {
    addBtn.onclick = (e) => {
      e.stopPropagation();
      readBondInputs();
      if (!Array.isArray(rpgState.bonds)) rpgState.bonds = [];
      rpgState.bonds.push({ name: "", bond: 0 });
      renderRPG();
      const inputs = document.querySelectorAll(".rpg-bond-name");
      inputs[inputs.length - 1]?.focus();
    };
  }

  document.querySelectorAll(".rpg-bond-del").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      readBondInputs();
      const i = Number(el.dataset.i);
      if (Number.isFinite(i)) rpgState.bonds.splice(i, 1);
      renderRPG();
    };
  });

  document.querySelectorAll(".rpg-bond-name, .rpg-bond-val").forEach((el) => {
    el.onclick = (e) => e.stopPropagation();
  });
}

function renderTimersTab() {
  if (!Array.isArray(rpgState.timers)) rpgState.timers = [];
  const list = rpgState.timers;

  const btn = (id, text, color, title) =>
    `<button id="${id}" title="${escAttr(title || "")}" style="background:#333; border:1px solid ${color};
      color:${color}; cursor:pointer; font-size:0.9em; padding:1px 7px; font-weight:bold;">${text}</button>`;

  const SYS = isSysSkin();
  const header = `
    <div class="${SYS ? "sys-tabhead" : ""}" style="display:flex; justify-content:space-between; align-items:center; gap:4px; margin-bottom:4px;">
      ${SYS ? `<span>${sysIcon("timer")}TIMERS</span>` : `<span style="color:#90caf9; font-weight:bold;">⏱️ Timers</span>`}
      <span style="display:flex; gap:4px;">
        ${timersEditMode ? btn("rpg-timer-add", "+", "#69f0ae", "Add") : btn("rpg-timer-turn", SYS ? sysIcon("skip") : "⏭", "#C0A040", "Advance one turn")}
        ${timersEditMode ? btn("rpg-timer-edit", "✓", "#69f0ae", "Save") : btn("rpg-timer-edit", "✎", "#4FC3F7", "Edit")}
      </span>
    </div>`;

  if (!list.length && !timersEditMode) {
    return header + `<div style="opacity:0.5; font-style:italic;">No active timers</div>`;
  }

  if (timersEditMode) {
    const opts = (sel) =>
      TIMER_KINDS.map((k) => `<option value="${k}" ${String(sel).toUpperCase() === k ? "selected" : ""}>${k}</option>`).join("");

    const rows = list.map((t, i) => `
      <div style="display:flex; gap:3px; align-items:center; padding:2px 0; border-bottom:1px solid #333;">
        <input class="rpg-timer-name" data-i="${i}" type="text" value="${escAttr(t?.owner ? t.owner + "/" + t.name : (t?.name ?? ""))}"
          style="flex:1 1 auto; min-width:0; background:#222; border:1px solid #555; color:#fff; font-family:inherit; font-size:1em;">
        ${(() => {
          // a deadline still ahead is edited as time left; the date is kept
          // as written unless this field is changed
          const dl = parseDeadline(t?.value);
          const left = dl === null ? null : minutesUntil(dl);
          const shown = left !== null && left > 0 ? durationText(left) : String(t?.value ?? "");
          return `<input class="rpg-timer-val" data-i="${i}" type="text" value="${escAttr(shown)}" data-shown="${escAttr(shown)}"
            title="${left !== null && left > 0 ? escAttr("Time left. Due " + String(t.value)) : ""}"
            style="flex:0 0 78px; width:78px; background:#222; border:1px solid #555; color:${left !== null && left > 0 ? "#ce93d8" : "#90caf9"}; font-family:inherit; font-size:1em; text-align:center;">`;
        })()}
        <select class="rpg-timer-kind" data-i="${i}"
          style="flex:0 0 62px; background:#222; border:1px solid #555; color:#ddd; font-family:inherit; font-size:0.9em;">${opts(t?.kind)}</select>
        <button class="rpg-timer-del" data-i="${i}" title="Delete"
          style="flex:0 0 auto; background:#333; border:1px solid #ff5252; color:#ff5252; cursor:pointer; font-size:0.85em; padding:1px 5px; font-weight:bold;">✕</button>
      </div>`).join("");

    return header + rows + `
      <div style="font-size:0.7em; color:#666; margin-top:4px; line-height:1.35;">
        Value: <span style="color:#888;">2/3</span> (turns), <span style="color:#888;">2/2x</span> (uses), or time left like
        <span style="color:#ce93d8;">1d 3h</span> / <span style="color:#ce93d8;">45m</span>, saved as a deadline date for the AI.<br>
        <span style="color:#ce93d8;">EVENT</span> = appointment · <span style="color:#ff5252;">DOOM</span> = threat. Both survive being dropped.<br>
        Name may be <span style="color:#888;">Owner/Skill</span>. Blank name deletes.
      </div>`;
  }

  const rows = list
    .map((t, i) => ({ t, i, info: timerInfo(t) }))
    .sort((a, b) => {
      const ka = KIND_RANK[a.info.kind] ?? 9, kb = KIND_RANK[b.info.kind] ?? 9;
      if (ka !== kb) return ka - kb;
      return a.info.sortKey - b.info.sortKey;
    })
    .map(({ t, info }) => {
      const st = timerKindStyle(info.kind);
      const dim = info.done && !TIMER_PERSISTENT_KINDS.includes(info.kind) ? "opacity:0.55;" : "";
      const delta = timerDelta(t);
      const ownerTag = t.owner
        ? `<span style="font-size:0.75em; color:#888;">${escHtml(t.owner)}·</span>`
        : "";
      const mark = t.repaired ? `<span title="Auto-ticked by the HUD" style="color:#C0A040;">*</span>` : "";
      const keptMark = t.kept ? `<span title="Carried over — the model stopped listing it" style="color:#888;">°</span>` : "";
      const bar = info.pct === null ? "" : `
        <div style="width:100%; background:#333; height:3px; border-radius:2px; overflow:hidden; margin-top:3px;">
          <div style="height:100%; background:${st.color}; width:${info.pct}%"></div>
        </div>`;

      if (SYS) {
        const use = info.mode === "charges" && !info.done
          ? `<button class="rpg-c-tuse" data-key="${escAttr(timerKey(t))}" title="Use one charge"
               style="margin-left:2px; padding:0 5px; font-size:0.85em; line-height:1.4; cursor:pointer;
                      background:rgba(var(--t-10_26_48, 10,26,48),.9); color:var(--t-dff1ff, #dff1ff); border:1px solid rgba(var(--t-143_208_255, 143,208,255),.55);">\u22121</button>` : "";
        return `
        <div class="sys-unit${dim ? " dim" : ""}">
          <div class="sys-unit-head">
            <span class="sys-tkind" style="--tc:${st.color}">${sysIcon(SYS_TIMER_ICON[info.kind] || "hourglass")}</span>
            <span class="nm">${ownerTag}${escHtml(t.name)}${mark}${keptMark}</span>
            <span class="sys-unit-val" style="color:${st.color};">${escHtml(info.label)}${delta ? `<span class="d" style="color:var(--t-8aa3b8, #8aa3b8);">${escHtml(delta)}</span>` : ""}${use}</span>
          </div>
          ${info.pct === null ? "" : `<div class="sys-cap sm tint" style="--mc:${st.color}"><i style="width:${info.pct}%"></i></div>`}
        </div>`;
      }

      return `
        <div style="padding:4px 0; border-bottom:1px solid #333; ${dim}">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
            <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              ${st.icon} ${ownerTag}${escHtml(t.name)}${mark}${keptMark}
            </span>
            <span style="flex:0 0 auto; color:${st.color};">
              ${escHtml(info.label)}
              ${delta ? `<span style="font-size:0.75em; color:#888;"> ${escHtml(delta)}</span>` : ""}
              ${info.mode === "charges" && !info.done
                ? `<button class="rpg-c-tuse" data-key="${escAttr(timerKey(t))}" title="Use one charge"
                     style="margin-left:4px; padding:0 5px; font-size:0.85em; line-height:1.4; cursor:pointer;
                            background:#333; color:#ddd; border:1px solid #666; border-radius:2px;">\u22121</button>`
                : ""}
            </span>
          </div>
          ${bar}
        </div>`;
    })
    .join("");

  return header + rows;
}

function readTimerInputs() {
  if (!Array.isArray(rpgState.timers)) return;
  document.querySelectorAll(".rpg-timer-name").forEach((el) => {
    const i = Number(el.dataset.i);
    if (!rpgState.timers[i]) return;
    const raw = String(el.value || "").trim();
    const slash = raw.indexOf("/");
    const looksOwned = slash !== -1 && !/^\d+\s*\/\s*\d+$/.test(raw);
    rpgState.timers[i].owner = looksOwned ? raw.slice(0, slash).trim() : "";
    rpgState.timers[i].name = looksOwned ? raw.slice(slash + 1).trim() : raw;
  });
  document.querySelectorAll(".rpg-timer-val").forEach((el) => {
    const i = Number(el.dataset.i);
    const t = rpgState.timers[i];
    if (!t) return;
    const typed = String(el.value || "").trim();
    if (el.dataset.shown !== undefined && typed === el.dataset.shown) return;   // untouched: keep the date as it was
    const mins = parseDuration(typed);
    t.value = mins !== null && mins > 0 ? deadlineText(nowWorldMinutes() + mins) : typed;
    el.dataset.shown = typed;
  });
  document.querySelectorAll(".rpg-timer-kind").forEach((el) => {
    const i = Number(el.dataset.i);
    if (rpgState.timers[i]) rpgState.timers[i].kind = String(el.value || "CD").toUpperCase();
  });
}

function commitTimersEdit() {
  readTimerInputs();

  const cleaned = (rpgState.timers || []).filter((t) => t && String(t.name || "").trim());
  const nowKeys = new Set(cleaned.map(timerKey));
  let removed = timersSnapshot.filter((t) => !nowKeys.has(timerKey(t)));

  if (removed.length) {
    const label = removed.map((t) => (t.owner ? `${t.owner}/${t.name}` : t.name)).join(", ");
    const sure = confirm(`Remove ${removed.length === 1 ? "this timer" : "these timers"}?\n\n${label}\n\nCancel keeps them.`);
    if (!sure) {
      removed.forEach((t) => cleaned.push({ ...t }));
      removed = [];
    }
  }

  rpgState.timers = cleaned;
  timersEditMode = false;
  timersSnapshot = [];
  renderRPG();

  const ok = writeStateBackToChatMessage(rpgState);
  if (!ok) console.warn("RPG HUD: couldn't write back <rpg_state> after timer edit");
  if (!removed.length) return;

  const scrub = confirm(
    `Also remove ${removed.length === 1 ? "it" : "them"} from ALL earlier messages?\n\n` +
    `If you skip this, the AI can still see them in older blocks and may add them back.\n\n` +
    `This edits your chat history and cannot be undone.`
  );
  if (scrub) {
    const n = purgeTimersFromHistory(removed);
    if (window.toastr) hudToast.info(`Scrubbed ${removed.length} timer(s) from ${n} message(s).`);
  }
}

function bindTimersTab() {
  const editBtn = document.getElementById("rpg-timer-edit");
  if (editBtn) {
    editBtn.onclick = (e) => {
      e.stopPropagation();
      if (timersEditMode) commitTimersEdit();
      else {
        timersSnapshot = (rpgState.timers || [])
          .filter((t) => t && String(t.name || "").trim())
          .map((t) => ({ ...t }));
        timersEditMode = true;
        renderRPG();
      }
    };
  }

  const turnBtn = document.getElementById("rpg-timer-turn");
  if (turnBtn) turnBtn.onclick = (e) => { e.stopPropagation(); advanceTimerTurn(); };

  const addBtn = document.getElementById("rpg-timer-add");
  if (addBtn) {
    addBtn.onclick = (e) => {
      e.stopPropagation();
      readTimerInputs();
      if (!Array.isArray(rpgState.timers)) rpgState.timers = [];
      rpgState.timers.push({ owner: "", name: "", value: "1/1", kind: "CD" });
      renderRPG();
      const inputs = document.querySelectorAll(".rpg-timer-name");
      inputs[inputs.length - 1]?.focus();
    };
  }

  document.querySelectorAll(".rpg-timer-del").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      readTimerInputs();
      const i = Number(el.dataset.i);
      if (Number.isFinite(i)) rpgState.timers.splice(i, 1);
      renderRPG();
    };
  });

  document.querySelectorAll(".rpg-timer-name, .rpg-timer-val, .rpg-timer-kind").forEach((el) => {
    el.onclick = (e) => e.stopPropagation();
  });
}

function flushInlineEdits() {
  if (bondsEditMode) commitBondsEdit();
  if (timersEditMode) commitTimersEdit();
}

// Strips bond after deleting
// Strips a name from the |Bonds:| ledger AND from any live |Bond:| value on
// that character's own line. bondMemoryFromHistory reads both, so clearing
// only the ledger left the bond recoverable from history and it would return.
function stripBondsFromText(text, keys) {
  return String(text).replace(
    /(<rpg_state\b[^>]*>)([\s\S]*?)(<\/rpg_state>)/gi,
    (full, open, body, close) => {
      let newBody = body.replace(/\|Bonds:([^|]*)\|/gi, (m, val) => {
        const kept = String(val)
          .split(";")
          .map((x) => x.trim())
          .filter(Boolean)
          .filter((chunk) => {
            const i = chunk.lastIndexOf(":");
            const nm = i === -1 ? chunk : chunk.slice(0, i);
            return !keys.has(normBondName(nm));
          });
        return `|Bonds:${kept.join(";")}|`;
      });

      // Characters' own |Bond:| values are left alone: only the ledger is
      // scrubbed. The name is blocked, which keeps it out of the ledger.
      return open + newBody + close;
    }
  );
}

function purgeBondsFromHistory(names) {
  const keys = new Set((names || []).map(normBondName).filter(Boolean));
  if (!keys.size) return 0;

  const chat = SillyTavern.getContext()?.chat;
  if (!Array.isArray(chat)) return 0;

  let changed = 0;
  chat.forEach((msg) => {
    if (!msg || typeof msg.mes !== "string") return;
    if (!/<rpg_state\b/i.test(msg.mes)) return;

    const next = stripBondsFromText(msg.mes, keys);
    if (next !== msg.mes) {
      msg.mes = next;
      changed++;
    }
    // alternate swipes hold their own copy of the block
    if (Array.isArray(msg.swipes)) {
      msg.swipes = msg.swipes.map((s) =>
        typeof s === "string" ? stripBondsFromText(s, keys) : s
      );
    }
  });

  if (changed) {
    invalidateHistoryMemory();
    try { window.saveChat?.(); } catch (e) { console.warn("RPG HUD: saveChat failed", e); }
  }
  return changed;
}

// --- TIMER HISTORY SCRUB (mirrors the bond version) ---
// keys are "owner|name", lowercased — same shape as timerKey()
function stripTimersFromText(text, keys) {
  return String(text).replace(
    /(<rpg_state\b[^>]*>)([\s\S]*?)(<\/rpg_state>)/gi,
    (full, open, body, close) => {
      const newBody = body.replace(/\|Timers:([^|]*)\|/gi, (m, val) => {
        const kept = parseTimers(val).filter((t) => !keys.has(timerKey(t)));
        return `|Timers:${formatTimers(kept)}|`;
      });
      return open + newBody + close;
    }
  );
}

function purgeTimersFromHistory(list) {
  const keys = new Set((list || []).map(timerKey).filter((k) => k && k !== "|"));
  if (!keys.size) return 0;

  const chat = SillyTavern.getContext()?.chat;
  if (!Array.isArray(chat)) return 0;

  let changed = 0;
  chat.forEach((msg) => {
    if (!msg || typeof msg.mes !== "string") return;
    if (!/<rpg_state\b/i.test(msg.mes)) return;

    const next = stripTimersFromText(msg.mes, keys);
    if (next !== msg.mes) {
      msg.mes = next;
      changed++;
    }
    // alternate swipes hold their own copy of the block
    if (Array.isArray(msg.swipes)) {
      msg.swipes = msg.swipes.map((s) =>
        typeof s === "string" ? stripTimersFromText(s, keys) : s
      );
    }
  });

  if (changed) {
    invalidateHistoryMemory();
    try { window.saveChat?.(); } catch (e) { console.warn("RPG HUD: saveChat failed", e); }
  }
  return changed;
}

// --- METERS (generic bar stats) ---
function meterKey(name) {
  return String(name || "").trim().toLowerCase();
}

function meterColorByName(name) {
  const custom = uiSettings?.meterColors?.[meterKey(name)];
  if (custom && /^#[0-9a-f]{6}$/i.test(custom)) return custom;
  return meterAutoColor(name);
}

// the name-guessing fallback, kept separate so "reset colour" has a target
function meterAutoColor(name) {
  const k = String(name || "").toLowerCase();
  if (k.includes("shield") || k.includes("barrier")) return "#00bcd4";
  if (k.includes("temp") && k.includes("hp")) return "#ff9800";
  if (k.includes("stamina") || k.includes("energy")) return "#ffd54f";
  if (k.includes("sanity") || k.includes("mind")) return "#64b5f6";
  if (k.includes("hunger") || k.includes("food")) return "#81c784";
  if (k.includes("thirst") || k.includes("water")) return "#4dd0e1";
  if (k.includes("heat") || k.includes("temp")) return "#ff7043";
  if (k.includes("corrupt") || k.includes("taint")) return "#ba68c8";
  if (k.includes("rad") || k.includes("toxin") || k.includes("poison")) return "#cddc39";
  return "#26a69a";
}

function renderMeters(meters, editable = false) {
  if (!Array.isArray(meters) || meters.length === 0) return "";

  const rows = meters
    .map((m) => {
      if (!m || typeof m !== "object") return "";
      const name = m.name ?? m.label ?? "Meter";
      const curr = m.curr ?? m.value ?? 0;
      const max = m.max ?? 100;

      const c = meterColorByName(name);

      const maxNum = safeParseFloatOrInf(max, 0);
      if (Number.isFinite(maxNum) && maxNum <= 0) return "";

      const pct = percentFrom(curr, max);

      return `
        <div style="margin-top:4px;">
          <div style="display:flex; justify-content:space-between; font-size:0.72em; color:${c};">
            <span${editable ? ` data-meter-edit title="Tap to edit meters" style="cursor:pointer;"` : ""}>${escHtml(name)}</span>
            <span>${renderInlineValue(curr)} / ${renderInlineValue(max)}</span>
          </div>
          <div style="width:100%; background:#222; height:3px; border-radius:2px; overflow:hidden;">
            <div style="height:100%; background:${c}; width:${pct}%"></div>
          </div>
        </div>
      `;
    })
    .join("");

  if (!rows.trim()) return "";
  return `<div style="margin-top:6px; padding-top:6px; border-top:1px dashed #444;">${rows}</div>`;
}

function findLatestRpgMessageIndex(chat) {
  if (!Array.isArray(chat)) return -1;
  const regex = /<rpg_state\b[^>]*>[\s\S]*?<\/rpg_state>/i;
  for (let i = chat.length - 1; i >= 0; i--) {
    const msg = chat[i];
    if (msg && !msg.is_user && typeof msg.mes === "string" && regex.test(msg.mes)) return i;
  }
  return -1;
}

// ---- OOC note for manual edits ----
// Edit state -> Save leaves one line in the block telling the AI what you
// changed by hand, so it treats the new values as canon instead of explaining
// or undoing them. It's written "(OOC: ...)": the parser takes any line
// starting with "[" as a section header, which would scramble what follows,
// while a line with no pipes is skipped. Older blocks carrying it drop out of
// the AI's view through your own regex after a few messages.
const OOC_PREFIX = "(OOC: The user manually edited the state: ";
const OOC_SUFFIX = " Treat these as canon. Don't reply to or mention this note, and don't copy it into your next <rpg_state>.)";
const OOC_LINE_RE = /^[ \t]*\(OOC:[^\n]*\)[ \t]*$/gim;

function oocNoteFor(changes) {
  return `${OOC_PREFIX}${changes.join("; ")}.${OOC_SUFFIX}`;
}

// what an existing HUD note in this block already lists, to merge new edits in
function oocNoteChanges(blockText) {
  const line = (String(blockText || "").match(OOC_LINE_RE) || []).find((l) => l.trim().startsWith(OOC_PREFIX));
  if (!line) return [];
  const body = line.trim().slice(OOC_PREFIX.length);
  const end = body.lastIndexOf("." + OOC_SUFFIX);
  return (end >= 0 ? body.slice(0, end) : body).split("; ").map((x) => x.trim()).filter(Boolean);
}

function writeStateBackToChatMessage(stateObj, opts = {}) {
  const context = SillyTavern.getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat) || chat.length === 0) return false;

  let idx = lastRpgMsgIndex;
  if (!(idx >= 0 && idx < chat.length)) {
    idx = chat.findLastIndex(m => !m.is_user && /<rpg_state\b[^>]*>[\s\S]*?<\/rpg_state>/i.test(m.mes));
  }
  if (idx < 0) return false;

  const msg = chat[idx];
  if (!msg || typeof msg.mes !== "string") return false;
  const regex = /<rpg_state\b[^>]*>[\s\S]*?<\/rpg_state>/i;

  // Uses the exact same builder to prevent mismatched keys!
  let finalString = buildPipeString(stateObj);

  // The builder writes state, not notes, so an (OOC: ...) line already in the
  // block would vanish on any rewrite (a bond edit, a move...) before the AI
  // ever saw it. Carry existing notes over; a new note from Edit state
  // replaces the HUD's own earlier one.
  const oldBlock = (msg.mes.match(regex) || [""])[0];
  let notes = (oldBlock.match(OOC_LINE_RE) || []).map((l) => l.trim());
  if (opts.oocNote) notes = notes.filter((l) => !l.startsWith(OOC_PREFIX)).concat(opts.oocNote);
  if (notes.length) finalString = finalString.replace(/<\/rpg_state>\s*$/i, `${notes.join("\n")}\n</rpg_state>`);

  msg.mes = msg.mes.replace(regex, finalString);

  try { window.saveChat?.(); } catch (e) { console.warn("RPG HUD: saveChat failed", e); }
  return true;
}

// --- 3. ACTIONS ---

function buildPipeString(stateObj) {
  syncLiveBondsIntoLedger(stateObj);
	
  let lines = ["[Global]"];
  const wt = stateObj.world_time || {};
  const yearStr = wt.year ? ` ${wt.year}` : "";
  lines.push(`|Loc:${stateObj.location || "Unknown"}||Time:${wt.weekday ? wt.weekday + " " : ""}${wt.month} ${wt.day}${yearStr},${wt.clock}||Weather:${wt.weather || "Unknown"}||Combat:${stateObj.combat?.active ? "Round " + (stateObj.combat?.round || 1) : "Off"}|`);
  
  const safeJoin = (arr) => Array.isArray(arr) && arr.length ? arr.map(i => typeof i === 'object' ? i.name : i).join(";") : "";
  
  // Explicitly keep pipes even if empty
  const quests = safeJoin(stateObj.quests);
  const env = safeJoin(stateObj.env_effects);
  lines.push(`|Quests:${quests === "None" ? "" : quests}||Env:${env === "None" ? "" : env}|`);
  lines.push(`|Bonds:${formatBondLedger(stateObj.bonds)}|`);
  lines.push(`|Timers:${formatTimers(stateObj.timers)}|`);
  lines.push("");

  const formatStats = (s) => {
    if (!s) return "ATK:0,MATK:0,DEF:0,SATK:0,SDEF:0";
    let parts = [];
    if (s.atk !== undefined) parts.push(`ATK:${s.atk}`);
    if (s.matk !== undefined) parts.push(`MATK:${s.matk}`);
    if (s.def !== undefined) parts.push(`DEF:${s.def}`);
    if (s.satk !== undefined) parts.push(`SATK:${s.satk}`);
    if (s.sdef !== undefined) parts.push(`SDEF:${s.sdef}`);
    return parts.length ? parts.join(",") : "ATK:0,MATK:0,DEF:0,SATK:0,SDEF:0";
  };

  // Fixed: Will output |Meters:| instead of omitting the pipe
  const formatMeters = (m) => {
    if (!Array.isArray(m) || !m.length) return "|Meters:|";
    return `|Meters:` + m.map(x => `${x.name}:${x.curr}/${x.max}`).join(";") + `|`;
  };

  // Vehicle: one line, same keys as an entity
  const buildVehicleLine = (v) => {
    const vType   = String(v.type || "mecha").toLowerCase();
    const usesEn  = (vType === "ship" || vType === "car");
    const eKey    = usesEn ? "EN" : "MP";
    const eCurr   = usesEn ? (v.en_curr ?? v.mp_curr ?? 0) : (v.mp_curr ?? v.en_curr ?? 0);
    const eMax    = usesEn ? (v.en_max  ?? v.mp_max  ?? 0) : (v.mp_max  ?? v.en_max  ?? 0);
    const coinStr = (v.dankcoin !== undefined && v.dankcoin !== null) ? `||Coin:${v.dankcoin}` : "";
    const meters  = Array.isArray(v.meters) && v.meters.length
      ? v.meters.map(x => `${x.name}:${x.curr}/${x.max}`).join(";")
      : "";

    return `>Vehicle|Type:${vType}||Name:${v.name || "Vehicle"}||HP:${v.hp_curr ?? 0}/${v.hp_max ?? 0}||${eKey}:${eCurr}/${eMax}${coinStr}||Stats:${formatStats(v.stats)}||Meters:${meters}||INV:${safeJoin(v.inventory)}||Skills:${safeJoin(v.skills)}||Passives:${safeJoin(v.passives)}||Masteries:${safeJoin(v.masteries)}||Status:${safeJoin(v.status_effects)}|`;
  };

  const buildEntity = (ent, isPlayer = false, isPartyOrNPC = false) => {
    let coinStr = (isPlayer || (ent.dankcoin !== undefined && ent.dankcoin !== null)) ? `||Coin:${ent.dankcoin ?? 0}` : "";
    // Only write a bond the character actually has. Writing "Bond:0" for
    // everyone else gave them a bond on every edit, which auto-add then
    // folded into the ledger as a character you'd never bonded with.
    const hasBond = ent.bond !== undefined && ent.bond !== null && String(ent.bond).trim() !== "";
    let bondStr = isPartyOrNPC && hasBond ? `||Bond:${ent.bond}` : "";
    
    let block = [`|Name:${ent.name || "Unknown"}||HP:${ent.hp_curr ?? 0}/${ent.hp_max ?? 0}||MP:${ent.mp_curr ?? 0}/${ent.mp_max ?? 0}${coinStr}${bondStr}|`];
    block.push(`|Stats:${formatStats(ent.stats)}|`);
    
    // Always push the meters pipe
    block.push(formatMeters(ent.meters));
    
    block.push(`|INV:${safeJoin(ent.inventory)}||Skills:${safeJoin(ent.skills)}||Passives:${safeJoin(ent.passives)}||Masteries:${safeJoin(ent.masteries)}||Status:${safeJoin(ent.status_effects)}|`);
    
    if (ent.vehicle && ent.vehicle.active) {
      block.push(buildVehicleLine(ent.vehicle));
    }
    return block;
  };

  lines.push("[Player]"); lines.push(...buildEntity(stateObj, true, false)); lines.push("");
  if (stateObj.party?.length) { lines.push("[Party]"); stateObj.party.forEach(p => lines.push(...buildEntity(p, false, true))); lines.push(""); }
  if (stateObj.enemies?.length) { lines.push("[Enemies]"); stateObj.enemies.forEach(e => lines.push(...buildEntity(e, false, false))); lines.push(""); }
  if (stateObj.npcs?.length) { lines.push("[NPCs]"); stateObj.npcs.forEach(n => lines.push(...buildEntity(n, false, true))); lines.push(""); }
  
  return `<rpg_state>\n${lines.join("\n").trim()}\n</rpg_state>`;
}

function insertLastStateIntoNarrative(e) {
  if (e) e.stopPropagation();
  const stateString = buildPipeString(rpgState);
  const $input = $('#send_textarea');
  if ($input.length) {
    let currentVal = $input.val().trim();
    $input.val(currentVal + (currentVal ? '\n\n' : '') + stateString).trigger('input').focus();
    $input[0].scrollTop = $input[0].scrollHeight;
  } else {
    alert("Could not find the chat input box.");
  }
  isSettingsOpen = false;
  renderRPG();
}

function remindStateInLastMessage(e) {
  if (e) e.stopPropagation();
  if (!rpgState || Object.keys(rpgState).length === 0) return alert("No valid RPG state to remind.");
  
  const chat = SillyTavern.getContext()?.chat;
  if (!Array.isArray(chat) || chat.length === 0) return alert("No chat history found.");

  const lastMsgIndex = chat.length - 1;
  const lastMsg = chat[lastMsgIndex];
  const newBlock = buildPipeString(rpgState);
  const regex = /<rpg_state\b[^>]*>[\s\S]*?<\/rpg_state>/i;

  if (lastMsg && !lastMsg.is_user) {
    if (confirm("Append/Update <rpg_state> in the last AI message?")) {
      lastMsg.mes = regex.test(lastMsg.mes) ? lastMsg.mes.replace(regex, newBlock) : (lastMsg.mes + "\n\n" + newBlock).trim();
      if (window.saveChat) { window.saveChat(); lastRpgMsgIndex = lastMsgIndex; alert("State injected."); }
      isSettingsOpen = false; renderRPG(); return;
    }
  }

  if (writeStateBackToChatMessage(rpgState)) {
    checkMessage(true); alert("Updated an OLD <rpg_state>.");
  } else {
    insertLastStateIntoNarrative(); alert("Inserted state into your input box instead.");
  }
  isSettingsOpen = false; renderRPG();
}

function resetRPG(e) {
  if (e) e.stopPropagation();
  if (confirm("Reset all RPG stats to zero?")) {
    rpgState = JSON.parse(JSON.stringify(defaultState));
    charIndex = 0;
    isSettingsOpen = false;
    renderRPG();
  }
}
// Gray Fog folds the panel away (and unfolds it) instead of swapping it instantly.
const FOG_FOLD_MS = 380, FOG_UNFOLD_MS = 560, FOG_ORB_MS = 280;
let fogFold = null;   // { dir: "fold" | "unfold" | "orb", at }
const fogMotionOk = () => uiSettings.fogFold !== false && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const FOG_FOLD_SPEEDS = { slow: 1.6, normal: 1, fast: .6, instant: .35 };
const fogFoldK = () => FOG_FOLD_SPEEDS[uiSettings.fogFoldSpeed] || 1;
// Re-renders mid-animation pick it up where it was, rather than restarting or dropping it.
function fogFoldClasses(container, minimized) {
  if (!fogFold) return;
  const t = Date.now() - fogFold.at;
  const [cls, base] = fogFold.dir === "fold" ? ["fog-fold", FOG_FOLD_MS]
    : fogFold.dir === "unfold" ? ["fog-unfold", FOG_UNFOLD_MS] : ["fog-orb-in", FOG_ORB_MS];
  const ms = base * fogFold.k;
  if (t >= ms || minimized !== (fogFold.dir === "orb")) return;
  container.classList.add(cls);
  container.style.animationDuration = `${Math.round(ms)}ms`;
  container.style.animationDelay = `-${t}ms`;
}
function toggleMinimize(e) {
  if (e) e.stopPropagation();
  flushInlineEdits();
  if (isFogSkin() && fogMotionOk()) {
    if (fogFold?.dir === "fold" && Date.now() - fogFold.at < FOG_FOLD_MS * fogFold.k) return;     // already folding
    const k = fogFoldK();
    if (!isMinimized) {
      fogFold = { dir: "fold", at: Date.now(), k };
      const c = document.getElementById("rpg-hud-container");
      if (c) fogFoldClasses(c, false);
      setTimeout(() => {
        isMinimized = true; isSettingsOpen = false;
        fogFold = { dir: "orb", at: Date.now(), k };
        renderRPG();
      }, FOG_FOLD_MS * k);
      return;
    }
    fogFold = { dir: "unfold", at: Date.now(), k };
  }
  isMinimized = !isMinimized;
  isSettingsOpen = false;
  renderRPG();
}
function switchTab(tabName) {
  flushInlineEdits();
  if (tabName !== activeTab) { saoListEdit = null; saoMasteryEdit = null; }
  activeTab = tabName;
  renderRPG();
}
function jumpToChar(e) {
  charIndex = parseInt(e.target.value, 10) || 0;
  saoListEdit = null; saoMasteryEdit = null;
  renderRPG();
}
function toggleSettings(e) {
  if (e) e.stopPropagation();
  flushInlineEdits();
  isSettingsOpen = !isSettingsOpen;
  renderRPG();
}
function openEditorFromSettings(e) {
  if (e) e.stopPropagation();
  isSettingsOpen = false;
  renderEditor();
}

function parseMetersFromText(text) {
  const out = [];
  const lines = String(text || "").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#") || line.startsWith("//")) continue;

    let parts = line.split("|").map((s) => s.trim());
    if (parts.length < 3) parts = line.split(",").map((s) => s.trim());
    if (parts.length < 3) continue;

    const name = parts[0];
    const curr = parts[1];
    const max = parts[2];

    if (!name) continue;
    out.push({ name, curr, max });
  }
  return out;
}

function metersToEditorText(meters) {
  if (!Array.isArray(meters) || meters.length === 0) return "";
  return meters
    .map((m) => {
      const name = m?.name ?? "";
      const curr = m?.curr ?? m?.value ?? "";
      const max = m?.max ?? 100;
      return `${name} | ${curr} | ${max}`;
    })
    .filter(Boolean)
    .join("\n");
}

function isLegacyBondKey(k) {
  const key = String(k ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  return /bond\s*:?\s*$/i.test(key) && key.toLowerCase() !== "bond";
}

function scrubLegacyBondKeys(obj) {
  if (!obj || typeof obj !== "object") return;
  for (const k of Object.keys(obj)) {
    if (isLegacyBondKey(k)) delete obj[k];
  }
}

function saveEditor() {
  const before = JSON.parse(JSON.stringify(rpgState));   // for the OOC note
  const { root, display, isVehicle } = getActiveData();
  const getEl = (id) => document.getElementById(id);

  const getMixed = (id) => {
    const el = getEl(id);
    if (!el) return 0;
    return el.value;
  };
  const getVal = (id) => {
    const el = getEl(id);
    return el ? Number(el.value) || 0 : 0;
  };
  const getStr = (id) => {
    const el = getEl(id);
    return el ? el.value : "";
  };
  const getList = (id) => {
    const el = getEl(id);
    return el
      ? el.value
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : [];
  };
  const getStrList = (id) => {
    const el = getEl(id);
    return el
      ? el.value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : [];
  };

  display.name = getStr("edit-name");
  display.hp_curr = getMixed("edit-hp-curr");
  display.hp_max = getMixed("edit-hp-max");

  const energyCurrVal = getMixed("edit-mp-curr");
  const energyMaxVal  = getMixed("edit-mp-max");
  
  if (isVehicle && (display.type === "ship" || display.type === "car")) {
    display.en_curr = energyCurrVal;
    display.en_max  = energyMaxVal;
    delete display.mp_curr;
    delete display.mp_max;
  } else {
    display.mp_curr = energyCurrVal;
    display.mp_max  = energyMaxVal;
    delete display.en_curr;
    delete display.en_max;
  }

  display.dankcoin = getVal("edit-coin");

  const metersText = getStr("edit-meters");
  display.meters = parseMetersFromText(metersText);

  display.stats.atk = getMixed("edit-atk");
  display.stats.matk = getMixed("edit-matk");
  display.stats.def = getMixed("edit-def");
  display.stats.satk = getMixed("edit-satk");
  display.stats.sdef = getMixed("edit-sdef");

  display.status_effects = getStrList("edit-status");
  display.inventory = getList("edit-inventory");
  display.skills = getList("edit-skills");
  display.passives = getList("edit-passives");
  display.masteries = getList("edit-mastery");

  if (getEl("edit-bond")) {
  root.bond = clamp(parseBondValue(getEl("edit-bond").value), Number.NEGATIVE_INFINITY, 101);
  scrubLegacyBondKeys(root);
}

  if (getEl("edit-vehicle-active")) {
    const isActive = getEl("edit-vehicle-active").checked;
    const vType = getEl("edit-vehicle-type").value;
    if (!root.vehicle) root.vehicle = { active: false, stats: {}, skills: [], passives: [], inventory: [] };
    root.vehicle.active = isActive;
    root.vehicle.type = vType;
  }

  if (charIndex === 0) {
    rpgState.location = getStr("edit-location");
    rpgState.world_time.month = getStr("edit-month");
    rpgState.world_time.day = getVal("edit-day");
	rpgState.world_time.year = getStr("edit-year").trim();
    {
      // after month/day/year, so "Auto" uses the date being saved
      const wd = getStr("edit-weekday");
      if (wd === "auto") {
        const w = worldWeekday({ month: rpgState.world_time.month, day: rpgState.world_time.day, year: rpgState.world_time.year }, false);
        if (w) rpgState.world_time.weekday = w; else delete rpgState.world_time.weekday;
      } else if (wd && wd !== "none") {
        const d = WEEKDAYS.find((x) => x.slice(0, 3).toLowerCase() === wd);
        rpgState.world_time.weekday = d ? d.slice(0, 3) : wd;
      } else if (wd === "none") {
        delete rpgState.world_time.weekday;
      }
    }
    rpgState.world_time.clock = getStr("edit-clock");
    rpgState.world_time.weather = getStr("edit-weather");
    rpgState.quests = getList("edit-quests");
    rpgState.env_effects = getList("edit-env");
	rpgState.bonds = parseBondLedgerFromText(getStr("edit-bonds"));
  }

  renderRPG();

  // Tell the AI what was changed by hand. Edits made before it has replied
  // are merged into one note, which sits in the same (latest) block.
  let oocNote = null;
  if (uiSettings.oocEditNotes !== false) {
    const changes = diffTurn(before, rpgState).map((c) => c.text);
    if (changes.length) {
      let earlier = [];
      try {
        const m = SillyTavern.getContext()?.chat?.[lastRpgMsgIndex]?.mes;
        earlier = oocNoteChanges((String(m || "").match(/<rpg_state\b[^>]*>[\s\S]*?<\/rpg_state>/i) || [""])[0]);
      } catch {}
      oocNote = oocNoteFor([...earlier, ...changes.filter((c) => !earlier.includes(c))]);
    }
  }

  const ok = writeStateBackToChatMessage(rpgState, oocNote ? { oocNote } : {});
  if (!ok) console.warn("RPG HUD: couldn't write back <rpg_state> (no message found?)");
}

// --- 4. UI RENDERER ---
function renderClassicSkin() {
  let container = document.getElementById("rpg-hud-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "rpg-hud-container";
    document.body.appendChild(container);
  }

  // Classic redraws through three separate paths (minimised, settings, main)
  // with no shared ending, so positions are saved here and put back in a
  // microtask: after this synchronous render finishes, before the next paint,
  // so there's no visible jump.
  saoSaveScroll(container);
  queueMicrotask(() => saoRestoreScroll(container));

  const SYS = isSysSkin();   // the System and Gray Fog skins are this panel, restyled
  const FOG = isFogSkin();
  const ico = (emoji, k) => (SYS ? sysIcon(k) : emoji);   // emoji in classic, line icons in System
  if (SYS) { sysEnsureCss(); sysEnsureWebFont(); }
  const BOX_RADIUS = "0px";
  const BAR_RADIUS = "4px";
  const FONT_FAMILY = uiSettings.fontFamily || "'Courier New', Courier, monospace";
  const FONT_SIZE = `${0.9 * (uiSettings.fontScale || 1)}em`;

  let latest = { status: "nochat", label: "", detail: "" };
  try {
    const context = SillyTavern.getContext();
    const chat = context?.chat;
    latest = updateLatestStatusAndToast(chat);
  } catch {}

  if (isMinimized) {
      const dot = indicatorColor(latest?.status);
      const latestTitle = latest?.detail ? `${latest.label}\n${latest.detail}` : (latest?.label || "");

      container.className = "";
      if (FOG) {
        // Gray Fog: a floating round button with the slowly turning star, coloured like the status dot
        const tint = fogStatusTint(latest?.status);
        container.className = "rpg-fog-orb";
        container.style.cssText = `position: fixed; right: 12px;
          top: clamp(calc(env(safe-area-inset-top, 0px) + 50px), 20vh, calc(100vh - env(safe-area-inset-bottom, 0px) - 50px));
          transform: translateY(-50%); z-index: 99999; --orb-tint: ${tint};`;
        fogFoldClasses(container, true);
        container.innerHTML = `<button class="fog-orb" title="${escAttr(latestTitle || "Open the HUD")}" aria-label="Open the HUD">
          <svg viewBox="0 0 24 24" aria-hidden="true" style="animation-delay:-${Date.now() % 14000}ms">${FOG_STAR_GLYPH("var(--orb-tint)")}</svg></button>`;
        container.onclick = toggleMinimize;
        return;
      }
      container.style.cssText = SYS ? `
        position: fixed; right: 0;
        top: clamp(calc(env(safe-area-inset-top, 0px) + 50px), 20vh, calc(100vh - env(safe-area-inset-bottom, 0px) - 50px));
        transform: translateY(-50%);
        width: 26px; height: 58px;
        background: ${FOG ? "rgba(26,26,32,0.94)" : "rgba(5,12,24,0.92)"};
        border: 1px solid ${FOG ? "#c9ccd6" : "#8fd0ff"}; border-right: 0;
        z-index: 99999; cursor: pointer; box-sizing: border-box;
        box-shadow: 0 0 10px rgba(90,180,255,0.55), inset 0 0 8px rgba(90,180,255,0.25);
        display: flex; align-items: center; justify-content: center;
        touch-action: manipulation; user-select: none;
      ` : `
        position: fixed;
        right: 0;

		top: clamp(
		  calc(env(safe-area-inset-top, 0px) + 50px),
		  20vh,
		  calc(100vh - env(safe-area-inset-bottom, 0px) - 50px)
		);
        transform: translateY(-50%);

        width: 26px;
        height: 58px;

        background: rgba(0,0,0,0.78);
        border: 2px solid #C0A040;
        border-right: 0;

        border-top-left-radius: 12px;
        border-bottom-left-radius: 12px;

        z-index: 99999;
        cursor: pointer;
        box-shadow: 0 0 10px #000;
        box-sizing: border-box;

        display: flex;
        align-items: center;
        justify-content: center;

        touch-action: manipulation;
        user-select: none;
      `;

      container.innerHTML = `
        <div title="${escAttr(latestTitle)}" style="
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: ${dot};
          box-shadow: 0 0 0 2px rgba(0,0,0,0.65);
          pointer-events: none;
        "></div>
      `;

      container.onclick = toggleMinimize;
      return;
    }

const hudW = Math.max(220, Number(uiSettings.hudWidth) || 280);
const hudH = Math.max(0, Number(uiSettings.hudHeight) || 0);

container.style.cssText = `position: fixed; top: 50px; right: 20px;
  width: ${hudW}px;
  ${hudH ? `height:${hudH}px;` : ""}
  ${SYS ? `background: var(--sys-bg); border: 1px solid var(--sc); color: #e4f3ff;` : `
  background: rgba(10, 10, 15, 0.95);
  border: 2px solid #C0A040; color: #E0E0E0;`}
  padding: 10px 10px ${FOG ? 53 : 46}px 10px;
  z-index: 9999;
  font-family: ${FONT_FAMILY};
  font-size: ${FONT_SIZE};
  display: block !important;
  border-radius: ${BOX_RADIUS};
  box-shadow: ${SYS ? "var(--sys-shadow)" : "0 0 10px #000"};
  box-sizing:border-box;
  contain: layout paint;
  overflow: hidden;`;

  applyHudTypography(container);
  if (SYS) container.style.fontFamily = sysFontStack();
  container.className = SYS ? `rpg-sys${FOG ? " rpg-fog" : ""}` : "";
  if (FOG) fogFoldClasses(container, false);
  container.onclick = null;

  try {
    const { root, display, type, isVehicle } = getActiveData();
    if (SYS) container.className = `rpg-sys${FOG ? " rpg-fog" : ""} rpg-sys-${isVehicle ? "veh" : type}`;
    if (FOG) fogFoldClasses(container, false);
    const context = SillyTavern.getContext();
    const chat = context?.chat;
    latest = updateLatestStatusAndToast(chat);

    const latestTitle = latest.detail
      ? `${latest.label}\n${latest.detail}`
      : latest.label;

    let headerColor = "#C0A040";
    let borderColor = "#333";
    let hpLabel = "HP";
    let mpLabel = "MP";
    let hpColor = "#d32f2f";
    let mpColor = "#1976d2";
    let icon = "⭐";

    if (isVehicle) {
      const vType = String(root.vehicle.type || "mecha").toLowerCase();
      
      if (vType === "ship") {
        headerColor = "#00E5FF";
        borderColor = "#006064";
        hpLabel = "HULL";
        hpColor = "#00838F";
        mpColor = "#FBC02D";
        icon = "🚀";
      } else if (vType === "car") {
        headerColor = "#FF9800";
        borderColor = "#E65100";
        hpLabel = "HULL";
        hpColor = "#FB8C00";
        mpColor = "#1976d2"; 
        icon = "🚗";
      } else if (vType === "transport") {
        headerColor = "#8BC34A";
        borderColor = "#33691E";
        hpLabel = "HULL";
        hpColor = "#7CB342";
        mpColor = "#1976d2";
        icon = "🚊";
      } else {
        headerColor = "#E040FB";
        borderColor = "#4A148C";
        hpLabel = "HULL";
        hpColor = "#AB47BC";
        mpColor = "#1976d2";
        icon = "🤖";
      }
    } else if (type === "party") icon = "🛡️";
    else if (type === "enemy") {
      headerColor = "#ff5252";
      borderColor = "#b71c1c";
      icon = "⚔️";
    } else if (type === "npc") {
      headerColor = "#00e5ff";
      borderColor = "#006064";
      icon = "👤";
    }

    const inv = Array.isArray(display.inventory) ? display.inventory : [];
    const skills = Array.isArray(display.skills) ? display.skills : [];
    const passives = Array.isArray(display.passives) ? display.passives : [];
    const masteries = Array.isArray(display.masteries) ? display.masteries : [];

    const statusSafe =
      display.status_effects && display.status_effects.length
        ? `<span style="color:#ff5252; font-weight:bold;">${display.status_effects.map((s) => escHtml(s)).join(", ")}</span>`
        : `<span style="color:#69f0ae;">Healthy</span>`;

    const hpPercent = percentFrom(display.hp_curr, display.hp_max);
    const { curr: energyCurr, max: energyMax, label: energyLabel } = getEnergy(display, isVehicle);
    const mpPercent = percentFrom(energyCurr, energyMax);

    let bondHtml = "";
    if ((type === "party" || type === "npc") && !isVehicle) {
      let bond = parseBondValue(root.bond);
      bond = clamp(bond, Number.NEGATIVE_INFINITY, 101);

      const bondLabel = bond >= 101 ? "∞" : String(bond);
      const bondPct = bond >= 101 ? 100 : clamp(Math.abs(bond), 0, 100);
      const bondColor = bond < 0 ? "#ff5252" : "#f06292";
      
      bondHtml = `<div style="display:flex; justify-content:space-between; font-size:0.8em; margin-top:5px;">
        <span style="color:${bondColor};">❤️ Bond</span> <span>${bondLabel}/100</span>
      </div>
      <div style="width:100%; background:#333; height:4px; margin-bottom:5px; border-radius:${BAR_RADIUS}; overflow:hidden;">
        <div style="height:100%; background:${bondColor}; width:${bondPct}%"></div>
      </div>`;
    }

    if (saoMeterEdit && meterEditIdx !== charIndex) saoMeterEdit = null;   // switched character: drop the draft
    const meterEditorHtml = saoMeterEdit ? `${CLASSIC_ED_CSS}<div class="rpg-c-ed rpg-c-medit">${saoMetersSection(display)}</div>` : "";
    const hasMeters = Array.isArray(display.meters) && display.meters.length > 0;
    const metersHtml = saoMeterEdit ? meterEditorHtml
      : hasMeters ? renderMeters(display.meters, true)
      : `<div style="text-align:right; margin-top:2px;"><span data-meter-edit data-meter-add title="Add a meter"
          style="cursor:pointer; font-size:0.72em; color:#888;">+ meter</span></div>`;

    const coin = toNumberOr(display.dankcoin ?? root.dankcoin ?? 0, 0);

    const time = rpgState.world_time || { month: "???", day: 0, clock: "??:??", weather: "Unknown" };
    const selectStyle = `background: transparent; border: none; color: ${headerColor}; font-weight: bold; font-size: 1em; cursor: pointer; outline: none; max-width: 170px; font-family:${FONT_FAMILY};`;
    const tabStyle = (name) => SYS
      ? `flex:0 0 auto; min-width:52px; text-align:center; cursor:pointer; padding:4px 8px; font-size:0.74em; letter-spacing:0.1em; text-transform:uppercase; user-select:none; ` +
        (activeTab === name
          ? "border:1px solid var(--sc); color:#fff; background:rgba(var(--t-90_170_255, 90,170,255),0.16); text-shadow:0 0 6px var(--sg); box-shadow:inset 0 0 6px var(--sg);"
          : "border:1px solid transparent; color:var(--t-8fb6d8, #8fb6d8);")
      :
      `flex:0 0 auto; min-width:56px; text-align:center; cursor:pointer; padding:5px 8px; font-size:0.8em; border-radius:3px; user-select:none; ` +
      `${activeTab === name ? "background:#C0A040; color:#000; font-weight:bold;" : "background:transparent; color:#ddd;"}`;

    const combatLine =
      rpgState?.combat?.active
        ? `<div style="color:#ff5252; font-weight:bold; font-size:0.9em; margin-top:3px;">⚔️ Round ${escHtml(
            rpgState.combat.round ?? 1
          )}</div>`
        : "";

    const settingsPanelHtml = isSettingsOpen
      ? `
      <div id="rpg-settings-overlay" style="
        position:absolute; inset:0;
        background: rgba(0,0,0,0.88);
        border: 1px solid #333;
        z-index: 100000;
        display:flex;
        flex-direction:column;
        box-sizing:border-box;
        padding:10px;
      ">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px solid #333; padding-bottom:6px;">
          <div style="font-weight:bold; color:#ddd;">${ico("⚙️", "gear")} SETTINGS</div>
          <button id="rpg-settings-close" style="background:#444; border:1px solid #777; color:#fff; cursor:pointer; font-size:10px; padding:3px 10px; font-weight:bold;">CLOSE</button>
        </div>

        <div data-scroll-key="c:settings" style="flex:1; overflow:auto; padding-right:4px;">
          <div style="font-size:0.75em; color:#aaa; margin-bottom:6px;">Actions</div>

          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-bottom:12px;">
             <button id="rpg-settings-edit" style="background:#333; border:1px solid #4FC3F7; color:#4FC3F7; cursor:pointer; padding:8px 10px; font-weight:bold;">${ico("✏️", "pencil")} Edit</button>
             <button id="rpg-settings-remove" style="background:#333; border:1px solid #ff9800; color:#ffcc80; cursor:pointer; padding:8px 10px; font-weight:bold;">${ico("🗑️", "trash")} Remove</button>
             ${(() => {
               const info = getActivePointerInfo();
               if (!MOVE_KEYS[info.type]) return "";
               const opts = Object.keys(MOVE_KEYS).filter((t) => t !== info.type)
                 .map((t) => `<option value="${t}">${MOVE_LABELS[t]}</option>`).join("");
               return `<div style="grid-column:1 / span 2; display:flex; gap:6px; align-items:center;">
                 <span style="font-size:0.8em; color:#aaa; white-space:nowrap;">Move ${escHtml(displayName(info.name, "character"))} to</span>
                 <select id="rpg-settings-move-to" style="flex:1; min-width:0; background:#222; border:1px solid #555; color:#ddd; padding:6px;">${opts}</select>
                 <button id="rpg-settings-move" style="background:#333; border:1px solid #bbb; color:#eee; cursor:pointer; padding:6px 10px; font-weight:bold;">Move</button>
               </div>`;
             })()}
             <button id="rpg-settings-clear-npcs" style="background:#333; border:1px solid #00e5ff; color:#b3f5ff; cursor:pointer; padding:8px 10px; font-weight:bold;">${ico("🧹", "sweep")} NPCs</button>

             <button id="rpg-settings-clear-enemies" style="background:#333; border:1px solid #ff5252; color:#ffd0d0; cursor:pointer; padding:8px 10px; font-weight:bold;">${ico("🧹", "sweep")} Enemies</button>
             <button id="rpg-settings-clear-party" style="background:#333; border:1px solid #C0A040; color:#fff; cursor:pointer; padding:8px 10px; font-weight:bold;">${ico("🧹", "sweep")} Party</button>
			 <button id="rpg-settings-insert" style="background:#333; border:1px solid #4CAF50; color:#A5D6A7; cursor:pointer; padding:8px 10px; font-weight:bold;">Insert State</button>
             <button id="rpg-settings-remind" style="background:#333; border:1px solid #9C27B0; color:#E1BEE7; cursor:pointer; padding:8px 10px; font-weight:bold;">Remind State</button>
			 <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; background:rgba(255,255,255,0.05); padding:8px; border-radius:4px; grid-column:1 / span 2;">
    			<span title="Automatically reminds the AI of stats on every message">Auto-Inject Prompt</span>
   			 <input type="checkbox" id="rpg-settings-autoinject" ${autoInjectState ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;">
		  </div>
		  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; background:rgba(255,255,255,0.05); padding:8px; border-radius:4px; grid-column:1 / span 2;">
    			<span title="If a reply's Time: has no weekday, add one (when the month and year are written)">Add Weekdays</span>
   			 <input type="checkbox" id="rpg-settings-addweekday" ${uiSettings.addWeekdays !== false ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;">
		  </div>
		  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; background:rgba(255,255,255,0.05); padding:8px; border-radius:4px; grid-column:1 / span 2;">
    			<span title="If a reply writes a weekday in Time: that doesn't match the date, correct it">Fix Weekdays</span>
   			 <input type="checkbox" id="rpg-settings-fixweekday" ${uiSettings.fixWeekdays !== false ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;">
		  </div>
		  <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; background:rgba(255,255,255,0.05); padding:8px; border-radius:4px; grid-column:1 / span 2;">
    			<span title="How times are shown. 12- and 24-hour times in the story are both understood either way.">Clock</span>
   			 <select id="rpg-settings-clockfmt" style="background:#222; color:#ddd; border:1px solid #555; padding:3px;">${clockFormatOptions()}</select>
		  </div>
		  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; background:rgba(255,255,255,0.05); padding:8px; border-radius:4px; grid-column:1 / span 2;">
    			<span title="Editing Items, Skills or Passives (tap an icon) also rewrites this many earlier replies">Edits Rewrite Past Replies</span>
   			 <input type="number" id="rpg-settings-edithist" min="0" max="20" step="1" value="${Math.max(0, Math.min(20, parseInt(uiSettings.listEditHistory, 10) || 0))}" style="width:52px; background:#222; color:#ddd; border:1px solid #555; text-align:center;">
		  </div>
		  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; background:rgba(255,255,255,0.05); padding:8px; border-radius:4px; grid-column:1 / span 2;">
    			<span title="When the AI drops an item, skill or passive's description entirely, put it back (keeping its other changes)">Restore Lost Descriptions</span>
   			 <input type="checkbox" id="rpg-settings-restoredesc" ${uiSettings.restoreLostDesc ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;">
		  </div>
		  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; background:rgba(255,255,255,0.05); padding:8px; border-radius:4px; grid-column:1 / span 2;">
    			<span title="Edit -> Save leaves an (OOC: ...) note in the block telling the AI what you changed by hand">Note Edits for AI</span>
   			 <input type="checkbox" id="rpg-settings-oocnotes" ${uiSettings.oocEditNotes !== false ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;">
		  </div>
		  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; background:rgba(255,255,255,0.05); padding:8px; border-radius:4px; grid-column:1 / span 2;">
    			<span title="Warn when an item/skill/passive loses its description">Change Alerts</span>
   			 <input type="checkbox" id="rpg-settings-changealerts" ${uiSettings.changeAlerts ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;">
		  </div>
		  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; background:rgba(255,255,255,0.05); padding:8px; border-radius:4px; grid-column:1 / span 2;">
    			<span title="Change Alerts stay quiet when only an amount changed: 4 hours to 3.5 hours, x3 to x2, 60% to 55%. Those still show in the Log.">Ignore Amount Changes</span>
   			 <input type="checkbox" id="rpg-settings-ignorecounts" ${uiSettings.ignoreCountChanges !== false ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;">
		  </div>
		  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; background:rgba(255,255,255,0.05); padding:8px; border-radius:4px; grid-column:1 / span 2;">
    			<span title="How long the HUD's pop-up messages stay, in seconds. 0 keeps them until you tap them.">Toast Seconds</span>
   			 <input type="number" id="rpg-settings-toastsecs" min="0" max="120" step="1" value="${Math.max(0, Math.min(120, Number(uiSettings.toastSeconds ?? 8)))}" style="width:52px; background:#222; color:#ddd; border:1px solid #555; text-align:center;">
		  </div>
             <button id="rpg-settings-reset" style="background:#b71c1c; border:1px solid #ff5252; color:#fff; cursor:pointer; padding:8px 10px; font-weight:bold; grid-column:1 / span 2;">X Reset</button>
          </div>

        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px;">
          <span style="font-size:0.8em; color:#ddd;">Auto-add bonds</span>
          <input type="checkbox" id="rpg-settings-autobond" ${uiSettings.autoAddBonds ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;">
        </div>
        ${bondBlocklist.size ? `<button id="rpg-settings-unblock" style="width:100%; background:#222; border:1px solid #555; color:#ddd; padding:6px; margin-bottom:10px; cursor:pointer;">Unblock ${bondBlocklist.size} bond(s)</button>` : ""}

        <div style="font-size:0.75em; color:#aaa; margin-bottom:6px;">Appearance</div>
        <button id="rpg-settings-reset" style="width:100%; background:#222; border:1px solid #555; color:#ddd; padding:6px; margin-bottom:6px; cursor:pointer;">↺ Reset settings to defaults</button>
        <button id="rpg-settings-resetlayout" style="width:100%; background:#222; border:1px solid #555; color:#ddd; padding:6px; margin-bottom:10px; cursor:pointer;">✥ Reset SAO layout</button>

        <div style="background:rgba(255,255,255,0.06); border:1px solid #333; border-radius:4px; padding:8px; margin-bottom:10px;">
        <div style="font-size:0.75em; color:#bbb; margin-bottom:6px;">Skin</div>

        <select id="rpg-skin-select" style="width:100%; background:#222; border:1px solid #555; color:#ddd; padding:6px; margin-bottom:10px;">
            <option value="classic">Classic panel</option>
            <option value="system">System window</option>
            <option value="fog">Gray Fog</option>
            <option value="sao">SAO overlay</option>
        </select>

        ${SYS ? sysSettingsHtml() : ""}

        <div style="font-size:0.75em; color:#bbb; margin-bottom:6px;">${SYS ? "Font preset (with Font: Follow preset)" : "Font preset"}</div>

        <select id="rpg-font-preset" style="width:100%; background:#222; border:1px solid #555; color:#ddd; padding:6px;">
            <option value="retro_mono">Retro Mono (Courier)</option>
            <option value="modern_mono">Modern Mono (Consolas)</option>
            <option value="ui_sans">UI Sans (System)</option>
            <option value="big_sans">Big Sans (Verdana)</option>
            <option value="story_serif">Story Serif (Georgia)</option>
        </select>

        <div style="display:flex; align-items:center; justify-content:space-between; margin-top:10px;">
            <div style="font-size:0.75em; color:#bbb;">Size</div>
            <div id="rpg-font-scale-label" style="font-size:0.75em; color:#bbb;">100%</div>
        </div>

        <input id="rpg-font-scale" type="range" min="0.85" max="1.15" step="0.01"
                style="width:100%; margin-top:6px;">
        </div>

          <div style="font-size:0.75em; color:#aaa; margin-bottom:6px;">Notes</div>
          <div style="font-size:0.75em; color:#777; line-height:1.3;">
            • HP/MP dropdown appears if values are strings like: <span style="color:#bbb;">"260 ((100+100)*1.3)"</span><br>
            • Meters are editable: <span style="color:#bbb;">Name | curr | max</span><br>
            • Coins are per character/vehicle (shown bottom-right).<br>
            • rpg_state indicator on the top left.<br>
            🟢 = Valid.<br>
            🟡 = Broken rpg_state.<br>
            🔴 = rpg_state in user message.<br>
            ⚪ = No rpg_state.
          </div>
        </div>
      </div>
    `
      : "";
      
      const errorPanelHtml = isErrorOpen ? buildPipeErrorPanelHtml() : "";

      {
        const prevStrip = container.querySelector("#rpg-tab-strip");
        if (prevStrip) tabStripScrollLeft = prevStrip.scrollLeft;
      }


    container.innerHTML = `
    ${SYS ? emblemLayersHtml() : ""}
    ${SYS ? sysTopHtml({ root, display, type, isVehicle, latest, latestTitle, hpLabel, coin, time, meterEditorHtml }) : `
	<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px; padding-bottom:5px; border-bottom:1px solid ${borderColor}; min-height:24px;">
	  <div style="display:flex; align-items:center; gap:6px; min-width:0;">
	    <span style="font-size:1.2em;">${icon}</span>
	    <select id="rpg-char-select" style="${selectStyle}" title="Switch Character">${getCharOptions()}</select>
	</div>
	
	  <div style="display:flex; align-items:center; justify-content:flex-end; gap:6px; width:60px; flex:0 0 60px;">
        <span id="rpg-latest-indicator" style="cursor:pointer; user-select:none;">
          ${renderIndicatorDotHtml(latest.status, latestTitle)}
        </span>

        <button id="rpg-min-btn" title="Minimize" style="background:#444; border:1px solid #777; color:#fff; cursor:pointer; font-size:12px; padding:0; width:36px; height:20px; font-weight:bold; line-height:18px; box-sizing:border-box;">_</button>
      </div>
    </div>


      <div style="background:rgba(255,255,255,0.05); padding:5px; border-radius:4px; margin-bottom:5px; font-size:0.85em; text-align:center;">
        <div style="color:#fff; font-weight:bold;">📍 ${escHtml(rpgState.location)}</div>
        <div style="color:#aaa; font-size:0.9em;">
          📅 ${worldWeekday(time) ? escHtml(worldWeekday(time)) + ", " : ""}${escHtml(time.month)} ${escHtml(time.day)}${time.year ? `, ${escHtml(time.year)}` : ""}
          &nbsp;|&nbsp;
          ⏰ ${escHtml(showClock(time.clock))}
          &nbsp;|&nbsp;
          ${getWeatherEmoji(time.weather)} ${escHtml(time.weather || "Unknown")}
        </div>
        ${combatLine}
      </div>

      <div style="font-size:0.8em; text-align:right; margin-bottom:2px;">${statusSafe}</div>

      <div style="display:flex; justify-content:space-between; font-size:0.8em; align-items:center;">
        <span>${escHtml(hpLabel)}</span>
        <span>${renderInlineValue(display.hp_curr)} / ${renderInlineValue(display.hp_max)}</span>
      </div>
      <div style="width:100%; background:#333; height:8px; margin-bottom:4px; border-radius:${BAR_RADIUS}; overflow:hidden;"><div style="height:100%; background:${hpColor}; width:${hpPercent}%"></div></div>

      <div style="display:flex; justify-content:space-between; font-size:0.8em; align-items:center;">
        <span>${escHtml(energyLabel)}</span>
        <span>${renderInlineValue(energyCurr)} / ${renderInlineValue(energyMax)}</span>
      </div>
      <div style="width:100%; background:#333; height:8px; margin-bottom:2px; border-radius:${BAR_RADIUS}; overflow:hidden;">
        <div style="height:100%; background:${mpColor}; width:${mpPercent}%"></div>
      </div>

      ${bondHtml}
      ${metersHtml}

      <div style="background:rgba(255,255,255,0.05); padding:5px; border-radius:4px; margin-bottom:10px;">
        <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:2px; text-align:center; margin-bottom:5px;">
          ${renderStatBox("ATK", display.stats?.atk)}
          ${renderStatBox("MATK", display.stats?.matk)}
          ${renderStatBox("DEF", display.stats?.def)}
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:2px; text-align:center;">
          ${renderStatBox("SATK", display.stats?.satk)}
          ${renderStatBox("SDEF", display.stats?.sdef)}
        </div>
      </div>
    `}

      <div id="rpg-tab-strip" data-scroll-key="c:strip" style="display:flex; overflow-x:auto; white-space:nowrap; gap:2px; border-bottom:1px solid ${SYS ? "rgba(var(--t-143_208_255, 143,208,255),0.35)" : "#555"}; margin-bottom:5px; padding-bottom:2px; scrollbar-gutter:stable;">
        <div id="tab-party" style="${tabStyle("party")}">Party</div>
		<div id="tab-bonds" style="${tabStyle("bonds")}">Bonds</div>
	    <div id="tab-timers" style="${tabStyle("timers")}">Timers</div>
        <div id="tab-inv" style="${tabStyle("inventory")}">Items</div>
        <div id="tab-skill" style="${tabStyle("skills")}">Skills</div>
        <div id="tab-pass" style="${tabStyle("passives")}">Passive</div>
        <div id="tab-mast" style="${tabStyle("mastery")}">Mastery</div>
        <div id="tab-quest" style="${tabStyle("quests")}">Quest</div>
        <div id="tab-env" style="${tabStyle("env")}">Environment</div>
        <div id="tab-log" style="${tabStyle("log")}">Log</div>
      </div>

      ${CLASSIC_ED_CSS}
      <div data-scroll-key="c:body:${activeTab}" style="height: ${classicEditorOpen() ? 240 : 110}px; overflow-y: auto; font-size: 0.8em; padding:5px; background:${SYS ? "rgba(var(--t-4_12_24, 4,12,24),0.55); border:1px solid rgba(var(--t-143_208_255, 143,208,255),0.22)" : "rgba(0,0,0,0.3)"}; scrollbar-gutter:${activeTab === "log" ? "auto" : "stable"};">
        ${activeTab === "party" ? renderPartyTab() : ""}
        ${activeTab === "log" ? classicLogHtml() : ""}
		${activeTab === "bonds" ? renderBondsTab() : ""}
		${activeTab === "timers" ? renderTimersTab() : ""}
        ${activeTab === "inventory" ? classicIconList("inventory", inv, "No Items") : ""}
        ${activeTab === "skills" ? classicIconList("skills", skills, "No Skills Learned") : ""}
        ${activeTab === "passives" ? classicIconList("passives", passives, "No Passives") : ""}
        ${activeTab === "mastery" ? classicMasteryHtml(masteries) : ""}
        ${activeTab === "quests" ? classicQuestHtml() : ""}
        ${activeTab === "env" ? makeList(rpgState.env_effects, "No Environmental Effects") : ""}
      </div>

      ${renderEnemySummary()}

    <div class="rpg-c-btns${FOG ? ` fog-dock${fogDockOpen || isSettingsOpen || classicInfo ? " open" : ""}${fogDockAnim ? " anim" : ""}` : ""}" style="
	  position:absolute; left:10px; bottom:8px;
	  display:flex; gap:6px;
	">
	  <button id="rpg-settings-btn" title="Settings" style="
	    background:#333; border:1px solid #777; color:#fff;
	    cursor:pointer; width:34px; height:26px;
	    display:flex; align-items:center; justify-content:center;
	    box-sizing:border-box;
	  ">${ico("⚙️", "gear")}</button>
	
	  <button id="rpg-scan-btn" title="Scan" style="
	    background:#333; border:1px solid #C0A040; color:#fff;
	    cursor:pointer; width:34px; height:26px;
	    display:flex; align-items:center; justify-content:center;
	    box-sizing:border-box;
	  ">↻</button>
	  ${FOG ? `<button id="rpg-fog-dock" title="${fogDockOpen ? "Close the menu" : "Menu"}" aria-expanded="${fogDockOpen}">
	    <svg viewBox="0 0 24 24" aria-hidden="true"${fogDockOpen ? ` style="animation-delay:-${Date.now() - fogDockOpenedAt}ms"` : ""}><g class="fog-star">
	      <path d="M12 2.5 L13.6 10.4 L21.5 12 L13.6 13.6 L12 21.5 L10.4 13.6 L2.5 12 L10.4 10.4 Z" fill="currentColor"/>
	      <circle cx="12" cy="12" r="6.3" fill="none" stroke="currentColor" stroke-width="1" opacity=".55"/></g></svg>
	    ${!fogDockOpen && changelogUnseen() ? `<span class="fog-dock-badge"></span>` : ""}</button>` : ""}
	  <button id="rpg-help-btn" title="Help" style="
	    position:relative; background:#333; border:1px solid #777; color:#fff;
	    cursor:pointer; width:34px; height:26px;
	    display:flex; align-items:center; justify-content:center;
	    box-sizing:border-box;
	  ">?</button>
	  <button id="rpg-log-btn" title="Update log" style="
	    position:relative; background:#333; border:1px solid #777; color:#fff;
	    cursor:pointer; width:34px; height:26px;
	    display:flex; align-items:center; justify-content:center;
	    box-sizing:border-box;
	  ">${ico("📜", "log")}${changelogUnseen() ? `<span style="position:absolute; top:-3px; right:-3px; width:8px; height:8px; border-radius:50%; background:#ff5252; box-shadow:0 0 0 2px #111;"></span>` : ""}</button>
	</div>


      ${SYS ? "" : `<div style="position:absolute; right:10px; bottom:10px; font-size:0.8em; color:#FFD700;">💰 ${escHtml(coin)}</div>`}

      <div id="rpg-resize-left" title="Resize"
        style="position:absolute; left:-8px; top:0; bottom:0; width:16px;
          cursor:ew-resize; z-index:200000; background:transparent; touch-action:none;"></div>

      ${SYS && emblemEditOpen && !isSettingsOpen ? `<div id="rpg-emblem-drag" title="Drag to move the picture. Pinch or scroll to resize; twist with two fingers (or Shift+scroll) to rotate."></div><div class="em-guide"></div>` + emblemEditorHtml() : ""}
      ${settingsPanelHtml}
      ${errorPanelHtml}
      ${classicInfoHtml()}
    `;

{
  const handle = container.querySelector("#rpg-resize-left");
  if (handle) {
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      handle.setPointerCapture?.(ev.pointerId);

      const startX = ev.clientX;
      const startW = container.getBoundingClientRect().width;

      const onMove = (e) => {
        const dx = e.clientX - startX; 
        const newW = Math.max(220, Math.min(700, startW - dx)); 
        uiSettings.hudWidth = Math.round(newW);
        container.style.width = uiSettings.hudWidth + "px";
      };

      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        saveUiSettings();
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    });
  }
}

{
  const newStrip = container.querySelector("#rpg-tab-strip");
  if (newStrip) {
    requestAnimationFrame(() => {
      newStrip.scrollLeft = tabStripScrollLeft;
    });
    newStrip.onscroll = () => {
      tabStripScrollLeft = newStrip.scrollLeft;
    };
  }
}

    bindJumpLinks();
	bindBondsTab();
    bindTimersTab();

    const bind = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.onclick = fn;
    };

    bind("rpg-min-btn", toggleMinimize);
    bind("rpg-fog-dock", (e) => {
      e?.stopPropagation();
      fogDockOpen = !(fogDockOpen || isSettingsOpen || classicInfo);
      if (fogDockOpen) fogDockOpenedAt = Date.now();
      if (!fogDockOpen) { if (isSettingsOpen) { flushInlineEdits(); isSettingsOpen = false; } classicInfo = null; }
      fogDockAnim = true;
      renderRPG();
      fogDockAnim = false;
    });
    bind("rpg-settings-btn", (e) => { classicInfo = null; toggleSettings(e); });
    bind("rpg-error-close", closePipeErrorPanel);
    
    const errorScroll = document.getElementById("rpg-error-scroll");
    if (errorScroll && isErrorOpen) {
      requestAnimationFrame(() => {
        const target = Math.max(0, charNumToScroll(lastPipeError?.char));
        errorScroll.scrollLeft = target;
      });
    }
    
    const errorOverlay = document.getElementById("rpg-error-overlay");
    if (errorOverlay) errorOverlay.onclick = (e) => e.stopPropagation();

    bind("rpg-scan-btn", (e) => {
      if (e) e.stopPropagation();
      checkMessage(true);
    });
    
    const indicator = document.getElementById("rpg-latest-indicator");
    if (indicator) {
      indicator.onclick = (e) => {
        e.stopPropagation();
    
        if (latest.status === "invalid") {
          openPipeErrorPanel(e);
          return;
        }
    
        if (latest.status === "notag") {
          lastPipeError = {
            line: null,
            char: 0,
            message: "No <rpg_state> found in the latest AI message.",
            snippet: "",
          };
          openPipeErrorPanel(e);
          return;
        }
    
        if (latest.status === "user") {
          lastPipeError = {
            line: null,
            char: 0,
            message: "The latest message is from the user, not the AI.",
            snippet: "",
          };
          openPipeErrorPanel(e);
          return;
        }
    
        if (latest.status === "valid") {
          lastPipeError = {
            line: null,
            char: 0,
            message: "Latest <rpg_state> looks valid.",
            snippet: "",
          };
          openPipeErrorPanel(e);
        }
      };
    }

    const dropdown = document.getElementById("rpg-char-select");
    if (dropdown) {
      dropdown.value = charIndex;
      dropdown.onchange = jumpToChar;
    }

    bind("tab-party", () => switchTab("party"));
	bind("tab-bonds", () => switchTab("bonds"));
	bind("tab-timers", () => switchTab("timers"));
    bind("tab-inv", () => switchTab("inventory"));
    bind("tab-skill", () => switchTab("skills"));
    bind("tab-pass", () => switchTab("passives"));
    bind("tab-mast", () => switchTab("mastery"));
    bind("tab-quest", () => switchTab("quests"));
    bind("tab-env", () => switchTab("env"));
    bind("tab-log", () => switchTab("log"));
    classicBindLog();
    classicBindEditors();
    classicBindInfo();
    if (SYS) { applyEmblem(container); if (emblemEditOpen) bindEmblemEditor(container); }
    container.querySelectorAll("[data-meter-edit]").forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation();
        meterEditIdx = charIndex;
        saoStartMeterEdit();
        // "+ meter" opens straight onto a new, empty row
        if (el.hasAttribute("data-meter-add")) {
          saoMeterEdit.push({ name: "", curr: "0", max: "100", color: "#26a69a", custom: false, orig: "" });
        }
        renderRPG();
        if (el.hasAttribute("data-meter-add")) {
          requestAnimationFrame(() => { const n = document.querySelectorAll(".rpg-sao-m-name"); n[n.length - 1]?.focus(); });
        }
      };
    });
    if (saoMeterEdit) saoBindMeterEditor();
	  
	if (isSettingsOpen) {
	  bind("rpg-settings-close", toggleSettings);
	  bind("rpg-settings-edit", openEditorFromSettings);
	
	  bind("rpg-settings-reset", resetRPG);
	  bind("rpg-settings-remove", removeActiveCharacter);
	  const ehEl = document.getElementById("rpg-settings-edithist");
	  if (ehEl) {
	    ehEl.onclick = (e) => e.stopPropagation();
	    ehEl.onkeydown = (e) => e.stopPropagation();
	    ehEl.onchange = () => { uiSettings.listEditHistory = Math.max(0, Math.min(20, parseInt(ehEl.value, 10) || 0)); saveUiSettings(); };
	  }
	  const awEl = document.getElementById("rpg-settings-addweekday");
	  if (awEl) {
	    awEl.onclick = (e) => e.stopPropagation();
	    awEl.onchange = () => { uiSettings.addWeekdays = awEl.checked; saveUiSettings(); };
	  }
	  const cfEl = document.getElementById("rpg-settings-clockfmt");
	  if (cfEl) {
	    cfEl.onclick = (e) => e.stopPropagation();
	    cfEl.onchange = () => { uiSettings.clockFormat = cfEl.value; saveUiSettings(); renderRPG(); };
	  }
	  const wdEl = document.getElementById("rpg-settings-fixweekday");
	  if (wdEl) {
	    wdEl.onclick = (e) => e.stopPropagation();
	    wdEl.onchange = () => { uiSettings.fixWeekdays = wdEl.checked; saveUiSettings(); };
	  }
	  const rdEl = document.getElementById("rpg-settings-restoredesc");
	  if (rdEl) {
	    rdEl.onclick = (e) => e.stopPropagation();
	    rdEl.onchange = () => { uiSettings.restoreLostDesc = rdEl.checked; saveUiSettings(); };
	  }
	  const oocEl = document.getElementById("rpg-settings-oocnotes");
	  if (oocEl) {
	    oocEl.onclick = (e) => e.stopPropagation();
	    oocEl.onchange = () => { uiSettings.oocEditNotes = oocEl.checked; saveUiSettings(); };
	  }
	  bind("rpg-settings-move", () => {
	    const to = document.getElementById("rpg-settings-move-to")?.value;
	    if (to) moveActiveCharacter(to);
	  });
	  const mvSel = document.getElementById("rpg-settings-move-to");
	  if (mvSel) mvSel.onclick = (e) => e.stopPropagation();
	  bind("rpg-settings-clear-npcs", (e) => clearArray("npc", e));
	  bind("rpg-settings-clear-enemies", (e) => clearArray("enemy", e));
	  bind("rpg-settings-clear-party", (e) => clearArray("party", e));
	  bind("rpg-settings-insert", insertLastStateIntoNarrative);
	  bind("rpg-settings-remind", remindStateInLastMessage);

	  const abEl = document.getElementById("rpg-settings-autobond");
	  if (abEl) {
	    abEl.onclick = (e) => e.stopPropagation();
	    abEl.onchange = () => { uiSettings.autoAddBonds = abEl.checked; saveUiSettings(); };
	  }
	  const ubEl = document.getElementById("rpg-settings-unblock");
	  if (ubEl) ubEl.onclick = (e) => {
	    e.stopPropagation();
	    clearBondBlocklist();
	    if (window.toastr) hudToast.info("Bond blocklist cleared for this chat.");
	    renderRPG();
	  };

	  const resetEl = document.getElementById("rpg-settings-reset");
	  if (resetEl) resetEl.onclick = resetUiSettings;

	  const rlEl = document.getElementById("rpg-settings-resetlayout");
	  if (rlEl) rlEl.onclick = (e) => { e.stopPropagation(); saoResetLayout(); };

	  const skinEl = document.getElementById("rpg-skin-select");
	  if (skinEl) {
	    skinEl.value = uiSettings.skin || "classic";
	    skinEl.onchange = () => { setSkin(skinEl.value); };
	    skinEl.onclick = (e) => e.stopPropagation();
	  }

	  if (SYS) sysBindSettings(container);

	  const icEl = document.getElementById("rpg-settings-ignorecounts");
	  if (icEl) {
	    icEl.onclick = (e) => e.stopPropagation();
	    icEl.onchange = () => { uiSettings.ignoreCountChanges = icEl.checked; saveUiSettings(); };
	  }
	  const tsEl = document.getElementById("rpg-settings-toastsecs");
	  if (tsEl) {
	    tsEl.onclick = (e) => e.stopPropagation();
	    tsEl.onkeydown = (e) => e.stopPropagation();
	    tsEl.onchange = () => { uiSettings.toastSeconds = Math.max(0, Math.min(120, parseInt(tsEl.value, 10) || 0)); saveUiSettings(); };
	  }

	  const caEl = document.getElementById("rpg-settings-changealerts");
	  if (caEl) caEl.onchange = () => {
	    uiSettings.changeAlerts = caEl.checked;
	    saveUiSettings();
	  };

	  const overlay = document.getElementById("rpg-settings-overlay");
	  if (overlay) overlay.onclick = (e) => e.stopPropagation();
	
	  try {
	    const presetEl = document.getElementById("rpg-font-preset");
	    const scaleEl = document.getElementById("rpg-font-scale");
	    const scaleLabel = document.getElementById("rpg-font-scale-label");
	
	    if (presetEl) {
	      presetEl.value = uiSettings.fontPreset || "retro_mono";
	      presetEl.onchange = () => {
	        uiSettings.fontPreset = presetEl.value;
	        uiSettings.fontFamily = fontPresetToFamily(uiSettings.fontPreset);
	        saveUiSettings();
	        applyHudTypography(container);
	      };
	    }
	
	    if (scaleEl) {
	      scaleEl.value = String(uiSettings.fontScale || 1.0);
	      const updateLabel = () => {
	        if (scaleLabel) scaleLabel.textContent = `${Math.round((Number(scaleEl.value) || 1) * 100)}%`;
	      };
	      updateLabel();
	
	      scaleEl.oninput = () => {
	        uiSettings.fontScale = Number(scaleEl.value) || 1.0;
	        saveUiSettings();
	        applyHudTypography(container);
	        updateLabel();
	      };
	    }
	  } catch {}
	}
  } catch (e) {
    container.innerHTML = `<div style="color:#ff5252; padding:10px;">HUD crashed: ${escHtml(
      e.message
    )}<br><button id="rpg-hard-reset">Hard Reset</button></div>`;
    document.getElementById("rpg-hard-reset").onclick = resetRPG;
    console.error("RPG HUD UI Error:", e);
  }
}



// =====================================================================
// TURN LOG
// Nothing is stored. Every AI message already carries a complete
// <rpg_state>, so a turn's changes are the difference between one block
// and the block before it. Rebuilt from history on demand, which means it
// follows swipes, edits and deletions for free and works on old chats.
// =====================================================================

// same rule the scanner uses: the first block in the message
function rpgInnerFromMessage(mes) {
  const m = String(mes || "").match(/<rpg_state\b[^>]*>([\s\S]*?)<\/rpg_state>/i);
  if (!m) return null;
  return m[1].replace(/```[a-z]*\n?/g, "").replace(/```/g, "").trim();
}

// parsed blocks, keyed by their exact text, so a long chat parses once
const turnParseCache = new Map();
function coreStateOf(inner) {
  if (turnParseCache.has(inner)) return turnParseCache.get(inner);
  let st = null;
  try { st = parseBlockCore(inner); } catch (e) { st = null; }
  if (turnParseCache.size > 600) turnParseCache.clear();
  turnParseCache.set(inner, st);
  return st;
}

// every AI message with a parseable block, oldest first
function rpgTurnsOf(chat) {
  const out = [];
  if (!Array.isArray(chat)) return out;
  chat.forEach((msg, i) => {
    if (!msg || msg.is_user || typeof msg.mes !== "string") return;
    const inner = rpgInnerFromMessage(msg.mes);
    if (!inner) return;
    const st = coreStateOf(inner);
    if (st) out.push({ idx: i, inner, state: st });
  });
  return out;
}

const tNum = (v) => { const n = barValue(v); return Number.isFinite(n) ? n : null; };
const tSigned = (n) => (n > 0 ? `+${n}` : `${n}`);
const tNameKey = (u) => normBondName(u?.name);

// Keyed by name with any trailing modifier dropped, so "Iron Sword +10 ATK"
// and "Iron Sword +15 ATK" are the same item upgraded, not a swap.
// the name alone, as written: "Iron Sword +10 ATK [X]" -> "Iron Sword"
function tItemName(text) {
  return entryBaseName(descSplit(text).head)
    .replace(/:\s*-?\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?.*$/, "")
    .replace(/\s[+\-\u2212]\s?\d.*$/, "")
    .trim() || String(text ?? "").trim();
}

function tItemKey(text) {
  // the name, in front of any ", description" (commas inside brackets don't count)
  return entryBaseName(descSplit(text).head)
    .replace(/:\s*-?\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?.*$/, "")   // "Sword: 45/100"
    .replace(/\s[+\-\u2212]\s?\d.*$/, "")                              // "Sword +10 ATK"
    .trim().toLowerCase();
}

// Keys for a list where a repeated name gets "#2", "#3"..., so two variants
// of the same skill are two entries in the log rather than one.
function tUniqueKeys(list) {
  const seen = new Map();
  return (Array.isArray(list) ? list : []).map((i) => {
    const k = tItemKey(String(typeof i === "object" ? (i?.name ?? "") : (i ?? "")).trim());
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}#${n}`;
  });
}

function tListMap(list) {
  const m = new Map();
  const keys = tUniqueKeys(list);
  (Array.isArray(list) ? list : []).forEach((i, idx) => {
    const text = String(typeof i === "object" ? (i?.name ?? "") : (i ?? "")).trim();
    const key = keys[idx];
    if (key && !m.has(key)) m.set(key, text);
  });
  return m;
}

function tBondMap(st) {
  const m = new Map();
  (Array.isArray(st?.bonds) ? st.bonds : []).forEach((b) => {
    if (b?.name) m.set(normBondName(b.name), { name: b.name, v: parseBondValue(b.bond) });
  });
  // live values on characters win, same as the live pipeline
  [...(st?.party || []), ...(st?.npcs || [])].forEach((u) => {
    if (u?.name && u.bond !== undefined && u.bond !== "") {
      m.set(normBondName(u.name), { name: u.name, v: parseBondValue(u.bond) });
    }
  });
  return m;
}

// Every change carries `u`, a note of exactly what it touched, so it can be
// reverted on its own. `who` is null for the player, else {group, key}.
function tDiffVitals(out, label, a, b, who) {
  const pre = label ? label + " " : "";
  const hp0 = tNum(a?.hp_curr), hp1 = tNum(b?.hp_curr);
  if (hp0 !== null && hp1 !== null && hp0 !== hp1) {
    out.push({ tone: hp1 < hp0 ? "bad" : "good", u: { f: "hp", who },
      text: `${pre}HP ${hp0} \u2192 ${hp1}${b?.hp_max ? "/" + splitMathValue(String(b.hp_max)).val : ""} (${tSigned(hp1 - hp0)})` });
  }
  const ea = getEnergy(a || {}, false), eb = getEnergy(b || {}, false);
  const e0 = tNum(ea.curr), e1 = tNum(eb.curr);
  if (e0 !== null && e1 !== null && e0 !== e1) {
    out.push({ tone: "neutral", u: { f: "mp", who },
      text: `${pre}${eb.label || "MP"} ${e0} \u2192 ${e1}${eb.max ? "/" + splitMathValue(String(eb.max)).val : ""} (${tSigned(e1 - e0)})` });
  }

  // the stats themselves: max HP and MP, then ATK, MATK and the rest
  const stat = (label, raw0, raw1, u) => {
    const s0 = String(raw0 ?? "").trim(), s1 = String(raw1 ?? "").trim();
    if (s0 === s1 || (!s0 && !s1)) return;
    const n0 = tNum(raw0), n1 = tNum(raw1);
    const show = (v) => splitMathValue(String(v ?? "")).val || "\u2013";
    if (n0 !== null && n1 !== null) {
      if (n0 === n1) return;                       // only the breakdown in brackets moved
      out.push({ tone: n1 > n0 ? "good" : "bad", u, text: `${pre}${label} ${n0} \u2192 ${n1} (${tSigned(n1 - n0)})` });
    } else {
      out.push({ tone: "neutral", u, text: `${pre}${label} ${show(raw0)} \u2192 ${show(raw1)}` });
    }
  };
  stat("Max HP", a?.hp_max, b?.hp_max, { f: "hpmax", who });
  stat(`Max ${eb.label || "MP"}`, ea.max, eb.max, { f: "mpmax", who });
  const st0 = a?.stats || {}, st1 = b?.stats || {};
  const order = ["atk", "matk", "def", "satk", "sdef"];
  [...new Set([...order, ...Object.keys(st0), ...Object.keys(st1)])].forEach((k) => {
    if (!(k in st0) && !(k in st1)) return;
    stat(k.toUpperCase(), st0[k], st1[k], { f: "stat", who, key: k });
  });

  // "Healthy", "None" and the like mean no status, so going from Poisoned to
  // Healthy is logged as losing Poisoned, not also as gaining Healthy
  const realStatus = (list) => new Set((list || []).map((x) => String(x).trim())
    .filter((x) => x && !BLK_NO_STATUS.test(x)));
  const sa = realStatus(a?.status_effects);
  const sb = realStatus(b?.status_effects);
  sb.forEach((x) => { if (!sa.has(x)) out.push({ tone: "bad", text: `${pre}+ ${x}`, u: { f: "status", who, item: x, added: true } }); });
  sa.forEach((x) => { if (!sb.has(x)) out.push({ tone: "good", text: `${pre}\u2212 ${x}`, u: { f: "status", who, item: x, added: false } }); });

  const ma = new Map((a?.meters || []).map((m) => [meterKey(m.name), m]));
  const mbKeys = new Set();
  (b?.meters || []).forEach((m) => {
    const key = meterKey(m.name); mbKeys.add(key);
    const before = ma.get(key);
    if (!before) { out.push({ tone: "neutral", text: `${pre}+ ${m.name} ${m.curr}/${m.max}`, u: { f: "meter", who, key } }); return; }
    const n0 = tNum(before.curr), n1 = tNum(m.curr);
    if (n0 !== null && n1 !== null && n0 !== n1) {
      out.push({ tone: "neutral", text: `${pre}${m.name} ${n0} \u2192 ${n1} (${tSigned(n1 - n0)})`, u: { f: "meter", who, key } });
    }
  });
  ma.forEach((m, key) => { if (!mbKeys.has(key)) out.push({ tone: "neutral", text: `${pre}\u2212 ${m.name}`, u: { f: "meter", who, key } }); });
}

// One character's items, skills, passives and masteries. `owner` is shown in
// front for anyone but the player, and `who` says whose list an undo touches.
function tDiffLists(out, a, b, owner = "", who = null) {
  WATCHED_LISTS.forEach(({ key, label }) => {
    const tag = owner ? `${owner} \u00B7 ${label}` : label;
    const A = tListMap(a?.[key]), B = tListMap(b?.[key]);
    B.forEach((text, k) => {
      if (!A.has(k)) { out.push({ tone: "good", text: `+ ${tag}: ${text}`, u: { f: "list", key, k, who } }); return; }
      const before = A.get(k);
      if (before === text || stripStatusTags(before) === stripStatusTags(text)) return;
      out.push({ tone: "neutral", text: `~ ${tag}: ${stripStatusTags(before)} \u2192 ${stripStatusTags(text)}`, u: { f: "list", key, k, who },
        diff: { label: tag, name: tItemName(text), before: stripStatusTags(before), after: stripStatusTags(text) } });
    });
    A.forEach((text, k) => { if (!B.has(k)) out.push({ tone: "bad", text: `\u2212 ${tag}: ${text}`, u: { f: "list", key, k, who } }); });
  });
}

const tTimerKey = (t) => `${String(t?.owner || "").toLowerCase()}|${String(t?.name || "").toLowerCase()}`;

// everything that changed between two consecutive states
function diffTurn(a, b) {
  const out = [];

  if (String(a.location || "") !== String(b.location || "") && b.location) {
    out.push({ tone: "neutral", text: `Moved to ${b.location}`, u: { f: "location" } });
  }
  const ta = a.world_time || {}, tb = b.world_time || {};
  try {
    const m0 = worldMinutes(ta.month, ta.day, ta.clock, ta.year);
    const m1 = worldMinutes(tb.month, tb.day, tb.clock, tb.year);
    if (Number.isFinite(m0) && Number.isFinite(m1) && m1 !== m0) {
      out.push({ tone: "neutral", text: `Time ${m1 > m0 ? "+" : "\u2212"}${formatMinutes(Math.abs(m1 - m0))}`, u: { f: "time" } });
    }
  } catch {}
  if (!a.combat?.active && b.combat?.active) out.push({ tone: "bad", text: "Combat started", u: { f: "combat" } });
  if (a.combat?.active && !b.combat?.active) out.push({ tone: "good", text: "Combat ended", u: { f: "combat" } });

  tDiffVitals(out, "", a, b, null);
  const c0 = tNum(a.dankcoin), c1 = tNum(b.dankcoin);
  if (c0 !== null && c1 !== null && c0 !== c1) {
    out.push({ tone: c1 > c0 ? "good" : "bad", text: `Coin ${tSigned(c1 - c0)} (${c1})`, u: { f: "coin" } });
  }
  tDiffLists(out, a, b);

  [["party", "joined the party", "left the party"],
   ["npcs", "appeared", "left"],
   ["enemies", "appeared", "is gone"]].forEach(([group, joined, left]) => {
    const A = new Map((a[group] || []).map((u) => [tNameKey(u), u]));
    const B = new Map((b[group] || []).map((u) => [tNameKey(u), u]));
    B.forEach((u, key) => {
      const name = displayName(u.name, "?");
      if (!A.has(key)) {
        out.push({ tone: group === "enemies" ? "bad" : "good", text: `${name} ${joined}`, u: { f: "unit", group, key } });
        return;
      }
      tDiffVitals(out, name, A.get(key), u, { group, key });
      tDiffLists(out, A.get(key), u, name, { group, key });
    });
    A.forEach((u, key) => {
      if (!B.has(key)) out.push({ tone: group === "enemies" ? "good" : "neutral",
        text: `${displayName(u.name, "?")} ${left}`, u: { f: "unit", group, key } });
    });
  });

  const ba = tBondMap(a), bb = tBondMap(b);
  bb.forEach((x, key) => {
    const before = ba.get(key);
    if (!before) { out.push({ tone: "good", text: `New bond: ${displayName(x.name)} (${x.v >= 101 ? "\u221E" : x.v})`, u: { f: "bond", key } }); return; }
    if (before.v !== x.v) {
      const d = x.v - before.v;
      out.push({ tone: d > 0 ? "good" : "bad", u: { f: "bond", key },
        text: `${displayName(x.name)} bond ${before.v} \u2192 ${x.v} (${d > 0 ? "\u25B2" : "\u25BC"}${Math.abs(d)})` });
    }
  });

  const qa = new Set((a.quests || []).map((q) => String(q).trim()));
  const qb = new Set((b.quests || []).map((q) => String(q).trim()));
  qb.forEach((q) => { if (q && !qa.has(q)) out.push({ tone: "good", text: `+ Quest: ${q}`, u: { f: "quest", q, added: true } }); });
  qa.forEach((q) => { if (q && !qb.has(q)) out.push({ tone: "neutral", text: `Quest closed: ${q}`, u: { f: "quest", q, added: false } }); });

  const tma = new Map((a.timers || []).map((t) => [tTimerKey(t), t]));
  const tmb = new Map((b.timers || []).map((t) => [tTimerKey(t), t]));
  tmb.forEach((t, key) => { if (!tma.has(key)) out.push({ tone: "neutral", text: `+ Timer: ${t.name} (${t.value})`, u: { f: "timer", key } }); });
  tma.forEach((t, key) => { if (!tmb.has(key)) out.push({ tone: "neutral", text: `Timer ended: ${t.name}`, u: { f: "timer", key } }); });

  return out;
}

// ---- reverting one change ----
const tClone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const tItemText = (x) => String(typeof x === "object" ? (x?.name ?? "") : (x ?? "")).trim();

function tTarget(state, who) {
  if (!who) return state;
  return (state?.[who.group] || []).find((x) => normBondName(x?.name) === who.key) || null;
}

// b is the latest block (a clone we may change), a the block before it
function applyTurnUndo(b, a, u) {
  const tb = tTarget(b, u.who), ta = tTarget(a, u.who);
  const putBack = (list, match, source) => {
    const i = list.findIndex(match);
    if (source !== undefined) { if (i >= 0) list[i] = tClone(source); else list.push(tClone(source)); }
    else if (i >= 0) list.splice(i, 1);
  };

  switch (u.f) {
    case "location": b.location = a.location; break;
    case "time": b.world_time = tClone(a.world_time); break;
    case "combat": b.combat = tClone(a.combat); break;
    case "coin": b.dankcoin = a.dankcoin; break;
    case "hp":
      if (tb && ta) tb.hp_curr = ta.hp_curr;
      break;
    case "mp":
      if (tb && ta) ["mp_curr", "mp", "en_curr", "en"].forEach((k) => {
        if (k in ta) tb[k] = ta[k]; else delete tb[k];
      });
      break;
    case "hpmax":
      if (tb && ta) tb.hp_max = ta.hp_max;
      break;
    case "mpmax":
      if (tb && ta) ["mp_max", "en_max"].forEach((k) => {
        if (k in ta) tb[k] = ta[k]; else delete tb[k];
      });
      break;
    case "stat": {
      if (!tb || !ta) break;
      const sa = ta.stats || {};
      tb.stats = { ...(tb.stats || {}) };
      if (u.key in sa) tb.stats[u.key] = sa[u.key]; else delete tb.stats[u.key];
      break;
    }
    case "status": {
      if (!tb) break;
      const list = Array.isArray(tb.status_effects) ? tb.status_effects : (tb.status_effects = []);
      if (u.added) tb.status_effects = list.filter((x) => String(x).trim() !== u.item);
      else if (!list.some((x) => String(x).trim() === u.item)) list.push(u.item);
      break;
    }
    case "meter": {
      if (!tb) break;
      const list = Array.isArray(tb.meters) ? tb.meters : (tb.meters = []);
      putBack(list, (m) => meterKey(m.name) === u.key, (ta?.meters || []).find((m) => meterKey(m.name) === u.key));
      break;
    }
    case "list": {
      // the player's list, or the character's named by who
      if (!tb) break;
      const list = Array.isArray(tb[u.key]) ? tb[u.key] : (tb[u.key] = []);
      const src = ta?.[u.key] || [];
      const bk = tUniqueKeys(list), ak = tUniqueKeys(src);
      const i = bk.indexOf(u.k), j = ak.indexOf(u.k);
      if (j >= 0) { if (i >= 0) list[i] = tClone(src[j]); else list.push(tClone(src[j])); }
      else if (i >= 0) list.splice(i, 1);
      break;
    }
    case "unit": {
      const list = Array.isArray(b[u.group]) ? b[u.group] : (b[u.group] = []);
      putBack(list, (x) => normBondName(x?.name) === u.key, (a[u.group] || []).find((x) => normBondName(x?.name) === u.key));
      break;
    }
    case "bond": {
      const before = tBondMap(a).get(u.key);
      const led = Array.isArray(b.bonds) ? b.bonds : (b.bonds = []);
      const li = led.findIndex((x) => normBondName(x?.name) === u.key);
      if (before) { if (li >= 0) led[li].bond = before.v; else led.push({ name: before.name, bond: before.v }); }
      else if (li >= 0) led.splice(li, 1);
      // live values win over the ledger, so they have to follow too
      [...(b.party || []), ...(b.npcs || [])].forEach((x) => {
        if (normBondName(x?.name) !== u.key) return;
        if (before) x.bond = before.v; else delete x.bond;
      });
      break;
    }
    case "quest": {
      const list = Array.isArray(b.quests) ? b.quests : (b.quests = []);
      if (u.added) b.quests = list.filter((x) => String(x).trim() !== u.q);
      else if (!list.some((x) => String(x).trim() === u.q)) list.push(u.q);
      break;
    }
    case "timer": {
      const list = Array.isArray(b.timers) ? b.timers : (b.timers = []);
      putBack(list, (t) => tTimerKey(t) === u.key, (a.timers || []).find((t) => tTimerKey(t) === u.key));
      break;
    }
  }
}

// newest first; each entry is one AI message that had a block
let turnLogCache = { sig: "", turns: [] };
function buildTurnLog(chat) {
  const turns = rpgTurnsOf(chat);
  const sig = `${currentChatKey(SillyTavern.getContext())}|${turns.length}|${turns.map((t) => t.inner.length).join(",")}`;
  if (sig === turnLogCache.sig) return turnLogCache.turns;

  const out = [];
  for (let i = 1; i < turns.length; i++) {
    const changes = diffTurn(turns[i - 1].state, turns[i].state);
    const wt = turns[i].state.world_time || {};
    out.push({
      idx: turns[i].idx,
      n: i,
      when: `${worldWeekday(wt) ? worldWeekday(wt) + " " : ""}${wt.month || "?"} ${wt.day ?? "?"} ${wt.clock ? showClock(wt.clock) : ""}`.trim(),
      where: turns[i].state.location || "",
      changes,
    });
  }
  out.reverse();
  turnLogCache = { sig, turns: out };
  return out;
}

// =====================================================================
// SKIN SYSTEM
// renderRPG() picks a skin. Each skin owns #rpg-hud-container completely:
// its layout, its container styling, and its own minimise behaviour.
// State (rpgState) is shared and untouched — a skin only ever reads it and
// calls the same handlers the classic skin does.
// =====================================================================

// System and Gray Fog share one layout; Gray Fog is a theme over it
function isSysSkin(name = uiSettings.skin) { return name === "system" || name === "fog"; }
function isFogSkin(name = uiSettings.skin) { return name === "fog"; }

function setSkin(name) {
  flushInlineEdits();
  uiSettings.skin = ["sao", "system", "fog"].includes(name) ? name : "classic";
  saveUiSettings();
  isSettingsOpen = false;
  emblemEditOpen = false;
  saoPanel = null;
  const c = document.getElementById("rpg-hud-container");
  if (c) { c.innerHTML = ""; c.style.cssText = ""; c.className = ""; c.onclick = null; }
  renderRPG();
}

function renderRPG() {
  if ((uiSettings.skin || "classic") === "sao") return renderSaoSkin();
  return renderClassicSkin();
}

// ---------------------------------------------------------------- SAO SKIN
let saoPanel = null;        // null | "status" | "bonds" | "quests" | "place" | "gear"
let saoMin = true;   // the overlay opens collapsed to its dot
let saoTimersOpen = false;
let saoHelpOpen = false;
let saoQuestTab = "quests";   // "quests" | "log"
const saoScroll = new Map();  // scroll key -> {top, left}
let saoLogShown = 20;         // turns rendered before "show older"
let saoMeterEdit = null;
let meterEditIdx = -1;       // classic/System: whose meters the open editor belongs to
let saoMasteryEdit = null;   // null, or a draft: [{name, curr, max, tail, orig}]     // null, or a draft: [{name, curr, max, color, custom}]
let saoLayoutMode = false;   // drag clusters around instead of using them
let saoAnimKind = "";        // "" | "restore" | "collapse" | "panel"
let saoAnimUntil = 0;        // animations apply to any render before this time
let saoLastPct = new Map();  // bar key -> last painted %, so values can tween
let saoTweens = new Map();   // bar key -> running animation token
let saoCollapsed = { meters: false, party: false, npcs: false, foes: false };
let saoSub = "stats";
let saoSvgUid = 0;

const SAO_SHAPE = { step: 0.60, slope: 2, drop: 0.50, tip: 4, tipy: 0 };
const SAO_RIM = { grey: "#53565e", greyW: 4, metalW: 2, hi: "#eceadf", lo: "#94918a",
                  slantW: 4,         // grey band along the slant; keep = greyW so the rim reads as one band
                  tipSlope: 0.55 };  // slant run per unit of rise. Every bar gets the same angle, and the
                                     // point's length depends only on this: lower = shorter, blunter point
const SAO_WELL = "rgba(36,39,46,0.82)";
// How many characters fit beside the bar depends on the font, the font scale
// and the device, so it is measured after layout rather than guessed.
// Centring can leave an element on a fractional pixel, which blurs all the
// text inside it. Nudge it back onto a whole pixel.
// Below ~50% lightness the panel is dark, so the text has to invert with it.
// Light text on a dark panel also renders crisper at small sizes than dark
// text on a light one, which is why the classic HUD always looked sharper.
const SAO_FONTS = {
  sans: "'Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif",
  // Straight vertical stems and squared curves, like the reference. Those need
  // far less antialiasing than a humanist sans, so they render cleaner small.
  squarish: "'Rajdhani','Bahnschrift','DIN Alternate','Avenir Next Condensed'," +
            "'Futura','Century Gothic','Segoe UI',sans-serif",
  // narrow and squared, closest to the ALfheim (New) names
  saira: "'Saira Condensed','Rajdhani','Bahnschrift','DIN Alternate','Avenir Next Condensed','Segoe UI',sans-serif",
  // narrower and more stylised still
  teko: "'Teko','Saira Condensed','Rajdhani','Bahnschrift','Avenir Next Condensed','Segoe UI',sans-serif",
  // clean and slightly futuristic, suits Aincrad
  exo: "'Exo 2','Rajdhani','Segoe UI',system-ui,sans-serif",
};

// What each web font needs fetched. Weights listed only where the family is
// known to have them: Google refuses the whole request if one is missing.
const SAO_WEBFONTS = {
  squarish: "Rajdhani:wght@500;600;700",
  saira: "Saira+Condensed:wght@500;600;700",
  teko: "Teko:wght@400;500;600",
  exo: "Exo+2:wght@500;600;700",
};

// Custom: any Google Fonts family you type. Letters, digits and spaces only,
// since it goes into both a URL and a CSS font-family.
function saoCustomFontName() {
  return String(uiSettings.saoCustomFont || "").replace(/[^A-Za-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

function saoFontStack() {
  if (uiSettings.saoFont === "custom") {
    const n = saoCustomFontName();
    return n ? `'${n}',${SAO_FONTS.squarish}` : SAO_FONTS.squarish;
  }
  return SAO_FONTS[uiSettings.saoFont] || uiSettings.fontFamily || SAO_FONTS.sans;
}

// Rajdhani isn't installed anywhere by default, so fetch it once when asked.
// If there's no network the stack above falls through to a local face.
function saoEnsureWebFont() {
  let family = SAO_WEBFONTS[uiSettings.saoFont];
  if (uiSettings.saoFont === "custom") {
    const n = saoCustomFontName();
    family = n ? n.replace(/ /g, "+") : null;    // regular weight only: every family has it
  }
  if (!family) return;
  const href = `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
  let link = document.getElementById("rpg-sao-webfont");
  if (link && link.getAttribute("href") === href) return;
  if (!link) {
    link = document.createElement("link");
    link.id = "rpg-sao-webfont";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  link.href = href;
}

function saoPanelVars() {
  const l = clamp(uiSettings.saoPanelLight ?? 92, 18, 98);
  const s = clamp(uiSettings.saoPanelSat ?? 10, 0, 40);
  const dark = l < 50;
  // Antialiasing fringe is most visible at maximum contrast, so backing the
  // ink off toward the panel visibly softens it on small text.
  const c = clamp(uiSettings.saoInk ?? 70, 0, 100);
  const inkL = dark ? 50 + c * 0.45 : 50 - c * 0.42;
  const dimL = dark ? inkL - 22 : inkL + 22;
  return {
    l,
    ink: `hsl(44 6% ${inkL.toFixed(1)}%)`,
    inkDim: `hsl(44 5% ${dimL.toFixed(1)}%)`,
    rule: `hsl(44 ${s * 0.7}% ${dark ? Math.min(l + 16, 96) : l - 17}%)`,
    chip: `hsl(44 ${s}% ${dark ? Math.min(l + 9, 92) : l - 7}%)`,
    dark,
  };
}

// vitals/col/clock are anchored to the viewport; the rest sit in the bar
// stack and shift relative to where they'd normally fall.
const SAO_DRAG_KEYS = ["vitals", "col", "clock"];

// How much of a piece must stay on screen. The orb column is the way back to
// settings, so it keeps a whole orb visible — losing it would strand the HUD.
const SAO_KEEP_VISIBLE = 28;

function saoPos() {
  const p = uiSettings.saoPos || {};
  const out = {};
  SAO_DRAG_KEYS.forEach((k) => {
    const v = p[k];
    const x = Array.isArray(v) ? Number(v[0]) : 0;
    const y = Array.isArray(v) ? Number(v[1]) : 0;
    out[k] = [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0];
  });
  return out;
}

function saoPosCss() {
  const p = saoPos();
  return SAO_DRAG_KEYS.map((k) => `--sao-${k}-x:${p[k][0]}px; --sao-${k}-y:${p[k][1]}px;`).join(" ");
}

function saoResetLayout() {
  uiSettings.saoPos = null;
  saveUiSettings();
  renderRPG();
  if (window.toastr) hudToast.info("HUD layout reset.");
}

// Drag by pointer. Interactive bits are switched off while this is on, so a
// drag can't fire a button and a tap can't be mistaken for a nudge.
// Delegated from the container, and bound once. Ghosts are recreated after
// every drag and every re-render, so per-element listeners went stale the
// moment you let go.
function saoBindDragging() {
  const c = document.getElementById("rpg-hud-container");
  if (!c || c.dataset.dragBound === "1") return;
  c.dataset.dragBound = "1";

  c.addEventListener("pointerdown", (ev) => {
    if (!saoLayoutMode) return;
    const el = ev.target?.closest?.(".rpg-sao-mover");
    if (!el) return;
    const key = el.dataset.ghost;
    if (!SAO_DRAG_KEYS.includes(key)) return;

    ev.preventDefault();
    ev.stopPropagation();

    const vw = window.innerWidth, vh = window.innerHeight;
    const K = SAO_KEEP_VISIBLE;
    const whole = key === "col";          // the way back to settings
    const start = saoPos()[key].slice();
    const x0 = ev.clientX, y0 = ev.clientY;
    const r = el.getBoundingClientRect();
    const gx = parseFloat(el.style.left) || 0, gy = parseFloat(el.style.top) || 0;
    el.classList.add("dragging");
    saoDragging = true;

    // Panels open to the LEFT of the orbs, so the column stops short of that
    // edge; everything else may go nearly off screen.
    const leftRoom = vw > 720 ? 330 : 120;
    const clampX = whole
      ? (v) => clamp(v, leftRoom - r.left, vw - 4 - r.right)
      : (v) => clamp(v, K - r.right, vw - K - r.left);
    const clampY = whole
      ? (v) => clamp(v, 4 - r.top, vh - 4 - r.bottom)
      : (v) => clamp(v, K - r.bottom, vh - K - r.top);

    const snapOn = uiSettings.saoSnap !== false;
    const targets = snapOn ? saoSnapTargets(key) : null;
    const w = r.width, h = r.height;

    const apply = (m) => {
      let dx = clampX(m.clientX - x0), dy = clampY(m.clientY - y0);
      let gxLine = null, gyLine = null;

      if (snapOn) {
        const L = gx + dx, T = gy + dy;
        const hitX = saoNearest([L, L + w / 2, L + w], targets.xs);
        const hitY = saoNearest([T, T + h / 2, T + h], targets.ys);
        if (hitX) { dx = clampX(dx + hitX.d); gxLine = hitX.at; }
        if (hitY) { dy = clampY(dy + hitY.d); gyLine = hitY.at; }
        saoDrawGuides(gxLine, gyLine);
      }

      c.style.setProperty(`--sao-${key}-x`, `${Math.round(start[0] + dx)}px`);
      c.style.setProperty(`--sao-${key}-y`, `${Math.round(start[1] + dy)}px`);
      el.style.left = `${Math.round(gx + dx)}px`;
      el.style.top = `${Math.round(gy + dy)}px`;
      return [dx, dy];
    };

    const up = (u) => {
      window.removeEventListener("pointermove", apply);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      el.classList.remove("dragging");
      saoDragging = false;
      const [dx, dy] = apply(u);
      c.querySelectorAll(".rpg-sao-guide").forEach((g) => g.remove());
      const next = { ...saoPos() };
      next[key] = [Math.round(start[0] + dx), Math.round(start[1] + dy)];
      uiSettings.saoPos = next;
      saveUiSettings();
      saoPlacePanels();
      requestAnimationFrame(saoDrawGhosts);
    };

    // on window, so a fast drag that leaves the overlay still tracks
    window.addEventListener("pointermove", apply);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
}

function saoAnim(kind, ms) {
  saoAnimKind = kind;
  saoAnimUntil = performance.now() + (ms || 260);
}

function saoApplyPanelVars() {
  const c = document.getElementById("rpg-hud-container");
  if (!c) return;
  const v = saoPanelVars();
  c.style.setProperty("--rpg-sao-panel-l", v.l + "%");
  c.style.setProperty("--rpg-sao-ink", v.ink);
  c.style.setProperty("--rpg-sao-ink-dim", v.inkDim);
  c.style.setProperty("--rpg-sao-rule", v.rule);
  c.style.setProperty("--rpg-sao-chip", v.chip);
}

// Point the notch at the orb that is actually lit, rather than at the middle
// of the panel. Clamped so it can't slide off the panel's own edges.
const SAO_SNAP_PX = 9;

// Edges and centres worth lining up to: the other pieces, and the viewport.
// All in container coordinates, which start at the top-left of the screen.
function saoSnapTargets(exceptKey) {
  const c = document.getElementById("rpg-hud-container");
  const xs = [], ys = [];
  if (!c) return { xs, ys };

  const vw = window.innerWidth, vh = window.innerHeight;
  xs.push(0, vw / 2, vw);
  ys.push(0, vh / 2, vh);

  c.querySelectorAll(".rpg-sao-mover").forEach((g) => {
    if (g.dataset.ghost === exceptKey) return;
    const l = parseFloat(g.style.left) || 0, t = parseFloat(g.style.top) || 0;
    const w = g.offsetWidth, h = g.offsetHeight;
    xs.push(l, l + w / 2, l + w);
    ys.push(t, t + h / 2, t + h);
  });
  return { xs, ys };
}

// nearest target within the threshold, or null
function saoNearest(values, targets) {
  let best = null;
  targets.forEach((t) => {
    values.forEach((v) => {
      const d = t - v;
      if (Math.abs(d) <= SAO_SNAP_PX && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
    });
  });
  return best;
}

function saoDrawGuides(x, y) {
  const c = document.getElementById("rpg-hud-container");
  if (!c) return;
  c.querySelectorAll(".rpg-sao-guide").forEach((g) => g.remove());
  const add = (vertical, at) => {
    const g = document.createElement("div");
    g.className = "rpg-sao-guide";
    if (vertical) { g.style.left = `${at}px`; g.style.top = "0"; g.style.width = "1px"; g.style.height = "100%"; }
    else { g.style.top = `${at}px`; g.style.left = "0"; g.style.height = "1px"; g.style.width = "100%"; }
    c.appendChild(g);
  };
  if (x !== null && x !== undefined) add(true, x);
  if (y !== null && y !== undefined) add(false, y);
}

// union of a piece's visible children, in viewport coordinates
function saoContentRect(el) {
  let box = null;
  const add = (r) => {
    if (!r || r.width < 1 || r.height < 1) return;
    box = box ? {
      left: Math.min(box.left, r.left), top: Math.min(box.top, r.top),
      right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom),
    } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  Array.from(el.children).forEach((child) => {
    if (child.classList?.contains("rpg-sao-mover")) return;
    add(child.getBoundingClientRect());
  });
  if (!box) add(el.getBoundingClientRect());
  return box;
}

// Rebuild the drag overlays so each one sits exactly on what it moves.
function saoDrawGhosts() {
  const c = document.getElementById("rpg-hud-container");
  if (!c) return;
  c.querySelectorAll(".rpg-sao-mover").forEach((g) => g.remove());
  if (!saoLayoutMode) return;

  const cr = c.getBoundingClientRect();
  SAO_DRAG_KEYS.forEach((key) => {
    const el = document.querySelector(`[data-drag="${key}"]`);
    if (!el) return;
    const b = saoContentRect(el);
    if (!b) return;
    const g = document.createElement("div");
    g.className = "rpg-sao-mover";
    g.dataset.ghost = key;
    g.style.left = `${Math.round(b.left - cr.left) - 3}px`;
    g.style.top = `${Math.round(b.top - cr.top) - 3}px`;
    g.style.width = `${Math.round(b.right - b.left) + 6}px`;
    g.style.height = `${Math.round(b.bottom - b.top) + 6}px`;
    g.textContent = key === "vitals" ? "BARS" : key === "col" ? "MENU" : "CLOCK";
    c.appendChild(g);
  });
}

// A last-resort rescue, not a layout rule. It only acts when a piece is
// genuinely unreachable — almost entirely off screen — because anything
// stricter nudges pieces on ordinary renders and the correction is saved,
// so small errors would accumulate every time the HUD redrew.
let saoDragging = false;

function saoEnforceOnScreen() {
  if (saoDragging) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const c = document.getElementById("rpg-hud-container");
  if (!vw || !vh || !c) return;

  const pos = saoPos();
  let changed = false;

  SAO_DRAG_KEYS.forEach((key) => {
    const el = document.querySelector(`[data-drag="${key}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;

    // "unreachable" means there is nothing left to grab, with a wide margin
    const MIN = 24;
    let dx = 0, dy = 0;
    if (r.right < MIN) dx = MIN - r.right;
    else if (r.left > vw - MIN) dx = vw - MIN - r.left;
    if (r.bottom < MIN) dy = MIN - r.bottom;
    else if (r.top > vh - MIN) dy = vh - MIN - r.top;

    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      pos[key] = [Math.round(pos[key][0] + dx), Math.round(pos[key][1] + dy)];
      c.style.setProperty(`--sao-${key}-x`, `${pos[key][0]}px`);
      c.style.setProperty(`--sao-${key}-y`, `${pos[key][1]}px`);
      changed = true;
    }
  });

  if (changed) {
    uiSettings.saoPos = pos;
    saveUiSettings();
  }
}

function saoPlacePanels() {
  // The column is draggable, so anchor the panels to where it actually is
  // rather than to a fixed inset. On narrow screens they stay left-aligned.
  const col = document.querySelector(".rpg-sao-col");
  const vw = window.innerWidth || 0;
  if (col && vw > 720) {
    const cr = col.getBoundingClientRect();
    const base = clamp(vw - cr.left + 14, 12, Math.max(12, vw - 360));
    const menu = document.querySelector(".rpg-sao-menuwrap");
    const panel = document.querySelector(".rpg-sao-panelwrap");
    if (menu) menu.style.right = `${Math.round(base)}px`;
    if (panel) {
      const shift = panel.classList.contains("helpshift")
        ? (menu ? menu.getBoundingClientRect().width + 14 : 220) : 0;
      panel.style.right = `${Math.round(base + shift)}px`;
    }
  }

  const lit = document.querySelector(".rpg-sao-orb.on")
           || document.getElementById("rpg-sao-diag");
  const gear = document.querySelector('.rpg-sao-orb[data-tab="gear"]') || lit;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;

  document.querySelectorAll(".rpg-sao-panelwrap, .rpg-sao-menuwrap").forEach((wrap) => {
    const box = wrap.querySelector(".rpg-sao-panel, .rpg-sao-menu");
    const notch = wrap.querySelector(".rpg-sao-notch");
    if (!box) return;

    box.style.top = "0px";
    const isMenu = wrap.classList.contains("rpg-sao-menuwrap");
    const orb = isMenu ? gear : lit;
    const w = wrap.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const o = orb ? orb.getBoundingClientRect() : null;

    if (!b.height) return;

    let shift = 0;
    if (o) {
      shift = (o.top + o.height / 2) - (b.top + b.height / 2);
      const maxUp = b.top - 8;                       // don't leave the top
      const maxDown = vh - 8 - b.bottom;             // or the bottom
      shift = clamp(shift, -maxUp, maxDown);
    }
    const frac = b.top - Math.round(b.top);
    box.style.top = `${Math.round(shift) - frac}px`;

    if (!notch) return;
    if (!o || o.left < b.right - 4) { notch.style.display = "none"; return; }

    const nb = box.getBoundingClientRect();          // re-read after the shift
    const y = o.top + o.height / 2 - w.top;
    const lo = nb.top - w.top + 14;
    const hi = nb.bottom - w.top - 14;
    notch.style.display = "block";
    notch.style.top = `${Math.round(clamp(y, lo, hi)) - 12}px`;
    notch.style.left = `${Math.round(nb.right - w.left)}px`;
  });

  document.querySelectorAll(".rpg-sao-timers").forEach((el) => {
    el.style.top = "0px";
    const r = el.getBoundingClientRect();
    const frac = r.top - Math.round(r.top);
    if (frac) el.style.top = `${-frac}px`;
  });
}

function saoFitName() {
  const block = document.querySelector(".rpg-sao-block");
  const el = block && block.querySelector(".rpg-sao-name");
  if (block && el) {
    block.classList.remove("over");          // measure in the narrow column
    if (el.scrollWidth > el.clientWidth + 1) block.classList.add("over");
  }

  // Same idea for party, NPC and enemy rows, but only the rows that need it.
  // Stacking every row would double the column's height; leaving them all
  // ellipsised makes two similarly named enemies indistinguishable.
  document.querySelectorAll(".rpg-sao-row").forEach((row) => {
    const tag = row.querySelector(".rpg-sao-tag");
    if (!tag) return;
    row.classList.remove("stacked");
    if (tag.scrollWidth > tag.clientWidth + 1) row.classList.add("stacked");
  });
}

// one hue sweep: green at full, yellow at half, red at empty
function saoHpStops(p) {
  const h = clamp(p * 1.1, 0, 110);
  return [`hsl(${h},84%,64%)`, `hsl(${h},78%,42%)`];
}

function saoPct(currRaw, maxRaw) {
  const a = barValue(currRaw);
  const b = barValue(maxRaw);
  if (!isFinite(a) || !isFinite(b) || b <= 0) return 0;
  return clamp((a / b) * 100, 0, 100);
}

// The bar is one SVG path, stroked twice then filled. Strokes centre on the
// path, so the fill hides their inner halves and what survives outside is a
// grey band with a thin metal line inside it. One path means the rim can't
// thin out along the diagonal the way two nested clip-paths did.
// ALfheim: a flat bar with an arrowhead on the right, outlined in thin silver.
function aloBarSvg(W, H, pctVal, c1, c2) {
  const m = 1;
  const x0 = m, y0 = m, w = W - m * 2, h = H - m * 2;
  if (w <= 4 || h <= 1) return "";
  const tip = Math.min(h * 0.75, w * 0.12);
  const d = `M${x0} ${y0}H${x0 + w - tip}L${x0 + w} ${y0 + h / 2}L${x0 + w - tip} ${y0 + h}H${x0}Z`;
  const id = "a" + (++saoSvgUid);
  const fx = x0 + w * clamp(pctVal, 0, 100) / 100;
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
      </linearGradient>
      <clipPath id="c${id}"><path d="${d}"/></clipPath>
    </defs>
    <path d="${d}" fill="rgba(20,24,30,.62)"/>
    <rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="rgba(225,228,236,.2)" clip-path="url(#c${id})"/>
    ${pctVal > 0 ? `<rect x="${x0}" y="${y0}" width="${fx - x0}" height="${h}" fill="url(#g${id})" clip-path="url(#c${id})"/>` : ""}
    <path d="${d}" fill="none" stroke="rgba(236,236,240,.85)" stroke-width="1" stroke-linejoin="miter"/>
  </svg>`;
}

// Outline of a closed polygon pushed out by r, corners mitred, except the one
// at tipIdx, which is cut square to its bisector at distance D from the vertex.
// A stroke can only be fully pointed or fully cut; this can be anything between.
// Vertices run clockwise with y pointing down, so (dy, -dx) is outward.
function saoOffsetPoly(pts, r, tipIdx, D = Infinity) {
  const n = pts.length;
  const rad = typeof r === "function" ? r : () => r;
  const lines = pts.map((a, i) => {
    const b = pts[(i + 1) % n];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const ri = rad(i);
    return { px: a[0] + dy * ri, py: a[1] - dx * ri, dx, dy };
  });
  const meet = (l1, l2) => {
    const den = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(den) < 1e-9) return [l2.px, l2.py];
    const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den;
    return [l1.px + l1.dx * t, l1.py + l1.dy * t];
  };
  const out = [];
  pts.forEach((V, i) => {
    const prev = lines[(i - 1 + n) % n], cur = lines[i];
    const A = meet(prev, cur);
    if (i === tipIdx) {
      let ux = A[0] - V[0], uy = A[1] - V[1];
      const dist = Math.hypot(ux, uy) || 1;
      if (dist > D) {
        ux /= dist; uy /= dist;
        const cut = { px: V[0] + ux * D, py: V[1] + uy * D, dx: -uy, dy: ux };
        out.push(meet(prev, cut), meet(cut, cur));
        return;
      }
    }
    out.push(A);
  });
  return out;
}

function saoBarSvg(W, H, pctVal, c1, c2) {
  if (uiSettings.saoBarStyle === "alo") return aloBarSvg(W, H, pctVal, c1, c2);
  if (uiSettings.saoBarStyle === "blk") return blkBarSvg(W, H, pctVal, c1, c2);
  const m = Math.ceil(SAO_RIM.greyW / 2);
  // The tip is a sharp mitred corner, and the grey rim's point sticks out past
  // the path. With only m of room the browser sliced it off flat, which read as
  // a rounded blob. Its horizontal reach is (stroke/2)(L + run)/rise for a tip
  // of that run and rise, so thinner bars (sharper tips) get more room.
  // The tip keeps the same angle on every bar: its run scales with the rise.
  // A fixed 4px run made thin bars' tips needle-thin, and a needle's rim point
  // runs on for many pixels. Room on the right is exactly the point's reach,
  // (rSlant*L + rTop*run)/rise for top and slant bands of rTop and rSlant.
  const rTop = SAO_RIM.greyW / 2, rSlant = SAO_RIM.slantW / 2;
  const rise0 = Math.max(0.5, SAO_SHAPE.drop * (H - m * 2));
  const run0 = Math.min(SAO_SHAPE.tip, rise0 * SAO_RIM.tipSlope);
  const reach = (rSlant * Math.hypot(run0, rise0) + rTop * run0) / rise0;
  const mr = Math.ceil(reach) + 1;
  const x0 = m, y0 = m, w = W - m - mr, h = H - m * 2;
  if (w <= 2 || h <= 1) return "";

  const stepX = clamp(SAO_SHAPE.step * w, 1, w - 2);
  const slope = Math.min(SAO_SHAPE.slope, Math.max(0, w - stepX - 1));
  const dropY = y0 + SAO_SHAPE.drop * h;
  const tipY = y0 + SAO_SHAPE.tipy * h;
  const tip = Math.min(run0, Math.max(0, w - stepX - slope - 1));

  const pts = [[x0, y0], [x0 + w, y0]];
  if (tipY > y0 + 0.01) pts.push([x0 + w, tipY]);
  pts.push([x0 + w - tip, dropY], [x0 + stepX + slope, dropY], [x0 + stepX, y0 + h], [x0, y0 + h]);
  const tipIdx = tipY > y0 + 0.01 ? 2 : 1;          // the sharp corner
  const d = "M" + pts.map((p) => `${p[0]} ${p[1]}`).join("L") + "Z";

  // Sharp mitred outlines. The grey band runs slimmer along the tip's slant
  // (edge tipIdx), which pulls its point in without blunting it.
  const poly = (r) => saoOffsetPoly(pts, r, tipIdx).map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");
  const greyPoly = poly((i) => (i === tipIdx ? rSlant : rTop));
  const metalPoly = poly(SAO_RIM.metalW / 2);

  const id = "s" + (++saoSvgUid);
  const f = clamp(pctVal, 0, 100) / 100;
  const fx = x0 + w * f;
  // The fill's leading edge is slanted to match the step. Slide that slant as
  // the bar fills so it lands flush at both ends: at 100% the BOTTOM corner
  // reaches the far edge (no grey slither in the tail), at 0% nothing shows.
  const topX = fx + slope * f;
  const botX = Math.max(x0, fx - slope * (1 - f));
  const fillPoly = pctVal > 0
    ? `<polygon points="${x0},${y0} ${topX},${y0} ${botX},${y0 + h} ${x0},${y0 + h}" fill="url(#g${id})" clip-path="url(#c${id})"/>`
    : "";

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none" shape-rendering="geometricPrecision" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="m${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${SAO_RIM.hi}"/><stop offset="1" stop-color="${SAO_RIM.lo}"/>
      </linearGradient>
      <linearGradient id="g${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
      </linearGradient>
      <clipPath id="c${id}"><path d="${d}"/></clipPath>
    </defs>
    <polygon points="${greyPoly}" fill="${SAO_RIM.grey}"/>
    <polygon points="${metalPoly}" fill="url(#m${id})"/>
    <path d="${d}" fill="${SAO_WELL}"/>
    ${fillPoly}
  </svg>`;
}

// Bars can only be drawn once they have a real pixel width, so the markup
// ships empty and this fills every .rpg-sao-bar after layout.
function saoDrawBar(el, p) {
  // the box's exact size: clientWidth/Height round to whole pixels, and at a
  // Bar size like 70% (5.6px tall) the drawing then didn't match its box
  const q = el.getBoundingClientRect();
  const W = Math.round(q.width * 100) / 100, H = Math.round(q.height * 100) / 100;
  if (!W || !H) return;
  el.innerHTML = saoBarSvg(W, H, p, el.dataset.c1 || "#b9f56d", el.dataset.c2 || "#63c322");
}

function saoTweenValue(key, target, draw, alive) {
  const animate = uiSettings.saoAnimate !== false
    && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!animate || !key) { if (key) saoLastPct.set(key, target); draw(target); return; }

  const from = saoLastPct.has(key) ? saoLastPct.get(key) : target;
  if (Math.abs(from - target) < 0.4) { saoLastPct.set(key, target); draw(target); return; }

  const token = (saoTweens.get(key) || 0) + 1;
  saoTweens.set(key, token);
  const t0 = performance.now(), dur = 420;
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  const step = (now) => {
    if (saoTweens.get(key) !== token || (alive && !alive())) return;
    const k = Math.min(1, (now - t0) / dur);
    const v = from + (target - from) * ease(k);
    saoLastPct.set(key, v);
    draw(v);
    if (k < 1) requestAnimationFrame(step);
    else saoLastPct.set(key, target);
  };
  requestAnimationFrame(step);
}

const ALO_MP = ["#7fb3e8", "#2d65a8"];

// The bars are a fixed length; the name compartment takes what the name
// needs (up to a cap) and the plate grows to fit, so a long name makes the
// plate longer instead of making the bars shorter.
function aloPlateGeom(H, nameW, barLen, bare, barH) {
  if (bare) {
    // characters: just the bars, their name sits on the line above
    const div = nameW > 0 ? Math.round(nameW + 8) : 0;
    const bx = nameW > 0 ? div + 2 : 1;
    const bEnd = bx + barLen;
    return { L: 0, R: 0, div, bx, bEnd, W: Math.round(bEnd + 2), bare: true, bh: H - 2, nameLeft: 0 };
  }
  const L = Math.max(5, Math.round(H * 0.42));     // left point depth
  const R = Math.max(5, Math.round(H * 0.5));      // right point depth
  const div = Math.round(L + 5 + nameW + 8);       // divider after the name
  const bx = div + 5;
  const bEnd = bx + barLen;
  const W = Math.round(bEnd + R * 0.45 + 3);
  return { L, R, div, bx, bEnd, W, bare: false, bh: barH || 0, nameLeft: L + 5 };
}

// A notch darker for the ALfheim bars, without touching the colour sweep the
// Aincrad bars share. Handles the hsl() the sweep produces and plain hex.
function aloDarken(c, amt) {
  const str = String(c || "").trim();
  let m = str.match(/^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i);
  if (m) return `hsl(${m[1]},${m[2]}%,${Math.max(0, parseFloat(m[3]) - amt).toFixed(1)}%)`;
  m = str.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16), k = 1 - amt / 70;
    const ch = (v) => Math.round(v * k).toString(16).padStart(2, "0");
    return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
  }
  return str;
}

// halfway between two #rrggbb colours; anything else falls back to the first
function aloMix(a, b) {
  const m1 = String(a).match(/^#([0-9a-f]{6})$/i), m2 = String(b).match(/^#([0-9a-f]{6})$/i);
  if (!m1 || !m2) return a;
  const x = parseInt(m1[1], 16), y = parseInt(m2[1], 16);
  const ch = (sh) => Math.round((((x >> sh) & 255) + ((y >> sh) & 255)) / 2).toString(16).padStart(2, "0");
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

function aloPlateSvg(W, H, geo, hp, mp, hpc, mpc) {
  hpc = hpc.map((c) => aloDarken(c, 9));
  mpc = mpc.map((c) => aloDarken(c, 9));
  const mpFlat = aloMix(mpc[0], mpc[1]);
  const { L, R, div, bx, bEnd } = geo;
  const mid = H / 2;
  const plate = `M${L} 1H${W - R}L${W - 1} ${mid}L${W - R} ${H - 1}H${L}L1 ${mid}Z`;
  const bh = geo.bh ? Math.min(geo.bh, H - 2) : H - Math.max(2, Math.round(H * 0.17)) * 2;
  const by = Math.round((H - bh) / 2);
  const pad = by;
  const tipIn = Math.max(3, bh * 0.6);
  const bw = Math.max(4, bEnd - bx);
  const frame = `M${bx} ${by}H${bEnd - tipIn}L${bEnd} ${mid}L${bEnd - tipIn} ${by + bh}H${bx}Z`;

  // HP and MP share the frame almost evenly, HP a touch heavier, meeting on a
  // silver seam instead of a dark gap
  const hpH = Math.round(bh * 0.53);
  const seam = by + hpH;
  const mpH = by + bh - seam;
  const id = "p" + (++saoSvgUid);
  const w = (p) => (bw * clamp(p, 0, 100)) / 100;

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="h${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${hpc[0]}"/><stop offset="1" stop-color="${hpc[1]}"/></linearGradient>
      <linearGradient id="m${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${mpc[0]}"/><stop offset="1" stop-color="${mpc[1]}"/></linearGradient>
      <linearGradient id="b${id}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="rgba(58,62,70,.78)"/>
        <stop offset="${(div / W).toFixed(3)}" stop-color="rgba(58,62,70,.62)"/>
        <stop offset="${((bx + (bEnd - bx) * 0.5) / W).toFixed(3)}" stop-color="rgba(58,62,70,.22)"/>
        <stop offset="${(Math.min(0.98, (bEnd - tipIn) / W)).toFixed(3)}" stop-color="rgba(58,62,70,.03)"/>
        <stop offset="1" stop-color="rgba(58,62,70,0)"/></linearGradient>
      <linearGradient id="v${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="rgba(255,255,255,.10)"/><stop offset=".5" stop-color="rgba(255,255,255,0)"/>
        <stop offset="1" stop-color="rgba(0,0,0,.14)"/></linearGradient>
      <linearGradient id="d${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="rgba(0,0,0,0)"/><stop offset="1" stop-color="rgba(0,0,0,.42)"/></linearGradient>
      <clipPath id="c${id}"><path d="${frame}"/></clipPath>
    </defs>
    ${geo.bare ? "" : `<path d="${plate}" fill="url(#b${id})"/>
    <path d="${plate}" fill="url(#v${id})"/>
    <line x1="${div}" y1="${Math.round(H * 0.16)}" x2="${div}" y2="${H - Math.round(H * 0.16)}" stroke="rgba(228,230,236,.85)" stroke-width="1.2"/>`}
    <g clip-path="url(#c${id})">
      <rect x="${bx}" y="${seam}" width="${bw}" height="${mpH}" fill="rgba(225,228,236,.2)"/>
      ${mp > 0 ? `<rect x="${bx}" y="${seam}" width="${w(mp)}" height="${mpH}" fill="${mpFlat}"/>` : ""}
      <rect x="${bx}" y="${by}" width="${bw}" height="${hpH}" fill="rgba(225,228,236,.26)"/>
      ${hp > 0 ? `<rect x="${bx}" y="${by}" width="${w(hp)}" height="${hpH}" fill="url(#h${id})"/>
      <rect x="${bx}" y="${seam - Math.max(2, Math.round(hpH * 0.5))}" width="${w(hp)}"
            height="${Math.max(2, Math.round(hpH * 0.5))}" fill="url(#d${id})"/>` : ""}
      <line x1="${bx}" y1="${seam}" x2="${bEnd}" y2="${seam}" stroke="rgba(214,218,226,.9)" stroke-width="1"/>
    </g>
    <path d="${frame}" fill="none" stroke="rgba(236,236,240,.78)" stroke-width="1" stroke-linejoin="miter"/>
  </svg>`;
}

// Titles ride above the plate: "Aldric, Warden of the Gate" or
// "Aldric - Warden of the Gate" shows "Aldric" on the plate and the rest above.
function aloSplitTitle(full) {
  const text = String(full || "").trim();
  const m = text.match(/^(.+?)(?:,\s+|\s+[\u2014\u2013-]\s+)(.+)$/);
  if (m && m[1].trim() && m[2].trim()) return { name: m[1].trim(), title: m[2].trim() };
  return { name: text, title: "" };
}

const ALO_NAME_CAP = { big: 170, small: 128 };   // px at 100%; past this, ellipsis
const ALO_BAR_LEN  = { big: 230, small: 150 };
const ALO_PLAYER_BAR_H = 20;   // px at 100%; the plate is taller, the bars aren't

function saoPaintAloPlates() {
  const plates = Array.from(document.querySelectorAll(".rpg-alo-plate"));
  if (!plates.length) return;
  const c = document.getElementById("rpg-hud-container");
  const ui = parseFloat(c ? getComputedStyle(c).getPropertyValue("--rpg-sao-ui") : "") || 1;

  // Everyone in a group shares the widest name's compartment, so their bars
  // start and end in the same place. The player's plate is its own group.
  // Characters carry their name above the bars, so only the player's plate
  // has a name compartment to size.

  plates.forEach((el) => {
    const small = el.classList.contains("small");
    const H = Math.round(el.getBoundingClientRect().height * 100) / 100;
    if (!H) return;
    const nameEl0 = el.querySelector(".rpg-alo-name");
    const nameW = small ? 0 : Math.min(nameEl0 ? nameEl0.scrollWidth : 0, ALO_NAME_CAP.big * ui);
    const geo = aloPlateGeom(H, nameW, Math.round(ALO_BAR_LEN[small ? "small" : "big"] * ui),
                             small, Math.round(ALO_PLAYER_BAR_H * ui));

    el.style.width = `${geo.W}px`;
    const nameEl = el.querySelector(".rpg-alo-name");
    if (nameEl) { nameEl.style.left = `${geo.nameLeft}px`; nameEl.style.width = `${Math.ceil(nameW)}px`; }

    const host = el.querySelector(".rpg-alo-svg");
    if (!host) return;
    const key = el.dataset.key || "p";
    const hpT = clamp(parseFloat(el.dataset.hp) || 0, 0, 100);
    const mpT = clamp(parseFloat(el.dataset.mp) || 0, 0, 100);
    let hpV = saoLastPct.has(`${key}:hp`) ? saoLastPct.get(`${key}:hp`) : hpT;
    let mpV = saoLastPct.has(`${key}:mp`) ? saoLastPct.get(`${key}:mp`) : mpT;
    const draw = () => {
      host.innerHTML = aloPlateSvg(geo.W, H, geo, hpV, mpV,
        [el.dataset.hp1, el.dataset.hp2], [el.dataset.mp1, el.dataset.mp2]);
    };
    const alive = () => el.isConnected;
    saoTweenValue(`${key}:hp`, hpT, (v) => { hpV = v; draw(); }, alive);
    saoTweenValue(`${key}:mp`, mpT, (v) => { mpV = v; draw(); }, alive);
  });
}

// a party member, NPC or enemy as a small ALfheim plate with HP over MP

// =====================================================================
// ALFHEIM (NEW) — the post-Oberon party HUD: a name with a strip of status
// tiles beside it, an emblem tile on the left, and flat HP / MP bars.
// =====================================================================
const BLK_MP = ["#62a5d6", "#2b76b0"];
// Any colour goes, grey and red included: the tile's icon says what a
// character is, so a red party member still can't be mistaken for an enemy.
// Enemies alone are always red, and alone carry the skull.
const BLK_TILES = [
  "#d9a52b", // gold
  "#3fae8c", // jade
  "#2f9fe0", // sky
  "#8a5cd0", // violet
  "#7cb342", // lime
  "#ec8a2e", // amber
  "#d9508f", // rose
  "#1fb6c9", // cyan
  "#5b6fe0", // indigo
  "#1b1d22", // black, like Kirito's tile in the game; the white rim keeps it readable
  "#8d949e", // grey, like Lisbeth's
  "#c9483a", // red
];

// shift an hsl() lightness, or blend a #hex toward white / black
function blkShade(c, amt) {
  const str = String(c || "").trim();
  let m = str.match(/^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i);
  if (m) return `hsl(${m[1]},${m[2]}%,${clamp(parseFloat(m[3]) + amt, 0, 100).toFixed(1)}%)`;
  m = str.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16), t = amt >= 0 ? 255 : 0, k = Math.min(1, Math.abs(amt) / 100);
    const ch = (v) => Math.round(v + (t - v) * k).toString(16).padStart(2, "0");
    return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
  }
  return str;
}

// Flat bar: a solid fill with the lighter band near its end that the game's
// bars have, a soft top sheen, and a thin light outline. Square ends.
function blkBarSvg(W, H, pctVal, c1, c2) {
  if (W < 4 || H < 2) return "";
  const id = "k" + (++saoSvgUid);
  const fw = (W - 1) * clamp(pctVal, 0, 100) / 100;
  // the band near the end is a gentle step up from the fill, not a highlight
  const base = blkShade(c2, 5), light = blkShade(base, 9);
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="f${id}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="${base}"/><stop offset=".72" stop-color="${base}"/>
        <stop offset=".725" stop-color="${light}"/><stop offset="1" stop-color="${light}"/></linearGradient>
      <linearGradient id="s${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="rgba(255,255,255,.28)"/><stop offset=".5" stop-color="rgba(255,255,255,0)"/>
        <stop offset="1" stop-color="rgba(0,0,0,.12)"/></linearGradient>
    </defs>
    <rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" fill="rgba(205,222,238,.12)"/>
    ${fw > 0 ? `<rect x=".5" y=".5" width="${fw}" height="${H - 1}" fill="url(#f${id})"/>
    <rect x=".5" y=".5" width="${fw}" height="${H - 1}" fill="url(#s${id})"/>` : ""}
    <rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" fill="none" stroke="rgba(225,235,245,.42)" stroke-width="1"/>
  </svg>`;
}

// Status tiles. Common effects get a pictogram and a colour, the rest a
// two-letter label, so nothing written by the model is ever dropped.
const s16 = (inner) => `<svg viewBox="0 0 16 16" aria-hidden="true">${inner}</svg>`;
const stroke = (d, w = 1.8) => `<path d="${d}" fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const BLK_STATUS = [
  { re: /poison|toxic|venom/i, c: "#7b4db3", i: s16('<path d="M8 2S3.5 7.5 3.5 10.2a4.5 4.5 0 0 0 9 0C12.5 7.5 8 2 8 2Z" fill="#fff"/>') },
  { re: /bleed/i, c: "#b3261e", i: s16('<path d="M8 2S3.5 7.5 3.5 10.2a4.5 4.5 0 0 0 9 0C12.5 7.5 8 2 8 2Z" fill="#fff"/>') },
  { re: /burn|fire|flame|scorch/i, c: "#d7263d", i: s16('<path d="M8 1.5c.5 2.5 3.5 3.8 3.5 7.2a3.5 3.5 0 0 1-7 0c0-1.4.6-2.4 1.4-3.2.1 1.3.8 2 1.6 2.3C7.3 5.8 7.4 3.6 8 1.5Z" fill="#fff"/>') },
  { re: /stun|paraly|shock|static/i, c: "#e0a21c", i: s16('<path d="M9 1.5 4 9h3.2l-.7 5.5L12 6.8H8.8L9 1.5Z" fill="#fff"/>') },
  { re: /freez|frozen|frost|chill|slow/i, c: "#2f8fc9", i: s16(stroke("M8 2v12M2.8 5l10.4 6M2.8 11l10.4-6", 1.6)) },
  { re: /regen|\bheal(?:ing|ed|s)?\b|restor|mend/i, c: "#3f9e57", i: s16(stroke("M8 3.2v9.6M3.2 8h9.6", 2.4)) },
  { re: /shield|barrier|protect|guard|veil|ward|aegis/i, c: "#3b7fb8", i: s16('<path d="M8 1.8 13 3.6v4.1c0 3.1-2.2 5.3-5 6.5-2.8-1.2-5-3.4-5-6.5V3.6Z" fill="#fff"/>') },
  { re: /haste|quick|speed|swift|agil/i, c: "#1f9aa6", i: s16(stroke("M3 4l4 4-4 4M8 4l4 4-4 4")) },
  { re: /strength|might|power|empower|rage|berserk|\bup\b|boost/i, c: "#e08a1c", i: s16(stroke("M8 13V3.5M4 7.5l4-4 4 4")) },
  { re: /weak|vulnerab|fatigue|winded|exhaust|tired|drain|\bdown\b/i, c: "#8a7a2e", i: s16(stroke("M8 3v9.5M4 8.5l4 4 4-4")) },
  { re: /critical|dying|near death/i, c: "#c0392b", i: s16(stroke("M8 2.5v7", 2.2) + '<circle cx="8" cy="12.6" r="1.3" fill="#fff"/>') },
  { re: /sleep|drows|asleep/i, c: "#5b5fb0", t: "Z" },
  { re: /blind|dark/i, c: "#44474d", i: s16('<path d="M1.8 8S4.3 3.8 8 3.8 14.2 8 14.2 8 11.7 12.2 8 12.2 1.8 8 1.8 8Z" fill="none" stroke="#fff" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="#fff"/>') },
  { re: /confus|charm|dazed/i, c: "#b04da8", t: "?" },
];

// words that mean "no status", which shouldn't be drawn as a tile at all
const BLK_NO_STATUS = /^(healthy|normal|none|fine|ok(ay)?|stable|unharmed|n\/a|-|\u2013|\u2014)$/i;

// Everything affecting one character: their Status list plus any running
// BUFF / DEBUFF timers they own (a timer with no owner is the player's).
// The same effect from both places is shown once, with the timer's time left
// added to its tooltip. Cooldowns, events and doom clocks aren't statuses.
function blkEffects(statusList, ownerName) {
  const byKey = new Map();
  const keyOf = (label) => {
    const n = BLK_STATUS.findIndex((b) => b.re.test(label));
    return n >= 0 ? `icon${n}` : label.toLowerCase();
  };

  (Array.isArray(statusList) ? statusList : []).forEach((x) => {
    const label = String(x).trim();
    if (!label || BLK_NO_STATUS.test(label)) return;
    const k = keyOf(label);
    if (!byKey.has(k)) byKey.set(k, { label, tip: label });
  });

  const me = ownerName ? normBondName(ownerName) : "";
  const playerKey = normBondName(rpgState?.name);
  (Array.isArray(rpgState?.timers) ? rpgState.timers : []).forEach((t) => {
    const kind = String(t?.kind || "").toUpperCase();
    if (kind !== "BUFF" && kind !== "DEBUFF") return;
    const owner = String(t?.owner || "").trim();
    const ownerKey = normBondName(owner);
    const mine = ownerName
      ? ownerKey === me
      : (!owner || /\{\{\s*user\s*\}\}/i.test(owner) || (playerKey && ownerKey === playerKey));
    if (!mine) return;

    const info = timerInfo(t);
    if (info.done) return;
    const label = String(t?.name || "").trim();
    if (!label) return;
    const k = keyOf(label);
    const left = `${label} \u00B7 ${info.label}`;
    if (byKey.has(k)) byKey.get(k).tip += ` \u00B7 ${info.label}`;
    else byKey.set(k, { label, tip: left, kind });
  });

  return [...byKey.values()];
}

function blkChips(list, max) {
  const all = (Array.isArray(list) ? list : [])
    .map((x) => (typeof x === "string" ? { label: x.trim(), tip: x.trim() } : x))
    .filter((x) => x && x.label && !BLK_NO_STATUS.test(x.label));
  const shown = all.slice(0, max || 6);
  const chips = shown.map((st) => {
    const hit = BLK_STATUS.find((b) => b.re.test(st.label));
    // unrecognised timer effects still say which way they cut
    const fallback = st.kind === "DEBUFF" ? "#a86a1c" : st.kind === "BUFF" ? "#3a8f5c" : "#5f6b77";
    const body = hit?.i || escHtml(hit?.t || st.label.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "?");
    return `<span class="rpg-blk-chip" style="background:${hit ? hit.c : fallback}" title="${escAttr(st.tip || st.label)}">${body}</span>`;
  }).join("");
  const more = all.length > shown.length
    ? `<span class="rpg-blk-more" title="${escAttr(all.slice(shown.length).map((x) => x.tip || x.label).join(", "))}">+${all.length - shown.length}</span>`
    : "";
  return chips + more;
}

// A name's preferred colour, from a well-mixed hash of it.
function blkHashIndex(name) {
  let h = 0x811c9dc5;
  for (const ch of String(name || "").toLowerCase()) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) % BLK_TILES.length;
}

// The player's tile is black unless you pick otherwise.
const BLK_PLAYER_TILE = "#1b1d22";
const blkNameKey = (name) => normBondName(name) || String(name ?? "");
function blkPlayerTileColor() {
  return uiSettings.tileColors?.["@player"] || BLK_PLAYER_TILE;
}

// Twelve colours can't stay distinct if each name picks alone, so everyone on
// screen is coloured together, in two steps:
//  1. Automatic colours, worked out as if nothing had been picked and the
//     player were black: each name starts at its preferred colour and steps to
//     the next free one. Earlier names keep theirs, so a newcomer never
//     recolours the party, and picking one person's colour never shuffles
//     anyone else's.
//  2. Picked colours win. Only someone whose automatic colour now clashes with
//     a picked one (or with the player's) moves, to the nearest free colour.
let blkColorMap = new Map();
function blkAssignColors(names) {
  const picked = uiSettings.tileColors || {};
  const N = BLK_TILES.length;

  const auto = new Map(), used = new Set([BLK_PLAYER_TILE]);
  names.forEach((n) => {
    const key = blkNameKey(n);
    if (!key || auto.has(key)) return;
    if (used.size >= N) used.clear();                      // more than twelve: start sharing
    let i = blkHashIndex(n);
    for (let t = 0; t < N && used.has(BLK_TILES[i]); t++) i = (i + 1) % N;
    auto.set(key, BLK_TILES[i]);
    used.add(BLK_TILES[i]);
  });

  const out = new Map(), taken = new Set([blkPlayerTileColor()]);
  auto.forEach((c, key) => { if (picked[key]) { out.set(key, picked[key]); taken.add(picked[key]); } });
  auto.forEach((c, key) => { if (!out.has(key) && !taken.has(c)) { out.set(key, c); taken.add(c); } });
  auto.forEach((c, key) => {
    if (out.has(key)) return;                               // only the ones that clashed
    let i = BLK_TILES.indexOf(c), found = c;
    for (let t = 0; t < N; t++) {
      i = (i + 1) % N;
      if (!taken.has(BLK_TILES[i])) { found = BLK_TILES[i]; break; }
    }
    out.set(key, found);
    taken.add(found);
  });
  blkColorMap = out;
}

function blkTileColor(name) {
  const key = blkNameKey(name);
  return uiSettings.tileColors?.[key] || blkColorMap.get(key) || BLK_TILES[blkHashIndex(name)];
}

// What sits in the tile, by what the character is. The player and party
// icons are the Status and Bonds orbs' own; NPCs get a speech bubble, the
// people you talk to; enemies an angry skull. evenodd punches the holes.
const BLK_ICONS = {
  player: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7.4" r="3.8"/><path d="M4.3 20.8c0-4.3 3.4-7 7.7-7s7.7 2.7 7.7 7z"/></svg>',
  // party: the Bonds orb's own icon, see blkIcon
  npc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M4 4.5h16A1.5 1.5 0 0 1 21.5 6v9a1.5 1.5 0 0 1-1.5 1.5h-8.6L6.5 20.2v-3.7H4A1.5 1.5 0 0 1 2.5 15V6A1.5 1.5 0 0 1 4 4.5ZM8 9.3a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm4 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm4 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z"/></svg>',
  enemy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M12 2.5c-4.7 0-8.3 3.4-8.3 7.8 0 2.6 1.2 4.6 3.1 5.8v2.4c0 .8.6 1.4 1.4 1.4h1v-2.2h1.6v2.2h2.4v-2.2h1.6v2.2h1c.8 0 1.4-.6 1.4-1.4v-2.4c1.9-1.2 3.1-3.2 3.1-5.8 0-4.4-3.6-7.8-8.3-7.8ZM6.6 9.2l4.1 1.5-.5 2.6-3.2-.8Zm10.8 0-4.1 1.5.5 2.6 3.2-.8ZM12 13.6l-1.2 2.1h2.4Z"/></svg>',
};
// The party icon is borrowed from the Bonds orb when a row is drawn, not at
// load: SAO_TABS is declared further down, and touching a const before its
// line throws, even behind typeof.
function blkIcon(kind) {
  if (kind === "party") return SAO_TABS.find((t) => t.id === "bonds")?.icon || BLK_ICONS.player;
  return BLK_ICONS[kind] || "";
}

// One character. Only the name is a tap target; the rest lets taps through.
function blkUnitRow(view, idx, key, opts = {}) {
  const foe = !!opts.foe, big = !!opts.big;
  const hp = opts.hpPct ?? saoPct(view.hp_curr, view.hp_max);
  const mp = opts.mpPct ?? saoPct(view.en?.curr, view.en?.max);
  const hs = view.isVeh ? SAO_PALETTE.vehicle : saoHpStops(hp);
  const full = opts.name ?? view.name;
  const { name, title } = aloSplitTitle(full);
  const num = barPair;
  const initial = (String(name).replace(/^[^\p{L}\p{N}]+/u, "")[0] || "?").toUpperCase();
  return `<div class="rpg-blk-row${big ? " big" : ""}${foe ? " foe" : ""}">
    <div class="rpg-blk-top">
    <div class="rpg-blk-plate"></div>
    <div class="rpg-blk-head">
      <span class="rpg-blk-name rpg-sao-jump" data-idx="${idx}" title="${escAttr(full)}">${escHtml(name)}</span>
      ${title ? `<span class="rpg-blk-title">${escHtml(title)}</span>` : ""}
      <span class="rpg-blk-chips">${blkChips(opts.status, big ? 8 : 6)}</span>
    </div>
    </div>
    <div class="rpg-blk-line">
    <div class="rpg-blk-tile" data-tkey="${escAttr(opts.kind === "player" ? "@player" : blkNameKey(name))}"
      style="background-color:${foe ? "#a8322a" : opts.kind === "player" ? blkPlayerTileColor() : blkTileColor(name)}">${
      blkIcon(opts.kind || (foe ? "enemy" : big ? "player" : "party")) || escHtml(initial)}</div>
    <div class="rpg-blk-bars">
      ${saoBarHtml("blkhp", hp, hs[0], hs[1], `${key}:hp`)}
      ${saoBarHtml("blkmp", mp, BLK_MP[0], BLK_MP[1], `${key}:mp`)}
    </div>
    <div class="rpg-blk-nums"><span>${opts.hpText ?? num(view.hp_curr, view.hp_max)}</span>
      <span>${opts.mpText ?? num(view.en?.curr, view.en?.max)}</span></div>
    </div>
  </div>`;
}

function aloUnitRow(view, idx, key, foe) {
  const hp = saoPct(view.hp_curr, view.hp_max);
  const mp = saoPct(view.en?.curr, view.en?.max);
  const hs = saoUnitStops(view);
  const { name, title } = aloSplitTitle(view.name);
  const num = barPair;
  return `<div class="rpg-alo-row">
    <div class="rpg-alo-unit rpg-sao-jump${foe ? " foe" : ""}" data-idx="${idx}" title="${escAttr(view.name)}">
      <div class="rpg-alo-label"><span class="rpg-alo-uname">${escHtml(name)}</span>${
        title ? `<span class="rpg-alo-utitle">${escHtml(title)}</span>` : ""}</div>
      <div class="rpg-alo-barline">
        <div class="rpg-alo-plate small" data-key="${escAttr(key)}" data-hp="${hp}" data-mp="${mp}"
          data-hp1="${hs[0]}" data-hp2="${hs[1]}" data-mp1="${ALO_MP[0]}" data-mp2="${ALO_MP[1]}">
          <div class="rpg-alo-svg"></div>
        </div>
        <div class="rpg-alo-unitnums"><span>${num(view.hp_curr, view.hp_max)}</span>
          <span>${num(view.en?.curr, view.en?.max)}</span></div>
      </div>
    </div>
  </div>`;
}

function saoPaintBars() {
  saoPaintAloPlates();
  const animate = uiSettings.saoAnimate !== false
    && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  document.querySelectorAll(".rpg-sao-bar").forEach((el) => {
    const target = clamp(parseFloat(el.dataset.p || "0"), 0, 100);
    const key = el.dataset.key;

    // A bar keyed to a character keeps its last value across re-renders, so a
    // hit slides the bar down instead of snapping. Unkeyed bars just draw.
    if (!animate || !key) { saoDrawBar(el, target); if (key) saoLastPct.set(key, target); return; }

    const from = saoLastPct.has(key) ? saoLastPct.get(key) : target;
    if (Math.abs(from - target) < 0.4) { saoLastPct.set(key, target); saoDrawBar(el, target); return; }

    const token = (saoTweens.get(key) || 0) + 1;   // supersede any running tween
    saoTweens.set(key, token);
    const t0 = performance.now(), dur = 420;
    const ease = (x) => 1 - Math.pow(1 - x, 3);

    const step = (now) => {
      if (saoTweens.get(key) !== token || !el.isConnected) return;
      const k = Math.min(1, (now - t0) / dur);
      const v = from + (target - from) * ease(k);
      saoLastPct.set(key, v);
      saoDrawBar(el, v);
      if (k < 1) requestAnimationFrame(step);
      else saoLastPct.set(key, target);
    };
    requestAnimationFrame(step);
  });
}

const SAO_PALETTE = {
  mp: ["#7fd4ff", "#2e8fd6"],
  meter: ["#d9b6f5", "#8d4fd1"],
  vehicle: ["#e0a6f0", "#9b3fbf"],
};

function saoBarHtml(cls, pctVal, c1, c2, key) {
  return `<div class="rpg-sao-bar ${cls}" data-p="${pctVal}" data-c1="${c1}" data-c2="${c2}"`
    + `${key ? ` data-key="${escAttr(key)}"` : ""}></div>`;
}

function saoSlimRow(name, curr, max, stops, jumpIdx, foe, key) {
  const p = saoPct(curr, max);
  const cls = `rpg-sao-tag${foe ? " foe" : ""}`;
  const tag = jumpIdx === null || jumpIdx === undefined
    ? `<span class="${cls}">${escHtml(name)}</span>`
    : `<button class="${cls} rpg-sao-jump" data-idx="${jumpIdx}" title="Open ${escAttr(name)}">${escHtml(name)}</button>`;
  return `<div class="rpg-sao-row">${tag}${saoBarHtml("slim", p, stops[0], stops[1], key)}
    <span class="rpg-sao-num">${barPair(curr, max)}</span></div>`;
}

// A unit in an active vehicle is displayed as the vehicle, the way the
// classic skin does it, so the bars and chips don't show a stale pilot.
function saoUnitView(unit) {
  const v = unit?.vehicle;
  if (v && v.active) {
    return { name: `\u{1F916} ${displayName(v.name, "Vehicle")}`, hp_curr: v.hp_curr, hp_max: v.hp_max,
             isVeh: true, en: getEnergy(v, true),
             meters: Array.isArray(v.meters) ? v.meters : [] };
  }
  return { name: unit === rpgState ? playerDisplayName() : displayName(unit?.name, "?"),
           hp_curr: unit?.hp_curr, hp_max: unit?.hp_max,
           isVeh: false, en: getEnergy(unit, false),
           meters: Array.isArray(unit?.meters) ? unit.meters : [] };
}

// Everyone's HP runs the same green-to-red sweep, enemies included: the bar
// reports how hurt they are, and hostility is already carried by the ROUND
// header, the red chips and the fact that they're in the combat group.
function saoUnitStops(view) {
  if (view.isVeh) return SAO_PALETTE.vehicle;
  return saoHpStops(saoPct(view.hp_curr, view.hp_max));
}

function saoMeterColor(name) {
  try {
    const c = typeof meterColorByName === "function" ? meterColorByName(name) : null;
    return c ? [c, c] : SAO_PALETTE.meter;
  } catch { return SAO_PALETTE.meter; }
}

// Shields, sanity and the like, tucked under whoever owns them.
function saoMeterRows(view, owner) {
  const ms = Array.isArray(view?.meters) ? view.meters : [];
  if (!ms.length) return "";
  return ms.map((m) => {
    const c = saoMeterColor(m.name);
    return `<div class="rpg-sao-row sub"><span class="rpg-sao-tag">${escHtml(m.name)}</span>`
      + saoBarHtml("slim", saoPct(m.curr, m.max), c[0], c[1], `${owner || "?"}/m:${normBondName(m.name)}`)
      + `<span class="rpg-sao-num">${barPair(m.curr, m.max)}</span></div>`;
  }).join("");
}

function saoDivider(label, key, color) {
  if (!color && key === "npcs") color = "#bcd4e8";
  const open = !saoCollapsed[key];
  return `<div class="rpg-sao-div" ${color ? `style="color:${color}"` : ""}><span class="rpg-sao-divlabel" data-k="${key}"
      title="${open ? "Collapse" : "Expand"}">${escHtml(label)}</span>
    <button class="rpg-sao-caret" data-k="${key}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${escAttr(label)}">${open ? "&#9662;" : "&#9656;"}</button>
  </div>`;
}

// ---- panels -------------------------------------------------------------
function saoStatusPanel() {
  const { root, display, type, isVehicle } = getActiveData();
  const name = display === rpgState ? playerDisplayName()
             : displayName(display?.name || root?.name, "Unit");

  const subs = [["stats","Stats"],["inventory","Items"],["skills","Skills"],
                ["passives","Passive"],["masteries","Mastery"]];
  let h = `<div class="rpg-sao-subtabs">` + subs.map(([k, label]) =>
    `<button class="rpg-sao-subtab${saoSub === k ? " on" : ""}" data-sub="${k}">${label}</button>`
  ).join("") + `</div>`;

  if (saoSub === "stats") {
    const en = getEnergy(display, isVehicle);
    h += `<div class="rpg-sao-vline"><span>HP</span><b>${renderInlineValue(display.hp_curr)} / ${renderInlineValue(display.hp_max)}</b></div>`;
    h += `<div class="rpg-sao-vline"><span>${escHtml(en.label || "MP")}</span><b>${renderInlineValue(en.curr)} / ${renderInlineValue(en.max)}</b></div>`;
    // tile colour: ALfheim (New) only, and never for enemies, who stay red
    if (uiSettings.saoBarStyle === "blk" && type !== "enemy") {
      const tName = type === "player" ? "" : aloSplitTitle(saoUnitView(root).name).name;
      const tKey = type === "player" ? "@player" : blkNameKey(tName);
      const tCur = type === "player" ? blkPlayerTileColor() : blkTileColor(tName);
      const picked = !!uiSettings.tileColors?.[tKey];
      h += `<div class="rpg-sao-vline rpg-sao-tilecolor"><span>Tile colour</span><b>
        <input type="color" id="rpg-sao-tilecolor" data-key="${escAttr(tKey)}" value="${escAttr(tCur)}" title="Pick this character's tile colour">
        ${picked ? `<button class="rpg-sao-mini" id="rpg-sao-tilecolor-auto" data-key="${escAttr(tKey)}" title="Back to the automatic colour">\u21BA auto</button>` : ""}
      </b></div>`;
    }
    if ((type === "party" || type === "npc") && !isVehicle) {
      const has = root?.bond !== undefined && root?.bond !== null && String(root.bond).trim() !== "";
      const b = has ? parseBondValue(root.bond) : null;
      const blocked = bondBlocklist.has(normBondName(root?.name));
      h += `<div class="rpg-sao-vline rpg-sao-livebond"><span>Bond${blocked ? ` <i title="Kept off the Bonds list">(hidden)</i>` : ""}</span><b>
        <input type="text" inputmode="numeric" id="rpg-sao-livebond" value="${b === null ? "" : b >= 101 ? "\u221E" : b}"
          placeholder="none" title="0\u2013100, or \u221E. Leave empty for no bond. Enter to save."> / 100</b></div>`;
    }
    if (MOVE_KEYS[type]) {
      h += `<div class="rpg-sao-vline rpg-sao-move"><span>Move to</span><b>` +
        Object.keys(MOVE_KEYS).filter((t) => t !== type).map((t) =>
          `<button class="rpg-sao-mini rpg-sao-moveto" data-to="${t}">${MOVE_LABELS[t]}</button>`).join("") +
        `</b></div>`;
    }
    const stats = display.stats || {};
    const keys = Object.keys(stats);
    if (keys.length) {
      h += `<div class="rpg-sao-grid">` + keys.map((k) =>
        `<div><span>${escHtml(k.toUpperCase())}</span><span>${renderInlineValue(stats[k])}</span></div>`
      ).join("") + `</div>`;
    }
    const coin = toNumberOr(display.dankcoin ?? root?.dankcoin ?? 0, 0);
    h += `<div class="rpg-sao-vline" style="margin-top:8px;"><span>Coin</span><b>${escHtml(coin)}</b></div>`;

    h += saoMetersSection(display);

    const st = Array.isArray(display.status_effects) ? display.status_effects : [];
    h += `<div class="rpg-sao-status">Status: ` +
      (st.length ? `<b>${st.map(escHtml).join(", ")}</b>` : `Healthy`) + `</div>`;
  } else {
    const list = Array.isArray(display[saoSub]) ? display[saoSub] : [];
    if (saoSub === "masteries") {
      h += saoMasteriesSection(list);
    } else {
      if (saoListEdit && saoListEdit.key === saoSub) {
        h += saoListEditorHtml(saoSub);
      } else {
        // icons double as the way in: tap one to edit this list
        h += list.length
          ? `<ul class="rpg-sao-entries with-icons">` + (() => {
              const who = activeListOwner();
              const lockedSet = new Set(who === undefined ? [] : lockedIndices(list.map(String), posLocksFor(ownerIdOf(who), saoSub)).map((l) => l.i));
              return list.map((it, i) => saoListItemWithIcon(saoSub, it, true, i, lockedSet)).join("");
            })() + `</ul>`
          : `<p class="rpg-sao-empty">Nothing recorded. <button class="rpg-sao-mini rpg-sao-ico" data-list="${saoSub}">+ Add</button></p>`;
      }
    }
  }
  return { title: name, body: h };
}

// charIndexFor lays them out player, party, enemies, npcs. This reads that back.
function saoRosterOf(idx) {
  const p = Array.isArray(rpgState.party) ? rpgState.party.length : 0;
  const e = Array.isArray(rpgState.enemies) ? rpgState.enemies.length : 0;
  if (idx <= 0) return "player";
  if (idx < 1 + p) return "party";
  if (idx < 1 + p + e) return "enemy";
  return "npc";
}

function saoRosterGroups() {
  const party = Array.isArray(rpgState.party) ? rpgState.party : [];
  const npcs = Array.isArray(rpgState.npcs) ? rpgState.npcs : [];
  const enemies = Array.isArray(rpgState.enemies) ? rpgState.enemies : [];
  return [
    { key: "player", label: "You", type: "player", list: [rpgState] },
    { key: "party", label: "Party", type: "party", list: party },
    { key: "npc", label: "NPCs", type: "npc", list: npcs },
    { key: "enemy", label: "Enemies", type: "enemy", list: enemies },
  ].filter((g) => g.list.length);
}

// Two rows instead of one long scroll: pick the group, then the character.
// The second row is dropped when the group holds only one of them.
// ---- meters: read view, or an inline editor for whoever is on the sheet ----
function saoMetersSection(display) {
  const meters = Array.isArray(display.meters) ? display.meters : [];

  if (saoMeterEdit) {
    const rows = saoMeterEdit.map((m, i) => `
      <div class="rpg-sao-mrow-edit" data-i="${i}">
        ${reorderBtns("meter", i, saoMeterEdit.length)}
        <input type="color" class="rpg-sao-m-color" data-i="${i}" value="${escAttr(m.color)}"
          title="Colour${m.custom ? "" : " (automatic)"}">
        <input type="text" class="rpg-sao-m-name" data-i="${i}" value="${escAttr(m.name)}" placeholder="Name">
        <input type="text" class="rpg-sao-m-curr" data-i="${i}" value="${escAttr(m.curr)}" inputmode="decimal">
        <span class="rpg-sao-m-slash">/</span>
        <input type="text" class="rpg-sao-m-max" data-i="${i}" value="${escAttr(m.max)}" inputmode="decimal">
        <button class="rpg-sao-m-auto${m.custom ? "" : " off"}" data-i="${i}" title="Back to automatic colour">&#8634;</button>
        <button class="rpg-sao-m-del" data-i="${i}" title="Remove">&#10005;</button>
      </div>`).join("");

    return `<div class="rpg-sao-subhead"><span class="rpg-sao-sub">Meters</span></div>
      <div class="rpg-sao-meditor">
        ${rows || `<p class="rpg-sao-empty">No meters. Add one below.</p>`}
        <button class="rpg-sao-mini" id="rpg-sao-m-add">+ Add meter</button>
        <div class="rpg-sao-medit-actions">
          <button class="rpg-sao-mini" id="rpg-sao-m-cancel">Cancel</button>
          <button class="rpg-sao-mini primary" id="rpg-sao-m-save">Save</button>
        </div>
      </div>`;
  }

  const list = meters.length
    ? meters.map((m) => {
        const c = meterColorByName(m.name);
        return `<div class="rpg-sao-vline"><span><i class="rpg-sao-swatch" style="background:${c}"></i>${escHtml(m.name)}</span>
          <b>${escHtml(m.curr)} / ${escHtml(m.max)}</b></div>`;
      }).join("")
    : `<p class="rpg-sao-empty">No meters.</p>`;

  return `<div class="rpg-sao-subhead"><span class="rpg-sao-sub">Meters</span>
      <button class="rpg-sao-mini" id="rpg-sao-m-edit">&#9998; Edit</button></div>${list}`;
}


// =====================================================================
// LIST ICONS + EDITING (Status orb: Items, Skills, Passive)
// An entry's icon comes from its name (the part before any description):
// weapons are checked first, so "Angel Halo (Blade)" is a sword, not jewellery.
// Tapping an icon opens that list for editing in place.
// =====================================================================
const ico = (d, extra = "") => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/>${extra}</svg>`;
const LIST_ICONS = {
  sword:   ico("M20 4v4l-9.5 9.5-4-4L16 4z M5 13l6 6 M7.5 16.5 4 20"),
  dagger:  ico("M18 4.5v3.5l-6.5 6.5-3-3L15 5z M6.5 11.5l6 6 M8.5 15.5 5 19"),
  spear:   ico("M4 20 14.5 9.5 M14.5 9.5l1.6-5.2 4.6-1.6-1.6 4.6z"),
  axe:     ico("M5 20 14 11 M12.5 3.5c4.5.3 7.7 3.5 8 8l-3.2 1L11.5 6.7z"),
  hammer:  ico("M5 20l8-8 M10.6 5.6l4.2-2.4 5.9 5.9-2.4 4.2z"),
  bow:     ico("M5 3.5c8.3 0 15.5 7.2 15.5 15.5 M5 3.5 20.5 19 M3.5 9.5 9 4"),
  gun:     ico("M3 8.5h16l1 2.5h-8.5l-1.3 2.5H7.6L6.6 19H3.5z M12 11v2"),
  staff:   ico("M5 20l9.5-9.5", '<circle cx="17" cy="7" r="3.2"/>'),
  shield:  ico("M12 3l7 2.8v5.4c0 4.4-2.9 7.8-7 9.8-4.1-2-7-5.4-7-9.8V5.8z"),
  armor:   ico("M8 3.5h8l4 3.7-3 3V20.5H7V10.2l-3-3z M10 3.5c0 1.4.9 2.4 2 2.4s2-1 2-2.4"),
  ring:    ico("M10 6.5l2-3 2 3-2 2z", '<circle cx="12" cy="14.5" r="5.3"/>'),
  potion:  ico("M9.5 3h5 M10.5 3v5.2L5.7 16.8a2.6 2.6 0 0 0 2.3 3.9h8a2.6 2.6 0 0 0 2.3-3.9L13.5 8.2V3 M7.4 14.5h9.2"),
  food:    ico("M12 7.5c-3-2-7.2 0-7.2 4.9s3 8.1 5.2 8.1c1 0 1.4-.5 2-.5s1 .5 2 .5c2.2 0 5.2-3.2 5.2-8.1S15 5.5 12 7.5z M12 7.5c0-2 1-3.3 3-4"),
  key:     ico("M10.4 12.6 20 3 M17 6l2.2 2.2 M14.6 8.4l2.2 2.2", '<circle cx="7.6" cy="15.4" r="3.6"/>'),
  book:    ico("M5 4.5h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z M5 17.5a3 3 0 0 1 3-3h11"),
  gem:     ico("M5.5 9.5l3.2-5h6.6l3.2 5L12 20.5z M5.5 9.5h13 M9.5 9.5 12 20.5l2.5-11"),
  coin:    ico("", '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="4"/>'),
  bag:     ico("M5.5 8.5h13l1.2 12H4.3z M9 8.5V7a3 3 0 0 1 6 0v1.5"),
  phone:   ico("M8 2.5h8a1.6 1.6 0 0 1 1.6 1.6v15.8a1.6 1.6 0 0 1-1.6 1.6H8a1.6 1.6 0 0 1-1.6-1.6V4.1A1.6 1.6 0 0 1 8 2.5z M10.5 18.3h3"),
  laptop:  ico("M5.5 5.5h13v9h-13z M2.8 18.5h18.4l-1.7-4H4.5z"),
  camera:  ico("M4 8.2h3.4l1.6-2.6h6l1.6 2.6H20v10.6H4z", '<circle cx="12" cy="13.4" r="3.4"/>'),
  misc:    ico("M9 9.2a3 3 0 1 1 4.6 2.5c-1 .6-1.6 1.3-1.6 2.6 M12 17.6v.4"),
  quest:   ico("M6 21V3.5 M6 4.5h11.5l-2.5 4 2.5 4H6"),
  // skills and passives
  fire:    ico("M12 3c.9 3.1 5 5 5 10.2a5 5 0 0 1-10 0c0-3 1.8-4.2 2-6.2 1.1.9 1.9 2 2 3.3 1.2-2.1 1.3-4.6 1-7.3z"),
  ice:     ico("M12 3v18 M4.2 7.5l15.6 9 M4.2 16.5l15.6-9 M9.5 4.5 12 7l2.5-2.5 M9.5 19.5 12 17l2.5 2.5"),
  bolt:    ico("M13.5 3 6 13.5h5.3L10.5 21 18 10.5h-5.3z"),
  heal:    ico("M9.5 4h5v5.5H20v5h-5.5V20h-5v-5.5H4v-5h5.5z"),
  dark:    ico("M15.5 4a8.2 8.2 0 1 0 4.8 13.2A6.4 6.4 0 0 1 15.5 4z"),
  wind:    ico("M3 9h11a3 3 0 1 0-3-3 M3 14h15a3 3 0 1 1-3 3 M3 19h6"),
  burst:   ico("M12 3l2.1 6H20l-4.8 3.6 1.9 6.9L12 15.6 6.9 19.5l1.9-6.9L4 9h5.9z"),
  badge:   ico("M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z", '<circle cx="12" cy="12" r="2.4"/>'),
};

// first match wins, so weapons come before anything they might be mistaken for
const ITEM_KINDS = [
  ["dagger", /\b(dagger|knife|dirk|stiletto|kunai|tanto|shiv)\b/],
  ["sword",  /(sword|blade|rapier|katana|sabre|saber|claymore|scimitar|cutlass|estoc|falchion|odachi|zweihander|wakizashi|longsword|greatsword)/],
  ["spear",  /\b(spear|lance|pike|halberd|glaive|trident|naginata|polearm|javelin|partisan)\b/],
  ["axe",    /\b(axe|hatchet|battleaxe|greataxe|tomahawk)\b/],
  ["hammer", /\b(hammer|mace|maul|club|flail|morningstar|warhammer|cudgel)\b/],
  ["bow",    /\b(bow|crossbow|longbow|shortbow|arrows?|bolts?|quiver)\b/],
  ["gun",    /\b(gun|pistol|rifle|revolver|musket|shotgun|blaster|sniper|carbine|ammo|bullets?)\b/],
  // electronics. Left out on purpose, since they usually mean something else in
  // fantasy: "tablet" (stone, medicine), "cell" (prison), "chip", "notebook"
  ["phone",  /\b(phone|smartphone|cellphone|iphone|mobile|radio|walkie|walkie-talkie|communicator|comms?|pager|beeper|pda|handset|headset|earpiece|transceiver|transmitter|receiver|scanner|tracker|gadget|device|smartwatch)\b/],
  ["laptop", /\b(laptop|computer|pc|terminal|console|datapad|monitor|keyboard|usb|drive|disk|disc|server|hard drive|flash drive)\b/],
  ["camera", /\b(camera|camcorder|polaroid|binoculars|telescope|spyglass)\b/],
  ["staff",  /\b(staff|wand|rod|scepter|sceptre|orb|focus)\b/],
  ["shield", /\b(shield|buckler|aegis)\b/],
  ["armor",  /\b(armou?r|mail|plate|helm|helmet|gauntlets?|greaves|boots|cloak|robes?|coat|shirt|dress|jacket|tunic|hood|gloves|cape|vest|pants|trousers|uniform|outfit|clothes|clothing|garb|leathers?|hat|mask|belt)\b/],
  ["potion", /\b(potion|elixir|tonic|draught|vial|flask|antidote|salve|crystal|bandages?|medicine|pills?|herbs?)\b/],
  ["food",   /\b(food|bread|rations?|meat|apple|fruit|stew|cheese|jerky|berr(y|ies)|fish|cake|pie|drink|water|ale|wine|tea|soup|meal)\b/],
  ["key",    /\b(key|keycard|keys)\b/],
  ["book",   /\b(scroll|book|tome|map|letter|note|journal|grimoire|manual|page|diary|contract)\b/],
  ["ring",   /\b(ring|amulet|necklace|pendant|bracelet|earrings?|charm|talisman|brooch|circlet|crown|halo|locket|keychain|keyring|trinket|bauble|accessory|accessories|pin|badge|emblem|anklet|tiara|choker|strap|watch|wristwatch)\b/],
  ["gem",    /\b(gem|jewel|ruby|emerald|sapphire|diamond|ore|ingot|shard|stone|pearl|materials?|hide|pelt|scales?|fang|claw|bone|crystals)\b/],
  ["coin",   /\b(coins?|gold|purse|pouch|money|col)\b/],
  ["bag",    /\b(rope|torch|lantern|pickaxe|shovel|lockpicks?|tools?|kit|compass|tent|bedroll|bag|backpack|satchel|flint|whetstone|sheath|scabbard|holster|case)\b/],
];
const SKILL_KINDS = [
  ["heal",   /\b(heal\w*|cure|regen\w*|restor\w*|mend\w*|revive|resurrect\w*|holy)\b/],
  ["fire",   /\b(fire\w*|flame\w*|burn\w*|blaze|inferno|ember|scorch\w*|pyro\w*|magma|lava)\b/],
  ["ice",    /\b(ice|icy|frost\w*|freez\w*|cold|snow|blizzard|glacia\w*|cryo\w*)\b/],
  ["bolt",   /\b(lightning|thunder\w*|shock\w*|bolt|spark\w*|static|volt\w*|electr\w*)\b/],
  ["dark",   /\b(dark\w*|shadow\w*|curse\w*|void|necro\w*|death|drain\w*|blood)\b/],
  ["wind",   /\b(wind|gust|dash\w*|blink|teleport\w*|step|veil|phase|evade|evasion|dodge|haste|swift\w*|sprint)\b/],
  ["shield", /\b(guard\w*|shield\w*|barrier|protect\w*|ward\w*|parry|block\w*|fortif\w*|resist\w*|armou?r)\b/],
];

// Items: what kind of thing is it? Names put the main noun last ("Sword Charm
// Keychain" is a keychain, "Iron Sword" a sword), so:
//   1. a type in brackets wins: "Angel Halo (Blade)" is a sword
//   2. then the name's last word, quantities and stat bonuses aside
//   3. then any word, in category order ("Ring of Fire" ends on "Fire")
// [...] notes are ignored entirely: "Keychain [Attached to Katana]" is a keychain.
function listIconKind(listKey, text, opts = {}) {
  if (listKey === "quests") return "quest";
  if (!opts.auto) {
    const ov = iconOverrideFor(listKey, text);
    if (ov && LIST_ICONS[ov]) return ov;
  }
  if (listKey === "inventory") {
    const head = String(descSplit(text).head || text).toLowerCase();
    const paren = (head.match(/\(([^)]*)\)/g) || []).join(" ");
    const base = head.replace(/\([^)]*\)/g, " ")
      .replace(/\s[+\-\u2212]\s?\d.*$/, "")              // "+10 ATK" and on
      .replace(/\b(x\d+|\d+x|\d+)\b/g, " ")               // "x3", "3x", bare numbers
      .replace(/\s+/g, " ").trim();
    const last = base.split(" ").pop() || "";
    for (const part of [paren, last, base]) {
      if (!part) continue;
      for (const [kind, re] of ITEM_KINDS) if (re.test(part)) return kind;
    }
    return "misc";
  }
  // skills and passives: the whole entry speaks to what they do
  const all = stripStatusTags(String(text)).toLowerCase();
  for (const [kind, re] of SKILL_KINDS) if (re.test(all)) return kind;
  return listKey === "passives" ? "badge" : "burst";
}

// ---- icons you've picked yourself ----
// Keyed by list and the entry's name (the part before any description), so
// they survive the AI rewording a description or changing a "+10 ATK", and
// apply in every chat. Kept in SillyTavern's own settings when available, so
// they follow you to your other devices, with a local copy as a fallback.
const ICON_OVR_KEY = "rpgHud:iconOverrides";
let iconOvrLocal = null;
function iconOverridesAll() {
  try {
    const synced = SillyTavern.getContext()?.extensionSettings?.rpgHud?.iconOverrides;
    if (synced && typeof synced === "object") return synced;
  } catch {}
  if (!iconOvrLocal) {
    try { iconOvrLocal = JSON.parse(localStorage.getItem(ICON_OVR_KEY) || "{}") || {}; } catch { iconOvrLocal = {}; }
  }
  return iconOvrLocal;
}
function saveIconOverrides(map) {
  iconOvrLocal = map;
  try { localStorage.setItem(ICON_OVR_KEY, JSON.stringify(map)); } catch {}
  try {
    const ctx = SillyTavern.getContext();
    if (ctx?.extensionSettings) {
      ctx.extensionSettings.rpgHud = ctx.extensionSettings.rpgHud || {};
      ctx.extensionSettings.rpgHud.iconOverrides = map;
      ctx.saveSettingsDebounced?.();
    }
  } catch {}
}
const iconOvrKey = (listKey, text) => `${listKey}|${tItemKey(text)}`;
function iconOverrideFor(listKey, text) {
  const k = tItemKey(text);
  return k ? iconOverridesAll()[`${listKey}|${k}`] || null : null;
}
function setIconOverride(listKey, text, kind) {
  if (!tItemKey(text)) return;
  const map = { ...iconOverridesAll() };
  if (kind && LIST_ICONS[kind]) map[iconOvrKey(listKey, text)] = kind;
  else delete map[iconOvrKey(listKey, text)];
  saveIconOverrides(map);
}

// every icon, the list's own kind first
const ITEM_ICON_ORDER = ["sword", "dagger", "spear", "axe", "hammer", "bow", "gun", "staff", "shield", "armor", "ring", "potion",
  "food", "key", "book", "gem", "coin", "bag", "phone", "laptop", "camera", "misc"];
const SKILL_ICON_ORDER = ["fire", "ice", "bolt", "heal", "dark", "wind", "burst", "badge"];
function iconPickerHtml(listKey, i, current, isCustom) {
  const order = listKey === "inventory" ? [...ITEM_ICON_ORDER, ...SKILL_ICON_ORDER] : [...SKILL_ICON_ORDER, ...ITEM_ICON_ORDER];
  return `<div class="rpg-sao-icopick">
      <button class="rpg-sao-ico rpg-sao-pickopt auto${isCustom ? "" : " on"}" data-i="${i}" data-kind="" title="Pick from the name">Auto</button>
      ${order.map((k) => `<button class="rpg-sao-ico rpg-sao-pickopt${isCustom && current === k ? " on" : ""}" data-i="${i}" data-kind="${k}" title="${k}">${LIST_ICONS[k]}</button>`).join("")}
    </div>`;
}

function listIconHtml(listKey, text, editable) {
  const kind = listIconKind(listKey, text);
  return editable
    ? `<button class="rpg-sao-ico" data-list="${listKey}" title="${escAttr(kind === "misc" ? "Misc" : kind)} \u00B7 tap to edit this list">${LIST_ICONS[kind]}</button>`
    : `<span class="rpg-sao-ico">${LIST_ICONS[kind]}</span>`;
}

// ---- reordering rows in any of the Status orb's editors ----
// Buttons, not dragging: they're easier to hit on a touch screen. Each editor
// keeps its rows in a plain list, so moving one is a swap with a neighbour;
// Save then writes them in the new order. Order isn't an edit, so it's only
// written to the latest reply, never pushed into earlier ones.
function reorderBtns(kind, i, n) {
  return `<span class="rpg-sao-reorder">` +
    `<button class="rpg-sao-mv" data-kind="${kind}" data-i="${i}" data-d="-1"${i === 0 ? " disabled" : ""} title="Move up">\u25B2</button>` +
    `<button class="rpg-sao-mv" data-kind="${kind}" data-i="${i}" data-d="1"${i === n - 1 ? " disabled" : ""} title="Move down">\u25BC</button></span>`;
}

function reorderRows(kind) {
  if (kind === "list") return saoListEdit?.rows || null;
  if (kind === "mastery") return Array.isArray(saoMasteryEdit) ? saoMasteryEdit : null;
  if (kind === "meter") return Array.isArray(saoMeterEdit) ? saoMeterEdit : null;
  return null;
}

// ---- telling same-name entries apart ----
// "Vorpal Strike (Lv1)" and "Vorpal Strike (Lv3)" share the name key
// "vorpal strike". When a key matches more than one entry, the one whose text
// is most like the target wins. A lone match is taken by name alone, so a
// reworded description never breaks anything.
function textWords(t) {
  return new Set(stripStatusTags(String(t ?? "")).toLowerCase().split(/[^a-z0-9+*.\-]+/).filter(Boolean));
}
function textSimilarity(a, b) {
  if (String(a).trim() === String(b).trim()) return 2;            // identical beats everything
  const A = textWords(a), B = textWords(b);
  let n = 0;
  A.forEach((w) => { if (B.has(w)) n++; });
  return n / Math.max(1, Math.max(A.size, B.size));
}
// index in items of the entry best matching (key, text), skipping taken ones
function bestEntryIndex(items, key, text, taken = new Set()) {
  let best = -1, score = -1;
  items.forEach((t, i) => {
    if (taken.has(i) || tItemKey(t) !== key) return;
    const sc = text ? textSimilarity(t, text) : 0;
    if (sc > score) { score = sc; best = i; }
  });
  return best;
}

// ---- position locks ----
// A locked entry keeps its place in its list (1st, 2nd, 3rd...). After each
// new reply, locked entries the AI moved are put back; the unlocked ones keep
// their own order around them. Locks are matched by name, so a reworded
// description doesn't break one, and kept per chat:
//   { chatKey: { ownerId: { listKey: { itemKey: position } } } }
const POSLOCKS_KEY = "rpgHud:posLocks";
const POS_FIELDS = { inventory: "INV", skills: "Skills", passives: "Passives" };

function posLocksAll() {
  try { return JSON.parse(localStorage.getItem(POSLOCKS_KEY) || "{}") || {}; } catch { return {}; }
}
// Locks are a list of { key, text, pos }. The text is what tells same-name
// variants apart; older saves were { itemKey: pos } and still load.
function posLocksFor(ownerId, listKey) {
  let key = "";
  try { key = currentChatKey(SillyTavern.getContext()); } catch {}
  const raw = posLocksAll()?.[key]?.[ownerId]?.[listKey];
  if (Array.isArray(raw)) return raw;
  return raw ? Object.entries(raw).map(([k, pos]) => ({ key: k, text: "", pos })) : [];
}

// which indices in items are locked, and to where
function lockedIndices(items, locks) {
  const taken = new Set(), out = [];
  [...locks].sort((a, b) => a.pos - b.pos).forEach((l) => {
    const i = bestEntryIndex(items, l.key, l.text, taken);
    if (i >= 0) { taken.add(i); out.push({ i, pos: l.pos }); }
  });
  return out;
}
function savePosLocks(ownerId, listKey, list) {
  const map = list;
  let key = "";
  try { key = currentChatKey(SillyTavern.getContext()); } catch { return; }
  const all = posLocksAll();
  const chat = (all[key] = all[key] || {});
  const owner = (chat[ownerId] = chat[ownerId] || {});
  if (map.length) owner[listKey] = map; else delete owner[listKey];
  if (!Object.keys(owner).length) delete chat[ownerId];
  if (!Object.keys(chat).length) delete all[key];
  try { localStorage.setItem(POSLOCKS_KEY, JSON.stringify(all)); } catch {}
}

// Put locked entries back at their positions; everything else keeps its order.
function applyPositionLocks(items, locks) {
  const locked = lockedIndices(items, locks);
  if (!locked.length) return items.slice();
  const lockedSet = new Set(locked.map((l) => l.i));
  const out = items.filter((_, i) => !lockedSet.has(i));
  locked.sort((a, b) => a.pos - b.pos).forEach((l) => out.splice(Math.min(l.pos, out.length), 0, items[l.i]));
  return out;
}

const ownerIdOf = (who) => (who ? `${who.group}:${who.key}` : "@player");

// Rewrite one character's list field inside a message's block, walking the
// lines so the right character's field is the one changed.
function editOwnerFieldInMes(mes, ownerId, field, fn) {
  const bm = String(mes).match(/<rpg_state\b[^>]*>[\s\S]*?<\/rpg_state>/i);
  if (!bm) return mes;
  const lines = bm[0].split("\n");
  let section = null, unit = null, changed = false;
  const re = new RegExp(`(\\|\\s*${field}\\s*:)([^|]*)(\\|)`, "i");
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    const h = ln.match(/^\s*\[([^\]]+)\]\s*$/);
    if (h) { const t = h[1].toLowerCase(); section = /player/.test(t) ? "player" : /party/.test(t) ? "party" : /npc/.test(t) ? "npcs" : /enem/.test(t) ? "enemies" : null; unit = null; continue; }
    const nm = ln.match(/\|\s*Name\s*:\s*([^|]*)\|/i);
    if (nm && section && section !== "player") unit = normBondName(nm[1]);
    if (ln.trim().startsWith(">")) continue;
    const id = section === "player" ? "@player" : section && unit ? `${section}:${unit}` : null;
    if (id !== ownerId || !re.test(ln)) continue;
    lines[li] = ln.replace(re, (m, a, val, z) => {
      const items = val.split(";").map((x) => x.trim()).filter(Boolean);
      const out = fn(items);
      if (out.join(";") === items.join(";")) return m;
      changed = true;
      return a + out.join(";") + z;
    });
  }
  return changed ? String(mes).replace(bm[0], lines.join("\n")) : mes;
}

// lists in a new reply whose locked entries have moved
function positionFixesFor(state) {
  const out = [];
  listOwners(state).forEach((owner) => {
    Object.keys(POS_FIELDS).forEach((listKey) => {
      const locks = posLocksFor(owner.id, listKey);
      if (!locks.length) return;
      const items = (owner.ent?.[listKey] || []).map((x) => String(x).trim()).filter(Boolean);
      const fixed = applyPositionLocks(items, locks);
      if (fixed.join(";") !== items.join(";")) out.push({ ownerId: owner.id, owner: owner.name, listKey, locks });
    });
  });
  return out;
}

// ---- the editor ----
let saoListEdit = null;   // null, or { key, rows: [{ text, orig }] }

function saoListEditorHtml(key) {
  const label = { inventory: "Items", skills: "Skills", passives: "Passives", quests: "Quests" }[key] || key;
  const isQuests = key === "quests";
  const n = saoListEdit.rows.length;
  // a row's icon: the one picked in this editor, else any saved one, else from the name
  const rowIcon = (r) => {
    if (r.icon === "") return { kind: listIconKind(key, r.text, { auto: true }), custom: false };
    if (r.icon) return { kind: r.icon, custom: true };
    const ov = iconOverrideFor(key, r.orig || r.text);
    return ov && LIST_ICONS[ov] ? { kind: ov, custom: true } : { kind: listIconKind(key, r.text, { auto: true }), custom: false };
  };
  const rows = saoListEdit.rows.map((r, i) => {
    const ic = isQuests ? { kind: "quest", custom: false } : rowIcon(r);
    return `
    <div class="rpg-sao-ledit">
      ${reorderBtns("list", i, n)}
      ${isQuests ? `<span class="rpg-sao-ico">${LIST_ICONS.quest}</span>`
        : `<button class="rpg-sao-ico rpg-sao-ledit-ico${ic.custom ? " custom" : ""}${saoListEdit.pick === i ? " picking" : ""}" data-i="${i}"
            title="${ic.custom ? "Your icon" : "Icon from the name"} \u00B7 tap to choose">${LIST_ICONS[ic.kind]}</button>`}
      <textarea class="rpg-sao-ledit-text" data-i="${i}" rows="2" spellcheck="false">${escHtml(r.text)}</textarea>
      <span class="rpg-sao-ledit-side">
        <button class="rpg-sao-ledit-del" data-i="${i}" title="Remove">&#10005;</button>
        ${isQuests ? "" : `<button class="rpg-sao-ledit-lock${r.locked ? " on" : ""}" data-i="${i}"
          title="${r.locked ? "Locked to this position: the AI can't move it. Tap to unlock." : "Lock to this position"}">${r.locked ? LOCK_ICON.on : LOCK_ICON.off}</button>`}
      </span>
    </div>${!isQuests && saoListEdit.pick === i ? iconPickerHtml(key, i, ic.kind, ic.custom) : ""}`;
  }).join("");
  const depth = Math.max(0, parseInt(uiSettings.listEditHistory, 10) || 0);
  return `<div class="rpg-sao-meditor rpg-sao-leditor">
      ${rows || `<p class="rpg-sao-empty">Empty. Add one below.</p>`}
      <button class="rpg-sao-mini" id="rpg-sao-ledit-add">+ Add</button>
      <p class="rpg-sao-hint">${isQuests ? "" : "Tap an icon to choose a different one; it sticks to that name in every chat. "}${isQuests
        ? "Quests are shared by everyone. Saving updates the latest reply."
        : depth
        ? `Saving also updates ${depth} earlier repl${depth === 1 ? "y" : "ies"} (setting: Edits rewrite past replies).`
        : "Saving updates the latest reply. To also update earlier ones, see the setting Edits rewrite past replies."}</p>
      <div class="rpg-sao-medit-actions">
        <button class="rpg-sao-mini" id="rpg-sao-ledit-cancel">Cancel</button>
        <button class="rpg-sao-mini primary" id="rpg-sao-ledit-save">Save ${escHtml(label)}</button>
      </div>
    </div>`;
}

function saoListItemWithIcon(listKey, it, editable, idx = -1, lockedSet = null) {
  const locked = !!lockedSet && lockedSet.has(idx);
  return saoListItem(it).replace(/^<li>/, `<li class="has-ico${locked ? " pos-locked" : ""}">${listIconHtml(listKey, it, editable)}<div class="rpg-sao-li-body">`)
    .replace(/<\/li>$/, `</div>${locked ? `<span class="rpg-sao-poslock" title="Locked to this position">${LOCK_ICON.on}</span>` : ""}</li>`);
}

// the active character as the block sees it: null for the player
function activeListOwner() {
  const info = getActivePointerInfo();
  if (info.type === "player") return null;
  const group = { party: "party", npc: "npcs", enemy: "enemies" }[info.type];
  return group ? { group, key: normBondName(info.name) } : undefined;
}

// Rewrite one list field for one character in up to `depth` replies before
// the latest: entries matched by name (not exact text, since descriptions
// drift), changed or removed. Additions aren't pushed into the past.
function rewriteListHistory(who, listKey, edits, depth) {
  const field = { inventory: "INV", skills: "Skills", passives: "Passives" }[listKey];
  if (!field || depth <= 0 || !edits.length) return 0;
  let ctx;
  try { ctx = SillyTavern.getContext(); } catch { return 0; }
  const chat = ctx?.chat || [];
  const ownerId = who ? `${who.group}:${who.key}` : "@player";
  let touched = 0, seen = 0;
  for (let i = lastRpgMsgIndex - 1; i >= 0 && seen < depth; i--) {
    const msg = chat[i];
    if (!msg || msg.is_user || !rpgInnerFromMessage(msg.mes)) continue;
    seen++;
    const blockMatch = msg.mes.match(/<rpg_state\b[^>]*>[\s\S]*?<\/rpg_state>/i);
    const lines = blockMatch[0].split("\n");
    let section = null, unit = null, changed = false;
    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li];
      const h = ln.match(/^\s*\[([^\]]+)\]\s*$/);
      if (h) { const t = h[1].toLowerCase(); section = /player/.test(t) ? "player" : /party/.test(t) ? "party" : /npc/.test(t) ? "npcs" : /enem/.test(t) ? "enemies" : null; unit = null; continue; }
      const nm = ln.match(/\|\s*Name\s*:\s*([^|]*)\|/i);
      if (nm && section && section !== "player") unit = normBondName(nm[1]);
      if (ln.trim().startsWith(">")) continue;
      const id = section === "player" ? "@player" : section && unit ? `${section}:${unit}` : null;
      if (id !== ownerId) continue;
      const re = new RegExp(`(\\|\\s*${field}\\s*:)([^|]*)(\\|)`, "i");
      if (!re.test(ln)) continue;
      lines[li] = ln.replace(re, (m, a, val, z) => {
        const items = val.split(";").map((x) => x.trim()).filter(Boolean);
        // each edit takes the single closest same-name entry, so a variant
        // with the same name is never edited or removed along with it
        const taken = new Set(), plan = new Map();
        edits.forEach((e) => {
          const i = bestEntryIndex(items, tItemKey(e.from), e.from, taken);
          if (i >= 0) { taken.add(i); plan.set(i, e); }
        });
        if (!plan.size) return m;
        changed = true;
        const out = [];
        items.forEach((x, i) => { const e = plan.get(i); if (!e) out.push(x); else if (e.to) out.push(e.to); });
        return a + out.join(";") + z;
      });
    }
    if (changed) {
      setMessageText(msg, msg.mes.replace(blockMatch[0], lines.join("\n")));
      touched++;
    }
  }
  if (touched) {
    try { window.saveChat?.(); } catch {}
    invalidateHistoryMemory();
    turnLogCache = { sig: "", turns: [] };
  }
  return touched;
}

function saoSaveListEdit() {
  const key = saoListEdit.key;
  const isQuests = key === "quests";
  const active = getActiveData();
  const display = isQuests ? rpgState : active.display;
  const isVehicle = isQuests ? true : active.isVehicle;   // quests: no locks, no history
  const before = (Array.isArray(display[key]) ? display[key] : []).map(String);
  // ";" and "|" would split the entry apart in the block
  let rows = saoListEdit.rows.map((r) => ({ orig: r.orig, locked: !!r.locked, icon: r.icon, text: String(r.text || "").replace(/;/g, ",").replace(/\|/g, "/").replace(/\s*\n\s*/g, " ").trim() }))
    .filter((r) => r.text);
  if (!isQuests) {
    rows.forEach((r) => {
      if (r.icon !== undefined) { setIconOverride(key, r.text, r.icon); return; }
      // renamed: a saved icon follows the entry to its new name
      if (r.orig && tItemKey(r.orig) !== tItemKey(r.text)) {
        const ov = iconOverrideFor(key, r.orig);
        if (ov && !iconOverrideFor(key, r.text)) setIconOverride(key, r.text, ov);
      }
    });
  }
  const kept = new Set(rows.map((r) => r.orig).filter(Boolean));
  let removed = before.filter((t) => !kept.has(t));
  if (removed.length) {
    const sure = confirm(`Remove ${removed.length === 1 ? "this entry" : "these entries"}?\n\n` +
      removed.map((t) => "\u2022 " + tItemName(t)).join("\n") + "\n\nCancel keeps them.");
    if (!sure) { rows = rows.concat(removed.map((t) => ({ orig: t, text: t }))); removed = []; }
  }
  display[key] = rows.map((r) => r.text);
  // position locks: each locked row's final place in the list
  const ownerForLocks = activeListOwner();
  if (ownerForLocks !== undefined && !isVehicle) {
    const list = [];
    rows.forEach((r, i) => { if (r.locked) list.push({ key: tItemKey(r.text), text: r.text, pos: i }); });
    savePosLocks(ownerIdOf(ownerForLocks), key, list);
  }
  const edits = rows.filter((r) => r.orig && r.orig !== r.text).map((r) => ({ from: r.orig, to: r.text }))
    .concat(removed.map((t) => ({ from: t, to: null })));
  saoListEdit = null;
  renderRPG();
  const ok = writeStateBackToChatMessage(rpgState);
  if (!ok) console.warn("RPG HUD: couldn't write back <rpg_state> after list edit");

  const depth = Math.max(0, Math.min(20, parseInt(uiSettings.listEditHistory, 10) || 0));
  const who = activeListOwner();
  if (depth && edits.length && !isVehicle && who !== undefined) {
    const n = rewriteListHistory(who, key, edits, depth);
    if (window.toastr) hudToast.info(n ? `Also updated ${n} earlier repl${n === 1 ? "y" : "ies"}.` : "No earlier replies needed changing.");
  }
  try { checkMessage(); } catch {}
}

function saoBindListEditor() {
  document.querySelectorAll(".rpg-quest-edit").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const items = (Array.isArray(rpgState.quests) ? rpgState.quests : []).map(String);
      saoListEdit = { key: "quests", rows: items.map((t) => ({ text: t, orig: t, locked: false })) };
      renderRPG();
    };
  });
  document.querySelectorAll(".rpg-sao-ico[data-list]").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const { display } = getActiveData();
      const key = el.dataset.list;
      const who = activeListOwner();
      const items = (Array.isArray(display[key]) ? display[key] : []).map(String);
      const lockedSet = new Set(who === undefined ? [] : lockedIndices(items, posLocksFor(ownerIdOf(who), key)).map((l) => l.i));
      saoListEdit = { key, rows: items.map((t, i) => ({ text: t, orig: t, locked: lockedSet.has(i) })) };
      renderRPG();
    };
  });
  const box = document.querySelector(".rpg-sao-leditor");
  if (!box || !saoListEdit) return;
  box.querySelectorAll(".rpg-sao-ledit-text").forEach((el) => {
    el.oninput = () => { const r = saoListEdit.rows[+el.dataset.i]; if (r) r.text = el.value; };
    el.onclick = (e) => e.stopPropagation();
    el.onkeydown = (e) => e.stopPropagation();
  });
  box.querySelectorAll(".rpg-sao-ledit-ico").forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); const i = +el.dataset.i; saoListEdit.pick = saoListEdit.pick === i ? null : i; renderRPG(); };
  });
  box.querySelectorAll(".rpg-sao-pickopt").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const r = saoListEdit.rows[+el.dataset.i];
      if (r) r.icon = el.dataset.kind;        // "" = back to automatic
      saoListEdit.pick = null;
      renderRPG();
    };
  });
  box.querySelectorAll(".rpg-sao-ledit-lock").forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); const r = saoListEdit.rows[+el.dataset.i]; if (r) { r.locked = !r.locked; renderRPG(); } };
  });
  box.querySelectorAll(".rpg-sao-ledit-del").forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); saoListEdit.rows.splice(+el.dataset.i, 1); saoListEdit.pick = null; renderRPG(); };
  });
  const one = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = (e) => { e.stopPropagation(); fn(); }; };
  one("rpg-sao-ledit-add", () => {
    saoListEdit.rows.push({ text: "", orig: "" });
    renderRPG();
    requestAnimationFrame(() => { const t = document.querySelectorAll(".rpg-sao-ledit-text"); t[t.length - 1]?.focus(); });
  });
  one("rpg-sao-ledit-cancel", () => { saoListEdit = null; renderRPG(); });
  one("rpg-sao-ledit-save", saoSaveListEdit);
}

// ---- masteries: "Name: 45/100" gets a bar, same rule as the classic skin ----
function saoParseProgress(str) {
  const text = String(str ?? "");
  const m = text.match(/^(.*?):\s*(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(.*)$/);
  if (!m) return { name: text.trim(), curr: "", max: "", tail: "" };
  return { name: m[1].trim(), curr: m[2], max: m[3], tail: m[4] || "" };
}

// ; and | would split the entry apart in the pipe format
const saoCleanPipe = (v) => String(v ?? "").replace(/[;|]/g, " ").trim();

function saoFormatProgress(e) {
  const name = saoCleanPipe(e.name);
  if (!name) return "";
  const tail = saoCleanPipe(e.tail);
  const suffix = tail ? " " + tail : "";
  const c = String(e.curr ?? "").trim(), mx = String(e.max ?? "").trim();
  if (c === "" && mx === "") return name + suffix;
  return `${name}: ${c || 0}/${mx || 100}${suffix}`;
}

function saoProgressBar(curr, max) {
  const c = parseFloat(curr), mx = parseFloat(max);
  if (!Number.isFinite(c) || !Number.isFinite(mx) || mx <= 0) return "";
  return `<div class="rpg-sao-pbar"><div style="width:${clamp((c / mx) * 100, 0, 100)}%"></div></div>`;
}

function saoListItem(it) {
  const p = saoParseProgress(it);
  const bar = p.curr !== "" ? saoProgressBar(p.curr, p.max) : "";
  if (!bar) return `<li>${escHtml(it)}</li>`;
  return `<li><div class="rpg-sao-li-top"><span>${escHtml(p.name)}${p.tail ? `<i> ${escHtml(p.tail.trim())}</i>` : ""}</span>
    <b>${escHtml(p.curr)}/${escHtml(p.max)}</b></div>${bar}</li>`;
}

function saoMasteriesSection(list) {
  if (saoMasteryEdit) {
    const rows = saoMasteryEdit.map((m, i) => `
      <div class="rpg-sao-mast-edit">
        ${reorderBtns("mastery", i, saoMasteryEdit.length)}
        <input type="text" class="rpg-sao-ms-name" data-i="${i}" value="${escAttr(m.name)}" placeholder="Name">
        <input type="text" class="rpg-sao-ms-curr" data-i="${i}" value="${escAttr(m.curr)}" inputmode="decimal" placeholder="\u2013">
        <span class="rpg-sao-m-slash">/</span>
        <input type="text" class="rpg-sao-ms-max" data-i="${i}" value="${escAttr(m.max)}" inputmode="decimal" placeholder="\u2013">
        <button class="rpg-sao-ms-del" data-i="${i}" title="Remove">&#10005;</button>
      </div>`).join("");
    return `<div class="rpg-sao-subhead"><span class="rpg-sao-sub">Masteries</span></div>
      <div class="rpg-sao-meditor rpg-sao-mseditor">
        ${rows || `<p class="rpg-sao-empty">No masteries. Add one below.</p>`}
        <p class="rpg-sao-hint">Leave the numbers blank for a mastery without a bar.</p>
        <button class="rpg-sao-mini" id="rpg-sao-ms-add">+ Add mastery</button>
        <div class="rpg-sao-medit-actions">
          <button class="rpg-sao-mini" id="rpg-sao-ms-cancel">Cancel</button>
          <button class="rpg-sao-mini primary" id="rpg-sao-ms-save">Save</button>
        </div>
      </div>`;
  }

  const body = list.length
    ? `<ul class="rpg-sao-entries">` + list.map(saoListItem).join("") + `</ul>`
    : `<p class="rpg-sao-empty">No masteries.</p>`;
  return `<div class="rpg-sao-subhead"><span class="rpg-sao-sub">Masteries</span>
      <button class="rpg-sao-mini" id="rpg-sao-ms-edit">&#9998; Edit</button></div>${body}`;
}

function saoSaveMasteryEdit() {
  const { display } = getActiveData();
  const before = Array.isArray(display.masteries) ? display.masteries : [];
  let draft = saoMasteryEdit.filter((m) => saoCleanPipe(m.name));

  const kept = new Set(draft.map((m) => (m.orig ?? "").toLowerCase()).filter(Boolean));
  const removed = before.filter((x) => !kept.has(String(x).toLowerCase()));
  if (removed.length) {
    const sure = confirm(`Remove ${removed.length === 1 ? "this mastery" : "these masteries"}?\n\n` +
      `${removed.map((x) => saoParseProgress(x).name).join(", ")}\n\nCancel keeps them.`);
    if (!sure) draft = draft.concat(removed.map((x) => ({ ...saoParseProgress(x), orig: x })));
  }

  display.masteries = draft.map(saoFormatProgress).filter(Boolean);
  saoMasteryEdit = null;
  const ok = writeStateBackToChatMessage(rpgState);
  if (!ok) console.warn("RPG HUD: couldn't write back <rpg_state> after mastery edit");
  renderRPG();
}

function saoBindMasteryEditor() {
  const edit = document.getElementById("rpg-sao-ms-edit");
  if (edit) edit.onclick = (e) => {
    e.stopPropagation();
    const { display } = getActiveData();
    saoMasteryEdit = (Array.isArray(display.masteries) ? display.masteries : [])
      .map((x) => ({ ...saoParseProgress(x), orig: String(x) }));
    renderRPG();
  };

  const body = document.querySelector(".rpg-sao-mseditor");
  if (!body || !saoMasteryEdit) return;

  const field = (cls, key) => body.querySelectorAll(cls).forEach((el) => {
    el.oninput = () => { const m = saoMasteryEdit[+el.dataset.i]; if (m) m[key] = el.value; };
    el.onclick = (e) => e.stopPropagation();
  });
  field(".rpg-sao-ms-name", "name");
  field(".rpg-sao-ms-curr", "curr");
  field(".rpg-sao-ms-max", "max");

  body.querySelectorAll(".rpg-sao-ms-del").forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); saoMasteryEdit.splice(+el.dataset.i, 1); renderRPG(); };
  });

  const one = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = (e) => { e.stopPropagation(); fn(); }; };
  one("rpg-sao-ms-add", () => {
    saoMasteryEdit.push({ name: "", curr: "0", max: "100", tail: "", orig: "" });
    renderRPG();
    requestAnimationFrame(() => {
      const names = document.querySelectorAll(".rpg-sao-ms-name");
      names[names.length - 1]?.focus();
    });
  });
  one("rpg-sao-ms-cancel", () => { saoMasteryEdit = null; renderRPG(); });
  one("rpg-sao-ms-save", saoSaveMasteryEdit);
}

function saoStartMeterEdit() {
  const { display } = getActiveData();
  const meters = Array.isArray(display.meters) ? display.meters : [];
  saoMeterEdit = meters.map((m) => ({
    name: m.name ?? "",
    curr: m.curr ?? 0,
    max: m.max ?? 100,
    color: meterColorByName(m.name),
    custom: !!uiSettings.meterColors?.[meterKey(m.name)],
    orig: m.name ?? "",
  }));
}

function saoSaveMeterEdit() {
  const { display } = getActiveData();
  const before = Array.isArray(display.meters) ? display.meters : [];
  let draft = saoMeterEdit.filter((m) => String(m.name).trim());

  // Deleting asks first, and Cancel keeps them — same as bonds and timers.
  const kept = new Set(draft.map((m) => meterKey(m.orig || m.name)));
  const removed = before.filter((m) => !kept.has(meterKey(m.name)));
  if (removed.length) {
    const sure = confirm(`Remove ${removed.length === 1 ? "this meter" : "these meters"}?\n\n` +
      `${removed.map((m) => m.name).join(", ")}\n\nCancel keeps them.`);
    if (!sure) {
      draft = draft.concat(removed.map((m) => ({
        name: m.name, curr: m.curr, max: m.max, color: meterColorByName(m.name), custom: false,
      })));
    }
  }

  display.meters = draft.map((m) => ({
    name: String(m.name).trim(),
    curr: String(m.curr).trim() || "0",
    max: String(m.max).trim() || "100",
  }));

  // colours are keyed by name, so they carry across every character with
  // that meter and survive the model rewriting the block
  const colors = { ...(uiSettings.meterColors || {}) };
  draft.forEach((m) => {
    const k = meterKey(m.name);
    if (m.custom) colors[k] = m.color;
    else delete colors[k];
    if (m.orig && meterKey(m.orig) !== k) delete colors[meterKey(m.orig)];   // renamed
  });
  uiSettings.meterColors = colors;
  saveUiSettings();

  saoMeterEdit = null;
  const ok = writeStateBackToChatMessage(rpgState);
  if (!ok) console.warn("RPG HUD: couldn't write back <rpg_state> after meter edit");
  renderRPG();
}

function saoBindMeterEditor() {
  const body = document.querySelector(".rpg-sao-meditor");
  const edit = document.getElementById("rpg-sao-m-edit");
  if (edit) edit.onclick = (e) => { e.stopPropagation(); saoStartMeterEdit(); renderRPG(); };
  if (!body || !saoMeterEdit) return;

  // typing updates the draft in place; re-rendering would steal focus
  const field = (cls, key) => body.querySelectorAll(cls).forEach((el) => {
    el.oninput = () => { const m = saoMeterEdit[+el.dataset.i]; if (m) m[key] = el.value; };
    el.onclick = (e) => e.stopPropagation();
  });
  field(".rpg-sao-m-name", "name");
  field(".rpg-sao-m-curr", "curr");
  field(".rpg-sao-m-max", "max");

  body.querySelectorAll(".rpg-sao-m-color").forEach((el) => {
    el.oninput = () => {
      const m = saoMeterEdit[+el.dataset.i];
      if (!m) return;
      m.color = el.value; m.custom = true;
      el.closest(".rpg-sao-mrow-edit")?.querySelector(".rpg-sao-m-auto")?.classList.remove("off");
    };
    el.onclick = (e) => e.stopPropagation();
  });

  const btn = (sel, fn) => body.querySelectorAll(sel).forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); fn(+el.dataset.i); };
  });
  btn(".rpg-sao-m-del", (i) => { saoMeterEdit.splice(i, 1); renderRPG(); });
  btn(".rpg-sao-m-auto", (i) => {
    const m = saoMeterEdit[i]; if (!m) return;
    m.custom = false; m.color = meterAutoColor(m.name); renderRPG();
  });

  const one = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = (e) => { e.stopPropagation(); fn(); }; };
  one("rpg-sao-m-add", () => {
    saoMeterEdit.push({ name: "", curr: "0", max: "100", color: "#26a69a", custom: false, orig: "" });
    renderRPG();
    requestAnimationFrame(() => {
      const names = document.querySelectorAll(".rpg-sao-m-name");
      names[names.length - 1]?.focus();
    });
  });
  one("rpg-sao-m-cancel", () => { saoMeterEdit = null; renderRPG(); });
  one("rpg-sao-m-save", saoSaveMeterEdit);
}

function saoWhoStrip() {
  const groups = saoRosterGroups();
  if (!groups.length) return "";
  const cur = saoRosterOf(charIndex);
  const active = groups.filter((g) => g.key === cur)[0] || groups[0];

  const cats = `<div class="rpg-sao-cats">` + groups.map((g) =>
    `<button class="rpg-sao-cat${g.key === active.key ? " on" : ""}${g.key === "enemy" ? " foe" : ""}"
      data-cat="${g.key}">${g.label}${g.list.length > 1 ? ` <i>${g.list.length}</i>` : ""}</button>`
  ).join("") + `</div>`;

  if (active.list.length < 2) return cats;

  const chips = `<div class="rpg-sao-who" data-scroll-key="who:${active.key}">` + active.list.map((u, i) => {
    const idx = charIndexFor(active.type, i);
    return `<button class="rpg-sao-chip${idx === charIndex ? " on" : ""}${active.key === "enemy" ? " foe" : ""}"
      data-idx="${idx}">${escHtml(saoUnitView(u).name)}</button>`;
  }).join("") + `</div>`;

  return cats + chips;
}

function saoBondsPanel() {
  if (bondsEditMode) return { title: "Bonds", body: `<div class="rpg-sao-classic">${renderBondsTab()}</div>` };

  const list = Array.isArray(rpgState.bonds) ? rpgState.bonds : [];
  const party = Array.isArray(rpgState.party) ? rpgState.party : [];
  const npcs = Array.isArray(rpgState.npcs) ? rpgState.npcs : [];
  const jumpIdxFor = (name) => {
    const key = normBondName(name);
    let i = party.findIndex((u) => normBondName(u?.name) === key);
    if (i !== -1) return charIndexFor("party", i);
    i = npcs.findIndex((u) => normBondName(u?.name) === key);
    if (i !== -1) return charIndexFor("npc", i);
    return null;
  };

  const head = `<div class="rpg-sao-panelhead"><button class="rpg-sao-mini" id="rpg-sao-bond-edit">&#9998; Edit</button></div>`;
  if (!list.length) return { title: "Bonds", body: head + `<p class="rpg-sao-empty">No bonds recorded.</p>` };

  const rows = [...list].sort((a, b) => parseBondValue(b.bond) - parseBondValue(a.bond)).map((b) => {
    const val = parseBondValue(b.bond);
    const label = val >= 101 ? "&#8734;" : String(val);
    let p = val >= 101 ? 100 : clamp(Math.abs(val), 0, 100);

    const hasBase = Object.prototype.hasOwnProperty.call(b, "prev");
    const prevVal = !hasBase || b.prev === null ? null : parseBondValue(b.prev);
    let delta = "", ghost = "";
    if (!hasBase) {
      delta = "";
    } else if (prevVal === null) {
      delta = `<span class="rpg-sao-new">NEW</span>`;
    } else if (prevVal !== val) {
      const d = val - prevVal;
      const pp = prevVal >= 101 ? 100 : clamp(Math.abs(prevVal), 0, 100);
      delta = `<span class="rpg-sao-delta ${d > 0 ? "up" : "down"}">${d > 0 ? "&#9650;" : "&#9660;"}${Math.abs(d)}</span>`;
      ghost = `<div class="rpg-sao-ghost" style="left:${Math.min(p, pp)}%; width:${Math.abs(p - pp)}%; background:${d > 0 ? "#3f8f34" : "#c0392b"}"></div>`;
      p = Math.min(p, pp);
    }

    const idx = jumpIdxFor(b.name);
    const nameHtml = idx === null
      ? `<span class="rpg-sao-who-name">${escHtml(displayName(b.name))}</span>`
      : `<button class="rpg-sao-who-name rpg-sao-jump" data-idx="${idx}">${escHtml(displayName(b.name))}</button>`;

    return `<div class="rpg-sao-bond">
      <div class="rpg-sao-bondtop">
        <span class="${idx === null ? "away" : "here"}">${idx === null ? "&#9675;" : "&#9679;"}</span>
        ${nameHtml}<span class="rpg-sao-bondval">${label}</span>${delta}
      </div>
      <div class="rpg-sao-bondtrack"><div class="b" style="width:${p}%"></div>${ghost}</div>
    </div>`;
  }).join("");

  return { title: "Bonds", body: head + rows };
}

function saoQuestsPanel() {
  const tabs = `<div class="rpg-sao-subtabs">
    <button class="rpg-sao-qtab${saoQuestTab === "quests" ? " on" : ""}" data-qtab="quests">Quests</button>
    <button class="rpg-sao-qtab${saoQuestTab === "log" ? " on" : ""}" data-qtab="log">Log</button></div>`;

  if (saoQuestTab === "log") return { title: "Turn log", body: tabs + saoLogHtml() };

  const quests = Array.isArray(rpgState.quests) ? rpgState.quests : [];
  if (saoListEdit && saoListEdit.key === "quests") return { title: "Quests", body: tabs + saoListEditorHtml("quests") };
  return {
    title: "Quests",
    body: tabs + `<div class="rpg-sao-subhead"><span class="rpg-sao-sub">Active</span>
        <button class="rpg-sao-mini rpg-quest-edit">&#9998; Edit</button></div>` + (quests.length
      ? quests.map((q) => `<div class="rpg-sao-quest">${escHtml(q)}</div>`).join("")
      : `<p class="rpg-sao-empty">No active quests.</p>`),
  };
}

// identifies what's in the panel, so switching tab or character starts at the
// top while a re-render of the same view keeps your place
function saoPanelScrollKey() {
  if (saoPanel === "status") return `status:${charIndex}:${saoSub}`;
  if (saoPanel === "quests") return `quests:${saoQuestTab}`;
  if (saoPanel === "gear" && saoHelpOpen) return saoHelpOpen === "log" ? "whatsnew" : saoHelpOpen === "layout" ? "layout" : "help";
  return `panel:${saoPanel}`;
}

function saoSaveScroll(root) {
  root.querySelectorAll("[data-scroll-key]").forEach((el) => {
    saoScroll.set(el.dataset.scrollKey, { top: el.scrollTop, left: el.scrollLeft });
  });
}

function saoRestoreScroll(root) {
  root.querySelectorAll("[data-scroll-key]").forEach((el) => {
    const p = saoScroll.get(el.dataset.scrollKey);
    if (!p) return;
    if (p.top) el.scrollTop = p.top;
    if (p.left) el.scrollLeft = p.left;
  });
}

// Jump-to-top / jump-to-bottom, shown only when there's somewhere to jump to.
function saoBindJumps() {
  document.querySelectorAll(".rpg-sao-panel").forEach((panel) => {
    const body = panel.querySelector(".rpg-sao-body");
    const up = panel.querySelector(".rpg-sao-jumpto.up");
    const down = panel.querySelector(".rpg-sao-jumpto.down");
    if (!body || !up || !down) return;

    const update = () => {
      const room = body.scrollHeight - body.clientHeight;
      up.classList.toggle("show", room > 24 && body.scrollTop > 40);
      down.classList.toggle("show", room > 24 && body.scrollTop < room - 40);
    };
    if (body.dataset.jumpBound !== "1") {        // bound once per element
      body.dataset.jumpBound = "1";
      body.addEventListener("scroll", update, { passive: true });
    }
    update();

    const go = (top) => (e) => {
      e.stopPropagation();
      body.scrollTo({ top, behavior: uiSettings.saoAnimate === false ? "auto" : "smooth" });
    };
    up.onclick = go(0);
    down.onclick = go(body.scrollHeight);
  });
}

// ---- undo / redo the latest turn ----
// Writes the previous turn's block back into the latest message, so every
// change that turn made is reverted at once. Only the <rpg_state> is touched,
// never the story text. One level, with redo until the message changes again.
let turnUndo = null;   // { key, idx, before, after }

function setMessageText(msg, text) {
  msg.mes = text;
  // the active swipe keeps its own copy; without this, swiping away and back
  // would bring the undone state straight back
  if (Array.isArray(msg.swipes) && Number.isInteger(msg.swipe_id) && msg.swipe_id in msg.swipes) {
    msg.swipes[msg.swipe_id] = text;
  }
}

function afterTurnEdit(ctx, idx) {
  const msg = ctx.chat[idx];
  try { ctx.updateMessageBlock?.(idx, msg); } catch {}
  try { window.saveChat?.(); } catch (e) { console.warn("RPG HUD: saveChat failed", e); }
  // our own edit, so the description alert shouldn't read it as the model's
  alertSig = `${idx}|${rpgInnerFromMessage(msg.mes)}`;
  alertIdx = idx;
  invalidateHistoryMemory();
  turnLogCache = { sig: "", turns: [] };
  // A plain scan, not a manual one: a manual scan writes the whole live state
  // back into the message, which would overwrite the block this edit just set
  // (and break redo, which checks the message is still exactly what we wrote).
  try { checkMessage(); } catch {}
  renderRPG();
}

// ---- locked changes ----
// A lock keeps one change of the newest turn through "Undo last turn": the
// rest of the turn is undone around it. Locks belong to one turn (chat + the
// message it lives in), so a new reply starts with none, and they're saved
// per chat so a refresh keeps them. A change is identified by what it
// touched (its undo note), not its wording.
const LOCKS_KEY = "rpgHud:turnLocks";
const lockId = (u) => JSON.stringify(u, Object.keys(u).sort().concat(["group", "key"]));

function lockScope(ctx, idx) { return `${currentChatKey(ctx)}|${idx}`; }

function loadLocks(scope) {
  try {
    const all = JSON.parse(localStorage.getItem(LOCKS_KEY) || "{}");
    return new Set(Array.isArray(all[scope]) ? all[scope] : []);
  } catch { return new Set(); }
}

function saveLocks(scope, set) {
  try {
    const all = JSON.parse(localStorage.getItem(LOCKS_KEY) || "{}");
    if (set.size) all[scope] = [...set]; else delete all[scope];
    const keys = Object.keys(all);                     // keep the store small
    keys.slice(0, Math.max(0, keys.length - 30)).forEach((k) => delete all[k]);
    localStorage.setItem(LOCKS_KEY, JSON.stringify(all));
  } catch {}
}

function newestTurnLocks(ctx) {
  const turns = rpgTurnsOf(ctx?.chat);
  if (turns.length < 2) return { scope: null, set: new Set() };
  const scope = lockScope(ctx, turns[turns.length - 1].idx);
  return { scope, set: loadLocks(scope) };
}

function toggleLock(id) {
  let ctx;
  try { ctx = SillyTavern.getContext(); } catch { return; }
  const { scope, set } = newestTurnLocks(ctx);
  if (!scope) return;
  if (set.has(id)) set.delete(id); else set.add(id);
  saveLocks(scope, set);
  renderRPG();
}

// the newest turn's changes that are locked
function lockedChanges(ctx) {
  const turns = rpgTurnsOf(ctx?.chat);
  if (turns.length < 2) return [];
  const { set } = newestTurnLocks(ctx);
  if (!set.size) return [];
  const last = turns[turns.length - 1], prev = turns[turns.length - 2];
  return diffTurn(prev.state, last.state).filter((c) => c.u && set.has(lockId(c.u)));
}

function saoUndoLastTurn() {
  let ctx;
  try { ctx = SillyTavern.getContext(); } catch { return; }
  const turns = rpgTurnsOf(ctx?.chat);
  if (turns.length < 2) return;
  const last = turns[turns.length - 1], prev = turns[turns.length - 2];
  const msg = ctx.chat[last.idx];

  const keep = lockedChanges(ctx);
  const ok = confirm(
    "Undo the latest turn?\n\n" +
    (keep.length
      ? `Every change that turn made is reverted except the ${keep.length} you locked:\n` +
        keep.slice(0, 8).map((c) => "  \u2022 " + c.text).join("\n") + (keep.length > 8 ? "\n  \u2022 \u2026" : "") + "\n\n"
      : "Its rpg_state goes back to exactly how it was the turn before, reverting every change that turn made. ") +
    "The story text isn't touched.\n\n" +
    "You can redo it until the chat changes."
  );
  if (!ok) return;

  const before = msg.mes;
  let after;
  if (keep.length) {
    // start from the turn before, then carry each locked change forward
    const next = tClone(prev.state);
    keep.forEach((c) => applyTurnUndo(next, last.state, c.u));
    after = before.replace(/<rpg_state\b[^>]*>[\s\S]*?<\/rpg_state>/i, buildPipeString(next));
  } else {
    after = before.replace(/(<rpg_state\b[^>]*>)[\s\S]*?(<\/rpg_state>)/i,
      (m, open, close) => `${open}\n${prev.inner}\n${close}`);
  }
  if (after === before) return;

  setMessageText(msg, after);
  turnUndo = { key: currentChatKey(ctx), idx: last.idx, before, after };
  afterTurnEdit(ctx, last.idx);
  if (window.toastr) hudToast.info(keep.length ? `Latest turn undone, keeping ${keep.length} locked change${keep.length === 1 ? "" : "s"}.` : "Latest turn undone.");
}

// Revert one change from the newest turn: reparse that turn's block, put the
// one thing back the way the turn before had it, and write the block out.
// The write goes through the same builder as every other edit, and
// parse -> build -> parse is lossless, so nothing else in the block moves.
function saoUndoChange(ci, expectText) {
  let ctx;
  try { ctx = SillyTavern.getContext(); } catch { return; }
  const turns = rpgTurnsOf(ctx?.chat);
  if (turns.length < 2) return;
  const last = turns[turns.length - 1], prev = turns[turns.length - 2];

  // the chat may have moved on since the log was drawn
  const change = diffTurn(prev.state, last.state)[ci];
  if (!change || !change.u || change.text !== expectText) {
    if (window.toastr) hudToast.info("That change has already moved on. The log has been refreshed.");
    renderRPG();
    return;
  }

  const next = tClone(last.state);
  applyTurnUndo(next, prev.state, change.u);

  const msg = ctx.chat[last.idx];
  const before = msg.mes;
  const after = before.replace(/<rpg_state\b[^>]*>[\s\S]*?<\/rpg_state>/i, buildPipeString(next));
  if (after === before) return;

  setMessageText(msg, after);
  turnUndo = { key: currentChatKey(ctx), idx: last.idx, before, after };
  afterTurnEdit(ctx, last.idx);
  if (window.toastr) hudToast.info(`Reverted: ${change.text}`);
}

function saoCanRedo(ctx) {
  if (!turnUndo || !ctx?.chat) return false;
  return currentChatKey(ctx) === turnUndo.key && ctx.chat[turnUndo.idx]?.mes === turnUndo.after;
}

function saoRedoLastTurn() {
  let ctx;
  try { ctx = SillyTavern.getContext(); } catch { return; }
  if (!saoCanRedo(ctx)) { turnUndo = null; renderRPG(); return; }
  setMessageText(ctx.chat[turnUndo.idx], turnUndo.before);
  const idx = turnUndo.idx;
  turnUndo = null;
  afterTurnEdit(ctx, idx);
  if (window.toastr) hudToast.info("Turn restored.");
}

// Classic's Log tab: the same turn log, undo and per-change undo as the SAO
// Quests orb, drawn with classic's inline styles for its dark panel. Its tab
// body drops scrollbar-gutter:stable: with it, Chromium left the good/bad
// bullets unpainted, and a log that almost always scrolls gains nothing from it.

// =====================================================================
// CLASSIC: list icons + editors
// Same editors as the SAO Status orb (so saving, history rewriting, position
// locks and reordering all behave the same), drawn in classic's dark style.
// The SAO editors' markup is reused inside .rpg-c-ed, which gives it a dark
// look; everything outside .rpg-c-ed is untouched.
// =====================================================================
const CLASSIC_ED_CSS = `<style>
.rpg-c-ed{--rpg-sao-ink:#e6e6e6; --rpg-sao-ink-dim:#9a9a9a; --rpg-sao-chip:#262626; --rpg-sao-rule:#555;
  font-size:1.05em; color:#e6e6e6}
.rpg-c-ed .rpg-sao-ico{flex:0 0 auto; display:grid; place-items:center; width:24px; height:24px; padding:0;
  border-radius:3px; border:1px solid #5a5a5a; background:#262626; color:#ddd}
.rpg-c-ed button.rpg-sao-ico{cursor:pointer; -webkit-tap-highlight-color:transparent}
.rpg-c-ed button.rpg-sao-ico:hover{border-color:#C0A040; color:#ffd54f}
.rpg-c-ed .rpg-sao-ico svg{width:15px; height:15px; display:block; fill:none; stroke:currentColor; stroke-width:1.7;
  stroke-linecap:round; stroke-linejoin:round}
.rpg-c-li{display:flex; gap:7px; align-items:center; padding:4px 0; border-bottom:1px solid #333}
.rpg-c-li-body{flex:1; min-width:0; overflow-wrap:anywhere}
.rpg-c-poslock{flex:0 0 auto; color:#ffc107; display:grid}
.rpg-c-ed .rpg-sao-mini{padding:2px 8px; font:inherit; font-size:.9em; font-weight:bold; cursor:pointer;
  background:#333; color:#ddd; border:1px solid #666; border-radius:2px}
.rpg-c-ed .rpg-sao-mini.primary{background:#2e7d32; border-color:#4caf50; color:#fff}
.rpg-c-ed .rpg-sao-medit-actions{display:flex; gap:6px; justify-content:flex-end; margin-top:6px}
.rpg-c-ed .rpg-sao-hint{font-size:.85em; color:#999; margin:4px 0}
.rpg-c-ed .rpg-sao-empty{opacity:.6; font-style:italic; margin:2px 0}
.rpg-c-ed .rpg-sao-ledit{display:flex; gap:6px; align-items:flex-start; margin-bottom:6px}
.rpg-c-ed .rpg-sao-ledit > .rpg-sao-ico{align-self:center}
.rpg-c-ed .rpg-sao-icopick{display:flex; flex-wrap:wrap; gap:4px; margin:-2px 0 8px; padding:6px; border:1px dashed #555; border-radius:3px}
.rpg-c-ed .rpg-sao-icopick .on, .rpg-c-ed .rpg-sao-ledit-ico.picking{border-color:#C0A040; color:#ffd54f; box-shadow:inset 0 0 0 1px #C0A040}
.rpg-c-ed .rpg-sao-icopick .auto{width:auto; padding:0 7px; font:inherit; font-size:.85em}
.rpg-c-ed .rpg-sao-ledit-ico.custom{position:relative}
.rpg-c-ed .rpg-sao-ledit-ico.custom::after{content:""; position:absolute; top:-3px; right:-3px; width:7px; height:7px; border-radius:50%;
  background:#4FC3F7; box-shadow:0 0 0 1.5px #111}
.rpg-sao-ledit > .rpg-sao-ico{align-self:center}
.rpg-c-ed .rpg-sao-ledit-text{flex:1; min-width:0; box-sizing:border-box; resize:vertical; font:inherit; line-height:1.35;
  padding:3px 5px; color:#eee; background:#1b1b1b; border:1px solid #555; border-radius:2px}
.rpg-c-ed .rpg-sao-ledit-side{flex:0 0 auto; display:flex; flex-direction:column; gap:4px}
.rpg-c-ed .rpg-sao-ledit-del, .rpg-c-ed .rpg-sao-ms-del, .rpg-c-ed .rpg-sao-ledit-lock{width:22px; height:22px; padding:0;
  cursor:pointer; display:grid; place-items:center; font-size:12px; border-radius:2px;
  background:#262626; border:1px solid #555; color:#bbb}
.rpg-c-ed .rpg-sao-ledit-del:hover, .rpg-c-ed .rpg-sao-ms-del:hover{color:#ef5350; border-color:#ef5350}
.rpg-c-ed .rpg-sao-ledit-lock.on{color:#ffc107; border-color:#ffc107; background:rgba(255,193,7,.15)}
.rpg-c-ed .rpg-sao-reorder{flex:0 0 auto; display:flex; flex-direction:column; gap:2px}
.rpg-c-ed .rpg-sao-mv{width:18px; height:13px; padding:0; cursor:pointer; font-size:8px; line-height:1; border-radius:2px;
  color:#ddd; background:#262626; border:1px solid #555}
.rpg-c-ed .rpg-sao-mv:disabled{opacity:.3; cursor:default}
@media (pointer:coarse){ .rpg-c-ed .rpg-sao-mv{width:22px; height:18px; font-size:9px} }
.rpg-c-ed .rpg-sao-subhead{display:none}
.rpg-c-ed .rpg-sao-mast-edit{display:grid; align-items:center; gap:4px; margin-bottom:5px;
  grid-template-columns:auto minmax(0,1fr) 44px 8px 44px 22px}
.rpg-c-ed .rpg-sao-mast-edit input[type=text]{min-width:0; width:100%; box-sizing:border-box; font:inherit;
  padding:2px 4px; color:#eee; background:#1b1b1b; border:1px solid #555; border-radius:2px}
.rpg-c-ed .rpg-sao-m-slash{text-align:center; color:#888}
.rpg-c-ed .rpg-sao-mrow-edit{display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin-bottom:6px; padding-bottom:6px;
  border-bottom:1px solid #333}
.rpg-c-ed .rpg-sao-mrow-edit input[type=text]{min-width:0; box-sizing:border-box; font:inherit; padding:2px 4px; color:#eee;
  background:#1b1b1b; border:1px solid #555; border-radius:2px}
.rpg-c-ed .rpg-sao-m-name{flex:1 1 90px}
.rpg-c-ed .rpg-sao-m-curr, .rpg-c-ed .rpg-sao-m-max{flex:0 0 46px; width:46px; text-align:center}
.rpg-c-ed .rpg-sao-m-color{flex:0 0 26px; width:26px; height:22px; padding:0; border:1px solid #555; background:none; cursor:pointer}
.rpg-c-ed .rpg-sao-m-auto, .rpg-c-ed .rpg-sao-m-del{width:22px; height:22px; padding:0; cursor:pointer; display:grid; place-items:center;
  font-size:12px; border-radius:2px; background:#262626; border:1px solid #555; color:#bbb}
.rpg-c-ed .rpg-sao-m-auto.off{opacity:.35}
.rpg-c-ed .rpg-sao-m-del:hover{color:#ef5350; border-color:#ef5350}
.rpg-c-medit{margin:6px 0; padding:6px; border:1px dashed #555; font-size:.85em}
</style>`;

const LIST_TAB_KEYS = { inventory: "inventory", skills: "skills", passives: "passives" };

function classicIconList(listKey, items, emptyText) {
  if (saoListEdit && saoListEdit.key === listKey) return `<div class="rpg-c-ed">${saoListEditorHtml(listKey)}</div>`;
  if (!items.length) {
    return `<div class="rpg-c-ed"><div style="opacity:0.5; font-style:italic;">${escHtml(emptyText)}
      <button class="rpg-sao-mini rpg-sao-ico" data-list="${listKey}" style="display:inline-grid; width:auto; height:auto; padding:1px 7px; border-radius:2px; margin-left:4px;">+ Add</button></div></div>`;
  }
  const who = activeListOwner();
  const lockedSet = new Set(who === undefined ? [] : lockedIndices(items.map(String), posLocksFor(ownerIdOf(who), listKey)).map((l) => l.i));
  return `<div class="rpg-c-ed">` + items.map((it, i) => {
    const text = String(it);
    const p = text.match(/:\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    const bar = p ? `<div style="width:100%; background:#444; height:4px; margin-top:3px; border-radius:2px; overflow:hidden;"><div style="height:100%; background:#7e57c2; width:${clamp(parseFloat(p[2]) > 0 ? (parseFloat(p[1]) / parseFloat(p[2])) * 100 : 0, 0, 100)}%"></div></div>` : "";
    return `<div class="rpg-c-li">${listIconHtml(listKey, text, true)}<div class="rpg-c-li-body">${escHtml(text)}${bar}</div>${
      lockedSet.has(i) ? `<span class="rpg-c-poslock" title="Locked to this position">${LOCK_ICON.on}</span>` : ""}</div>`;
  }).join("") + `</div>`;
}

function classicMasteryHtml(items) {
  const editBtn = (id, label, color) => `<button id="${id}" style="background:#333; border:1px solid ${color}; color:${color};
      cursor:pointer; font-size:0.9em; padding:1px 7px; font-weight:bold;">${label}</button>`;
  if (Array.isArray(saoMasteryEdit)) {
    return `<div class="rpg-c-ed">${saoMasteriesSection(items)}</div>`;
  }
  return `<div style="display:flex; justify-content:flex-end; margin-bottom:3px;">${editBtn("rpg-sao-ms-edit", "✎", "#4FC3F7")}</div>` +
    makeList(items, "No Mastery Tracking");
}

function classicQuestHtml() {
  if (saoListEdit && saoListEdit.key === "quests") return `<div class="rpg-c-ed">${saoListEditorHtml("quests")}</div>`;
  return `<div style="display:flex; justify-content:flex-end; margin-bottom:3px;">
      <button class="rpg-quest-edit" style="background:#333; border:1px solid #4FC3F7; color:#4FC3F7; cursor:pointer; font-size:0.9em; padding:1px 7px; font-weight:bold;">\u270E</button></div>` +
    makeList(rpgState.quests, "No Active Quests");
}

// the classic tab body grows while an editor is open, so rows aren't cramped
function classicEditorOpen() {
  return !!(saoListEdit && (LIST_TAB_KEYS[activeTab] === saoListEdit.key || (activeTab === "quests" && saoListEdit.key === "quests")))
    || (activeTab === "mastery" && Array.isArray(saoMasteryEdit));
}

function classicBindEditors() {
  saoBindListEditor();
  saoBindMasteryEditor();
  document.querySelectorAll(".rpg-c-ed .rpg-sao-mv").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const rows = reorderRows(el.dataset.kind);
      const i = +el.dataset.i, j = i + (+el.dataset.d);
      if (!rows || j < 0 || j >= rows.length) return;
      [rows[i], rows[j]] = [rows[j], rows[i]]; if (saoListEdit) saoListEdit.pick = null;
      renderRPG();
    };
  });
}


// =====================================================================
// SYSTEM SKIN
// The classic panel, restyled as a glowing status window. It shares every
// tab, editor and overlay with classic; only the top of the panel (title,
// big slot, info lines, bars and stats) is its own. It also has the optional
// "You have acquired..." notifications, raised from the same once-per-reply
// pass that drives Change Alerts.
// =====================================================================

const SYS_CSS = `
.rpg-sys{--sc:#8fd0ff; --sg:rgba(90,180,255,.55); --st:rgba(50,120,210,.22);
  --sys-bg:repeating-linear-gradient(115deg, rgba(var(--t-140_200_255, 140,200,255),.045) 0 1px, transparent 1px 13px),
    radial-gradient(120% 60% at 20% 0%, var(--st), transparent 60%),
    radial-gradient(100% 50% at 90% 100%, rgba(var(--t-40_90_180, 40,90,180),.16), transparent 60%), rgba(var(--t-4_9_18, 4,9,18),.94);
  --sys-shadow:0 0 0 1px rgba(0,0,0,.55), 0 0 16px var(--sg), inset 0 0 0 3px rgba(var(--t-4_9_18, 4,9,18),.85),
    inset 0 0 0 4px rgba(var(--t-143_208_255, 143,208,255),.28), inset 0 0 26px rgba(var(--t-60_140_230, 60,140,230),.14)}
.rpg-sys-enemy{--sc:#ff8080; --sg:rgba(255,80,80,.5); --st:rgba(200,50,60,.24)}
.rpg-sys-veh{--sc:#d6a2ff; --sg:rgba(190,120,255,.5); --st:rgba(140,70,210,.22)}
.rpg-sys::before,.rpg-sys::after{content:""; position:absolute; width:14px; height:14px; pointer-events:none;
  border:0 solid var(--sc); filter:drop-shadow(0 0 3px var(--sg)); z-index:1}
.rpg-sys::before{top:5px; left:5px; border-top-width:2px; border-left-width:2px}
.rpg-sys::after{bottom:5px; right:5px; border-bottom-width:2px; border-right-width:2px}
.rpg-sys .sys-svg{fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round;
  width:1.1em; height:1.1em; vertical-align:-0.18em; flex:0 0 auto}
.rpg-sys .rpg-c-btns .sys-svg{width:16px; height:16px; color:var(--t-dff1ff, #dff1ff); filter:drop-shadow(0 0 3px var(--sg))}
.rpg-sys .sys-tabhead{display:flex; justify-content:space-between; align-items:center; gap:4px; margin-bottom:5px;
  padding-bottom:3px; border-bottom:1px solid rgba(var(--t-143_208_255, 143,208,255),.25)}
.rpg-sys .sys-tabhead > span:first-child{display:flex; align-items:center; gap:6px; font-size:1.02em; letter-spacing:.18em;
  color:var(--sc); text-shadow:0 0 6px var(--sg)}
.rpg-sys .sys-tabhead button{display:inline-flex; align-items:center; justify-content:center; min-width:24px;
  background:rgba(var(--t-10_26_48, 10,26,48),.9) !important; border:1px solid rgba(var(--t-143_208_255, 143,208,255),.55) !important; color:var(--t-dff1ff, #dff1ff) !important}
.rpg-sys .sys-unit-head .sys-dot{flex:0 0 auto; width:6px; height:6px; border-radius:50%; border:1px solid var(--t-6d8aa5, #6d8aa5)}
.rpg-sys .sys-unit-head .sys-dot.on{border-color:#7ef0c0; background:#7ef0c0; box-shadow:0 0 6px rgba(126,240,192,.8)}
.rpg-sys .sys-unit-val{margin-left:auto; flex:0 0 auto; white-space:nowrap; display:flex; align-items:center; gap:4px}
.rpg-sys .sys-unit-val .d{font-size:.8em}
.rpg-sys .sys-track{position:relative; height:100%}
.rpg-sys .sys-track s{position:absolute; top:0; height:100%; opacity:.5; border-radius:3px; text-decoration:none}
.rpg-sys .sys-unit.dim{opacity:.55}
.rpg-sys .sys-unit-head .nm{min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--t-d6e8f7, #d6e8f7)}
.rpg-sys .sys-tkind{display:inline-grid; place-items:center; color:var(--tc); filter:drop-shadow(0 0 3px var(--tc))}
.rpg-sys .sys-tkind .sys-svg{width:13px; height:13px}

.rpg-sys .sys-head{position:relative; display:flex; justify-content:center; align-items:center; min-height:30px; margin:2px 0 8px}
.rpg-sys .sys-kind{position:absolute; left:4px; top:50%; transform:translateY(-50%); font-size:.62em; letter-spacing:.16em;
  color:var(--sc); opacity:.9; text-shadow:0 0 6px var(--sg)}
.rpg-sys .sys-ctl{position:absolute; right:0; top:50%; transform:translateY(-50%); display:flex; align-items:center; gap:6px}
.rpg-sys .sys-plate{border:1px solid var(--sc); padding:3px 18px 2px calc(18px + .22em); font-size:1.2em; font-weight:600;
  letter-spacing:.22em; color:var(--t-f2faff, #f2faff); text-shadow:0 0 8px var(--sg),0 0 2px #fff; background:rgba(var(--t-12_30_56, 12,30,56),.55);
  box-shadow:0 0 10px var(--sg), inset 0 0 10px rgba(var(--t-90_170_255, 90,170,255),.18)}
.rpg-sys #rpg-min-btn{width:28px !important; height:20px !important; background:rgba(var(--t-10_26_48, 10,26,48),.9) !important;
  border:1px solid rgba(var(--t-143_208_255, 143,208,255),.6) !important; color:var(--t-dff1ff, #dff1ff) !important}

.rpg-sys .sys-hero{margin:2px 0 8px}
.rpg-sys .sys-hero.name{text-align:center}
.rpg-sys .sys-big{font-size:1.9em; font-weight:700; line-height:1.1; color:var(--t-f4fbff, #f4fbff); letter-spacing:.02em;
  text-shadow:0 0 10px var(--sg), 0 0 2px rgba(255,255,255,.8); overflow-wrap:anywhere}
.rpg-sys .sys-big.m{font-size:1.6em} .rpg-sys .sys-big.s{font-size:1.3em}
.rpg-sys .sys-rule{height:1px; margin:6px 8%; background:linear-gradient(90deg,transparent,var(--sc),transparent); opacity:.6}
.rpg-sys .sys-info{display:grid; grid-template-columns:auto minmax(0,1fr); gap:1px 8px; font-size:.8em; text-align:left; align-items:baseline}
.rpg-sys .sys-info .k{color:var(--t-8fb6d8, #8fb6d8); letter-spacing:.08em; font-size:.82em; white-space:nowrap}
.rpg-sys .sys-info .v{color:var(--t-eaf6ff, #eaf6ff); font-weight:600; overflow-wrap:anywhere; min-width:0}
.rpg-sys .sys-info .v.bad{color:#ff9a9a; text-shadow:0 0 6px rgba(255,80,80,.5)}
.rpg-sys .sys-info .v.ok{color:#a6ecd0}
.rpg-sys .sys-hero.clock{display:flex; align-items:center; gap:12px}
.rpg-sys .sys-clock{flex:0 0 auto; width:64px; height:64px; color:var(--sc); filter:drop-shadow(0 0 4px var(--sg))}
.rpg-sys .sys-clock svg{display:block; width:100%; height:100%}
.rpg-sys .sys-clock.hat{width:76px; height:84px; filter:drop-shadow(0 0 5px rgba(150,190,255,.45))}
.rpg-sys .sys-clock.hat.system{filter:drop-shadow(0 0 4px var(--sg))}
.rpg-sys .sys-clock.pocket{filter:drop-shadow(0 0 4px var(--sg)) drop-shadow(0 2px 3px rgba(0,0,0,.5))}
.rpg-sys .sys-hero.clock .sys-info{flex:1; min-width:0}
.rpg-sys .sys-pick{position:relative; display:inline-block; max-width:100%; cursor:pointer}
.rpg-sys .sys-pick select{position:absolute; inset:0; width:100%; height:100%; opacity:0; cursor:pointer; font-size:16px;
  -webkit-appearance:none; appearance:none; border:0; margin:0}
.rpg-sys .sys-caret{font-size:.5em; opacity:.7; margin-left:.35em; vertical-align:middle; text-shadow:none}

.rpg-sys .sys-panels{display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:8px; margin-bottom:8px}
.rpg-sys .sys-box{border:1px solid rgba(var(--t-143_208_255, 143,208,255),.42); padding:7px 10px; background:rgba(var(--t-8_20_38, 8,20,38),.45);
  box-shadow:inset 0 0 12px rgba(var(--t-60_140_230, 60,140,230),.10); min-width:0}
.rpg-sys .sys-bar + .sys-bar{margin-top:6px}
.rpg-sys .sys-bar-lab{display:flex; align-items:center; gap:5px; font-size:.72em; letter-spacing:.08em; color:var(--t-a9cbe8, #a9cbe8)}
.rpg-sys .sys-bar-lab .sys-svg{width:12px; height:12px; color:var(--t-e6f5ff, #e6f5ff); flex:0 0 auto}
.rpg-sys .sys-bar-num{margin-left:auto; color:var(--t-dff1ff, #dff1ff); letter-spacing:0; font-size:1.05em; white-space:nowrap}
.rpg-sys .sys-cap{height:8px; margin-top:3px; border:1px solid rgba(var(--t-190_230_255, 190,230,255),.75); border-radius:6px; padding:1px;
  box-sizing:border-box; box-shadow:0 0 6px var(--sg), inset 0 0 4px rgba(var(--t-90_170_255, 90,170,255),.3)}
.rpg-sys .sys-cap i{display:block; height:100%; border-radius:4px; background:linear-gradient(90deg,var(--t-a9dcff, #a9dcff),var(--t-f4fbff, #f4fbff));
  box-shadow:0 0 6px rgba(var(--t-190_230_255, 190,230,255),.9)}
.rpg-sys .sys-cap.low i{background:linear-gradient(90deg,#ff6b6b,#ffb3b3); box-shadow:0 0 6px rgba(255,90,90,.9)}
.rpg-sys .sys-cap.tint i{background:var(--mc); box-shadow:0 0 6px var(--mc)}
.rpg-sys .sys-stats{display:grid; grid-template-columns:1fr 1fr; gap:6px 12px; align-content:center}
.rpg-sys .sys-stat{display:flex; align-items:center; gap:5px; font-size:.78em; color:var(--t-a9cbe8, #a9cbe8); letter-spacing:.06em; min-width:0}
.rpg-sys .sys-stat .sys-svg{width:14px; height:14px; color:var(--t-e6f5ff, #e6f5ff); filter:drop-shadow(0 0 3px var(--sg)); flex:0 0 auto}
.rpg-sys .sys-stat b{margin-left:auto; font-size:1.3em; color:var(--t-f4fbff, #f4fbff); text-shadow:0 0 8px var(--sg); letter-spacing:0; font-weight:600;
  white-space:nowrap}

.rpg-sys .sys-units + .sys-units{margin-top:8px}
.rpg-sys .sys-sec{font-size:.82em; letter-spacing:.18em; color:var(--sc); text-shadow:0 0 6px var(--sg); margin:1px 0 5px;
  padding-bottom:3px; border-bottom:1px solid rgba(var(--t-143_208_255, 143,208,255),.25)}
.rpg-sys .sys-sec.foe{color:#ff9a9a; text-shadow:0 0 6px rgba(255,80,80,.5); border-bottom-color:rgba(255,128,128,.3)}
.rpg-sys .sys-unit{padding:3px 0 6px}
.rpg-sys .sys-unit + .sys-unit{border-top:1px solid rgba(var(--t-143_208_255, 143,208,255),.12); padding-top:5px}
.rpg-sys .sys-unit-head{display:flex; align-items:center; gap:8px; margin-bottom:3px}
.rpg-sys .sys-unit-head .rpg-jump{cursor:pointer; color:var(--t-eaf6ff, #eaf6ff); font-weight:600; min-width:0; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; text-shadow:0 0 6px var(--sg)}
.rpg-sys .sys-unit-tag{margin-left:auto; display:flex; align-items:center; gap:3px; color:#f7b3cc; font-size:.9em; white-space:nowrap}
.rpg-sys .sys-unit-tag .sys-svg{width:11px; height:11px}
.rpg-sys .sys-mini{display:grid; grid-template-columns:30px minmax(0,1fr) auto; align-items:center; gap:6px; margin-top:2px}
.rpg-sys .sys-mini .l{font-size:.78em; letter-spacing:.08em; color:var(--t-a9cbe8, #a9cbe8)}
.rpg-sys .sys-mini .n{font-size:.85em; color:var(--t-dff1ff, #dff1ff); white-space:nowrap; min-width:58px; text-align:right}
.rpg-sys .sys-cap.sm{height:7px; margin-top:0}
.rpg-sys .sys-cap.foe{border-color:rgba(255,170,170,.75); box-shadow:0 0 6px rgba(255,80,80,.45)}
.rpg-sys .sys-cap.foe i{background:linear-gradient(90deg,#ff6b6b,#ffc2c2); box-shadow:0 0 6px rgba(255,90,90,.85)}
.rpg-sys .sys-foes{margin-top:6px; padding:6px 8px 2px; font-size:.8em; border:1px solid rgba(255,128,128,.35);
  background:rgba(40,8,14,.35); max-height:96px; overflow-y:auto}
.rpg-sys .rpg-c-btns button{background:rgba(var(--t-10_26_48, 10,26,48),.9) !important; border:1px solid rgba(var(--t-143_208_255, 143,208,255),.55) !important;
  color:var(--t-dff1ff, #dff1ff) !important; box-shadow:0 0 6px rgba(var(--t-90_170_255, 90,170,255),.2)}
.rpg-sys #rpg-settings-overlay,.rpg-sys #rpg-info-overlay{background:var(--t-04090f, #04090f) !important; border-color:var(--sc) !important}
.rpg-sys .rpg-c-li{border-bottom-color:rgba(var(--t-143_208_255, 143,208,255),.15)}
.rpg-sys .rpg-c-ed .rpg-sao-ico{border-color:rgba(var(--t-143_208_255, 143,208,255),.45); background:rgba(var(--t-10_26_48, 10,26,48),.85); color:var(--t-dff1ff, #dff1ff);
  box-shadow:0 0 5px rgba(var(--t-90_170_255, 90,170,255),.18)}
.rpg-sys .rpg-c-ed button.rpg-sao-ico:hover{border-color:var(--sc); color:#fff}
.rpg-sys .rpg-c-ed .rpg-sao-icopick{border-color:rgba(var(--t-143_208_255, 143,208,255),.35)}
.rpg-sys .rpg-c-ed .rpg-sao-icopick .on,.rpg-sys .rpg-c-ed .rpg-sao-ledit-ico.picking{border-color:var(--sc); color:#fff;
  box-shadow:inset 0 0 0 1px var(--sc), 0 0 6px var(--sg)}
.rpg-sys .rpg-c-ed .rpg-sao-ledit-ico.custom::after{background:var(--sc); box-shadow:0 0 0 1.5px var(--t-04090f, #04090f), 0 0 5px var(--sg)}
.rpg-sys .rpg-c-ed .rpg-sao-mini{background:rgba(var(--t-10_26_48, 10,26,48),.9); border-color:rgba(var(--t-143_208_255, 143,208,255),.5); color:var(--t-dff1ff, #dff1ff)}
.rpg-sys .sys-ibtn{display:inline-grid; place-items:center; padding:0; margin:0; border:0; background:none; color:inherit;
  cursor:pointer; -webkit-tap-highlight-color:transparent; font:inherit; line-height:0}
.rpg-sys .sys-ibtn:hover .sys-svg{color:#fff; filter:drop-shadow(0 0 4px var(--sg))}
.rpg-sys .sys-medit{margin:-2px 0 8px}
.rpg-sys .sys-addmeter-row{display:flex; justify-content:flex-end; margin-top:5px}
.rpg-sys .sys-addmeter{padding:0; border:0; background:none; cursor:pointer; font:inherit; font-size:.62em; letter-spacing:.12em;
  color:var(--t-6f93b5, #6f93b5); -webkit-tap-highlight-color:transparent}
.rpg-sys .sys-addmeter:hover{color:var(--sc); text-shadow:0 0 6px var(--sg)}
.rpg-sys .rpg-c-ed .rpg-sao-mini.primary{background:rgba(var(--t-40_110_190, 40,110,190),.55); border-color:var(--sc); color:#fff; box-shadow:0 0 6px var(--sg)}
.rpg-sys .sys-medit .rpg-c-medit{margin:0; padding:0; border:0; font-size:.8em}
.rpg-sys .rpg-c-ed .rpg-sao-mrow-edit{border-bottom-color:rgba(var(--t-143_208_255, 143,208,255),.15)}
.rpg-sys .rpg-c-ed .rpg-sao-mrow-edit input[type=text]{background:rgba(var(--t-6_16_30, 6,16,30),.9); border-color:rgba(var(--t-143_208_255, 143,208,255),.35); color:var(--t-eaf6ff, #eaf6ff)}
.rpg-sys .rpg-c-ed .rpg-sao-m-auto,.rpg-sys .rpg-c-ed .rpg-sao-m-del,.rpg-sys .rpg-c-ed .rpg-sao-m-color{background:rgba(var(--t-10_26_48, 10,26,48),.9);
  border-color:rgba(var(--t-143_208_255, 143,208,255),.4); color:var(--t-cfe6f8, #cfe6f8)}
.rpg-sys .rpg-c-ed .rpg-sao-ledit-text,.rpg-sys .rpg-c-ed .rpg-sao-mast-edit input[type=text]{background:rgba(var(--t-6_16_30, 6,16,30),.9);
  border-color:rgba(var(--t-143_208_255, 143,208,255),.35); color:var(--t-eaf6ff, #eaf6ff)}
.rpg-sys .rpg-c-ed .rpg-sao-ledit-del,.rpg-sys .rpg-c-ed .rpg-sao-ms-del,.rpg-sys .rpg-c-ed .rpg-sao-ledit-lock,
.rpg-sys .rpg-c-ed .rpg-sao-mv{background:rgba(var(--t-10_26_48, 10,26,48),.9); border-color:rgba(var(--t-143_208_255, 143,208,255),.4); color:var(--t-cfe6f8, #cfe6f8)}

#rpg-sys-notices{position:fixed; top:calc(env(safe-area-inset-top, 0px) + 14px); left:50%; transform:translateX(-50%);
  z-index:100003; display:flex; flex-direction:column; gap:8px; width:min(330px, calc(100vw - 24px)); pointer-events:none;
  font-size:15px}
.rpg-sys-note{--sc:#8fd0ff; --sg:rgba(90,180,255,.55); pointer-events:auto; position:relative; cursor:pointer;
  padding:10px 14px 12px; text-align:center; color:var(--t-e4f3ff, #e4f3ff); border:1px solid var(--sc);
  background:repeating-linear-gradient(115deg, rgba(var(--t-140_200_255, 140,200,255),.05) 0 1px, transparent 1px 13px),
    radial-gradient(120% 70% at 50% 0%, rgba(50,120,210,.28), transparent 65%), rgba(var(--t-4_9_18, 4,9,18),.95);
  box-shadow:0 0 0 1px rgba(0,0,0,.5), 0 0 18px var(--sg), inset 0 0 0 3px rgba(var(--t-4_9_18, 4,9,18),.85), inset 0 0 0 4px rgba(var(--t-143_208_255, 143,208,255),.28);
  transform-origin:50% 50%; animation:rpgSysIn .38s ease-out}
.rpg-sys-note.warn{--sc:#ff8080; --sg:rgba(255,80,80,.5)}
.rpg-sys-note .plate{display:inline-block; border:1px solid var(--sc); padding:2px 14px 1px calc(14px + .2em); margin-bottom:7px;
  font-size:.78em; font-weight:600; letter-spacing:.2em; color:var(--t-f2faff, #f2faff); text-shadow:0 0 6px var(--sg); box-shadow:0 0 8px var(--sg)}
.rpg-sys-note .msg{font-size:.92em; line-height:1.4; overflow-wrap:anywhere}
.rpg-sys-note .msg b{color:var(--t-cfeaff, #cfeaff); text-shadow:0 0 6px var(--sg); font-weight:600}
.rpg-sys-note.out{animation:rpgSysOut .3s ease-in forwards}
@keyframes rpgSysIn{0%{opacity:0; transform:scale(.6,.05)} 55%{opacity:1; transform:scale(1.02,1.04)} 100%{transform:none}}
@keyframes rpgSysOut{to{opacity:0; transform:scale(.9,.05)}}
@media (prefers-reduced-motion: reduce){ .rpg-sys-note,.rpg-sys-note.out{animation-duration:.01s} }
`;


// ---- Gray Fog: a theme over the System layout ----------------------------
// Charcoal fog, a pewter double frame with small flourishes at the corners,
// a faint sigil behind the title and a scatter of stars. The sigil is our own
// (rings, a long eight-point star and clock ticks), not any book's emblem.
const FOG_FONT = "'EB Garamond','Cormorant Garamond',Georgia,'Times New Roman',serif";
const FOG_WEBFONTS = "family=Cinzel:wght@500;600&family=EB+Garamond:wght@400;500;600&family=Grenze+Gotisch:wght@500;600";
const fogSvgUrl = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
// The star, from your tracing (pixel units of that tracing, mirrored so both
// sides match):
//   K1     a wide kite: the upper diagonal points, meeting low in the middle
//   H      a long level diamond: the left and right points
//   K2     the lower diagonal points, rising towards the middle and dropping
//          into the long bottom spike
//   spike  the top spike, standing on the circle, with a second, inner spike
//          nested in it that runs down to the empty ring in the middle
// Every crossing is woven: one line goes over and the other breaks. By default
// K1 lies over H, and H over K2, but K2's rising edges go over K1's long ones,
// so the three interlace. The circle goes over or under each edge as traced.
// Everything is drawn at full strength inside one faded group, so where lines
// meet they don't add up to a brighter spot.
const FOG_STAR_AXIS = 603;
const FOG_STAR = {
  K1: { pts: [[185, 410], [603, 530], [1021, 410], [603, 877]], closed: true, rank: 4 },
  H: { pts: [[95, 635], [603, 475], [1111, 635], [603, 807]], closed: true, rank: 3 },
  K2: { pts: [[358, 880], [603, 444], [848, 880], [728, 848], [603, 1140], [478, 848]], closed: true, rank: 2 },
  spike: { pts: [[525, 258], [603, 32], [681, 258]], closed: false, rank: 6 },
  inner: { pts: [[465, 488], [603, 98], [741, 488]], closed: false, rank: 5 },
};
const FOG_STAR_CIRCLE = { x: 603, y: 580, r: 340 };
const FOG_STAR_HUB = { x: 603, y: 565, r: 112 };
// edges the circle passes OVER, named by their left-hand end (mirrored edges share it)
const FOG_CIRCLE_OVER = new Set(["95,635>603,807", "358,880>603,444"]);
// the circle meets the side kites' upper wings edge-on (joined, not woven) and stops inside them
const FOG_CIRCLE_JOIN = new Set(["185,410>603,530", "185,410>603,877"]);
// crossings that break the default order: [upper edge, lower edge], same naming
const FOG_OVER = [["358,880>603,444", "185,410>603,877"]];
const FOG_STAR_K = 190 / 1108, fogSX = (x) => 100 + (x - FOG_STAR_AXIS) * FOG_STAR_K, fogSY = (y) => 100 + (y - 586) * FOG_STAR_K;

function fogStarSvgBody() {
  const f = (v) => v.toFixed(2);
  const P = (pts, close) => `M${pts.map(([x, y]) => `${f(fogSX(x))} ${f(fogSY(y))}`).join(" L")}${close ? " Z" : ""}`;
  const mirX = (x) => Math.min(x, 2 * FOG_STAR_AXIS - x);
  const edgeName = (p, q) => { const [l, m] = p[0] <= q[0] ? [p, q] : [q, p]; return [`${mirX(l[0])},${l[1]}>${mirX(m[0])},${m[1]}`, `${mirX(m[0])},${m[1]}>${mirX(l[0])},${l[1]}`]; };
  const named = (names, set) => names.some((n) => (set.has ? set.has(n) : set.includes(n)));
  const unit = (dx, dy) => { const n = Math.hypot(dx, dy) || 1; return [dx / n, dy / n]; };
  const { x: cx, y: cy, r } = FOG_STAR_CIRCLE;

  // where lines end on other lines, they end exactly on them
  const shapes = JSON.parse(JSON.stringify(FOG_STAR));
  const meet = (p, q, a, b) => {                       // where line p-q meets line a-b
    const r1 = [q[0] - p[0], q[1] - p[1]], r2 = [b[0] - a[0], b[1] - a[1]], den = r1[0] * r2[1] - r1[1] * r2[0];
    const t = ((a[0] - p[0]) * r2[1] - (a[1] - p[1]) * r2[0]) / den;
    return [p[0] + r1[0] * t, p[1] + r1[1] * t];
  };
  const K1 = shapes.K1.pts, apex = shapes.inner.pts[1];
  shapes.inner.pts[0] = meet(apex, shapes.inner.pts[0], K1[0], K1[1]);
  shapes.inner.pts[2] = meet(apex, shapes.inner.pts[2], K1[2], K1[1]);
  const top = shapes.spike.pts[1];
  [0, 2].forEach((i) => {                               // the top spike's feet land on the circle
    const [ux, uy] = unit(shapes.spike.pts[i][0] - top[0], shapes.spike.pts[i][1] - top[1]);
    const fx = top[0] - cx, fy = top[1] - cy, B = 2 * (fx * ux + fy * uy), C = fx * fx + fy * fy - r * r;
    const t0 = (-B - Math.sqrt(B * B - 4 * C)) / 2, t = t0 + 2 / FOG_STAR_K;    // a little past it; trimmed below
    shapes.spike.pts[i] = [top[0] + ux * t, top[1] + uy * t];
  });

  const edges = [];
  Object.entries(shapes).forEach(([shape, { pts, closed, rank }]) => {
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      edges.push({ shape, rank, p, q, names: edgeName(p, q), dir: unit(q[0] - p[0], q[1] - p[1]) });
    }
  });
  // A break is cut along the line that passes over, so the broken ends run
  // parallel to it instead of ending square. { at, along, sin } per break.
  const cuts = { circle: [] };
  Object.keys(shapes).forEach((k) => { cuts[k] = []; });
  const segX = (a, b) => {
    const r1 = [a.q[0] - a.p[0], a.q[1] - a.p[1]], r2 = [b.q[0] - b.p[0], b.q[1] - b.p[1]];
    const den = r1[0] * r2[1] - r1[1] * r2[0];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((b.p[0] - a.p[0]) * r2[1] - (b.p[1] - a.p[1]) * r2[0]) / den;
    const u = ((b.p[0] - a.p[0]) * r1[1] - (b.p[1] - a.p[1]) * r1[0]) / den;
    if (t <= .01 || t >= .99 || u <= .01 || u >= .99) return null;     // shared corners and end-on meetings aren't crossings
    return [a.p[0] + r1[0] * t, a.p[1] + r1[1] * t];
  };
  const sinOf = (d1, d2) => Math.abs(d1[0] * d2[1] - d1[1] * d2[0]);
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i], b = edges[j];
    if (a.shape === b.shape) continue;
    const x = segX(a, b);
    if (!x) continue;
    const aOver = FOG_OVER.some(([o, u]) => named(a.names, [o]) && named(b.names, [u]))
      || (!FOG_OVER.some(([o, u]) => named(b.names, [o]) && named(a.names, [u])) && a.rank > b.rank);
    const [over, under] = aOver ? [a, b] : [b, a];
    cuts[under.shape].push({ at: x, along: over.dir, under: under.dir });
  }
  edges.forEach((e) => {
    if (e.shape === "spike" || e.shape === "inner") return;      // those sit on, or inside, the circle
    const dx = e.q[0] - e.p[0], dy = e.q[1] - e.p[1], fx = e.p[0] - cx, fy = e.p[1] - cy;
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r, D = B * B - 4 * A * C;
    if (D <= 0) return;
    [(-B - Math.sqrt(D)) / (2 * A), (-B + Math.sqrt(D)) / (2 * A)].forEach((t) => {
      if (t < 0 || t > 1) return;
      const pt = [e.p[0] + dx * t, e.p[1] + dy * t], tan = [-(pt[1] - cy) / r, (pt[0] - cx) / r];
      if (named(e.names, FOG_CIRCLE_JOIN)) return;
      if (named(e.names, FOG_CIRCLE_OVER)) cuts[e.shape].push({ at: pt, along: tan, under: e.dir });
      else cuts.circle.push({ at: pt, along: e.dir, under: tan, curved: true });
    });
  });
  // two breaks in the circle close together leave a sliver: clear the arc between them
  const arcs = [];
  cuts.circle.forEach((a, i) => cuts.circle.slice(i + 1).forEach((b) => {
    if (Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]) * FOG_STAR_K >= 17 || a.at[1] > cy + 40 || b.at[1] > cy + 40) return;
    let a1 = Math.atan2(a.at[1] - cy, a.at[0] - cx), a2 = Math.atan2(b.at[1] - cy, b.at[0] - cx);
    if (Math.abs(a2 - a1) > Math.PI) a2 += a2 < a1 ? 2 * Math.PI : -2 * Math.PI;
    arcs.push([Math.min(a1, a2), Math.max(a1, a2)]);
  }));

  const GAP = 5.4;                                      // width of a break, in the 200-unit drawing
  const R = r * FOG_STAR_K, CX = fogSX(cx), CY = fogSY(cy);
  // The cut is a parallelogram: its sides run along the line passing over (so the
  // broken ends are slanted to match it) and along the broken line itself (so it
  // never nicks a neighbouring line, however shallow the crossing).
  const cutEl = ({ at, along: o, under: u, curved }) => {
    const c = Math.max(.12, Math.abs(o[0] * u[1] - o[1] * u[0])), t = GAP / 2 / c;
    const w = 1.15 + .7 + (curved ? t * t / (2 * R) : 0), sI = w / c;
    const x = fogSX(at[0]), y = fogSY(at[1]);
    const pt = (a, b) => `${f(x + o[0] * a + u[0] * b)} ${f(y + o[1] * a + u[1] * b)}`;
    return `<path d="M${pt(sI, t)} L${pt(sI, -t)} L${pt(-sI, -t)} L${pt(-sI, t)} Z" fill="#000" stroke="none"/>`;
  };
  const arcEl = ([a1, a2]) => `<path d="M${f(CX + R * Math.cos(a1))} ${f(CY + R * Math.sin(a1))} A${f(R)} ${f(R)} 0 0 1 ${f(CX + R * Math.cos(a2))} ${f(CY + R * Math.sin(a2))}"
      stroke="#000" stroke-width="${GAP}" stroke-linecap="butt" fill="none"/>`;
  const hub = FOG_STAR_HUB, hubR = hub.r * FOG_STAR_K;
  const clearHub = `<circle cx="${f(fogSX(hub.x))}" cy="${f(fogSY(hub.y))}" r="${f(hubR + 4.4)}" fill="#000" stroke="none"/>`;
  // the inner spike stops along the far side of the kite's edge it lands on
  const off = 1.15 / FOG_STAR_K, k1 = shapes.K1.pts;
  const belowK1 = `<path d="${P([[k1[0][0], k1[0][1] + off], [k1[1][0], k1[1][1] + off], [k1[2][0], k1[2][1] + off], [k1[2][0] + 400, 2000], [k1[0][0] - 400, 2000]], true)}" fill="#000" stroke="none"/>`;
  const mask = (id, inner) => `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200"><rect width="200" height="200" fill="#fff" stroke="none"/>${inner}</mask>`;
  const area = (pts) => `<path d="${P(pts, true)}" fill="#000" stroke="none"/>`;
  // the circle stops at the outside of a spike's edge, so the two meet cleanly
  const areaAndEdge = (pts) => `<path d="${P(pts, true)}" fill="#000" stroke="#000" stroke-width="2.3" stroke-linejoin="miter"/>`;
  // the top spike's feet end along the inside of the circle's line, following its curve
  const insideCircle = `<circle cx="${f(fogSX(cx))}" cy="${f(fogSY(cy))}" r="${f(r * FOG_STAR_K - 1.15)}" fill="#000" stroke="none"/>`;
  const masks = Object.keys(shapes).map((k) => mask(`m-${k}`,
      cuts[k].map(cutEl).join("") + (k === "spike" ? insideCircle : clearHub) + (k === "inner" ? belowK1 : ""))).join("")
    // the circle doesn't show inside either spike
    + mask("m-circle", cuts.circle.map(cutEl).join("") + arcs.map(arcEl).join("")
      + area(shapes.spike.pts) + area(shapes.K1.pts) + areaAndEdge([[478, 848], [603, 1140], [728, 848]]));
  const lines = Object.entries(shapes).map(([k, { pts, closed }]) => `<path d="${P(pts, closed)}" mask="url(#m-${k})"/>`).join("");
  return `<defs>${masks}</defs>
    <g opacity=".27" stroke-width="2.3">
      <circle cx="${f(CX)}" cy="${f(CY)}" r="${f(R)}" mask="url(#m-circle)"/>
      ${lines}
      <circle cx="${f(fogSX(hub.x))}" cy="${f(fogSY(hub.y))}" r="${f(hubR)}" stroke-width="2.1"/>
    </g>`;
}
const FOG_SIGIL = fogSvgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="none" stroke="#e6e8ef" stroke-linejoin="miter" stroke-miterlimit="20">
  ${fogStarSvgBody()}
</svg>`);
const fogStar = (x, y, r, o) => `<path d="M${x} ${y - r} L${x + r * .22} ${y - r * .22} L${x + r} ${y} L${x + r * .22} ${y + r * .22} L${x} ${y + r} L${x - r * .22} ${y + r * .22} L${x - r} ${y} L${x - r * .22} ${y - r * .22} Z" fill="#fff" fill-opacity="${o}"/>`;
const FOG_STARS = fogSvgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 600" preserveAspectRatio="none">
  ${fogStar(38, 70, 5, .55)}${fogStar(262, 46, 4, .5)}${fogStar(214, 132, 3, .45)}${fogStar(70, 188, 2.5, .35)}
  ${fogStar(280, 250, 3.5, .35)}${fogStar(22, 330, 3, .3)}${fogStar(246, 420, 2.5, .3)}${fogStar(120, 22, 2.5, .4)}
  <circle cx="160" cy="92" r="1" fill="#fff" fill-opacity=".5"/><circle cx="96" cy="120" r=".8" fill="#fff" fill-opacity=".4"/>
  <circle cx="232" cy="208" r=".9" fill="#fff" fill-opacity=".35"/><circle cx="48" cy="262" r=".8" fill="#fff" fill-opacity=".3"/>
</svg>`);
// one corner, drawn top-left; the others are this flipped
const fogCorner = (t) => fogSvgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30" fill="none" stroke="#d3d5de" stroke-linecap="round">
  <g transform="${t}">
    <path d="M3 22 V3 H22" stroke-opacity=".55" stroke-width="1"/>
    <path d="M7 15 V7 H15" stroke-opacity=".45" stroke-width=".9"/>
    <path d="M7 7 L11 11" stroke-opacity=".6" stroke-width=".9"/>
    <path d="M3 3 L6 6" stroke-opacity=".6" stroke-width=".9"/>
    <path d="M11 11 l2.2 -2.2 l2.2 2.2 l-2.2 2.2 Z" fill="#d3d5de" fill-opacity=".55" stroke-opacity=".7" stroke-width=".7" transform="translate(-1 1)"/>
    <path d="M3 22 q0 4 3 5" stroke-opacity=".45" stroke-width=".9"/><path d="M22 3 q4 0 5 3" stroke-opacity=".45" stroke-width=".9"/>
  </g></svg>`);
const FOG_CORNERS = {
  tl: fogCorner(""), tr: fogCorner("translate(30 0) scale(-1 1)"),
  bl: fogCorner("translate(0 30) scale(1 -1)"), br: fogCorner("translate(30 30) scale(-1 -1)"),
};

const FOG_VARS = `
  --sc:#cfd2dc; --sg:rgba(200,205,225,.28); --st:rgba(190,195,215,.14);
  --t-143_208_255:200,204,214; --t-10_26_48:30,30,37; --t-4_9_18:16,16,20; --t-90_170_255:168,156,205;
  --t-140_200_255:210,214,225; --t-60_140_230:120,112,150; --t-190_230_255:222,224,232; --t-6_16_30:20,20,26;
  --t-40_90_180:80,74,108; --t-12_30_56:34,34,42; --t-8_20_38:26,26,32; --t-40_110_190:104,88,146; --t-4_12_24:18,18,23;
  --t-dff1ff:#e9e8ee; --t-eaf6ff:#efeef3; --t-f4fbff:#f6f5f8; --t-a9cbe8:#b3b1bf; --t-f2faff:#f3f2f6; --t-e6f5ff:#e7e6ec;
  --t-04090f:#0e0e12; --t-cfe6f8:#d4d3dc; --t-6d8aa5:#7d7b88; --t-d6e8f7:#dbdae2; --t-8fb6d8:#a4a2b0; --t-a9dcff:#a9a7b6;
  --t-6f93b5:#8a8898; --t-e4f3ff:#e7e6ec; --t-cfeaff:#dcdae5; --t-8aa3b8:#8f8d9b;
  --t-0d1a2c:#1d1d24; --t-3d6a94:#5c5a6a; --t-9fc6e6:#aeacba;`;

const FOG_CSS = `
.rpg-sys.rpg-fog, .rpg-sys-note.fog {${FOG_VARS}}
.rpg-sys.rpg-fog.rpg-sys-enemy{--sc:#d0767c; --sg:rgba(200,60,70,.32)}
.rpg-sys.rpg-fog.rpg-sys-veh{--sc:#b9a3dc; --sg:rgba(160,130,210,.32)}
.rpg-sys.rpg-fog{
  --sys-bg:${FOG_STARS} 0 0 / 100% 600px no-repeat,
    radial-gradient(55% 30% at 50% 10%, rgba(214,218,232,.17), transparent 72%),
    radial-gradient(75% 35% at 12% 88%, rgba(150,150,166,.13), transparent 70%),
    radial-gradient(60% 40% at 92% 58%, rgba(112,92,152,.14), transparent 70%),
    linear-gradient(180deg, #2c2e35 0%, #1f2026 42%, #141418 100%);
  --sys-shadow:0 0 0 1px rgba(0,0,0,.6), 0 4px 22px rgba(0,0,0,.55), 0 0 12px var(--sg),
    inset 0 0 0 4px rgba(20,20,25,.85), inset 0 0 0 5px rgba(205,208,218,.30), inset 0 0 40px rgba(0,0,0,.35);
  font-family:${FOG_FONT}}
.rpg-sys.rpg-fog::before,.rpg-sys.rpg-fog::after{border:0; filter:none; width:auto; height:26px; left:3px; right:3px; z-index:-1;
  background-repeat:no-repeat; background-size:26px 26px}
/* the corner buttons sit just inside the corner ornaments rather than on top of them */
.rpg-fog .sys-ctl{right:7px; gap:6px}   /* the minimize button's corner sits on the corner flourish's diagonal */
.rpg-fog #rpg-min-btn{width:24px !important}
/* the bottom buttons tuck behind one centred button and fan out from it */
.rpg-sys.rpg-fog .rpg-c-btns.fog-dock{left:50% !important; bottom:13.5px !important; transform:translateX(-50%); align-items:center; gap:7px !important}
.rpg-fog .fog-dock:not(.open) > button:not(#rpg-fog-dock){display:none !important}
.rpg-fog #rpg-fog-dock{position:relative; width:32px; height:32px; border-radius:50%; padding:0; cursor:pointer; display:grid; place-items:center;
  color:#eceef3; background:radial-gradient(circle at 35% 28%, #4a4c56, #1b1b21 70%);
  border:1px solid rgba(214,217,226,.75); box-shadow:0 0 0 3px rgba(18,18,23,.8), 0 0 0 4px rgba(214,217,226,.28), 0 0 12px var(--sg)}
.rpg-fog #rpg-fog-dock svg{width:20px; height:20px; overflow:visible; filter:drop-shadow(0 0 3px var(--sg))}
.rpg-fog #rpg-fog-dock .fog-star{transform-origin:12px 12px}
.rpg-fog .fog-dock.open #rpg-fog-dock .fog-star{transform:rotate(45deg) scale(.9)}
.rpg-fog .fog-dock.open #rpg-fog-dock svg{animation:fogDockSpin 14s linear infinite}
.rpg-fog .fog-dock.open.anim #rpg-fog-dock .fog-star{animation:fogDockTurn .35s ease-out both}
.rpg-fog .fog-dock.anim:not(.open) #rpg-fog-dock .fog-star{animation:fogDockUnturn .3s ease-out both}
@keyframes fogDockSpin{to{transform:rotate(360deg)}}
/* the HUD folded away: a floating round button, its star tinted by the status */
.rpg-fog-orb .fog-orb{width:44px; height:44px; border-radius:50%; padding:0; cursor:pointer; display:grid; place-items:center;
  touch-action:manipulation; user-select:none; -webkit-tap-highlight-color:transparent;
  background:radial-gradient(circle at 35% 28%, #4a4c56, #1b1b21 70%); border:1px solid rgba(214,217,226,.75);
  box-shadow:0 0 0 3px rgba(18,18,23,.85), 0 0 0 4px rgba(214,217,226,.3), 0 2px 12px rgba(0,0,0,.6), 0 0 14px rgba(200,205,225,.25);
  transition:transform .15s}
.rpg-fog-orb .fog-orb:hover{transform:scale(1.06)}
.rpg-fog-orb .fog-orb svg{width:26px; height:26px; overflow:visible; animation:fogDockSpin 14s linear infinite;
  filter:drop-shadow(0 0 3px var(--orb-tint)) drop-shadow(0 0 1px rgba(0,0,0,.8))}
@media (prefers-reduced-motion: reduce){.rpg-fog-orb .fog-orb svg{animation:none}}
.rpg-fog-orb.fog-orb-in .fog-orb{animation:fogOrbIn ${FOG_ORB_MS}ms cubic-bezier(.3,1.4,.5,1) both; animation-delay:inherit; animation-duration:inherit}
@keyframes fogOrbIn{from{opacity:0; transform:scale(.3) rotate(-60deg)} to{opacity:1; transform:none}}
/* opening: a thin strip unrolls sideways, then the panel folds down from the top edge */
.rpg-sys.rpg-fog.fog-unfold{transform-origin:50% 0; animation:fogUnfold ${FOG_UNFOLD_MS}ms ease-out both}
.rpg-sys.rpg-fog.fog-fold{transform-origin:50% 0; animation:fogFoldUp ${FOG_FOLD_MS}ms ease-in both; pointer-events:none}
@keyframes fogUnfold{
  0%{opacity:0; transform:perspective(1100px) rotateX(-88deg) scaleX(.08)}
  32%{opacity:1; transform:perspective(1100px) rotateX(-88deg) scaleX(1)}
  80%{transform:perspective(1100px) rotateX(5deg)}
  100%{transform:none}}
@keyframes fogFoldUp{
  0%{transform:none}
  55%{opacity:1; transform:perspective(1100px) rotateX(-88deg) scaleX(1)}
  100%{opacity:0; transform:perspective(1100px) rotateX(-88deg) scaleX(.08)}}
/* the status mark in the header: the star, still, in the status colour */
.rpg-fog .fog-status{display:inline-grid; place-items:center; width:20px; height:20px; vertical-align:middle}
.rpg-fog .fog-status svg{width:20px; height:20px; overflow:visible; filter:drop-shadow(0 0 3px var(--orb-tint)) drop-shadow(0 0 1px rgba(0,0,0,.9))}
@keyframes fogDockTurn{from{transform:none} to{transform:rotate(45deg) scale(.9)}}
@keyframes fogDockUnturn{from{transform:rotate(45deg) scale(.9)} to{transform:none}}
@media (prefers-reduced-motion: reduce){.rpg-fog .fog-dock.open #rpg-fog-dock svg{animation:none}}
.rpg-fog #rpg-fog-dock:hover{border-color:#fff}
.rpg-fog .fog-dock-badge{position:absolute; top:-2px; right:-2px; width:8px; height:8px; border-radius:50%; background:#ff5252; box-shadow:0 0 0 2px #111}
.rpg-fog .fog-dock.anim > #rpg-settings-btn,.rpg-fog .fog-dock.anim > #rpg-scan-btn{animation:fogDockL .3s cubic-bezier(.2,.8,.3,1.2) both}
.rpg-fog .fog-dock.anim > #rpg-help-btn,.rpg-fog .fog-dock.anim > #rpg-log-btn{animation:fogDockR .3s cubic-bezier(.2,.8,.3,1.2) both}
.rpg-fog .fog-dock.anim > #rpg-settings-btn,.rpg-fog .fog-dock.anim > #rpg-log-btn{animation-delay:.06s}
@keyframes fogDockL{from{opacity:0; transform:translateX(24px) scale(.6)} to{opacity:1; transform:none}}
@keyframes fogDockR{from{opacity:0; transform:translateX(-24px) scale(.6)} to{opacity:1; transform:none}}
.rpg-sys.rpg-fog::before{top:3px; bottom:auto; background-image:${FOG_CORNERS.tl},${FOG_CORNERS.tr}; background-position:left top, right top}
.rpg-sys.rpg-fog::after{bottom:3px; top:auto; background-image:${FOG_CORNERS.bl},${FOG_CORNERS.br}; background-position:left bottom, right bottom}

.rpg-fog .sys-plate{font-family:Cinzel,${FOG_FONT}; font-weight:600; font-size:1.05em; letter-spacing:.32em;
  padding:4px 11px 3px calc(11px + .32em); background:rgba(18,18,23,.6); border-color:rgba(214,217,226,.7);
  box-shadow:0 0 0 3px rgba(18,18,23,.75), 0 0 0 4px rgba(214,217,226,.25), 0 0 14px var(--sg); text-shadow:0 0 8px var(--sg)}
.rpg-fog .sys-plate::before,.rpg-fog .sys-plate::after{content:"\\2726"; font-size:.6em; opacity:.75; letter-spacing:0; vertical-align:.15em}
.rpg-fog .sys-plate::before{margin-right:.6em} .rpg-fog .sys-plate::after{margin-left:.3em}
.rpg-fog .sys-kind{font-family:Cinzel,${FOG_FONT}; letter-spacing:.2em}
.rpg-fog .fog-num{font-family:Cinzel,${FOG_FONT}; font-weight:600; text-align:center; font-size:.86em; letter-spacing:.3em; color:#d6d4de;
  margin:-2px 0 2px; text-shadow:0 0 4px #000, 0 0 10px rgba(0,0,0,.8), 0 0 8px var(--sg)}
.rpg-fog .sys-big{font-family:'Grenze Gotisch','UnifrakturMaguntia',Cinzel,${FOG_FONT}; font-weight:500; letter-spacing:.03em;
  text-shadow:0 0 6px rgba(0,0,0,.9), 0 0 14px rgba(0,0,0,.6), 0 0 12px var(--sg)}
.rpg-fog .sys-rule{background:linear-gradient(90deg,transparent,var(--sc) 30%,var(--sc) 70%,transparent); opacity:.45; position:relative}
.rpg-fog .sys-info .k,.rpg-fog .sys-bar-lab,.rpg-fog .sys-stat,.rpg-fog .sys-sec,.rpg-fog .sys-tabhead > span:first-child,
.rpg-fog .sys-mini .l{font-family:Cinzel,${FOG_FONT}}
.rpg-fog .sys-info{font-size:.86em}
.rpg-fog .sys-info .v{font-weight:500}
.rpg-fog .sys-info .v.ok{color:#b9d6c4}
.rpg-fog .sys-box{border-color:rgba(205,208,218,.32); background:rgba(14,14,18,.38);
  box-shadow:inset 0 0 0 2px rgba(14,14,18,.6), inset 0 0 0 3px rgba(205,208,218,.12)}
.rpg-fog .sys-stat b{font-family:${FOG_FONT}; font-weight:600}
.rpg-fog .sys-cap{border-radius:1px; border-color:rgba(214,217,226,.6); box-shadow:0 0 4px var(--sg)}
.rpg-fog .sys-cap i{border-radius:0; background:linear-gradient(90deg,#8d8a9a,#eceaf2); box-shadow:0 0 5px rgba(225,225,235,.55)}
.rpg-fog .sys-cap.mp i{background:linear-gradient(90deg,#5d4a8c,#b6a3dc); box-shadow:0 0 6px rgba(150,120,210,.6)}
.rpg-fog .sys-cap.low i{background:linear-gradient(90deg,#7c1d29,#d4636c); box-shadow:0 0 6px rgba(190,50,60,.7)}
.rpg-fog .sys-cap.foe i{background:linear-gradient(90deg,#7c1d29,#d4636c); box-shadow:0 0 6px rgba(190,50,60,.7)}
.rpg-fog .sys-cap.foe{border-color:rgba(220,140,145,.65)}
.rpg-fog .sys-foes{border-color:rgba(200,110,115,.35); background:rgba(40,12,16,.35)}
.rpg-fog .sys-svg{stroke-width:1.4}
.rpg-fog .sys-clock{filter:drop-shadow(0 0 4px var(--sg))}

#rpg-sys-notices .rpg-sys-note.fog{font-family:${FOG_FONT}; border-color:rgba(214,217,226,.75); border-radius:0;
  background:radial-gradient(90% 70% at 50% 0%, rgba(214,218,232,.16), transparent 70%), linear-gradient(180deg,#2a2b31,#18181c);
  box-shadow:0 0 0 1px rgba(0,0,0,.5), 0 6px 22px rgba(0,0,0,.5), inset 0 0 0 3px rgba(20,20,25,.85), inset 0 0 0 4px rgba(205,208,218,.28)}
#rpg-sys-notices .rpg-sys-note.fog.warn{--sc:#d0767c; --sg:rgba(200,60,70,.35); border-color:rgba(208,118,124,.8)}
.rpg-sys-note.fog .plate{font-family:Cinzel,${FOG_FONT}; letter-spacing:.28em; border-color:rgba(214,217,226,.6); box-shadow:0 0 10px var(--sg)}
.rpg-sys-note.fog .msg{font-size:1em}
.rpg-sys-note.fog .msg b{color:#f1eff6; font-weight:600}
`;

// ---- the tarot number under the title ----
function toRoman(n) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 0 || n > 3999) return "";
  if (n === 0) return "0";                     // the Fool's card is 0, there's no Roman zero
  const map = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  for (const [v, r] of map) while (n >= v) { out += r; n -= v; }
  return out;
}
// a Sequence the card tracks: a meter or a stat called Sequence (or Seq)
function fogSequenceOf(display) {
  const m = (Array.isArray(display?.meters) ? display.meters : []).find((x) => /^seq(uence)?$/i.test(String(x?.name || "").trim()));
  if (m) return tNum(m.curr);
  const st = display?.stats || {};
  const k = Object.keys(st).find((x) => /^seq(uence)?$/i.test(x));
  return k ? tNum(st[k]) : null;
}
function fogNumberHtml(display, time) {
  const mode = uiSettings.fogNumber || "auto";
  if (mode === "none") return "";
  const seq = mode === "day" ? null : fogSequenceOf(display);
  let n = seq;
  let title = seq !== null ? `Sequence ${seq}` : "";
  if (n === null && mode !== "sequence") { n = parseInt(time?.day, 10); title = `Day ${n} of the month`; }
  const r = n === null || !Number.isFinite(n) ? "" : toRoman(n);
  return r ? `<div class="fog-num" title="${escAttr(title)}">\u2014 ${r} \u2014</div>` : "";
}

function fogEnsureWebFont() {
  const href = `https://fonts.googleapis.com/css2?${FOG_WEBFONTS}&display=swap`;
  let link = document.getElementById("rpg-fog-webfont");
  if (link && link.getAttribute("href") === href) return;
  if (!link) {
    link = document.createElement("link");
    link.id = "rpg-fog-webfont";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  link.href = href;
}


// ---- background images (System and Gray Fog) -----------------------------
// Up to six pictures stacked behind the top of the panel, bottom to top: Gray
// Fog's built-in star, images from links, images you upload. Each layer
// has its own size, position, angle, opacity, shape, soft edges, colour and
// blend, adjusted live from a small editor at the bottom of the panel so the
// top stays in view. Layers are per skin. An uploaded picture is shrunk and
// kept on this device (a link works on every device you paste it into).
const EMBLEM_MAX = 6;
const EMBLEM_LAYER_DEFAULT = { src: "upload", url: "", size: 55, x: 0, y: 0, rot: 0, op: 60, shape: "none", soft: false, tone: "original", blend: "normal" };
const EMBLEM_BUILTIN_DEFAULT = { src: "builtin", url: "", size: 77, x: 0, y: -13, rot: 0, op: 100, shape: "none", soft: false, tone: "original", blend: "normal" };
const emblemImgKey = (skin, id) => id === "legacy" ? `rpgHud:emblemImg:${skin}` : `rpgHud:emblemImg:${skin}:${id}`;
const emblemImgCache = {};
let emblemEditOpen = false;
let emblemEdMin = false;     // the editor folded down to its header, to see more of the panel
let emblemSel = 0;

// the layer list for a skin; older single-image settings are read as one layer
function emblemLayers(skin = uiSettings.skin) {
  const saved = uiSettings.emblemLayers?.[skin];
  if (Array.isArray(saved)) return saved.map((l) => ({ ...EMBLEM_LAYER_DEFAULT, ...l }));
  const old = uiSettings.emblems?.[skin];
  if (old) {
    const base = skin === "fog" ? EMBLEM_BUILTIN_DEFAULT : { ...EMBLEM_LAYER_DEFAULT, src: "none", size: 70, y: -8, op: 30, soft: true };
    const l = { ...base, ...old, id: "legacy" };
    return l.src === "none" ? [] : [l];
  }
  return skin === "fog" ? [{ ...EMBLEM_BUILTIN_DEFAULT, id: "builtin" }] : [];
}
function saveEmblemLayers(layers, save = true, skin = uiSettings.skin) {
  uiSettings.emblemLayers = { ...(uiSettings.emblemLayers || {}), [skin]: layers };
  if (uiSettings.emblems?.[skin]) { uiSettings.emblems = { ...uiSettings.emblems }; delete uiSettings.emblems[skin]; }
  if (save) saveUiSettings();
}
function setEmblemLayer(i, patch, save = true, skin = uiSettings.skin) {
  const layers = emblemLayers(skin);
  if (!layers[i]) return;
  layers[i] = { ...layers[i], ...patch };
  saveEmblemLayers(layers, save, skin);
}
function emblemUpload(skin, id) {
  const k = emblemImgKey(skin, id);
  if (!(k in emblemImgCache)) {
    try { emblemImgCache[k] = localStorage.getItem(k) || ""; } catch { emblemImgCache[k] = ""; }
  }
  return emblemImgCache[k];
}
// a CSS url() that can't be broken out of, whatever the link contains
const cssUrl = (u) => `url("${String(u).replace(/["\\\n\r]/g, (c) => "\\" + c.charCodeAt(0).toString(16) + " ")}")`;
function emblemBackground(l, skin) {
  if (l.src === "builtin") return FOG_SIGIL;
  if (l.src === "url") return /^https?:\/\/\S+$/i.test(String(l.url).trim()) ? cssUrl(l.url.trim()) : "";
  if (l.src === "upload") { const d = emblemUpload(skin, l.id); return d ? cssUrl(d) : ""; }
  return "";
}
const EMBLEM_SHAPES = {
  circle: "circle(50%)", rounded: "inset(0 round 16%)",
  diamond: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)",
  hexagon: "polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0 50%)",
};
function emblemLayersHtml() {
  return emblemLayers().map((_, i) => `<div class="sys-emblem" data-layer="${i}"></div>`).join("");
}
function applyEmblem(container) {
  if (!container) return;
  const skin = uiSettings.skin, layers = emblemLayers(skin);
  const W = container.clientWidth || 300;
  container.querySelectorAll(".sys-emblem[data-layer]").forEach((el) => {
    const l = layers[+el.dataset.layer];
    const bg = l ? emblemBackground(l, skin) : "";
    if (!bg) { el.style.display = "none"; return; }
    const size = W * l.size / 100, clip = EMBLEM_SHAPES[l.shape] || "none";
    const mask = l.soft ? "radial-gradient(closest-side, #000 55%, transparent 100%)" : "none";
    Object.assign(el.style, {
      display: "block", width: `${size}px`, height: `${size}px`, top: `${(W * l.y / 100).toFixed(1)}px`,
      left: `calc(50% + ${(W * l.x / 100).toFixed(1)}px)`, transform: `translateX(-50%) rotate(${l.rot}deg)`,
      backgroundImage: bg, backgroundSize: l.shape === "none" ? "contain" : "cover",
      opacity: String(l.op / 100), clipPath: clip, webkitClipPath: clip, maskImage: mask, webkitMaskImage: mask,
      filter: l.tone === "silver" ? "grayscale(1) brightness(1.05) contrast(.95)" : l.tone === "dim" ? "grayscale(.5) brightness(.75)" : "none",
      mixBlendMode: l.blend === "screen" ? "screen" : l.blend === "soft" ? "soft-light" : "normal",
    });
  });
  // while editing, a dashed outline shows the selected layer's box
  const guide = container.querySelector(".em-guide"), g = layers[emblemSel];
  if (guide) {
    if (!g) { guide.style.display = "none"; return; }
    const size = W * g.size / 100;
    Object.assign(guide.style, { display: "block", width: `${size}px`, height: `${size}px`, top: `${(W * g.y / 100).toFixed(1)}px`,
      left: `calc(50% + ${(W * g.x / 100).toFixed(1)}px)`, transform: `translateX(-50%) rotate(${g.rot}deg)`,
      borderRadius: g.shape === "circle" ? "50%" : g.shape === "rounded" ? "18%" : "0" });
  }
}

// Move, resize and turn the selected layer by dragging on the panel itself.
function bindEmblemDrag(container) {
  const pad = container.querySelector("#rpg-emblem-drag");
  if (!pad) return;
  const skin = uiSettings.skin, i = emblemSel;
  const lim = Object.fromEntries(EMBLEM_SLIDERS.map(([k, , min, max]) => [k, [min, max]]));
  const clamp = (k, v) => Math.max(lim[k][0], Math.min(lim[k][1], Math.round(v)));
  const W = () => container.clientWidth || 300;
  const set = (patch) => {
    const l = emblemLayers(skin)[i];
    if (!l) return;
    const out = {};
    for (const k of Object.keys(patch)) out[k] = k === "rot" ? ((Math.round(patch[k]) + 540) % 360) - 180 : clamp(k, patch[k]);
    setEmblemLayer(i, out, false);
    applyEmblem(container);
    for (const k of Object.keys(out)) {
      const el = container.querySelector(`.em-slide[data-k="${k}"]`);
      if (el) { el.value = out[k]; el.nextElementSibling.textContent = out[k] + el.dataset.unit; }
    }
  };
  const pts = new Map();
  let start = null;
  const snapshot = () => {
    const l = emblemLayers(skin)[i];
    const p = [...pts.values()];
    const g = p.length > 1 ? { d: Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y), a: Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x),
      cx: (p[0].x + p[1].x) / 2, cy: (p[0].y + p[1].y) / 2 } : { cx: p[0].x, cy: p[0].y };
    start = { l: { ...l }, ...g, n: p.length };
  };
  pad.onpointerdown = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!emblemLayers(skin)[i]) return;
    pad.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    snapshot();
  };
  pad.onpointermove = (e) => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...pts.values()], w = W(), L = start.l;
    if (p.length === 1 && start.n === 1) {
      set({ x: L.x + (p[0].x - start.cx) / w * 100, y: L.y + (p[0].y - start.cy) / w * 100 });
    } else if (p.length > 1 && start.n > 1) {
      const d = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y), a = Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x);
      const cx = (p[0].x + p[1].x) / 2, cy = (p[0].y + p[1].y) / 2;
      set({ size: L.size * d / Math.max(1, start.d), rot: L.rot + (a - start.a) * 180 / Math.PI,
        x: L.x + (cx - start.cx) / w * 100, y: L.y + (cy - start.cy) / w * 100 });
    }
  };
  const lift = (e) => {
    if (!pts.delete(e.pointerId)) return;
    if (pts.size) snapshot(); else { start = null; saveUiSettings(); }
  };
  pad.onpointerup = lift; pad.onpointercancel = lift;
  pad.onclick = (e) => e.stopPropagation();
  let wheelSave = 0;
  pad.onwheel = (e) => {
    e.preventDefault(); e.stopPropagation();
    const l = emblemLayers(skin)[i];
    if (!l) return;
    const step = e.deltaY < 0 ? 1 : -1;
    set(e.shiftKey ? { rot: l.rot + step * 3 } : { size: l.size + step * 2 });
    clearTimeout(wheelSave); wheelSave = setTimeout(saveUiSettings, 400);
  };
}

const EMBLEM_SLIDERS = [
  ["size", "Size", 10, 200, "%"], ["x", "Left / right", -60, 60, ""], ["y", "Up / down", -60, 140, ""],
  ["rot", "Rotate", -180, 180, "°"], ["op", "Opacity", 5, 100, "%"],
];
const EMBLEM_SRC_LABEL = { builtin: "Star", url: "Link", upload: "Upload" };
function emblemEditorHtml() {
  const skin = uiSettings.skin, layers = emblemLayers(skin);
  if (emblemSel >= layers.length) emblemSel = Math.max(0, layers.length - 1);
  const l = layers[emblemSel];
  const opt = (v, t, cur) => `<option value="${v}"${cur === v ? " selected" : ""}>${t}</option>`;
  const sel = (id, label, cur, opts) => `<label class="em-row"><span>${label}</span><select id="${id}">${opts.map(([v, t]) => opt(v, t, cur)).join("")}</select></label>`;
  const chips = layers.map((x, i) => `<button class="em-chip${i === emblemSel ? " on" : ""}" data-i="${i}" title="Layer ${i + 1}">${i + 1} · ${EMBLEM_SRC_LABEL[x.src] || x.src}</button>`).join("");
  const tools = `<div class="em-row em-layers">${chips || `<span class="em-none">No images.</span>`}
      ${layers.length < EMBLEM_MAX ? `<button id="em-add" title="Add a layer on top">+ Add</button>` : ""}</div>`;
  const head = `<div class="em-head"><span>BACKGROUND IMAGES</span><span class="em-headbtns">
      <button id="em-fold" title="${emblemEdMin ? "Show the controls" : "Fold the controls down to see the panel"}">${emblemEdMin ? "▴" : "▾"}</button><button id="em-done">Done</button></span></div>`;
  if (emblemEdMin) return `<div id="rpg-emblem-ed" class="rpg-emblem-ed min">${head}${l ? tools : ""}
      <p class="em-hint">Drag the panel to move layer ${emblemSel + 1}; pinch or scroll to resize, twist or Shift+scroll to rotate.</p></div>`;
  if (!l) return `<div id="rpg-emblem-ed" class="rpg-emblem-ed">
      ${head}${tools}
      <p class="em-hint">Add a layer to use the star, a picture from a link, or one from this device. Layers stack bottom to top.</p></div>`;
  return `<div id="rpg-emblem-ed" class="rpg-emblem-ed">
      ${head}
      ${tools}
      <div class="em-row em-btns">
        <button id="em-down" ${emblemSel === 0 ? "disabled" : ""} title="Move this layer down">◀ Lower</button>
        <button id="em-up" ${emblemSel >= layers.length - 1 ? "disabled" : ""} title="Move this layer up">Raise ▶</button>
        <button id="em-remove" title="Remove this layer">✕ Remove</button>
      </div>
      ${sel("em-src", "Image", l.src, [["builtin", "Star (built in)"], ["url", "From a link"], ["upload", "Upload from this device"]])}
      ${l.src === "url" ? `<div class="em-row"><input id="em-url" type="url" inputmode="url" placeholder="https://example.com/image.png" value="${escAttr(l.url)}"><button id="em-url-go">Use</button></div>` : ""}
      ${l.src === "upload" ? `<div class="em-row"><button id="em-pick">${emblemUpload(skin, l.id) ? "Replace image…" : "Choose image…"}</button>
        <input id="em-file" type="file" accept="image/*" style="display:none"></div>` : ""}
      ${EMBLEM_SLIDERS.map(([k, label, min, max, unit]) => `<label class="em-row"><span>${label}</span>
        <input type="range" class="em-slide" data-k="${k}" data-unit="${unit}" min="${min}" max="${max}" step="1" value="${l[k]}"><b>${l[k]}${unit}</b></label>`).join("")}
      ${sel("em-shape", "Shape", l.shape, [["none", "As it is"], ["circle", "Circle"], ["rounded", "Rounded square"], ["diamond", "Diamond"], ["hexagon", "Hexagon"]])}
      ${sel("em-soft", "Edges", l.soft ? "soft" : "hard", [["hard", "Sharp"], ["soft", "Fade out"]])}
      ${sel("em-tone", "Colour", l.tone, [["original", "Original"], ["silver", "Silver (greyscale)"], ["dim", "Dimmed"]])}
      ${sel("em-blend", "Blend", l.blend, [["normal", "Normal"], ["screen", "Glow (dark parts vanish)"], ["soft", "Soft light"]])}
      <div class="em-row em-btns"><button id="em-reset">Reset this layer's position and look</button></div>
      <p class="em-hint">Drag on the panel above to move this layer; pinch or scroll to resize, twist or Shift+scroll to rotate. Fold the controls (▾) to see more. Layers stack bottom to top. ${l.src === "url" ? "Any public image link; some sites block showing their images elsewhere, and if yours stays blank, save it and use Upload. "
        : l.src === "upload" ? "Kept on this device only, shrunk to keep it light. For every device, use a link instead. " : ""}Glow suits a light picture on a black background.</p>
    </div>`;
}

function bindEmblemEditor(container) {
  const box = container.querySelector("#rpg-emblem-ed");
  if (!box) return;
  box.onclick = (e) => e.stopPropagation();
  box.onkeydown = (e) => e.stopPropagation();
  const skin = uiSettings.skin, i = emblemSel;
  const layer = () => emblemLayers(skin)[emblemSel];
  box.querySelectorAll(".em-slide").forEach((el) => {
    // while a slider is held, the editor turns see-through except for that slider
    el.onpointerdown = () => {
      box.classList.add("peek");
      el.closest(".em-row")?.classList.add("em-active");
      const end = () => { box.classList.remove("peek"); el.closest(".em-row")?.classList.remove("em-active");
        window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
      window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
    };
    el.oninput = () => {
      setEmblemLayer(i, { [el.dataset.k]: Number(el.value) }, false);
      el.nextElementSibling.textContent = el.value + el.dataset.unit;
      applyEmblem(container);
    };
    el.onchange = () => saveUiSettings();
  });
  const onSel = (id, fn) => { const el = box.querySelector("#" + id); if (el) el.onchange = () => fn(el.value); };
  onSel("em-src", (v) => { setEmblemLayer(i, { src: v }); renderRPG(); });
  onSel("em-shape", (v) => { setEmblemLayer(i, { shape: v }); applyEmblem(container); });
  onSel("em-soft", (v) => { setEmblemLayer(i, { soft: v === "soft" }); applyEmblem(container); });
  onSel("em-tone", (v) => { setEmblemLayer(i, { tone: v }); applyEmblem(container); });
  onSel("em-blend", (v) => { setEmblemLayer(i, { blend: v }); applyEmblem(container); });
  const btn = (id, fn) => { const el = box.querySelector("#" + id); if (el) el.onclick = (e) => { e.stopPropagation(); fn(); }; };
  box.querySelectorAll(".em-chip").forEach((el) => { el.onclick = (e) => { e.stopPropagation(); emblemSel = +el.dataset.i; renderRPG(); }; });
  btn("em-done", () => { emblemEditOpen = false; emblemEdMin = false; renderRPG(); });
  btn("em-fold", () => { emblemEdMin = !emblemEdMin; renderRPG(); });
  bindEmblemDrag(container);
  btn("em-add", () => {
    const layers = emblemLayers(skin);
    if (layers.length >= EMBLEM_MAX) return;
    layers.push({ ...EMBLEM_LAYER_DEFAULT, id: `l${Date.now().toString(36)}` });
    saveEmblemLayers(layers);
    emblemSel = layers.length - 1;
    renderRPG();
  });
  btn("em-remove", () => {
    const layers = emblemLayers(skin), gone = layers.splice(i, 1)[0];
    if (gone?.src === "upload" || gone?.id) {
      try { localStorage.removeItem(emblemImgKey(skin, gone.id)); } catch {}
      delete emblemImgCache[emblemImgKey(skin, gone.id)];
    }
    saveEmblemLayers(layers);
    emblemSel = Math.max(0, Math.min(i, layers.length - 1));
    renderRPG();
  });
  const move = (d) => {
    const layers = emblemLayers(skin), j = i + d;
    if (j < 0 || j >= layers.length) return;
    [layers[i], layers[j]] = [layers[j], layers[i]];
    saveEmblemLayers(layers);
    emblemSel = j;
    renderRPG();
  };
  btn("em-down", () => move(-1));
  btn("em-up", () => move(1));
  btn("em-reset", () => {
    const l = layer();
    const base = l.src === "builtin" ? EMBLEM_BUILTIN_DEFAULT : EMBLEM_LAYER_DEFAULT;
    setEmblemLayer(i, { ...base, src: l.src, url: l.url, id: l.id });
    renderRPG();
  });
  btn("em-url-go", () => {
    const url = String(box.querySelector("#em-url")?.value || "").trim();
    if (!/^https?:\/\/\S+$/i.test(url)) { hudToast.warning("That doesn't look like a web link (it should start with https://)."); return; }
    setEmblemLayer(i, { url });
    applyEmblem(container);
    const probe = new Image();
    probe.onerror = () => hudToast.warning("That link didn't give an image. The site may block showing it elsewhere; try saving it and using Upload.");
    probe.src = url;
  });
  const file = box.querySelector("#em-file");
  btn("em-pick", () => file?.click());
  if (file) file.onchange = () => {
    const f = file.files?.[0], l = layer();
    if (!f || !l) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // shrink to at most 640px on the long side, so it fits in browser storage
        const k = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        let data = c.toDataURL("image/webp", 0.9);
        if (!data.startsWith("data:image/webp")) data = c.toDataURL("image/png");
        const key = emblemImgKey(skin, l.id);
        try { localStorage.setItem(key, data); }
        catch { hudToast.warning("That image is too big to keep on this device. Try a smaller one, or use a link."); return; }
        emblemImgCache[key] = data;
        renderRPG();
      };
      img.onerror = () => hudToast.warning("Couldn't read that file as an image.");
      img.src = String(reader.result);
    };
    reader.readAsDataURL(f);
  };
}

const EMBLEM_CSS = `
.rpg-sys .sys-emblem{position:absolute; z-index:-1; pointer-events:none; display:none;
  background-position:center; background-repeat:no-repeat}
.rpg-emblem-ed{position:absolute; left:8px; right:8px; bottom:8px; max-height:60%; overflow:auto; z-index:100000; box-sizing:border-box;
  padding:8px 10px; font-size:.8em; color:var(--t-dff1ff, #dff1ff);
  background:rgba(var(--t-4_9_18, 4,9,18),.96); border:1px solid var(--sc); box-shadow:0 0 12px var(--sg);
  transition:background .15s, border-color .15s, box-shadow .15s}
.rpg-emblem-ed .em-head{display:flex; justify-content:space-between; align-items:center; letter-spacing:.18em; color:var(--sc);
  margin-bottom:6px; text-shadow:0 0 6px var(--sg)}
.rpg-emblem-ed .em-row{display:flex; align-items:center; gap:8px; margin:5px 0}
.rpg-emblem-ed .em-row > span{flex:0 0 78px; color:var(--t-8fb6d8, #8fb6d8)}
.rpg-emblem-ed .em-row input[type=range]{flex:1; min-width:0; accent-color:var(--sc)}
.rpg-emblem-ed .em-row b{flex:0 0 38px; text-align:right; font-weight:500}
.rpg-emblem-ed select, .rpg-emblem-ed input[type=url]{flex:1; min-width:0; box-sizing:border-box; font:inherit; font-size:16px; padding:3px 5px;
  color:inherit; background:var(--t-0d1a2c, #0d1a2c); border:1px solid var(--t-3d6a94, #3d6a94)}
@media (pointer:fine){ .rpg-emblem-ed select, .rpg-emblem-ed input[type=url]{font-size:inherit} }
.rpg-emblem-ed button{font:inherit; padding:3px 10px; cursor:pointer; color:inherit;
  background:rgba(var(--t-10_26_48, 10,26,48),.9); border:1px solid rgba(var(--t-143_208_255, 143,208,255),.55)}
.rpg-emblem-ed .em-btns{justify-content:flex-end; flex-wrap:wrap}
.rpg-emblem-ed .em-layers{flex-wrap:wrap; gap:5px}
.rpg-emblem-ed .em-chip.on{border-color:var(--sc); box-shadow:inset 0 0 6px var(--sg); color:#fff}
.rpg-emblem-ed button:disabled{opacity:.35; cursor:default}
.rpg-emblem-ed .em-none{color:var(--t-8fb6d8, #8fb6d8); flex:1}
.rpg-emblem-ed .em-hint{margin:6px 0 0; color:var(--t-8fb6d8, #8fb6d8); font-size:.92em; line-height:1.35}
.rpg-emblem-ed .em-headbtns{display:flex; gap:6px}
.rpg-emblem-ed.min{max-height:none}
.rpg-emblem-ed.min .em-hint{margin-top:4px}
/* holding a slider: only that slider stays visible, so the picture behind can be seen */
.rpg-emblem-ed.peek{background:transparent; border-color:transparent; box-shadow:none; overflow:hidden}
.rpg-emblem-ed.peek > *:not(.em-active){opacity:0; transition:opacity .15s}
.rpg-emblem-ed.peek .em-active{background:rgba(var(--t-4_9_18, 4,9,18),.88); outline:1px solid var(--sc); padding:4px 6px; margin:0 -6px}
#rpg-emblem-drag{position:absolute; inset:0; z-index:99998; cursor:move; touch-action:none; background:transparent}
.rpg-sys .em-guide{position:absolute; z-index:99997; pointer-events:none; display:none; box-sizing:border-box;
  border:1px dashed var(--sc); box-shadow:0 0 0 1px rgba(0,0,0,.5), 0 0 8px var(--sg)}
`;

function sysEnsureCss() {
  const css = SYS_CSS + FOG_CSS + EMBLEM_CSS;
  let el = document.getElementById("rpg-sys-css");
  if (el && el.textContent === css) return;
  if (!el) {
    el = document.createElement("style");
    el.id = "rpg-sys-css";
    document.head.appendChild(el);
  }
  el.textContent = css;
}

function sysFontStack() {
  if (isFogSkin()) return FOG_FONT;
  const k = uiSettings.sysFont || "exo";
  if (k === "preset") return uiSettings.fontFamily || SAO_FONTS.sans;
  return SAO_FONTS[k] || SAO_FONTS.exo;
}

function sysEnsureWebFont() {
  if (isFogSkin()) { fogEnsureWebFont(); return; }
  const family = SAO_WEBFONTS[uiSettings.sysFont || "exo"];
  if (!family) return;
  const href = `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
  let link = document.getElementById("rpg-sys-webfont");
  if (link && link.getAttribute("href") === href) return;
  if (!link) {
    link = document.createElement("link");
    link.id = "rpg-sys-webfont";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  link.href = href;
}

const SYS_ICON_PATHS = {
  hp: '<path d="M8 3v10M3 8h10" stroke-width="2.4"/>',
  mp: '<path d="M8 2.5c2.6 3.2 4 5.3 4 7.1a4 4 0 0 1-8 0c0-1.8 1.4-3.9 4-7.1z"/>',
  bond: '<path d="M8 13.2S2.5 9.8 2.5 6.2A2.9 2.9 0 0 1 8 4.9a2.9 2.9 0 0 1 5.5 1.3c0 3.6-5.5 7-5.5 7z"/>',
  meter: '<path d="M2.8 11.5a5.5 5.5 0 1 1 10.4 0"/><path d="M8 10l2.8-2.8"/>',
  atk: '<g transform="rotate(45 8 8)"><path d="M8 .6l1.25 2V10h-2.5V2.6z"/><path d="M8 3.4v5.4" stroke-width="1"/><path d="M4.4 10.3h7.2" stroke-width="1.8"/><path d="M8 10.6v3"/><circle cx="8" cy="14.5" r=".9"/></g>',
  matk: '<path d="M2.8 13.2L9.6 6.4"/><path d="M12 1.8v4.4M9.8 4h4.4"/>',
  def: '<path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z"/>',
  satk: '<path d="M8 14c-2.6 0-4.3-1.8-4.3-4.1 0-2.6 2.3-3.7 2.6-6.4 1.6 1 2.6 2.4 2.6 4 .7-.4 1.2-1.2 1.3-2 1.4 1.2 2.1 2.7 2.1 4.4C12.3 12.2 10.6 14 8 14z"/>',
  sdef: '<path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z"/><path d="M8 5.6v4.8M5.6 8h4.8"/>',
  coin: '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="2.8"/>',
  gear: '<path d="M6.94 3.42L7.08 1.46L8.92 1.46L9.06 3.42L10.49 4.01L11.97 2.73L13.27 4.03L11.99 5.51L12.58 6.94L14.54 7.08L14.54 8.92L12.58 9.06L11.99 10.49L13.27 11.97L11.97 13.27L10.49 11.99L9.06 12.58L8.92 14.54L7.08 14.54L6.94 12.58L5.51 11.99L4.03 13.27L2.73 11.97L4.01 10.49L3.42 9.06L1.46 8.92L1.46 7.08L3.42 6.94L4.01 5.51L2.73 4.03L4.03 2.73L5.51 4.01z" stroke-width="1.3"/><circle cx="8" cy="8" r="2.1"/>',
  log: '<path d="M4.5 2.5h6.5a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H4.5a1.5 1.5 0 0 1-1.5-1.5V4a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M5.8 6h4.4M5.8 8.5h4.4M5.8 11h2.6"/>',
  help: '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.4M8 11.6v.1"/>',
  pencil: '<path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2z"/><path d="M9.3 4.2l2.5 2.5"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>',
  sweep: '<path d="M11 2L8 8"/><path d="M5 8.5h5.5l1 5.5H4z"/><path d="M6.8 11v3M8.7 11v3"/>',
  timer: '<circle cx="8" cy="9" r="5"/><path d="M8 9V6.5M6.5 2h3M8 2v2M12 4.6l1-1"/>',
  hourglass: '<path d="M4 2h8M4 14h8M5 2c0 3 3 4 3 6s-3 3-3 6M11 2c0 3-3 4-3 6s3 3 3 6"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  warn: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.3v.2"/>',
  sparkle: '<path d="M8 2l1.4 4.6L14 8l-4.6 1.4L8 14l-1.4-4.6L2 8l4.6-1.4z"/>',
  skull: '<path d="M8 2.2c-3 0-5 2-5 4.7 0 1.6.8 2.7 1.8 3.3v2.1h6.4v-2.1c1-.6 1.8-1.7 1.8-3.3 0-2.7-2-4.7-5-4.7z"/><circle cx="6" cy="7.4" r="1"/><circle cx="10" cy="7.4" r="1"/><path d="M7 12.3v-1.2M9 12.3v-1.2"/>',
  skip: '<path d="M3.5 3.5l6 4.5-6 4.5z"/><path d="M12.5 3.5v9"/>',
};
// timer kinds, matching timerKindStyle's emoji
const SYS_TIMER_ICON = { DOOM: "skull", EVENT: "calendar", DEBUFF: "warn", BUFF: "sparkle" };
// Gray Fog swaps a few for tarot-flavoured ones: a cup for health, a star for
// spirituality, a crescent for SDEF and a pentacle for coin
const FOG_ICON_PATHS = {
  hp: '<path d="M4.3 2.5h7.4c0 3.8-1.5 5.8-3.7 5.8S4.3 6.3 4.3 2.5z"/><path d="M8 8.3v4M5.4 13.6h5.2"/>',
  mp: '<path d="M8 1.6l1.35 5.05L14.4 8l-5.05 1.35L8 14.4l-1.35-5.05L1.6 8l5.05-1.35z"/>',
  sdef: '<path d="M11.2 2.2a6 6 0 1 0 2.7 11A4.1 4.1 0 0 1 11.2 2.2z" fill="currentColor" fill-opacity=".3" stroke-width="1.5"/>',
  atk: '<path d="M8 .8l1.3 2.1v7.6H6.7V2.9z" fill="currentColor" fill-opacity=".18"/><path d="M8 3.4v6.4" stroke-width=".8"/><path d="M3.9 10.6h8.2M3.9 10.6l-.6-.9M12.1 10.6l.6-.9" stroke-width="1.4"/><path d="M8 11v2.4"/><path d="M8 13.3l1 1-1 1-1-1z" fill="currentColor"/>',
  matk: '<path d="M2.3 13.1L9 6.4l1.1 1.1-6.7 6.7z" fill="currentColor" fill-opacity=".18"/><path d="M4.3 10.1l1.1 1.1M6.3 8.1l1.1 1.1" stroke-width=".9"/><path d="M12.2 1.4l.8 2.6 2.6.8-2.6.8-.8 2.6-.8-2.6-2.6-.8 2.6-.8z" fill="currentColor" fill-opacity=".35"/><path d="M14.4 8.6v1.6M13.6 9.4h1.6M8.6 1.6v1.2M8 2.2h1.2" stroke-width=".8"/>',
  coin: '<circle cx="8" cy="8" r="6"/><path d="M8 3.4 L10.7 11.72 L3.63 6.58 L12.37 6.58 L5.3 11.72 Z" stroke-width="1"/>',
};
const sysIcon = (k) => `<svg class="sys-svg" viewBox="0 0 16 16" aria-hidden="true">${(isFogSkin() && FOG_ICON_PATHS[k]) || SYS_ICON_PATHS[k] || ""}</svg>`;

// An analog face for the in-world time. "14:30", "2:30 PM", "02.30pm" all read.
function sysClockSvg(clock) {
  const m = String(clock || "").match(/(\d{1,2})\s*[:.h]\s*(\d{2})(?:\s*([ap])\.?\s*m\.?)?/i);
  let h = 0, mi = 0;
  const ok = !!m;
  if (m) {
    h = +m[1]; mi = Math.min(59, +m[2]);
    if (m[3]) { const pm = /p/i.test(m[3]); if (h === 12) h = 0; if (pm) h += 12; }
  }
  const ha = ((h % 12) + mi / 60) * 30, ma = mi * 6;
  let ticks = "";
  for (let i = 0; i < 12; i++) {
    const major = i % 3 === 0;
    ticks += `<line x1="50" y1="${major ? 9 : 11}" x2="50" y2="${major ? 17 : 15}" stroke="currentColor" stroke-width="${major ? 3 : 1.6}"
      stroke-linecap="round" transform="rotate(${i * 30} 50 50)"/>`;
  }
  const hand = "var(--t-f4fbff, #f4fbff)";
  return `<svg viewBox="0 0 100 100" aria-label="${escAttr(ok ? `Time ${clock}` : "Time unknown")}" role="img">
    <circle cx="50" cy="50" r="47" style="fill:rgba(var(--t-8_20_38, 8,20,38),.6)" stroke="currentColor" stroke-width="2"/>
    <circle cx="50" cy="50" r="41" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="1"/>
    ${ticks}
    <text x="50" y="74" text-anchor="middle" font-size="11" letter-spacing="1" style="font-family:inherit; fill:var(--t-a9cbe8, #a9cbe8)">${ok ? (h >= 12 ? "PM" : "AM") : "?"}</text>
    ${ok ? `<line x1="50" y1="53" x2="50" y2="28" style="stroke:${hand}" stroke-width="4.5" stroke-linecap="round" transform="rotate(${ha.toFixed(1)} 50 50)"/>
    <line x1="50" y1="56" x2="50" y2="16" style="stroke:${hand}" stroke-width="2.6" stroke-linecap="round" transform="rotate(${ma} 50 50)"/>` : ""}
    <circle cx="50" cy="50" r="3.6" style="fill:${hand}"/>
  </svg>`;
}

// The storybook clock: a round case with ears, little arms and feet, a face
// with Roman numerals set around the rim, a bow and a little top hat.
// "storybook" is pale blue, white and navy; "system" is the same drawing in
// the window's own glow, so it follows the frame (red for enemies and so on).
const HAT_CLOCK_LOOKS = {
  fog: { case_: "#1d1d23", edge: "currentColor", stitch: "currentColor", stitchOp: .42, face: "#111115", faceEdge: "currentColor",
    dots: "#9c99a8", nums: "#ecebf0", hands: "#f3f2f6", hub: "#0e0e12", ampm: "#9c99a8",
    bow: "rgba(140,115,190,.35)", bowDk: "rgba(140,115,190,.55)", bowEdge: "currentColor", hat: "#000", brim: "#000", hatEdge: "currentColor", shine: "rgba(220,220,230,.3)" },
  storybook: { case_: "#b7cdee", edge: "#7f9ccc", stitch: "#8eaad6", stitchOp: 1, face: "#fbfcff", faceEdge: "#8eaad6",
    dots: "#444", nums: "#2f2f2f", hands: "#2b2b2b", hub: "#fff", ampm: "#8a96a8",
    bow: "#1f3a9e", bowDk: "#152a78", bowEdge: "#152a78", hat: "#0b0b0e", brim: "#0b0b0e", hatEdge: "#000", shine: "#3a3a44" },
  system: { case_: "#0a1a30", edge: "currentColor", stitch: "currentColor", stitchOp: .45, face: "#050c18", faceEdge: "currentColor",
    dots: "#8fb6d8", nums: "#e6f5ff", hands: "#f4fbff", hub: "#04090f", ampm: "#8fb6d8",
    bow: "rgba(90,170,255,.28)", bowDk: "rgba(90,170,255,.45)", bowEdge: "currentColor", hat: "#000", brim: "#000", hatEdge: "currentColor", shine: "rgba(143,208,255,.35)" },
};
function sysHatClockSvg(clock, look = "storybook") {
  const L = HAT_CLOCK_LOOKS[look] || HAT_CLOCK_LOOKS.storybook;
  const p = parseClock(clock);
  const cx = 60, cy = 70;
  const h = p ? Math.floor(p.mins / 60) : 0, mi = p ? p.mins % 60 : 0;
  const ha = ((h % 12) + mi / 60) * 30, ma = mi * 6;
  const ROMAN = ["XII", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"];
  let dots = "";
  for (let i = 0; i < 60; i++) {
    const a = (i * 6 - 90) * Math.PI / 180;
    dots += `<circle cx="${(cx + 34.5 * Math.cos(a)).toFixed(2)}" cy="${(cy + 34.5 * Math.sin(a)).toFixed(2)}" r=".75"/>`;
  }
  const nums = ROMAN.map((r, i) =>
    `<text x="${cx}" y="${cy - 26}" transform="rotate(${i * 30} ${cx} ${cy})" text-anchor="middle"
      font-size="${r.length > 3 ? 6.4 : 7.6}" letter-spacing="-.3">${r}</text>`).join("");
  return `<svg viewBox="0 0 120 132" role="img" aria-label="${escAttr(p ? `Time ${clock}` : "Time unknown")}">
    <!-- ears, arms and legs first, each with its stitching, so the body covers the joins -->
    <g fill="${L.case_}" stroke="${L.edge}" stroke-width="1.6">
      <circle cx="22" cy="34" r="15"/><circle cx="98" cy="34" r="15"/>
      <ellipse cx="11" cy="84" rx="10" ry="11"/><ellipse cx="109" cy="84" rx="10" ry="11"/>
      <rect x="31" y="98" width="17" height="30" rx="8.5"/><rect x="72" y="98" width="17" height="30" rx="8.5"/>
    </g>
    <g fill="none" stroke="${L.stitch}" stroke-opacity="${L.stitchOp}" stroke-width=".8" stroke-dasharray="1.3 1.3">
      <circle cx="22" cy="34" r="12.6"/><circle cx="98" cy="34" r="12.6"/>
      <ellipse cx="11" cy="84" rx="7.6" ry="8.6"/><ellipse cx="109" cy="84" rx="7.6" ry="8.6"/>
      <rect x="33.4" y="100.4" width="12.2" height="25.2" rx="6.1"/><rect x="74.4" y="100.4" width="12.2" height="25.2" rx="6.1"/>
    </g>
    <circle cx="${cx}" cy="${cy}" r="47" fill="${L.case_}" stroke="${L.edge}" stroke-width="1.6"/>
    <circle cx="${cx}" cy="${cy}" r="44.6" fill="none" stroke="${L.stitch}" stroke-opacity="${L.stitchOp}" stroke-width=".8" stroke-dasharray="1.3 1.3"/>
    <circle cx="${cx}" cy="${cy}" r="39" fill="${L.face}" stroke="${L.faceEdge}" stroke-width="1.2"/>
    <g fill="${L.dots}">${dots}</g>
    <g fill="${L.nums}" font-family="'Times New Roman',Georgia,serif" font-weight="700">${nums}</g>
    ${p ? `<g fill="${L.hands}">
      <path d="M${cx - 2.6} ${cy} L${cx} ${cy - 20} L${cx + 2.6} ${cy} L${cx} ${cy + 4} Z" transform="rotate(${ha.toFixed(1)} ${cx} ${cy})"/>
      <path d="M${cx - 2} ${cy} L${cx} ${cy - 32} L${cx + 2} ${cy} L${cx} ${cy + 5} Z" transform="rotate(${ma} ${cx} ${cy})"/>
    </g>` : `<text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="9" fill="${L.ampm}">?</text>`}
    <circle cx="${cx}" cy="${cy}" r="3.6" fill="${L.hub}" stroke="${L.hands}" stroke-width="1.6"/>
    ${p ? `<text x="${cx}" y="${cy + 17}" text-anchor="middle" font-size="6.5" letter-spacing=".6" fill="${L.ampm}" font-family="inherit">${h >= 12 ? "PM" : "AM"}</text>` : ""}
    <g transform="translate(${cx} 112)">
      <path d="M-2 -1 L-6 12 L-2.5 10 L0 13 Z M2 -1 L6 12 L2.5 10 L0 13 Z" fill="${L.bowDk}" stroke="${L.bowEdge}" stroke-width=".6"/>
      <path d="M-1.5 0 C-7 -8 -16 -7 -15 0 C-16 7 -7 8 -1.5 0 Z" fill="${L.bow}" stroke="${L.bowEdge}" stroke-width=".8"/>
      <path d="M1.5 0 C7 -8 16 -7 15 0 C16 7 7 8 1.5 0 Z" fill="${L.bow}" stroke="${L.bowEdge}" stroke-width=".8"/>
      <rect x="-3.2" y="-3.6" width="6.4" height="7.2" rx="1.8" fill="${L.bowDk}" stroke="${L.bowEdge}" stroke-width=".6"/>
    </g>
    <g>
      <ellipse cx="${cx}" cy="25.5" rx="17" ry="4" fill="${L.brim}" stroke="${L.hatEdge}" stroke-width=".8"/>
      <path d="M${cx - 10} 25 L${cx - 10.5} 5.5 Q${cx} 3 ${cx + 10.5} 5.5 L${cx + 10} 25 Z" fill="${L.hat}" stroke="${L.hatEdge}" stroke-width=".8"/>
      <path d="M${cx - 7} 8 Q${cx - 6.5} 13 ${cx - 7} 16.5" stroke="${L.shine}" stroke-width="1.2" fill="none" stroke-linecap="round"/>
    </g>
  </svg>`;
}

// A Victorian pocket watch: bow ring and crown on top, a short chain, a
// small-seconds dial at six and Breguet hands (the open ring near the tip).
const POCKET_WATCH_LOOKS = {
  fog: { metal: true, caseA: "#eceef3", caseB: "#8b8e9a", edge: "#4a4c55", rim: "#c9ccd6", face: "#efe9da", faceEdge: "#a39d8c",
    nums: "#2a2620", ticks: "#5a554a", hands: "#28324d", sub: "#8f897a", chain: "url(#rpg-pw-case-fog)", ampm: "#7a7466" },
  system: { caseA: "#14304f", caseB: "#081426", edge: "currentColor", rim: "currentColor", face: "#050c18", faceEdge: "currentColor",
    nums: "#e6f5ff", ticks: "#8fb6d8", hands: "#f4fbff", sub: "#6f93b5", chain: "currentColor", ampm: "#8fb6d8" },
};
function sysPocketWatchSvg(clock, look = "fog") {
  const L = POCKET_WATCH_LOOKS[look] || POCKET_WATCH_LOOKS.fog;
  const p = parseClock(clock);
  const cx = 64, cy = 76, R = 42;
  const h = p ? Math.floor(p.mins / 60) : 0, mi = p ? p.mins % 60 : 0;
  const ha = ((h % 12) + mi / 60) * 30, ma = mi * 6;
  const ROMAN = ["XII", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"];
  let ticks = "";
  for (let i = 0; i < 60; i++) {
    const big = i % 5 === 0;
    ticks += `<line x1="${cx}" y1="${cy - R + 7}" x2="${cx}" y2="${cy - R + (big ? 11 : 9)}" stroke="${L.ticks}" stroke-width="${big ? 1.4 : .6}" transform="rotate(${i * 6} ${cx} ${cy})"/>`;
  }
  const nums = ROMAN.map((r, i) => {
    if (i === 6) return "";                                  // the small-seconds dial sits there
    const t = (i * 30 - 90) * Math.PI / 180, rr = R - 19.5;
    return `<text x="${(cx + rr * Math.cos(t)).toFixed(1)}" y="${(cy + rr * Math.sin(t) + 2.3).toFixed(1)}" text-anchor="middle" font-size="${r.length > 3 ? 5.4 : 6.4}">${r}</text>`;
  }).join("");
  // Breguet hand: a slim taper with an open ring a little before the tip
  const hand = (len, ring, w, ang) => `<g transform="rotate(${ang.toFixed(1)} ${cx} ${cy})">
      <path d="M${cx - w} ${cy + 5} L${cx} ${cy - len} L${cx + w} ${cy + 5} Z" fill="${L.hands}"/>
      <circle cx="${cx}" cy="${cy - ring}" r="${(w * 1.6).toFixed(1)}" fill="${L.face}" stroke="${L.hands}" stroke-width="1"/></g>`;
  const links = [[51, 21, -35], [45, 26, -50], [40, 32, -65], [37, 39, -80], [36, 47, -95]]
    .map(([x, y, r]) => `<ellipse cx="${x}" cy="${y}" rx="3.6" ry="2.2" transform="rotate(${r} ${x} ${y})"/>`).join("");
  return `<svg viewBox="0 0 120 132" role="img" aria-label="${escAttr(p ? `Time ${clock}` : "Time unknown")}">
    <defs>${L.metal
      // polished silver: banded light and dark like a reflection, a bevel that runs the other way, and a soft highlight
      ? `<linearGradient id="rpg-pw-case-${look}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbfcfe"/><stop offset=".18" stop-color="#c3c6cf"/>
          <stop offset=".38" stop-color="#6c6f7a"/><stop offset=".52" stop-color="#e3e5ea"/><stop offset=".7" stop-color="#9a9da8"/>
          <stop offset=".86" stop-color="#5d606a"/><stop offset="1" stop-color="#d4d6dd"/></linearGradient>
        <linearGradient id="rpg-pw-bezel-${look}" x1="1" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#f4f5f8"/><stop offset=".3" stop-color="#8d909b"/>
          <stop offset=".55" stop-color="#e9ebef"/><stop offset=".8" stop-color="#6a6d77"/><stop offset="1" stop-color="#c7cad2"/></linearGradient>
        <radialGradient id="rpg-pw-shine-${look}" cx=".3" cy=".22" r=".6"><stop offset="0" stop-color="#fff" stop-opacity=".85"/>
          <stop offset=".35" stop-color="#fff" stop-opacity=".18"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`
      : `<linearGradient id="rpg-pw-case-${look}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${L.caseA}"/><stop offset="1" stop-color="${L.caseB}"/></linearGradient>`}</defs>
    <g fill="none" stroke="${L.chain}" stroke-width="1.3" opacity=".9">${links}</g>
    <ellipse cx="${cx}" cy="17" rx="10" ry="8" fill="none" stroke="url(#rpg-pw-case-${look})" stroke-width="3.2"/>
    <ellipse cx="${cx}" cy="17" rx="10" ry="8" fill="none" stroke="${L.edge}" stroke-width=".6"/>
    <rect x="${cx - 4}" y="22" width="8" height="5" rx="1" fill="url(#rpg-pw-case-${look})" stroke="${L.edge}" stroke-width=".7"/>
    <rect x="${cx - 6.5}" y="26.5" width="13" height="6" rx="2" fill="url(#rpg-pw-case-${look})" stroke="${L.edge}" stroke-width=".7"/>
    <path d="M${cx - 4} 27.5v4M${cx - 1.3} 27.5v4M${cx + 1.3} 27.5v4M${cx + 4} 27.5v4" stroke="${L.edge}" stroke-width=".5"/>
    <circle cx="${cx}" cy="${cy}" r="${R + 3}" fill="url(#rpg-pw-case-${look})" stroke="${L.edge}" stroke-width="1"/>
    ${L.metal ? `<circle cx="${cx}" cy="${cy}" r="${R + 2.5}" fill="url(#rpg-pw-shine-${look})"/>
    <circle cx="${cx}" cy="${cy}" r="${R - .2}" fill="none" stroke="url(#rpg-pw-bezel-${look})" stroke-width="2.6"/>
    <circle cx="${cx}" cy="${cy}" r="${R - 1.6}" fill="none" stroke="${L.edge}" stroke-width=".6" opacity=".7"/>
    <ellipse cx="${cx}" cy="17" rx="10" ry="8" fill="none" stroke="#fff" stroke-width=".7" opacity=".55" stroke-dasharray="9 54" stroke-dashoffset="-34"/>`
      : `<circle cx="${cx}" cy="${cy}" r="${R - .5}" fill="none" stroke="${L.rim}" stroke-width="1.2" opacity=".8"/>`}
    <circle cx="${cx}" cy="${cy}" r="${R - 2.5}" fill="${L.face}" stroke="${L.faceEdge}" stroke-width=".8"/>
    ${ticks}
    <g fill="${L.nums}" font-family="'Times New Roman',Georgia,serif">${nums}</g>
    <circle cx="${cx}" cy="${cy + 19}" r="7.5" fill="none" stroke="${L.sub}" stroke-width=".8"/>
    ${p ? `<line x1="${cx}" y1="${cy + 19}" x2="${cx}" y2="${cy + 13}" stroke="${L.sub}" stroke-width=".9" transform="rotate(${(mi * 37) % 360} ${cx} ${cy + 19})"/>` : ""}
    ${p ? `<text x="${cx}" y="${cy - 8.5}" text-anchor="middle" font-size="5.2" letter-spacing=".5" fill="${L.ampm}" font-family="inherit">${h >= 12 ? "PM" : "AM"}</text>` : `<text x="${cx}" y="${cy - 10}" text-anchor="middle" font-size="9" fill="${L.ampm}">?</text>`}
    ${p ? hand(17, 11, 1.8, ha) + hand(34, 28, 1.3, ma) : ""}
    <circle cx="${cx}" cy="${cy}" r="2.6" fill="${L.hands}"/>
    ${L.metal ? `<path d="M${cx - R + 6} ${cy - 2} A${R - 5} ${R - 5} 0 0 1 ${cx + 2} ${cy - R + 5} A${R - 1} ${R - 1} 0 0 0 ${cx - R + 6} ${cy - 2} Z" fill="#fff" opacity=".22"/>` : ""}
  </svg>`;
}

function sysBar(icon, label, curr, max, extra = {}) {
  const iconHtml = extra.editMeters
    ? `<button class="sys-ibtn" data-meter-edit title="Edit meters" aria-label="Edit meters">${sysIcon(icon)}</button>`
    : sysIcon(icon);
  const maxNum = safeParseFloatOrInf(max, 0);
  if (extra.skipEmpty && Number.isFinite(maxNum) && maxNum <= 0) return "";
  const pct = extra.pct ?? percentFrom(curr, max);
  const cls = (extra.tint ? "tint" : (extra.lowWarn && pct <= 25 ? "low" : "")) + (extra.cls ? " " + extra.cls : "");
  return `<div class="sys-bar">
      <div class="sys-bar-lab">${iconHtml}<span>${escHtml(label)}</span>
        <span class="sys-bar-num">${extra.numHtml ?? `${renderInlineValue(curr)} / ${renderInlineValue(max)}`}</span></div>
      <div class="sys-cap ${cls}"${extra.tint ? ` style="--mc:${escAttr(extra.tint)}"` : ""}><i style="width:${pct}%"></i></div>
    </div>`;
}

function sysTopHtml({ root, display, type, isVehicle, latest, latestTitle, hpLabel, coin, time, meterEditorHtml = "" }) {
  const kind = isVehicle ? "VEHICLE" : ({ player: "PLAYER", party: "PARTY", npc: "NPC", enemy: "ENEMY" }[type] || "");
  const name = isVehicle ? displayName(display.name, "Vehicle")
    : type === "player" ? playerDisplayName() : displayName(display.name, "Unit");
  const pick = (inner) => `<span class="sys-pick">${inner}<span class="sys-caret">▾</span>` +
    `<select id="rpg-char-select" title="Switch character">${getCharOptions().replace(/>\s*\p{Extended_Pictographic}\uFE0F?\s*/gu, ">")}</select></span>`;
  const clockMode = ["clock", "hatclock", "hatclock2", "pocketwatch"].includes(uiSettings.sysBigSlot);
  const pocketWatch = uiSettings.sysBigSlot === "pocketwatch";
  const hatClock = uiSettings.sysBigSlot === "hatclock" || uiSettings.sysBigSlot === "hatclock2";
  const hatLook = uiSettings.sysBigSlot === "hatclock2" ? (isFogSkin() ? "fog" : "system") : "storybook";

  const wd = worldWeekday(time);
  const dateText = `${wd ? wd + ", " : ""}${time.month ?? "???"} ${time.day ?? ""}${time.year ? ", " + time.year : ""}`;
  const effects = (Array.isArray(display.status_effects) ? display.status_effects : [])
    .map((x) => String(x).trim()).filter((x) => x && !BLK_NO_STATUS.test(x));
  const rows = [];
  if (clockMode) rows.push(["NAME", pick(escHtml(name)), ""]);
  rows.push(["LOCATION", escHtml(rpgState.location || "Unknown"), ""]);
  rows.push(["TIME", `${escHtml(dateText)} \u00B7 ${escHtml(time.clock ? showClock(time.clock) : "??:??")}`, ""]);
  if (time.weather && !/^unknown$/i.test(String(time.weather))) rows.push(["WEATHER", escHtml(time.weather), ""]);
  if (rpgState?.combat?.active) rows.push(["COMBAT", `Round ${escHtml(rpgState.combat.round ?? 1)}`, "bad"]);
  rows.push(["CONDITION", effects.length ? effects.map(escHtml).join(", ") : "Healthy", effects.length ? "bad" : "ok"]);
  const info = `<div class="sys-info">${rows.map(([k, v, c]) => `<span class="k">${k}:</span><span class="v ${c}">${v}</span>`).join("")}</div>`;

  const size = name.length > 18 ? " s" : name.length > 11 ? " m" : "";
  const hero = clockMode
    ? `<div class="sys-hero clock"><div class="sys-clock${hatClock ? ` hat ${hatLook}` : pocketWatch ? " hat pocket" : ""}">${pocketWatch ? sysPocketWatchSvg(time.clock, isFogSkin() ? "fog" : "system")
      : hatClock ? sysHatClockSvg(time.clock, hatLook) : sysClockSvg(time.clock)}</div>${info}</div>`
    : `<div class="sys-hero name"><div class="sys-big${size}">${pick(escHtml(name))}</div><div class="sys-rule"></div>${info}</div>`;

  // bars: HP, MP/EN, bond for party and NPCs, then any meters
  const { curr: eCurr, max: eMax, label: eLabel } = getEnergy(display, isVehicle);
  let bars = sysBar("hp", hpLabel, display.hp_curr, display.hp_max, { lowWarn: true })
    + sysBar("mp", isFogSkin() && eLabel === "MP" ? "SPIRITUALITY" : eLabel, eCurr, eMax, { skipEmpty: true, cls: "mp" });
  if ((type === "party" || type === "npc") && !isVehicle) {
    const bond = clamp(parseBondValue(root.bond), Number.NEGATIVE_INFINITY, 101);
    bars += sysBar("bond", "BOND", 0, 0, {
      pct: bond >= 101 ? 100 : clamp(Math.abs(bond), 0, 100),
      numHtml: `${bond >= 101 ? "∞" : escHtml(bond)} / 100`,
      tint: bond < 0 ? "#ff6b6b" : "#f48fb1",
    });
  }
  (Array.isArray(display.meters) ? display.meters : []).forEach((mt) => {
    if (!mt || typeof mt !== "object") return;
    const nm = mt.name ?? mt.label ?? "Meter";
    bars += sysBar("meter", String(nm).toUpperCase(), mt.curr ?? mt.value ?? 0, mt.max ?? 100,
      { skipEmpty: true, tint: meterColorByName(nm), editMeters: true });
  });
  if (!(Array.isArray(display.meters) && display.meters.length) && !meterEditorHtml) {
    bars += `<div class="sys-addmeter-row"><button class="sys-addmeter" data-meter-edit data-meter-add title="Add a meter">+ METER</button></div>`;
  }

  const stat = (icon, label, raw) => {
    const has = raw !== undefined && raw !== null && String(raw).trim() !== "";
    return `<div class="sys-stat">${sysIcon(icon)}<span>${label}</span><b>${has ? renderInlineValue(raw) : "—"}</b></div>`;
  };
  const st = display.stats || {};
  const hasStats = ["atk", "def", "matk", "sdef", "satk"].some((k) => st[k] !== undefined && st[k] !== null && String(st[k]).trim() !== "");
  const stats = !hasStats && !toNumberOr(coin, 0) ? "" : stat("atk", "ATK", st.atk) + stat("def", "DEF", st.def)
    + stat("matk", "MATK", st.matk) + stat("sdef", "SDEF", st.sdef)
    + stat("satk", "SATK", st.satk) + stat("coin", "COIN", coin);

  return `
    <div class="sys-head">
      <span class="sys-kind">${kind}</span>
      <div class="sys-plate">STATUS</div>
      <div class="sys-ctl">
        <span id="rpg-latest-indicator" style="cursor:pointer; user-select:none;">${isFogSkin() ? fogStatusStarHtml(latest.status, latestTitle) : renderIndicatorDotHtml(latest.status, latestTitle)}</span>
        <button id="rpg-min-btn" title="Minimize" style="cursor:pointer; font-size:12px; padding:0; font-weight:bold; line-height:18px; box-sizing:border-box;">_</button>
      </div>
    </div>
    ${isFogSkin() ? fogNumberHtml(display, time) : ""}
    ${hero}
    <div class="sys-panels">
      <div class="sys-box">${bars}</div>
      ${stats ? `<div class="sys-box sys-stats">${stats}</div>` : ""}
    </div>
    ${meterEditorHtml ? `<div class="sys-box sys-medit"><div class="sys-sec">METERS</div>${meterEditorHtml}</div>` : ""}`;
}

// Party, NPC and enemy rows in the same capsule bars as the status window.
function sysUnitList(list, { title, jumpType, emptyText = "", foe = false, hpOnly = false }) {
  const head = `<div class="sys-sec${foe ? " foe" : ""}">${escHtml(title)}</div>`;
  if (!Array.isArray(list) || !list.length) {
    return emptyText ? `<div class="sys-units">${head}<div style="opacity:.5; font-style:italic;">${escHtml(emptyText)}</div></div>` : "";
  }
  const mini = (label, curr, max, cls) => {
    const maxNum = safeParseFloatOrInf(max, 0);
    if (Number.isFinite(maxNum) && maxNum <= 0) return "";
    const pct = percentFrom(curr, max);
    const low = cls !== "foe" && cls !== "mp" && pct <= 25 ? " low" : "";
    return `<div class="sys-mini"><span class="l">${escHtml(label)}</span>
      <div class="sys-cap sm ${cls}${low}"><i style="width:${pct}%"></i></div>
      <span class="n">${escHtml(splitMathValue(String(curr ?? 0)).val)}/${escHtml(splitMathValue(String(max ?? 0)).val)}</span></div>`;
  };
  const rows = list.map((unit, idx) => {
    const isVeh = !!(unit?.vehicle && unit.vehicle.active);
    const t = isVeh ? unit.vehicle : unit;
    const name = escHtml(displayName(t?.name || unit?.name, "Unit"));
    const { curr: eC, max: eM, label: eL } = getEnergy(t, isVeh);
    const bond = !foe && unit?.bond !== undefined && unit.bond !== "" ? parseBondValue(unit.bond) : null;
    return `<div class="sys-unit">
      <div class="sys-unit-head"><span class="rpg-jump" data-idx="${charIndexFor(jumpType, idx)}">${isVeh ? "\u25C6 " : ""}${name}</span>
        ${bond !== null ? `<span class="sys-unit-tag">${sysIcon("bond")}${bond >= 101 ? "\u221E" : escHtml(bond)}</span>` : ""}</div>
      ${mini(isVeh ? "HULL" : "HP", t?.hp_curr, t?.hp_max, foe ? "foe" : "")}
      ${hpOnly ? "" : mini(isFogSkin() && eL === "MP" ? "SPI" : eL, eC, eM, "mp")}
    </div>`;
  }).join("");
  return `<div class="sys-units">${head}${rows}</div>`;
}

// ---- settings (inside the classic settings overlay, when this skin is on) ----
function sysSettingsHtml() {
  const sel = "width:100%; background:var(--t-0d1a2c, #0d1a2c); border:1px solid var(--t-3d6a94, #3d6a94); color:var(--t-dff1ff, #dff1ff); padding:6px; margin-bottom:8px;";
  const lab = "font-size:0.75em; color:var(--t-9fc6e6, #9fc6e6); margin-bottom:4px;";
  const opt = (v, t, cur) => `<option value="${v}"${cur === v ? " selected" : ""}>${t}</option>`;
  const big = ["clock", "hatclock", "hatclock2", "pocketwatch"].includes(uiSettings.sysBigSlot) ? uiSettings.sysBigSlot : "name";
  const font = uiSettings.sysFont || "exo";
  return `
    <div style="margin:0 0 10px; padding:8px; border:1px solid rgba(var(--t-143_208_255, 143,208,255),0.35); background:rgba(var(--t-90_170_255, 90,170,255),0.06);">
      <div style="${lab}">Big slot</div>
      <select id="rpg-sys-bigslot" style="${sel}">${opt("name", "Name", big)}${opt("clock", "Clock (in-world time)", big)}${opt("pocketwatch", "Pocket watch", big)}${opt("hatclock", "Clock: Roman, top hat", big)}${opt("hatclock2", isFogSkin() ? "Clock: Roman, top hat (Gray Fog colours)" : "Clock: Roman, top hat (System colours)", big)}</select>
      ${isFogSkin() ? "" : `<div style="${lab}">Font</div>`}
      <select id="rpg-sys-font" style="${sel}${isFogSkin() ? " display:none;" : ""}">${opt("exo", "Exo 2", font)}${opt("squarish", "Squarish (Rajdhani)", font)}${opt("saira", "Saira Condensed", font)}${opt("teko", "Teko", font)}${opt("sans", "Sans", font)}${opt("preset", "Follow preset", font)}</select>
      ${isFogSkin() ? `<div style="${lab}">Tarot number</div>
      <select id="rpg-fog-number" style="${sel}">${opt("auto", "Sequence if tracked, else the day", uiSettings.fogNumber || "auto")}${opt("day", "Day of the month", uiSettings.fogNumber || "auto")}${opt("sequence", "Sequence only", uiSettings.fogNumber || "auto")}${opt("none", "None", uiSettings.fogNumber || "auto")}</select>
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px;">
        <span title="The panel folds into the round button when you minimize it, and unfolds when you open it">Fold animation</span>
        <input type="checkbox" id="rpg-fog-fold-cb" ${uiSettings.fogFold !== false ? "checked" : ""} style="cursor:pointer; width:18px; height:18px;">
      </div>
      <div style="${lab}${uiSettings.fogFold === false ? " opacity:.45;" : ""}">Fold speed</div>
      <select id="rpg-fog-fold-speed" style="${sel}${uiSettings.fogFold === false ? " opacity:.45;" : ""}" ${uiSettings.fogFold === false ? "disabled" : ""}>${["slow", "normal", "fast", "instant"].map((v) => opt(v, { slow: "Slow", normal: "Normal", fast: "Fast", instant: "Very fast" }[v], FOG_FOLD_SPEEDS[uiSettings.fogFoldSpeed] ? uiSettings.fogFoldSpeed : "normal")).join("")}</select>` : ""}
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px;">
        <span title="A System popup when a reply gives you items, skills or passives, adds quests, timers or party members, or starts a fight">Notifications</span>
        <input type="checkbox" id="rpg-sys-notices-cb" ${uiSettings.sysNotices !== false ? "checked" : ""} style="cursor:pointer; width:18px; height:18px;">
      </div>
      <button id="rpg-sys-testnote" style="width:100%; background:var(--t-0d1a2c, #0d1a2c); border:1px solid var(--t-3d6a94, #3d6a94); color:var(--t-dff1ff, #dff1ff); padding:6px; cursor:pointer; margin-bottom:8px;">Show a test notification</button>
      <button id="rpg-sys-emblem-open" style="width:100%; background:var(--t-0d1a2c, #0d1a2c); border:1px solid var(--t-3d6a94, #3d6a94); color:var(--t-dff1ff, #dff1ff); padding:6px; cursor:pointer;">Background images\u2026</button>
    </div>`;
}

function sysBindSettings() {
  const stop = (el) => { if (el) el.onclick = (e) => e.stopPropagation(); };
  const big = document.getElementById("rpg-sys-bigslot");
  if (big) { stop(big); big.onchange = () => { uiSettings.sysBigSlot = big.value; saveUiSettings(); renderRPG(); }; }
  const font = document.getElementById("rpg-sys-font");
  if (font) { stop(font); font.onchange = () => { uiSettings.sysFont = font.value; saveUiSettings(); renderRPG(); }; }
  const fn = document.getElementById("rpg-fog-number");
  if (fn) { stop(fn); fn.onchange = () => { uiSettings.fogNumber = fn.value; saveUiSettings(); renderRPG(); }; }
  const fc = document.getElementById("rpg-fog-fold-cb");
  if (fc) { stop(fc); fc.onchange = () => { uiSettings.fogFold = fc.checked; saveUiSettings(); renderRPG(); }; }
  const fs = document.getElementById("rpg-fog-fold-speed");
  if (fs) { stop(fs); fs.onchange = () => { uiSettings.fogFoldSpeed = fs.value; saveUiSettings(); }; }
  const nt = document.getElementById("rpg-sys-notices-cb");
  if (nt) { stop(nt); nt.onchange = () => { uiSettings.sysNotices = nt.checked; saveUiSettings(); }; }
  const emb = document.getElementById("rpg-sys-emblem-open");
  if (emb) emb.onclick = (e) => { e.stopPropagation(); isSettingsOpen = false; emblemEditOpen = true; renderRPG(); };
  const test = document.getElementById("rpg-sys-testnote");
  if (test) test.onclick = (e) => {
    e.stopPropagation();
    sysShowNotices([
      { plate: "NOTIFICATION", html: "You have acquired <b>[Health Potion]</b>." },
      { plate: "NOTIFICATION", html: "You have learned the skill <b>[Shadow Step]</b>." },
      { plate: "QUEST INFO", html: "A new quest has been registered:<br><b>Find the missing scout</b>" },
    ]);
  };
}

// ---- notifications ----
// What a reply changed, phrased the way a System window would put it. Player
// lists only (a party member's new item isn't yours), plus the party, foes,
// quests, timers, coin and combat.
function sysNoticesFor(a, b) {
  const out = [];
  const nm = (t) => `<b>[${escHtml(tItemName(t))}]</b>`;
  const join = (arr) => arr.length === 1 ? arr[0]
    : arr.length === 2 ? `${arr[0]} and ${arr[1]}`
    : `${arr.slice(0, 2).join(", ")} and ${arr.length - 2} more`;
  const trunc = (t, n = 90) => { t = String(t).trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
  const keyOf = (u) => normBondName(u?.name);

  {
    const had = new Set((a.enemies || []).map(keyOf));
    const fresh = (b.enemies || []).filter((u) => !had.has(keyOf(u))).map((u) => `<b>${escHtml(displayName(u.name, "?"))}</b>`);
    const parts = [];
    if (!a.combat?.active && b.combat?.active) parts.push("Combat has begun.");
    if (fresh.length) parts.push(fresh.length === 1 ? `Hostile detected: ${fresh[0]}.` : `${fresh.length} hostiles detected: ${join(fresh)}.`);
    if (parts.length) out.push({ plate: "WARNING", warn: true, html: parts.join("<br>") });
  }

  const added = (key) => {
    const A = tListMap(a[key]), B = tListMap(b[key]);
    const list = [];
    B.forEach((text, k) => { if (!A.has(k)) list.push(nm(text)); });
    return list;
  };
  const items = added("inventory");
  if (items.length) out.push({ plate: "NOTIFICATION", html: `You have acquired ${join(items)}.` });
  const skills = added("skills");
  if (skills.length) out.push({ plate: "NOTIFICATION",
    html: skills.length === 1 ? `You have learned the skill ${skills[0]}.` : `You have learned new skills: ${join(skills)}.` });
  const passives = added("passives");
  if (passives.length) out.push({ plate: "NOTIFICATION",
    html: passives.length === 1 ? `You have gained the passive ${passives[0]}.` : `You have gained new passives: ${join(passives)}.` });
  const masteries = added("masteries");
  if (masteries.length) out.push({ plate: "NOTIFICATION", html: `New mastery: ${join(masteries)}.` });

  const c0 = tNum(a.dankcoin), c1 = tNum(b.dankcoin);
  if (c0 !== null && c1 !== null && c1 > c0) out.push({ plate: "NOTIFICATION", html: `You have obtained <b>${escHtml(c1 - c0)}</b> coin.` });

  {
    const real = (list) => (list || []).map((x) => String(x).trim()).filter((x) => x && !BLK_NO_STATUS.test(x));
    const had = new Set(real(a.status_effects));
    const fresh = real(b.status_effects).filter((x) => !had.has(x)).map((x) => `<b>[${escHtml(x)}]</b>`);
    if (fresh.length) out.push({ plate: "NOTIFICATION", html: `You are now affected by ${join(fresh)}.` });
  }

  {
    const had = new Set((a.party || []).map(keyOf));
    (b.party || []).filter((u) => !had.has(keyOf(u))).forEach((u) =>
      out.push({ plate: "NOTIFICATION", html: `<b>${escHtml(displayName(u.name, "?"))}</b> has joined your party.` }));
  }

  {
    const qa = new Set((a.quests || []).map((q) => String(q).trim()));
    const qb = new Set((b.quests || []).map((q) => String(q).trim()));
    qb.forEach((q) => { if (q && !qa.has(q)) out.push({ plate: "QUEST INFO", html: `A new quest has been registered:<br><b>${escHtml(trunc(q))}</b>` }); });
    qa.forEach((q) => { if (q && !qb.has(q)) out.push({ plate: "QUEST INFO", html: `Quest closed:<br><b>${escHtml(trunc(q))}</b>` }); });
  }
  {
    const had = new Set((a.timers || []).map(tTimerKey));
    (b.timers || []).filter((t) => !had.has(tTimerKey(t))).forEach((t) =>
      out.push({ plate: "QUEST INFO", html: `Timer started: <b>${escHtml(t.name || "Timer")}</b>${t.value ? ` (${escHtml(t.value)})` : ""}` }));
  }
  // the bigger news first, so it survives the cap
  const rank = (n) => n.warn ? 0 : n.plate === "QUEST INFO" ? 2 : /coin\.$|affected by/.test(n.html) ? 3 : 1;
  return out.map((n, i) => [n, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map((x) => x[0]);
}

// Each reply (each swipe of it) announces a thing once, however many times the
// block is re-read or tidied afterwards.
const sysNoticeSeen = new Map();   // reply key -> Set of messages shown
function sysShowNotices(list, replyKey = "") {
  if (replyKey) {
    let seen = sysNoticeSeen.get(replyKey);
    if (!seen) {
      seen = new Set();
      sysNoticeSeen.set(replyKey, seen);
      if (sysNoticeSeen.size > 50) sysNoticeSeen.delete(sysNoticeSeen.keys().next().value);
    }
    list = list.filter((n) => !seen.has(n.html));
    list.forEach((n) => seen.add(n.html));
  }
  if (!list.length) return;
  sysEnsureCss();
  sysEnsureWebFont();
  let root = document.getElementById("rpg-sys-notices");
  if (!root) {
    root = document.createElement("div");
    root.id = "rpg-sys-notices";
    document.body.appendChild(root);
  }
  root.style.fontFamily = sysFontStack();
  const shown = list.slice(0, 5);
  if (list.length > 5) {
    const n = list.length - 5;
    shown.push({ plate: "NOTIFICATION", html: `And ${n} more change${n === 1 ? "" : "s"}. See the Log tab.` });
  }
  shown.forEach((n, i) => {
    setTimeout(() => {
      const el = document.createElement("div");
      el.className = "rpg-sys-note" + (n.warn ? " warn" : "") + (isFogSkin() ? " fog" : "");
      el.innerHTML = `<div class="plate">${n.plate}</div><div class="msg">${n.html}</div>`;
      const close = () => {
        if (el.dataset.out) return;
        el.dataset.out = "1";
        el.classList.add("out");
        setTimeout(() => el.remove(), 320);
      };
      el.onclick = (e) => { e.stopPropagation(); close(); };
      root.appendChild(el);
      while (root.children.length > 6) root.firstElementChild.remove();
      setTimeout(close, 5200 + i * 400);
    }, i * 260);
  });
}

// =====================================================================
// UPDATE LOG + CLASSIC HELP
// The update log is shared by both skins. When the build changes, the log
// button shows a dot until the log is opened once.
// =====================================================================
const CHANGELOG = [
  { build: "2026-10-26.30", items: [
    "New skin: Gray Fog. The System panel in a Victorian occult look: charcoal fog with a faint eight-pointed star over a broken circle and stars, a silver double frame with corner flourishes, gothic and serif lettering, one round menu button at the bottom that fans out into settings, scan, help and the log, a floating round button when minimised whose slowly turning star takes the status colour (the status dot is that star too), a fold and unfold when closing and opening (its speed is adjustable, and it can be turned off), and a tarot number under the title (the Sequence if the card tracks one, else the day). MP reads as Spirituality, and the icons lean tarot: a cup, a star, a crescent and a pentacle. Every System feature carries over, including the clocks and notifications.",
    "Big slot: a pocket watch, with a chain, a small-seconds dial and Breguet hands. Polished silver and ivory in Gray Fog, glowing in System.",
    "Background images (System and Gray Fog): stack up to six layers behind the top of the panel: the built-in star, pictures from links, or ones you upload. Each layer's size, position, angle, opacity, shape, faded edges, colour and blend are adjustable, with a live preview. Drag on the panel to place a picture, pinch or scroll to size it, twist to turn it, and fold the controls away to see the whole panel while you do.",
  ] },
  { build: "2026-10-25.3", items: [
    "The turn log now tracks stat changes: max HP and max MP, and ATK, MATK, DEF, SATK and SDEF, for you, the party, NPCs and enemies. Each can be undone or locked like any other change.",
  ] },
  { build: "2026-10-25.2", items: [
    "A character with no meters now shows a small + meter (System and classic). It opens the meter editor on a new row, so the first meter can be added without Edit state.",
  ] },
  { build: "2026-10-25.1", items: [
    "Fix: a pipe inside an item, like \u201cF-Rank Card [ 0 | 0 ]\u201d, set off a false broken-format warning. The check now reads lines the same way the parser does, so only real problems are flagged.",
  ] },
  { build: "2026-10-24.1", items: [
    "Fix: a field missing its colon (like |Timers| instead of |Timers:|) raised the broken-format warning, but the details panel came up empty. It now names the field, shows the line with the spot marked, and says how to write it.",
  ] },
  { build: "2026-10-23.6", items: [
    "System skin: two new clocks for the Big slot. \u201cClock: Roman, top hat\u201d is a pale blue storybook clock with ears, little arms and legs, fine stitching, Roman numerals around the rim, a navy bow and a black top hat. \u201cClock: Roman, top hat (System colours)\u201d is the same clock drawn in the System window's glow. Both show the in-world time like the original clock.",
  ] },
  { build: "2026-10-22.3", items: [
    "New setting, Toast seconds (default 8): how long the HUD's pop-up messages stay. 0 keeps them until tapped, the old behaviour.",
    "Fix: the HUD was making every toast permanent, SillyTavern's own included. Its toasts now set their own duration and leave SillyTavern's alone.",
    "New setting, Ignore amount changes (on by default): Change Alerts no longer fire when only an amount in a description changed, like an oxygen tank going from 4 hours to 3.5 hours, x3 to x2, or 60% to 55%. Those still show in the Log.",
  ] },
  { build: "2026-10-22.2", items: [
    "Edit meters straight from the panel: in the System skin tap a meter's icon, in classic tap its name. The editor opens for that character: rename, change values, colour, reorder, add or remove, then Save.",
  ] },
  { build: "2026-10-22.1", items: [
    "Pick your own icon for any item, skill or passive: open the list editor (tap an icon), then tap a row's icon and choose one, or Auto to go back to guessing from the name. Save keeps it.",
    "Your icon sticks to the entry's name, so it survives the AI rewording the description or changing its stats, follows a rename you make in the editor, and applies in every chat. It's stored in SillyTavern's settings, so it carries over to your other devices.",
  ] },
  { build: "2026-10-21.9", items: [
    "12-hour times now work everywhere: \u201c2:30 PM\u201d, \u201c2:30pm\u201d, \u201c2 p.m.\u201d, \u201cnoon\u201d and \u201cmidnight\u201d are understood in Time: and in timer deadlines, so countdowns, time-passed in the log and the analog clock are right. Before, PM was ignored.",
    "New setting, Clock: As written (default), 12-hour or 24-hour. It changes how times are shown in every skin, not what's in the story.",
    "Deadlines the HUD writes (editing a timer as time left) follow the Clock setting; on As written they match the story's own format.",
  ] },
  { build: "2026-10-21.8", items: [
    "System skin: the ATK icon is now a proper sword (blade, crossguard, grip and pommel) instead of something that read as an arrow.",
  ] },
  { build: "2026-10-21.7", items: [
    "System skin: Bonds and Timers use the capsule bars too. Bonds show a glowing dot for who's in the scene; timers get a line icon per kind (threat, event, debuff, buff, cooldown).",
    "System skin: emoji replaced with matching line icons: the settings gear, update log, help, the Bonds heart, the Timers stopwatch, the advance-turn button and the settings action buttons. The character picker drops its emoji too. Classic keeps its emoji.",
  ] },
  { build: "2026-10-21.6", items: [
    "System skin: the Party tab and the Hostiles list now use the same glowing capsule bars as the status window (red for hostiles), with bonds shown as a heart next to the name.",
  ] },
  { build: "2026-10-21.5", items: [
    "New skin: System window. A glowing status panel with the same tabs and editors as classic. Pick it under Skin in settings (either skin).",
    "System settings: Big slot shows your name or an analog clock of the in-world time; Font; and Notifications, which pop up a System window when a reply gives you items, skills, passives, coin or a status, adds quests, timers or party members, or brings in enemies.",
  ] },
  { build: "2026-10-21.4", items: [
    "Fix: at Bar sizes that make a bar a fraction of a pixel tall (like 70%), bars were drawn slightly shrunk and centred, leaving a gap after the tile. They now fill their box exactly, in every bar style.",
    "Party, NPC and enemy sections are dimmed again (build .3 had briefly undimmed them while chasing this).",
  ] },

  { build: "2026-10-21.2", items: [
    "Settings: Layout report, which measures how this device draws the bar rows, for tracking down device-only layout bugs.",
  ] },
  { build: "2026-10-21.1", items: [
    "Fix: on iPhone, ALfheim (New) bars sat detached from the tile. The tile and bars now share one row, so they can't drift apart.",
    "Fix: on narrow phone screens your own HP/MP numbers were cut off; bars now shorten to fit.",
  ] },
  { build: "2026-10-13.1", items: [
    "Timer editor: deadlines show as time left (1d 3h, 45m). Type a duration and it's saved as a deadline date for the AI. Untouched timers keep their exact date.",
  ] },
  { build: "2026-10-12.2", items: [
    "Fix: timer deadlines with a weekday in front (Mon Jan 6 1023,14:00) count down again instead of showing as raw text.",
  ] },
  { build: "2026-10-12.1", items: [
    "Add weekdays (on by default): a new reply's Time: without a weekday gets one written in.",
    "Edit state has a Weekday choice: None, Auto, or a specific day.",
    "Fix: position locks no longer stop working when alerts and the other auto-fixes are all off.",
  ] },
  { build: "2026-10-11.4", items: [
    "Classic: a ? help button and a \u{1F4DC} update log beside settings. The log is also in the SAO settings menu as What's new.",
  ] },
  { build: "2026-10-11.3", items: [
    "Quests can be edited in both skins (✎): reorder, delete, add.",
    "Item, skill and passive icons sit beside the middle of long entries instead of the top.",
  ] },
  { build: "2026-10-11.1–.2", items: [
    "Classic gets the item, skill and passive icons (squared) and the same editors as SAO: tap an icon to edit.",
    "Classic Mastery tab gets a ✎ editor, like Bonds.",
    "Classic settings: Edits Rewrite Past Replies.",
  ] },
  { build: "2026-09-26.29–.31", items: [
    "▲▼ reordering in the item/skill/passive, mastery and meter editors.",
    "Position locks: lock an entry to its place in the list; if the AI reorders it, it's put back.",
    "Same-name variants (Vorpal Strike Lv1 / Lv3) are told apart by locks, history rewriting, restore and the turn log.",
  ] },
  { build: "2026-09-26.26–.28", items: [
    "Icons for items, skills and passives in the Status orb; tap one to edit that list.",
    "Edits rewrite past replies (0–20): list edits also fix that many earlier replies.",
    "Icons pick by bracket type, then the name's last word. Accessories, phones, laptops and cameras added.",
  ] },
  { build: "2026-09-26.24–.25", items: [
    "Day of the week shown with the date everywhere.",
    "Fix weekdays: a wrong weekday written in Time: is corrected to the real calendar (tap the toast to undo).",
  ] },
  { build: "2026-09-26.20–.23", items: [
    "Restore lost descriptions: puts back a description the AI dropped entirely, for any character.",
    "Description alerts and the turn log cover party, NPCs and enemies, not just you.",
    "Turn log: lock a change so Undo last turn keeps it.",
    "The no-state toast no longer fires on page refresh.",
    "More fonts: Saira Condensed, Teko, Exo 2, or any Google Font.",
  ] },
  { build: "2026-09-26.14–.19", items: [
    "Move characters between Party, NPCs and Enemies.",
    "Edit state → Save leaves an (OOC: ...) note telling the AI what you changed.",
    "Edit a character's own Bond from their Stats tab; deleting a bond no longer scrubs live bonds.",
    "Bars with an equation in their max now fill properly; tap a number to see its breakdown.",
    "Bigger tap targets for the collapse arrows; no stray scrolling when minimised.",
  ] },
  { build: "2026-09-26.1–.13", items: [
    "ALfheim (New) bar style, with status tiles, emblem tiles and pickable tile colours.",
    "Tap through the bars to whatever is behind them.",
    "Classic: a Log tab with undo, a −1 button on charge timers, scroll position kept.",
    "Bond editor now actually writes into the message.",
    "Build stamp at the bottom of the SAO settings menu.",
  ] },
];

const SEEN_BUILD_KEY = "rpgHud:seenBuild";
function changelogUnseen() {
  try { return localStorage.getItem(SEEN_BUILD_KEY) !== HUD_BUILD; } catch { return false; }
}
function markChangelogSeen() {
  try { localStorage.setItem(SEEN_BUILD_KEY, HUD_BUILD); } catch {}
}

function changelogPanel() {
  const item = (name, text) => `<div class="rpg-sao-help-item"><dt>${name}</dt><dd>${text}</dd></div>`;
  return {
    title: "What's new",
    body: `<dl class="rpg-sao-help">` +
      CHANGELOG.map((c) => item(`Build ${escHtml(c.build)}`, c.items.map((t) => "• " + escHtml(t)).join("<br>"))).join("") +
      `</dl><p class="rpg-sao-empty">You're on build ${escHtml(HUD_BUILD)}.</p>`,
  };
}

// ---- classic: help and log as overlays, like settings ----
let classicInfo = null;   // null | "help" | "log"

const CLASSIC_HELP = [
  ["The dot", "Top right. Green: the latest reply has a valid state. Yellow: the block is broken (tap for details). Grey: no block."],
  ["Tabs", "Party, Bonds, Timers, Items, Skills, Passive, Mastery, Quest, Environment and Log. Pick a character from the name dropdown to see their tabs."],
  ["Editing lists", "In Items, Skills and Passive, tap any icon to edit that list: change text, ✕ to delete, ▲▼ to reorder, + Add. Mastery and Quest have a ✎ button instead."],
  ["Meters", "Tap a meter's name (in the System skin, its icon) to edit that character's meters, or + meter when they have none: rename, change values, pick a colour (↺ goes back to automatic), reorder, add or remove. Save writes them to the latest reply."],
  ["Your own icons", "In the list editor, tap a row's icon to pick a different one (Auto goes back to guessing from the name), then Save. It sticks to that name in every chat and on your other devices; a blue dot marks it in the editor."],
  ["Position locks", "In the item, skill and passive editor, the padlock under ✕ pins an entry to its place. If the AI reorders the list, locked entries are put back; the rest keep their order."],
  ["Edits Rewrite Past Replies", "Settings. List edits also fix this many earlier replies, so the AI can't copy the old version back from history. 0 means the latest reply only."],
  ["Bonds", "✎ to edit, + to add. Deleting asks whether to also remove the name from earlier Bonds lists; characters' own Bond values are left alone."],
  ["Timers", "Turns (2/3), deadlines (Jan 6 1023,14:00) or uses (2/2x). Charge timers have a −1 button to spend one."],
  ["Log", "What changed each turn. Undo last turn reverts the newest turn; ↶ reverts a single change; the padlock keeps a change through Undo last turn. Redo puts it back."],
  ["Edit state", "Settings → ✏️ Edit: edit everything about the selected character. With Note Edits for AI on, saving leaves an (OOC: ...) line telling the AI what you changed."],
  ["Move", "Settings: move the selected character between Party, NPCs and Enemies."],
  ["Toast Seconds", "Settings. How long the HUD's pop-up messages stay before fading, in seconds. 0 keeps them until you tap them."],
  ["Ignore Amount Changes", "Settings (on by default). Change Alerts stay quiet when only an amount in a description changed, like an oxygen tank going from 4 hours to 3.5, x3 to x2, or 60% to 55%. Those still show in the Log."],
  ["Change Alerts", "A toast when an item, skill or passive's description changes or loses detail, for anyone."],
  ["Restore Lost Descriptions", "If the AI drops a description entirely, the old one is put back onto the new entry. Tap the toast to undo."],
  ["Add Weekdays", "If a new reply's Time: has no weekday, one is written in. Tap the toast to undo. Edit state also has a Weekday choice: Auto, a specific day, or None."],
  ["Fix Weekdays", "If the AI writes a weekday in Time: that doesn't match the date, it's corrected. Tap the toast to undo."],
  ["Scan (↻)", "Re-reads the latest reply and writes the state back into it."],
];

const SYS_HELP = [
  ["Background images", "Settings → Background images…: stack up to six layers behind the top of the panel: the built-in star, pictures from links, or ones you upload. Pick a layer to adjust its size, position, angle, opacity, shape, faded edges, colour and blend, live; Lower and Raise change the stacking. Each skin keeps its own. Uploads stay on that device; a link works anywhere you paste it."],
  ["Gray Fog", "A second look for this panel: charcoal fog, a silver frame, gothic lettering, silver and violet bars. Pick it under Skin; everything works the same as in System."],
  ["System window", "The panel shows the selected character. Tap the big name (or NAME, with the clock) to switch character. The frame turns red for enemies and purple for vehicles."],
  ["Big slot", "Settings → Big slot: the character's name, or an analog clock of the in-world time: the glowing one, a pocket watch, or a storybook clock with Roman numerals, a bow and a little top hat, in its own pale blue or in the System window's glow."],
  ["Notifications", "Settings → Notifications: a System popup when a reply gives you items, skills, passives, coin or a status, adds quests, timers or party members, or brings in enemies. Tap one to dismiss it. Your own edits never trigger them."],
];

function classicInfoHtml() {
  if (!classicInfo) return "";
  const isLog = classicInfo === "log";
  const rows = isLog
    ? CHANGELOG.map((c) => `<div style="margin-bottom:10px;"><div style="color:#FFD700; font-weight:bold; margin-bottom:3px;">Build ${escHtml(c.build)}</div>` +
        c.items.map((t) => `<div style="color:#ccc; padding-left:10px; text-indent:-10px; margin-bottom:2px;">• ${escHtml(t)}</div>`).join("") + `</div>`).join("")
      + `<div style="opacity:.6; font-style:italic;">You're on build ${escHtml(HUD_BUILD)}.</div>`
    : (isSysSkin() ? [...SYS_HELP, ...CLASSIC_HELP] : CLASSIC_HELP).map(([k, v]) => `<div style="margin-bottom:9px;"><div style="color:#4FC3F7; font-weight:bold;">${escHtml(k)}</div><div style="color:#ccc;">${escHtml(v)}</div></div>`).join("");
  return `
    <div id="rpg-info-overlay" style="position:absolute; inset:0; background:#0b0b0d; border:1px solid #333; z-index:100001;
      display:flex; flex-direction:column; box-sizing:border-box; padding:10px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px solid #333; padding-bottom:6px;">
        <div style="font-weight:bold; color:#ddd;">${isSysSkin() ? sysIcon(isLog ? "log" : "help") + (isLog ? " UPDATE LOG" : " HELP") : isLog ? "\u{1F4DC} UPDATE LOG" : "❓ HELP"}</div>
        <button id="rpg-info-close" style="background:#444; border:1px solid #777; color:#fff; cursor:pointer; font-size:10px; padding:3px 10px; font-weight:bold;">CLOSE</button>
      </div>
      <div data-scroll-key="c:info:${classicInfo}" style="flex:1; overflow:auto; font-size:0.8em; line-height:1.4; padding-right:4px;">${rows}</div>
    </div>`;
}

function classicBindInfo() {
  const one = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = (e) => { e.stopPropagation(); fn(); }; };
  one("rpg-help-btn", () => { classicInfo = classicInfo === "help" ? null : "help"; isSettingsOpen = false; renderRPG(); });
  one("rpg-log-btn", () => { classicInfo = classicInfo === "log" ? null : "log"; isSettingsOpen = false; markChangelogSeen(); renderRPG(); });
  one("rpg-info-close", () => { classicInfo = null; renderRPG(); });
}

function classicLogHtml() {
  let chat = [], ctx = null;
  try { ctx = SillyTavern.getContext(); chat = ctx?.chat || []; } catch {}
  const turns = buildTurnLog(chat);
  const redo = saoCanRedo(ctx);
  const btn = "padding:1px 7px; font-size:0.9em; cursor:pointer; background:#333; color:#ddd; border:1px solid #666; border-radius:2px;";
  const tools = (turns.length || redo)
    ? `<div style="display:flex; gap:5px; justify-content:flex-end; margin-bottom:5px;">
        ${turns.length ? `<button id="rpg-c-undo" style="${btn}" title="Revert everything the latest turn changed, except what you've locked">\u21B6 Undo last turn${(() => { const n = lockedChanges(ctx).length; return n ? ` \u00B7 keep ${n}` : ""; })()}</button>` : ""}
        ${redo ? `<button id="rpg-c-redo" style="${btn}">\u21B7 Redo</button>` : ""}
      </div>`
    : "";
  if (!turns.length) {
    return tools + `<div style="opacity:0.5; font-style:italic;">Nothing yet. Each reply that carries an rpg_state adds a turn here.</div>`;
  }

  const dot = { good: "#66bb6a", bad: "#ef5350", neutral: "#888" };
  const locks = newestTurnLocks(ctx).set;
  const html = turns.slice(0, saoLogShown).map((t, ti) => `
    <div style="padding:4px 0 5px; border-bottom:1px solid #333;">
      <div class="rpg-c-turnhead" data-mes="${t.idx}" title="Jump to this message"
           style="display:flex; justify-content:space-between; gap:8px; cursor:pointer; margin-bottom:2px;">
        <b>Turn ${t.n}</b>
        <span style="color:#999; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0;">
          ${escHtml(t.when)}${t.where ? " \u00B7 " + escHtml(t.where) : ""}</span>
      </div>
      ${t.changes.length ? t.changes.map((c, ci) => `
        <div style="display:flex; align-items:flex-start; gap:5px; padding:1px 0;">
          <span style="flex:1; min-width:0; overflow-wrap:anywhere;"><span style="color:${dot[c.tone] || dot.neutral}; font-weight:bold; margin-right:4px;">\u2022</span>${c.diff
            ? `~ ${escHtml(c.diff.label)}: <b>${escHtml(c.diff.name)}</b><br><span style="color:#aaa;">${wordDiffHtml(c.diff.before, c.diff.after, "toast")}</span>`
            : escHtml(c.text)}</span>
          ${ti === 0 && c.u
            ? `<button class="rpg-c-lock" data-lid="${escAttr(lockId(c.u))}" title="${locks.has(lockId(c.u)) ? "Locked: kept by Undo last turn. Tap to unlock." : "Lock: keep this when undoing the whole turn"}"
                 style="flex:0 0 auto; display:grid; place-items:center; width:20px; padding:2px 0; cursor:pointer; border-radius:2px;
                        background:${locks.has(lockId(c.u)) ? "rgba(255,193,7,0.18)" : "none"}; color:${locks.has(lockId(c.u)) ? "#ffc107" : "#888"};
                        border:1px solid ${locks.has(lockId(c.u)) ? "#ffc107" : "#555"};">${locks.has(lockId(c.u)) ? LOCK_ICON.on : LOCK_ICON.off}</button>
               <button class="rpg-c-revert" data-ci="${ci}" data-text="${escAttr(c.text)}" title="Undo just this change"
                 style="flex:0 0 auto; padding:0 4px; font-size:0.85em; cursor:pointer; background:none; color:#aaa; border:1px solid #555; border-radius:2px;">\u21B6</button>`
            : ""}
        </div>`).join("")
        : `<div style="opacity:0.5; font-style:italic;">No changes.</div>`}
    </div>`).join("");

  const more = turns.length > saoLogShown
    ? `<button id="rpg-c-log-more" style="${btn} width:100%; margin-top:6px;">Show older (${turns.length - saoLogShown})</button>`
    : "";
  return tools + html + more;
}

function classicBindLog() {
  const one = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = (e) => { e.stopPropagation(); fn(); }; };
  one("rpg-c-undo", saoUndoLastTurn);
  one("rpg-c-redo", saoRedoLastTurn);
  one("rpg-c-log-more", () => { saoLogShown += 20; renderRPG(); });
  document.querySelectorAll(".rpg-c-lock").forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); toggleLock(el.dataset.lid); };
  });
  document.querySelectorAll(".rpg-c-revert").forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); saoUndoChange(parseInt(el.dataset.ci, 10), el.dataset.text); };
  });
  document.querySelectorAll(".rpg-c-turnhead").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const mes = document.querySelector(`#chat .mes[mesid="${el.dataset.mes}"]`);
      if (mes) mes.scrollIntoView({ behavior: "smooth", block: "center" });
      else if (window.toastr) hudToast.info("That message isn't loaded in the chat view.");
    };
  });
  document.querySelectorAll(".rpg-c-tuse").forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); spendTimerCharge(el.dataset.key); };
  });
}

const LOCK_ICON = {
  on: '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><rect x="3" y="7" width="10" height="7.5" rx="1.3" fill="currentColor"/><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  off: '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><rect x="3" y="7" width="10" height="7.5" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.4-1" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
};

function saoLogHtml() {
  let chat = [];
  try { chat = SillyTavern.getContext()?.chat || []; } catch {}
  const turns = buildTurnLog(chat);
  let ctx = null;
  try { ctx = SillyTavern.getContext(); } catch {}
  const redo = saoCanRedo(ctx);
  const tools = (turns.length || redo)
    ? `<div class="rpg-sao-logtools">
        ${turns.length ? `<button class="rpg-sao-mini" id="rpg-sao-undo" title="Revert everything the latest turn changed, except what you've locked">\u21B6 Undo last turn${(() => { const n = lockedChanges(ctx).length; return n ? ` \u00B7 keep ${n}` : ""; })()}</button>` : ""}
        ${redo ? `<button class="rpg-sao-mini" id="rpg-sao-redo">\u21B7 Redo</button>` : ""}
      </div>`
    : "";
  if (!turns.length) {
    return tools + `<p class="rpg-sao-empty">Nothing yet. Each reply that carries an rpg_state adds a turn here.</p>`;
  }

  const locks = newestTurnLocks(ctx).set;
  const html = turns.slice(0, saoLogShown).map((t, ti) => `
    <div class="rpg-sao-turn${ti === 0 ? " newest" : ""}">
      <button class="rpg-sao-turnhead" data-mes="${t.idx}" title="Jump to this message">
        <span class="n">Turn ${t.n}</span>
        <span class="w">${escHtml(t.when)}${t.where ? " \u00B7 " + escHtml(t.where) : ""}</span>
      </button>
      ${t.changes.length
        ? `<ul class="rpg-sao-changes">${t.changes.map((c, ci) => `<li class="${c.tone}${ti === 0 && c.u && locks.has(lockId(c.u)) ? " locked" : ""}">
            <span>${c.diff
              ? `~ ${escHtml(c.diff.label)}: <b>${escHtml(c.diff.name)}</b><br><span class="rpg-wd">${wordDiffHtml(c.diff.before, c.diff.after, "log")}</span>`
              : escHtml(c.text)}</span>${ti === 0 && c.u
              ? `<span class="rpg-sao-chgbtns"><button class="rpg-sao-lock${locks.has(lockId(c.u)) ? " on" : ""}" data-lid="${escAttr(lockId(c.u))}"
                   title="${locks.has(lockId(c.u)) ? "Locked: kept by Undo last turn. Tap to unlock." : "Lock: keep this when undoing the whole turn"}">${locks.has(lockId(c.u)) ? LOCK_ICON.on : LOCK_ICON.off}</button><button class="rpg-sao-revert" data-ci="${ci}" data-text="${escAttr(c.text)}" title="Undo just this change">\u21B6</button></span>`
              : ""}</li>`).join("")}</ul>`
        : `<p class="rpg-sao-empty small">No changes.</p>`}
    </div>`).join("");

  const more = turns.length > saoLogShown
    ? `<button class="rpg-sao-mini" id="rpg-sao-log-more">Show older (${turns.length - saoLogShown})</button>`
    : "";
  return tools + html + more;
}

function saoPlacePanel() {
  const t = rpgState.world_time || {};
  const env = Array.isArray(rpgState.env_effects) ? rpgState.env_effects : [];
  let h = `<div class="rpg-sao-place">${escHtml(rpgState.location || "Unknown")}</div>`;
  h += `<div class="rpg-sao-weather">${getWeatherEmoji(t.weather)} ${escHtml(t.weather || "Unknown")}
        &#183; ${escHtml(t.clock ? showClock(t.clock) : "??:??")}, ${worldWeekday(t, true) ? escHtml(worldWeekday(t, true)) + ", " : ""}${escHtml(t.month || "?")} ${escHtml(t.day ?? "?")} ${escHtml(t.year || "")}</div>`;
  h += env.length
    ? env.map((e) => `<div class="rpg-sao-env">${escHtml(e)}</div>`).join("")
    : `<p class="rpg-sao-empty">No environmental effects.</p>`;
  return { title: "Location", body: h };
}

function saoTimersHtml() {
  if (timersEditMode) return `<div class="rpg-sao-classic">${renderTimersTab()}</div>`;

  const list = Array.isArray(rpgState.timers) ? rpgState.timers : [];
  const head = `<div class="rpg-sao-timerhead"><h3>TIMERS</h3>
    <span><button class="rpg-sao-mini" id="rpg-sao-timer-turn" title="Advance one turn">&#9197;</button>
    <button class="rpg-sao-mini" id="rpg-sao-timer-edit">&#9998;</button></span></div>`;
  if (!list.length) return head + `<p class="rpg-sao-empty">No active timers.</p>`;

  const rows = list.map((t) => ({ t, info: timerInfo(t) }))
    .sort((a, b) => {
      const ka = KIND_RANK[a.info.kind] ?? 9, kb = KIND_RANK[b.info.kind] ?? 9;
      return ka !== kb ? ka - kb : a.info.sortKey - b.info.sortKey;
    })
    .map(({ t, info }) => {
      const st = timerKindStyle(info.kind);
      const dim = info.done && !TIMER_PERSISTENT_KINDS.includes(info.kind) ? " spent" : "";
      const owner = t.owner ? `<span class="rpg-sao-owner">${escHtml(displayName(t.owner))}&#183;</span>` : "";
      const mark = t.repaired ? `<span title="Auto-ticked" style="color:#a8871f;">*</span>` : "";
      const kept = t.kept ? `<span title="Carried over" style="color:#9b978c;">&#176;</span>` : "";
      const bar = info.pct === null ? "" :
        `<div class="rpg-sao-tbar"><div style="width:${info.pct}%; background:${st.color}"></div></div>`;
      return `<div class="rpg-sao-timer${dim}">
        <div class="rpg-sao-tline"><span>${st.icon}</span>
          <span class="rpg-sao-tname">${owner}${escHtml(t.name)}${mark}${kept}</span>
          <span class="rpg-sao-tleft" style="color:${st.color}">${escHtml(info.label)}</span>${
            info.mode === "charges" && !info.done
              ? `<button class="rpg-sao-tuse" data-key="${escAttr(timerKey(t))}" title="Use one charge">\u22121</button>`
              : ""}</div>
        ${bar}</div>`;
    }).join("");

  return head + rows;
}

// the classic caret/error overlay, dropped into a SAO panel
// ---- layout report: how this device actually draws the ALfheim (New) rows ----
// For layout bugs that only show on one device: measured here, copied by the
// user, so the real numbers can be compared with what the CSS intends.
let layoutReportText = "";
function measureLayoutReport() {
  const r1 = (n) => Math.round(n * 10) / 10;
  const box = (el) => { if (!el) return "missing"; const q = el.getBoundingClientRect(); return `x ${r1(q.left)} w ${r1(q.width)} | y ${r1(q.top)} h ${r1(q.height)}`; };
  const cs = (el, ...props) => { if (!el) return ""; const c = getComputedStyle(el); return props.map((k) => `${k}=${c.getPropertyValue(k)}`).join(" "); };
  const lines = [
    `build ${HUD_BUILD} | style ${uiSettings.saoBarStyle} | bar size ${uiSettings.saoUiScale ?? 100}% | font ${uiSettings.saoFont} | backing ${!!uiSettings.saoTextBacking}`,
    `screen ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x | ${navigator.userAgent}`,
  ];
  const v = document.querySelector(".rpg-sao-vitals");
  lines.push(`vitals: ${box(v)} | ${cs(v, "width", "max-width", "zoom", "transform")}`);
  [...document.querySelectorAll(".rpg-blk-row")].slice(0, 4).forEach((row, i) => {
    const name = row.querySelector(".rpg-blk-name")?.textContent || "?";
    const tile = row.querySelector(".rpg-blk-tile"), bars = row.querySelector(".rpg-blk-bars"),
          hp = row.querySelector(".rpg-sao-bar.blkhp"), line = row.querySelector(".rpg-blk-line"),
          svg = hp?.querySelector("svg"), group = row.closest(".rpg-sao-slim");
    const t = tile?.getBoundingClientRect(), h = hp?.getBoundingClientRect();
    lines.push(``, `#${i + 1} ${name}${group ? " (in a group)" : " (you)"}  GAP tile->bar = ${t && h ? r1(h.left - t.right) : "?"} (should be -3 x bar size)`);
    lines.push(`  row:   ${box(row)} | ${cs(row, "display", "--bt", "--bl", "--bb", "font-size")}`);
    lines.push(`  line:  ${box(line)} | ${cs(line, "display", "justify-content", "gap")}`);
    lines.push(`  tile:  ${box(tile)} | ${cs(tile, "width", "margin-left", "margin-right", "flex", "border-left-width")}`);
    lines.push(`  bars:  ${box(bars)} | ${cs(bars, "margin-left", "flex", "width")}`);
    lines.push(`  hp:    ${box(hp)} | ${cs(hp, "width", "margin-left")}`);
    lines.push(`  svg:   ${box(svg)}`);
    if (group) lines.push(`  group: ${box(group)} | ${cs(group, "padding-left", "margin-left", "opacity", "display")}`);
  });
  if (!document.querySelector(".rpg-blk-row")) lines.push("", "No ALfheim (New) rows on screen. Switch Bar style to ALfheim (New) and make sure a party member or NPC is showing.");
  layoutReportText = lines.join("\n");
}

function layoutReportPanel() {
  return {
    title: "Layout report",
    body: `<p class="rpg-sao-hint">Measured on this device just now. Tap Copy and paste it to Claude.</p>
      <textarea id="rpg-sao-layout-text" readonly spellcheck="false"
        style="width:100%; box-sizing:border-box; height:40svh; font:11px/1.35 ui-monospace,monospace; white-space:pre;
               color:var(--rpg-sao-ink); background:var(--rpg-sao-chip); border:1px solid var(--rpg-sao-rule)">${escHtml(layoutReportText)}</textarea>
      <div class="rpg-sao-medit-actions"><button class="rpg-sao-mini primary" id="rpg-sao-layout-copy">Copy</button></div>`,
  };
}

function saoErrorPanel() {
  return {
    title: "Parse error",
    body: `<div class="rpg-sao-classic rpg-sao-errbed">${buildPipeErrorPanelHtml()}</div>`,
  };
}

// Only the settings this skin adds. The shared ones (auto-inject, change
// alerts) behave exactly as they do in the classic panel.
function saoHelpPanel() {
  const item = (name, text) =>
    `<div class="rpg-sao-help-item"><dt>${name}</dt><dd>${text}</dd></div>`;

  return {
    title: "What these do",
    body: `<dl class="rpg-sao-help">`
      + item("Keep bars when minimised",
          "Collapsing the HUD leaves your HP and MP bars on screen. Turn it off to hide everything but the dot.")
      + item("Text shadow",
          "Adds a shadow to the text that sits straight on the chat \u2014 your name, bar labels, the clock. Helps on a pale background.")
      + item("Text backing",
          "The other way to solve the same problem: a faint card behind that text instead of a shadow. Use one or the other, or neither.")
      + item("Panel brightness",
          "Dims the panels while they stay solid. Take it below halfway and they go dark, with the text inverting to light \u2014 small light-on-dark text renders crisper than dark-on-light.")
      + item("Reset settings",
          "Puts every slider and toggle back to its default. Your skin choice and chat data stay as they are.")
      + item("Move HUD pieces",
          "Drag the bars, the orb column and the clock wherever you like. Buttons stop responding while you're arranging, so a tap can't fire by accident. Reset puts them back.")
      + item("Turn log",
          "In the Quests orb, the Log tab lists what changed each turn \u2014 HP, items, bonds, where you went, how much time passed. It's worked out from your chat history rather than stored, so it follows swipes and edits and covers old chats too. Tap a turn to jump to its message. Undo last turn reverts everything the newest turn changed; the \u21B6 beside a single change in the newest turn reverts just that one. The padlock beside a change locks it: Undo last turn then reverts everything except what's locked. Redo puts any of these back.")
      + item("Add weekdays",
          "If a new reply's Time: has no weekday, the HUD writes the short one in (\u201cSun Jan 5 1023\u201d) once the reply has finished, so the AI can see it too. Only when the month is Jan\u2013Dec and the year is written. Tap the toast to undo. You can also pick a weekday, or None, in Edit state.")
      + item("Fix weekdays",
          "If a reply writes a weekday in Time: (\u201cMon Jan 7 1023\u201d) that the real calendar disagrees with, it's corrected in the AI's own style, once the reply has finished. Only when the month is Jan\u2013Dec and the year is written. A toast says what changed; tap it to undo.")
      + item("Restore lost descriptions",
          "Works for everyone: you, party members, NPCs and enemies. When a reply keeps an item, skill or passive but drops its description entirely, the old description is put back onto the new entry, so other changes (+10 to +15 ATK, a new cost) stay. A description that was only trimmed or reworded is left alone. A toast says what was restored; tap it to undo. Masteries are never touched.")
      + item("Note edits for AI",
          "When on, saving from Edit state adds one (OOC: ...) line to the block listing exactly what you changed, and asks the AI to treat it as canon without replying to it. Several edits before the AI answers are merged into one note. Other HUD edits keep the note in place. Edits made directly in the panels don't add one.")
      + item("Toast seconds",
          "How long the HUD's pop-up messages stay before fading, in seconds. 0 keeps them until you tap them.")
      + item("Ignore amount changes",
          "On by default. Change alerts stay quiet when only an amount in a description changed, like an oxygen tank going from 4 hours to 3.5, x3 to x2, or 60% to 55%. Those still show in the turn log.")
      + item("Charges",
          "A timer written as 2/2x, 2x or \u201c2 uses\u201d counts uses instead of turns, for effects like \u201cblock the next 2 attacks\u201d. It never ticks down on its own; the AI lowers it when it's used, or tap \u22121 in the timer list.")
      + item("Meters",
          "Open a character in Status and use Edit under Meters to add, rename, change or remove them. The swatch sets a colour; \u21BA puts it back to automatic. Colours follow the meter's name, so every character's Shield matches.")
      + item("Your own icons",
          "Tap an item, skill or passive's icon to open the list editor, then tap a row's icon to pick a different one. Auto goes back to guessing from the name. After Save it sticks to that name in every chat and on your other devices; a blue dot marks it in the editor.")
      + item("Animations",
          "Bars slide to their new value, orbs unfold when you reopen the HUD, and panels fade in. Off means everything snaps.")
      + item("Bar style",
          "Aincrad is the stepped SAO bar. ALfheim swaps it for the ALO look: one plate with your name, HP over MP in an arrow-ended frame, and arrow-ended bars for party, NPCs, enemies and meters. ALfheim (New) is the later party HUD: an emblem tile, the name with status tiles beside it, and flat HP and MP bars. To pick someone's tile colour, open them in the Status orb's Stats tab. Bar backdrop only affects Aincrad.")
      + item("Text contrast",
          "How far the text sits from the panel behind it. Maximum contrast also maximises the antialiasing fringe, so backing it off makes small text look cleaner.")
      + item("Font",
          "Follows your font preset by default, which is a monospace. Sans is lighter; Squarish uses straight-stemmed letterforms closer to the reference, which need less antialiasing at small sizes.")
      + item("Editor width",
          "How wide Edit state opens. The classic skin sets this by dragging its edge; this is the same number, so you don't have to switch skins to change it.")
      + item("Bar size",
          "Scales the whole left-hand cluster \u2014 bars, names and readouts. A phone is fine at 100%; a desktop usually wants 130\u2013150%.")
      + item("Bar backdrop",
          "The wash behind your HP and MP bars. It's a pale tint, so raising it makes the card lighter; at 0 the bars float free.")
      + item("Auto-add bonds",
          "On, a character's Bond value joins the ledger by itself. Off, only bonds the model writes into |Bonds:| are kept.")
      + item("Unblock bonds",
          "Deleting a bond stops it coming back. This clears that list for this chat, so deleted names may reappear.")
      + `</dl>
      <div class="rpg-sao-help-sec">Getting around</div>
      <dl class="rpg-sao-help">`
      + item("Tap a name",
          "Any party, NPC or enemy name on the left opens that character's full sheet.")
      + item("The clock",
          "Tap it to open your timers. Editing them lives in there too.")
      + item("The dot",
          "Green: the latest block parsed. Yellow: it failed \u2014 a <b>!</b> orb appears to show why. Red: your message is last. Grey: no block found.")
      + `</dl>`,
  };
}

function saoSettingsHtml() {
  const row = (id, icon, label) =>
    `<button class="rpg-sao-mrow" id="${id}"><span class="pip">${icon}</span>${label}</button>`;
  const toggle = (id, label, on) =>
    `<div class="rpg-sao-mrow toggle"><span>${label}</span>
      <button class="rpg-sao-switch${on ? " on" : ""}" id="${id}" aria-label="${escAttr(label)}"></button></div>`;

  return row("rpg-sao-edit", "&#9998;", "Edit state")
    + row("rpg-sao-remove", "&#10007;", "Remove character")
    + row("rpg-sao-clear-npcs", "&#9634;", "Clear NPCs")
    + row("rpg-sao-clear-enemies", "&#9634;", "Clear enemies")
    + row("rpg-sao-clear-party", "&#9634;", "Clear party")
    + row("rpg-sao-rescan", "&#8635;", "Rescan now")
    + row("rpg-sao-diagnose", "!", "Parse diagnostics")
    + row("rpg-sao-help", "?", saoHelpOpen === true ? "Hide help" : "What these do")
    + row("rpg-sao-whatsnew", "\u2726", saoHelpOpen === "log" ? "Hide what's new" : `What's new${changelogUnseen() ? " \u2022" : ""}`)
    + row("rpg-sao-move", "\u2725", "Move HUD pieces")
    + row("rpg-sao-reset", "\u21BA", "Reset settings")
    + row("rpg-sao-layoutrep", "\u2316", saoHelpOpen === "layout" ? "Hide layout report" : "Layout report")
    + row("rpg-sao-insert", "&#8595;", "Insert state")
    + row("rpg-sao-remind", "&#9993;", "Remind state")
    + toggle("rpg-sao-sw-alerts", "Change alerts", !!uiSettings.changeAlerts)
    + toggle("rpg-sao-sw-ignorecounts", "Ignore amount changes", uiSettings.ignoreCountChanges !== false)
    + `<div class="rpg-sao-mrow toggle"><span title="How long the HUD's pop-up messages stay, in seconds. 0 keeps them until you tap them.">Toast seconds</span>
        <input id="rpg-sao-toastsecs" type="number" min="0" max="120" step="1" value="${Math.max(0, Math.min(120, Number(uiSettings.toastSeconds ?? 8)))}"></div>`
    + toggle("rpg-sao-sw-inject", "Auto-inject", !!autoInjectState)
    + toggle("rpg-sao-sw-ooc", "Note edits for AI", uiSettings.oocEditNotes !== false)
    + toggle("rpg-sao-sw-restore", "Restore lost descriptions", !!uiSettings.restoreLostDesc)
    + toggle("rpg-sao-sw-addwd", "Add weekdays", uiSettings.addWeekdays !== false)
    + toggle("rpg-sao-sw-weekday", "Fix weekdays", uiSettings.fixWeekdays !== false)
    + `<div class="rpg-sao-mrow toggle"><span title="How times are shown. 12- and 24-hour times in the story are both understood either way.">Clock</span>
        <select id="rpg-sao-clockfmt">${clockFormatOptions()}</select></div>`
    + `<div class="rpg-sao-mrow toggle"><span title="Editing Items, Skills or Passives from the Status orb also rewrites this many earlier replies">Edits rewrite past replies</span>
        <input id="rpg-sao-edithist" type="number" min="0" max="20" step="1" value="${Math.max(0, Math.min(20, parseInt(uiSettings.listEditHistory, 10) || 0))}"></div>`
    + toggle("rpg-sao-sw-bars", "Keep bars when minimised", !!uiSettings.barsOnMin)
    + toggle("rpg-sao-sw-shadow", "Text shadow", !!uiSettings.saoTextShadow)
    + toggle("rpg-sao-sw-backing", "Text backing", !!uiSettings.saoTextBacking)
    + toggle("rpg-sao-sw-anim", "Animations", uiSettings.saoAnimate !== false)
    + toggle("rpg-sao-sw-autobond", "Auto-add bonds", !!uiSettings.autoAddBonds)
    + (bondBlocklist.size
        ? row("rpg-sao-unblock", "&#8635;", `Unblock ${bondBlocklist.size} bond(s)`) : "")
    + `<div class="rpg-sao-mrow toggle"><span>Panel brightness</span>
        <input type="range" id="rpg-sao-panel-a" min="18" max="98"
               value="${Math.round(uiSettings.saoPanelLight ?? 92)}"></div>`
    + `<div class="rpg-sao-mrow toggle"><span>Editor width</span>
        <input type="range" id="rpg-sao-edit-w" min="240" max="560" step="10"
               value="${clamp(uiSettings.hudWidth || 280, 240, 560)}"></div>`
    + `<div class="rpg-sao-mrow toggle"><span>Text contrast</span>
        <input type="range" id="rpg-sao-ink" min="25" max="100"
               value="${Math.round(uiSettings.saoInk ?? 70)}"></div>`
    + `<div class="rpg-sao-mrow toggle"><span>Bar size</span>
        <input type="range" id="rpg-sao-ui-scale" min="70" max="300"
               value="${Math.round(uiSettings.saoUiScale ?? 100)}"></div>`
    + `<div class="rpg-sao-mrow toggle"><span>Bar backdrop</span>
        <input type="range" id="rpg-sao-card-a" min="0" max="70"
               value="${Math.round(uiSettings.saoCardAlpha ?? 11)}"></div>`
    + `<div class="rpg-sao-mrow toggle"><span>Bar style</span>
        <select id="rpg-sao-barstyle">
          <option value="sao"${!["alo", "blk"].includes(uiSettings.saoBarStyle) ? " selected" : ""}>Aincrad (SAO)</option>
          <option value="alo"${uiSettings.saoBarStyle === "alo" ? " selected" : ""}>ALfheim (Classic)</option>
          <option value="blk"${uiSettings.saoBarStyle === "blk" ? " selected" : ""}>ALfheim (New)</option>
        </select></div>`
    + `<div class="rpg-sao-mrow toggle"><span>Font</span>
        <select id="rpg-sao-font">
          <option value="preset"${!SAO_FONTS[uiSettings.saoFont] && uiSettings.saoFont !== "custom" ? " selected" : ""}>Follow preset</option>
          <option value="sans"${uiSettings.saoFont === "sans" ? " selected" : ""}>Sans</option>
          <option value="squarish"${uiSettings.saoFont === "squarish" ? " selected" : ""}>Squarish (Rajdhani)</option>
          <option value="saira"${uiSettings.saoFont === "saira" ? " selected" : ""}>Saira Condensed</option>
          <option value="teko"${uiSettings.saoFont === "teko" ? " selected" : ""}>Teko</option>
          <option value="exo"${uiSettings.saoFont === "exo" ? " selected" : ""}>Exo 2</option>
          <option value="custom"${uiSettings.saoFont === "custom" ? " selected" : ""}>Custom\u2026</option>
        </select></div>`
    + (uiSettings.saoFont === "custom"
      ? `<div class="rpg-sao-mrow toggle rpg-sao-customfont"><input id="rpg-sao-customfont" type="text"
           value="${escAttr(saoCustomFontName())}" placeholder="Any Google Font, e.g. Orbitron"
           spellcheck="false" autocomplete="off"></div>`
      : "")
    + `<div class="rpg-sao-mrow toggle"><span>Skin</span>
        <select id="rpg-sao-skin">
          <option value="classic">Classic</option>
          <option value="system">System</option>
          <option value="fog">Gray Fog</option>
          <option value="sao" selected>SAO</option>
        </select></div>`
    + `<div class="rpg-sao-build">build ${HUD_BUILD}</div>`;
}

// ---- orbs ---------------------------------------------------------------
const SAO_COG = `<svg viewBox="0 0 24 24">
  <defs><mask id="rpgSaoCog"><rect width="24" height="24" fill="#fff"/><circle cx="12" cy="12" r="3.15" fill="#000"/></mask></defs>
  <g mask="url(#rpgSaoCog)"><circle cx="12" cy="12" r="6.7"/>
  ${[0,45,90,135,180,225,270,315].map((a) =>
    `<rect x="10.5" y="1.5" width="3" height="4.6" rx="0.7" transform="rotate(${a} 12 12)"/>`).join("")}
  </g></svg>`;

const SAO_TABS = [
  { id: "status", label: "Status", icon: `<svg viewBox="0 0 24 24"><circle cx="12" cy="7.4" r="3.8"/><path d="M4.3 20.8c0-4.3 3.4-7 7.7-7s7.7 2.7 7.7 7z"/></svg>` },
  { id: "bonds", label: "Bonds", icon: `<svg viewBox="0 0 24 24"><circle cx="8.1" cy="7.8" r="3.5"/><path d="M1.5 20.6c0-3.8 2.9-6.2 6.6-6.2s6.6 2.4 6.6 6.2z"/><circle cx="17.7" cy="9.4" r="2.6"/><path d="M12.8 20.6c0-2.8 2.2-4.6 4.9-4.6s4.9 1.8 4.9 4.6z"/></svg>` },
  { id: "quests", label: "Quests", icon: `<svg viewBox="0 0 24 24"><defs><mask id="rpgSaoMsg"><rect width="24" height="24" fill="#fff"/><rect x="0.2" y="7.1" width="16.6" height="11.3" rx="3" fill="#000"/><path d="M3.6 15.6h6v6.6l-6-3.4z" fill="#000"/></mask></defs><g mask="url(#rpgSaoMsg)"><rect x="8.4" y="2.4" width="14.4" height="10.2" rx="2.4"/><path d="M17.4 10.4h4.4v5.9l-4.4-2.9z"/></g><rect x="1.6" y="8.5" width="13.8" height="8.5" rx="2.2"/><path d="M5 15.1h4.6v5.5L5 17.8z"/></svg>` },
  { id: "place", label: "Location", icon: `<svg viewBox="0 0 24 24"><path d="M12 1.4c-3.7 0-6.7 2.9-6.7 6.6 0 4.8 6.7 11.5 6.7 11.5s6.7-6.7 6.7-11.5c0-3.7-3-6.6-6.7-6.6zm0 9.1a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/><rect x="3.6" y="20.8" width="16.8" height="1.7" rx="0.85"/></svg>` },
  { id: "gear", label: "Settings", icon: SAO_COG },
];

// matches indicatorColor(): valid | invalid | notag | user
function saoIndicatorClass(status) {
  switch (status) {
    case "valid":   return "ok";
    case "invalid": return "warn";
    case "user":    return "user";
    default:        return "none";
  }
}

// ---- the skin -----------------------------------------------------------
function renderSaoSkin() {
  let container = document.getElementById("rpg-hud-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "rpg-hud-container";
    document.body.appendChild(container);
  }

  saoEnsureWebFont();

  let latest = { status: "nochat", label: "", detail: "" };
  try { latest = updateLatestStatusAndToast(SillyTavern.getContext()?.chat); } catch {}

  container.style.cssText = `position:fixed; top:0; left:0; right:0; bottom:auto;
    height:100vh; height:100svh; z-index:9999; pointer-events:none;
    --rpg-sao-ui:${clamp(uiSettings.saoUiScale ?? 100, 70, 300) / 100};
    ${saoPosCss()}
    ${(() => { const v = saoPanelVars(); return `--rpg-sao-panel-l:${v.l}%;
    --rpg-sao-ink:${v.ink}; --rpg-sao-ink-dim:${v.inkDim};
    --rpg-sao-rule:${v.rule}; --rpg-sao-chip:${v.chip};`; })()}
    --rpg-sao-card-a:${clamp(uiSettings.saoCardAlpha ?? 11, 0, 70)}%;`;
  const live = uiSettings.saoAnimate !== false && performance.now() < saoAnimUntil;
  const animKind = live ? saoAnimKind : "";
  const anim = animKind ? ` anim-${animKind}` : "";
  container.className =
    (saoLayoutMode ? "layout " : "") +
    (uiSettings.saoTextShadow ? "rpg-sao-sh " : "") +
    (uiSettings.saoTextBacking ? "rpg-sao-bk" : "") + anim;
  container.style.cssText += `
    font-family:${saoFontStack()};
    font-size:${0.9 * (uiSettings.fontScale || 1)}em;`;
  container.onclick = null;

  try {
    const { root, display, type, isVehicle } = getActiveData();
    const player = rpgState;
    const pView = saoUnitView(player);
    const pName = pView.name;
    const en = pView.en;

    // A fresh install or "no chat selected" has 0/0 everywhere, which drew an
    // empty box in layout mode. Show representative bars so it can be placed.
    const noData = !toNumberOr(pView.hp_curr, 0) || !toNumberOr(pView.hp_max, 0);
    const demo = saoLayoutMode && noData;

    const hpPct = demo ? 72 : saoPct(pView.hp_curr, pView.hp_max);
    const hpStops = saoUnitStops(pView);
    const mpPct = demo ? 48 : saoPct(en.curr, en.max);

    const party = Array.isArray(rpgState.party) ? rpgState.party : [];
    const enemies = Array.isArray(rpgState.enemies) ? rpgState.enemies : [];
    const npcs = Array.isArray(rpgState.npcs) ? rpgState.npcs : [];
    const pMeters = Array.isArray(player.meters) ? player.meters : [];

    const showBars = saoLayoutMode || !saoMin || uiSettings.barsOnMin;
    const inCombat = !!rpgState?.combat?.active;

    // --- vitals ---
    let vitals = "";
    if (showBars) {
      const hpText = demo ? "720/1000" : barPair(pView.hp_curr, pView.hp_max);
      const mpText = demo ? "240/500" : barPair(en.curr, en.max);
      const shownName = escHtml(demo ? "Name" : pName);

      if (uiSettings.saoBarStyle === "blk") {
        blkAssignColors([
          ...party.map((u) => aloSplitTitle(saoUnitView(u).name).name),
          ...npcs.map((u) => aloSplitTitle(saoUnitView(u).name).name),
        ]);
      }

      const playerBlock = uiSettings.saoBarStyle === "blk"
        ? blkUnitRow(pView, 0, "p", { big: true, kind: "player", hpPct, mpPct, hpText, mpText,
            name: demo ? "Name" : pName, status: blkEffects(rpgState.status_effects, null) })
        : uiSettings.saoBarStyle === "alo"
        // ALfheim: one plate, name on the left, HP over MP in one arrow frame
        ? (() => {
            const t = aloSplitTitle(demo ? "Name" : pName);
            return `<div class="rpg-alo-player">
              ${t.title ? `<div class="rpg-alo-title">${escHtml(t.title)}</div>` : ""}
              <div class="rpg-alo-plate" data-key="p" data-hp="${hpPct}" data-mp="${mpPct}"
                data-hp1="${hpStops[0]}" data-hp2="${hpStops[1]}"
                data-mp1="${ALO_MP[0]}" data-mp2="${ALO_MP[1]}">
                <div class="rpg-alo-svg"></div>
                <span class="rpg-alo-name">${escHtml(t.name)}</span>
              </div>
              <div class="rpg-alo-nums"><span><i>HP</i> ${hpText}</span><span><i>${escHtml(en.label || "MP")}</i> ${mpText}</span></div>
            </div>`;
          })()
        : `<div class="rpg-sao-card">
          <div class="rpg-sao-block">
            <div class="rpg-sao-name">${shownName}</div>
            <div class="rpg-sao-stack">
              <div class="rpg-sao-vrow">${saoBarHtml("", hpPct, hpStops[0], hpStops[1], "p:hp")}
                <span class="rpg-sao-vnum">${hpText}</span></div>
              <div class="rpg-sao-vrow">${saoBarHtml("mid", mpPct, SAO_PALETTE.mp[0], SAO_PALETTE.mp[1], "p:mp")}
                <span class="rpg-sao-vnum">${mpText}</span></div>
            </div>
          </div>
        </div>`;

      vitals = `<div class="rpg-sao-vitals${uiSettings.saoBarStyle === "alo" ? " alo" : uiSettings.saoBarStyle === "blk" ? " alo blk" : ""}${animKind === "restore" && !uiSettings.barsOnMin ? " fadein" : ""}" data-drag="vitals">
        ${playerBlock}`;

      if (pMeters.length) {
        vitals += `<div class="rpg-sao-group">` + saoDivider("METERS", "meters") +
          `<div class="rpg-sao-slim${saoCollapsed.meters ? " hide" : ""}">` +
          pMeters.map((m) => saoSlimRow(m.name, m.curr, m.max, saoMeterColor(m.name), null, false,
            `p/m:${normBondName(m.name)}`)).join("") +
          `</div></div>`;
      }
      // party and NPCs get their own sections, each independently collapsible
      const alo = uiSettings.saoBarStyle === "alo";
      const unitGroup = (label, key, list, type) => {
        if (!list.length) return "";
        return `<div class="rpg-sao-group">` + saoDivider(label, key) +
          `<div class="rpg-sao-slim${alo ? " rpg-alo-group" : ""}${saoCollapsed[key] ? " hide" : ""}">` +
          list.map((u, i) => {
            const v = saoUnitView(u);
            const k = `${type}:${normBondName(u?.name) || i}`;
            const idx = charIndexFor(type, i);
            return (uiSettings.saoBarStyle === "blk"
              ? blkUnitRow(v, idx, k, { kind: type === "npc" ? "npc" : "party", status: blkEffects(u?.status_effects, u?.name) })
              : alo
              ? aloUnitRow(v, idx, k, false)
              : saoSlimRow(v.name, v.hp_curr, v.hp_max, saoUnitStops(v), idx, false, k))
              + saoMeterRows(v, k);
          }).join("") + `</div></div>`;
      };
      vitals += unitGroup("PARTY", "party", party, "party");
      vitals += unitGroup("NPCS", "npcs", npcs, "npc");
    }

    // --- enemies ---
    let foesHtml = "";
    if (showBars && inCombat && enemies.length) {
      foesHtml = `<div class="rpg-sao-foes"><div class="rpg-sao-group">` +
        saoDivider(`ROUND ${escHtml(rpgState.combat.round ?? 1)}`, "foes", "#f0b6ab") +
        `<div class="rpg-sao-slim${uiSettings.saoBarStyle === "alo" ? " rpg-alo-group" : ""}${saoCollapsed.foes ? " hide" : ""}">` +
        enemies.map((u, i) => {
          const v = saoUnitView(u);
          const k = `enemy:${normBondName(u?.name) || ""}:${i}`;
          if (uiSettings.saoBarStyle === "blk") {
            if (!v.isVeh && !v.name) v.name = `Enemy ${i + 1}`;
            return blkUnitRow(v, charIndexFor("enemy", i), k, { foe: true, kind: "enemy", status: blkEffects(u?.status_effects, u?.name) }) + saoMeterRows(v, k);
          }
          if (uiSettings.saoBarStyle === "alo") {
            if (!v.isVeh && !v.name) v.name = `Enemy ${i + 1}`;
            return aloUnitRow(v, charIndexFor("enemy", i), k, true) + saoMeterRows(v, k);
          }
          return saoSlimRow(v.isVeh ? v.name : (u?.name || `Enemy ${i + 1}`),
            v.hp_curr, v.hp_max, saoUnitStops(v), charIndexFor("enemy", i), true, k)
            + saoMeterRows(v, k);
        }).join("") + `</div></div></div>`;
    }

    // --- orbs ---
    const orbs = `<div class="rpg-sao-col"><div class="rpg-sao-colinner" data-drag="col" data-drag-box="col">` +
      (saoMin ? "" : SAO_TABS.map((t, i) =>
        `<button class="rpg-sao-orb${saoPanel === t.id ? " on" : ""}" data-tab="${t.id}"
          style="animation-delay:${i * 45}ms" title="${escAttr(t.label)}">${t.icon}</button>`
      ).join("") + `<div class="rpg-sao-rule" style="animation-delay:${SAO_TABS.length * 45}ms"></div>`) +
      (latest.status === "invalid"
        ? `<button class="rpg-sao-orb diag" id="rpg-sao-diag" title="Show the parse error">!</button>` : "") +
      `<button class="rpg-sao-orb min" id="rpg-sao-min" title="${escAttr(latest.label || "Toggle HUD")}">
        <span class="rpg-sao-dot ${saoIndicatorClass(latest.status)}"></span></button></div></div>`;

    // --- panel ---
    let panelHtml = "";
    if (!saoMin && saoPanel === "gear" && saoHelpOpen) {
      const help = saoHelpOpen === "log" ? changelogPanel() : saoHelpOpen === "layout" ? layoutReportPanel() : saoHelpPanel();
      panelHtml = `<div class="rpg-sao-panelwrap helpshift"><div class="rpg-sao-panel">
        <h2>${escHtml(help.title)}</h2>
        <div class="rpg-sao-body" data-scroll-key="help">${help.body}</div><div class="rpg-sao-jumps"><button class="rpg-sao-jumpto up" title="Back to the top"><svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.5 7.5L6 4l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button class="rpg-sao-jumpto down" title="To the bottom"><svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div></div><div class="rpg-sao-notch"></div></div>`;
    } else if (!saoMin && saoPanel && saoPanel !== "gear") {
      const built = saoPanel === "status" ? saoStatusPanel()
                  : saoPanel === "bonds" ? saoBondsPanel()
                  : saoPanel === "quests" ? saoQuestsPanel()
                  : saoPanel === "error" ? saoErrorPanel()
                  : saoPlacePanel();
      panelHtml = `<div class="rpg-sao-panelwrap"><div class="rpg-sao-panel">
        <h2>${escHtml(built.title)}</h2>
        ${saoPanel === "status" ? saoWhoStrip() : ""}
        <div class="rpg-sao-body" data-scroll-key="${escAttr(saoPanelScrollKey())}">${built.body}</div><div class="rpg-sao-jumps"><button class="rpg-sao-jumpto up" title="Back to the top"><svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.5 7.5L6 4l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button class="rpg-sao-jumpto down" title="To the bottom"><svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div></div><div class="rpg-sao-notch"></div></div>`;
    }

    const menuHtml = (!saoMin && saoPanel === "gear")
      ? `<div class="rpg-sao-menuwrap${saoHelpOpen ? " hashelp" : ""}"><div class="rpg-sao-menu" data-scroll-key="menu">${saoSettingsHtml()}</div><div class="rpg-sao-notch"></div></div>` : "";

    // --- clock ---
    const t = rpgState.world_time || {};
    const clockHtml = saoMin ? "" : `<div class="rpg-sao-clockwrap" data-drag="clock">
      ${saoTimersOpen ? `<div class="rpg-sao-timers" data-scroll-key="timers">${saoTimersHtml()}</div>` : ""}
      <button class="rpg-sao-clock" id="rpg-sao-clock">
        <span class="rpg-sao-dot ${saoIndicatorClass(latest.status)}"></span>
        <span class="rpg-sao-glyph">${getWeatherEmoji(t.weather)}</span>
        <span class="rpg-sao-cstack">
          <span class="hhmm">${t.clock ? escHtml(showClock(t.clock)).replace(/\s*([AP]\.?\s*M\.?)$/i, '<span style="font-size:.5em; margin-left:.25em;">$1</span>') : "??:??"}</span>
          <span class="date">${worldWeekday(t) ? escHtml(worldWeekday(t)) + " " : ""}${escHtml(t.month || "?")} ${escHtml(t.day ?? "?")} ${escHtml(t.year || "")}</span>
        </span></button></div>`;

    if (vitals) vitals += foesHtml + `</div>`;
    const layoutBar = saoLayoutMode
      ? `<div id="rpg-sao-layout-bar">Drag any outlined piece
          <button class="ghost${uiSettings.saoSnap !== false ? " on" : ""}" id="rpg-sao-layout-snap"
            title="Line pieces up with each other and with the screen">Snap ${uiSettings.saoSnap !== false ? "on" : "off"}</button>
          <button class="ghost" id="rpg-sao-layout-reset" title="Put every piece back where it started">Reset all</button>
          <button id="rpg-sao-layout-done">Done</button></div>`
      : "";

    saoSaveScroll(container);
    container.innerHTML = SAO_CSS + vitals + orbs + panelHtml + menuHtml + clockHtml + layoutBar;
    saoRestoreScroll(container);

    saoFitName();          // may change the bar width, so run it first
    saoPaintBars();
    saoPlacePanels();
    saoBindJumps();
    requestAnimationFrame(() => {
      saoFitName(); saoPaintBars(); saoPlacePanels();
      const vs = container.querySelector(".rpg-sao-vitals");
      if (vs) vs.classList.toggle("scrolls", vs.scrollHeight > vs.clientHeight + 1);
      saoRestoreScroll(container);
      saoBindJumps();
      saoBindDragging(); saoDrawGhosts();
    });
    saoBind();
  } catch (e) {
    container.innerHTML = `<div style="pointer-events:auto; position:fixed; top:60px; right:20px;
      background:#111; color:#ff5252; border:1px solid #ff5252; padding:10px; z-index:99999;">
      SAO skin crashed: ${escHtml(e.message)}<br>
      <button id="rpg-sao-fallback">Back to classic skin</button></div>`;
    const b = document.getElementById("rpg-sao-fallback");
    if (b) b.onclick = () => setSkin("classic");
    console.error("RPG HUD SAO skin error:", e);
  }
}

function saoBind() {
  const on = (sel, fn) => document.querySelectorAll(sel).forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); fn(el, e); };
  });

  on(".rpg-sao-orb[data-tab]", (el) => {
    flushInlineEdits();
    const tab = el.dataset.tab;
    const was = saoPanel;
    saoMeterEdit = null; saoMasteryEdit = null; saoListEdit = null;
    saoPanel = saoPanel === tab ? null : tab;
    if (saoPanel !== "gear") saoHelpOpen = false;
    if (saoPanel && saoPanel !== was) saoAnim("panel", 220);
    renderRPG();
  });

  const minBtn = document.getElementById("rpg-sao-min");
  if (minBtn) minBtn.onclick = (e) => {
    e.stopPropagation();
    flushInlineEdits();
    saoMin = !saoMin;
    if (saoMin) { saoPanel = null; saoAnim("collapse", 340); } else saoAnim("restore", 560);
    renderRPG();
  };

  on(".rpg-mathnum", (el) => showMathPop(el));
  on(".rpg-sao-mv", (el) => {
    const rows = reorderRows(el.dataset.kind);
    const i = +el.dataset.i, j = i + (+el.dataset.d);
    if (!rows || j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]]; if (saoListEdit) saoListEdit.pick = null;
    renderRPG();
  });
  on(".rpg-sao-moveto", (el) => moveActiveCharacter(el.dataset.to));

  on(".rpg-sao-caret, .rpg-sao-divlabel", (el) => {
    const k = el.dataset.k;
    saoCollapsed[k] = !saoCollapsed[k];
    renderRPG();
  });

  on(".rpg-sao-jump, .rpg-sao-chip", (el) => {
    const idx = parseInt(el.dataset.idx, 10);
    if (!Number.isFinite(idx)) return;
    saoMeterEdit = null; saoMasteryEdit = null; saoListEdit = null;
    charIndex = idx;
    saoSub = "stats";
    saoPanel = "status";
    renderRPG();
  });

  on(".rpg-sao-cat", (el) => {
    saoMeterEdit = null; saoMasteryEdit = null; saoListEdit = null;
    const g = saoRosterGroups().filter((x) => x.key === el.dataset.cat)[0];
    if (!g) return;
    charIndex = charIndexFor(g.type, 0);
    saoPanel = "status";
    renderRPG();
  });

  on(".rpg-sao-subtab", (el) => { saoSub = el.dataset.sub; saoMasteryEdit = null; saoListEdit = null; renderRPG(); });
  on(".rpg-sao-qtab", (el) => { saoQuestTab = el.dataset.qtab; saoLogShown = 20; saoListEdit = null; renderRPG(); });
  on(".rpg-sao-turnhead", (el) => {
    const mes = document.querySelector(`#chat .mes[mesid="${el.dataset.mes}"]`);
    if (mes) mes.scrollIntoView({ behavior: "smooth", block: "center" });
    else if (window.toastr) hudToast.info("That message isn't loaded in the chat view.");
  });

  const clock = document.getElementById("rpg-sao-clock");
  if (clock) clock.onclick = (e) => { e.stopPropagation(); saoTimersOpen = !saoTimersOpen; renderRPG(); };

  // bonds / timers reuse the classic editors, so their own binders apply
  const bondEdit = document.getElementById("rpg-sao-bond-edit");
  if (bondEdit) bondEdit.onclick = (e) => {
    e.stopPropagation();
    bondsEditMode = true;
    bondsSnapshot = (rpgState.bonds || []).filter((b) => b && b.name).map((b) => ({ ...b }));
    renderRPG();
  };
  const timerEdit = document.getElementById("rpg-sao-timer-edit");
  if (timerEdit) timerEdit.onclick = (e) => {
    e.stopPropagation();
    timersEditMode = true;
    timersSnapshot = (rpgState.timers || [])
      .filter((t) => t && String(t.name || "").trim())
      .map((t) => ({ ...t }));
    renderRPG();
  };
  on(".rpg-sao-tuse", (el) => spendTimerCharge(el.dataset.key));

  const timerTurn = document.getElementById("rpg-sao-timer-turn");
  if (timerTurn) timerTurn.onclick = (e) => { e.stopPropagation(); advanceTimerTurn(); };

  saoBindMeterEditor();
  saoBindMasteryEditor();
  saoBindListEditor();
  if (bondsEditMode) bindBondsTab();
  if (timersEditMode) bindTimersTab();

  // settings
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = (e) => { e.stopPropagation(); fn(e); }; };
  bind("rpg-sao-diag", () => {
    saoMin = false;
    saoPanel = saoPanel === "error" ? null : "error";
    renderRPG();
  });
  bind("rpg-sao-diagnose", () => { saoMin = false; saoPanel = "error"; renderRPG(); });
  bind("rpg-sao-help", () => { saoHelpOpen = saoHelpOpen === true ? false : true; renderRPG(); });
  // (the layout report box needs its own click handling: taps inside it shouldn't close the menu)
  bind("rpg-sao-layoutrep", () => {
    if (saoHelpOpen === "layout") { saoHelpOpen = false; renderRPG(); return; }
    measureLayoutReport();                 // before the panel opens, as the rows are now
    saoHelpOpen = "layout";
    renderRPG();
  });
  bind("rpg-sao-layout-copy", () => {
    const ta = document.getElementById("rpg-sao-layout-text");
    const done = () => { if (window.toastr) hudToast.info("Layout report copied."); };
    try { navigator.clipboard.writeText(layoutReportText).then(done, () => { ta?.select(); document.execCommand("copy"); done(); }); }
    catch { ta?.select(); try { document.execCommand("copy"); done(); } catch {} }
  });
  bind("rpg-sao-whatsnew", () => { saoHelpOpen = saoHelpOpen === "log" ? false : "log"; markChangelogSeen(); renderRPG(); });
  bind("rpg-sao-log-more", () => { saoLogShown += 20; renderRPG(); });

  // a character's own |Bond:|, edited from their Stats tab
  const liveBond = document.getElementById("rpg-sao-livebond");
  if (liveBond) {
    liveBond.onclick = (e) => e.stopPropagation();
    liveBond.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") liveBond.blur(); };
    liveBond.onchange = () => {
      const { root } = getActiveData();
      if (!root) return;
      const raw = liveBond.value.trim();
      if (raw === "") {
        delete root.bond;
      } else {
        const v = clamp(Math.round(parseBondValue(raw)), 0, 101);
        root.bond = v;
        // keep the Bonds list in step, unless you took this name off it
        if (!bondBlocklist.has(normBondName(root.name))) {
          if (!Array.isArray(rpgState.bonds)) rpgState.bonds = [];
          upsertBond(rpgState.bonds, root.name, v);
        }
      }
      writeStateBackToChatMessage(rpgState);
      renderRPG();
    };
  }

  const tilePick = document.getElementById("rpg-sao-tilecolor");
  if (tilePick) {
    const key = tilePick.dataset.key;
    const tiles = () => document.querySelectorAll(`.rpg-blk-tile[data-tkey="${CSS.escape(key)}"]`);
    tilePick.onclick = (e) => e.stopPropagation();
    // while choosing: recolour the tile in place, no redraw, so the picker stays open
    tilePick.oninput = () => tiles().forEach((t) => { t.style.backgroundColor = tilePick.value; });
    // on closing the picker: keep it
    tilePick.onchange = () => {
      uiSettings.tileColors = { ...(uiSettings.tileColors || {}), [key]: tilePick.value };
      saveUiSettings();
      renderRPG();
    };
  }
  bind("rpg-sao-tilecolor-auto", () => {
    const key = document.getElementById("rpg-sao-tilecolor-auto")?.dataset.key;
    if (!key) return;
    const next = { ...(uiSettings.tileColors || {}) };
    delete next[key];
    uiSettings.tileColors = next;
    saveUiSettings();
    renderRPG();
  });
  bind("rpg-sao-undo", saoUndoLastTurn);
  on(".rpg-sao-revert", (el) => saoUndoChange(parseInt(el.dataset.ci, 10), el.dataset.text));
  on(".rpg-sao-lock", (el) => toggleLock(el.dataset.lid));
  bind("rpg-sao-redo", saoRedoLastTurn);
  bind("rpg-sao-move", () => {
    saoLayoutMode = true;
    saoPanel = null;
    saoMin = false;        // everything has to be on screen to be arranged
    renderRPG();
    // the one place a rescue is expected, and visible when it happens
    requestAnimationFrame(() => { saoEnforceOnScreen(); saoDrawGhosts(); });
  });
  bind("rpg-sao-layout-done", () => { saoLayoutMode = false; renderRPG(); });
  bind("rpg-sao-layout-reset", saoResetLayout);
  bind("rpg-sao-layout-snap", () => {
    uiSettings.saoSnap = uiSettings.saoSnap === false;
    saveUiSettings();
    renderRPG();
  });
  bind("rpg-sao-reset", resetUiSettings);
  // the embedded error panel closes itself via isErrorOpen, which this skin
  // doesn't use — its visibility is saoPanel, so close that instead
  bind("rpg-error-close", () => { isErrorOpen = false; saoPanel = null; renderRPG(); });
  bind("rpg-sao-edit", openEditorFromSettings);
  bind("rpg-sao-remove", removeActiveCharacter);
  bind("rpg-sao-clear-npcs", (e) => clearArray("npc", e));
  bind("rpg-sao-clear-enemies", (e) => clearArray("enemy", e));
  bind("rpg-sao-clear-party", (e) => clearArray("party", e));
  bind("rpg-sao-rescan", () => checkMessage(true));
  bind("rpg-sao-insert", insertLastStateIntoNarrative);
  bind("rpg-sao-remind", remindStateInLastMessage);
  bind("rpg-sao-sw-alerts", () => { uiSettings.changeAlerts = !uiSettings.changeAlerts; saveUiSettings(); renderRPG(); });
  bind("rpg-sao-sw-ignorecounts", () => { uiSettings.ignoreCountChanges = uiSettings.ignoreCountChanges === false; saveUiSettings(); renderRPG(); });
  const tsI = document.getElementById("rpg-sao-toastsecs");
  if (tsI) {
    tsI.onclick = (e) => e.stopPropagation();
    tsI.onkeydown = (e) => e.stopPropagation();
    tsI.onchange = () => { uiSettings.toastSeconds = Math.max(0, Math.min(120, parseInt(tsI.value, 10) || 0)); saveUiSettings(); };
  }
  const eh = document.getElementById("rpg-sao-edithist");
  if (eh) {
    eh.onclick = (e) => e.stopPropagation();
    eh.onkeydown = (e) => e.stopPropagation();
    eh.onchange = () => { uiSettings.listEditHistory = Math.max(0, Math.min(20, parseInt(eh.value, 10) || 0)); saveUiSettings(); };
  }
  bind("rpg-sao-sw-addwd", () => {
    uiSettings.addWeekdays = uiSettings.addWeekdays === false;
    saveUiSettings();
    renderRPG();
  });
  bind("rpg-sao-sw-weekday", () => {
    uiSettings.fixWeekdays = uiSettings.fixWeekdays === false;
    saveUiSettings();
    renderRPG();
  });
  bind("rpg-sao-sw-restore", () => {
    uiSettings.restoreLostDesc = !uiSettings.restoreLostDesc;
    saveUiSettings();
    renderRPG();
  });
  bind("rpg-sao-sw-ooc", () => {
    uiSettings.oocEditNotes = uiSettings.oocEditNotes === false;
    saveUiSettings();
    renderRPG();
  });
  bind("rpg-sao-sw-inject", () => {
    autoInjectState = !autoInjectState;
    const box = document.getElementById("rpg-settings-autoinject");
    if (box) box.checked = autoInjectState;
    if (window.toastr) hudToast.info(`Auto-Inject ${autoInjectState ? "Enabled" : "Disabled"}`);
    renderRPG();
  });
  bind("rpg-sao-sw-bars", () => { uiSettings.barsOnMin = !uiSettings.barsOnMin; saveUiSettings(); renderRPG(); });
  bind("rpg-sao-sw-shadow", () => { uiSettings.saoTextShadow = !uiSettings.saoTextShadow; saveUiSettings(); renderRPG(); });
  bind("rpg-sao-sw-backing", () => { uiSettings.saoTextBacking = !uiSettings.saoTextBacking; saveUiSettings(); renderRPG(); });
  bind("rpg-sao-sw-anim", () => {
    uiSettings.saoAnimate = uiSettings.saoAnimate === false;
    saveUiSettings(); renderRPG();
  });
  bind("rpg-sao-sw-autobond", () => { uiSettings.autoAddBonds = !uiSettings.autoAddBonds; saveUiSettings(); renderRPG(); });
  bind("rpg-sao-unblock", () => {
    clearBondBlocklist();
    if (window.toastr) hudToast.info("Bond blocklist cleared for this chat.");
    renderRPG();
  });

  // live, without a re-render: rebuilding the menu would drop the slider mid-drag
  const pa = document.getElementById("rpg-sao-panel-a");
  if (pa) {
    pa.oninput = () => {
      // never re-render here: replacing the input would drop the drag
      uiSettings.saoPanelLight = clamp(parseFloat(pa.value), 18, 98);
      saoApplyPanelVars();
    };
    pa.onchange = () => saveUiSettings();
    pa.onclick = (e) => e.stopPropagation();
  }

  const ink = document.getElementById("rpg-sao-ink");
  if (ink) {
    ink.oninput = () => {
      uiSettings.saoInk = clamp(parseFloat(ink.value), 25, 100);
      saoApplyPanelVars();      // never re-render: it would drop the drag
    };
    ink.onchange = () => saveUiSettings();
    ink.onclick = (e) => e.stopPropagation();
  }

  const ew = document.getElementById("rpg-sao-edit-w");
  if (ew) {
    ew.oninput = () => { uiSettings.hudWidth = clamp(parseFloat(ew.value), 240, 560); };
    ew.onchange = () => saveUiSettings();
    ew.onclick = (e) => e.stopPropagation();
  }

  const us = document.getElementById("rpg-sao-ui-scale");
  if (us) {
    us.oninput = () => {
      const v = clamp(parseFloat(us.value), 70, 300);
      uiSettings.saoUiScale = v;
      document.getElementById("rpg-hud-container")?.style.setProperty("--rpg-sao-ui", String(v / 100));
      saoFitName(); saoPaintBars();   // the SVGs are drawn at pixel size, so redraw
    };
    us.onchange = () => saveUiSettings();
    us.onclick = (e) => e.stopPropagation();
  }

  const ca = document.getElementById("rpg-sao-card-a");
  if (ca) {
    ca.oninput = () => {
      const v = clamp(parseFloat(ca.value), 0, 70);
      uiSettings.saoCardAlpha = v;
      document.getElementById("rpg-hud-container")?.style.setProperty("--rpg-sao-card-a", v + "%");
    };
    ca.onchange = () => saveUiSettings();
    ca.onclick = (e) => e.stopPropagation();
  }

  const cfSel = document.getElementById("rpg-sao-clockfmt");
  if (cfSel) {
    cfSel.onchange = () => { uiSettings.clockFormat = cfSel.value; saveUiSettings(); renderRPG(); };
    cfSel.onclick = (e) => e.stopPropagation();
  }

  const styleSel = document.getElementById("rpg-sao-barstyle");
  if (styleSel) {
    styleSel.onchange = () => { uiSettings.saoBarStyle = styleSel.value; saveUiSettings(); renderRPG(); };
    styleSel.onclick = (e) => e.stopPropagation();
  }

  const fontSel = document.getElementById("rpg-sao-font");
  if (fontSel) {
    fontSel.onchange = () => { uiSettings.saoFont = fontSel.value; saveUiSettings(); renderRPG(); };
    fontSel.onclick = (e) => e.stopPropagation();
  }

  // custom font: applied on Enter or when the box loses focus
  const customFont = document.getElementById("rpg-sao-customfont");
  if (customFont) {
    const apply = () => {
      if (customFont.value === saoCustomFontName()) return;
      uiSettings.saoCustomFont = customFont.value;
      saveUiSettings();
      renderRPG();
    };
    customFont.onclick = (e) => e.stopPropagation();
    customFont.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); apply(); } };
    customFont.onblur = apply;
  }

  const skinSel = document.getElementById("rpg-sao-skin");
  if (skinSel) {
    skinSel.onchange = () => setSkin(skinSel.value);
    skinSel.onclick = (e) => e.stopPropagation();
  }
}

if (!window.__rpgSaoResizeBound) {
  window.__rpgSaoResizeBound = true;
  let rt = null;
  window.addEventListener("resize", () => {
    if ((uiSettings.skin || "classic") !== "sao") return;
    clearTimeout(rt);
    rt = setTimeout(() => {
      saoFitName(); saoPaintBars(); saoPlacePanels();
    }, 120);
  });
}

const SAO_CSS = `<style id="rpg-sao-style">
#rpg-hud-container > *{pointer-events:auto}
/* the column spans the whole height, so it must stay click-through itself;
   this needs the ID to outrank the blanket rule above. */
#rpg-hud-container .rpg-sao-col{pointer-events:none}
#rpg-hud-container .rpg-sao-colinner > *{pointer-events:auto}
#rpg-hud-container button{font-family:inherit}

/* The whole left stack scrolls rather than running off the bottom of the
   screen. The reserved strip matches the clock's, so it clears the chat box. */
/* The collapse arrows' enlarged tap areas reach a little below their row.
   On the bottom row (all groups collapsed) that overhang made the whole stack
   scrollable, and a scrollable stack catches touches, so tap-through stopped
   working too. This room holds the overhang; it's empty and lets taps through. */
.rpg-sao-vitals{padding-bottom:16px; box-sizing:content-box}
.rpg-sao-vitals{position:absolute; left:calc(8px + var(--sao-vitals-x, 0px));
  width:min(calc(322px * var(--rpg-sao-ui, 1)), calc(100vw - 130px));
  top:calc(env(safe-area-inset-top, 0px) + 12px + var(--sao-vitals-y, 0px));
  /* the last 16px is the bottom padding above, so the box ends where it always did */
  max-height:calc(100svh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)
                  - var(--rpg-sao-clock-lift, 84px) - 24px - 16px);
  overflow-y:auto; overflow-x:hidden; padding-right:4px;
  scrollbar-width:thin; scrollbar-color:rgba(255,255,255,.28) transparent}
.rpg-sao-vitals::-webkit-scrollbar{width:5px}
.rpg-sao-vitals::-webkit-scrollbar-thumb{background:rgba(255,255,255,.28); border-radius:3px}
.rpg-sao-vitals::-webkit-scrollbar-track{background:transparent}
/* --rpg-sao-card-a: the wash behind the player's bars. It's a LIGHT tint, so
   raising it lifts the card away from the chat rather than darkening it. */
.rpg-sao-card{padding:5px 6px 6px;
  background:rgb(226 233 244 / var(--rpg-sao-card-a, 11%));
  border:1px solid rgba(255,255,255,.2); border-radius:3px;
  backdrop-filter:blur(2px); box-shadow:0 2px 5px rgba(0,0,0,.35), 0 8px 22px rgba(0,0,0,.3)}
.rpg-sao-block{display:flex; align-items:center; gap:5px}
.rpg-sao-block.over{flex-direction:column; align-items:stretch; gap:3px}
.rpg-sao-stack{flex:1 1 auto; min-width:0}
.rpg-sao-name{flex:0 0 calc(40px * var(--rpg-sao-ui, 1)); width:calc(40px * var(--rpg-sao-ui, 1)); font-size:calc(11px * var(--rpg-sao-ui, 1)); font-weight:600; line-height:1.12;
  color:#f4f1e8; white-space:nowrap; overflow:hidden}
.rpg-sao-block.over .rpg-sao-name{flex:none; width:auto; padding-left:2px; font-size:calc(11.5px * var(--rpg-sao-ui, 1));
  white-space:normal; overflow:visible}
/* The step leaves the bar's lower-right corner empty. The readout sits in
   that gap, tucked under the tail, instead of hanging off the right edge. */
.rpg-sao-vrow{position:relative; padding-bottom:5px}
.rpg-sao-vrow + .rpg-sao-vrow{margin-top:5px}
.rpg-sao-vnum{position:absolute; right:3px; top:54%; line-height:1;
  font-size:calc(10px * var(--rpg-sao-ui, 1)); font-weight:600; color:#d3cfc4; white-space:nowrap}

/* ALfheim plates. Width is set by the painter: the bars are a fixed length
   and the name compartment takes what the longest name in its group needs,
   so a long name widens the plate rather than shortening the bars. */
.rpg-alo-plate{position:relative; height:calc(40px * var(--rpg-sao-ui, 1)); width:calc(300px * var(--rpg-sao-ui, 1)); max-width:none}
.rpg-alo-plate.small{height:calc(18px * var(--rpg-sao-ui, 1))}
.rpg-alo-svg{position:absolute; inset:0}
.rpg-alo-svg svg{display:block}
.rpg-alo-plate:not(.small) .rpg-alo-svg svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.3))}
.rpg-alo-plate.small .rpg-alo-name{text-shadow:0 1px 2px rgba(0,0,0,.7)}
.rpg-alo-name{position:absolute; top:0; bottom:0; z-index:1;
  display:flex; align-items:center; box-sizing:border-box;
  font-size:calc(12px * var(--rpg-sao-ui, 1)); font-weight:600; letter-spacing:.3px; color:#f4f2ec;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.rpg-alo-plate.small .rpg-alo-name{font-size:calc(10.5px * var(--rpg-sao-ui, 1)); font-weight:600}
.rpg-alo-title{font-size:calc(9.5px * var(--rpg-sao-ui, 1)); letter-spacing:.6px; color:#cfcbc1;
  margin:0 0 1px calc(10px * var(--rpg-sao-ui, 1)); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.rpg-alo-nums{display:flex; justify-content:flex-end; gap:calc(12px * var(--rpg-sao-ui, 1));
  margin:calc(3px * var(--rpg-sao-ui, 1)) calc(8px * var(--rpg-sao-ui, 1)) 0 0; font-size:calc(10px * var(--rpg-sao-ui, 1)); font-weight:600; color:#d3cfc4}
.rpg-alo-nums i{font-style:normal; opacity:.6; margin-right:2px}

.rpg-alo-row{margin-bottom:calc(5px * var(--rpg-sao-ui, 1))}
.rpg-alo-unit{display:block}
.rpg-alo-label{cursor:pointer}
/* width:0 + min-width:100% lets the label fill the row without widening it,
   so a long name is cut off at the bars' width instead of stretching them */
.rpg-alo-label{width:0; min-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  margin:0 0 calc(1px * var(--rpg-sao-ui, 1)) calc(1px * var(--rpg-sao-ui, 1)); line-height:1.15}
.rpg-alo-uname{font-size:calc(10.5px * var(--rpg-sao-ui, 1)); font-weight:600; letter-spacing:.3px; color:#f0eee8;
  text-shadow:0 1px 2px rgba(0,0,0,.7)}
.rpg-alo-utitle{font-size:calc(9px * var(--rpg-sao-ui, 1)); color:#bdb9af; margin-left:calc(6px * var(--rpg-sao-ui, 1)); letter-spacing:.4px;
  text-shadow:0 1px 2px rgba(0,0,0,.7)}
.rpg-alo-unit:hover .rpg-alo-uname{text-decoration:underline; text-underline-offset:2px}
.rpg-alo-unit.foe .rpg-alo-uname{color:#f2a99d}
.rpg-alo-barline{display:flex; align-items:center; gap:calc(6px * var(--rpg-sao-ui, 1))}
.rpg-alo-unitnums{display:flex; flex-direction:column; justify-content:center;
  height:calc(18px * var(--rpg-sao-ui, 1)); font-size:calc(9px * var(--rpg-sao-ui, 1)); line-height:1.15; color:#c8c4ba; white-space:nowrap}
.rpg-alo-unitnums > span:first-child{color:#dcd8cf; font-weight:600}


/* ---- ALfheim (New) ---- */
/* Two stacked blocks: the name (on its plate) above, then the tile, bars and
   numbers in ONE flex line. The tile and bars used to be in separate grid
   columns, attached only if the browser sized the first column to exactly the
   tile; iPhone Safari sized it wider and left a gap. Flex siblings can't drift.
   --bl shrinks on narrow screens so the numbers stay inside the stack (it
   leaves room for the orb column, the tile and the numbers). */
.rpg-blk-row{
  --bt:calc(30px * var(--rpg-sao-ui, 1)); --bb:calc(8px * var(--rpg-sao-ui, 1));
  --bl:max(calc(60px * var(--rpg-sao-ui, 1)), min(calc(150px * var(--rpg-sao-ui, 1)), calc(100vw - 134px - var(--bt) - 66px * var(--rpg-sao-ui, 1))));
  position:relative; display:flex; flex-direction:column; align-items:flex-start;
  margin-bottom:calc((var(--bt) - var(--bb) * 2) / 2 + 6px * var(--rpg-sao-ui, 1))}
.rpg-blk-row.big{--bt:calc(38px * var(--rpg-sao-ui, 1)); --bb:calc(10px * var(--rpg-sao-ui, 1));
  --bl:max(calc(80px * var(--rpg-sao-ui, 1)), min(calc(220px * var(--rpg-sao-ui, 1)), calc(100vw - 134px - var(--bt) - 66px * var(--rpg-sao-ui, 1))));
  margin-bottom:calc((var(--bt) - var(--bb) * 2) / 2 + 9px * var(--rpg-sao-ui, 1))}

/* translucent plate behind the name: starts a little in from the tile's left
   edge and fades out by the time it reaches the end of the bars */
/* the top block is exactly as wide as tile + bars, so the plate ends with the bars */
.rpg-blk-top{position:relative; width:calc(var(--bt) + var(--bl) - 3px * var(--rpg-sao-ui, 1))}
.rpg-blk-plate{position:absolute; top:0; bottom:0; right:0; left:calc(var(--bt) * .22); z-index:0;
  border-radius:calc(5px * var(--rpg-sao-ui, 1)) 0 0 calc(5px * var(--rpg-sao-ui, 1));
  background:linear-gradient(90deg, rgba(214,222,230,.26) 0, rgba(214,222,230,.18) 45%, rgba(214,222,230,0) 100%)}

/* Centred on the bars, so HP meets MP at the tile's middle. Equal negative
   margins let it overhang above and below without making the bar row taller,
   so the name plate sits right on the HP bar and the tile overlaps it. */
.rpg-blk-tile svg{width:60%; height:60%; display:block; fill:#fff;
  filter:drop-shadow(0 1px 1px rgba(0,0,0,.35))}
.rpg-blk-line{display:flex; align-items:center}
.rpg-blk-tile{flex:none; position:relative; z-index:2; box-sizing:border-box;
  margin:calc((var(--bb) * 2 - var(--bt)) / 2) 0;
  width:var(--bt); height:var(--bt); border-radius:calc(6px * var(--rpg-sao-ui, 1));
  border:calc(2px * var(--rpg-sao-ui, 1)) solid rgba(236,240,245,.88); box-shadow:0 1px 3px rgba(0,0,0,.45);
  display:grid; place-items:center; color:#fff; font-weight:800;
  font-size:calc(var(--bt) * .46); text-shadow:0 1px 2px rgba(0,0,0,.35);
  background-image:linear-gradient(180deg, rgba(255,255,255,.24) 0, rgba(255,255,255,.06) 48%,
                                           rgba(0,0,0,0) 52%, rgba(0,0,0,.14) 100%)}
/* starts where the bars start and may run a little past them, over the
   numbers, as before; a fixed width so a long name can't widen the row */
.rpg-blk-head{position:relative; z-index:1; box-sizing:border-box;
  display:flex; align-items:center; gap:calc(6px * var(--rpg-sao-ui, 1));
  margin-left:var(--bt); width:calc(var(--bl) - 3px * var(--rpg-sao-ui, 1) + 56px * var(--rpg-sao-ui, 1)); overflow:hidden; padding:calc(2px * var(--rpg-sao-ui, 1)) 0 calc(3px * var(--rpg-sao-ui, 1)) calc(7px * var(--rpg-sao-ui, 1))}
.rpg-blk-name{flex:0 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  font-size:calc(11.5px * var(--rpg-sao-ui, 1)); font-weight:700; letter-spacing:.4px; color:#f2f0ea;
  text-shadow:0 1px 2px rgba(0,0,0,.75); cursor:pointer}
.rpg-blk-row.big .rpg-blk-name{font-size:calc(13px * var(--rpg-sao-ui, 1))}
.rpg-blk-name:hover{text-decoration:underline; text-underline-offset:2px}
.rpg-blk-row.foe .rpg-blk-name{color:#f2a99d}
.rpg-blk-title{flex:0 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  font-size:calc(9px * var(--rpg-sao-ui, 1)); color:#bdb9af; text-shadow:0 1px 2px rgba(0,0,0,.7)}
.rpg-blk-chips{display:flex; gap:calc(1px * var(--rpg-sao-ui, 1)); flex:0 0 auto; align-items:center}
.rpg-blk-chip{display:grid; place-items:center; width:calc(19px * var(--rpg-sao-ui, 1)); height:calc(12px * var(--rpg-sao-ui, 1));
  clip-path:polygon(28% 0, 100% 0, 72% 100%, 0 100%); color:#fff;
  font-size:calc(7.5px * var(--rpg-sao-ui, 1)); font-weight:800; letter-spacing:.2px}
.rpg-blk-row.big .rpg-blk-chip{width:calc(22px * var(--rpg-sao-ui, 1)); height:calc(14px * var(--rpg-sao-ui, 1))}
.rpg-blk-chip svg{width:calc(9px * var(--rpg-sao-ui, 1)); height:calc(9px * var(--rpg-sao-ui, 1)); display:block}
.rpg-blk-more{font-size:calc(9px * var(--rpg-sao-ui, 1)); color:#cfcbc1; margin-left:2px}

/* HP and MP the same height, touching, and running out of the tile's edge */
.rpg-blk-bars{flex:none; display:flex; flex-direction:column; gap:0;
  position:relative; z-index:1; margin-left:calc(-3px * var(--rpg-sao-ui, 1))}
.rpg-sao-bar.blkhp, .rpg-sao-bar.blkmp{flex:none; width:var(--bl); height:var(--bb)}
.rpg-blk-row .rpg-sao-bar svg{filter:none}
.rpg-blk-nums{flex:none; display:flex; flex-direction:column; justify-content:space-between;
  height:calc(var(--bb) * 2); padding-left:calc(6px * var(--rpg-sao-ui, 1));
  font-size:calc(9px * var(--rpg-sao-ui, 1)); line-height:1; color:#c8c4ba; white-space:nowrap;
  text-shadow:0 1px 2px rgba(0,0,0,.7)}
.rpg-blk-nums > span:first-child{color:#e2ded5; font-weight:600}
.rpg-blk-row.big .rpg-blk-nums{font-size:calc(10px * var(--rpg-sao-ui, 1))}

/* ---- tap through the bars ----
   Only names and the collapse arrows catch taps; everything else in the
   stack lets them fall through to whatever is underneath. The one exception
   is a stack long enough to scroll, which has to catch touches to scroll. */
#rpg-hud-container .rpg-sao-vitals,
#rpg-hud-container .rpg-sao-vitals *{pointer-events:none}
#rpg-hud-container .rpg-sao-vitals.scrolls{pointer-events:auto}
#rpg-hud-container .rpg-sao-vitals button.rpg-sao-tag,
#rpg-hud-container .rpg-sao-vitals .rpg-sao-caret,
#rpg-hud-container .rpg-sao-vitals .rpg-sao-divlabel,
#rpg-hud-container .rpg-sao-vitals .rpg-mathnum,
#rpg-hud-container .rpg-sao-vitals .rpg-alo-label,
#rpg-hud-container .rpg-sao-vitals .rpg-alo-uname,
#rpg-hud-container .rpg-sao-vitals .rpg-blk-name{pointer-events:auto}

/* the stack sizes to its widest plate instead of a fixed width, so meters and
   other grid rows need explicit bar lengths to keep from collapsing */
.rpg-sao-vitals.alo{width:max-content; max-width:calc(100vw - 130px)}
.rpg-sao-vitals.alo .rpg-sao-slim{margin-right:0}
/* in ALfheim every bar row puts its label above, so all bars share one left edge */
.rpg-sao-vitals.alo .rpg-sao-row{
  grid-template-columns:calc(150px * var(--rpg-sao-ui, 1)) var(--numw); row-gap:0; margin-left:0}
.rpg-sao-vitals.alo .rpg-sao-row.sub{grid-template-columns:calc(90px * var(--rpg-sao-ui, 1)) var(--numw); opacity:.82}
.rpg-sao-vitals.alo .rpg-sao-row > .rpg-sao-tag{grid-column:1 / -1; grid-row:1;
  width:0; min-width:100%; text-align:left; margin-bottom:1px}
.rpg-sao-vitals.alo .rpg-sao-row > .rpg-sao-bar{grid-column:1; grid-row:2}
.rpg-sao-vitals.alo .rpg-sao-row > .rpg-sao-num{grid-column:2; grid-row:2}
.rpg-sao-vitals.alo .rpg-sao-row.sub > .rpg-sao-tag{font-size:calc(9px * var(--rpg-sao-ui, 1))}
.rpg-sao-bar{position:relative; flex:1 1 auto; min-width:0; width:100%; height:calc(15px * var(--rpg-sao-ui, 1))}
.rpg-sao-bar.mid{height:calc(11px * var(--rpg-sao-ui, 1))}
.rpg-sao-bar.slim{height:calc(9px * var(--rpg-sao-ui, 1)); width:auto}
.rpg-sao-bar svg{position:absolute; inset:0; width:100%; height:100%; display:block;
  filter:drop-shadow(0 1px 3px rgba(0,0,0,.4))}
.rpg-sao-slim .rpg-sao-bar svg{filter:none}

.rpg-sao-slim{opacity:.78; margin-right:calc(56px * var(--rpg-sao-ui, 1))}
.rpg-sao-slim.hide{display:none}
.rpg-sao-row{
  --tagw:calc(50px * var(--rpg-sao-ui, 1)); --numw:calc(58px * var(--rpg-sao-ui, 1));
  display:grid; grid-template-columns:var(--tagw) 1fr var(--numw);
  gap:7px; align-items:center; margin-bottom:3px;
}
.rpg-sao-row > .rpg-sao-tag{grid-column:1}
.rpg-sao-row > .rpg-sao-bar{grid-column:2}
.rpg-sao-row > .rpg-sao-num{grid-column:3}
/* a long name takes its own row, but the bar keeps the same column */
.rpg-sao-row.stacked{margin-bottom:5px}
.rpg-sao-row.stacked > .rpg-sao-tag{grid-column:1 / -1; grid-row:1;
  white-space:normal; overflow:visible; margin-bottom:1px}
.rpg-sao-row.stacked > .rpg-sao-bar{grid-column:2; grid-row:2}
.rpg-sao-row.stacked > .rpg-sao-num{grid-column:3; grid-row:2}
.rpg-sao-row.sub{margin-left:13px; opacity:.85}
.rpg-sao-row.sub{
  --tagw:calc(40px * var(--rpg-sao-ui, 1)); --numw:calc(50px * var(--rpg-sao-ui, 1));
  /* a meter belongs to the bar above it, so it never runs as long */
  grid-template-columns:var(--tagw) minmax(0, 42%) var(--numw) 1fr;
}
.rpg-sao-row.sub .rpg-sao-tag{font-size:calc(9.5px * var(--rpg-sao-ui, 1)); text-decoration:none}
.rpg-sao-row.sub .rpg-sao-bar.slim{height:calc(6px * var(--rpg-sao-ui, 1))}
.rpg-sao-row.sub .rpg-sao-num{font-size:calc(9px * var(--rpg-sao-ui, 1))}
.rpg-sao-tag{min-width:0; font-size:calc(10.5px * var(--rpg-sao-ui, 1)); font-weight:600; color:#ddd9ce; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; background:none; border:0; padding:0; text-align:left}
button.rpg-sao-tag{cursor:pointer; text-decoration:underline;
  text-decoration-color:rgba(255,255,255,.28); text-underline-offset:2px}
button.rpg-sao-tag:hover{color:#fff}
.rpg-sao-tag.foe{color:#f2a99d}
button.rpg-sao-tag.foe{text-decoration-color:rgba(242,169,157,.4)}
button.rpg-sao-tag.foe:hover{color:#ffd0c7}
.rpg-sao-num{font-size:calc(9.5px * var(--rpg-sao-ui, 1)); color:#c2beb4; min-width:0; overflow:hidden;
  text-align:right}

.rpg-sao-div{margin:9px 0 5px; font-size:calc(10px * var(--rpg-sao-ui, 1)); font-weight:700; letter-spacing:2px;
  color:#cdc8bb; display:flex; align-items:center; gap:7px}
.rpg-sao-div::after{content:""; flex:1; height:1px;
  background:linear-gradient(90deg,rgba(220,215,200,.4),transparent)}
.rpg-sao-caret{background:none; border:0; color:inherit; cursor:pointer; order:3;
  font-size:10px; position:relative; z-index:3;
  /* 10x12 was far too small to hit with a finger. The padding makes a much
     bigger tap area; matching negative margins keep the arrow where it was.
     It grows mostly leftwards, since the stack clips anything past its right edge. */
  padding:11px 4px 11px 20px; margin:-11px -2px -11px -18px;
  -webkit-tap-highlight-color:transparent}
.rpg-sao-divlabel{cursor:pointer; -webkit-tap-highlight-color:transparent;
  padding:6px 8px 6px 0; margin:-6px -8px -6px 0}
/* touch screens get bigger still */
@media (pointer:coarse){
  .rpg-sao-caret{padding:14px 6px 14px 30px; margin:-14px -4px -14px -28px; font-size:12px}
  .rpg-sao-divlabel{padding:10px 12px 10px 0; margin:-10px -12px -10px 0}
}

.rpg-sao-foes{margin-top:2px}
.rpg-sao-foes .rpg-sao-div{color:#f0b6ab}
.rpg-sao-npcdiv{color:#bcd4e8}

.rpg-sao-col{position:absolute; right:calc(22px - var(--sao-col-x, 0px));
  top:var(--sao-col-y, 0px); bottom:calc(0px - var(--sao-col-y, 0px));
  padding:calc(env(safe-area-inset-top, 0px) + 12px) 0
          calc(env(safe-area-inset-bottom, 0px) + var(--rpg-sao-clock-lift, 84px) + 58px);
  display:flex; flex-direction:column; justify-content:center; align-items:center;
  pointer-events:none; overflow:visible}
.rpg-sao-colinner{position:relative; display:flex; flex-direction:column; align-items:center;
  gap:clamp(4px, 1.4svh, 14px); pointer-events:none}
.rpg-sao-colinner > *{pointer-events:auto; flex:0 0 auto}
.rpg-sao-orb{width:var(--rpg-sao-orb); height:var(--rpg-sao-orb); border-radius:50%;
  background:radial-gradient(circle at 34% 28%, rgba(255,255,255,.26), rgba(255,255,255,.10));
  border:2px solid rgba(255,255,255,.62);
  box-shadow:0 2px 8px rgba(0,0,0,.35), inset 0 0 14px rgba(255,255,255,.14);
  backdrop-filter:blur(2px); display:grid; place-items:center; cursor:pointer;
  color:rgba(255,255,255,.92); transition:transform .16s, box-shadow .2s, border-color .2s}
.rpg-sao-orb svg{width:48%; height:48%; fill:currentColor;
  filter:drop-shadow(0 1px 1px rgba(0,0,0,.5))}
.rpg-sao-orb:hover{transform:scale(1.07)}
.rpg-sao-orb.on{border-color:#f2c141;
  background:radial-gradient(circle at 34% 28%, #fff6dc, #eeb52b);
  box-shadow:0 0 18px rgba(242,193,65,.9), 0 0 40px rgba(242,193,65,.35),
    0 2px 8px rgba(0,0,0,.45), inset 0 0 12px rgba(255,255,255,.5); color:#4a3714}
.rpg-sao-orb.on svg{filter:none}
.rpg-sao-orb.min{width:clamp(26px, 5svh, 42px); height:clamp(26px, 5svh, 42px); margin-top:2px}
.rpg-sao-rule{width:26px; height:1px; background:rgba(255,255,255,.4)}
.rpg-sao-orb.diag{width:clamp(26px, 5svh, 42px); height:clamp(26px, 5svh, 42px);
  border-color:#f2c141; color:#2a2209; font-weight:700; font-size:18px;
  background:radial-gradient(circle at 34% 28%, #fff6dc, #eeb52b);
  box-shadow:0 0 14px rgba(242,193,65,.8), 0 2px 8px rgba(0,0,0,.45)}

.rpg-sao-dot{width:12px; height:12px; border-radius:50%; background:currentColor;
  box-shadow:0 0 6px currentColor, 0 1px 3px rgba(0,0,0,.8); flex:0 0 auto}
.rpg-sao-dot.ok{color:#5ddb6d} .rpg-sao-dot.warn{color:#f2c141}
.rpg-sao-dot.user{color:#e2574c} .rpg-sao-dot.none{color:#8d8a83}
.rpg-sao-clock .rpg-sao-dot{width:9px; height:9px}

/* centred by flex, not transform, so the text keeps subpixel antialiasing */
.rpg-sao-panelwrap, .rpg-sao-menuwrap{position:absolute; top:0; bottom:0;
  display:flex; align-items:center; padding:12px 0}
#rpg-hud-container .rpg-sao-panelwrap,
#rpg-hud-container .rpg-sao-menuwrap{pointer-events:none}
#rpg-hud-container .rpg-sao-panelwrap > *,
#rpg-hud-container .rpg-sao-menuwrap > *{pointer-events:auto}
.rpg-sao-panelwrap{right:104px}
.rpg-sao-menuwrap{right:104px}
/* with the help sheet open, it sits beyond the menu so both read left-to-right */
.rpg-sao-panelwrap.helpshift{right:326px}

.rpg-sao-panel{position:relative;
  width:336px; max-height:76svh; overflow:hidden; background:var(--rpg-sao-panel);
  box-sizing:border-box; border:3px solid transparent;
  border-top-color:rgba(0,0,0,.22);
  border-right-color:rgba(0,0,0,.14);
  border-bottom-color:rgba(255,255,255,.16);
  border-left-color:rgba(255,255,255,.24);
  box-shadow:0 2px 6px rgba(0,0,0,.5), 0 14px 40px rgba(0,0,0,.6);
  color:var(--rpg-sao-ink); display:flex; flex-direction:column}
.rpg-sao-panelwrap{position:absolute}
/* built from a clipped box rather than borders, so it can carry the same
   sloped top face as the plate it grows out of */
.rpg-sao-notch{position:absolute; width:13px; height:24px; pointer-events:none;
  background:var(--rpg-sao-panel);
  clip-path:polygon(0 0, 100% 50%, 0 100%);
  filter:drop-shadow(1px 1px 1px rgba(0,0,0,.35))}
.rpg-sao-panel h2{margin:0; flex:0 0 auto; padding:11px 16px 8px; font-size:15px; font-weight:600;
  letter-spacing:1.2px; text-align:center; border-bottom:1px solid var(--rpg-sao-rule)}
.rpg-sao-body{padding:11px 16px 15px; overflow-y:auto; min-height:0; flex:1 1 auto}

.rpg-sao-cats{display:flex; flex:0 0 auto; padding:0 10px; gap:2px;
  border-bottom:1px solid var(--rpg-sao-rule)}
.rpg-sao-cat{flex:1 1 auto; padding:6px 2px 5px; font-size:11px; font-weight:700;
  letter-spacing:.4px; color:var(--rpg-sao-ink-dim); cursor:pointer; background:none; border:0;
  border-bottom:2px solid transparent; white-space:nowrap}
.rpg-sao-cat i{font-style:normal; font-size:9.5px; opacity:.7}
.rpg-sao-cat.on{color:var(--rpg-sao-ink); border-bottom-color:#b3903f}
.rpg-sao-cat.foe.on{color:#b34a38; border-bottom-color:#b34a38}

.rpg-sao-who{display:flex; gap:5px; overflow-x:auto; flex:0 0 auto; padding:6px 10px;
  border-bottom:1px solid var(--rpg-sao-rule)}
.rpg-sao-chip{flex:0 0 auto; padding:3px 10px; font-size:11.5px; font-weight:600;
  cursor:pointer; white-space:nowrap; background:var(--rpg-sao-chip); border:1px solid var(--rpg-sao-rule); color:var(--rpg-sao-ink-dim)}
.rpg-sao-chip.on{background:var(--rpg-sao-ink); border-color:var(--rpg-sao-ink);
  color:var(--rpg-sao-panel)}
.rpg-sao-chip.foe{border-color:#d8a89f}
.rpg-sao-chip.foe.on{background:#b34a38; border-color:#b34a38}

.rpg-sao-subtabs{display:flex; gap:3px; margin-bottom:11px; border-bottom:1px solid var(--rpg-sao-rule)}
.rpg-sao-subtab{flex:1; padding:5px 2px; text-align:center; font-size:11px; font-weight:600;
  color:var(--rpg-sao-ink-dim); cursor:pointer; border:0; border-bottom:2px solid transparent; background:none}
.rpg-sao-subtab.on{color:var(--rpg-sao-ink); border-bottom-color:#b3903f}
.rpg-sao-qtab{flex:1; padding:5px 2px; text-align:center; font-size:11px; font-weight:600;
  color:var(--rpg-sao-ink-dim); cursor:pointer; border:0; border-bottom:2px solid transparent; background:none}
.rpg-sao-qtab.on{color:var(--rpg-sao-ink); border-bottom-color:#b3903f}

.rpg-sao-turn{padding:6px 0 7px; border-bottom:1px solid var(--rpg-sao-rule)}
.rpg-sao-turn:last-of-type{border-bottom:0}
.rpg-sao-turnhead{display:flex; justify-content:space-between; align-items:baseline; gap:8px;
  width:100%; padding:0; margin:0 0 3px; background:none; border:0; cursor:pointer;
  color:var(--rpg-sao-ink); text-align:left}
.rpg-sao-turnhead .n{font-size:12px; font-weight:700; letter-spacing:.6px}
.rpg-sao-turnhead .w{font-size:10.5px; color:var(--rpg-sao-ink-dim); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; min-width:0}
.rpg-sao-turnhead:hover .n{text-decoration:underline}
.rpg-sao-changes{list-style:none; margin:0; padding:0; font-size:12px; line-height:1.35}
.rpg-sao-changes li{padding:1px 0 1px 9px; position:relative}
.rpg-sao-changes li::before{content:""; position:absolute; left:0; top:.55em;
  width:4px; height:4px; border-radius:50%; background:var(--rpg-sao-ink-dim)}
.rpg-sao-changes li.good::before{background:#4e9c3f}
.rpg-sao-changes li.bad::before{background:#c0392b}
.rpg-sao-empty.small{font-size:11.5px; margin:2px 0 0}
#rpg-sao-log-more{margin-top:8px; width:100%}
.rpg-sao-logtools{display:flex; gap:6px; justify-content:flex-end; margin:-2px 0 6px}
.rpg-sao-changes li{display:flex; align-items:flex-start; justify-content:space-between; gap:6px}
.rpg-sao-changes li > span{min-width:0; overflow-wrap:anywhere}
.rpg-wd{font-size:11.5px; color:var(--rpg-sao-ink-dim)}
.rpg-wd-del{color:#b23a2a; text-decoration:line-through; background:rgba(178,58,42,.08); padding:0 1px}
.rpg-wd-ins{color:#2f7a26; text-decoration:none; font-weight:700; background:rgba(47,122,38,.08); padding:0 1px}
.rpg-sao-chgbtns{flex:0 0 auto; display:flex; gap:3px}
.rpg-sao-lock{flex:0 0 auto; width:20px; height:18px; padding:0; margin-top:-1px; cursor:pointer;
  display:grid; place-items:center; border-radius:2px; color:var(--rpg-sao-ink-dim);
  background:transparent; border:1px solid var(--rpg-sao-rule); opacity:.55}
.rpg-sao-lock:hover{opacity:1; color:var(--rpg-sao-ink)}
.rpg-sao-lock.on{opacity:1; color:#8a6a12; border-color:#b3903f; background:rgba(179,144,63,.14)}
.rpg-sao-changes li.locked{background:rgba(179,144,63,.10); box-shadow:inset 2px 0 0 #b3903f}
.rpg-sao-revert{flex:0 0 auto; width:20px; height:18px; padding:0; margin-top:-1px; cursor:pointer;
  font-size:11px; line-height:1; border-radius:2px; color:var(--rpg-sao-ink-dim);
  background:transparent; border:1px solid var(--rpg-sao-rule); opacity:.55}
.rpg-sao-revert:hover, .rpg-sao-revert:focus-visible{opacity:1; color:var(--rpg-sao-ink)}

/* jump-to-top / bottom, floating over the panel's lower right */
.rpg-sao-jumps{position:absolute; right:10px; bottom:10px; z-index:2;
  display:flex; flex-direction:column; gap:5px; pointer-events:none}
/* quiet until you reach for them */
.rpg-sao-jumpto{width:24px; height:24px; border-radius:50%; padding:0; cursor:pointer;
  display:grid; place-items:center; color:#fff;
  background:rgba(40,40,44,.22); border:1px solid var(--rpg-sao-ink-dim, #6b6760);
  box-shadow:none; backdrop-filter:blur(1px);
  opacity:0; transform:scale(.8); pointer-events:none;
  transition:opacity .2s, transform .2s, background .2s}
.rpg-sao-jumpto svg{display:block}
.rpg-sao-jumpto.show{opacity:.42; transform:none; pointer-events:auto}
.rpg-sao-jumpto.show:hover, .rpg-sao-jumpto.show:focus-visible{opacity:.95; background:rgba(40,40,44,.55)}
.rpg-sao-vline{display:flex; justify-content:space-between; font-size:13px;
  padding:3px 0; border-bottom:1px solid var(--rpg-sao-rule)}
.rpg-sao-sub{margin-top:9px; font-size:10px; font-weight:700; letter-spacing:1.4px; color:var(--rpg-sao-ink-dim)}
.rpg-sao-grid{display:grid; grid-template-columns:1fr 1fr; gap:5px 14px; font-size:13px; margin-top:9px}
.rpg-sao-grid div{display:flex; justify-content:space-between;
  border-bottom:1px dotted var(--rpg-sao-rule); padding-bottom:2px; gap:6px}
.rpg-sao-grid span:last-child{font-weight:700; text-align:right}
.rpg-sao-grid details, .rpg-sao-vline details{display:inline-block}
.rpg-sao-grid details > span, .rpg-sao-vline details > span{
  position:static !important; display:block !important;
  min-width:0 !important; max-width:none !important;
  margin-top:4px; text-align:left; font-weight:400;
  background:rgba(20,20,24,.9) !important; color:#dcd8d0 !important;
  border-color:rgba(255,255,255,.18) !important;
}
.rpg-sao-grid div, .rpg-sao-vline{align-items:flex-start}
.rpg-sao-status{margin-top:9px; font-size:12.5px}
.rpg-sao-status b{color:#b4472f}
.rpg-sao-empty{font-size:12.5px; color:var(--rpg-sao-ink-dim); font-style:italic}
.rpg-sao-entries{list-style:none; margin:0; padding:0; font-size:13px}
.rpg-sao-entries li{padding:5px 0; border-bottom:1px solid var(--rpg-sao-rule); line-height:1.35}
.rpg-sao-entries li:last-child{border-bottom:0}

.rpg-sao-help{margin:0}
.rpg-sao-help-item{padding:6px 0; border-bottom:1px solid var(--rpg-sao-rule)}
.rpg-sao-help-item:last-child{border-bottom:0}
.rpg-sao-help dt{font-size:12.5px; font-weight:700}
.rpg-sao-help dd{margin:2px 0 0; font-size:12px; line-height:1.35; color:var(--rpg-sao-ink-dim)}
.rpg-sao-help-sec{margin:12px 0 2px; font-size:10px; font-weight:700;
  letter-spacing:1.6px; color:var(--rpg-sao-ink-dim); border-bottom:1px solid var(--rpg-sao-rule);
  padding-bottom:3px}

.rpg-sao-panelhead{display:flex; justify-content:flex-end; margin-bottom:6px}

.rpg-sao-subhead{display:flex; align-items:center; justify-content:space-between;
  margin-top:9px; border-bottom:1px solid var(--rpg-sao-rule); padding-bottom:3px}
.rpg-sao-subhead .rpg-sao-sub{margin:0}
.rpg-sao-swatch{display:inline-block; width:9px; height:9px; border-radius:2px;
  margin-right:6px; vertical-align:0; box-shadow:inset 0 0 0 1px rgba(0,0,0,.25)}

.rpg-sao-meditor{padding-top:6px}
.rpg-sao-mrow-edit{display:grid; align-items:center; gap:4px; margin-bottom:5px;
  grid-template-columns:auto 26px minmax(0,1fr) 44px 8px 44px 22px 22px}
.rpg-sao-mrow-edit input[type=text]{min-width:0; width:100%; box-sizing:border-box;
  font:inherit; font-size:12px; padding:3px 5px; color:var(--rpg-sao-ink);
  background:var(--rpg-sao-chip); border:1px solid var(--rpg-sao-rule); border-radius:2px}
.rpg-sao-tilecolor b{display:flex; align-items:center; gap:6px}
.rpg-mathnum{cursor:pointer; -webkit-tap-highlight-color:transparent}
.rpg-mathnum i{font-style:normal; font-size:.72em; opacity:.7; margin-left:1px}
.rpg-sao-move b{display:flex; gap:5px; flex-wrap:wrap; justify-content:flex-end}
.rpg-sao-entries.with-icons li.has-ico{display:flex; gap:8px; align-items:center}
.rpg-sao-li-body{flex:1; min-width:0}
.rpg-sao-ico{flex:0 0 auto; display:grid; place-items:center; width:24px; height:24px; padding:0;
  border-radius:50%; border:1px solid var(--rpg-sao-rule); background:var(--rpg-sao-chip); color:var(--rpg-sao-ink)}
button.rpg-sao-ico{cursor:pointer; -webkit-tap-highlight-color:transparent}
button.rpg-sao-ico:hover{border-color:#b3903f; color:#8a6a12}
.rpg-sao-ico svg{width:16px; height:16px; display:block; fill:none; stroke:currentColor; stroke-width:1.7;
  stroke-linecap:round; stroke-linejoin:round}
.rpg-sao-empty .rpg-sao-ico{display:inline-grid; width:auto; padding:0 6px; height:auto; margin:0 0 0 4px; border-radius:4px}
.rpg-sao-ledit{display:flex; gap:6px; align-items:flex-start; margin-bottom:6px}
.rpg-sao-ledit > .rpg-sao-ico{align-self:center}
.rpg-sao-icopick{display:flex; flex-wrap:wrap; gap:4px; margin:-2px 0 8px; padding:6px; border:1px dashed var(--rpg-sao-rule, #b9b9b9); border-radius:4px}
.rpg-sao-icopick .on, .rpg-sao-ledit-ico.picking{border-color:#b3903f; color:#8a6a12; box-shadow:inset 0 0 0 1px #b3903f}
.rpg-sao-icopick .auto{width:auto; padding:0 8px; font:inherit; font-size:.85em}
.rpg-sao-ledit-ico.custom{position:relative}
.rpg-sao-ledit-ico.custom::after{content:""; position:absolute; top:-3px; right:-3px; width:7px; height:7px; border-radius:50%;
  background:#3d9be0; box-shadow:0 0 0 1.5px #fff}
.rpg-sao-reorder{flex:0 0 auto; display:flex; flex-direction:column; gap:2px}
.rpg-sao-mv{width:18px; height:13px; padding:0; cursor:pointer; font-size:8px; line-height:1; border-radius:2px;
  color:var(--rpg-sao-ink); background:var(--rpg-sao-chip); border:1px solid var(--rpg-sao-rule);
  -webkit-tap-highlight-color:transparent}
.rpg-sao-mv:hover:not(:disabled){border-color:#b3903f; color:#8a6a12}
.rpg-sao-mv:disabled{opacity:.3; cursor:default}
@media (pointer:coarse){ .rpg-sao-mv{width:22px; height:18px; font-size:9px} }
.rpg-sao-ledit-text{flex:1; min-width:0; box-sizing:border-box; resize:vertical; font:inherit; font-size:12px; line-height:1.35;
  padding:4px 6px; color:var(--rpg-sao-ink); background:var(--rpg-sao-chip); border:1px solid var(--rpg-sao-rule); border-radius:2px}
.rpg-sao-ledit-del{flex:0 0 auto; width:22px; height:22px; padding:0; cursor:pointer; font-size:12px; border-radius:2px;
  background:var(--rpg-sao-chip); border:1px solid var(--rpg-sao-rule); color:var(--rpg-sao-ink)}
.rpg-sao-ledit-del:hover{color:#c0392b; border-color:#c0392b}
.rpg-sao-ledit-side{flex:0 0 auto; display:flex; flex-direction:column; gap:4px}
.rpg-sao-ledit-lock{width:22px; height:22px; padding:0; cursor:pointer; display:grid; place-items:center; border-radius:2px;
  background:var(--rpg-sao-chip); border:1px solid var(--rpg-sao-rule); color:var(--rpg-sao-ink-dim)}
.rpg-sao-ledit-lock.on{color:#8a6a12; border-color:#b3903f; background:rgba(179,144,63,.16)}
.rpg-sao-poslock{flex:0 0 auto; display:grid; place-items:center; color:#8a6a12; opacity:.85}
#rpg-sao-edithist, #rpg-sao-toastsecs{width:52px; font:inherit; font-size:12px; padding:2px 4px; text-align:center}
.rpg-sao-customfont input{width:100%; box-sizing:border-box; font:inherit; font-size:12px; padding:4px 6px;
  color:var(--rpg-sao-ink); background:var(--rpg-sao-chip); border:1px solid var(--rpg-sao-rule); border-radius:2px}
.rpg-sao-livebond b{display:flex; align-items:center; gap:4px}
.rpg-sao-livebond i{font-style:normal; font-weight:400; font-size:10px; color:var(--rpg-sao-ink-dim)}
.rpg-sao-livebond input{width:44px; text-align:right; font:inherit; font-size:12px; padding:2px 5px;
  color:var(--rpg-sao-ink); background:var(--rpg-sao-chip); border:1px solid var(--rpg-sao-rule); border-radius:2px}
.rpg-sao-tilecolor input[type=color]{width:30px; height:22px; padding:0; cursor:pointer;
  border:1px solid var(--rpg-sao-rule); border-radius:3px; background:none}
.rpg-sao-mrow-edit input[type=color]{width:26px; height:24px; padding:0; border:1px solid var(--rpg-sao-rule);
  border-radius:3px; background:none; cursor:pointer}
.rpg-sao-m-slash{text-align:center; color:var(--rpg-sao-ink-dim)}
.rpg-sao-m-auto, .rpg-sao-m-del{width:22px; height:22px; padding:0; cursor:pointer; font-size:12px;
  background:var(--rpg-sao-chip); border:1px solid var(--rpg-sao-rule); color:var(--rpg-sao-ink); border-radius:2px}
.rpg-sao-m-auto.off{visibility:hidden}
.rpg-sao-m-del:hover{color:#c0392b; border-color:#c0392b}
.rpg-sao-medit-actions{display:flex; justify-content:flex-end; gap:6px; margin-top:8px}
.rpg-sao-mini.primary{background:#4e9c3f; border-color:#4e9c3f; color:#fff}

.rpg-sao-mast-edit{display:grid; align-items:center; gap:4px; margin-bottom:5px;
  grid-template-columns:auto minmax(0,1fr) 44px 8px 44px 22px}
.rpg-sao-mast-edit input[type=text]{min-width:0; width:100%; box-sizing:border-box;
  font:inherit; font-size:12px; padding:3px 5px; color:var(--rpg-sao-ink);
  background:var(--rpg-sao-chip); border:1px solid var(--rpg-sao-rule); border-radius:2px}
.rpg-sao-ms-del{width:22px; height:22px; padding:0; cursor:pointer; font-size:12px; border-radius:2px;
  background:var(--rpg-sao-chip); border:1px solid var(--rpg-sao-rule); color:var(--rpg-sao-ink)}
.rpg-sao-ms-del:hover{color:#c0392b; border-color:#c0392b}
.rpg-sao-hint{font-size:10.5px; color:var(--rpg-sao-ink-dim); margin:2px 0 6px}

.rpg-sao-li-top{display:flex; justify-content:space-between; align-items:baseline; gap:8px}
.rpg-sao-li-top i{font-style:normal; color:var(--rpg-sao-ink-dim); font-size:11px}
.rpg-sao-li-top b{font-size:11.5px; font-weight:700; white-space:nowrap}
.rpg-sao-pbar{position:relative; height:5px; margin-top:4px; background:#ddd9cf;
  border:1px solid #c2bdb1; overflow:hidden}
.rpg-sao-pbar > div{position:absolute; left:0; top:0; bottom:0;
  background:linear-gradient(180deg,#b39ddb,#7e57c2)}
.rpg-sao-mini{background:var(--rpg-sao-chip); border:1px solid var(--rpg-sao-rule); color:var(--rpg-sao-ink);
  font-size:11px; font-weight:600; padding:2px 8px; cursor:pointer}
.rpg-sao-mini:hover{filter:brightness(1.06)}

.rpg-sao-bond{padding:6px 0; border-bottom:1px solid var(--rpg-sao-rule)}
.rpg-sao-bond:last-child{border-bottom:0}
.rpg-sao-bondtop{display:flex; align-items:center; gap:6px; font-size:13px}
.rpg-sao-bondtop .here{color:#4e9c3f; font-size:10px}
.rpg-sao-bondtop .away{color:#b3ada0; font-size:10px}
.rpg-sao-who-name{flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; background:none; border:0; padding:0; text-align:left;
  color:inherit; font-size:13px}
button.rpg-sao-who-name{cursor:pointer; text-decoration:underline; text-decoration-color:#bdb7a9}
.rpg-sao-bondval{font-weight:700}
.rpg-sao-delta{font-size:11px; font-weight:700}
.rpg-sao-delta.up{color:#3f8f34} .rpg-sao-delta.down{color:#c0392b}
.rpg-sao-new{color:#3f8f34; font-size:10px; font-weight:700}
.rpg-sao-bondtrack{position:relative; height:5px; margin-top:4px;
  background:#ddd9cf; border:1px solid #c2bdb1}
.rpg-sao-bondtrack .b{position:absolute; top:0; bottom:0;
  background:linear-gradient(180deg,#f7a0c0,#e0568f)}
.rpg-sao-ghost{position:absolute; top:0; bottom:0; opacity:.5}

.rpg-sao-quest{padding:4px 0; border-bottom:1px solid var(--rpg-sao-rule); font-size:13px; line-height:1.3}
.rpg-sao-quest:last-child{border-bottom:0}
.rpg-sao-place{font-size:20px; font-weight:600; letter-spacing:.5px}
.rpg-sao-weather{font-size:13px; color:var(--rpg-sao-ink-dim); margin:2px 0 10px}
.rpg-sao-env{font-size:12.5px; padding:4px 0; border-bottom:1px solid var(--rpg-sao-rule)}
.rpg-sao-env:last-child{border-bottom:0}

.rpg-sao-menu{position:relative; width:206px; max-height:76svh; overflow-y:auto}
.rpg-sao-mrow{display:flex; align-items:center; gap:9px; padding:7px 11px; margin-bottom:2px;
  width:100%; text-align:left; background:var(--rpg-sao-panel);
  /* Real borders mitre at the corner, so the two faces meet on a diagonal.
     Stacked inset shadows instead overlapped there and went muddy. */
  box-sizing:border-box; border:3px solid transparent;
  border-top-color:rgba(0,0,0,.24);
  border-right-color:rgba(0,0,0,.15);
  border-bottom-color:rgba(255,255,255,.17);
  border-left-color:rgba(255,255,255,.26);
  box-shadow:0 2px 5px rgba(0,0,0,.5), 0 8px 22px rgba(0,0,0,.45);
  color:var(--rpg-sao-ink); font-size:12.5px; font-weight:600; cursor:pointer}
.rpg-sao-mrow .pip{flex:0 0 22px; height:22px; border-radius:50%; background:#6b6355;
  color:#fff; display:grid; place-items:center; font-size:11px}
.rpg-sao-mrow:hover{filter:brightness(1.06)}
.rpg-sao-build{margin-top:4px; padding:4px 11px; background:var(--rpg-sao-panel);
  font-size:10px; letter-spacing:.5px; text-align:right; color:var(--rpg-sao-ink-dim); opacity:.8}
.rpg-sao-mrow.toggle{cursor:default; justify-content:space-between; gap:6px}
.rpg-sao-mrow select{font-family:inherit; font-size:12px; background:var(--rpg-sao-chip);
  border:1px solid var(--rpg-sao-rule); color:var(--rpg-sao-ink); padding:2px 4px}
.rpg-sao-mrow input[type=range]{width:78px; flex:0 0 auto}
.rpg-sao-switch{position:relative; width:34px; height:18px; border-radius:9px;
  background:#bdb7a9; cursor:pointer; transition:background .2s; flex:0 0 auto; border:0}
.rpg-sao-switch::after{content:""; position:absolute; top:2px; left:2px; width:14px; height:14px;
  border-radius:50%; background:#fff; transition:transform .2s}
.rpg-sao-switch.on{background:#4e9c3f}
.rpg-sao-switch.on::after{transform:translateX(16px)}

/* --rpg-sao-clock-lift: how far above the chat box the clock sits. One number;
   the orb column reserves this much space too, so the two can't overlap. */
#rpg-hud-container{--rpg-sao-clock-lift:84px; --rpg-sao-orb:clamp(30px, 6.2svh, 54px)}
/* Panel brightness walks the paper's LIGHTNESS down while it stays solid, so
   it dims instead of going see-through. Rules and chips follow it. */
#rpg-hud-container{
  --rpg-sao-panel-l:92%;
  --rpg-sao-panel-s:10%;   /* raise for warmer paper, 0% for neutral grey */
  --rpg-sao-panel:hsl(44 var(--rpg-sao-panel-s) var(--rpg-sao-panel-l));
  /* --rpg-sao-ink, --rpg-sao-ink-dim, --rpg-sao-rule and --rpg-sao-chip are set
     on the container, because they have to flip once the panel goes dark. */
}
.rpg-sao-clockwrap{position:absolute; right:calc(22px - var(--sao-clock-x, 0px));
  bottom:calc(env(safe-area-inset-bottom, 0px) + var(--rpg-sao-clock-lift, 84px)
              - var(--sao-clock-y, 0px));
  display:flex; flex-direction:column; align-items:flex-end; gap:8px}
.rpg-sao-timers{position:relative; width:252px; background:var(--rpg-sao-panel);
  box-sizing:border-box; border:3px solid transparent;
  border-top-color:rgba(0,0,0,.22); border-right-color:rgba(0,0,0,.14);
  border-bottom-color:rgba(255,255,255,.16); border-left-color:rgba(255,255,255,.24); box-shadow:0 2px 6px rgba(0,0,0,.5), 0 12px 34px rgba(0,0,0,.58);
  color:var(--rpg-sao-ink); padding:8px 12px 10px; max-height:52svh; overflow-y:auto}
.rpg-sao-timerhead{display:flex; justify-content:space-between; align-items:center;
  border-bottom:1px solid var(--rpg-sao-rule); padding-bottom:4px; margin-bottom:6px}
.rpg-sao-timerhead h3{margin:0; font-size:11px; font-weight:700; letter-spacing:1.6px; color:var(--rpg-sao-ink-dim)}
.rpg-sao-timerhead span{display:flex; gap:4px}
.rpg-sao-timer{padding:5px 0; border-bottom:1px solid var(--rpg-sao-rule)}
.rpg-sao-timer:last-child{border-bottom:0}
.rpg-sao-timer.spent{opacity:.5}
.rpg-sao-tline{display:flex; align-items:center; gap:6px; font-size:12.5px}
.rpg-sao-tname{flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.rpg-sao-owner{color:var(--rpg-sao-ink-dim); font-size:11px}
.rpg-sao-tleft{font-weight:700}
.rpg-sao-tbar{position:relative; height:3px; margin-top:4px; background:#ddd9cf}
.rpg-sao-tuse{flex:0 0 auto; margin-left:4px; padding:0 5px; height:17px; line-height:15px; cursor:pointer;
  font-size:10.5px; font-weight:700; border-radius:2px; color:var(--rpg-sao-ink);
  background:var(--rpg-sao-chip); border:1px solid var(--rpg-sao-rule)}
.rpg-sao-tuse:hover{filter:brightness(1.08)}
.rpg-sao-tbar div{position:absolute; top:0; bottom:0; left:0}

.rpg-sao-clock{display:flex; align-items:center; gap:9px; background:none; border:0;
  padding:2px 0; cursor:pointer; color:#f2f0e8}

/* Optional legibility aids for the text that sits straight on the chat, with
   nothing behind it. Both off by default; Settings > Text shadow / backing. */
#rpg-hud-container.rpg-sao-sh .rpg-sao-name,
#rpg-hud-container.rpg-sao-sh .rpg-sao-tag,
#rpg-hud-container.rpg-sao-sh .rpg-sao-num,
#rpg-hud-container.rpg-sao-sh .rpg-sao-vnum,
#rpg-hud-container.rpg-sao-sh .rpg-sao-div,
#rpg-hud-container.rpg-sao-sh .rpg-sao-cstack .hhmm,
#rpg-hud-container.rpg-sao-sh .rpg-sao-cstack .date{text-shadow:0 1px 2px rgba(0,0,0,.8)}
#rpg-hud-container.rpg-sao-sh .rpg-sao-glyph{filter:drop-shadow(0 1px 2px rgba(0,0,0,.8))}

#rpg-hud-container.rpg-sao-bk .rpg-sao-group{
  background:rgba(13,15,19,.55); border:1px solid rgba(255,255,255,.12);
  border-radius:3px; padding:4px 7px 6px; margin-right:52px; backdrop-filter:blur(2px)}
#rpg-hud-container.rpg-sao-bk .rpg-sao-group .rpg-sao-div{margin-top:2px}
#rpg-hud-container.rpg-sao-bk .rpg-sao-group .rpg-sao-slim{margin-right:0}
#rpg-hud-container.rpg-sao-bk .rpg-sao-clock{
  background:rgba(13,15,19,.55); border:1px solid rgba(255,255,255,.12);
  border-radius:3px; padding:3px 10px 4px; backdrop-filter:blur(2px)}
.rpg-sao-glyph{font-size:17px}
.rpg-sao-cstack{text-align:right; line-height:1}
.rpg-sao-cstack .hhmm{display:block; font-size:30px; font-weight:600; letter-spacing:3px}
.rpg-sao-cstack .date{display:block; font-size:11px; letter-spacing:1.6px; color:#d5d1c6;
  margin-top:2px}

/* the classic bond/timer editors get dropped in as-is, so give them a dark bed */
.rpg-sao-classic{background:rgba(12,12,16,.94); margin:-11px -16px -15px; padding:10px 12px;
  color:#e0e0e0; font-family:'Courier New',monospace; font-size:12px}
/* the error overlay is absolutely positioned in the classic skin; un-pin it here */
.rpg-sao-errbed{position:relative; min-height:220px}
.rpg-sao-errbed #rpg-error-overlay{position:relative !important; inset:auto !important;
  background:none !important; border:0 !important; padding:0 !important}
.rpg-sao-timers .rpg-sao-classic{margin:-8px -12px -10px}

@media (max-width:720px){
  .rpg-sao-vitals{width:min(72vw, calc(268px * var(--rpg-sao-ui, 1)), calc(100vw - 96px))}
  .rpg-sao-slim{margin-right:calc(44px * var(--rpg-sao-ui, 1))}
  .rpg-sao-panelwrap{right:auto; left:12px}
  .rpg-sao-panel{width:calc(100vw - 108px); max-width:330px; max-height:62svh}
  .rpg-sao-menuwrap{right:calc(12px + var(--rpg-sao-orb) + 26px); left:auto}
  .rpg-sao-menu{width:min(206px, calc(100vw - var(--rpg-sao-orb) - 62px))}
  .rpg-sao-menuwrap.hashelp{display:none}
  .rpg-sao-panelwrap.helpshift{right:auto; left:12px}
  .rpg-sao-col{right:calc(12px - var(--sao-col-x, 0px))}
  .rpg-sao-clockwrap{right:calc(12px - var(--sao-clock-x, 0px))}
  .rpg-sao-timers{width:min(74vw,246px)}
  .rpg-sao-cstack .hhmm{font-size:20px; letter-spacing:2px}
  .rpg-sao-cstack .date{font-size:10px}
  .rpg-sao-glyph{font-size:14px}
}
/* Entry animations are opt-in per render: the observer redraws the HUD every
   couple of seconds, and replaying these each time would be a strobe. */
@keyframes rpgSaoOrbIn{
  from{opacity:0; transform:translateX(14px) scale(.72)}
  to{opacity:1; transform:none}
}
#rpg-hud-container.layout .rpg-sao-colinner{pointer-events:auto}

/* The overlay is measured from the content, so it always sits on what you
   can see, whatever shape the underlying element happens to be.
   NB: .rpg-sao-ghost is taken — that's the bond delta segment. */
.rpg-sao-mover{
  position:absolute; z-index:6; box-sizing:border-box;
  border:1px dashed rgba(255,255,255,.7); border-radius:3px;
  background:rgba(120,160,220,.07); cursor:move; touch-action:none;
  font-size:9px; font-weight:700; letter-spacing:1.2px; color:#f2c141;
  padding:1px 4px; line-height:1.1; text-align:right;
}
.rpg-sao-mover.dragging{border:2px solid #f2c141; background:rgba(242,193,65,.12)}
.rpg-sao-guide{position:absolute; z-index:7; pointer-events:none;
  background:#4fc3f7; box-shadow:0 0 6px rgba(79,195,247,.8)}
/* nothing underneath responds while arranging; the overlay catches it all */
#rpg-hud-container.layout [data-drag],
#rpg-hud-container.layout [data-drag] *{pointer-events:none !important}
/* only clipping changes, so a group can be pulled clear of the stack */
#rpg-hud-container.layout .rpg-sao-vitals{overflow:visible}
#rpg-sao-layout-bar{
  position:absolute; left:50%; transform:translateX(-50%);
  bottom:calc(env(safe-area-inset-bottom, 0px) + 12px);
  display:flex; gap:6px; align-items:center; z-index:5;
  background:rgba(14,16,20,.92); border:1px solid rgba(255,255,255,.25);
  border-radius:4px; padding:6px 8px; color:#e8e6e0; font-size:12px; font-weight:600;
}
#rpg-sao-layout-bar button{
  font-family:inherit; font-size:12px; font-weight:700; cursor:pointer;
  background:#f2c141; color:#2a2209; border:0; padding:4px 12px; border-radius:3px;
}
#rpg-sao-layout-bar button.ghost{background:transparent; color:#cfcbc2; border:1px solid #4a4d55}
#rpg-sao-layout-bar button.ghost.on{color:#f2c141; border-color:#f2c141}

@keyframes rpgSaoFadeIn{ from{opacity:0} to{opacity:1} }
@keyframes rpgSaoRise{ from{opacity:0; transform:translateY(8px)} to{opacity:1; transform:none} }
@keyframes rpgSaoDotIn{
  0%{transform:scale(.45); opacity:0}
  62%{transform:scale(1.18); opacity:1}
  100%{transform:scale(1); opacity:1}
}
@keyframes rpgSaoPanelIn{
  from{opacity:0; transform:translateX(10px)}
  to{opacity:1; transform:none}
}

#rpg-hud-container.anim-restore .rpg-sao-colinner > *{
  animation:rpgSaoOrbIn .26s cubic-bezier(.2,.8,.3,1) backwards;
}
#rpg-hud-container.anim-restore .rpg-sao-clockwrap{animation:rpgSaoFadeIn .34s ease-out .12s backwards}
#rpg-hud-container.anim-restore .rpg-sao-vitals.fadein{animation:rpgSaoRise .42s cubic-bezier(.2,.8,.3,1) backwards}
#rpg-hud-container.anim-restore #rpg-sao-min{animation:rpgSaoOrbIn .26s cubic-bezier(.2,.8,.3,1) .27s backwards}
#rpg-hud-container.anim-collapse #rpg-sao-min{animation:rpgSaoDotIn .34s cubic-bezier(.3,1.4,.4,1) backwards}
#rpg-hud-container.anim-collapse .rpg-sao-dot{animation:rpgSaoFadeIn .3s ease-out .06s backwards}
#rpg-hud-container.anim-panel .rpg-sao-panelwrap,
#rpg-hud-container.anim-panel .rpg-sao-menuwrap{
  animation:rpgSaoPanelIn .2s cubic-bezier(.2,.8,.3,1) backwards;
}

@media (prefers-reduced-motion:reduce){
  #rpg-hud-container *{transition:none !important; animation:none !important}
}
</style>`;

// --- 5. EDITOR RENDERER ---
function renderEditor() {
  let container = document.getElementById("rpg-hud-container");
  if (!container) return;

  // The SAO skin leaves the container as a full-screen click-through overlay,
  // which the editor is not built for. Give it a normal panel box first.
  if ((uiSettings.skin || "classic") === "sao") {
    container.style.cssText = `position:fixed; top:50px; right:12px; left:auto;
      width:min(${uiSettings.hudWidth || 280}px, calc(100vw - 24px));
      max-height:calc(100svh - 120px); overflow-y:auto;
      background:rgba(12,12,16,0.97); border:1px solid #444; border-radius:6px;
      padding:10px; box-sizing:border-box; z-index:10000; pointer-events:auto;
      color:#e0e0e0; box-shadow:0 10px 34px rgba(0,0,0,.6);
      font-family:${uiSettings.fontFamily}; font-size:${0.9 * (uiSettings.fontScale || 1)}em;`;
  }

  const { root, display, type, isVehicle } = getActiveData();

const { curr: energyCurr, max: energyMax, label: energyLabel } = getEnergy(display, isVehicle);

  let editorHeader = "✏️ EDIT MODE";
  let headerColor = "#4FC3F7";
  if (isVehicle) {
    const vType = String(root.vehicle.type || "mecha").toLowerCase();
    if (vType === "ship") {
      editorHeader = "🚀 EDIT SHIP";
      headerColor = "#00E5FF";
    } else if (vType === "car") {
      editorHeader = "🚗 EDIT CAR";
      headerColor = "#FF9800";
    } else if (vType === "transport") {
      editorHeader = "🚊 EDIT TRANSPORT";
      headerColor = "#8BC34A";
    } else {
      editorHeader = "🤖 EDIT MECHA";
      headerColor = "#E040FB";
    }
  } else if (type === "enemy") {
    editorHeader = "⚔️ EDIT ENEMY";
    headerColor = "#ff5252";
  } else if (type === "npc") {
    editorHeader = "👤 EDIT NPC";
    headerColor = "#00e5ff";
  }

  function labelStyle() {
    return `font-size:0.7em; color:#aaa; margin-bottom:2px;`;
  }

  let globalSection =
    charIndex === 0
      ? `
  <div style="background:rgba(255,255,255,0.05); padding:5px; margin-bottom:10px; border-radius:4px;">
    <div style="margin-bottom:5px; font-size:0.8em; color:#aaa;">Global Data</div>

    <div style="display:flex; gap:6px; align-items:center; margin-bottom:6px;">
      <input id="edit-location" type="text" value="${escAttr(rpgState.location || "")}"
        style="flex:1; background:#222; border:1px solid #555; color:white;"> 📍
    </div>

    <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:6px; margin-bottom:10px;">
      <div>
        <div style="${labelStyle()}">Month</div>
        <input id="edit-month" type="text" value="${escAttr(rpgState.world_time?.month ?? "Jan")}"
          style="width:100%; background:#222; border:1px solid #555; color:white;">
      </div>
      <div>
        <div style="${labelStyle()}">Day</div>
        <input id="edit-day" type="number" value="${escAttr(rpgState.world_time?.day ?? 1)}"
          style="width:100%; background:#222; border:1px solid #555; color:white;">
      </div>
	  <div>
        <div style="${labelStyle()}">Year</div>
        <input id="edit-year" type="text" value="${escAttr(rpgState.world_time?.year ?? "")}"
          style="width:100%; background:#222; border:1px solid #555; color:white;">
      </div>
      <div>
        <div style="${labelStyle()}">Weekday</div>
        <select id="edit-weekday" style="width:100%; background:#222; border:1px solid #555; color:white;">
          ${(() => {
            const wt = rpgState.world_time || {};
            const written = wt.weekday ? String(wt.weekday).slice(0, 3).toLowerCase() : "";
            const auto = worldWeekday({ month: wt.month, day: wt.day, year: wt.year }, false);
            const cur = !written ? "none" : auto && auto.toLowerCase() === written ? "auto" : written;
            const opt = (v, label) => `<option value="${v}"${cur === v ? " selected" : ""}>${label}</option>`;
            return opt("none", "None") + opt("auto", `Auto${auto ? " (" + auto + ")" : ""}`) +
              WEEKDAYS.map((d) => opt(d.slice(0, 3).toLowerCase(), d)).join("");
          })()}
        </select>
      </div>
      <div>
        <div style="${labelStyle()}">Clock</div>
        <input id="edit-clock" type="text" value="${escAttr(rpgState.world_time?.clock ?? "12:00")}"
          style="width:100%; background:#222; border:1px solid #555; color:white;">
      </div>
      <div>
        <div style="${labelStyle()}">Weather</div>
        <input id="edit-weather" type="text" value="${escAttr(rpgState.world_time?.weather ?? "Unknown")}"
          style="width:100%; background:#222; border:1px solid #555; color:white;">
      </div>
    </div>

    <div style="margin-bottom:10px;">
      <div style="${labelStyle()}">Quests</div>
      <textarea id="edit-quests" style="width:100%; height:50px; background:#222; border:1px solid #555; color:white;">${escTextarea(
        (rpgState.quests || []).join("\n")
      )}</textarea>
    </div>

    <div style="border-top:1px solid #555; padding-top:5px;">
      <div style="${labelStyle()}">Env Effects</div>
      <textarea id="edit-env" style="width:100%; height:40px; background:#222; border:1px solid #555; color:white;">${escTextarea(
        (rpgState.env_effects || []).join("\n")
      )}</textarea>
    </div>

	<div style="border-top:1px solid #555; padding-top:5px; margin-top:5px;">
      <div style="${labelStyle()}">Bond Ledger (Name | value)</div>
      <textarea id="edit-bonds" style="width:100%; height:60px; background:#222; border:1px solid #555; color:white;">${escTextarea(
        bondLedgerToEditorText(rpgState.bonds)
      )}</textarea>
    </div>
  </div>
`
      : "";

  const checked = root.vehicle && root.vehicle.active ? "checked" : "";
  const vehicleType = root.vehicle && root.vehicle.type ? root.vehicle.type : "mecha";
  const vToggle = `
  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; background:#333; padding:5px; border-radius:3px;">
    <div style="display:flex; align-items:center; gap:5px;">
      <input id="edit-vehicle-active" type="checkbox" ${checked} style="transform:scale(1.2);">
      <div style="color:#fff; font-weight:bold; font-size:0.8em;">Active</div>
    </div>
    <select id="edit-vehicle-type" style="background:#222; color:#fff; border:1px solid #555; font-size:0.8em;">
      <option value="mecha" ${vehicleType === "mecha" ? "selected" : ""}>Mecha</option>
      <option value="ship" ${vehicleType === "ship" ? "selected" : ""}>Ship</option>
      <option value="car" ${vehicleType === "car" ? "selected" : ""}>Car</option>
      <option value="transport" ${vehicleType === "transport" ? "selected" : ""}>Transport</option>
    </select>
  </div>`;

  let bondInput = "";
  if ((type === "party" || type === "npc") && !isVehicle) {
    bondInput = `<div style="margin-bottom:10px;"><div style="${labelStyle()}">Bond (0-100)</div><input id="edit-bond" type="text" value="${escAttr(
      (root.bond ?? 0)
    )}" style="width:100%; background:#222; color:white;"></div>`;
  }

  const context = SillyTavern.getContext();
  const realUserName = context?.name1 || context?.user_name || "You";
  let editNameVal = display.name;
  if (editNameVal === "{{user}}") editNameVal = realUserName;

  const metersText = metersToEditorText(display.meters);

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px solid #333; padding-bottom:5px;">
      <div style="color:${headerColor}; font-weight:bold;">${escHtml(editorHeader)}</div>
      <div style="display:flex; gap:6px;">
        <button id="rpg-cancel-btn" style="background:#444; border:1px solid #777; color:white; cursor:pointer; font-size:10px; padding:3px 10px; font-weight:bold;">CANCEL</button>
        <button id="rpg-save-btn" style="background:#2e7d32; border:1px solid #66bb6a; color:white; cursor:pointer; font-size:10px; padding:3px 10px; font-weight:bold;">SAVE</button>
      </div>
    </div>

    <div style="height: 390px; overflow-y: auto; padding-right:5px;">
      ${globalSection}
      ${vToggle}

      <div style="display:flex; gap:6px; align-items:center; margin-bottom:10px;">
        <div style="flex:1;">
          <div style="${labelStyle()}">Name</div>
          <input id="edit-name" type="text" value="${escAttr(editNameVal)}" style="width:100%; background:#222; border:1px solid #555; color:white;">
        </div>
        <div style="width:80px;">
          <div style="${labelStyle()}">💰 Coin</div>
          <input id="edit-coin" type="number" value="${escAttr(display.dankcoin ?? 0)}" style="width:100%; background:#222; border:1px solid #555; color:#FFD700;">
        </div>
      </div>

      ${bondInput}

      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:5px; margin-bottom:10px;">
        <div><div style="${labelStyle()}">${escHtml(isVehicle ? "Hull" : "HP")} Curr</div><input id="edit-hp-curr" type="text" value="${escAttr(
          display.hp_curr
        )}" style="width:100%; background:#222; color:white;">
        </div>
        <div><div style="${labelStyle()}">${escHtml(isVehicle ? "Hull" : "HP")} Max</div><input id="edit-hp-max" type="text" value="${escAttr(
          display.hp_max
        )}" style="width:100%; background:#222; color:white;">
        </div>
        <div><div style="${labelStyle()}">${escHtml(isVehicle ? "En/Mp" : "MP")} Curr</div>
          <input id="edit-mp-curr" type="text" value="${escAttr(energyCurr)}" style="width:100%; background:#222; color:white;">
        </div>
        <div><div style="${labelStyle()}">${escHtml(isVehicle ? "En/Mp" : "MP")} Max</div>
          <input id="edit-mp-max" type="text" value="${escAttr(energyMax)}" style="width:100%; background:#222; color:white;">
        </div>
      </div>

      <div style="margin-bottom:10px; border-top:1px dashed #444; padding-top:8px;">
        <div style="${labelStyle()}">Meters (one per line: Name | curr | max)</div>
        <textarea id="edit-meters" style="width:100%; height:80px; background:#222; border:1px solid #555; color:white;">${escTextarea(
          metersText
        )}</textarea>
        <div style="font-size:0.7em; color:#666; margin-top:4px;">
          Examples: <span style="color:#888;">Shield | 30 | 80</span> · <span style="color:#888;">Stamina | 80 | 160</span>
        </div>
      </div>

      <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:5px; margin-bottom:5px;">
        <div><div style="${labelStyle()}">ATK</div><input id="edit-atk" type="text" value="${escAttr(
          display.stats.atk
        )}" style="width:100%; background:#222; border:1px solid #555; color:white;"></div>
        <div><div style="${labelStyle()}">MATK</div><input id="edit-matk" type="text" value="${escAttr(
          display.stats.matk
        )}" style="width:100%; background:#222; border:1px solid #555; color:white;"></div>
        <div><div style="${labelStyle()}">DEF</div><input id="edit-def" type="text" value="${escAttr(
          display.stats.def
        )}" style="width:100%; background:#222; border:1px solid #555; color:white;"></div>
      </div>

      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:5px; margin-bottom:10px;">
        <div><div style="${labelStyle()}">SATK</div><input id="edit-satk" type="text" value="${escAttr(
          display.stats.satk ?? 0
        )}" style="width:100%; background:#222; border:1px solid #555; color:white;"></div>
        <div><div style="${labelStyle()}">SDEF</div><input id="edit-sdef" type="text" value="${escAttr(
          display.stats.sdef ?? 0
        )}" style="width:100%; background:#222; border:1px solid #555; color:white;"></div>
      </div>

      <div style="margin-bottom:10px;">
        <div style="${labelStyle()}">Condition</div>
        <input id="edit-status" type="text" value="${escAttr((display.status_effects || []).join(", "))}" style="width:100%; background:#222; border:1px solid #555; color:white;">
      </div>

      <div style="margin-bottom:10px;">
        <div style="${labelStyle()}">Inventory</div>
        <textarea id="edit-inventory" style="width:100%; height:60px; background:#222; border:1px solid #555; color:white;">${escTextarea(
          (Array.isArray(display.inventory) ? display.inventory : [])
            .map((i) => (typeof i === "object" ? i.name : i))
            .join("\n")
        )}</textarea>
      </div>

      <div style="margin-bottom:10px;">
        <div style="${labelStyle()}">Skills</div>
        <textarea id="edit-skills" style="width:100%; height:60px; background:#222; border:1px solid #555; color:white;">${escTextarea(
          (Array.isArray(display.skills) ? display.skills : [])
            .map((i) => (typeof i === "object" ? i.name : i))
            .join("\n")
        )}</textarea>
      </div>

      <div style="margin-bottom:10px;">
        <div style="${labelStyle()}">Passives</div>
        <textarea id="edit-passives" style="width:100%; height:60px; background:#222; border:1px solid #555; color:white;">${escTextarea(
          (Array.isArray(display.passives) ? display.passives : [])
            .map((i) => (typeof i === "object" ? i.name : i))
            .join("\n")
        )}</textarea>
      </div>

      <div style="margin-bottom:10px;">
        <div style="${labelStyle()}">Masteries</div>
        <textarea id="edit-mastery" style="width:100%; height:60px; background:#222; border:1px solid #555; color:white;">${escTextarea(
          (display.masteries || []).join("\n")
        )}</textarea>
      </div>
    </div>
  `;

  document.getElementById("rpg-save-btn").onclick = saveEditor;
  document.getElementById("rpg-cancel-btn").onclick = () => renderRPG();
}

// --- 6. PARSER (PIPE UPGRADE) ---
function findLatestRpgBlock(chat) {
  if (!Array.isArray(chat)) return null;

  const regex = /<rpg_state\b[^>]*>([\s\S]*?)<\/rpg_state>/i;
  for (let i = chat.length - 1; i >= 0; i--) {
    const msg = chat[i];
    if (msg && !msg.is_user && typeof msg.mes === "string") {
      const m = msg.mes.match(regex);
      if (m) {
        lastRpgMsgIndex = i;
        return m[1];
      }
    }
  }
  return null;
}

function applyRpgState(nextState) {
  rpgState = nextState;
}

// Pure: text in, state out. No globals read or written, so it can parse any
// message in history (the turn log does) without disturbing the live HUD.
function parseBlockCore(text) {
  let newState = JSON.parse(JSON.stringify(defaultState));
  newState.party = [];
  newState.enemies = [];
  newState.npcs = [];

  let currentMode = "Global";
  let currentEntity = newState; 

  const lines = text.split('\n');

  const getPipes = (line) => {
    let data = {};
    // Upgraded Regex: uses *? instead of +? so it successfully reads completely empty values like |INV:||
    const matches = [...line.matchAll(/\|([^|:]+):\s*([^|]*?)(?=\||$)/g)];
    matches.forEach(m => data[m[1].trim().toLowerCase()] = m[2].trim());
    return data;
  };

  const splitNum = (str) => {
    if (!str) return [0, 0];
    if (str.includes("???")) return ["???", "???"];
    const parts = str.split('/');
    let c = parts[0].trim();
    // Keep the second part intact (don't parseFloat) to preserve math dropdowns
    let m = parts.length > 1 ? parts.slice(1).join('/').trim() : c;
    return [c, m];
  };


  const parseList = (str) => str ? str.split(';').map(s => s.trim()).filter(Boolean) : [];

  for (let line of lines) {
    line = sanitizeBrokenPipeLine(line).trim();
    if (!line) continue;

    const headerMatch = line.match(/^\[(.*?)\]/);
    if (headerMatch) {
      // Fuzzy matching to prevent the "Bleed-over" bug if the AI makes a typo
      const rawMode = headerMatch[1].toLowerCase();
      if (rawMode.includes("player")) currentMode = "Player";
      else if (rawMode.includes("party")) currentMode = "Party";
      else if (rawMode.includes("enem")) currentMode = "Enemies";
      else if (rawMode.includes("npc")) currentMode = "NPCs";
      else currentMode = "Global";

      if (currentMode === "Player") currentEntity = newState;
      continue;
    }

    const isVehicle = line.startsWith('>');
    let target = currentEntity; 
    
    if (isVehicle) {
      if (!currentEntity.vehicle) {
        currentEntity.vehicle = {
          active: true,
          type: "mecha",
          name: "Vehicle",
          hp_curr: 0,
          hp_max: 0,
          mp_curr: 0,
          mp_max: 0,
          en_curr: 0,
          en_max: 0,
          meters: [],
          stats: {},
          inventory: [],
          skills: [],
          passives: [],
		  masteries: [],
          status_effects: [],
        };
      }
      currentEntity.vehicle.active = true;
      target = currentEntity.vehicle;
    }

    const data = getPipes(line);
    if (Object.keys(data).length === 0) continue; 

    // 1. Group creation / Name mapping
    if (isVehicle) {
      if (data.name) target.name = data.name;
    } else if (data.name && ["Party", "Enemies", "NPCs"].includes(currentMode)) {
      const newEnt = { name: data.name, stats: {}, inventory: [], meters: [], skills: [], passives: [], masteries: [], status_effects: [] };
      if (currentMode === "Party") newState.party.push(newEnt);
      if (currentMode === "Enemies") newState.enemies.push(newEnt);
      if (currentMode === "NPCs") newState.npcs.push(newEnt);
      currentEntity = newEnt;
      target = currentEntity;
    } else if (data.name && currentMode === "Player") {
      target.name = data.name;
    }

    // 2. Map Data safely checking against undefined so empty strings clear the data correctly
    if (data.loc !== undefined) newState.location = data.loc;
    if (data.time !== undefined) {
      const tParts = String(data.time).split(',');
      // an optional weekday in front: "Mon Jan 6 1023,14:00" or "Mon, Jan 6 1023,14:00"
      let weekday = "";
      if (tParts.length > 2 && WEEKDAY_RE.test(tParts[0].trim())) weekday = tParts.shift().trim();
      const datePart = (tParts[0] || "").trim().split(/\s+/);
      if (datePart.length > 2 && WEEKDAY_RE.test(datePart[0])) weekday = datePart.shift();
      if (weekday) newState.world_time.weekday = weekday.replace(/[.,]/g, "");
      newState.world_time.month = datePart[0] || "Jan";
      newState.world_time.day = parseInt(datePart[1]) || 1;
      if (datePart[2] !== undefined && /^\d{1,4}$/.test(datePart[2])) {
        newState.world_time.year = datePart[2];
      }
      newState.world_time.clock = (tParts[1] || "").trim() || "12:00";
    }
    if (data.weather !== undefined) {
    newState.world_time.weather = data.weather || "Unknown";
  }
    if (data.combat !== undefined) {
      if (data.combat.toLowerCase().includes('off')) {
        newState.combat.active = false;
        newState.combat.round = 1;
      } else {
        newState.combat.active = true;
        newState.combat.round = parseInt(data.combat.replace(/[^0-9]/g, '')) || 1;
      }
    }

    const vehicleType = String(target?.type || "").toLowerCase();
    const prefersEn = isVehicle && (vehicleType === "car" || vehicleType === "ship");
    const prefersMp = !isVehicle || vehicleType === "mecha" || vehicleType === "transport";
    
    if (data.hp !== undefined) {
      [target.hp_curr, target.hp_max] = splitNum(data.hp);
    }
    
    if (prefersEn) {
      if (data.en !== undefined) {
        [target.en_curr, target.en_max] = splitNum(data.en);
      } else if (data.mp !== undefined) {
        [target.en_curr, target.en_max] = splitNum(data.mp);
      }
    
      target.mp_curr = target.en_curr ?? 0;
      target.mp_max = target.en_max ?? 0;
    } else if (prefersMp) {
      if (data.mp !== undefined) {
        [target.mp_curr, target.mp_max] = splitNum(data.mp);
      } else if (data.en !== undefined) {
        [target.mp_curr, target.mp_max] = splitNum(data.en);
      }
    
      if (isVehicle) {
        target.en_curr = target.mp_curr ?? 0;
        target.en_max = target.mp_max ?? 0;
      }
    }
    if (data.coin !== undefined) target.dankcoin = parseInt(data.coin) || 0;
    if (data.bond !== undefined) target.bond = parseInt(data.bond) || 0;
    if (data.type && isVehicle) target.type = data.type.toLowerCase();

    if (data.inv !== undefined) target.inventory = parseList(data.inv);
    if (data.skills !== undefined) target.skills = parseList(data.skills);
    if (data.masteries !== undefined) target.masteries = parseList(data.masteries);
    if (data.passives !== undefined) target.passives = parseList(data.passives);
    if (data.quests !== undefined) newState.quests = parseList(data.quests);
    if (data.env !== undefined) newState.env_effects = parseList(data.env);
	if (data.bonds !== undefined) newState.bonds = parseBondLedger(data.bonds);
    if (data.timers !== undefined) newState.timers = parseTimers(data.timers);

    // Failsafe: Catch Bond if the AI hides it inside Status
    if (data.status !== undefined) {
      let st = parseList(data.status);
      const bondIdx = st.findIndex(s => s.toLowerCase().startsWith('bond:'));
      if (bondIdx !== -1) {
        target.bond = parseInt(st[bondIdx].split(':')[1]) || 0;
        st.splice(bondIdx, 1);
      }
      target.status_effects = st;
    }

    if (data.stats !== undefined) {
      if (!target.stats) target.stats = {};
      const statParts = data.stats.split(',');
      statParts.forEach(sp => {
        const [sName, sVal] = sp.trim().split(':'); 
        if (sName && sVal) target.stats[sName.toLowerCase().trim()] = sVal.trim();
      });
    }

    if (data.meters !== undefined) {
      target.meters = data.meters.split(';').map(mStr => {
        const mParts = mStr.trim().split(':'); 
        const name = mParts[0];
        const [curr, max] = splitNum(mParts[1]);
        return { name, curr, max };
      }).filter(m => m.name);
    }
  }

  return newState;
}

// The live parse: the pure core, then the steps that depend on history and
// on the previous state (bond ledger, timer carry-over, year inheritance).
function parsePipeFormat(text) {
  const newState = parseBlockCore(text);

  newState.bonds = mergeBondLedger(bondMemory, newState.bonds);

  // names the block itself declared, before live |Bond:| values get folded in
  const declared = new Set(newState.bonds.map((b) => normBondName(b?.name)));
  syncLiveBondsIntoLedger(newState);

  newState.bonds = newState.bonds.filter((b) => {
    const k = normBondName(b?.name);
    if (bondBlocklist.has(k)) return false;                       // deleted on purpose
    if (!uiSettings.autoAddBonds && !declared.has(k)) return false; // no silent adds
    return true;
  });

  // Deltas measure against the same memory, so they're swipe-stable too and the
  // observer's repeat scans of one message can't erase the arrow.
  const baseline = new Map(
    (Array.isArray(bondMemory) ? bondMemory : [])
      .map((b) => [normBondName(b?.name), parseBondValue(b?.bond)])
  );
  if (baseline.size) {
    newState.bonds.forEach((b) => {
      const key = normBondName(b?.name);
      b.prev = baseline.has(key) ? baseline.get(key) : null;
    });
  }

  newState.timers = mergeTimers(rpgState, newState);
  if (!newState.world_time.year && rpgState?.world_time?.year) {
    newState.world_time.year = rpgState.world_time.year;
  }

  return newState;
}

const checkMessage = async (manual = false) => {
  if (bondsEditMode || timersEditMode) return;
  if (manual) console.log("RPG HUD: Manual Scan...");

  const context = SillyTavern.getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat) || chat.length === 0) return;
  const chatKey = currentChatKey(context);
  if (chatKey !== lastChatKey) {
    lastChatKey = chatKey;
    lastListSnapshot = null;
    bondMemory = [];
    timerMemory = [];
    historyMemoryKey = null;
    loadBondBlocklist(chatKey);
  }
  renderRPG();

  const rawBlock = findLatestRpgBlock(chat);
  if (!rawBlock) {
    if (manual) console.warn("RPG HUD: no <rpg_state> block found in recent messages");
    return;
  }

  try {
    let cleanText = rawBlock.replace(/```[a-z]*\n?/g, "").replace(/```/g, "").trim();

    // must run AFTER findLatestRpgBlock set lastRpgMsgIndex, BEFORE the parse
    refreshHistoryMemory(chat, chatKey);

    const parsedState = parsePipeFormat(cleanText);

    applyRpgState(parsedState);
	maybeReportListChanges();
    renderRPG();

    if (manual) {
      const ok = writeStateBackToChatMessage(rpgState);
      if (!ok) console.warn("RPG HUD: couldn't write back after manual scan");
    }
  } catch (err) {
  const msg = String(err?.message || err);
  lastPipeError = {
    line: null,
    char: null,
    message: msg,
    snippet: rawBlock,
  };

  console.error("RPG HUD Parse Error:", err);
  if (manual && window.toastr) hudToast.error("Pipe Parser failed to read the block.");
}
};

// --- 7. OBSERVER ---
const setupObserver = () => {
  const chatContainer = document.querySelector("#chat");
  if (!chatContainer) {
    setTimeout(setupObserver, 1000);
    return;
  }
  const observer = new MutationObserver(() => {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      checkMessage();
    }, 1200);
  });
  observer.observe(chatContainer, { childList: true, subtree: true });
};

import { eventSource, event_types } from '../../../../script.js';

// --- PROMPT INJECTION (Toggleable Interceptor) ---
eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (payload) => {
    if (!autoInjectState || !rpgState || Object.keys(rpgState).length === 0) return;

    const pipeString = buildPipeString(rpgState);

    const injection = `\n\n[System Note: Current RPG state for reference:\n${pipeString}\nUpdate values as needed based on the interaction and include the new <rpg_state> block at the end of your response.]`;

    payload.prompt += injection;
    console.log("RPG HUD: Auto-inject applied (Pipe Format)");
});

$(document).on('change', '#rpg-settings-autoinject', function() {
    autoInjectState = this.checked;
    if (window.toastr) {
        hudToast.info(`Auto-Inject ${autoInjectState ? 'Enabled' : 'Disabled'}`);
    }
    console.log("RPG HUD: Auto-inject toggle set to", autoInjectState);
});

// --- ST EVENT TRIGGERS (more reliable than the DOM observer for edits) ---
[
  "MESSAGE_UPDATED",
  "MESSAGE_EDITED",
  "MESSAGE_SWIPED",
  "MESSAGE_RECEIVED",
  "MESSAGE_DELETED",
].forEach((name) => {
  const evt = event_types?.[name];
  if (!evt) return;
  eventSource.on(evt, () => {
    if (name === "MESSAGE_RECEIVED") { replyReceivedAt = Date.now(); lastReplyAt = Date.now(); }
    // an edit or deletion can change history underneath the cached ledger
    if (name === "MESSAGE_UPDATED" || name === "MESSAGE_EDITED" || name === "MESSAGE_DELETED") {
      invalidateHistoryMemory();
    }
    // small delay: some events fire before chat[] is updated
    setTimeout(() => checkMessage(), 150);
  });
});

// Opening another chat (or refreshing into one) is never a new reply.
if (event_types?.CHAT_CHANGED) {
  eventSource.on(event_types.CHAT_CHANGED, () => { replyReceivedAt = 0; notagWatch = null; });
}

// --- 8. BOOT ---
jQuery(() => {
  console.log("RPG HUD: boot start ✅");
  try {
    // (no global toastr options: HUD toasts set their own, see hudToastOpts)
  } catch {}

  try {
    document.documentElement.style.scrollbarGutter = "stable";
  } catch {}

  try {
    renderRPG();
    console.log("RPG HUD: renderRPG() ok ✅");
  } catch (e) {
    console.error("RPG HUD: renderRPG() failed ❌", e);
  }

  try {
    setupObserver();
    console.log("RPG HUD: setupObserver() ok ✅");
  } catch (e) {
    console.error("RPG HUD: setupObserver() failed ❌", e);
  }

  setTimeout(() => {
    Promise.resolve(checkMessage(true)).finally(() => {
      hudToastArmed = true; 
    });
  }, 300);

  // Debug hook — console access to internals.
  //   __rpgHud.state            live rpgState
  //   __rpgHud.scan(true)       force a scan (true = also write back)
  //   __rpgHud.diff()           run the change-alert diff right now
  //   __rpgHud.build()          preview the block the next write-back would emit
  window.__rpgHud = {
    get state() { return rpgState; },
    scan: (write = false) => checkMessage(write),
    diff: () => maybeReportListChanges(),
    build: () => buildPipeString(rpgState),
  };

  console.log("RPG HUD: boot complete ✅");
});
