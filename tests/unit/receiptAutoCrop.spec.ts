import { describe, it, expect } from 'vitest';
import {
  detectReceiptBoundsFromImageData,
  type NormalizedRect,
} from '@/utils/receiptAutoCrop';

/**
 * 建立測試用偽隨機雜訊產生器（線性同餘），避免測試圖片退化為單調純色
 */
function createSeededNoise(seedInit = 42) {
  let seed = seedInit >>> 0;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed >>> 24) & 0xff;
  };
}

/**
 * 繪製具備多色木紋背景與文字／條碼明細紋理的發票測試影像資料
 */
function createSyntheticReceiptImage(options: {
  width: number;
  height: number;
  paperBox: { x0: number; y0: number; x1: number; y1: number };
  whiteBackground?: boolean;
}) {
  const { width, height, paperBox, whiteBackground = false } = options;
  const data = new Uint8ClampedArray(width * height * 4);
  const nextRand = createSeededNoise(1024);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const noise = (nextRand() % 17) - 8;

      const insidePaper =
        x >= paperBox.x0 && x <= paperBox.x1 && y >= paperBox.y0 && y <= paperBox.y1;

      let r = 0;
      let g = 0;
      let b = 0;

      if (!insidePaper) {
        if (whiteBackground) {
          // 淺灰白桌面帶細微斜向桌面紋理
          const grain = ((x + y) % 5 === 0 ? -6 : 2) + Math.floor(noise * 0.4);
          r = 242 + grain;
          g = 242 + grain;
          b = 240 + grain;
        } else {
          // 深色木桌漸層＋木紋條紋
          const stripe = Math.sin(y * 0.35 + x * 0.06) * 10;
          r = 92 + stripe + noise;
          g = 64 + stripe * 0.7 + noise;
          b = 44 + stripe * 0.5 + noise;
        }
      } else {
        // 紙本發票底色帶光影漸層
        const paperTone =
          244 - Math.floor(((y - paperBox.y0) / Math.max(1, paperBox.y1 - paperBox.y0)) * 12);
        r = paperTone + Math.floor(noise * 0.4);
        g = paperTone + Math.floor(noise * 0.4);
        b = paperTone - 3 + Math.floor(noise * 0.4);

        // 在發票內部模擬標題、金額文字行與底部條碼深色線段
        const relX = (x - paperBox.x0) / Math.max(1, paperBox.x1 - paperBox.x0);
        const relY = (y - paperBox.y0) / Math.max(1, paperBox.y1 - paperBox.y0);
        const isTextRow =
          relX > 0.1 &&
          relX < 0.9 &&
          ((relY > 0.1 && relY < 0.72 && Math.floor(relY * 22) % 2 === 0 && ((x * 7 + y) % 3 !== 0)) ||
            (relY > 0.78 && relY < 0.92 && x % 3 === 0));

        if (isTextRow) {
          r = 28 + Math.abs(noise);
          g = 32 + Math.abs(noise);
          b = 38 + Math.abs(noise);
        }
      }

      data[idx] = Math.max(0, Math.min(255, r));
      data[idx + 1] = Math.max(0, Math.min(255, g));
      data[idx + 2] = Math.max(0, Math.min(255, b));
      data[idx + 3] = 255;
    }
  }

  return { data, width, height };
}

describe('receiptAutoCrop 純前端紙本發票自動初框偵測套件', () => {
  it('深色木桌背景上的淺色紙本發票應透過白紙區塊偵測緊貼框住發票且不額外外擴邊距', () => {
    const img = createSyntheticReceiptImage({
      width: 180,
      height: 220,
      paperBox: { x0: 42, y0: 26, x1: 138, y1: 188 },
      whiteBackground: false,
    });

    const result = detectReceiptBoundsFromImageData(img);
    expect(result).not.toBeNull();
    expect(result?.method).toBe('paper');

    const rect = result!.rect;
    // 應緊貼紙張真實邊界（容許 3×3 降噪 1~2px 微差）且不額外外擴至背景
    expect(rect.x).toBeGreaterThanOrEqual(40 / 180);
    expect(rect.x).toBeLessThanOrEqual(44 / 180);
    expect(rect.y).toBeGreaterThanOrEqual(24 / 220);
    expect(rect.y).toBeLessThanOrEqual(28 / 220);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(136 / 180);
    expect(rect.x + rect.width).toBeLessThanOrEqual(140 / 180);
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(186 / 220);
    expect(rect.y + rect.height).toBeLessThanOrEqual(190 / 220);
  });

  it('白色桌面背景導致紙張邊界融於背景時，應自動切換文字梯度投影緊貼框住文字主體區', () => {
    const img = createSyntheticReceiptImage({
      width: 180,
      height: 220,
      paperBox: { x0: 46, y0: 32, x1: 134, y1: 184 },
      whiteBackground: true,
    });

    const result = detectReceiptBoundsFromImageData(img);
    expect(result).not.toBeNull();
    expect(result?.method).toBe('text-gradient');

    const rect = result!.rect;
    // 應包住核心文字與條碼區且無過度外擴邊距
    expect(rect.x).toBeLessThanOrEqual(62 / 180);
    expect(rect.y).toBeLessThanOrEqual(56 / 220);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(118 / 180);
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(162 / 220);
    expect(rect.width).toBeLessThan(0.65);
  });

  it('傳入電子發票 QR 錨點座標時，自動框選結果必完整涵蓋該 QR 錨點區域', () => {
    const img = createSyntheticReceiptImage({
      width: 180,
      height: 220,
      paperBox: { x0: 42, y0: 26, x1: 138, y1: 165 },
      whiteBackground: false,
    });

    const anchor: NormalizedRect = {
      x: 0.48,
      y: 0.78,
      width: 0.16,
      height: 0.12,
    };

    const result = detectReceiptBoundsFromImageData(img, anchor);
    expect(result).not.toBeNull();

    const rect = result!.rect;
    expect(rect.x).toBeLessThanOrEqual(anchor.x);
    expect(rect.y).toBeLessThanOrEqual(anchor.y);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(anchor.x + anchor.width);
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(anchor.y + anchor.height);
  });

  it('尺寸過小或缺乏對比與文字紋理的影像應安全回傳 null（退回預設框）', () => {
    const tiny = {
      data: new Uint8ClampedArray(16 * 16 * 4),
      width: 16,
      height: 16,
    };
    expect(detectReceiptBoundsFromImageData(tiny)).toBeNull();

    // 低對比紋理畫面（無發票主體）
    const w = 120;
    const h = 120;
    const flatGrad = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const val = 110 + ((x + y) % 8);
        flatGrad[i] = val;
        flatGrad[i + 1] = val + 2;
        flatGrad[i + 2] = val - 2;
        flatGrad[i + 3] = 255;
      }
    }
    expect(detectReceiptBoundsFromImageData({ data: flatGrad, width: w, height: h })).toBeNull();
  });
});
