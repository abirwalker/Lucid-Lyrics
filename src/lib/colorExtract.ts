/**
 * Sophisticated color extraction from album art.
 * Uses clustering, saturation scoring, and Euclidean distance for 3 distinct accent colors.
 */

/**
 * Shared color map — syncs surprise color across main view and NPV.
 * Keyed by syllable text + start time to ensure same syllable = same color.
 */
const syllableColorMap = new Map<string, string>();

export function getSyllableColor(key: string): string | null {
  return syllableColorMap.get(key) ?? null;
}

export function setSyllableColor(key: string, color: string): void {
  syllableColorMap.set(key, color);
}

export function clearSyllableColorMap(): void {
  syllableColorMap.clear();
}

export function makeSyllableKey(text: string, startTime: number): string {
  return `${text}_${Math.round(startTime * 1000)}`;
}

/**
 * Deterministic pseudo-random from a string seed (0-1 range).
 */
export function seededRandom(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 10000) / 10000;
}

export interface TrackColors {
  LIGHT_VIBRANT: string;
  VIBRANT_NON_ALARMING: string;
  DESATURATED: string;
}

const DEFAULT_COLORS: TrackColors = {
  LIGHT_VIBRANT: "180, 180, 180",
  VIBRANT_NON_ALARMING: "150, 150, 150",
  DESATURATED: "120, 120, 120",
};

// ── Shared canvas for pixel reading ──
const CANVAS_SIZE = 32;
const sharedCanvas =
  typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(CANVAS_SIZE, CANVAS_SIZE)
    : document.createElement("canvas");
const ctx = sharedCanvas.getContext("2d", { willReadFrequently: true })!;

// ── HSL utilities ──
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [r * 255, g * 255, b * 255];
}

// ── Image URL helpers ──
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

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      // Wait for GPU to fully decode pixels — prevents ghost colors on cache hit
      img.decode()
        .then(() => resolve(img))
        .catch(() => resolve(img)); // Decode may not be supported, fall back
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url;
  });
}

// ── Core extraction ──

interface Cluster {
  r: number;
  g: number;
  b: number;
  count: number;
  h: number;
  s: number;
  l: number;
}

/**
 * Cluster pixels into color families, two-pass score (vibrant → relaxed fallback),
 * then pick 3 maximally distinct accent colors.
 *
 * Improvements from the "bulletproof theme engine":
 * - clearRect prevents ghost colors from previous tracks
 * - Two-pass scoring: Pass 1 hunts vibrant, Pass 2 relaxes for monochrome
 * - MIN_PIXEL_COUNT filters compression artifacts
 * - Multiplicative scoring favors large color areas over tiny neon accents
 * - Darkness penalty for very dark clusters
 */
async function extractColors(imageUrl: string): Promise<TrackColors> {
  const img = await loadImage(imageUrl);

  sharedCanvas.width = CANVAS_SIZE;
  sharedCanvas.height = CANVAS_SIZE;
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

  const imgData = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
  console.log("[Lucid] 🎨 Extracting from:", imageUrl, `| Canvas: ${CANVAS_SIZE}×${CANVAS_SIZE} | Pixels: ${imgData.length / 4}`);

  // 1. CLUSTER: group nearby pixels into color families
  const clusters: Cluster[] = [];
  const MAX_CLUSTERS = 16;
  const DIST_THRESHOLD_SQ = 40 * 40;
  const MIN_PIXEL_COUNT = 12; // Ignore compression artifacts (< ~1.1% of canvas)

  for (let i = 0; i < imgData.length; i += 4) {
    const r = imgData[i];
    const g = imgData[i + 1];
    const b = imgData[i + 2];
    if (imgData[i + 3] < 220) continue;

    let matched = false;
    for (let j = 0; j < clusters.length; j++) {
      const c = clusters[j];
      const dr = r - c.r;
      const dg = g - c.g;
      const db = b - c.b;
      if (dr * dr + dg * dg + db * db < DIST_THRESHOLD_SQ) {
        c.count++;
        c.r += (r - c.r) / c.count;
        c.g += (g - c.g) / c.count;
        c.b += (b - c.b) / c.count;
        matched = true;
        break;
      }
    }

    if (!matched && clusters.length < MAX_CLUSTERS) {
      const [h, s, l] = rgbToHsl(r, g, b);
      clusters.push({ r, g, b, count: 1, h, s, l });
    }
  }

  // Recalculate HSL for final cluster centers
  for (const c of clusters) {
    [c.h, c.s, c.l] = rgbToHsl(c.r, c.g, c.b);
  }

  console.log("[Lucid] 🎨 Clusters:", clusters.map((c) => ({
    rgb: `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)}`,
    hsl: `h${(c.h * 360).toFixed(0)} s${(c.s * 100).toFixed(0)}% l${(c.l * 100).toFixed(0)}%`,
    count: c.count,
  })));

  if (clusters.length === 0) return DEFAULT_COLORS;

  const totalPixels = CANVAS_SIZE * CANVAS_SIZE;

  // 2. TWO-PASS SCORING: Pass 1 = vibrant, Pass 2 = relaxed for monochrome
  for (let pass = 1; pass <= 2; pass++) {
    const satFloor = pass === 1 ? 0.20 : 0.04;
    const darkFloor = pass === 1 ? 0.11 : 0.05;

    const scored = clusters
      .filter((c) => {
        if (c.count < MIN_PIXEL_COUNT) return false;
        if (c.s < satFloor || c.l < darkFloor || c.l > 0.88) return false;
        return true;
      })
      .map((c) => {
        const weight = c.count / totalPixels;
        const darknessPenalty = c.l < 0.20 ? (0.20 - c.l) * 3.0 : 0;
        const lightnessPenalty = Math.abs(c.l - 0.55) + darknessPenalty;
        // Multiplicative: favors large colorful areas over tiny neon text
        const score = c.s * 2.2 * (1.0 + weight * 3.5) + (1.0 - lightnessPenalty);
        return { ...c, score };
      })
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0 && pass === 1) continue;
    if (scored.length === 0) break;

    console.log(`[Lucid] 🎨 Pass ${pass} scored:`, scored.map((c) => ({
      rgb: `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)}`,
      score: c.score.toFixed(2),
      s: c.s.toFixed(2),
      l: c.l.toFixed(2),
      weight: c.count,
    })));

    // 3. PICK 3: maximize Euclidean distance between selections
    const primary = scored[0];

    let secondary = scored[1] || primary;
    let maxDist = 0;
    for (const c of scored.slice(1)) {
      const dist = Math.sqrt(
        (c.r - primary.r) ** 2 + (c.g - primary.g) ** 2 + (c.b - primary.b) ** 2,
      );
      if (dist > maxDist) {
        maxDist = dist;
        secondary = c;
      }
    }

    let tertiary = scored[2] || secondary;
    let maxDist2 = 0;
    for (const c of scored.slice(2)) {
      const dist = Math.sqrt(
        (c.r - (primary.r + secondary.r) / 2) ** 2 +
          (c.g - (primary.g + secondary.g) / 2) ** 2 +
          (c.b - (primary.b + secondary.b) / 2) ** 2,
      );
      if (dist > maxDist2) {
        maxDist2 = dist;
        tertiary = c;
      }
    }

    const toRgb = (c: { r: number; g: number; b: number }) =>
      `${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}`;

    console.log("[Lucid] 🎨 Final 3 colors:", {
      VIBRANT_NON_ALARMING: toRgb(primary),
      LIGHT_VIBRANT: toRgb(secondary),
      DESATURATED: toRgb(tertiary),
    });

    return {
      VIBRANT_NON_ALARMING: toRgb(primary),
      LIGHT_VIBRANT: toRgb(secondary),
      DESATURATED: toRgb(tertiary),
    };
  }

  // Ultimate fallback: most populous cluster
  const byPop = [...clusters].sort((a, b) => b.count - a.count);
  const fb = byPop[0];
  const fbRgb = `${Math.round(fb.r)}, ${Math.round(fb.g)}, ${Math.round(fb.b)}`;
  return {
    VIBRANT_NON_ALARMING: fbRgb,
    LIGHT_VIBRANT: fbRgb,
    DESATURATED: fbRgb,
  };
}

// ── Contrast correction ──

function relativeLuminance(r: number, g: number, b: number): number {
  const f = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
): number {
  const L1 = relativeLuminance(r1, g1, b1);
  const L2 = relativeLuminance(r2, g2, b2);
  const [light, dark] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (light + 0.05) / (dark + 0.05);
}

function ensureContrast(
  r: number, g: number, b: number,
  bgR: number, bgG: number, bgB: number,
  minRatio = 3,
): { r: number; g: number; b: number } {
  let attempts = 0;
  const direction = relativeLuminance(bgR, bgG, bgB) > 0.5 ? -1 : 1;
  while (contrastRatio(r, g, b, bgR, bgG, bgB) < minRatio && attempts < 20) {
    r = Math.min(255, Math.max(0, r + direction * 8));
    g = Math.min(255, Math.max(0, g + direction * 8));
    b = Math.min(255, Math.max(0, b + direction * 8));
    attempts++;
  }
  return { r, g, b };
}

function parseRgb(str: string): [number, number, number] {
  const parts = str.split(",").map((s) => parseInt(s.trim(), 10));
  return [parts[0] || 128, parts[1] || 128, parts[2] || 128];
}

const BG_DARK = { r: 18, g: 18, b: 18 };

/**
 * Adjust all 3 accent colors for contrast against a dark background.
 */
function contrastCorrectColors(colors: TrackColors): TrackColors {
  const correct = (str: string) => {
    const [r, g, b] = parseRgb(str);
    const c = ensureContrast(r, g, b, BG_DARK.r, BG_DARK.g, BG_DARK.b, 3);
    return `${c.r}, ${c.g}, ${c.b}`;
  };
  return {
    VIBRANT_NON_ALARMING: correct(colors.VIBRANT_NON_ALARMING),
    LIGHT_VIBRANT: correct(colors.LIGHT_VIBRANT),
    DESATURATED: correct(colors.DESATURATED),
  };
}

// ── Public API with cancellation ──

let extractionId = 0;

export async function extractTrackColors(): Promise<TrackColors> {
  const imageUrl = getAlbumArtUrl();
  if (!imageUrl) return DEFAULT_COLORS;

  const id = ++extractionId; // Each call gets a unique ID

  try {
    const result = await extractColors(imageUrl);
    // If a newer extraction started while we were loading, discard this result
    if (id !== extractionId) return DEFAULT_COLORS;
    return contrastCorrectColors(result);
  } catch (error) {
    console.warn("[Lucid] Color extraction failed:", error);
    return DEFAULT_COLORS;
  }
}
