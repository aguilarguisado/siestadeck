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

export type QuotaMeterProps = {
  utilization: number | null;
  window: "5h" | "7d";
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
  window: "5h" | "7d";
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

  const pillColor = window === "5h" ? colors.accent : colors.accent7d;
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

  const pillColor = window === "5h" ? colors.accent : colors.accent7d;
  const trackColor = window === "5h" ? colors.ring5h : colors.ring7d;
  const bgColor = window === "5h" ? colors.bg5h : colors.bg7d;
  const pillH = 22;
  const pillW = 48;
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

export type AttentionTileProps = {
  mode: "setup" | "quiet" | "blocked" | "turn_done" | "idle";
  /** blocked only: which of the two flash frames to draw. */
  flashOn?: boolean;
  /** Alarming sessions; a count badge is drawn when > 1. */
  sessionCount?: number;
  /** Short context label (cwd basename of the most urgent session). */
  label?: string;
};

const BELL_PATH = "M72 32c-16 0-26 13-26 29v14l-10 12v5h72v-5l-10-12v-14c0-16-10-29-26-29z";
const BELL_CLAPPER = "M63 96a9 9 0 0 0 18 0z";

/**
 * Attention tile. Exactly two SVG strings exist per (label, count) while
 * flashing — flashOn is the only animated input — so the rasterize LRU
 * cache stays effective.
 */
export function renderAttention({ mode, flashOn = false, sessionCount = 0, label }: AttentionTileProps): string {
  const badge =
    sessionCount > 1
      ? `<circle cx="118" cy="26" r="14" fill="${colors.text}"/>
    <text x="118" y="32" text-anchor="middle" font-family="${FONT}" font-size="17" font-weight="800" fill="${colors.bg}">${sessionCount > 9 ? "9+" : sessionCount}</text>`
      : "";
  const subText = (text: string, fill: string, opacity = 1): string =>
    `<text x="${SIZE / 2}" y="134" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="${fill}" opacity="${opacity}" letter-spacing="1">${escape(text)}</text>`;
  const mainText = (text: string, fill: string): string =>
    `<text x="${SIZE / 2}" y="119" text-anchor="middle" font-family="${FONT}" font-size="19" font-weight="800" fill="${fill}" letter-spacing="1.5">${text}</text>`;

  switch (mode) {
    case "blocked": {
      if (flashOn) {
        return svgFrame(
          `<path d="${BELL_PATH}" fill="${colors.bg}"/>
    <path d="${BELL_CLAPPER}" fill="${colors.bg}"/>
    ${mainText("WAITING", colors.bg)}
    ${label ? subText(label, colors.bg, 0.75) : ""}
    ${badge}`,
          colors.danger,
        );
      }
      return svgFrame(
        `<rect x="4" y="4" width="${SIZE - 8}" height="${SIZE - 8}" rx="14" fill="none" stroke="${colors.danger}" stroke-width="4"/>
    <path d="${BELL_PATH}" fill="${colors.danger}"/>
    <path d="${BELL_CLAPPER}" fill="${colors.danger}"/>
    ${mainText("WAITING", colors.danger)}
    ${label ? subText(label, colors.textDim) : ""}
    ${badge}`,
      );
    }
    case "turn_done":
      return svgFrame(
        `<circle cx="${SIZE / 2}" cy="66" r="30" fill="none" stroke="${colors.warn}" stroke-width="6"/>
    <path d="M58 68l10 10 20-22" fill="none" stroke="${colors.warn}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    ${mainText("DONE", colors.warn)}
    ${label ? subText(label, colors.textDim) : ""}
    ${badge}`,
      );
    case "idle":
      return svgFrame(
        `<text x="${SIZE / 2}" y="80" text-anchor="middle" font-family="${FONT}" font-size="42" font-weight="700" fill="${colors.textDim}">Zzz</text>
    ${mainText("IDLE", colors.textDim)}
    ${label ? subText(label, colors.textDim) : ""}
    ${badge}`,
      );
    case "setup":
      return svgFrame(
        `<path d="${BELL_PATH}" fill="none" stroke="${colors.brandOnDark}" stroke-width="5"/>
    <path d="${BELL_CLAPPER}" fill="${colors.brandOnDark}"/>
    ${mainText("SETUP", colors.brandOnDark)}
    ${subText("press to install", colors.textDim)}`,
      );
    case "quiet":
      return svgFrame(
        `<circle cx="${SIZE / 2}" cy="66" r="9" fill="${colors.ok}"/>
    ${mainText("QUIET", colors.textDim)}`,
      );
  }
}
