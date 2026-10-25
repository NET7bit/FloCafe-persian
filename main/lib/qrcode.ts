/**
 * Lazily resolved `qrcode` module.
 *
 * `qrcode` (together with `pngjs`) accounts for ~57 modules of the startup import
 * graph, yet every caller only needs it to render a data URL inside a request
 * handler. Resolving it on first use keeps those modules out of startup.
 */
type QRCodeModule = typeof import('qrcode');

let qrcodeModule: QRCodeModule | null = null;

export async function loadQRCode(): Promise<QRCodeModule> {
  if (!qrcodeModule) qrcodeModule = await import('qrcode');
  return qrcodeModule;
}
