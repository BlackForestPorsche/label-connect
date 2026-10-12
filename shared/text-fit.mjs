/** Line height multiplier — keep in sync with `.words` in app.css and canvas paint. */
export const LINE_HEIGHT = 1.15;

/** Inner padding as a fraction of the smaller box side (also at least 1pt). */
export function boxPadding(widthPt, heightPt) {
  return Math.max(1, Math.min(widthPt, heightPt) * 0.04);
}

/**
 * Approximate Liberation Sans advance width for tests / Node (no canvas).
 * Browser callers should pass a real measureText-based function instead.
 */
export function approxTextWidth(text, sizePt) {
  const s = String(text ?? "");
  let units = 0;
  for (const ch of s) {
    if (ch === " ") units += 0.33;
    else if ("iIljtfI1|'".includes(ch)) units += 0.35;
    else if ("mwMW@".includes(ch)) units += 0.9;
    else units += 0.55;
  }
  return units * sizePt;
}

/**
 * Wrap text to maxWidth using an explicit newline split, then word wrap.
 * measure(text) returns width in the same units as maxWidth.
 */
export function wrapLines(text, maxWidth, measure) {
  const paragraphs = String(text ?? "").split("\n");
  const lines = [];
  for (const para of paragraphs) {
    if (para === "") {
      lines.push("");
      continue;
    }
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const trial = current ? `${current} ${word}` : word;
      if (!current || measure(trial) <= maxWidth) {
        current = trial;
        continue;
      }
      lines.push(current);
      current = word;
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [""];
}

/**
 * Largest integer font size (pt) whose wrapped lines fit in the padded box.
 * measure(text, sizePt) → width in pt.
 */
export function fitFontSize(text, widthPt, heightPt, measure, { min = 4, max = 72 } = {}) {
  const pad = boxPadding(widthPt, heightPt);
  const maxW = Math.max(1, widthPt - pad * 2);
  const maxH = Math.max(1, heightPt - pad * 2);
  let lo = min;
  let hi = max;
  let best = min;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const lines = wrapLines(text, maxW, (line) => measure(line, mid));
    const height = lines.length * mid * LINE_HEIGHT;
    const widthOk = lines.every((line) => measure(line, mid) <= maxW + 0.01);
    if (height <= maxH + 0.01 && widthOk) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Layout for centered, fitted text. Coordinates are in the same unit as the box
 * (points when width/height are in points).
 */
export function fitTextLayout(text, widthPt, heightPt, measure, options) {
  const pad = boxPadding(widthPt, heightPt);
  const maxW = Math.max(1, widthPt - pad * 2);
  const maxH = Math.max(1, heightPt - pad * 2);
  const size = fitFontSize(text, widthPt, heightPt, measure, options);
  const lines = wrapLines(text, maxW, (line) => measure(line, size));
  const lineH = size * LINE_HEIGHT;
  const blockH = lines.length * lineH;
  const startY = pad + Math.max(0, (maxH - blockH) / 2);
  return {
    size,
    lines,
    lineHeight: lineH,
    pad,
    startY,
    centerX: widthPt / 2,
  };
}
