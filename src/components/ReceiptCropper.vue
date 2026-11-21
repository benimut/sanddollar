<script setup lang="ts">
/**
 * @file ReceiptCropper.vue
 * @description 紙本發票拍照後之正矩形框選裁切元件（不旋轉）
 *
 * 核心職責：
 * 1. 於原始拍攝靜態畫面中呈現可拖曳調整之正矩形選取框（支援手機單指觸控與滑鼠拖曳四角、四邊與框體）。
 * 2. 座標以相對於實際圖片顯示範圍之比例計算，精準映射回原始高解析度影像執行 Canvas 裁切。
 * 3. 裁切後自動依長邊上限等比縮放並壓縮為 JPEG，降低網路傳輸量與模型 Token 消耗。
 */

import { ref, computed } from 'vue';
import { Maximize2, RotateCcw, Sparkles } from 'lucide-vue-next';
import {
  detectReceiptBoundsFromImage,
  type NormalizedRect,
} from '@/utils/receiptAutoCrop';

/** 裁切並壓縮完成後輸出之影像資料 */
export interface CroppedImagePayload {
  /** 裁切壓縮後之二進位 JPEG Blob（可直接透過 FormData 上傳，無 Base64 膨脹） */
  imageBlob: Blob;
  /** 影像 MIME 類型（固定為 image/jpeg） */
  mimeType: 'image/jpeg';
  /** 輸出影像寬度（像素） */
  width: number;
  /** 輸出影像高度（像素） */
  height: number;
  /** 二進位影像位元組數 */
  sizeBytes: number;
}

/** 支援之拖曳操作類型（平移或八方向縮放，嚴格正矩形不旋轉） */
type DragHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

/** 裁切框最小寬／高比例，避免拖曳至零面積 */
const MIN_CROP_RATIO = 0.12;

/** 裁切輸出 JPEG 之長邊最大像素上限 */
const MAX_OUTPUT_DIMENSION = 1280;

/** 裁切輸出 JPEG 壓縮品質 */
const OUTPUT_JPEG_QUALITY = 0.78;

const props = withDefaults(
  defineProps<{
    /** 拍攝取得之原始圖片 URL（Object URL 或 Data URL） */
    imageDataUrl: string;
    /** 是否正在送出辨識中（鎖定按鈕互動） */
    isSubmitting?: boolean;
    /** 若照片中已偵測出電子發票 QR Code，提供其歸一化錨點供自動框選參考 */
    anchorRect?: NormalizedRect | null;
    /** 若已偵測出電子發票 QR Code，於裁切畫面上方顯示融合提示文字 */
    qrHintText?: string;
  }>(),
  {
    isSubmitting: false,
    anchorRect: null,
    qrHintText: '',
  }
);

const emit = defineEmits<{
  /** 重新拍照 */
  (e: 'retake'): void;
  /** 完成正矩形裁切並送出辨識 */
  (e: 'confirm', payload: CroppedImagePayload): void;
}>();

/** 圖片 DOM 參照（用於取得原始解析度與實際顯示框尺寸） */
const imageRef = ref<HTMLImageElement | null>(null);

/** 圖片已載入完成標記 */
const isImageLoaded = ref(false);

/** 影像裁切與 JPEG 編碼中標記（防止快速連點） */
const isEncoding = ref(false);

/** 當前正矩形選取框（預設保留些許邊距，方便使用者立即辨識可調邊界） */
const cropRect = ref<NormalizedRect>({
  x: 0.06,
  y: 0.06,
  width: 0.88,
  height: 0.88,
});

/** 目前進行中的拖曳狀態快照 */
interface ActiveDragState {
  handle: DragHandle;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startRect: NormalizedRect;
  boxWidth: number;
  boxHeight: number;
}

let activeDrag: ActiveDragState | null = null;

/** 裁切框 CSS 定位樣式 */
const cropBoxStyle = computed(() => ({
  left: `${cropRect.value.x * 100}%`,
  top: `${cropRect.value.y * 100}%`,
  width: `${cropRect.value.width * 100}%`,
  height: `${cropRect.value.height * 100}%`,
}));

/**
 * 將數值限制於指定區間內
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 圖片載入完成事件：嘗試以純前端影像處理自動定位發票初始框，失敗則退回預設框
 */
function handleImageLoad() {
  isImageLoaded.value = true;
  const imgEl = imageRef.value;
  if (!imgEl) return;

  const detected = detectReceiptBoundsFromImage(imgEl, props.anchorRect);
  cropRect.value = detected
    ? detected.rect
    : { x: 0.06, y: 0.06, width: 0.88, height: 0.88 };
}

/**
 * 重設為選取整張拍攝畫面
 */
function handleSelectFull() {
  if (props.isSubmitting) return;
  cropRect.value = { x: 0, y: 0, width: 1, height: 1 };
}

/**
 * 開始拖曳框體或邊角把手
 */
function onPointerDown(handle: DragHandle, event: PointerEvent) {
  if (props.isSubmitting) return;
  const imgEl = imageRef.value;
  if (!imgEl) return;

  const bounds = imgEl.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return;

  event.preventDefault();
  event.stopPropagation();

  const target = event.currentTarget as HTMLElement | null;
  if (target && typeof target.setPointerCapture === 'function') {
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // 部分瀏覽器環境忽略 pointer capture 例外
    }
  }

  activeDrag = {
    handle,
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startRect: { ...cropRect.value },
    boxWidth: bounds.width,
    boxHeight: bounds.height,
  };
}

/**
 * 拖曳移動中即時計算新的正矩形選取框座標
 */
function onPointerMove(event: PointerEvent) {
  if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;

  event.preventDefault();

  const dx = (event.clientX - activeDrag.startClientX) / activeDrag.boxWidth;
  const dy = (event.clientY - activeDrag.startClientY) / activeDrag.boxHeight;
  const { handle, startRect } = activeDrag;

  if (handle === 'move') {
    const nextX = clamp(startRect.x + dx, 0, 1 - startRect.width);
    const nextY = clamp(startRect.y + dy, 0, 1 - startRect.height);
    cropRect.value = {
      x: nextX,
      y: nextY,
      width: startRect.width,
      height: startRect.height,
    };
    return;
  }

  let left = startRect.x;
  let top = startRect.y;
  let right = startRect.x + startRect.width;
  let bottom = startRect.y + startRect.height;

  if (handle.includes('w')) {
    left = clamp(startRect.x + dx, 0, right - MIN_CROP_RATIO);
  }
  if (handle.includes('e')) {
    right = clamp(startRect.x + startRect.width + dx, left + MIN_CROP_RATIO, 1);
  }
  if (handle.includes('n')) {
    top = clamp(startRect.y + dy, 0, bottom - MIN_CROP_RATIO);
  }
  if (handle.includes('s')) {
    bottom = clamp(startRect.y + startRect.height + dy, top + MIN_CROP_RATIO, 1);
  }

  cropRect.value = {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * 結束拖曳互動
 */
function onPointerUp(event: PointerEvent) {
  if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
  const target = event.currentTarget as HTMLElement | null;
  if (target && typeof target.releasePointerCapture === 'function') {
    try {
      target.releasePointerCapture(event.pointerId);
    } catch {
      // 忽略已釋放例外
    }
  }
  activeDrag = null;
}

/**
 * 將 Data URL 轉換為 Blob（作為舊版環境或不支援 canvas.toBlob 時的安全備援）
 */
function dataUrlToBlob(dataUrl: string, fallbackMime: string): Blob {
  const parts = dataUrl.split(',');
  const mimeMatch = parts[0]?.match(/:(.*?);/);
  const mime = mimeMatch?.[1] || fallbackMime;
  const base64 = parts[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/**
 * 將 HTMLCanvasElement 非同步編碼為 JPEG Blob（不阻塞主執行緒，無 toBlob 時安全降級）
 */
async function encodeCanvasToJpegBlob(
  canvas: HTMLCanvasElement,
  quality: number
): Promise<Blob | null> {
  if (typeof canvas.toBlob === 'function') {
    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob((result) => resolve(result), 'image/jpeg', quality);
      } catch {
        resolve(null);
      }
    });
    if (blob && blob.size > 0) {
      return blob;
    }
  }

  if (typeof canvas.toDataURL === 'function') {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl) {
      return dataUrlToBlob(dataUrl, 'image/jpeg');
    }
  }

  return null;
}

/**
 * 依目前選取之正矩形範圍從原圖裁切並壓縮為二進位 JPEG Blob，通知父層送往後端辨識
 */
async function handleConfirmCrop() {
  if (props.isSubmitting || isEncoding.value) return;
  const imgEl = imageRef.value;
  if (!imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight) return;

  isEncoding.value = true;
  try {
    const naturalW = imgEl.naturalWidth;
    const naturalH = imgEl.naturalHeight;

    const sx = Math.round(cropRect.value.x * naturalW);
    const sy = Math.round(cropRect.value.y * naturalH);
    const sw = Math.max(16, Math.round(cropRect.value.width * naturalW));
    const sh = Math.max(16, Math.round(cropRect.value.height * naturalH));

    // 等比縮放至長邊不超過上限，控制檔案體積與辨識速度
    const maxSide = Math.max(sw, sh);
    const scale = maxSide > MAX_OUTPUT_DIMENSION ? MAX_OUTPUT_DIMENSION / maxSide : 1;
    const targetW = Math.max(16, Math.round(sw * scale));
    const targetH = Math.max(16, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 填滿白底避免任何透明像素殘留
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, targetW, targetH);

    const imageBlob = await encodeCanvasToJpegBlob(canvas, OUTPUT_JPEG_QUALITY);
    if (!imageBlob) return;

    emit('confirm', {
      imageBlob,
      mimeType: 'image/jpeg',
      width: targetW,
      height: targetH,
      sizeBytes: imageBlob.size,
    });
  } finally {
    isEncoding.value = false;
  }
}
</script>

<template>
  <div class="space-y-3" data-testid="receipt-cropper">
    <div
      v-if="qrHintText"
      data-testid="cropper-qr-hint"
      class="text-[11px] text-teal-800 bg-teal-50 border border-teal-200 px-2.5 py-1.5 rounded-lg font-medium"
    >
      {{ qrHintText }}
    </div>

    <!-- 裁切預覽舞台：外層置中，內層緊貼實際圖片尺寸，確保座標 1:1 對應 -->
    <div
      class="w-full min-h-[16rem] max-h-[58vh] bg-slate-950 rounded-xl border border-slate-200 flex items-center justify-center p-2 overflow-hidden select-none"
    >
      <div class="relative inline-block max-w-full max-h-[54vh] overflow-hidden touch-none">
        <img
          ref="imageRef"
          :src="imageDataUrl"
          alt="紙本發票拍照預覽"
          draggable="false"
          class="block max-w-full max-h-[54vh] w-auto h-auto select-none pointer-events-none"
          @load="handleImageLoad"
        />

        <!-- 正矩形選取框疊層 -->
        <div
          v-if="isImageLoaded"
          data-testid="crop-selection-box"
          :style="cropBoxStyle"
          class="absolute border-2 border-teal-400 cursor-move touch-none"
          style="box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.58);"
          @pointerdown="onPointerDown('move', $event)"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <!-- 內部三分參考格線 -->
          <div class="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
            <div class="border-r border-b border-white/25"></div>
            <div class="border-r border-b border-white/25"></div>
            <div class="border-b border-white/25"></div>
            <div class="border-r border-b border-white/25"></div>
            <div class="border-r border-b border-white/25"></div>
            <div class="border-b border-white/25"></div>
            <div class="border-r border-white/25"></div>
            <div class="border-r border-white/25"></div>
            <div></div>
          </div>

          <!-- 四角拖曳把手（放大觸控熱區，行動裝置好拖曳） -->
          <div
            data-testid="crop-handle-nw"
            class="absolute -top-3 -left-3 w-6 h-6 flex items-center justify-center cursor-nwse-resize touch-none"
            @pointerdown="onPointerDown('nw', $event)"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          >
            <span class="w-3.5 h-3.5 rounded-full bg-white border-2 border-teal-500 shadow"></span>
          </div>
          <div
            data-testid="crop-handle-ne"
            class="absolute -top-3 -right-3 w-6 h-6 flex items-center justify-center cursor-nesw-resize touch-none"
            @pointerdown="onPointerDown('ne', $event)"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          >
            <span class="w-3.5 h-3.5 rounded-full bg-white border-2 border-teal-500 shadow"></span>
          </div>
          <div
            data-testid="crop-handle-sw"
            class="absolute -bottom-3 -left-3 w-6 h-6 flex items-center justify-center cursor-nesw-resize touch-none"
            @pointerdown="onPointerDown('sw', $event)"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          >
            <span class="w-3.5 h-3.5 rounded-full bg-white border-2 border-teal-500 shadow"></span>
          </div>
          <div
            data-testid="crop-handle-se"
            class="absolute -bottom-3 -right-3 w-6 h-6 flex items-center justify-center cursor-nwse-resize touch-none"
            @pointerdown="onPointerDown('se', $event)"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          >
            <span class="w-3.5 h-3.5 rounded-full bg-white border-2 border-teal-500 shadow"></span>
          </div>

          <!-- 四邊中點拖曳把手 -->
          <div
            class="absolute -top-2.5 left-1/2 -translate-x-1/2 w-10 h-5 flex items-center justify-center cursor-ns-resize touch-none"
            @pointerdown="onPointerDown('n', $event)"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          >
            <span class="w-6 h-1.5 rounded-full bg-white/95 border border-teal-600 shadow-xs"></span>
          </div>
          <div
            class="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-10 h-5 flex items-center justify-center cursor-ns-resize touch-none"
            @pointerdown="onPointerDown('s', $event)"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          >
            <span class="w-6 h-1.5 rounded-full bg-white/95 border border-teal-600 shadow-xs"></span>
          </div>
          <div
            class="absolute top-1/2 -left-2.5 -translate-y-1/2 w-5 h-10 flex items-center justify-center cursor-ew-resize touch-none"
            @pointerdown="onPointerDown('w', $event)"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          >
            <span class="w-1.5 h-6 rounded-full bg-white/95 border border-teal-600 shadow-xs"></span>
          </div>
          <div
            class="absolute top-1/2 -right-2.5 -translate-y-1/2 w-5 h-10 flex items-center justify-center cursor-ew-resize touch-none"
            @pointerdown="onPointerDown('e', $event)"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          >
            <span class="w-1.5 h-6 rounded-full bg-white/95 border border-teal-600 shadow-xs"></span>
          </div>
        </div>
      </div>
    </div>

    <!-- 裁切操作按鈕（重拍／全選／確認範圍並辨識並排） -->
    <div class="flex items-center justify-between gap-2">
      <button
        type="button"
        data-testid="retake-photo-btn"
        :disabled="isSubmitting"
        class="shrink-0 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors disabled:opacity-50"
        @click="emit('retake')"
      >
        <RotateCcw class="w-3.5 h-3.5" />
        <span>重拍</span>
      </button>

      <button
        type="button"
        data-testid="select-full-btn"
        :disabled="isSubmitting"
        class="shrink-0 inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors disabled:opacity-50"
        @click="handleSelectFull"
      >
        <Maximize2 class="w-3.5 h-3.5" />
        <span>全選</span>
      </button>

      <button
        type="button"
        data-testid="confirm-crop-btn"
        :disabled="!isImageLoaded || isSubmitting || isEncoding"
        class="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-teal-600 hover:bg-teal-700 rounded-xl shadow-xs transition-colors disabled:opacity-60"
        @click="handleConfirmCrop"
      >
        <Sparkles class="w-3.5 h-3.5" />
        <span>{{ isSubmitting ? 'AI 辨識中，請稍候...' : isEncoding ? '處理影像中...' : '確認範圍並辨識' }}</span>
      </button>
    </div>
  </div>
</template>
