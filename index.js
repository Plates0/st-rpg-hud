console.log("RPG HUD: index.js loaded ✅", new Date().toISOString());
window.__rpgHudLoaded = true;

// =====================================================
// RPG HUD Extension for SillyTavern
// - NO prompt injection
// - NO caching/localStorage snapshots
// - Editor SAVE rewrites the actual <rpg_state> block
// - XSS-hardened rendering
// - Editor has CANCEL
//
// Current UX:
// - Header: Character select + Minimize only (prevents header button "jank")
// - Bottom-left: ⚙️ opens a FULL Settings panel (future-proof)
// - Bottom-right: 💰 per-entity dankcoin
//
// Data model:
// - dankcoin is PER-ENTITY (player/party/enemy/npc/vehicle), not global
// - Survival replaced with generic dynamic meters[] (supports >100 max, editable)
// - Combat tracker: rpgState.combat.active + round -> shows "Round N" only when active
// - Extra stats renamed: SATK / SDEF (keys: satk, sdef)
// - HP/MP inline dropdown works if values are strings like: "260 ((100+100)*1.3)"
// =====================================================

// --- 0. XSS SAFETY HELPERS ---
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

// Inline value renderer that supports "123 (math...)" dropdown.
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

  // Generic meters (shields, stamina, sanity, hunger, temp hp, etc.)
  // Each: { name: string, curr: number|string, max: number|string }
  meters: [],

  stats: {
    atk: 0,
    matk: 0,
    def: 0,
    satk: 0,
    sdef: 0,
  },

  inventory: ["(Reset)"],
  skills: [],
  passives: [],
  masteries: [],
  quests: [],
  env_effects: [],
  status_effects: [],

  dankcoin: 0, // per-entity

  location: "Unknown",
  world_time: { month: "Jan", day: 1, clock: "12:00" },

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
};

let rpgState = JSON.parse(JSON.stringify(defaultState));
let activeTab = "inventory";
let isMinimized = false;
let scanTimer = null;
let charIndex = 0;
let tabStripScrollLeft = 0; // <-- remember horizontal scroll position of the tab bar

// Settings panel state
let isSettingsOpen = false;

// Track where the latest <rpg_state> came from so SAVE can rewrite it.
let lastRpgMsgIndex = -1;

// --- DEBUG OVERLAY (mobile-friendly) ---
let isDebugOpen = false;

let lastHudError = {
  time: "",
  kind: "",
  message: "",
  detail: "",
  snippet: "",
  caret: "",
  caret2: "",
};

let lastIndicatorStatus = null; // tracks status changes for toast/alerts

function setHudError(partial) {
  lastHudError = { ...lastHudError, ...partial, time: new Date().toISOString() };
  window.__rpgHudLastError = lastHudError;
}

function toggleDebug(e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  isDebugOpen = !isDebugOpen;
  renderRPG();
}

// Auto-rewrite <rpg_state> back into the chat when we had to repair JSON
const AUTO_REWRITE_ON_REPAIR = true;

// Disable or Enable Auto-Injection of the last <rpg_state> tags. This acts as a Response Interceptor. If you use the Interceptor, the AI will see the stats twice if they are already in the last message of the chat. 
// Most modern LLMs (Claude, GPT-4, etc.) handle this fine and actually appreciate the "reminder," but smaller models might get confused. This allows the user to turn it on or off.
let autoInjectState = false; // Default to OFF

// --- UI SETTINGS (font + scale) ---
// Stored separately from RPG state (does NOT go into <rpg_state>)
const UI_SETTINGS_KEY = "rpgHud:uiSettings";

const defaultUiSettings = {
  fontPreset: "retro_mono", // one of: retro_mono, modern_mono, ui_sans, big_sans, story_serif
  fontFamily: "'Courier New', Courier, monospace",
  fontScale: 1.0, // 0.85 - 1.15

  // NEW: persistent HUD size
  hudWidth: 280,
  hudHeight: 0, // 0 = auto
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

  // Update family from preset (if preset set)
  if (uiSettings.fontPreset) {
    uiSettings.fontFamily = fontPresetToFamily(uiSettings.fontPreset);
  }

  // Apply directly so slider changes don't require a full rerender
  container.style.fontFamily = uiSettings.fontFamily;
  container.style.fontSize = `${0.9 * scale}em`;
}

// --- 2. HELPERS ---
function updateLatestStatusAndToast(chat) {
  const latest = getLatestRpgValidity(chat);

  if (lastIndicatorStatus !== latest.status) {
    const prev = lastIndicatorStatus;
    lastIndicatorStatus = latest.status;

    // Only toast when we ENTER invalid
    if (latest.status === "invalid" && prev !== "invalid") {
      const msg = "RPG JSON is broken (🟡). Tap the dot for details.";
      if (window.toastr?.warning) window.toastr.warning(msg);
      else alert(msg);
    }
  }

  return latest;
}

function guessLikelyJsonErrorPos(text, parserPos, msg) {
  const t = String(text || "");
  const p = Math.max(0, Math.min(Number(parserPos) || 0, t.length));
  const m = String(msg || "").toLowerCase();

  const win = 260;
  const windowStart = Math.max(0, p - win);
  const windowEnd = Math.min(t.length, p + 40);
  const chunk = t.slice(windowStart, windowEnd);

  // A) Missing closing quote before colon:  "vehicle:null
  // Find patterns like: "key:VALUE   (colon appears before a closing quote)
  {
    const r = /"([A-Za-z_][\w]*)\s*:\s*[^"\s][^,}\]]*/g;
    let match, best = null;
    while ((match = r.exec(chunk))) {
      best = { idx: match.index, key: match[1] };
    }
    if (best) {
      // point at the colon inside the broken string, after the key
      const colonOffset = best.idx + 1 + best.key.length; // 1 for opening quote
      return windowStart + colonOffset;
    }
  }

  // B) Missing opening quote for key:  vehicle": null
  {
    const r = /(^|[{\[,]\s*)([A-Za-z_][\w]*)"\s*:/g;
    let match, best = null;
    while ((match = r.exec(chunk))) {
      best = { idx: match.index, leadLen: match[1].length };
    }
    if (best) {
      return windowStart + best.idx + best.leadLen; // points at start of the bare key
    }
  }

  // C) If message says "after property name", try to point near a recent quote/colon
  if (m.includes("after property name") || m.includes("expected ':'")) {
    const left = t.slice(Math.max(0, p - win), p);
    const lastQuote = left.lastIndexOf('"');
    const lastColon = left.lastIndexOf(':');

    // Prefer the last quote if it’s near the end; else last colon; else parserPos
    if (lastQuote !== -1 && (p - (Math.max(0, p - win) + lastQuote)) < 80) {
      return Math.max(0, p - win) + lastQuote;
    }
    if (lastColon !== -1) {
      return Math.max(0, p - win) + lastColon;
    }
  }

  return null;
}


function makeCaretSnippet(text, pos, radius = 160) {
  const t = String(text ?? "");
  const p = Math.max(0, Math.min(Number(pos) || 0, t.length));

  const start = Math.max(0, p - radius);
  const end = Math.min(t.length, p + radius);

  const slice = t.slice(start, end);
  const caretAt = p - start;

  return {
    slice,
    caretLine: " ".repeat(Math.max(0, caretAt)) + "^",
  };
}

function extractJsonErrorPos(err, textForLineCol = "") {
  const msg = String(err?.message || err);

  // Chrome/Edge: "Unexpected token ... in JSON at position 1234"
  let m = msg.match(/position\s+(\d+)/i);
  if (m) return Number(m[1]);

  // Firefox/WebView: "at line 12 column 34" / "line 12 column 34"
  m = msg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (m) {
    const line = Math.max(1, Number(m[1]) || 1);
    const col  = Math.max(1, Number(m[2]) || 1);

    // convert (line, col) -> absolute position in the string (0-based)
    const s = String(textForLineCol || "");
    let pos = 0;
    let curLine = 1;

    for (let i = 0; i < s.length; i++) {
      if (curLine === line) { pos = i; break; }
      if (s[i] === "\n") curLine++;
    }

    // pos now = start index of the line; add (col-1)
    return Math.min(s.length, pos + (col - 1));
  }

  return null;
}

function getLatestRpgValidity(chat) {
  if (!Array.isArray(chat) || chat.length === 0) {
    return { status: "nochat", label: "No chat", detail: "" };
  }

  const last = chat[chat.length - 1];

  // last message is user
  if (last?.is_user) {
    return { status: "user", label: "Last is user", detail: "" };
  }

  const mes = String(last?.mes || "");
  const regex = /<rpg_state\b[^>]*>([\s\S]*?)<\/rpg_state>/i;
  const m = mes.match(regex);

  if (!m) {
    return { status: "notag", label: "No <rpg_state>", detail: "" };
  }

  const raw = sanitizeJsonText(m[1]);

  try {
    JSON.parse(raw);
    return { status: "valid", label: "Latest OK", detail: "" };
  } catch (e) {
    return { status: "invalid", label: "Latest BAD JSON", detail: String(e?.message || e) };
  }
}

function getEnergy(display, isVehicle) {
  if (!display) return { curr: 0, max: 0, label: isVehicle ? "EN/MP" : "MP" };

  // Prefer MP keys if present
  const mpCurr = display.mp_curr ?? display.mp;
  const mpMax  = display.mp_max;

  // EN variants (ships / alt schemas)
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

  // If either side is Infinity, show a full bar (visual “cap”)
  if (!Number.isFinite(curr) || !Number.isFinite(max)) return 100;

  if (max <= 0) return 0;
  return clamp((curr / max) * 100, 0, 100);
}

const INF_THRESHOLD = 999999999; // treat this and above as infinity

function isHugeNumber(v) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) && n >= INF_THRESHOLD;
}

function parseBondValue(v) {
  let s = String(v ?? "").trim();

  // Remove any trailing /100 fraction (common LLM mistake)
  s = s.replace(/\/100$/i, '');

  s = s.toLowerCase();

  if (s === "∞" || s === "infinity" || s === "inf") return 101; // sentinel for infinity
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
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
  // Double-confirm to avoid accidental nukes
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

  const ok = confirmDanger(
    "DELETE CHARACTER",
    `Remove ${label} "${info.name}" from <rpg_state>?`
  );
  if (!ok) return;

  if (info.type === "party") rpgState.party.splice(info.idx, 1);
  if (info.type === "enemy") rpgState.enemies.splice(info.idx, 1);
  if (info.type === "npc") rpgState.npcs.splice(info.idx, 1);

  // safest: return to player view after removal
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

  const ok = confirmDanger(
    "CLEAR ARRAY",
    `Clear ${label} from <rpg_state>?`
  );
  if (!ok) return;

  if (type === "party") rpgState.party = [];
  if (type === "enemy") rpgState.enemies = [];
  if (type === "npc") rpgState.npcs = [];

  // if you were looking at that group, go back to player
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
      isSettingsOpen = false; // close settings if open
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
    emptyText = "None",
    jumpType = null, // "party" | "npc" | "enemy"
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

      // only hide the meter if max is a real finite <= 0
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

function exportStateForChat(stateObj) {
  // deep clone so we don't mutate live state
  const o = JSON.parse(JSON.stringify(stateObj));

  const visit = (x) => {
    if (!x || typeof x !== "object") return;

    // Convert bond >= 101 into the infinity symbol string
    if (Object.prototype.hasOwnProperty.call(x, "bond")) {
      const b = parseBondValue(x.bond);
      x.bond = b >= 101 ? "∞" : b;
    }

    // Walk children
    for (const k of Object.keys(x)) {
      const v = x[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") visit(v);
    }
  };

  visit(o);
  return o;
}


function writeStateBackToChatMessage(stateObj) {
  const context = SillyTavern.getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat) || chat.length === 0) return false;

  let idx = lastRpgMsgIndex;
  if (!(idx >= 0 && idx < chat.length)) idx = findLatestRpgMessageIndex(chat);
  if (idx < 0) return false;

  const msg = chat[idx];
  if (!msg || typeof msg.mes !== "string") return false;

  const regex = /<rpg_state\b[^>]*>[\s\S]*?<\/rpg_state>/i;
  if (!regex.test(msg.mes)) return false;

  // ✅ Minified JSON to avoid whitespace token bloat
  const exportObj = exportStateForChat(stateObj);
  const json = JSON.stringify(exportObj);
  const newBlock = `<rpg_state>${json}</rpg_state>`;
  msg.mes = msg.mes.replace(regex, newBlock);

  try {
    window.saveChat?.();
  } catch (e) {
    console.warn("RPG HUD: saveChat failed after writeback", e);
  }
  return true;
}

// --- 3. ACTIONS ---
function insertLastStateIntoNarrative(e) {
  if (e) e.stopPropagation();
  const stateString = `<rpg_state>${JSON.stringify(rpgState, null, 2)}</rpg_state>`;
  const $input = $('#send_textarea');
  if ($input.length) {
    let currentVal = $input.val().trim();
    currentVal += (currentVal ? '\n\n' : '') + stateString; // Add spacing for readability
    $input.val(currentVal);
    $input.trigger('input'); // Update textarea height and trigger any listeners
    // Optional: Focus the input and scroll to the bottom
    $input.focus();
    $input[0].scrollTop = $input[0].scrollHeight;
  } else {
    console.warn("RPG HUD: Could not find #send_textarea");
    alert("Could not find the chat input box. Make sure you're in a chat session.");
  }
  // Optional: Close settings after insertion
  isSettingsOpen = false;
  renderRPG();
}

function remindStateInLastMessage(e) {
  if (e) e.stopPropagation();

  if (Object.keys(rpgState).length === 0 || !rpgState) {
    alert("No valid RPG state to remind. Scan or generate one first.");
    return;
  }

  // 1. Get the current chat
  const context = SillyTavern.getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat) || chat.length === 0) {
    alert("No chat history found.");
    return;
  }

  // 2. Look at the VERY LAST message
  const lastMsgIndex = chat.length - 1;
  const lastMsg = chat[lastMsgIndex];

  // 3. Prepare the new state block
  const exportObj = exportStateForChat(rpgState);
  const json = JSON.stringify(exportObj);
  const newBlock = `<rpg_state>${json}</rpg_state>`;
  const regex = /<rpg_state\b[^>]*>[\s\S]*?<\/rpg_state>/i;

  // 4. Case A: The last message is from the AI
  if (lastMsg && !lastMsg.is_user) {
    if (confirm("Append/Update <rpg_state> in the last AI message?")) {
      
      // If tag exists, replace it
      if (regex.test(lastMsg.mes)) {
        lastMsg.mes = lastMsg.mes.replace(regex, newBlock);
      } 
      // If tag is missing, append it
      else {
        lastMsg.mes = (lastMsg.mes + "\n\n" + newBlock).trim();
      }

      // Save changes to SillyTavern
      if (window.saveChat) {
        window.saveChat();
        // Update the internal index tracker since we just wrote to the last msg
        lastRpgMsgIndex = lastMsgIndex; 
        alert("State successfully injected into the last AI message.");
      } else {
        console.warn("RPG HUD: window.saveChat not available.");
      }
      
      // Refresh UI
      isSettingsOpen = false;
      renderRPG();
      return;
    }
  }

  // 5. Case B: The last message was you (User), or you declined the AI overwrite
  // Fallback to searching history for ANY tag to update (old behavior)
  const success = writeStateBackToChatMessage(rpgState);

  if (success) {
    checkMessage(true);
    alert("Updated an OLD <rpg_state> found further back in history.");
  } else {
    // 6. Case C: No tags found anywhere, and last msg wasn't suitable
    insertLastStateIntoNarrative();
    alert("Last message was yours (or no tags found). Inserted state into your input box instead.");
  }

  isSettingsOpen = false;
  renderRPG();
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
  isMinimized = !isMinimized;
  isSettingsOpen = false;
  renderRPG();
}
function switchTab(tabName) {
  activeTab = tabName;
  renderRPG();
}
function jumpToChar(e) {
  charIndex = parseInt(e.target.value, 10) || 0;
  renderRPG();
}
function toggleSettings(e) {
  if (e) e.stopPropagation();
  isSettingsOpen = !isSettingsOpen;
  renderRPG();
}
function openEditorFromSettings(e) {
  if (e) e.stopPropagation();
  isSettingsOpen = false;
  renderEditor();
}

function parseMetersFromText(text) {
  // Lines like: Name | curr | max
  // Also accept commas: Name, curr, max
  const out = [];
  const lines = String(text || "").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Allow comments
    if (line.startsWith("#") || line.startsWith("//")) continue;

    let parts = line.split("|").map((s) => s.trim());
    if (parts.length < 3) parts = line.split(",").map((s) => s.trim());
    if (parts.length < 3) continue;

    const name = parts[0];
    const curr = parts[1];
    const max = parts[2];

    if (!name) continue;

    // Keep curr/max as raw text (supports "260 ((...)*1.3)" etc)
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
  // matches: "Bond", "Kita Bond", "Kita Bond ", "Kita Bond:", etc.
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

  // ✅ Energy SAVE (Option B):
  // Ships write to EN keys; everyone else writes to MP keys.
  const energyCurrVal = getMixed("edit-mp-curr");
  const energyMaxVal  = getMixed("edit-mp-max");
  
  if (isVehicle && display.type === "ship") {
    display.en_curr = energyCurrVal;
    display.en_max  = energyMaxVal;
  
    // Optional cleanup: remove MP so you don't get duplicates
    delete display.mp_curr;
    delete display.mp_max;
  } else {
    display.mp_curr = energyCurrVal;
    display.mp_max  = energyMaxVal;
  
    // Optional cleanup for non-ships (if they had EN before)
    delete display.en_curr;
    delete display.en_max;
  }

  // per-entity coin (vehicle or character)
  display.dankcoin = getVal("edit-coin");

  // meters (vehicle or character)
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

  // Top-level globals (player only)
  if (charIndex === 0) {
    rpgState.location = getStr("edit-location");
    rpgState.world_time.month = getStr("edit-month");
    rpgState.world_time.day = getVal("edit-day");
    rpgState.world_time.clock = getStr("edit-clock");
    rpgState.quests = getList("edit-quests");
    rpgState.env_effects = getList("edit-env");
  }

  renderRPG();

  const ok = writeStateBackToChatMessage(rpgState);
  if (!ok) console.warn("RPG HUD: couldn't write back <rpg_state> (no message found?)");
}

// --- 4. UI RENDERER ---
function renderRPG() {
  let container = document.getElementById("rpg-hud-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "rpg-hud-container";
    document.body.appendChild(container);
  }

  // Style constants
  const BOX_RADIUS = "0px";
  const BAR_RADIUS = "4px";
  const FONT_FAMILY = uiSettings.fontFamily || "'Courier New', Courier, monospace";
  const FONT_SIZE = `${0.9 * (uiSettings.fontScale || 1)}em`;

  // ✅ Always compute validity + toast, even when minimized
  let latest = { status: "nochat", label: "", detail: "" };
  try {
    const context = SillyTavern.getContext();
    const chat = context?.chat;
    latest = updateLatestStatusAndToast(chat);
  } catch {}


  if (isMinimized) {
    container.style.cssText = `position: fixed; top: 50px; right: 20px; width: 50px; height: 50px; background: rgba(0,0,0,0.8); border: 2px solid #C0A040; color: #E0E0E0; z-index: 99999; cursor: pointer; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 10px #000; font-family: ${FONT_FAMILY}; font-size: ${FONT_SIZE}; box-sizing:border-box;`;
    applyHudTypography(container);
    container.innerHTML = `<div style="font-size:24px; user-select:none;">🛡️</div>`;
    container.onclick = toggleMinimize;
    return;
  }

// Make container a positioning context for the settings button/panel + coin
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

    const latestDot =
      latest.status === "valid" ? "🟢" :
      latest.status === "invalid" ? "🟡" :
      latest.status === "notag" ? "⚪" :
      latest.status === "user" ? "🔴" :
      "⚫";

    const latestTitle = latest.detail
      ? `${latest.label}\n${latest.detail}`
      : latest.label;

    // Notify when indicator flips into invalid JSON (yellow)
    if (lastIndicatorStatus !== latest.status) {
      const prev = lastIndicatorStatus;
      lastIndicatorStatus = latest.status;

      if (latest.status === "invalid" && prev !== "invalid") {
        if (window.toastr?.warning) {
          window.toastr.warning("RPG JSON is broken (🟡). Tap the dot for details.");
        } else {
          alert("RPG JSON is broken (🟡). Tap the dot for details.");
        }
      }
    }



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
        mpColor = "#1976d2"; // still MP unless you’re a ship
        icon = "🚗";
      } else if (vType === "transport") {
        headerColor = "#8BC34A";
        borderColor = "#33691E";
        hpLabel = "HULL";
        hpColor = "#7CB342";
        mpColor = "#1976d2";
        icon = "🚊";
      } else {
        // mecha default
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

      // Visual-only bar fill: use magnitude, cap to 0..100
      const bondPct = bond >= 101 ? 100 : clamp(Math.abs(bond), 0, 100);
      
      // Optional: color changes when negative
      const bondColor = bond < 0 ? "#ff5252" : "#f06292";
      
      bondHtml = `<div style="display:flex; justify-content:space-between; font-size:0.8em; margin-top:5px;">
        <span style="color:${bondColor};">❤️ Bond</span> <span>${bondLabel}/100</span>
      </div>
      <div style="width:100%; background:#333; height:4px; margin-bottom:5px; border-radius:${BAR_RADIUS}; overflow:hidden;">
        <div style="height:100%; background:${bondColor}; width:${bondPct}%"></div>
      </div>`;
    }

    const metersHtml = renderMeters(display.meters);

    // per-entity coin shown for currently displayed entity (vehicle overrides)
    const coin = toNumberOr(display.dankcoin ?? root.dankcoin ?? 0, 0);

    const time = rpgState.world_time || { month: "???", day: 0, clock: "??:??" };
    const selectStyle = `background: transparent; border: none; color: ${headerColor}; font-weight: bold; font-size: 1em; cursor: pointer; outline: none; max-width: 170px; font-family:${FONT_FAMILY};`;
    const tabStyle = (name) =>
      `flex:0 0 auto; min-width:56px; text-align:center; cursor:pointer; padding:5px 8px; font-size:0.8em; border-radius:3px; user-select:none; ` +
      `${activeTab === name ? "background:#C0A040; color:#000; font-weight:bold;" : "background:transparent; color:#ddd;"}`;

    // Combat tracker (only when active)
    const combatLine =
      rpgState?.combat?.active
        ? `<div style="color:#ff5252; font-weight:bold; font-size:0.9em; margin-top:3px;">⚔️ Round ${escHtml(
            rpgState.combat.round ?? 1
          )}</div>`
        : "";

    // Settings panel overlay (full panel)
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
			 <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; background:rgba(255,255,255,0.05); padding:8px; border-radius:4px;">
    			<span title="Automatically reminds the AI of stats on every message">Auto-Inject Prompt</span>
   			 <input type="checkbox" id="rpg-settings-autoinject" ${autoInjectState ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;">
		  </div>
             <button id="rpg-settings-reset" style="background:#b71c1c; border:1px solid #ff5252; color:#fff; cursor:pointer; padding:8px 10px; font-weight:bold; grid-column:1 / span 2;">X Reset</button>
          </div>

        <div style="font-size:0.75em; color:#aaa; margin-bottom:6px;">Appearance</div>

        <div style="background:rgba(255,255,255,0.06); border:1px solid #333; border-radius:4px; padding:8px; margin-bottom:10px;">
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

    // Debug overlay (tap the indicator dot to open)
    const debugOverlayHtml = isDebugOpen ? `
      <div id="rpg-debug-overlay" style="
        position:absolute; inset:0;
        background: rgba(0,0,0,0.92);
        border: 1px solid #333;
        z-index: 150000;
        display:flex;
        flex-direction:column;
        box-sizing:border-box;
        padding:10px;
      ">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; border-bottom:1px solid #333; padding-bottom:6px;">
          <div style="font-weight:bold; color:#ddd;">🧾 JSON DEBUG</div>
          <div style="display:flex; gap:6px;">
            <button id="rpg-debug-copy" style="background:#333; border:1px solid #777; color:#fff; cursor:pointer; font-size:10px; padding:3px 10px; font-weight:bold;">COPY</button>
            <button id="rpg-debug-close" style="background:#444; border:1px solid #777; color:#fff; cursor:pointer; font-size:10px; padding:3px 10px; font-weight:bold;">CLOSE</button>
          </div>
        </div>

        <div style="flex:1; overflow:auto; font-size:0.8em; color:#ddd; line-height:1.35; padding-right:4px;">
          <div style="color:#aaa; margin-bottom:6px;">
            <div><b>Type:</b> ${escHtml(lastHudError.kind || "none")}</div>
            <div><b>Time:</b> ${escHtml(lastHudError.time || "(none)")}</div>
          </div>

          <div style="margin-bottom:10px;">
            <div style="font-size:0.75em; color:#aaa; margin-bottom:4px;">Message</div>
            <div style="white-space:pre-wrap; background:rgba(255,255,255,0.06); border:1px solid #333; padding:8px; border-radius:4px;">
              ${escHtml(lastHudError.message || "No error captured yet.")}
            </div>
          </div>

          ${lastHudError.snippet ? `
          <div style="margin-bottom:10px;">
            <div style="font-size:0.75em; color:#aaa; margin-bottom:4px;">Snippet (around where it broke)</div>

            <div id="rpg-debug-scroll" style="
              overflow-x:auto;
              border:1px solid #333;
              border-radius:4px;
              background:rgba(255,255,255,0.06);
              padding:8px;
            ">
              <pre id="rpg-debug-snippet" style="
                white-space:pre;
                margin:0;
                font-family:monospace;
                background:transparent;
                border:0;
                padding:0;
              "></pre>

              <pre id="rpg-debug-caret" style="
                white-space:pre;
                margin:6px 0 0;
                font-family:monospace;
                color:#ff5252;
                font-weight:bold;
                background:transparent;
                border:0;
                padding:0;
              "></pre>

              <pre id="rpg-debug-caret2" style="
                white-space:pre;
                margin:2px 0 0;
                font-family:monospace;
                color:#ffd54f;
                font-weight:bold;
                background:transparent;
                border:0;
                padding:0;
                display:none;
              "></pre>
            </div>
          </div>
        ` : ""}




          ${lastHudError.detail ? `
            <div style="margin-bottom:10px;">
              <div style="font-size:0.75em; color:#aaa; margin-bottom:4px;">Detail</div>
              <pre style="white-space:pre-wrap; margin:0; background:rgba(255,255,255,0.04); border:1px solid #2a2a2a; padding:8px; border-radius:4px;">${escHtml(lastHudError.detail)}</pre>
            </div>
          ` : ""}
        </div>
      </div>
    ` : "";



      // Save current tab-strip horizontal scroll before rerender nukes the DOM
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
	
	  <!-- Header right: indicator + MINIMIZE (stable) -->
      <div style="display:flex; align-items:center; justify-content:flex-end; gap:6px; width:60px; flex:0 0 60px;">
        <span id="rpg-latest-indicator" title="${escAttr(latestTitle)}"
          style="font-size:12px; cursor:pointer; user-select:none;">${latestDot}</span>

        <button id="rpg-min-btn" title="Minimize" style="background:#444; border:1px solid #777; color:#fff; cursor:pointer; font-size:12px; padding:0; width:36px; height:20px; font-weight:bold; line-height:18px; box-sizing:border-box;">_</button>
      </div>
    </div>


      <div style="background:rgba(255,255,255,0.05); padding:5px; border-radius:4px; margin-bottom:5px; font-size:0.85em; text-align:center;">
        <div style="color:#fff; font-weight:bold;">📍 ${escHtml(rpgState.location)}</div>
        <div style="color:#aaa; font-size:0.9em;">📅 ${escHtml(time.month)} ${escHtml(time.day)} &nbsp;|&nbsp; ⏰ ${escHtml(
          time.clock
        )}</div>
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
        <div id="tab-inv" style="${tabStyle("inventory")}">Items</div>
        <div id="tab-skill" style="${tabStyle("skills")}">Skills</div>
        <div id="tab-pass" style="${tabStyle("passives")}">Passive</div>
        <div id="tab-mast" style="${tabStyle("mastery")}">Mastery</div>
        <div id="tab-quest" style="${tabStyle("quests")}">Quest</div>
        <div id="tab-env" style="${tabStyle("env")}">Environment</div>
      </div>

      <div style="height: 110px; overflow-y: auto; font-size: 0.8em; padding:5px; background:rgba(0,0,0,0.3); scrollbar-gutter:stable;">
        ${activeTab === "party" ? renderPartyTab() : ""}
        ${activeTab === "inventory" ? makeList(inv, "No Items") : ""}
        ${activeTab === "skills" ? makeList(skills, "No Skills Learned") : ""}
        ${activeTab === "passives" ? makeList(passives, "No Passives") : ""}
        ${activeTab === "mastery" ? makeList(masteries, "No Mastery Tracking") : ""}
        ${activeTab === "quests" ? makeList(rpgState.quests, "No Active Quests") : ""}
        ${activeTab === "env" ? makeList(rpgState.env_effects, "No Environmental Effects") : ""}
      </div>

      ${renderEnemySummary()}

    <!-- Footer controls (absolute, stable) -->
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
      ${debugOverlayHtml}
    `;

    // --- LEFT RESIZE HANDLE (Pointer Events: mouse + touch + pen) ---
{
  const handle = container.querySelector("#rpg-resize-left");
  if (handle) {
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      // capture pointer so we keep receiving move events even if finger leaves the handle
      handle.setPointerCapture?.(ev.pointerId);

      const startX = ev.clientX;
      const startW = container.getBoundingClientRect().width;

      const onMove = (e) => {
        const dx = e.clientX - startX; // moving right = +
        const newW = Math.max(220, Math.min(700, startW - dx)); // grow LEFT
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

    // Restore tab-strip scroll after rerender, and keep it updated
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

    const bind = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.onclick = fn;
    };

    bind("rpg-min-btn", toggleMinimize);
    bind("rpg-settings-btn", toggleSettings);

    bind("rpg-scan-btn", (e) => {
      if (e) e.stopPropagation();
      checkMessage(true);
    });

    bind("rpg-latest-indicator", toggleDebug);

    // Debug overlay binds
    if (isDebugOpen) {
      bind("rpg-debug-close", toggleDebug);
      
      const sn = document.getElementById("rpg-debug-snippet");
      if (sn) sn.textContent = lastHudError.snippet || "";

      const ca = document.getElementById("rpg-debug-caret");
      if (ca) ca.textContent = lastHudError.caret || "";

      const ca2 = document.getElementById("rpg-debug-caret2");
      if (ca2) {
        if (lastHudError.caret2) {
          ca2.style.display = "block";
          ca2.textContent = lastHudError.caret2;
        } else {
          ca2.style.display = "none";
          ca2.textContent = "";
        }
      }

      const copyBtn = document.getElementById("rpg-debug-copy");
      if (copyBtn) {
        copyBtn.onclick = (e) => {
          e.stopPropagation();

          const text =
            `Type: ${lastHudError.kind}\nTime: ${lastHudError.time}\n\n` +
            `Message:\n${lastHudError.message}\n\n` +
            (lastHudError.snippet ? `Snippet:\n${lastHudError.snippet}\n\n` : "") +
            (lastHudError.caret ? `Caret:\n${lastHudError.caret}\n\n` : "") +
            (lastHudError.caret2 ? `Caret2:\n${lastHudError.caret2}\n\n` : "") +
            (lastHudError.detail ? `Detail:\n${lastHudError.detail}\n` : "");

          navigator.clipboard?.writeText(text).then(() => {
            window.toastr?.info?.("Copied debug info");
          }).catch(() => {
            alert("Could not copy (clipboard blocked).");
          });
        };
      }

      const overlay = document.getElementById("rpg-debug-overlay");
      if (overlay) overlay.onclick = (e) => e.stopPropagation();
    }

    const dropdown = document.getElementById("rpg-char-select");
    if (dropdown) {
      dropdown.value = charIndex;
      dropdown.onchange = jumpToChar;
    }

    bind("tab-party", () => switchTab("party"));
    bind("tab-inv", () => switchTab("inventory"));
    bind("tab-skill", () => switchTab("skills"));
    bind("tab-pass", () => switchTab("passives"));
    bind("tab-mast", () => switchTab("mastery"));
    bind("tab-quest", () => switchTab("quests"));
    bind("tab-env", () => switchTab("env"));
	  
    // Settings panel binds
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
	
	  const overlay = document.getElementById("rpg-settings-overlay");
	  if (overlay) overlay.onclick = (e) => e.stopPropagation();
	
	  // Font preset + size slider (live apply)
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
    setHudError({
      kind: "render",
      message: String(e?.message || e),
      detail: e?.stack ? String(e.stack) : "",
      snippet: ""
    });

    container.innerHTML = `<div style="color:#ff5252; padding:10px;">HUD crashed: ${escHtml(
      e.message
    )}<br><button id="rpg-hard-reset">Hard Reset</button></div>`;
    document.getElementById("rpg-hard-reset").onclick = resetRPG;
    console.error(e);
  }
}




// --- 5. EDITOR RENDERER ---
function renderEditor() {
  let container = document.getElementById("rpg-hud-container");
  if (!container) return;

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
        <div style="${labelStyle()}">Clock</div>
        <input id="edit-clock" type="text" value="${escAttr(rpgState.world_time?.clock ?? "12:00")}"
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

// --- 6. PARSER (UPGRADED) ---
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

function sanitizeJsonText(raw) {
  if (typeof raw !== "string") return "";

  return raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]")
    .trim();
}

function patchArrayField(text, fieldName, patchFn) {
  const key = `"${fieldName}":`;
  const i = text.indexOf(key);
  if (i < 0) return text;

  const start = text.indexOf("[", i);
  if (start < 0) return text;

  // find matching closing ] with simple depth counter
  let depth = 0;
  let end = -1;
  for (let p = start; p < text.length; p++) {
    const ch = text[p];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) { end = p; break; }
    }
  }
  if (end < 0) return text;

  const before = text.slice(0, start);
  const arr = text.slice(start, end + 1);
  const after = text.slice(end + 1);

  return before + patchFn(arr) + after;
}

/**
 * Attempts to repair common model-broken JSON patterns:
 * - missing commas between values
 * - stray quotes around numbers: "day":"1,  or  1"
 * Returns a "best effort" JSON string.
 */
function repairJsonText(raw) {
  let t = sanitizeJsonText(raw);

  // Existing fixes (keep)
  t = t.replace(/\[X\]\s*,\s*"/g, '[X]","');
  t = t.replace(/("clock"\s*:\s*")([^"]*?),(")/g, '$1$2$3');
  t = t.replace(/("month"\s*:\s*")([^"]*?),(")/g, '$1$2$3');

  // Turn quoted numbers into numbers:  "hp_curr":"225" -> "hp_curr":225
  t = t.replace(/:\s*"(\s*-?\d+(?:\.\d+)?\s*)"\s*(?=[,}\]])/g, ":$1");

  // Day fixes
  t = t.replace(/"day"\s*:\s*"(\d+)"\s*([,}])/g, '"day":$1$2');
  t = t.replace(/"day"\s*:\s*(\d+)\s*"\s*([,}])/g, '"day":$1$2');

  // ✅ SAFE stray-quote fix: only numeric fields we expect
  // Example it fixes: "hp_curr":225"  -> "hp_curr":225
  t = t.replace(
    /"(hp_curr|hp_max|mp_curr|mp_max|round|dankcoin|bond)"\s*:\s*(-?\d+(?:\.\d+)?)\s*"\s*([,}\]])/g,
    '"$1":$2$3'
  );
  // Also for meters: {"curr":25" ...}
  t = t.replace(
    /"(curr|max)"\s*:\s*(-?\d+(?:\.\d+)?)\s*"\s*([,}\]])/g,
    '"$1":$2$3'
  );

  // ✅ Your month/clock quoting line goes HERE (after numeric cleanup, before arrays)
  // Fixes: "month": Jan  -> "month":"Jan"
  // Fixes: "clock": 23:05 -> "clock":"23:05"
  t = t.replace(
    /"(month|clock)"\s*:\s*([A-Za-z][A-Za-z ]*|\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*([,}])/g,
    '"$1":"$2"$3'
  );

  // Bond fraction fix
  t = t.replace(
    /"bond"\s*:\s*(?:"?\s*(\d+(?:\.\d+)?)\s*\/\s*100\s*"?)/g,
    '"bond":$1'
  );

  // Array string fixes (keep yours)
  const fixBrokenArrayStrings = (arrBody) =>
    arrBody.replace(/([^"])\s*,\s*"/g, '$1","');

  t = patchArrayField(t, "skills", fixBrokenArrayStrings);
  t = patchArrayField(t, "inventory", fixBrokenArrayStrings);
  t = patchArrayField(t, "passives", fixBrokenArrayStrings);
  t = patchArrayField(t, "quests", fixBrokenArrayStrings);
  t = patchArrayField(t, "env_effects", fixBrokenArrayStrings);
  t = patchArrayField(t, "status_effects", fixBrokenArrayStrings);

  // Trailing commas
  t = t.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
  t = t.replace(/,\s*([\]}])/g, '$1');

  return t;
}

function normalizeMeters(meters) {
  if (!Array.isArray(meters)) return [];
  return meters
    .map((m) => {
      if (!m || typeof m !== "object") return null;
      const name = m.name ?? m.label ?? "";
      if (!name) return null;
      const curr = m.curr ?? m.value ?? 0;
      const max = m.max ?? 100;
      return { name: String(name), curr, max };
    })
    .filter(Boolean);
}

function normalizeEntity(entity, defaultTemplate = {}) {
  const e = entity && typeof entity === "object" ? entity : {};
  const base = JSON.parse(JSON.stringify(defaultTemplate));
  const out = { ...base, ...e };

  const ensureArr = (v) => (Array.isArray(v) ? v : []);
  out.inventory = ensureArr(out.inventory);
  out.skills = ensureArr(out.skills);
  out.passives = ensureArr(out.passives);
  out.masteries = ensureArr(out.masteries);

  const statusA = ensureArr(out.status_effects);
  const statusB = ensureArr(out.status);
  out.status_effects = statusA.length ? statusA : statusB;

  out.stats =
    out.stats && typeof out.stats === "object"
      ? out.stats
      : { atk: 0, matk: 0, def: 0, satk: 0, sdef: 0 };

  if (out.stats.satk === undefined && out.stats.extra_1 !== undefined) out.stats.satk = out.stats.extra_1;
  if (out.stats.sdef === undefined && out.stats.extra_2 !== undefined) out.stats.sdef = out.stats.extra_2;

  if (out.stats.satk === undefined) out.stats.satk = 0;
  if (out.stats.sdef === undefined) out.stats.sdef = 0;

  // remove legacy keys if present
  if ("extra_1" in out.stats) delete out.stats.extra_1;
  if ("extra_2" in out.stats) delete out.stats.extra_2;

  out.dankcoin = toNumberOr(out.dankcoin ?? 0, 0);

    // ---- bond compatibility ----
  // Canonical: bond
  // Legacy: "<Name> Bond", "Bond", "Bond:", etc.
  const hasCanonicalBond =
    Object.prototype.hasOwnProperty.call(e, "bond") ||
    Object.prototype.hasOwnProperty.call(e, "Bond");

  // If incoming did NOT explicitly provide bond, try to migrate from legacy keys
  if (!hasCanonicalBond) {
  const legacyKey = Object.keys(e).find(isLegacyBondKey);

  if (legacyKey) {
    const v = parseBondValue(e[legacyKey]); // ✅ handles "15/100"
    if (Number.isFinite(v)) out.bond = v;
  } else if (Object.prototype.hasOwnProperty.call(e, "Bond")) {
    const v = parseBondValue(e.Bond);       // ✅ handles "15/100"
    if (Number.isFinite(v)) out.bond = v;
  }
}

  // Always delete legacy keys (prevents token bloat)
  scrubLegacyBondKeys(out);
  if ("Bond" in out) delete out.Bond;

  // Additional explicit fallback for "Bond"
  if (!("bond" in out) && "Bond" in out) {
    out.bond = parseBondValue(out.Bond);
    delete out.Bond;
  }

  // Clamp final bond
  const b = parseBondValue(out.bond);
  out.bond = clamp(b, Number.NEGATIVE_INFINITY, 101);


  // Meters
  out.meters = normalizeMeters(out.meters);

  // Back-compat: convert old survival object into meters if meters missing
  // survival: { "Thirst": 70, "Sanity": 90 } -> meters [{name, curr, max:100}]
  if ((!out.meters || out.meters.length === 0) && out.survival && typeof out.survival === "object") {
    const entries = Object.entries(out.survival);
    out.meters = entries
      .map(([k, v]) => ({ name: String(k), curr: v, max: 100 }))
      .filter((m) => m.name);
  }
  if ("survival" in out) delete out.survival;

  // Vehicle
  if (out.vehicle === null || out.vehicle === undefined) out.vehicle = null;
  else if (typeof out.vehicle === "object") {
    out.vehicle.active = Boolean(out.vehicle.active);
    out.vehicle.type = out.vehicle.type || "mecha";
    out.vehicle.name = out.vehicle.name || "Vehicle";

    out.vehicle.stats =
      out.vehicle.stats && typeof out.vehicle.stats === "object"
        ? out.vehicle.stats
        : { atk: 0, matk: 0, def: 0, satk: 0, sdef: 0 };

    if (out.vehicle.stats.satk === undefined && out.vehicle.stats.extra_1 !== undefined) out.vehicle.stats.satk = out.vehicle.stats.extra_1;
    if (out.vehicle.stats.sdef === undefined && out.vehicle.stats.extra_2 !== undefined) out.vehicle.stats.sdef = out.vehicle.stats.extra_2;

    if (out.vehicle.stats.satk === undefined) out.vehicle.stats.satk = 0;
    if (out.vehicle.stats.sdef === undefined) out.vehicle.stats.sdef = 0;
    if ("extra_1" in out.vehicle.stats) delete out.vehicle.stats.extra_1;
    if ("extra_2" in out.vehicle.stats) delete out.vehicle.stats.extra_2;

    out.vehicle.inventory = ensureArr(out.vehicle.inventory);
    out.vehicle.skills = ensureArr(out.vehicle.skills);
    out.vehicle.passives = ensureArr(out.vehicle.passives);
    out.vehicle.status_effects = ensureArr(out.vehicle.status_effects);
    if ((!out.vehicle.status_effects || out.vehicle.status_effects.length === 0) && Array.isArray(out.vehicle.status)) {
      out.vehicle.status_effects = out.vehicle.status;
    }

    out.vehicle.dankcoin = toNumberOr(out.vehicle.dankcoin ?? 0, 0);
    // --- VEHICLE BACK-COMPAT FIXES ---
    // Accept EN-style keys for ships (and migrate them)
    if (out.vehicle.mp_curr === undefined && out.vehicle.en !== undefined) {
      out.vehicle.mp_curr = out.vehicle.en;
    }
    if (out.vehicle.mp_max === undefined && out.vehicle.en_max !== undefined) {
      out.vehicle.mp_max = out.vehicle.en_max;
    }
    
    // Some models use en_curr / enMax variants
    if (out.vehicle.mp_curr === undefined && out.vehicle.en_curr !== undefined) {
      out.vehicle.mp_curr = out.vehicle.en_curr;
    }
    if (out.vehicle.mp_max === undefined && out.vehicle.enMax !== undefined) {
      out.vehicle.mp_max = out.vehicle.enMax;
    }
    
    // If model accidentally dumped core vehicle fields into vehicle.stats, migrate them out
    const vs = (out.vehicle.stats && typeof out.vehicle.stats === "object") ? out.vehicle.stats : {};
    const moveOutOfStats = (key) => {
      if (out.vehicle[key] === undefined && vs[key] !== undefined) {
        out.vehicle[key] = vs[key];
        delete vs[key];
      }
    };
    
    moveOutOfStats("hp_curr");
    moveOutOfStats("hp_max");
    moveOutOfStats("mp_curr");
    moveOutOfStats("mp_max");
    
    // just in case the model put EN fields there too
    if (out.vehicle.en === undefined && vs.en !== undefined) {
      out.vehicle.en = vs.en;
      delete vs.en;
    }
    if (out.vehicle.en_max === undefined && vs.en_max !== undefined) {
      out.vehicle.en_max = vs.en_max;
      delete vs.en_max;
    }
    
    // ✅ KEEP EN KEYS (do NOT delete them)
    
    // write back migrated stats object
    out.vehicle.stats = vs;
    out.vehicle.meters = normalizeMeters(out.vehicle.meters);

    // back-compat srvival->meters inside vehicle
    if ((!out.vehicle.meters || out.vehicle.meters.length === 0) && out.vehicle.survival && typeof out.vehicle.survival === "object") {
      out.vehicle.meters = Object.entries(out.vehicle.survival)
        .map(([k, v]) => ({ name: String(k), curr: v, max: 100 }))
        .filter((m) => m.name);
    }
    if ("survival" in out.vehicle) delete out.vehicle.survival;
  } else out.vehicle = null;

  return out;
}

function normalizeFullState(parsed) {
  const base = JSON.parse(JSON.stringify(defaultState));
  const incoming = parsed && typeof parsed === "object" ? parsed : {};
  const mergedTop = { ...base, ...incoming };

  const player = normalizeEntity(mergedTop, defaultState);

  player.quests = Array.isArray(mergedTop.quests) ? mergedTop.quests : base.quests;
  player.env_effects = Array.isArray(mergedTop.env_effects) ? mergedTop.env_effects : base.env_effects;

  player.location = mergedTop.location ?? base.location;
player.world_time = {
  month: String(mergedTop.world_time?.month ?? "Jan").replace(/^"|"$/g, ''), // strip any extra quotes
  day: toNumberOr(mergedTop.world_time?.day ?? 1),
  clock: String(mergedTop.world_time?.clock ?? "12:00").replace(/^"|"$/g, '')
};

  // Combat
  if (mergedTop.combat && typeof mergedTop.combat === "object") {
    player.combat = {
      active: Boolean(mergedTop.combat.active),
      round: toNumberOr(mergedTop.combat.round ?? 1, 1),
    };
  } else {
    player.combat = { active: false, round: 1 };
  }

  // Dungeon optional
  if (mergedTop.dungeon && typeof mergedTop.dungeon === "object") player.dungeon = mergedTop.dungeon;
  else if (player.dungeon) player.dungeon.active = false;

  const entityTemplate = {
    name: "Unit",
    hp_curr: 0,
    hp_max: 0,
    mp_curr: 0,
    mp_max: 0,
    meters: [],
    stats: { atk: 0, matk: 0, def: 0, satk: 0, sdef: 0 },
    inventory: [],
    skills: [],
    passives: [],
    masteries: [],
    status_effects: [],
    vehicle: null,
    bond: 0,
    dankcoin: 0,
  };

  const normList = (arr) => (Array.isArray(arr) ? arr : []).map((e) => normalizeEntity(e, entityTemplate));
  player.party = normList(mergedTop.party);
  player.enemies = normList(mergedTop.enemies);
  player.npcs = normList(mergedTop.npcs);

  return player;
}

function applyRpgState(nextState) {
  rpgState = nextState;
}

const checkMessage = async (manual = false) => {
  if (manual) console.log("RPG HUD: Manual Scan...");

  const context = SillyTavern.getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat) || chat.length === 0) return;
  renderRPG();

  const rawBlock = findLatestRpgBlock(chat);
  console.log("RPG HUD: lastRpgMsgIndex =", lastRpgMsgIndex);
  console.log("RPG HUD: msg.is_user =", chat[lastRpgMsgIndex]?.is_user);
  console.log("RPG HUD: msg preview =", (chat[lastRpgMsgIndex]?.mes || "").slice(0, 220));
  console.log("RPG HUD: rawBlock preview =", String(rawBlock).slice(0, 220));
  if (!rawBlock) {
    if (manual) console.warn("RPG HUD: no <rpg_state> block found in recent messages");
    return;
  }

  // 1) try parse as-is
  let jsonText = sanitizeJsonText(rawBlock);
  try {
    const parsed = JSON.parse(jsonText);

    const normalized = normalizeFullState(parsed);
    applyRpgState(normalized);
    renderRPG();

  // Only rewrite on manual scan (not every auto scan)
  if (manual) {
    const ok = writeStateBackToChatMessage(rpgState);
    if (!ok) console.warn("RPG HUD: couldn't write back <rpg_state> after manual scan");
  }
  return;
} catch (e1) {
  setHudError({
    kind: "parse",
    message: String(e1?.message || e1),
    detail: e1?.stack ? String(e1.stack) : "",
    snippet: "",
    caret: "",
  });

  // continue to repair attempt
  if (manual) console.log("RPG HUD: Initial parse failed, attempting repair...");
}


// 2) repair then parse
try {
  jsonText = repairJsonText(rawBlock);

  // ✅ DEBUG: show the repaired text near where it breaks
if (manual) {
  const inv = jsonText.indexOf('"inventory"');
  if (inv !== -1) console.warn("RPG HUD: repaired around inventory:", jsonText.slice(inv, inv + 220));

  const wt = jsonText.indexOf('"world_time"');
  if (wt !== -1) console.warn("RPG HUD: repaired world_time:", jsonText.slice(Math.max(0, wt - 40), wt + 200));

  const dayDebug = jsonText.indexOf('"day"');
  if (dayDebug !== -1) console.warn("RPG HUD: repaired day area:", jsonText.slice(Math.max(0, dayDebug - 50), dayDebug + 200));
}


  const parsed2 = JSON.parse(jsonText);

  const normalized2 = normalizeFullState(parsed2);
  applyRpgState(normalized2);
  renderRPG();

  if (manual || AUTO_REWRITE_ON_REPAIR) {
    const ok = writeStateBackToChatMessage(rpgState);
    if (!ok) console.warn("RPG HUD: couldn't write back <rpg_state> after repair");
  }
} catch (e2) {
  const msg = String(e2?.message || e2);
  const pos = extractJsonErrorPos(e2, jsonText);

  let snippet = "";
  let caret = "";
  let caret2 = "";

  try {
    if (Number.isFinite(pos)) {
      const out = makeCaretSnippet(jsonText, pos, 200);
      snippet = out.slice;
      caret = out.caretLine;

      const guess = guessLikelyJsonErrorPos(jsonText, pos, msg);
      if (Number.isFinite(guess) && guess !== pos) {
        const out2 = makeCaretSnippet(jsonText, guess, 200);
        // only use the guess caret if it points into the same snippet slice
        if (out2.slice === snippet) {
          caret2 = out2.caretLine;
        }
      }
    } else {
      snippet = String(jsonText || "").slice(0, 400);
    }
  } catch (snipErr) {
    snippet = "(snippet generation failed) " + String(snipErr?.message || snipErr);
  }

  setHudError({
    kind: "parse",
    message: msg,
    detail: e2?.stack ? String(e2.stack) : "",
    snippet,
    caret,
    caret2,
  });



  if (manual) {
    console.error("RPG HUD Parse Error", e2);
    if (snippet) console.warn("RPG HUD: JSON around error:", snippet);
  }
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
    if (!autoInjectState) return;
    if (!rpgState || Object.keys(rpgState).length === 0) return;

    const exportObj = exportStateForChat(rpgState);
    const json = JSON.stringify(exportObj);

    // Clearer instruction — avoids "MUST" language that can sometimes make models over-correct
    const injection = `\n\n[System Note: Current RPG state for reference: <rpg_state>${json}</rpg_state>. Update values as needed based on the interaction and include the new <rpg_state> tag at the end of your response.]`;

    payload.prompt += injection;
    console.log("RPG HUD: Auto-inject applied (toggle ON)");
});

// Listen for toggle changes (already good, but add debug)
$(document).on('change', '#rpg-settings-autoinject', function() {
    autoInjectState = this.checked;
    if (window.toastr) {
        window.toastr.info(`Auto-Inject ${autoInjectState ? 'Enabled' : 'Disabled'}`);
    }
    console.log("RPG HUD: Auto-inject toggle set to", autoInjectState);
});

// --- 8. BOOT ---
jQuery(() => {
  console.log("RPG HUD: boot start ✅");

  // Try to stabilize scrollbar gutter to avoid page-level right-edge shifts (best-effort)
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

  setTimeout(() => checkMessage(true), 300);

  console.log("RPG HUD: boot complete ✅");
});
