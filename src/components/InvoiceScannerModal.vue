<script setup lang="ts">
/**
 * @file InvoiceScannerModal.vue
 * @description 電子發票雙 QR Code 相機掃描與逐項分類彈窗元件
 *
 * 核心業務職責：
 * 1. 高解析度相機即時掃描：使用原生 getUserMedia 請求高解析度後置鏡頭與連續自動對焦，卸載或關閉時完整釋放 MediaStream。
 * 2. 雙引擎高密度 QR Code 解碼：優先使用瀏覽器原生 BarcodeDetector（單幀可同時辨識左、右雙碼），不支援或未命中時自動降級使用 jsQR 搭配全圖／左右分區與 Big5 編碼解碼，解決台灣電子發票高密度並排 QR Code 難以辨識的問題。
 * 3. 雙 QR Code 連續辨識與去重：自動區分左側主體碼（77 碼以上發票字軌開頭）與右側明細碼（** 開頭），避免重複掃描覆蓋使用者已選取之分類，並針對非發票 QR Code 提供即時視覺提示。
 * 4. 故障降級手動輸入機制：相機無權限或裝置不支援時，無縫切換為手動文字雙碼輸入作為備用方案。
 */

import { ref, onMounted, onUnmounted } from 'vue';
import jsQR from 'jsqr';
import { parseInvoiceQRCode, type ParsedInvoiceResult } from '@/utils/invoiceParser';
import { useCategories } from '@/composables/useCategories';

/** 瀏覽器原生 BarcodeDetector 單筆偵測結果介面 */
interface DetectedBarcode {
  rawValue?: string;
}

/** 瀏覽器原生 BarcodeDetector 實例介面 */
interface BarcodeDetectorInstance {
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
}

/** 瀏覽器原生 BarcodeDetector 建構子介面 */
interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
}

/** 解碼畫布最大邊長（保留高密度發票 QR Code 細節並兼顧行動裝置效能） */
const MAX_DECODE_DIMENSION = 1280;

/** 每幀掃描間隔（毫秒） */
const SCAN_INTERVAL_MS = 120;

/** 台灣電子發票左側主體碼格式（至少 77 碼且前 10 碼為 2 碼大寫英文 + 8 碼數字） */
const TAIWAN_INVOICE_LEFT_PREFIX = /^[A-Z]{2}\d{8}/;

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'parsed', result: ParsedInvoiceResult): void;
}>();

// 使用共用 Composable 管理支出分類選項
const {
  categories: categoryOptions,
  loadCategories,
} = useCategories('expense');

/** 相機即時預覽 video 元素參考 */
const videoRef = ref<HTMLVideoElement | null>(null);

/** 左側 QR Code 字串（含金額、發票號碼等 77 碼以上資訊） */
const leftCode = ref('');

/** 右側 QR Code 字串（延伸品項明細） */
const rightCode = ref('');

/** 錯誤提示訊息 */
const errorMessage = ref('');

/** 相機啟動與存取錯誤提示訊息 */
const cameraError = ref('');

/** 掃描到非發票 QR Code 時的即時提醒訊息 */
const cameraWarning = ref('');

/** 相機掃描狀態導引提示 */
const cameraStatus = ref('');

/** 相機是否已成功啟動並開始串流 */
const isCameraActive = ref(false);

/** 解析後之發票結構資料 */
const parsedResult = ref<ParsedInvoiceResult | null>(null);

/** 目前啟用中的相機 MediaStream */
let mediaStream: MediaStream | null = null;

/** 掃描排程計時器 */
let scanTimer: ReturnType<typeof setTimeout> | null = null;

/** 是否處於掃描迴圈運行狀態 */
let isScanning = false;

/** 元件是否已卸載或關閉（避免非同步相機請求回傳後資源洩漏） */
let isDisposed = false;

/** 複用之離屏解碼畫布與 2D 繪圖環境 */
let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;

/** 瀏覽器原生 BarcodeDetector 實例（不支援時為 null） */
let barcodeDetector: BarcodeDetectorInstance | null = null;

/** 掃描影格計數（供原生引擎未命中時交替以 jsQR 補救） */
let scanTickCount = 0;

/**
 * 嘗試初始化瀏覽器原生 BarcodeDetector（僅偵測 qr_code 格式以提升速度與精準度）
 */
async function initBarcodeDetector(): Promise<BarcodeDetectorInstance | null> {
  const DetectorCtor = (
    window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }
  ).BarcodeDetector;
  if (!DetectorCtor) {
    return null;
  }

  try {
    if (typeof DetectorCtor.getSupportedFormats === 'function') {
      const supportedFormats = await DetectorCtor.getSupportedFormats();
      if (!supportedFormats.includes('qr_code')) {
        return null;
      }
    }
    return new DetectorCtor({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

/**
 * 從 jsQR 解碼結果提取文字內容
 * 針對台灣傳統 POS 發票採用 Big5 位元組編碼時，jsQR 內建 decodeURIComponent 會失敗導致 data 為空，
 * 因此於 data 為空時改由 binaryData 以 Big5 優先解碼，再退回 UTF-8。
 *
 * @param code - jsQR 解碼回傳物件
 * @returns 解碼後之字串，失敗時回傳空字串
 */
function extractJsQrText(code: ReturnType<typeof jsQR>): string {
  if (!code) return '';
  if (code.data && code.data.trim()) {
    return code.data.trim();
  }

  if (code.binaryData && code.binaryData.length > 0) {
    const bytes = new Uint8Array(code.binaryData);
    try {
      const big5Text = new TextDecoder('big5').decode(bytes).trim();
      if (big5Text) return big5Text;
    } catch {
      // 執行環境不支援 big5 時改用 UTF-8 容錯解碼
    }
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
    } catch {
      return '';
    }
  }

  return '';
}

/**
 * 使用 jsQR 對高解析度畫布進行全圖與左右分區解碼
 * 台灣電子發票的左、右兩顆 QR Code 緊鄰並排，分區裁切可避免兩組定位點互相干擾並支援同時讀取雙碼。
 *
 * @param ctx - 已繪製目前相機影格的 2D 畫布環境
 * @param width - 畫布寬度
 * @param height - 畫布高度
 * @returns 本幀解碼出之不重複字串清單
 */
function decodeWithJsQr(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): string[] {
  const results = new Set<string>();
  const halfOverlapWidth = Math.floor(width * 0.6);
  const rightStartX = Math.floor(width * 0.4);
  const rightWidth = width - rightStartX;

  // 依序掃描：全畫面、左半部（對準左碼）、右半部（對準右碼）
  const regions = [
    { x: 0, y: 0, w: width, h: height },
    { x: 0, y: 0, w: halfOverlapWidth, h: height },
    { x: rightStartX, y: 0, w: rightWidth, h: height },
  ];

  for (const region of regions) {
    if (region.w < 16 || region.h < 16) continue;
    try {
      const imageData = ctx.getImageData(region.x, region.y, region.w, region.h);
      const decoded = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'attemptBoth',
      });
      const text = extractJsQrText(decoded);
      if (text) {
        results.add(text);
      }
    } catch {
      // 略過單一分區讀取異常，避免中斷掃描迴圈
    }
  }

  return Array.from(results);
}

/**
 * 處理單筆掃描解碼出之 QR Code 字串
 * 支援左碼（主體資訊）與右碼（** 開頭延伸明細）雙碼連續辨識與去重
 *
 * @param decodedText - 掃描解碼出之字串內容
 */
function onScanSuccess(decodedText: string) {
  const text = decodedText ? decodedText.trim() : '';
  if (!text) return;

  if (text.startsWith('**')) {
    // 右碼延伸品項明細
    cameraWarning.value = '';
    if (rightCode.value.trim() === text) {
      return;
    }
    rightCode.value = text;
    if (leftCode.value.trim()) {
      cameraStatus.value = '已讀取左、右雙 QR Code 並完成解析';
      handleParse();
    } else {
      cameraStatus.value = '已讀取右側明細碼，請接續對準左側 QR Code';
    }
    return;
  }

  if (text.length >= 77 && TAIWAN_INVOICE_LEFT_PREFIX.test(text)) {
    // 左側發票主體碼
    cameraWarning.value = '';
    if (leftCode.value.trim() === text) {
      return;
    }
    leftCode.value = text;
    cameraStatus.value = rightCode.value.trim()
      ? '已讀取左、右雙 QR Code 並完成解析'
      : '已讀取左側 QR Code，若有右側明細碼請接續掃描';
    handleParse();
    return;
  }

  // 掃描到非台灣電子發票格式之 QR Code（例如店家連結或活動條碼），提供即時提醒且不覆蓋現有已掃描資料
  cameraWarning.value = '偵測到非電子發票 QR Code，請對準發票上的左右方塊 QR Code';
}

/**
 * 執行單一相機影格的高解析度擷取與雙引擎解碼
 */
async function scanSingleFrame() {
  if (!isScanning || isDisposed) return;

  const video = videoRef.value;
  if (
    !video ||
    video.readyState < 2 ||
    video.videoWidth <= 0 ||
    video.videoHeight <= 0
  ) {
    return;
  }

  // 依據原始相機解析度計算解碼畫布尺寸（維持高解析度，不壓縮為低畫質縮圖）
  const srcWidth = video.videoWidth;
  const srcHeight = video.videoHeight;
  const maxSide = Math.max(srcWidth, srcHeight);
  const scale = maxSide > MAX_DECODE_DIMENSION ? MAX_DECODE_DIMENSION / maxSide : 1;
  const targetWidth = Math.max(1, Math.round(srcWidth * scale));
  const targetHeight = Math.max(1, Math.round(srcHeight * scale));

  if (!offscreenCanvas) {
    offscreenCanvas = document.createElement('canvas');
    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!offscreenCtx) return;

  if (offscreenCanvas.width !== targetWidth || offscreenCanvas.height !== targetHeight) {
    offscreenCanvas.width = targetWidth;
    offscreenCanvas.height = targetHeight;
  }

  offscreenCtx.drawImage(video, 0, 0, targetWidth, targetHeight);
  scanTickCount += 1;

  const decodedTexts: string[] = [];

  // 引擎 A：優先使用瀏覽器原生 BarcodeDetector（單幀可同時偵測左、右雙碼）
  if (barcodeDetector) {
    try {
      const barcodes = await barcodeDetector.detect(offscreenCanvas);
      for (const barcode of barcodes) {
        if (barcode.rawValue && barcode.rawValue.trim()) {
          decodedTexts.push(barcode.rawValue.trim());
        }
      }
    } catch {
      // 原生引擎執行失敗時自動停用並降級為 jsQR
      barcodeDetector = null;
    }
  }

  // 引擎 B：若無原生引擎，或原生引擎未命中時交替使用 jsQR 多區域解碼補救
  if (decodedTexts.length === 0 && (!barcodeDetector || scanTickCount % 2 === 1)) {
    const jsQrTexts = decodeWithJsQr(offscreenCtx, targetWidth, targetHeight);
    decodedTexts.push(...jsQrTexts);
  }

  // 處理所有解碼結果（先處理左碼再處理右碼，確保同時掃出雙碼時狀態一次到位）
  if (decodedTexts.length > 0 && isScanning && !isDisposed) {
    const sortedTexts = [...decodedTexts].sort((a, b) => {
      const aIsRight = a.startsWith('**') ? 1 : 0;
      const bIsRight = b.startsWith('**') ? 1 : 0;
      return aIsRight - bIsRight;
    });
    for (const text of sortedTexts) {
      onScanSuccess(text);
    }
  }
}

/**
 * 排程下一次影格掃描（於前一次非同步解碼完成後才排程，避免主執行緒堆積）
 */
function scheduleNextScan() {
  if (!isScanning || isDisposed) return;

  scanTimer = setTimeout(async () => {
    try {
      await scanSingleFrame();
    } finally {
      scheduleNextScan();
    }
  }, SCAN_INTERVAL_MS);
}

/**
 * 請求最佳可用的相機串流（優先高解析度後置鏡頭，失敗時逐步降級約束）
 */
async function requestCameraStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    throw new Error('瀏覽器不支援相機存取');
  }

  const constraintFallbacks: MediaStreamConstraints[] = [
    {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    },
    {
      audio: false,
      video: {
        facingMode: 'environment',
      },
    },
    {
      audio: false,
      video: true,
    },
  ];

  let lastError: unknown = null;
  for (const constraints of constraintFallbacks) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err: unknown) {
      lastError = err;
      // 使用者明確拒絕權限時直接終止重試
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        throw err;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('無法取得相機串流');
}

/**
 * 嘗試為啟用中的相機軌道設定連續自動對焦（部分行動裝置支援）
 *
 * @param stream - 已開啟的相機 MediaStream
 */
async function applyContinuousFocusIfSupported(stream: MediaStream) {
  const videoTrack = stream.getVideoTracks()[0];
  if (
    !videoTrack ||
    typeof videoTrack.getCapabilities !== 'function' ||
    typeof videoTrack.applyConstraints !== 'function'
  ) {
    return;
  }

  try {
    const capabilities = videoTrack.getCapabilities() as MediaTrackCapabilities & {
      focusMode?: string[];
    };
    if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
      await videoTrack.applyConstraints({
        advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
      });
    }
  } catch {
    // 裝置不支援動態對焦設定時安全忽略
  }
}

/**
 * 啟動相機掃描器
 */
async function startScanner() {
  cameraError.value = '';
  cameraWarning.value = '';
  cameraStatus.value = '正在啟動相機...';

  try {
    const stream = await requestCameraStream();

    // 若使用者於授權過程中已關閉彈窗，立即釋放相機避免資源洩漏
    if (isDisposed) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    mediaStream = stream;
    await applyContinuousFocusIfSupported(stream);

    const video = videoRef.value;
    if (!video) {
      await stopScanner();
      return;
    }

    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();

    barcodeDetector = await initBarcodeDetector();
    isCameraActive.value = true;
    isScanning = true;
    scanTickCount = 0;
    cameraStatus.value = '相機啟動成功，請對準發票 QR Code';
    scheduleNextScan();
  } catch (err: unknown) {
    await stopScanner();
    const msg = err instanceof Error ? err.message : String(err);
    cameraStatus.value = '';
    cameraError.value = `相機啟動失敗或權限遭拒 (${msg})，請改用下方手動輸入。`;
  }
}

/**
 * 安全停止並清理相機與掃描迴圈資源
 */
async function stopScanner() {
  isScanning = false;
  isCameraActive.value = false;

  if (scanTimer !== null) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // 忽略已停止軌道之例外
      }
    });
    mediaStream = null;
  }

  if (videoRef.value) {
    videoRef.value.srcObject = null;
  }
}

/**
 * 執行發票 QR Code 解析
 */
function handleParse() {
  errorMessage.value = '';
  if (!leftCode.value.trim()) {
    errorMessage.value = '請輸入發票左側 QR Code 內容';
    return;
  }

  try {
    const result = parseInvoiceQRCode(leftCode.value.trim(), rightCode.value.trim() || undefined);

    // 確保每筆品項優先帶入支出分類清單第一項（若無可用分類則留空要求選擇）
    const defaultCategory = categoryOptions.value[0] || '';
    if (result.items && result.items.length > 0) {
      for (const item of result.items) {
        if (!item.category || item.category === '未分類' || !categoryOptions.value.includes(item.category)) {
          item.category = defaultCategory;
        }
      }
    }

    parsedResult.value = result;
  } catch (err: unknown) {
    errorMessage.value =
      err instanceof Error ? err.message : (String(err) || '發票解析失敗，請確認 QR Code 格式');
  }
}

/**
 * 關閉彈窗並安全釋放相機資源
 */
async function handleClose() {
  isDisposed = true;
  await stopScanner();
  emit('close');
}

/**
 * 確認並套用解析結果至表記帳表單
 */
async function handleApply() {
  if (!parsedResult.value) return;

  if (parsedResult.value.items && parsedResult.value.items.length > 0) {
    const hasInvalidCategory = parsedResult.value.items.some(
      (it) => !it.category || !categoryOptions.value.includes(it.category)
    );
    if (hasInvalidCategory) {
      errorMessage.value = '請為所有商品明細選擇有效的支出分類';
      return;
    }
  }

  emit('parsed', parsedResult.value);
  isDisposed = true;
  await stopScanner();
  emit('close');
}

onMounted(async () => {
  isDisposed = false;
  await Promise.all([
    startScanner(),
    loadCategories(),
  ]);
});

onUnmounted(async () => {
  isDisposed = true;
  await stopScanner();
});
</script>

<template>
  <div class="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl max-h-[90vh] flex flex-col overflow-hidden">
      <!-- 標題欄 -->
      <div class="flex items-center justify-between pb-3 border-b border-slate-100">
        <h3 id="modal-title" class="text-lg font-bold text-slate-800">電子發票雙 QR Code 掃描</h3>
        <button
          type="button"
          class="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
          @click="handleClose"
          aria-label="關閉"
        >
          ✕
        </button>
      </div>

      <!-- 內容區 -->
      <div class="py-4 space-y-4 overflow-y-auto flex-1">
        <!-- 相機預覽容器 -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between gap-2 text-xs text-slate-600">
            <span class="font-semibold shrink-0">相機鏡頭即時掃描</span>
            <span v-if="cameraStatus" class="text-teal-600 font-medium text-right">{{ cameraStatus }}</span>
          </div>
          <div
            id="qr-reader"
            class="relative w-full aspect-[4/3] max-h-64 bg-slate-900 rounded-lg overflow-hidden border border-slate-200 text-slate-400 text-xs"
          >
            <video
              ref="videoRef"
              autoplay
              playsinline
              muted
              class="w-full h-full object-cover"
            ></video>

            <!-- 視覺對準引導框（僅作畫面引導，不裁切解碼解析度） -->
            <div
              v-if="isCameraActive"
              class="pointer-events-none absolute inset-0 flex items-center justify-center p-5"
            >
              <div class="relative w-full h-full max-w-[300px] max-h-[160px] border-2 border-teal-400/80 rounded-lg shadow-[0_0_0_9999px_rgba(15,23,42,0.35)]">
                <span class="absolute -top-0.5 -left-0.5 w-4 h-4 border-t-4 border-l-4 border-teal-300 rounded-tl"></span>
                <span class="absolute -top-0.5 -right-0.5 w-4 h-4 border-t-4 border-r-4 border-teal-300 rounded-tr"></span>
                <span class="absolute -bottom-0.5 -left-0.5 w-4 h-4 border-b-4 border-l-4 border-teal-300 rounded-bl"></span>
                <span class="absolute -bottom-0.5 -right-0.5 w-4 h-4 border-b-4 border-r-4 border-teal-300 rounded-br"></span>
              </div>
            </div>

            <!-- 相機尚未就緒時之佔位提示 -->
            <div
              v-if="!isCameraActive"
              class="absolute inset-0 flex items-center justify-center px-4 text-center text-slate-400"
            >
              <span>{{ cameraError ? '相機無法使用，請使用下方手動輸入' : '正在開啟相機鏡頭...' }}</span>
            </div>
          </div>

          <!-- 左／右雙碼掃描進度指示 -->
          <div class="flex items-center gap-2 text-[11px]">
            <span
              class="px-2 py-0.5 rounded-full font-medium"
              :class="leftCode.trim() ? 'bg-teal-100 text-teal-800' : 'bg-slate-100 text-slate-500'"
            >
              左側主體碼：{{ leftCode.trim() ? '已讀取' : '待掃描' }}
            </span>
            <span
              class="px-2 py-0.5 rounded-full font-medium"
              :class="rightCode.trim() ? 'bg-teal-100 text-teal-800' : 'bg-slate-100 text-slate-500'"
            >
              右側明細碼：{{ rightCode.trim() ? '已讀取' : '選填' }}
            </span>
          </div>

          <!-- 非發票 QR Code 即時提醒 -->
          <div v-if="cameraWarning" class="text-xs text-amber-700 bg-amber-50 p-2 rounded-lg border border-amber-200">
            {{ cameraWarning }}
          </div>

          <!-- 相機錯誤提示 -->
          <div v-if="cameraError" class="text-xs text-rose-600 bg-rose-50 p-2.5 rounded-lg border border-rose-200">
            {{ cameraError }}
          </div>
        </div>

        <p class="text-xs text-slate-500">
          請將發票左右兩個 QR Code 置於框內保持清晰對焦，或在下方手動輸入左側與右側 QR Code 內容文字。
        </p>

        <!-- 左側 QR Code -->
        <div>
          <label for="left-qr" class="block text-sm font-medium text-slate-700 mb-1">
            左側 QR Code (含金額、日期與前兩項商品)
          </label>
          <textarea
            id="left-qr"
            v-model="leftCode"
            rows="3"
            placeholder="請輸入或貼上左側 QR Code 字串"
            class="w-full text-xs font-mono border border-slate-300 rounded-lg p-2.5 focus:ring-2 focus:ring-teal-500 focus:outline-none"
          ></textarea>
        </div>

        <!-- 右側 QR Code -->
        <div>
          <label for="right-qr" class="block text-sm font-medium text-slate-700 mb-1">
            右側 QR Code (延伸商品明細，選填)
          </label>
          <textarea
            id="right-qr"
            v-model="rightCode"
            rows="3"
            placeholder="請輸入或貼上右側 QR Code 字串 (若有)"
            class="w-full text-xs font-mono border border-slate-300 rounded-lg p-2.5 focus:ring-2 focus:ring-teal-500 focus:outline-none"
          ></textarea>
        </div>

        <!-- 格式錯誤提示 -->
        <div v-if="errorMessage" class="text-sm text-rose-600 bg-rose-50 p-2.5 rounded-lg border border-rose-200">
          {{ errorMessage }}
        </div>

        <!-- 解析預覽與逐項分類引導結果 -->
        <div v-if="parsedResult" class="bg-teal-50 border border-teal-200 rounded-lg p-3 space-y-3">
          <div class="flex justify-between text-xs text-teal-800 font-semibold">
            <span>發票號碼：{{ parsedResult.invoiceNumber }}</span>
            <span>開立日期：{{ parsedResult.date }}</span>
          </div>
          <div class="text-xs text-teal-900 font-bold">
            總計金額：NT$ {{ parsedResult.totalAmount }}
          </div>

          <!-- 逐項分類引導介面 -->
          <div v-if="parsedResult.items && parsedResult.items.length > 0" class="mt-2 space-y-2">
            <span class="block text-xs font-semibold text-teal-950">
              商品明細與分類指派 ({{ parsedResult.items.length }} 項)：
            </span>
            <div class="space-y-2 max-h-48 overflow-y-auto pr-1">
              <div
                v-for="(item, idx) in parsedResult.items"
                :key="idx"
                class="flex items-center justify-between p-2.5 bg-white rounded-lg border border-teal-100 shadow-xs text-xs space-x-2"
              >
                <div class="flex-1 min-w-0">
                  <span class="font-medium text-slate-800 block truncate" :title="item.name">
                    {{ item.name }}
                  </span>
                  <span class="text-slate-500 text-[11px]">
                    {{ item.quantity }} 件 × NT$ {{ item.unitPrice }} = NT$ {{ item.subtotal }}
                  </span>
                </div>
                <div class="shrink-0 flex items-center space-x-1">
                  <label :for="`item-category-${idx}`" class="text-[11px] text-slate-500">分類</label>
                  <select
                    :id="`item-category-${idx}`"
                    v-model="item.category"
                    class="border border-slate-300 rounded px-2 py-1 text-xs bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
                  >
                    <option v-for="cat in categoryOptions" :key="cat" :value="cat">
                      {{ cat }}
                    </option>
                  </select>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="text-xs text-slate-500 italic">
            無商品品項明細（純金額發票）
          </div>
        </div>
      </div>

      <!-- 操作按鈕 -->
      <div class="pt-3 border-t border-slate-100 flex items-center justify-end space-x-2">
        <button
          type="button"
          class="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
          @click="handleClose"
        >
          取消
        </button>
        <button
          type="button"
          class="px-4 py-2 text-sm bg-slate-800 text-white hover:bg-slate-900 rounded-lg shadow-sm"
          @click="handleParse"
        >
          解析發票
        </button>
        <button
          v-if="parsedResult"
          type="button"
          class="px-4 py-2 text-sm bg-teal-600 text-white hover:bg-teal-700 rounded-lg shadow-sm"
          @click="handleApply"
        >
          帶入表單
        </button>
      </div>
    </div>
  </div>
</template>
