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

const defaultUiSettings = {
  skin: "classic",
  autoAddBonds: true,     // add party/NPC |Bond:| values to the ledger automatically
  saoPanelLight: 92,      // panel lightness %, lower = dimmer but still solid
  saoCardAlpha: 11,       // % wash behind the player's HP/MP bars; higher = lighter
  saoFont: "preset",      // "preset" | "sans" | "squarish"
  saoInk: 70,             // text contrast against the panel, 0 = faint, 100 = maximum
  saoAnimate: true,       // bar tweening, orb unfold, panel and clock fades
  saoPos: null,           // {vitals:[x,y], col:[x,y], clock:[x,y]} drag offsets
  saoSnap: true,          // snap a dragged piece to the others' edges and centres
  saoUiScale: 100,        // % size of the bar cluster; a desktop usually wants ~130
  saoTextShadow: false,   // shadow behind the text that sits straight on the chat
  saoTextBacking: false,  // translucent card behind that text instead        // "classic" | "sao"
  barsOnMin: true,        // sao skin: keep the bars visible when minimised
  fontPreset: "retro_mono",
  fontFamily: "'Courier New', Courier, monospace",
  fontScale: 1.0,
  hudWidth: 280,
  hudHeight: 0,
  changeAlerts: true,
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
  if (window.toastr) window.toastr.info("HUD settings reset to defaults.");
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

  container.style.fontFamily = uiSettings.fontFamily;
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
    const key = entryBaseName(text).toLowerCase();
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

function maybeReportListChanges() {
  const next = snapshotLists(rpgState);
  const prev = lastListSnapshot;
  lastListSnapshot = next;

  if (!prev) return;                    // first scan is baseline only
  if (!uiSettings.changeAlerts) return;

  const diffs = diffLists(prev, next);
  if (!diffs.length) return;
  console.log("RPG HUD: list changes", diffs);

  const lost = diffs.filter((d) => d.type === "lost");
  if (!lost.length) return;

  const shown = lost.slice(0, 4);
  const body =
    shown
      .map((d) =>
        `${escHtml(d.label)}: <b>${escHtml(d.name)}</b>` +
        `<br><span style="opacity:0.7;">was: ${escHtml(d.before)}</span>`
      )
      .join("<br><br>") +
    (lost.length > 4 ? `<br><br>(+${lost.length - 4} more)` : "") +
    (diffs.length > lost.length
      ? `<br><br><span style="opacity:0.6;">${diffs.length - lost.length} other change(s) — see console</span>`
      : "");

  if (window.toastr?.warning) {
    window.toastr.warning(body, "⚠️ Description dropped", { escapeHtml: false });
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
      ">
        ${escHtml(message)}
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

function updateLatestStatusAndToast(chat) {
  const latest = getLatestRpgValidity(chat);

  if (lastIndicatorStatus !== latest.status) {
    const prev = lastIndicatorStatus;
    lastIndicatorStatus = latest.status;

    const enteredBad =
      (latest.status === "invalid" || latest.status === "notag") &&
      prev !== latest.status;

    const shouldToast =
      enteredBad &&
      (
        latest.status === "invalid" ||
        (
          latest.status === "notag" &&
          hudToastArmed &&
          (prev === "valid" || prev === "invalid")
        )
      );

    if (shouldToast) {
      const msg =
        latest.status === "invalid"
          ? "RPG Pipe format is broken (🟡). Tap the dot for details."
          : "No <rpg_state> found in the latest AI message (⚪).";

      if (window.toastr) {
        window.toastr.options = {
          ...window.toastr.options,
          timeOut: 0,
          extendedTimeOut: 0,
          tapToDismiss: true,
          closeButton: true,
          preventDuplicates: true,
        };

        if (latest.status === "invalid" && window.toastr.warning) window.toastr.warning(msg);
        else if (window.toastr.info) window.toastr.info(msg);
        else window.toastr.warning?.(msg);
      } else {
        alert(msg);
      }
    }
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
  let errors = [];

  lines.forEach((line, index) => {
    const t = line.trim();
    if (!t || t.startsWith('[')) return;

    // Upgraded check: properly handles adjacent pipes || without skipping
    const pipeSegments = [...t.matchAll(/\|([^|]+)(?=\|)/g)];
    pipeSegments.forEach(seg => {
      const content = seg[1].trim();
      // If there is content inside the pipe, it MUST have a colon
      if (content && !content.includes(':')) {
        errors.push(`Line ${index + 1}: Missing colon ':' inside |${content}|`);
      }
    });
  });

  if (errors.length > 0) {
    return { status: "invalid", label: "Format Warning", detail: errors.join("\n") };
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

function monthIndex(m) {
  const i = TIMER_MONTHS.indexOf(String(m || "").trim().slice(0, 3).toLowerCase());
  return i === -1 ? 0 : i;
}

function clockToMinutes(clock) {
  const m = String(clock || "").match(/(\d{1,2})\s*:\s*(\d{1,2})/);
  if (!m) return 0;
  return (parseInt(m[1], 10) || 0) * 60 + (parseInt(m[2], 10) || 0);
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
  const s = String(val || "").trim();
  const t = rpgState.world_time || {};

  const full = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?:\s+(\d{1,4}))?\s*,\s*(\d{1,2}\s*:\s*\d{1,2})$/);
  if (full) return worldMinutes(full[1], full[2], full[4], full[3] ?? t.year);

  const clockOnly = s.match(/^(\d{1,2}\s*:\s*\d{1,2})$/);
  if (clockOnly) {
    let target = worldMinutes(t.month, t.day, clockOnly[1], t.year);
    if (target <= nowWorldMinutes()) target += 1440;
    return target;
  }
  return null;
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

function timerInfo(t) {
  const kind = String(t?.kind || "CD").toUpperCase();
  const raw = String(t?.value ?? "").trim();
  const zero = timerKindStyle(kind).zero;

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

function getCharOptions() {
  const context = SillyTavern.getContext();
  const realUserName = context?.name1 || context?.user_name || "Player";
  let playerName = rpgState.name;
  if (playerName === "{{user}}" || playerName === "Player") playerName = realUserName;

  const fmt = (char, fallback) => {
    if (char.vehicle && char.vehicle.active) return `🤖 ${char.vehicle.name || "Vehicle"}`;
    return char.name || fallback;
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
      const name = escHtml(target?.name || unit?.name || "Unit");

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

  const header = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:4px; margin-bottom:4px;">
      <span style="color:#f06292; font-weight:bold;">❤️ Bonds</span>
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
        ? `<span class="rpg-jump" data-idx="${idx}" style="cursor:pointer; text-decoration:underline; text-decoration-color:#555;">${escHtml(b.name)}</span>`
        : `<span>${escHtml(b.name)}</span>`;

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
  const removed = bondsSnapshot.filter((n) => !nowKeys.has(normBondName(n)));

  rpgState.bonds = cleaned;
  bondsEditMode = false;
  bondsSnapshot = [];
  renderRPG();

  const ok = writeStateBackToChatMessage(rpgState);
  if (!ok) console.warn("RPG HUD: couldn't write back <rpg_state> after bond edit");

  if (removed.length) {
    const label = removed.join(", ");
    const yes = confirm(
      `Scrub from |Bonds:| in ALL earlier messages?\n\n${label}\n\n` +
      `If you skip this, the AI can still see them in older blocks and may add them back.\n\n` +
      `This edits your chat history and cannot be undone.`
    );
    blockBonds(removed);   // stop the next scan re-adding them from live |Bond:| values
    if (yes) {
      const n = purgeBondsFromHistory(removed);
      if (window.toastr) window.toastr.info(`Scrubbed ${removed.length} name(s) from ${n} message(s).`);
    } else if (window.toastr) {
      window.toastr.info(`${removed.length} bond(s) removed and blocked from returning.`);
    }
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
		bondsSnapshot = (rpgState.bonds || []).map((b) => b?.name).filter(Boolean);
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

  const header = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:4px; margin-bottom:4px;">
      <span style="color:#90caf9; font-weight:bold;">⏱️ Timers</span>
      <span style="display:flex; gap:4px;">
        ${timersEditMode ? btn("rpg-timer-add", "+", "#69f0ae", "Add") : btn("rpg-timer-turn", "⏭", "#C0A040", "Advance one turn")}
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
        <input class="rpg-timer-val" data-i="${i}" type="text" value="${escAttr(t?.value ?? "")}"
          style="flex:0 0 64px; width:64px; background:#222; border:1px solid #555; color:#90caf9; font-family:inherit; font-size:1em; text-align:center;">
        <select class="rpg-timer-kind" data-i="${i}"
          style="flex:0 0 62px; background:#222; border:1px solid #555; color:#ddd; font-family:inherit; font-size:0.9em;">${opts(t?.kind)}</select>
        <button class="rpg-timer-del" data-i="${i}" title="Delete"
          style="flex:0 0 auto; background:#333; border:1px solid #ff5252; color:#ff5252; cursor:pointer; font-size:0.85em; padding:1px 5px; font-weight:bold;">✕</button>
      </div>`).join("");

    return header + rows + `
      <div style="font-size:0.7em; color:#666; margin-top:4px; line-height:1.35;">
        Value: <span style="color:#888;">2/3</span> (turns) or <span style="color:#888;">Jan 6,14:00</span> (deadline).<br>
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

      return `
        <div style="padding:4px 0; border-bottom:1px solid #333; ${dim}">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
            <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              ${st.icon} ${ownerTag}${escHtml(t.name)}${mark}${keptMark}
            </span>
            <span style="flex:0 0 auto; color:${st.color};">
              ${escHtml(info.label)}
              ${delta ? `<span style="font-size:0.75em; color:#888;"> ${escHtml(delta)}</span>` : ""}
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
    if (rpgState.timers[i]) rpgState.timers[i].value = String(el.value || "").trim();
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
  const removed = timersSnapshot.filter((t) => !nowKeys.has(timerKey(t)));

  rpgState.timers = cleaned;
  timersEditMode = false;
  timersSnapshot = [];
  renderRPG();

  const ok = writeStateBackToChatMessage(rpgState);
  if (!ok) console.warn("RPG HUD: couldn't write back <rpg_state> after timer edit");

  if (removed.length) {
    const label = removed.map((t) => (t.owner ? `${t.owner}/${t.name}` : t.name)).join(", ");
    const yes = confirm(
      `Scrub from |Timers:| in ALL earlier messages?\n\n${label}\n\n` +
      `If you skip this, the AI can still see them in older blocks and may add them back.\n\n` +
      `This edits your chat history and cannot be undone.`
    );
    if (yes) {
      const n = purgeTimersFromHistory(removed);
      if (window.toastr) window.toastr.info(`Scrubbed ${removed.length} timer(s) from ${n} message(s).`);
    }
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
          .map((t) => ({ owner: t.owner || "", name: t.name, kind: t.kind }));
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
function stripBondsFromText(text, keys) {
  return String(text).replace(
    /(<rpg_state\b[^>]*>)([\s\S]*?)(<\/rpg_state>)/gi,
    (full, open, body, close) => {
      const newBody = body.replace(/\|Bonds:([^|]*)\|/gi, (m, val) => {
        const kept = String(val)
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
          .filter((chunk) => {
            const i = chunk.lastIndexOf(":");
            const nm = i === -1 ? chunk : chunk.slice(0, i);
            return !keys.has(normBondName(nm));
          });
        return `|Bonds:${kept.join(";")}|`;
      });
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
function meterColorByName(name) {
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

function renderMeters(meters) {
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
            <span>${escHtml(name)}</span>
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

function writeStateBackToChatMessage(stateObj) {
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
  const finalString = buildPipeString(stateObj);
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
  lines.push(`|Loc:${stateObj.location || "Unknown"}||Time:${wt.month} ${wt.day}${yearStr},${wt.clock}||Weather:${wt.weather || "Unknown"}||Combat:${stateObj.combat?.active ? "Round " + (stateObj.combat?.round || 1) : "Off"}|`);
  
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
    let bondStr = isPartyOrNPC ? `||Bond:${ent.bond ?? 0}` : "";
    
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
function toggleMinimize(e) {
  if (e) e.stopPropagation();
  flushInlineEdits();
  isMinimized = !isMinimized;
  isSettingsOpen = false;
  renderRPG();
}
function switchTab(tabName) {
  flushInlineEdits();
  activeTab = tabName;
  renderRPG();
}
function jumpToChar(e) {
  charIndex = parseInt(e.target.value, 10) || 0;
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
    rpgState.world_time.clock = getStr("edit-clock");
    rpgState.world_time.weather = getStr("edit-weather");
    rpgState.quests = getList("edit-quests");
    rpgState.env_effects = getList("edit-env");
	rpgState.bonds = parseBondLedgerFromText(getStr("edit-bonds"));
  }

  renderRPG();

  const ok = writeStateBackToChatMessage(rpgState);
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

      container.style.cssText = `
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
  background: rgba(10, 10, 15, 0.95);
  border: 2px solid #C0A040; color: #E0E0E0;
  padding: 10px 10px 46px 10px;
  z-index: 9999;
  font-family: ${FONT_FAMILY};
  font-size: ${FONT_SIZE};
  display: block !important;
  border-radius: ${BOX_RADIUS};
  box-shadow: 0 0 10px #000;
  box-sizing:border-box;
  contain: layout paint;
  overflow: hidden;`;

  applyHudTypography(container);
  container.onclick = null;

  try {
    const { root, display, type, isVehicle } = getActiveData();
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

    const metersHtml = renderMeters(display.meters);

    const coin = toNumberOr(display.dankcoin ?? root.dankcoin ?? 0, 0);

    const time = rpgState.world_time || { month: "???", day: 0, clock: "??:??", weather: "Unknown" };
    const selectStyle = `background: transparent; border: none; color: ${headerColor}; font-weight: bold; font-size: 1em; cursor: pointer; outline: none; max-width: 170px; font-family:${FONT_FAMILY};`;
    const tabStyle = (name) =>
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
          <div style="font-weight:bold; color:#ddd;">⚙️ SETTINGS</div>
          <button id="rpg-settings-close" style="background:#444; border:1px solid #777; color:#fff; cursor:pointer; font-size:10px; padding:3px 10px; font-weight:bold;">CLOSE</button>
        </div>

        <div style="flex:1; overflow:auto; padding-right:4px;">
          <div style="font-size:0.75em; color:#aaa; margin-bottom:6px;">Actions</div>

          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-bottom:12px;">
             <button id="rpg-settings-edit" style="background:#333; border:1px solid #4FC3F7; color:#4FC3F7; cursor:pointer; padding:8px 10px; font-weight:bold;">✏️ Edit</button>
             <button id="rpg-settings-remove" style="background:#333; border:1px solid #ff9800; color:#ffcc80; cursor:pointer; padding:8px 10px; font-weight:bold;">🗑️ Remove</button>
             <button id="rpg-settings-clear-npcs" style="background:#333; border:1px solid #00e5ff; color:#b3f5ff; cursor:pointer; padding:8px 10px; font-weight:bold;">🧹 NPCs</button>

             <button id="rpg-settings-clear-enemies" style="background:#333; border:1px solid #ff5252; color:#ffd0d0; cursor:pointer; padding:8px 10px; font-weight:bold;">🧹 Enemies</button>
             <button id="rpg-settings-clear-party" style="background:#333; border:1px solid #C0A040; color:#fff; cursor:pointer; padding:8px 10px; font-weight:bold;">🧹 Party</button>
			 <button id="rpg-settings-insert" style="background:#333; border:1px solid #4CAF50; color:#A5D6A7; cursor:pointer; padding:8px 10px; font-weight:bold;">Insert State</button>
             <button id="rpg-settings-remind" style="background:#333; border:1px solid #9C27B0; color:#E1BEE7; cursor:pointer; padding:8px 10px; font-weight:bold;">Remind State</button>
			 <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; background:rgba(255,255,255,0.05); padding:8px; border-radius:4px; grid-column:1 / span 2;">
    			<span title="Automatically reminds the AI of stats on every message">Auto-Inject Prompt</span>
   			 <input type="checkbox" id="rpg-settings-autoinject" ${autoInjectState ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;">
		  </div>
		  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; background:rgba(255,255,255,0.05); padding:8px; border-radius:4px; grid-column:1 / span 2;">
    			<span title="Warn when an item/skill/passive loses its description">Change Alerts</span>
   			 <input type="checkbox" id="rpg-settings-changealerts" ${uiSettings.changeAlerts ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;">
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
            <option value="sao">SAO overlay</option>
        </select>

        <div style="font-size:0.75em; color:#bbb; margin-bottom:6px;">Font preset</div>

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
          📅 ${escHtml(time.month)} ${escHtml(time.day)}${time.year ? `, ${escHtml(time.year)}` : ""}
          &nbsp;|&nbsp;
          ⏰ ${escHtml(time.clock)}
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

      <div id="rpg-tab-strip" style="display:flex; overflow-x:auto; white-space:nowrap; gap:2px; border-bottom:1px solid #555; margin-bottom:5px; padding-bottom:2px; scrollbar-gutter:stable;">
        <div id="tab-party" style="${tabStyle("party")}">Party</div>
		<div id="tab-bonds" style="${tabStyle("bonds")}">Bonds</div>
	    <div id="tab-timers" style="${tabStyle("timers")}">Timers</div>
        <div id="tab-inv" style="${tabStyle("inventory")}">Items</div>
        <div id="tab-skill" style="${tabStyle("skills")}">Skills</div>
        <div id="tab-pass" style="${tabStyle("passives")}">Passive</div>
        <div id="tab-mast" style="${tabStyle("mastery")}">Mastery</div>
        <div id="tab-quest" style="${tabStyle("quests")}">Quest</div>
        <div id="tab-env" style="${tabStyle("env")}">Environment</div>
      </div>

      <div style="height: 110px; overflow-y: auto; font-size: 0.8em; padding:5px; background:rgba(0,0,0,0.3); scrollbar-gutter:stable;">
        ${activeTab === "party" ? renderPartyTab() : ""}
		${activeTab === "bonds" ? renderBondsTab() : ""}
		${activeTab === "timers" ? renderTimersTab() : ""}
        ${activeTab === "inventory" ? makeList(inv, "No Items") : ""}
        ${activeTab === "skills" ? makeList(skills, "No Skills Learned") : ""}
        ${activeTab === "passives" ? makeList(passives, "No Passives") : ""}
        ${activeTab === "mastery" ? makeList(masteries, "No Mastery Tracking") : ""}
        ${activeTab === "quests" ? makeList(rpgState.quests, "No Active Quests") : ""}
        ${activeTab === "env" ? makeList(rpgState.env_effects, "No Environmental Effects") : ""}
      </div>

      ${renderEnemySummary()}

    <div style="
	  position:absolute; left:10px; bottom:8px;
	  display:flex; gap:6px;
	">
	  <button id="rpg-settings-btn" title="Settings" style="
	    background:#333; border:1px solid #777; color:#fff;
	    cursor:pointer; width:34px; height:26px;
	    display:flex; align-items:center; justify-content:center;
	    box-sizing:border-box;
	  ">⚙️</button>
	
	  <button id="rpg-scan-btn" title="Scan" style="
	    background:#333; border:1px solid #C0A040; color:#fff;
	    cursor:pointer; width:34px; height:26px;
	    display:flex; align-items:center; justify-content:center;
	    box-sizing:border-box;
	  ">↻</button>
	</div>


      <div style="position:absolute; right:10px; bottom:10px; font-size:0.8em; color:#FFD700;">💰 ${escHtml(coin)}</div>

      <div id="rpg-resize-left" title="Resize"
        style="position:absolute; left:-8px; top:0; bottom:0; width:16px;
          cursor:ew-resize; z-index:200000; background:transparent; touch-action:none;"></div>

      ${settingsPanelHtml}
      ${errorPanelHtml}
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
    bind("rpg-settings-btn", toggleSettings);
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
	  
	if (isSettingsOpen) {
	  bind("rpg-settings-close", toggleSettings);
	  bind("rpg-settings-edit", openEditorFromSettings);
	
	  bind("rpg-settings-reset", resetRPG);
	  bind("rpg-settings-remove", removeActiveCharacter);
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
	    if (window.toastr) window.toastr.info("Bond blocklist cleared for this chat.");
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
// SKIN SYSTEM
// renderRPG() picks a skin. Each skin owns #rpg-hud-container completely:
// its layout, its container styling, and its own minimise behaviour.
// State (rpgState) is shared and untouched — a skin only ever reads it and
// calls the same handlers the classic skin does.
// =====================================================================

function setSkin(name) {
  flushInlineEdits();
  uiSettings.skin = name === "sao" ? "sao" : "classic";
  saveUiSettings();
  isSettingsOpen = false;
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
let saoLayoutMode = false;   // drag clusters around instead of using them
let saoAnimKind = "";        // "" | "restore" | "collapse" | "panel"
let saoAnimUntil = 0;        // animations apply to any render before this time
let saoLastPct = new Map();  // bar key -> last painted %, so values can tween
let saoTweens = new Map();   // bar key -> running animation token
let saoCollapsed = { meters: false, party: false, npcs: false, foes: false };
let saoSub = "stats";
let saoSvgUid = 0;

const SAO_SHAPE = { step: 0.60, slope: 2, drop: 0.50, tip: 4, tipy: 0.20 };
const SAO_RIM = { grey: "#53565e", greyW: 4, metalW: 2, hi: "#eceadf", lo: "#94918a" };
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
};

// Rajdhani isn't installed anywhere by default, so fetch it once when asked.
// If there's no network the stack above falls through to a local face.
function saoEnsureWebFont() {
  if (uiSettings.saoFont !== "squarish") return;
  if (document.getElementById("rpg-sao-webfont")) return;
  const link = document.createElement("link");
  link.id = "rpg-sao-webfont";
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&display=swap";
  document.head.appendChild(link);
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
  if (window.toastr) window.toastr.info("HUD layout reset.");
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
    const el = ev.target?.closest?.(".rpg-sao-ghost");
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
  const a = parseFloat(String(currRaw ?? "").replace(/[^\d.\-]/g, ""));
  const b = parseFloat(String(maxRaw ?? "").replace(/[^\d.\-]/g, ""));
  if (!isFinite(a) || !isFinite(b) || b <= 0) return 0;
  return clamp((a / b) * 100, 0, 100);
}

// The bar is one SVG path, stroked twice then filled. Strokes centre on the
// path, so the fill hides their inner halves and what survives outside is a
// grey band with a thin metal line inside it. One path means the rim can't
// thin out along the diagonal the way two nested clip-paths did.
function saoBarSvg(W, H, pctVal, c1, c2) {
  const m = Math.ceil(SAO_RIM.greyW / 2);
  const x0 = m, y0 = m, w = W - m * 2, h = H - m * 2;
  if (w <= 2 || h <= 1) return "";

  const stepX = clamp(SAO_SHAPE.step * w, 1, w - 2);
  const slope = Math.min(SAO_SHAPE.slope, Math.max(0, w - stepX - 1));
  const tip = Math.min(SAO_SHAPE.tip, Math.max(0, w - stepX - slope - 1));
  const dropY = y0 + SAO_SHAPE.drop * h;
  const tipY = y0 + SAO_SHAPE.tipy * h;

  const d = `M${x0} ${y0}H${x0 + w}V${tipY}L${x0 + w - tip} ${dropY}` +
            `H${x0 + stepX + slope}L${x0 + stepX} ${y0 + h}H${x0}Z`;

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

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="m${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${SAO_RIM.hi}"/><stop offset="1" stop-color="${SAO_RIM.lo}"/>
      </linearGradient>
      <linearGradient id="g${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
      </linearGradient>
      <clipPath id="c${id}"><path d="${d}"/></clipPath>
    </defs>
    <path d="${d}" fill="none" stroke="${SAO_RIM.grey}" stroke-width="${SAO_RIM.greyW}" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="url(#m${id})" stroke-width="${SAO_RIM.metalW}" stroke-linejoin="round"/>
    <path d="${d}" fill="${SAO_WELL}"/>
    ${fillPoly}
  </svg>`;
}

// Bars can only be drawn once they have a real pixel width, so the markup
// ships empty and this fills every .rpg-sao-bar after layout.
function saoDrawBar(el, p) {
  const W = el.clientWidth, H = el.clientHeight;
  if (!W || !H) return;
  el.innerHTML = saoBarSvg(W, H, p, el.dataset.c1 || "#b9f56d", el.dataset.c2 || "#63c322");
}

function saoPaintBars() {
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
    <span class="rpg-sao-num">${escHtml(curr)}/${escHtml(max)}</span></div>`;
}

// A unit in an active vehicle is displayed as the vehicle, the way the
// classic skin does it, so the bars and chips don't show a stale pilot.
function saoUnitView(unit) {
  const v = unit?.vehicle;
  if (v && v.active) {
    return { name: `\u{1F916} ${v.name || "Vehicle"}`, hp_curr: v.hp_curr, hp_max: v.hp_max,
             isVeh: true, en: getEnergy(v, true),
             meters: Array.isArray(v.meters) ? v.meters : [] };
  }
  return { name: unit?.name || "?", hp_curr: unit?.hp_curr, hp_max: unit?.hp_max,
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
      + `<span class="rpg-sao-num">${escHtml(m.curr)}/${escHtml(m.max)}</span></div>`;
  }).join("");
}

function saoDivider(label, key, color) {
  if (!color && key === "npcs") color = "#bcd4e8";
  const open = !saoCollapsed[key];
  return `<div class="rpg-sao-div" ${color ? `style="color:${color}"` : ""}>${escHtml(label)}
    <button class="rpg-sao-caret" data-k="${key}" aria-expanded="${open}">${open ? "&#9662;" : "&#9656;"}</button>
  </div>`;
}

// ---- panels -------------------------------------------------------------
function saoStatusPanel() {
  const { root, display, type, isVehicle } = getActiveData();
  const name = display?.name || root?.name || rpgState?.name || "Player";

  const subs = [["stats","Stats"],["inventory","Items"],["skills","Skills"],
                ["passives","Passive"],["masteries","Mastery"]];
  let h = `<div class="rpg-sao-subtabs">` + subs.map(([k, label]) =>
    `<button class="rpg-sao-subtab${saoSub === k ? " on" : ""}" data-sub="${k}">${label}</button>`
  ).join("") + `</div>`;

  if (saoSub === "stats") {
    const en = getEnergy(display, isVehicle);
    h += `<div class="rpg-sao-vline"><span>HP</span><b>${renderInlineValue(display.hp_curr)} / ${renderInlineValue(display.hp_max)}</b></div>`;
    h += `<div class="rpg-sao-vline"><span>${escHtml(en.label || "MP")}</span><b>${renderInlineValue(en.curr)} / ${renderInlineValue(en.max)}</b></div>`;
    if ((type === "party" || type === "npc") && !isVehicle && root?.bond !== undefined) {
      const b = parseBondValue(root.bond);
      h += `<div class="rpg-sao-vline"><span>Bond</span><b>${b >= 101 ? "&#8734;" : b} / 100</b></div>`;
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

    const meters = Array.isArray(display.meters) ? display.meters : [];
    if (meters.length) {
      h += `<div class="rpg-sao-sub">Meters</div>` + meters.map((m) =>
        `<div class="rpg-sao-vline"><span>${escHtml(m.name)}</span><b>${escHtml(m.curr)} / ${escHtml(m.max)}</b></div>`
      ).join("");
    }

    const st = Array.isArray(display.status_effects) ? display.status_effects : [];
    h += `<div class="rpg-sao-status">Status: ` +
      (st.length ? `<b>${st.map(escHtml).join(", ")}</b>` : `Healthy`) + `</div>`;
  } else {
    const list = Array.isArray(display[saoSub]) ? display[saoSub] : [];
    h += list.length
      ? `<ul class="rpg-sao-entries">` + list.map((it) => `<li>${escHtml(it)}</li>`).join("") + `</ul>`
      : `<p class="rpg-sao-empty">Nothing recorded.</p>`;
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

  const chips = `<div class="rpg-sao-who">` + active.list.map((u, i) => {
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
      ? `<span class="rpg-sao-who-name">${escHtml(b.name)}</span>`
      : `<button class="rpg-sao-who-name rpg-sao-jump" data-idx="${idx}">${escHtml(b.name)}</button>`;

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
  const quests = Array.isArray(rpgState.quests) ? rpgState.quests : [];
  if (!quests.length) return { title: "Quests", body: `<p class="rpg-sao-empty">No active quests.</p>` };
  return {
    title: "Quests",
    body: quests.map((q) => `<div class="rpg-sao-quest">${escHtml(q)}</div>`).join(""),
  };
}

function saoPlacePanel() {
  const t = rpgState.world_time || {};
  const env = Array.isArray(rpgState.env_effects) ? rpgState.env_effects : [];
  let h = `<div class="rpg-sao-place">${escHtml(rpgState.location || "Unknown")}</div>`;
  h += `<div class="rpg-sao-weather">${getWeatherEmoji(t.weather)} ${escHtml(t.weather || "Unknown")}
        &#183; ${escHtml(t.clock || "??:??")}, ${escHtml(t.month || "?")} ${escHtml(t.day ?? "?")} ${escHtml(t.year || "")}</div>`;
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
      const owner = t.owner ? `<span class="rpg-sao-owner">${escHtml(t.owner)}&#183;</span>` : "";
      const mark = t.repaired ? `<span title="Auto-ticked" style="color:#a8871f;">*</span>` : "";
      const kept = t.kept ? `<span title="Carried over" style="color:#9b978c;">&#176;</span>` : "";
      const bar = info.pct === null ? "" :
        `<div class="rpg-sao-tbar"><div style="width:${info.pct}%; background:${st.color}"></div></div>`;
      return `<div class="rpg-sao-timer${dim}">
        <div class="rpg-sao-tline"><span>${st.icon}</span>
          <span class="rpg-sao-tname">${owner}${escHtml(t.name)}${mark}${kept}</span>
          <span class="rpg-sao-tleft" style="color:${st.color}">${escHtml(info.label)}</span></div>
        ${bar}</div>`;
    }).join("");

  return head + rows;
}

// the classic caret/error overlay, dropped into a SAO panel
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
      + item("Animations",
          "Bars slide to their new value, orbs unfold when you reopen the HUD, and panels fade in. Off means everything snaps.")
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
    + row("rpg-sao-help", "?", saoHelpOpen ? "Hide help" : "What these do")
    + row("rpg-sao-move", "\u2725", "Move HUD pieces")
    + row("rpg-sao-reset", "\u21BA", "Reset settings")
    + row("rpg-sao-insert", "&#8595;", "Insert state")
    + row("rpg-sao-remind", "&#9993;", "Remind state")
    + toggle("rpg-sao-sw-alerts", "Change alerts", !!uiSettings.changeAlerts)
    + toggle("rpg-sao-sw-inject", "Auto-inject", !!autoInjectState)
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
    + `<div class="rpg-sao-mrow toggle"><span>Font</span>
        <select id="rpg-sao-font">
          <option value="preset"${!SAO_FONTS[uiSettings.saoFont] ? " selected" : ""}>Follow preset</option>
          <option value="sans"${uiSettings.saoFont === "sans" ? " selected" : ""}>Sans</option>
          <option value="squarish"${uiSettings.saoFont === "squarish" ? " selected" : ""}>Squarish</option>
        </select></div>`
    + `<div class="rpg-sao-mrow toggle"><span>Skin</span>
        <select id="rpg-sao-skin">
          <option value="classic">Classic</option>
          <option value="sao" selected>SAO</option>
        </select></div>`;
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
    font-family:${SAO_FONTS[uiSettings.saoFont] || uiSettings.fontFamily || SAO_FONTS.sans};
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
      vitals = `<div class="rpg-sao-vitals${animKind === "restore" && !uiSettings.barsOnMin ? " fadein" : ""}" data-drag="vitals">
        <div class="rpg-sao-card">
          <div class="rpg-sao-block">
            <div class="rpg-sao-name">${escHtml(demo ? "Name" : pName)}</div>
            <div class="rpg-sao-stack">
              <div class="rpg-sao-vrow">${saoBarHtml("", hpPct, hpStops[0], hpStops[1], "p:hp")}
                <span class="rpg-sao-vnum">${demo ? "720/1000" : `${escHtml(pView.hp_curr)}/${escHtml(pView.hp_max)}`}</span></div>
              <div class="rpg-sao-vrow">${saoBarHtml("mid", mpPct, SAO_PALETTE.mp[0], SAO_PALETTE.mp[1], "p:mp")}
                <span class="rpg-sao-vnum">${demo ? "240/500" : `${escHtml(en.curr)}/${escHtml(en.max)}`}</span></div>
            </div>
          </div>
        </div>`;

      if (pMeters.length) {
        vitals += `<div class="rpg-sao-group">` + saoDivider("METERS", "meters") +
          `<div class="rpg-sao-slim${saoCollapsed.meters ? " hide" : ""}">` +
          pMeters.map((m) => saoSlimRow(m.name, m.curr, m.max, saoMeterColor(m.name), null, false,
            `p/m:${normBondName(m.name)}`)).join("") +
          `</div></div>`;
      }
      // party and NPCs get their own sections, each independently collapsible
      const unitGroup = (label, key, list, type) => {
        if (!list.length) return "";
        return `<div class="rpg-sao-group">` + saoDivider(label, key) +
          `<div class="rpg-sao-slim${saoCollapsed[key] ? " hide" : ""}">` +
          list.map((u, i) => {
            const v = saoUnitView(u);
            const k = `${type}:${normBondName(u?.name) || i}`;
            return saoSlimRow(v.name, v.hp_curr, v.hp_max, saoUnitStops(v),
                              charIndexFor(type, i), false, k) + saoMeterRows(v, k);
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
        `<div class="rpg-sao-slim${saoCollapsed.foes ? " hide" : ""}">` +
        enemies.map((u, i) => {
          const v = saoUnitView(u);
          const k = `enemy:${normBondName(u?.name) || ""}:${i}`;
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
      const help = saoHelpPanel();
      panelHtml = `<div class="rpg-sao-panelwrap helpshift"><div class="rpg-sao-panel">
        <h2>${escHtml(help.title)}</h2>
        <div class="rpg-sao-body">${help.body}</div></div><div class="rpg-sao-notch"></div></div>`;
    } else if (!saoMin && saoPanel && saoPanel !== "gear") {
      const built = saoPanel === "status" ? saoStatusPanel()
                  : saoPanel === "bonds" ? saoBondsPanel()
                  : saoPanel === "quests" ? saoQuestsPanel()
                  : saoPanel === "error" ? saoErrorPanel()
                  : saoPlacePanel();
      panelHtml = `<div class="rpg-sao-panelwrap"><div class="rpg-sao-panel">
        <h2>${escHtml(built.title)}</h2>
        ${saoPanel === "status" ? saoWhoStrip() : ""}
        <div class="rpg-sao-body">${built.body}</div></div><div class="rpg-sao-notch"></div></div>`;
    }

    const menuHtml = (!saoMin && saoPanel === "gear")
      ? `<div class="rpg-sao-menuwrap${saoHelpOpen ? " hashelp" : ""}"><div class="rpg-sao-menu">${saoSettingsHtml()}</div><div class="rpg-sao-notch"></div></div>` : "";

    // --- clock ---
    const t = rpgState.world_time || {};
    const clockHtml = saoMin ? "" : `<div class="rpg-sao-clockwrap" data-drag="clock">
      ${saoTimersOpen ? `<div class="rpg-sao-timers">${saoTimersHtml()}</div>` : ""}
      <button class="rpg-sao-clock" id="rpg-sao-clock">
        <span class="rpg-sao-dot ${saoIndicatorClass(latest.status)}"></span>
        <span class="rpg-sao-glyph">${getWeatherEmoji(t.weather)}</span>
        <span class="rpg-sao-cstack">
          <span class="hhmm">${escHtml(t.clock || "??:??")}</span>
          <span class="date">${escHtml(t.month || "?")} ${escHtml(t.day ?? "?")} ${escHtml(t.year || "")}</span>
        </span></button></div>`;

    if (vitals) vitals += foesHtml + `</div>`;
    const layoutBar = saoLayoutMode
      ? `<div id="rpg-sao-layout-bar">Drag any outlined piece
          <button class="ghost${uiSettings.saoSnap !== false ? " on" : ""}" id="rpg-sao-layout-snap"
            title="Line pieces up with each other and with the screen">Snap ${uiSettings.saoSnap !== false ? "on" : "off"}</button>
          <button class="ghost" id="rpg-sao-layout-reset" title="Put every piece back where it started">Reset all</button>
          <button id="rpg-sao-layout-done">Done</button></div>`
      : "";

    container.innerHTML = SAO_CSS + vitals + orbs + panelHtml + menuHtml + clockHtml + layoutBar;

    saoFitName();          // may change the bar width, so run it first
    saoPaintBars();
    saoPlacePanels();
    requestAnimationFrame(() => {
      saoFitName(); saoPaintBars(); saoPlacePanels();
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

  on(".rpg-sao-caret", (el) => {
    const k = el.dataset.k;
    saoCollapsed[k] = !saoCollapsed[k];
    renderRPG();
  });

  on(".rpg-sao-jump, .rpg-sao-chip", (el) => {
    const idx = parseInt(el.dataset.idx, 10);
    if (!Number.isFinite(idx)) return;
    charIndex = idx;
    saoSub = "stats";
    saoPanel = "status";
    renderRPG();
  });

  on(".rpg-sao-cat", (el) => {
    const g = saoRosterGroups().filter((x) => x.key === el.dataset.cat)[0];
    if (!g) return;
    charIndex = charIndexFor(g.type, 0);
    saoPanel = "status";
    renderRPG();
  });

  on(".rpg-sao-subtab", (el) => { saoSub = el.dataset.sub; renderRPG(); });

  const clock = document.getElementById("rpg-sao-clock");
  if (clock) clock.onclick = (e) => { e.stopPropagation(); saoTimersOpen = !saoTimersOpen; renderRPG(); };

  // bonds / timers reuse the classic editors, so their own binders apply
  const bondEdit = document.getElementById("rpg-sao-bond-edit");
  if (bondEdit) bondEdit.onclick = (e) => {
    e.stopPropagation();
    bondsEditMode = true;
    bondsSnapshot = (rpgState.bonds || []).map((b) => b?.name).filter(Boolean);
    renderRPG();
  };
  const timerEdit = document.getElementById("rpg-sao-timer-edit");
  if (timerEdit) timerEdit.onclick = (e) => {
    e.stopPropagation();
    timersEditMode = true;
    timersSnapshot = (rpgState.timers || [])
      .filter((t) => t && String(t.name || "").trim())
      .map((t) => ({ owner: t.owner || "", name: t.name, kind: t.kind }));
    renderRPG();
  };
  const timerTurn = document.getElementById("rpg-sao-timer-turn");
  if (timerTurn) timerTurn.onclick = (e) => { e.stopPropagation(); advanceTimerTurn(); };

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
  bind("rpg-sao-help", () => { saoHelpOpen = !saoHelpOpen; renderRPG(); });
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
  bind("rpg-sao-sw-inject", () => {
    autoInjectState = !autoInjectState;
    const box = document.getElementById("rpg-settings-autoinject");
    if (box) box.checked = autoInjectState;
    if (window.toastr) window.toastr.info(`Auto-Inject ${autoInjectState ? "Enabled" : "Disabled"}`);
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
    if (window.toastr) window.toastr.info("Bond blocklist cleared for this chat.");
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

  const fontSel = document.getElementById("rpg-sao-font");
  if (fontSel) {
    fontSel.onchange = () => { uiSettings.saoFont = fontSel.value; saveUiSettings(); renderRPG(); };
    fontSel.onclick = (e) => e.stopPropagation();
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
.rpg-sao-vitals{position:absolute; left:calc(8px + var(--sao-vitals-x, 0px));
  width:min(calc(322px * var(--rpg-sao-ui, 1)), calc(100vw - 130px));
  top:calc(env(safe-area-inset-top, 0px) + 12px + var(--sao-vitals-y, 0px));
  max-height:calc(100svh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)
                  - var(--rpg-sao-clock-lift, 84px) - 24px);
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

.rpg-sao-bar{position:relative; flex:1 1 auto; min-width:0; width:100%; height:calc(15px * var(--rpg-sao-ui, 1))}
.rpg-sao-bar.mid{height:calc(11px * var(--rpg-sao-ui, 1))}
.rpg-sao-bar.slim{height:calc(9px * var(--rpg-sao-ui, 1)); width:auto}
.rpg-sao-bar svg{position:absolute; inset:0; width:100%; height:100%; display:block;
  filter:drop-shadow(0 1px 3px rgba(0,0,0,.4))}
.rpg-sao-slim .rpg-sao-bar svg{filter:none}

.rpg-sao-slim{opacity:.78; margin-right:calc(56px * var(--rpg-sao-ui, 1))}
.rpg-sao-slim.hide{display:none}
.rpg-sao-row{display:flex; align-items:center; gap:7px; margin-bottom:3px}
.rpg-sao-row.stacked{flex-wrap:wrap; margin-bottom:5px}
.rpg-sao-row.stacked .rpg-sao-tag{flex:0 0 100%; width:100%;
  white-space:normal; overflow:visible; margin-bottom:1px}
.rpg-sao-row.sub{margin-left:13px; opacity:.85}
.rpg-sao-row.sub .rpg-sao-tag{flex:0 0 calc(40px * var(--rpg-sao-ui, 1)); font-size:calc(9.5px * var(--rpg-sao-ui, 1)); text-decoration:none}
.rpg-sao-row.sub .rpg-sao-bar.slim{height:calc(6px * var(--rpg-sao-ui, 1))}
.rpg-sao-row.sub .rpg-sao-num{font-size:calc(9px * var(--rpg-sao-ui, 1)); min-width:calc(42px * var(--rpg-sao-ui, 1))}
.rpg-sao-tag{flex:0 0 calc(50px * var(--rpg-sao-ui, 1)); font-size:calc(10.5px * var(--rpg-sao-ui, 1)); font-weight:600; color:#ddd9ce; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; background:none; border:0; padding:0; text-align:left}
button.rpg-sao-tag{cursor:pointer; text-decoration:underline;
  text-decoration-color:rgba(255,255,255,.28); text-underline-offset:2px}
button.rpg-sao-tag:hover{color:#fff}
.rpg-sao-tag.foe{color:#f2a99d}
button.rpg-sao-tag.foe{text-decoration-color:rgba(242,169,157,.4)}
button.rpg-sao-tag.foe:hover{color:#ffd0c7}
.rpg-sao-num{flex:0 0 auto; font-size:calc(9.5px * var(--rpg-sao-ui, 1)); color:#c2beb4; min-width:calc(46px * var(--rpg-sao-ui, 1));
  text-align:right}

.rpg-sao-div{margin:9px 0 5px; font-size:calc(10px * var(--rpg-sao-ui, 1)); font-weight:700; letter-spacing:2px;
  color:#cdc8bb; display:flex; align-items:center; gap:7px}
.rpg-sao-div::after{content:""; flex:1; height:1px;
  background:linear-gradient(90deg,rgba(220,215,200,.4),transparent)}
.rpg-sao-caret{background:none; border:0; color:inherit; cursor:pointer; padding:0 2px;
  font-size:10px; order:3}

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
   can see, whatever shape the underlying element happens to be. */
.rpg-sao-ghost{
  position:absolute; z-index:6; box-sizing:border-box;
  border:1px dashed rgba(255,255,255,.7); border-radius:3px;
  background:rgba(120,160,220,.07); cursor:move; touch-action:none;
  font-size:9px; font-weight:700; letter-spacing:1.2px; color:#f2c141;
  padding:1px 4px; line-height:1.1; text-align:right;
}
.rpg-sao-ghost.dragging{border:2px solid #f2c141; background:rgba(242,193,65,.12)}
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

function parsePipeFormat(text) {
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
      const datePart = (tParts[0] || "").trim().split(/\s+/);
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
  if (manual && window.toastr) window.toastr.error("Pipe Parser failed to read the block.");
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
        window.toastr.info(`Auto-Inject ${autoInjectState ? 'Enabled' : 'Disabled'}`);
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
    // an edit or deletion can change history underneath the cached ledger
    if (name === "MESSAGE_UPDATED" || name === "MESSAGE_EDITED" || name === "MESSAGE_DELETED") {
      invalidateHistoryMemory();
    }
    // small delay: some events fire before chat[] is updated
    setTimeout(() => checkMessage(), 150);
  });
});

// --- 8. BOOT ---
jQuery(() => {
  console.log("RPG HUD: boot start ✅");
  try {
    if (window.toastr) {
      window.toastr.options = {
        ...window.toastr.options,
        timeOut: 0,              
        extendedTimeOut: 0,
        tapToDismiss: true,
        closeButton: true,
        progressBar: false,
        newestOnTop: true,
        preventDuplicates: true,
      };
    }
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
