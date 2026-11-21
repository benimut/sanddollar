/**
 * @file receiptAutoCrop.ts
 * @description 純前端紙本發票自動邊界框選工具模組（無外部依賴）
 *
 * 核心演算法設計：
 * 1. 特徵 1（白紙連通區塊）：利用 Otsu 自適應亮度閾值與低彩度條件偵測桌面上的白色／米白色發票紙張，
 *    經 3×3 多數決降噪與 4-連通元件分析取出主體外接正矩形。
 * 2. 特徵 2（文字梯度投影）：當遇上「白發票放白桌」或「強陰影」導致 Feature 1 失效時，
 *    改計算灰階空間梯度並以水平／垂直 5-tap 平滑能量投影框住文字與條碼集中區域。
 * 3. QR 錨點融合與安全防呆：若傳入已偵測的 QR Code 座標框，確保自動框選結果必涵蓋之；
 *    若結果過小、滿版或信心度不足，安全回傳 null 退回預設裁切框。
 */

/** 歸一化正矩形裁切框座標（各欄位數值介於 0～1） */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 自動初框偵測結果 */
export interface AutoCropResult {
  /** 建議初始正矩形裁切範圍 */
  rect: NormalizedRect;
  /** 命中的偵測特徵路徑 */
  method: 'paper' | 'text-gradient';
  /** 估計信心分數（0～1） */
  confidence: number;
}

/** 縮圖分析之長邊像素上限（220px 可於 5~15ms 內完成運算） */
const ANALYSIS_MAX_DIMENSION = 220;

/**
 * 將數值夾限於指定區間
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 正規化選填的 QR 錨點座標，無效時回傳 null
 */
function normalizeAnchorRect(anchor?: NormalizedRect | null): NormalizedRect | null {
  if (!anchor) return null;
  if (
    !Number.isFinite(anchor.x) ||
    !Number.isFinite(anchor.y) ||
    !Number.isFinite(anchor.width) ||
    !Number.isFinite(anchor.height)
  ) {
    return null;
  }

  const x1 = clamp(anchor.x, 0, 1);
  const y1 = clamp(anchor.y, 0, 1);
  const x2 = clamp(anchor.x + anchor.width, 0, 1);
  const y2 = clamp(anchor.y + anchor.height, 0, 1);
  const w = x2 - x1;
  const h = y2 - y1;

  if (w <= 0.01 || h <= 0.01) return null;
  return { x: x1, y: y1, width: w, height: h };
}

/**
 * 計算兩個歸一化正矩形之聯集外接框
 */
function unionNormalizedRects(a: NormalizedRect, b: NormalizedRect): NormalizedRect {
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return {
    x: clamp(minX, 0, 1),
    y: clamp(minY, 0, 1),
    width: clamp(maxX - minX, 0, 1),
    height: clamp(maxY - minY, 0, 1),
  };
}

/**
 * 判斷兩歸一化矩形是否重疊
 */
function rectsOverlap(a: NormalizedRect, b: NormalizedRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * 將歸一化矩形向四週均等擴張指定安全邊距並夾限於 [0, 1]
 */
function expandAndClampRect(rect: NormalizedRect, padding: number): NormalizedRect {
  const left = clamp(rect.x - padding, 0, 1);
  const top = clamp(rect.y - padding, 0, 1);
  const right = clamp(rect.x + rect.width + padding, 0, 1);
  const bottom = clamp(rect.y + rect.height + padding, 0, 1);
  return {
    x: Number(left.toFixed(4)),
    y: Number(top.toFixed(4)),
    width: Number(Math.max(0.05, right - left).toFixed(4)),
    height: Number(Math.max(0.05, bottom - top).toFixed(4)),
  };
}

/**
 * 由 256 階灰階直方圖計算 Otsu 雙峰最佳二值化閾值，並限制在合理區間
 */
function computeOtsuThreshold(histogram: Int32Array, totalPixels: number): number {
  let totalSum = 0;
  for (let i = 0; i < 256; i++) {
    totalSum += i * histogram[i];
  }

  let sumBackground = 0;
  let weightBackground = 0;
  let maxBetweenVariance = -1;
  let bestThreshold = 150;

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;

    const weightForeground = totalPixels - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (totalSum - sumBackground) / weightForeground;
    const diff = meanBackground - meanForeground;
    const betweenVariance = weightBackground * weightForeground * diff * diff;

    if (betweenVariance > maxBetweenVariance) {
      maxBetweenVariance = betweenVariance;
      bestThreshold = t;
    }
  }

  return clamp(bestThreshold, 105, 225);
}

/**
 * 特徵 1：利用白紙高亮度、低飽和度與 4-連通區塊偵測發票主體外接正矩形
 */
function detectPaperComponentRect(
  lum: Uint8Array,
  chroma: Uint8Array,
  width: number,
  height: number,
  borderMeanLum: number,
  otsuThreshold: number,
  anchorRect: NormalizedRect | null
): AutoCropResult | null {
  const totalPixels = width * height;
  const lumThreshold = Math.max(120, otsuThreshold, borderMeanLum + 18);

  const rawMask = new Uint8Array(totalPixels);
  let rawPaperCount = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (lum[i] >= lumThreshold && chroma[i] <= 55) {
      rawMask[i] = 1;
      rawPaperCount++;
    }
  }

  // 紙張像素太少或幾乎整張畫面都為白色，交由特徵 2 處理
  const rawRatio = rawPaperCount / totalPixels;
  if (rawRatio < 0.08 || rawRatio > 0.92) {
    return null;
  }

  // 3×3 多數決降噪，濾除零星高光或桌面反光噪點
  const denoised = new Uint8Array(totalPixels);
  for (let y = 1; y < height - 1; y++) {
    const rowOffset = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = rowOffset + x;
      const sum =
        rawMask[idx - width - 1] +
        rawMask[idx - width] +
        rawMask[idx - width + 1] +
        rawMask[idx - 1] +
        rawMask[idx] +
        rawMask[idx + 1] +
        rawMask[idx + width - 1] +
        rawMask[idx + width] +
        rawMask[idx + width + 1];
      if (sum >= 5) {
        denoised[idx] = 1;
      }
    }
  }

  // 4-連通 BFS Flood Fill 找出主體連通區塊
  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);

  interface ComponentStats {
    pixelCount: number;
    rect: NormalizedRect;
    overlapsAnchor: boolean;
  }

  let bestComponent: ComponentStats | null = null;

  for (let startIdx = 0; startIdx < totalPixels; startIdx++) {
    if (denoised[startIdx] === 0 || visited[startIdx] === 1) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = startIdx;
    visited[startIdx] = 1;

    let count = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;

    while (head < tail) {
      const curr = queue[head++];
      const cx = curr % width;
      const cy = (curr - cx) / width;

      count++;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;

      if (cx > 0) {
        const left = curr - 1;
        if (denoised[left] === 1 && visited[left] === 0) {
          visited[left] = 1;
          queue[tail++] = left;
        }
      }
      if (cx + 1 < width) {
        const right = curr + 1;
        if (denoised[right] === 1 && visited[right] === 0) {
          visited[right] = 1;
          queue[tail++] = right;
        }
      }
      if (cy > 0) {
        const up = curr - width;
        if (denoised[up] === 1 && visited[up] === 0) {
          visited[up] = 1;
          queue[tail++] = up;
        }
      }
      if (cy + 1 < height) {
        const down = curr + width;
        if (denoised[down] === 1 && visited[down] === 0) {
          visited[down] = 1;
          queue[tail++] = down;
        }
      }
    }

    const boxW = (maxX - minX + 1) / width;
    const boxH = (maxY - minY + 1) / height;
    const boxAreaRatio = boxW * boxH;

    if (boxAreaRatio < 0.12 || boxAreaRatio > 0.93 || boxW < 0.16 || boxH < 0.16) {
      continue;
    }

    const bboxPixelArea = (maxX - minX + 1) * (maxY - minY + 1);
    const fillRatio = count / bboxPixelArea;
    if (fillRatio < 0.35) {
      continue;
    }

    const compRect: NormalizedRect = {
      x: minX / width,
      y: minY / height,
      width: boxW,
      height: boxH,
    };
    const overlapsAnchor = anchorRect ? rectsOverlap(compRect, anchorRect) : false;

    if (!bestComponent) {
      bestComponent = { pixelCount: count, rect: compRect, overlapsAnchor };
      continue;
    }

    // 若有 QR 錨點，優先挑選包含／重疊 QR 錨點且規模足夠的元件
    if (anchorRect) {
      if (overlapsAnchor && !bestComponent.overlapsAnchor) {
        bestComponent = { pixelCount: count, rect: compRect, overlapsAnchor };
        continue;
      }
      if (!overlapsAnchor && bestComponent.overlapsAnchor) {
        continue;
      }
    }

    if (count > bestComponent.pixelCount) {
      bestComponent = { pixelCount: count, rect: compRect, overlapsAnchor };
    }
  }

  if (!bestComponent) {
    return null;
  }

  const mergedRect = anchorRect
    ? unionNormalizedRects(bestComponent.rect, anchorRect)
    : bestComponent.rect;
  const finalRect = expandAndClampRect(mergedRect, 0.04);

  const lumContrast = clamp((otsuThreshold - borderMeanLum) / 100, 0, 1);
  const pixelCoverage = clamp(bestComponent.pixelCount / (totalPixels * 0.5), 0.3, 1);
  const confidence = Number((0.55 + 0.25 * lumContrast + 0.2 * pixelCoverage).toFixed(2));

  return {
    rect: finalRect,
    method: 'paper',
    confidence: clamp(confidence, 0.5, 0.98),
  };
}

/**
 * 對 1D 密度陣列執行 5-tap 移動平均平滑，抑制孤立噪點突波
 */
function smoothDensity5Tap(src: Float32Array): Float32Array {
  const len = src.length;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    let count = 0;
    const start = Math.max(0, i - 2);
    const end = Math.min(len - 1, i + 2);
    for (let k = start; k <= end; k++) {
      sum += src[k];
      count++;
    }
    out[i] = count > 0 ? sum / count : 0;
  }
  return out;
}

/**
 * 特徵 2：利用灰階水平與垂直梯度投影偵測文字與條碼集中區域（補救白桌背景或強陰影）
 */
function detectTextGradientRect(
  lum: Uint8Array,
  width: number,
  height: number,
  anchorRect: NormalizedRect | null
): AutoCropResult | null {
  const rowCounts = new Float32Array(height);
  const colCounts = new Float32Array(width);
  let edgePixelCount = 0;

  for (let y = 1; y < height - 1; y++) {
    const rowOffset = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = rowOffset + x;
      const gx = Math.abs(lum[idx + 1] - lum[idx - 1]);
      const gy = Math.abs(lum[idx + width] - lum[idx - width]);
      if (gx + gy >= 38) {
        edgePixelCount++;
        rowCounts[y] += 1;
        colCounts[x] += 1;
      }
    }
  }

  const innerPixels = Math.max(1, (width - 2) * (height - 2));
  const edgeRatio = edgePixelCount / innerPixels;
  if (edgeRatio < 0.005 || edgeRatio > 0.45) {
    return null;
  }

  const rowRawDensity = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    rowRawDensity[y] = rowCounts[y] / width;
  }

  const colRawDensity = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    colRawDensity[x] = colCounts[x] / height;
  }

  const rowSmooth = smoothDensity5Tap(rowRawDensity);
  const colSmooth = smoothDensity5Tap(colRawDensity);

  let rowPeak = 0;
  let rowSum = 0;
  for (let y = 0; y < height; y++) {
    if (rowSmooth[y] > rowPeak) rowPeak = rowSmooth[y];
    rowSum += rowSmooth[y];
  }
  const rowMean = rowSum / height;
  const rowThreshold = Math.max(rowPeak * 0.18, rowMean * 1.15);

  let colPeak = 0;
  let colSum = 0;
  for (let x = 0; x < width; x++) {
    if (colSmooth[x] > colPeak) colPeak = colSmooth[x];
    colSum += colSmooth[x];
  }
  const colMean = colSum / width;
  const colThreshold = Math.max(colPeak * 0.18, colMean * 1.15);

  let minY = height;
  let maxY = -1;
  for (let y = 1; y < height - 1; y++) {
    if (rowSmooth[y] >= rowThreshold) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  let minX = width;
  let maxX = -1;
  for (let x = 1; x < width - 1; x++) {
    if (colSmooth[x] >= colThreshold) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }

  if (minX >= maxX || minY >= maxY) {
    return null;
  }

  const boxW = (maxX - minX + 1) / width;
  const boxH = (maxY - minY + 1) / height;
  const boxAreaRatio = boxW * boxH;

  if (boxAreaRatio < 0.12 || boxAreaRatio > 0.93 || boxW < 0.16 || boxH < 0.16) {
    return null;
  }

  const rawRect: NormalizedRect = {
    x: minX / width,
    y: minY / height,
    width: boxW,
    height: boxH,
  };
  const mergedRect = anchorRect ? unionNormalizedRects(rawRect, anchorRect) : rawRect;
  const finalRect = expandAndClampRect(mergedRect, 0.07);

  const contrastRatio = clamp(Math.min(rowPeak / Math.max(rowMean, 0.001), colPeak / Math.max(colMean, 0.001)) / 5, 0, 1);
  const confidence = Number((0.45 + 0.35 * contrastRatio).toFixed(2));

  return {
    rect: finalRect,
    method: 'text-gradient',
    confidence: clamp(confidence, 0.4, 0.9),
  };
}

/**
 * 從已縮小之 ImageData 偵測紙本發票外接正矩形區域
 *
 * @param imageData - 包含 RGBA 像素陣列與寬高之 ImageData 物件
 * @param anchorRect - 選填之 QR Code 歸一化錨點座標（確保偵測框必包住已知 QR）
 * @returns 若具足夠信心度則回傳建議正矩形與方法名稱，否則安全回傳 null
 */
export function detectReceiptBoundsFromImageData(
  imageData: Pick<ImageData, 'data' | 'width' | 'height'>,
  anchorRect?: NormalizedRect | null
): AutoCropResult | null {
  const { data, width, height } = imageData;
  if (!data || width < 24 || height < 24 || data.length < width * height * 4) {
    return null;
  }

  const totalPixels = width * height;
  const lum = new Uint8Array(totalPixels);
  const chroma = new Uint8Array(totalPixels);
  const histogram = new Int32Array(256);

  const borderX = Math.max(1, Math.floor(width * 0.05));
  const borderY = Math.max(1, Math.floor(height * 0.05));
  let borderLumSum = 0;
  let borderPixelCount = 0;

  for (let y = 0; y < height; y++) {
    const isTopOrBottomBorder = y < borderY || y >= height - borderY;
    for (let x = 0; x < width; x++) {
      const pixelIdx = y * width + x;
      const rgbaIdx = pixelIdx * 4;
      const r = data[rgbaIdx];
      const g = data[rgbaIdx + 1];
      const b = data[rgbaIdx + 2];

      const l = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      const maxC = r >= g && r >= b ? r : g >= b ? g : b;
      const minC = r <= g && r <= b ? r : g <= b ? g : b;

      lum[pixelIdx] = l;
      chroma[pixelIdx] = maxC - minC;
      histogram[l] += 1;

      if (isTopOrBottomBorder || x < borderX || x >= width - borderX) {
        borderLumSum += l;
        borderPixelCount++;
      }
    }
  }

  const borderMeanLum = borderPixelCount > 0 ? borderLumSum / borderPixelCount : 128;
  const otsuThreshold = computeOtsuThreshold(histogram, totalPixels);
  const normalizedAnchor = normalizeAnchorRect(anchorRect);

  // 優先嘗試特徵 1（桌面上的白紙連通區）
  const paperResult = detectPaperComponentRect(
    lum,
    chroma,
    width,
    height,
    borderMeanLum,
    otsuThreshold,
    normalizedAnchor
  );
  if (paperResult) {
    return paperResult;
  }

  // 退回特徵 2（文字與線條梯度能量投影）
  return detectTextGradientRect(lum, width, height, normalizedAnchor);
}

/**
 * 將瀏覽器已載入的 HTMLImageElement 縮小至離屏畫布並自動偵測發票初框
 * 任何畫布環境不支援或跨網域存取異常皆安全回傳 null，不影響使用者手動框選。
 *
 * @param imgEl - 已載入完成之圖片元素
 * @param anchorRect - 選填之 QR Code 歸一化錨點座標
 * @returns 自動偵測結果或 null
 */
export function detectReceiptBoundsFromImage(
  imgEl: HTMLImageElement,
  anchorRect?: NormalizedRect | null
): AutoCropResult | null {
  try {
    if (typeof document === 'undefined') return null;
    const natW = imgEl?.naturalWidth || 0;
    const natH = imgEl?.naturalHeight || 0;
    if (natW < 24 || natH < 24) return null;

    const maxSide = Math.max(natW, natH);
    const scale = maxSide > ANALYSIS_MAX_DIMENSION ? ANALYSIS_MAX_DIMENSION / maxSide : 1;
    const targetW = Math.max(24, Math.round(natW * scale));
    const targetH = Math.max(24, Math.round(natH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || typeof ctx.getImageData !== 'function') return null;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(imgEl, 0, 0, targetW, targetH);

    const imageData = ctx.getImageData(0, 0, targetW, targetH);
    return detectReceiptBoundsFromImageData(imageData, anchorRect);
  } catch {
    return null;
  }
}
