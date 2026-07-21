import { SIZE, colors, quotaColor } from "./theme.js";

const FONT = "Helvetica, Arial, sans-serif";

// Overflow guard for renderValueKey: text-anchor="middle" gives no width fit,
// so an over-long value (e.g. an unmapped raw model id) would clip at both tile
// edges. Longer than SHRINK drops to the small (28px) font; longer than MAX is
// sliced with an ellipsis. Calibrated so ~8 glyphs fit the 144px tile at 28px:
// every current caller passes <= 7-char values, so short tiles (including the
// 7-char "log out") are untouched, while a long id degrades to e.g. "claude-…".
const VALUE_SHRINK_AT = 7;
const VALUE_MAX = 8;

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
}

function svgFrame(inner: string, bg: string = colors.bg): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="${bg}" rx="16"/>
  ${inner}
</svg>`;
}

/** Which quota window a meter-family tile renders. Mirrors the Quota Meter's
 * persisted `window` setting value; the bottom pill label is derived from it. */
export type MeterWindow = "5h" | "7d" | "fable";

// Per-window color tokens. An exhaustive switch (no default) so adding a new
// window value fails type-checking here instead of silently reusing another
// window's colors.
function windowTokens(window: MeterWindow): { pill: string; track: string; bg: string } {
  switch (window) {
    case "5h":
      return { pill: colors.accent, track: colors.ring5h, bg: colors.bg5h };
    case "7d":
      return { pill: colors.accent7d, track: colors.ring7d, bg: colors.bg7d };
    case "fable":
      return { pill: colors.accentFable, track: colors.ringFable, bg: colors.bgFable };
  }
}

// Bottom label pill width: the fixed 48px fits the 2-char "5H"/"7D" labels;
// longer labels ("FABLE") widen it. Two-char labels must stay at exactly 48 so
// the pre-Fable tile renders stay byte-identical (rasterize cache + snapshots).
function labelPillWidth(label: string): number {
  return Math.max(48, 16 + label.length * 10);
}

export type QuotaMeterProps = {
  utilization: number | null;
  window: MeterWindow;
  label: string;
  /** Seconds remaining on a 429/cooldown — when > 0, render a WAIT badge. */
  cooldownSeconds?: number;
  /** Seconds until the quota window resets — when > 0, render a top countdown pill. */
  resetsInSeconds?: number | null;
};

/**
 * Condensed reset countdown:
 *  - ≥ 1 day  → "1d", "3d", "7d"
 *  - < 1 day  → "H:MM" zero-padded minutes ("0:01", "3:34", "23:59")
 *  - < 1 min  → "" (caller hides the pill — sub-minute precision isn't useful here)
 */
export function formatResetTime(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return "";
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes <= 0) return "";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

export type SiestaTileProps = {
  window: MeterWindow;
  phrase: string;
  resetsInSeconds?: number | null;
  /** Persiana descent progress (0..1) — looped 0→1→0 by the action. */
  descentProgress?: number;
};

// Opaque rolling-shutter ("persiana enrollable") colors.
const PERSIANA_FILL = "#C2A887";
const PERSIANA_SEAM = "#8B7355";
const PERSIANA_BAR = "#9C7E5B";

function renderPersiana(progress: number, winX: number, winY: number, winW: number, winH: number): string {
  if (progress <= 0) return "";
  const bodyBottom = winY + progress * winH;
  const bodyH = bodyBottom - winY;
  if (bodyH <= 0) return "";
  const parts: string[] = [
    `<rect x="${winX}" y="${winY}" width="${winW}" height="${bodyH.toFixed(2)}" fill="${PERSIANA_FILL}"/>`,
  ];
  const SEAM_PITCH = 6;
  for (let y = winY + SEAM_PITCH; y < bodyBottom - 1; y += SEAM_PITCH) {
    parts.push(`<line x1="${winX}" y1="${y.toFixed(1)}" x2="${winX + winW}" y2="${y.toFixed(1)}" stroke="${PERSIANA_SEAM}" stroke-width="0.8" opacity="0.5"/>`);
  }
  const barH = Math.min(4, bodyH);
  parts.push(`<rect x="${winX}" y="${(bodyBottom - barH).toFixed(2)}" width="${winW}" height="${barH.toFixed(2)}" fill="${PERSIANA_BAR}"/>`);
  return parts.join("");
}

/**
 * 100%-quota easter-egg tile. Replaces the radial gauge when utilization ≥ 1.
 * Shows a window with a warm sunset gradient and a rolling shutter ("persiana
 * enrollable") descending in front of the glass, plus the reset countdown
 * pill on top and a rotating Spanish phrase below. The action loops
 * descentProgress 0 → 1 → 0 every ~5s.
 */
export function renderSiestaTile({ window, phrase, resetsInSeconds, descentProgress = 0 }: SiestaTileProps): string {
  const winX = 22;
  const winY = 34;
  const winW = 100;
  const winH = 64;

  const pillColor = windowTokens(window).pill;
  const timeText = formatResetTime(resetsInSeconds);
  const pillH = 22;
  const pillW = 48;
  const pillX = (SIZE - pillW) / 2;
  const topPill = timeText
    ? `<rect x="${pillX}" y="6" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="${pillColor}"/>
       <text x="${SIZE / 2}" y="${6 + pillH / 2 + 5}" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="800" fill="${colors.bg}" letter-spacing="1">${timeText}</text>`
    : "";

  return svgFrame(`
    ${topPill}
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#FFE2A8"/>
        <stop offset="55%" stop-color="#FFA76B"/>
        <stop offset="100%" stop-color="#D0776C"/>
      </linearGradient>
      <clipPath id="winClip"><rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="3"/></clipPath>
    </defs>
    <g clip-path="url(#winClip)">
      <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" fill="url(#sky)"/>
      ${renderPersiana(descentProgress, winX, winY, winW, winH)}
    </g>
    <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="3" fill="none" stroke="${colors.text}" stroke-width="2"/>
    <line x1="${winX + winW / 2}" y1="${winY}" x2="${winX + winW / 2}" y2="${winY + winH}" stroke="${colors.text}" stroke-width="1.5" opacity="0.85"/>
    <line x1="${winX}" y1="${winY + winH / 2}" x2="${winX + winW}" y2="${winY + winH / 2}" stroke="${colors.text}" stroke-width="1.5" opacity="0.85"/>
    <text x="${SIZE / 2}" y="124" text-anchor="middle" font-family="${FONT}" font-size="20" font-weight="700" fill="${colors.text}" letter-spacing="1">${escape(phrase)}</text>
  `, colors.siestaBg);
}

export function renderQuotaMeter({ utilization, window, label, cooldownSeconds, resetsInSeconds }: QuotaMeterProps): string {
  // Siesta state is handled by the action (it owns the looping animation
  // tick + phrase rotation); renderQuotaMeter only draws the radial gauge.
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const r = 58;
  const stroke = 12;
  const circumference = 2 * Math.PI * r;
  const pct = utilization == null ? 0 : Math.min(1, Math.max(0, utilization));
  const dash = circumference * pct;
  const arcColor = utilization == null ? colors.textDim : quotaColor(utilization);
  const display = utilization == null ? "--" : `${Math.round(pct * 100)}`;
  const suffix = utilization == null ? "" : "%";

  const { pill: pillColor, track: trackColor, bg: bgColor } = windowTokens(window);
  const pillH = 22;
  const pillW = labelPillWidth(label);
  const pillX = (SIZE - pillW) / 2;
  const bottomPillY = SIZE - pillH - 6;
  const topPillY = 6;

  const cooling = cooldownSeconds != null && cooldownSeconds > 0;
  // Cooldown badge replaces the top countdown pill — they occupy the same slot,
  // and a 429 cooldown is the more pressing concern (the user can't refresh).
  const timeText = cooling ? "" : formatResetTime(resetsInSeconds);
  const showTopPill = timeText !== "";

  const waitBadge = cooling
    ? `
      <g>
        <rect x="${SIZE / 2 - 30}" y="8" width="60" height="20" rx="10" fill="${colors.warn}"/>
        <text x="${SIZE / 2}" y="22" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="700" fill="${colors.bg}" letter-spacing="0.5">WAIT ${cooldownSeconds}s</text>
      </g>
    `
    : "";

  const topPillH = 26;
  const topPillW = 58;
  const topPillX = (SIZE - topPillW) / 2;
  const topPill = showTopPill
    ? `
    <rect x="${topPillX}" y="${topPillY}" width="${topPillW}" height="${topPillH}" rx="${topPillH / 2}" fill="${pillColor}"/>
    <text x="${topPillX + topPillW / 2}" y="${topPillY + topPillH / 2 + 6}" text-anchor="middle" font-family="${FONT}" font-size="18" font-weight="800" fill="${colors.bg}" letter-spacing="1">${timeText}</text>`
    : "";

  const valueText = suffix
    ? `${display}<tspan font-size="18" dy="-18" fill="${arcColor}">${suffix}</tspan>`
    : display;

  return svgFrame(`
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${trackColor}" stroke-width="${stroke}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${arcColor}" stroke-width="${stroke}"
            stroke-linecap="round" stroke-dasharray="${dash} ${circumference - dash}"
            transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy + 12}" text-anchor="middle" font-family="${FONT}" font-size="44" font-weight="700" fill="${arcColor}">${valueText}</text>
    <rect x="${pillX}" y="${bottomPillY}" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="${pillColor}"/>
    <text x="${pillX + pillW / 2}" y="${bottomPillY + pillH / 2 + 5}" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="800" fill="${colors.bg}" letter-spacing="1.5">${label}</text>
    ${topPill}
    ${waitBadge}
  `, bgColor);
}

export type LoginRequiredProps = {
  window: MeterWindow;
  /** Bottom pill label, e.g. "5H" / "7D" / "FABLE" — mirrors the gauge for family consistency. */
  label: string;
};

/**
 * "Login lost" tile. Shown when the quota fetch got a 401/403 and the token
 * refresh failed (auth backoff), instead of the misleading WAIT badge a rate
 * limit would show. A red frame + key glyph + "LOG IN" makes it unmistakable
 * that this is an auth problem the user fixes by re-authenticating. The tile is
 * static (no countdown), so the exact-string rasterize cache stays warm.
 */
export function renderLoginRequired({ window, label }: LoginRequiredProps): string {
  const { pill: pillColor, bg: bgColor } = windowTokens(window);
  const pillH = 22;
  const pillW = labelPillWidth(label);
  const pillX = (SIZE - pillW) / 2;
  const bottomPillY = SIZE - pillH - 6;

  return svgFrame(`
    <rect x="4" y="4" width="${SIZE - 8}" height="${SIZE - 8}" rx="14" fill="none" stroke="${colors.danger}" stroke-width="3"/>
    <circle cx="72" cy="36" r="13" fill="none" stroke="${colors.danger}" stroke-width="6"/>
    <rect x="69" y="47" width="6" height="26" rx="1" fill="${colors.danger}"/>
    <rect x="75" y="60" width="9" height="5" rx="1" fill="${colors.danger}"/>
    <rect x="75" y="68" width="7" height="5" rx="1" fill="${colors.danger}"/>
    <text x="${SIZE / 2}" y="98" text-anchor="middle" font-family="${FONT}" font-size="23" font-weight="800" fill="${colors.danger}" letter-spacing="2">LOG IN</text>
    <text x="${SIZE / 2}" y="112" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="${colors.textDim}" letter-spacing="1">tap to sign in</text>
    <rect x="${pillX}" y="${bottomPillY}" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="${pillColor}"/>
    <text x="${pillX + pillW / 2}" y="${bottomPillY + pillH / 2 + 5}" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="800" fill="${colors.bg}" letter-spacing="1.5">${label}</text>
  `, bgColor);
}

export type ValueKeyProps = {
  value: string;
  unit?: string;
  label: string;
  accent?: string;
  small?: boolean;
};

export function renderValueKey({ value, unit, label, accent = colors.text, small }: ValueKeyProps): string {
  let text = value;
  let effSmall = small;
  if (!unit) {
    if (text.length > VALUE_MAX) text = text.slice(0, VALUE_MAX - 1) + "…";
    if (text.length > VALUE_SHRINK_AT) effSmall = true;
  }
  const fontSize = effSmall ? 28 : 38;
  const unitSize = effSmall ? 14 : 18;
  const valueText = unit
    ? `${escape(text)}<tspan font-size="${unitSize}" dy="-4" fill="${colors.textDim}"> ${escape(unit)}</tspan>`
    : escape(text);
  return svgFrame(`
    <text x="${SIZE / 2}" y="${SIZE / 2 + 6}" text-anchor="middle" font-family="${FONT}" font-size="${fontSize}" font-weight="700" fill="${accent}">${valueText}</text>
    <text x="${SIZE / 2}" y="${SIZE - 14}" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="600" fill="${colors.textDim}" letter-spacing="1.5">${escape(label.toUpperCase())}</text>
  `);
}

// renderValueKey is the workhorse for the text-based tiles (Extra Usage,
// Active Model, Switch Account, Login / Logout). The radial tiles use
// renderQuotaMeter / renderSiestaTile above.
