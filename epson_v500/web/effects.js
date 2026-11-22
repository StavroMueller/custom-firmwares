// Looks for booth photos, and the framed layout they're saved and printed in.
// Pure pixel work on RGBA data, so it runs anywhere (tests run it in Node).

export const EFFECTS = {
  natural: "Natural",
  mono: "Black & white",
  contrast: "High contrast",
  photocopy: "Photocopy",
};

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Apply an effect in place to RGBA pixels (an ImageData's .data).
export function applyEffect(px, effect) {
  if (effect === "natural" || !EFFECTS[effect]) return px;
  for (let i = 0; i < px.length; i += 4) {
    let v = luma(px[i], px[i + 1], px[i + 2]);
    if (effect === "contrast") {
      // an S-curve: deeper shadows, brighter highlights
      const x = v / 255;
      v = 255 * (x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x));
    } else if (effect === "photocopy") {
      // hard black and white with a little toner grain
      v = clamp((v - 128) * 3.2 + 150 + ((i * 2654435761) % 23) - 11);
    }
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  return px;
}

// Sizes for a framed photo: a white border and a band at the bottom for the
// caption, in proportion to the photo.
export function frameLayout(width, height, { caption = "", date = "" } = {}) {
  const border = Math.round(Math.max(width, height) * 0.04);
  const band = caption || date ? Math.round(Math.max(width, height) * 0.12) : 0;
  return { border, band, width: width + 2 * border, height: height + 2 * border + band };
}

// Draw `src` (a canvas), turned clockwise by `deg`, into a new canvas with
// the frame and caption. makeCanvas(w, h) creates the canvas (DOM or test).
export function compose(src, { deg = 0, caption = "", date = "", framed = true, makeCanvas }) {
  const side = deg % 180 !== 0;
  const w = side ? src.height : src.width;
  const h = side ? src.width : src.height;
  const layout = framed ? frameLayout(w, h, { caption, date }) : { border: 0, band: 0, width: w, height: h };
  const c = makeCanvas(layout.width, layout.height);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.save();
  ctx.translate(layout.border + w / 2, layout.border + h / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  ctx.restore();
  if (layout.band) {
    const y = layout.border + h + layout.band / 2;
    ctx.fillStyle = "#222";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const size = Math.round(layout.band * (date && caption ? 0.32 : 0.42));
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    if (caption && date) {
      ctx.fillText(caption, c.width / 2, y - size * 0.6);
      ctx.font = `400 ${Math.round(size * 0.7)}px system-ui, sans-serif`;
      ctx.fillStyle = "#666";
      ctx.fillText(date, c.width / 2, y + size * 0.7);
    } else {
      ctx.fillText(caption || date, c.width / 2, y);
    }
  }
  return c;
}
