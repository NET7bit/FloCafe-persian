/**
 * Receipt header logo.
 *
 * The owner drops a PNG at `<userData>/logo.png`; it is scaled to the printer's
 * dot width and emitted as a single GS v 0 raster block. No settings UI and no
 * upload path yet — the file is the configuration.
 *
 * Everything here is best-effort: a missing, unreadable or corrupt logo must
 * never stop a receipt from printing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const RECEIPT_LOGO_FILENAME = 'logo.png';

/** Hard ceiling on logo height so a tall image cannot eat a whole receipt. */
const MAX_LOGO_HEIGHT_DOTS = 96;

/** Share of the paper width the logo may occupy. */
const LOGO_WIDTH_RATIO = 0.45;

export function receiptLogoPath(userDataPath: string): string {
  return path.join(userDataPath, RECEIPT_LOGO_FILENAME);
}

/**
 * The app's userData directory, or '' when Electron is not available (unit
 * tests, build scripts). Callers treat '' as "no logo".
 */
export function resolveUserDataPath(): string {
  try {
    const { app } = require('electron') as typeof import('electron');
    return app?.getPath?.('userData') ?? '';
  } catch {
    return '';
  }
}

export interface BitmapLike {
  /** BGRA, row-major, `width * height * 4` bytes. */
  readonly data: Buffer | Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Encode a bitmap as a centred ESC/POS raster block (GS v 0).
 *
 * Pixels darker than the midpoint become black; fully transparent pixels are
 * treated as white so a logo with an alpha background does not print a slab.
 */
export function encodeLogoRaster(bitmap: BitmapLike, widthDots: number): Buffer | null {
  const { width, height } = bitmap;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (widthDots <= 0) return null;

  const bytesPerRow = Math.ceil(width / 8);
  const out = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const b = bitmap.data[i] ?? 0;
      const g = bitmap.data[i + 1] ?? 0;
      const r = bitmap.data[i + 2] ?? 0;
      const a = bitmap.data[i + 3] ?? 255;
      const luminance = a < 32 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b;
      if (luminance < 128) out[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  const header = Buffer.from([
    0x1d, 0x76, 0x30, 0x00,
    bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
    height & 0xff, (height >> 8) & 0xff,
  ]);
  // Centre, draw, then return to left alignment for the text that follows.
  return Buffer.concat([Buffer.from([0x1b, 0x61, 0x01]), header, out, Buffer.from([0x1b, 0x61, 0x00])]);
}

/**
 * Load `<userData>/logo.png` and encode it for a printer that is `cols` columns
 * wide. Returns null when there is no usable logo.
 */
export function loadReceiptLogo(userDataPath: string, cols: number): Buffer | null {
  try {
    const filePath = receiptLogoPath(userDataPath);
    if (!fs.existsSync(filePath)) return null;

    // Loaded lazily so a test harness that mocks `electron` without
    // `nativeImage` still runs every other print path.
    const { nativeImage } = require('electron') as typeof import('electron');
    if (!nativeImage) return null;

    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) return null;

    const source = image.getSize();
    if (!source.width || !source.height) return null;

    const targetWidth = Math.max(1, Math.min(Math.round(cols * 8 * LOGO_WIDTH_RATIO), source.width));
    const scale = targetWidth / source.width;
    const targetHeight = Math.max(1, Math.min(MAX_LOGO_HEIGHT_DOTS, Math.round(source.height * scale)));
    const resized = image.resize({ width: targetWidth, height: targetHeight, quality: 'good' });

    return encodeLogoRaster(
      { data: resized.toBitmap(), width: targetWidth, height: targetHeight },
      targetWidth,
    );
  } catch {
    return null;
  }
}

/**
 * Insert the logo directly after the printer's init sequence. A block placed
 * before `ESC @` would be wiped by the reset.
 */
export function insertLogoAfterInit(receipt: Buffer, logo: Buffer | null): Buffer {
  if (!logo || logo.length === 0) return receipt;
  const init = receipt.indexOf(Buffer.from([0x1b, 0x40]));
  const at = init >= 0 ? init + 2 : 0;
  return Buffer.concat([receipt.subarray(0, at), logo, receipt.subarray(at)]);
}
