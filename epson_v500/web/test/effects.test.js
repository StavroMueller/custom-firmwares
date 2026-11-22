import assert from "node:assert/strict";
import { test } from "node:test";

import { applyEffect, frameLayout } from "../effects.js";

const px = () => Uint8ClampedArray.from([200, 100, 50, 255, 10, 20, 30, 255, 250, 250, 250, 255]);

test("effects keep alpha and make greys", () => {
  assert.deepEqual(applyEffect(px(), "natural"), px());
  for (const effect of ["mono", "contrast", "photocopy"]) {
    const out = applyEffect(px(), effect);
    for (let i = 0; i < out.length; i += 4) {
      assert.equal(out[i], out[i + 1]);
      assert.equal(out[i + 1], out[i + 2]);
      assert.equal(out[i + 3], 255);
    }
  }
  const [mono, contrast] = [applyEffect(px(), "mono"), applyEffect(px(), "contrast")];
  assert.ok(contrast[4] <= mono[4] && contrast[8] >= mono[8]); // darks darker, lights lighter
});

test("the frame leaves room for a caption only when there is one", () => {
  const plain = frameLayout(1000, 800);
  const captioned = frameLayout(1000, 800, { caption: "Party" });
  assert.equal(plain.width, 1080);
  assert.equal(captioned.height - plain.height, 120);
});
