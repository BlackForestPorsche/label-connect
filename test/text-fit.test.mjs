import assert from "node:assert/strict";
import test from "node:test";
import {
  approxTextWidth,
  boxPadding,
  fitFontSize,
  fitTextLayout,
  wrapLines,
  LINE_HEIGHT,
} from "../shared/text-fit.mjs";

test("wrapLines keeps hard breaks and wraps long lines", () => {
  const measure = (text) => approxTextWidth(text, 10);
  const lines = wrapLines("Hello world\nNext", 40, measure);
  assert.ok(lines.length >= 2);
  assert.equal(lines.at(-1), "Next");
});

test("fitFontSize grows until the box is full", () => {
  const measure = (text, size) => approxTextWidth(text, size);
  const small = fitFontSize("OK", 80, 40, measure);
  const large = fitFontSize("OK", 200, 100, measure);
  assert.ok(small >= 4);
  assert.ok(large > small);
  assert.ok(large <= 72);
});

test("fitTextLayout centers inside padded box", () => {
  const measure = (text, size) => approxTextWidth(text, size);
  const width = 100;
  const height = 60;
  const layout = fitTextLayout("Logan Test", width, height, measure);
  const pad = boxPadding(width, height);
  const blockH = layout.lines.length * layout.lineHeight;
  assert.equal(layout.centerX, width / 2);
  assert.ok(layout.startY >= pad - 0.01);
  assert.ok(layout.startY + blockH <= height - pad + 0.5);
  assert.equal(layout.lineHeight, layout.size * LINE_HEIGHT);
});

test("empty words still return a layout", () => {
  const measure = (text, size) => approxTextWidth(text, size);
  const layout = fitTextLayout("", 50, 20, measure);
  assert.ok(layout.size >= 4);
  assert.deepEqual(layout.lines, [""]);
});
