/**
 * Accent Color Picker Engine — Lucid Lyrics
 *
 * Sample → cluster → score → select 3 distinct colors → WCAG-correct.
 *
 * Fixes tagged inline:
 *  [FIX 1] CORS / tainted canvas returns null, caller falls back to DEFAULT_PALETTE.
 *  [FIX 2] Zero/insufficient usable pixels handled explicitly.
 *  [FIX 3] Tertiary selection maximizes min(distToPrimary, distToSecondary).
 *  [FIX 4] Contrast correction adjusts HSL lightness instead of raw RGB.
 *  [FIX 5] Binary search fallback for contrast correction.
 *  [FIX 6] Saturation/darkness floors defined, lightness penalty clamped.
 *  [FIX 7] Cluster-cap overflow forced into nearest cluster.
 *  [FIX 8] Fewer-than-3 clusters synthesizes a usable triad.
 *  [FIX 9] syllableColorMap key uses \u0000 delimiter.
 *  [FIX 10] Surprise roll cached at assignment time, not render time.
 *  [FIX 11] Identical album art cached by URL.
 */

// ─── Types ───

export interface RGB {
  r: number;
  g: number;
  b: number;
}

interface HSL {
  h: number;
  s: number;
  l: number;
}

interface Cluster extends RGB {
  count: number;
}

interface ScoredCluster extends Cluster {
  score: number;
  saturation: number;
  lightness: number;
}

export interface AccentPalette {
  vibrantNonAlarming: string; // primary, hex
  lightVibrant: string; // secondary, hex
  desaturated: string; // tertiary, hex
}

export class ExtractionCancelled extends Error {}

// ─── Tunables ───

const SAMPLE_SIZE = 32;
const ALPHA_THRESHOLD = 220;

const MAX_CLUSTERS = 16;
const CLUSTER_DISTANCE_THRESHOLD = 40;
const CLUSTER_DISTANCE_THRESHOLD_SQ = CLUSTER_DISTANCE_THRESHOLD * CLUSTER_DISTANCE_THRESHOLD;
const MIN_PIXEL_COUNT = 12;

const SATURATION_FLOOR = 0.15;
const DARKNESS_FLOOR_L = 0.1;

const BG_RGB: RGB = { r: 18, g: 18, b: 18 };
const MIN_CONTRAST_RATIO = 3.0;
const CONTRAST_MAX_ATTEMPTS = 20;
const CONTRAST_L_STEP = 0.03;

const DEFAULT_PALETTE: AccentPalette = {
  vibrantNonAlarming: "#1ed760",
  lightVibrant: "#7be3a6",
  desaturated: "#3d6b52",
};

// ─── Backward-compatible type aliases ───

export type TrackColors = AccentPalette;

// ─── Color space helpers ───

function rgbToHsl({ r, g, b }: RGB): HSL {
  const rN = r / 255,
    gN = g / 255,
    bN = b / 255;
  const max = Math.max(rN, gN, bN),
    min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  const d = max - min;

  let h = 0,
    s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rN) h = ((gN - bN) / d) % 6;
    else if (max === gN) h = (bN - rN) / d + 2;
    else h = (rN - gN) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return { h, s, l };
}

function hslToRgb({ h, s, l }: HSL): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  const hh = h * 6;

  let r = 0,
    g = 0,
    b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function toHex({ r, g, b }: RGB): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToRgb(hex: string): RGB {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function distSq(a: RGB, b: RGB): number {
  const dr = a.r - b.r,
    dg = a.g - b.g,
    db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function relativeLuminance({ r, g, b }: RGB): number {
  const srgb = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a),
    lb = relativeLuminance(b);
  const lighter = Math.max(la, lb),
    darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// ─── Stage 1: Pixel sampling ───

let sharedCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

function getSharedCanvasContext(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  if (sharedCtx) return sharedCtx;

  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(SAMPLE_SIZE, SAMPLE_SIZE);
    sharedCtx = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    sharedCtx = canvas.getContext("2d", { willReadFrequently: true });
  }
  return sharedCtx;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load album art: ${url}`));
    img.src = url;
  });
}

async function sampleAlbumArtPixels(imageUrl: string): Promise<RGB[] | null> {
  let img: HTMLImageElement;
  try {
    img = await loadImage(imageUrl);
  } catch (e) {
    console.warn("[AccentEngine] Image load failed, using fallback palette", e);
    return null;
  }

  const ctx = getSharedCanvasContext();
  if (!ctx) return null;

  ctx.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  } catch (e) {
    console.warn("[AccentEngine] Canvas tainted by CORS, using fallback palette", e);
    return null;
  }

  const pixels: RGB[] = [];
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    pixels.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
  }

  return pixels.length >= MIN_PIXEL_COUNT ? pixels : null;
}

// ─── Stage 2: Clustering ───

function clusterPixels(pixels: RGB[]): Cluster[] {
  const clusters: Cluster[] = [];

  for (const px of pixels) {
    let nearest: Cluster | null = null;
    let nearestDist = Infinity;

    for (const c of clusters) {
      const d = distSq(px, c);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = c;
      }
    }

    if (nearest && nearestDist < CLUSTER_DISTANCE_THRESHOLD_SQ) {
      mergeIntoCluster(nearest, px);
    } else if (clusters.length < MAX_CLUSTERS) {
      clusters.push({ r: px.r, g: px.g, b: px.b, count: 1 });
    } else if (nearest) {
      mergeIntoCluster(nearest, px);
    }
  }

  return clusters.filter((c) => c.count >= MIN_PIXEL_COUNT);
}

function mergeIntoCluster(cluster: Cluster, px: RGB): void {
  cluster.r += (px.r - cluster.r) / (cluster.count + 1);
  cluster.g += (px.g - cluster.g) / (cluster.count + 1);
  cluster.b += (px.b - cluster.b) / (cluster.count + 1);
  cluster.count++;
}

// ─── Stage 3: Two-pass scoring ───

function scoreClusters(clusters: Cluster[], totalPixels: number): ScoredCluster[] {
  const scored = clusters.map((c): ScoredCluster => {
    const { s, l } = rgbToHsl(c);
    const weight = c.count / totalPixels;

    const darknessPenalty = l < DARKNESS_FLOOR_L ? (DARKNESS_FLOOR_L - l) * 2 : 0;
    const lightnessPenalty = Math.abs(l - 0.55) + darknessPenalty;

    const colorTerm = s * 2.2 * (1.0 + weight * 3.5);
    const lightnessTerm = Math.max(0, 1.0 - lightnessPenalty);

    return { ...c, score: colorTerm + lightnessTerm, saturation: s, lightness: l };
  });

  const pass1 = scored.filter((c) => c.saturation >= SATURATION_FLOOR && c.lightness >= DARKNESS_FLOOR_L);
  return pass1.length > 0 ? pass1 : scored;
}

// ─── Stage 4: Selecting 3 distinct colors ───

function selectDistinctColors(scored: ScoredCluster[]): { primary: RGB; secondary: RGB; tertiary: RGB } {
  if (scored.length === 0) {
    return synthesizeFallbackTriad(hexToRgb(DEFAULT_PALETTE.vibrantNonAlarming));
  }

  const primary = scored.reduce((a, b) => (b.score > a.score ? b : a));

  if (scored.length === 1) {
    return synthesizeFallbackTriad(primary);
  }

  let secondary = scored[0] === primary ? scored[1] : scored[0];
  let bestDist = -1;
  for (const c of scored) {
    if (c === primary) continue;
    const d = distSq(primary, c);
    if (d > bestDist) {
      bestDist = d;
      secondary = c;
    }
  }

  if (scored.length === 2) {
    return { primary, secondary, tertiary: synthesizeVariant(secondary) };
  }

  let tertiary = scored[0];
  let bestMinDist = -1;
  for (const c of scored) {
    if (c === primary || c === secondary) continue;
    const d = Math.min(distSq(primary, c), distSq(secondary, c));
    if (d > bestMinDist) {
      bestMinDist = d;
      tertiary = c;
    }
  }

  return { primary, secondary, tertiary };
}

function synthesizeFallbackTriad(base: RGB): { primary: RGB; secondary: RGB; tertiary: RGB } {
  const hsl = rgbToHsl(base);
  return {
    primary: base,
    secondary: hslToRgb({ h: (hsl.h + 0.5) % 1, s: hsl.s, l: clamp01(hsl.l + 0.2) }),
    tertiary: hslToRgb({ h: (hsl.h + 0.15) % 1, s: hsl.s * 0.5, l: hsl.l }),
  };
}

function synthesizeVariant(base: RGB): RGB {
  const hsl = rgbToHsl(base);
  return hslToRgb({ h: (hsl.h + 0.25) % 1, s: hsl.s * 0.6, l: hsl.l });
}

// ─── Stage 5: WCAG contrast correction ───

function correctContrastWCAG(rgb: RGB, bg: RGB = BG_RGB, minRatio = MIN_CONTRAST_RATIO): RGB {
  if (contrastRatio(rgb, bg) >= minRatio) return rgb;

  const pushLighter = relativeLuminance(bg) < 0.5;
  let hsl = rgbToHsl(rgb);

  for (let i = 0; i < CONTRAST_MAX_ATTEMPTS; i++) {
    hsl = { ...hsl, l: clamp01(hsl.l + (pushLighter ? CONTRAST_L_STEP : -CONTRAST_L_STEP)) };
    const candidate = hslToRgb(hsl);
    if (contrastRatio(candidate, bg) >= minRatio) return candidate;
    if (hsl.l === 0 || hsl.l === 1) break;
  }

  let lo = pushLighter ? hsl.l : 0;
  let hi = pushLighter ? 1 : hsl.l;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const passes = contrastRatio(hslToRgb({ ...hsl, l: mid }), bg) >= minRatio;
    if (pushLighter ? passes : !passes) hi = mid;
    else lo = mid;
  }
  return hslToRgb({ ...hsl, l: pushLighter ? hi : lo });
}

// ─── Orchestration ───

let extractionId = 0;
const paletteCache = new Map<string, AccentPalette>();

export async function extractAccentPalette(imageUrl: string): Promise<AccentPalette> {
  const cached = paletteCache.get(imageUrl);
  if (cached) return cached;

  const myId = ++extractionId;

  const pixels = await sampleAlbumArtPixels(imageUrl);

  if (myId !== extractionId) {
    throw new ExtractionCancelled();
  }

  if (!pixels) {
    return DEFAULT_PALETTE;
  }

  const clusters = clusterPixels(pixels);
  const scored = scoreClusters(clusters, pixels.length);
  const { primary, secondary, tertiary } = selectDistinctColors(scored);

  const palette: AccentPalette = {
    vibrantNonAlarming: toHex(correctContrastWCAG(primary)),
    lightVibrant: toHex(correctContrastWCAG(secondary)),
    desaturated: toHex(correctContrastWCAG(tertiary)),
  };

  paletteCache.set(imageUrl, palette);
  return palette;
}

// ─── Cross-view sync (syllable color assignment) ───

interface SyllableColor {
  color: string;
  isSurprise: boolean;
}

export class SyllableColorAssigner {
  private map = new Map<string, SyllableColor>();
  private currentSongKey: string | null = null;

  private key(syllableText: string, startTimeMs: number): string {
    return `${syllableText}\u0000${startTimeMs}`;
  }

  resetForSong(songKey: string): void {
    if (songKey !== this.currentSongKey) {
      this.map.clear();
      this.currentSongKey = songKey;
    }
  }

  getOrAssign(syllableText: string, startTimeMs: number, palette: AccentPalette, isEmphasized: boolean): SyllableColor {
    const k = this.key(syllableText, startTimeMs);
    const existing = this.map.get(k);
    if (existing) return existing;

    const isSurprise = !isEmphasized && Math.random() < 0.15;
    const assigned: SyllableColor = {
      color: isSurprise ? pickRandomPaletteColor(palette) : "",
      isSurprise,
    };
    this.map.set(k, assigned);
    return assigned;
  }
}

function pickRandomPaletteColor(palette: AccentPalette): string {
  const options = [palette.vibrantNonAlarming, palette.lightVibrant, palette.desaturated];
  return options[Math.floor(Math.random() * options.length)];
}

// ─── Render-time blending utility ───

export function blendWithWhite(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  return toHex({
    r: rgb.r * (1 - alpha) + 255 * alpha,
    g: rgb.g * (1 - alpha) + 255 * alpha,
    b: rgb.b * (1 - alpha) + 255 * alpha,
  });
}

// ─── Album art URL helper ───

function spotifyImageToHttp(uri: string): string | null {
  const match = uri.match(/^spotify:image:([a-f0-9]+)$/);
  if (match) return `https://i.scdn.co/image/${match[1]}`;
  return null;
}

export function getAlbumArtUrl(): string | null {
  try {
    const item = Spicetify?.Player?.data?.item;
    if (!item) return null;

    const candidates = [
      item?.metadata?.image_xlarge_url,
      item?.metadata?.image_large_url,
      item?.metadata?.image_url,
      item?.metadata?.image_small_url,
      ...(Array.isArray(item?.images) ? item.images.map((i: any) => i?.url) : []),
    ].filter(Boolean) as string[];

    for (const url of candidates) {
      if (url.startsWith("http")) return url;
      const httpUrl = spotifyImageToHttp(url);
      if (httpUrl) return httpUrl;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Backward-compatible exports ───

export function seededRandom(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 10000) / 10000;
}

export function makeSyllableKey(text: string, startTime: number): string {
  return `${text}\u0000${Math.round(startTime * 1000)}`;
}

const legacySyllableColorMap = new Map<string, string>();

export function getSyllableColor(key: string): string | null {
  return legacySyllableColorMap.get(key) ?? null;
}

export function setSyllableColor(key: string, color: string): void {
  legacySyllableColorMap.set(key, color);
}

export function clearSyllableColorMap(): void {
  legacySyllableColorMap.clear();
}

/**
 * Backward-compatible wrapper around extractAccentPalette.
 * Gets album art URL internally and returns comma-separated RGB.
 */
export async function extractTrackColors(): Promise<TrackColors> {
  const imageUrl = getAlbumArtUrl();
  if (!imageUrl) return DEFAULT_PALETTE;

  const id = ++extractionId;

  try {
    const result = await extractAccentPalette(imageUrl);
    if (id !== extractionId) return DEFAULT_PALETTE;
    return result;
  } catch (error) {
    if (error instanceof ExtractionCancelled) return DEFAULT_PALETTE;
    console.warn("[Lucid] Color extraction failed:", error);
    return DEFAULT_PALETTE;
  }
}

/** Shared syllable color assigner instance */
export const syllableColorAssigner = new SyllableColorAssigner();
