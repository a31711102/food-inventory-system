/**
 * グレースケール画像の前処理（ブラウザとテストで同じコードを使う）。
 *
 * ジャーナルの写真は感熱紙をスマホで撮ったもので、影・重なり・照明ムラがある。
 * そのまま OCR にかけると信頼度25%でほぼ読めなかった（2026年8月の写真で検証）。
 * 次の処理で数字の行を切り出せる品質にする。
 *  1. flatten: 大きくぼかした画像を「背景」とみなし、元画像を背景で割って影を消す
 *  2. findRowBands: 金額欄（右寄せ）の黒画素の横方向プロファイルから行を見つける
 */

export interface Gray {
  width: number;
  height: number;
  /** 0〜255。1画素1バイト */
  data: Uint8Array;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** RGBA（Canvas の ImageData、jpeg-js の出力）からグレースケールへ */
export function toGray(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = (rgba[j]! * 299 + rgba[j + 1]! * 587 + rgba[j + 2]! * 114) / 1000;
  }
  return { width, height, data };
}

/**
 * 拡大縮小。縮小は面積平均、拡大は双線形。
 * ブラウザの Canvas に任せると実装ごとに結果が変わるので、自前で行う。
 */
export function resize(src: Gray, scale: number): Gray {
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const data = new Uint8Array(width * height);
  if (scale < 1) {
    const inv = 1 / scale;
    for (let y = 0; y < height; y++) {
      const y0 = Math.floor(y * inv), y1 = Math.min(src.height, Math.floor((y + 1) * inv));
      for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * inv), x1 = Math.min(src.width, Math.floor((x + 1) * inv));
        let sum = 0, n = 0;
        for (let yy = y0; yy < Math.max(y1, y0 + 1); yy++) {
          const row = yy * src.width;
          for (let xx = x0; xx < Math.max(x1, x0 + 1); xx++) { sum += src.data[row + xx]!; n++; }
        }
        data[y * width + x] = sum / n;
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      const fy = Math.min(src.height - 1, (y + 0.5) / scale - 0.5);
      const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(src.height - 1, y0 + 1), wy = Math.max(0, fy - y0);
      for (let x = 0; x < width; x++) {
        const fx = Math.min(src.width - 1, (x + 0.5) / scale - 0.5);
        const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(src.width - 1, x0 + 1), wx = Math.max(0, fx - x0);
        const a = src.data[y0 * src.width + x0]!, b = src.data[y0 * src.width + x1]!;
        const c = src.data[y1 * src.width + x0]!, d = src.data[y1 * src.width + x1]!;
        data[y * width + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
      }
    }
  }
  return { width, height, data };
}

/**
 * 影を消す。半径 r の窓の平均を背景とみなし、元の明るさを背景で割る。
 * 累積和を使うので半径に関係なく画素数に比例した時間で終わる。
 */
export function flatten(src: Gray, radius: number): Gray {
  const { width: w, height: h } = src;
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += src.data[y * w + x]!;
      sat[(y + 1) * (w + 1) + (x + 1)] = sat[y * (w + 1) + (x + 1)]! + rowSum;
    }
  }
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - radius), yb = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - radius), xb = Math.min(w, x + radius + 1);
      const s = sat[yb * (w + 1) + xb]! - sat[ya * (w + 1) + xb]! - sat[yb * (w + 1) + xa]! + sat[ya * (w + 1) + xa]!;
      const bg = s / ((yb - ya) * (xb - xa));
      data[y * w + x] = Math.min(255, (src.data[y * w + x]! / Math.max(1, bg)) * 255);
    }
  }
  return { width: w, height: h, data };
}

export function crop(src: Gray, r: Rect): Gray {
  const left = Math.max(0, Math.round(r.left));
  const top = Math.max(0, Math.round(r.top));
  const width = Math.max(1, Math.min(src.width - left, Math.round(r.width)));
  const height = Math.max(1, Math.min(src.height - top, Math.round(r.height)));
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    data.set(src.data.subarray((top + y) * src.width + left, (top + y) * src.width + left + width), y * width);
  }
  return { width, height, data };
}

/** 縦方向の行（金額欄に黒画素がある範囲）。y は画像の上からの画素位置 */
export interface Band {
  y0: number;
  y1: number;
}

/**
 * 金額欄（x の範囲）の黒画素を横に数え、文字の行を見つける。
 * 感熱紙の金額は右寄せなので、この範囲に必ず数字が入る。
 */
export function findRowBands(src: Gray, xFrom: number, xTo: number, opts: { dark?: number; minDots?: number; minHeight?: number } = {}): Band[] {
  const dark = opts.dark ?? 150;
  const minDots = opts.minDots ?? Math.max(3, Math.round(src.width * 0.003));
  const minHeight = opts.minHeight ?? Math.max(8, Math.round(src.height * 0.0055));
  const a = Math.max(0, Math.round(xFrom)), b = Math.min(src.width, Math.round(xTo));
  const bands: Band[] = [];
  let start = -1;
  for (let y = 0; y <= src.height; y++) {
    let c = 0;
    if (y < src.height) {
      const row = y * src.width;
      for (let x = a; x < b; x++) if (src.data[row + x]! < dark) c++;
    }
    const on = y < src.height && c > minDots;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      if (y - start > minHeight) bands.push({ y0: start, y1: y });
      start = -1;
    }
  }
  return bands;
}

/** Tesseract（Leptonica）が直接読める PGM 形式へ。圧縮しないので画質が落ちない */
export function encodePgm(g: Gray): Uint8Array {
  const head = new TextEncoder().encode(`P5\n${g.width} ${g.height}\n255\n`);
  const out = new Uint8Array(head.length + g.data.length);
  out.set(head, 0);
  out.set(g.data, head.length);
  return out;
}
