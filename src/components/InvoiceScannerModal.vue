<script setup lang="ts">
/**
 * @file InvoiceScannerModal.vue
 * @description 電子發票雙 QR Code 相機掃描與逐項分類彈窗元件
 *
 * 核心業務職責：
 * 1. 高解析度多鏡頭與對焦控制：
 *    - 透過原生 getUserMedia 階梯式請求高解析度後置鏡頭（1080p -> 720p -> 預設）。
 *    - 於 video.play() 開流後取得可用鏡頭清單供切換（記憶偏好 deviceId），並分別獨立套用連續對焦、硬體變焦（1x/2x/3x）與點擊預覽區重新對焦（Tap-to-Focus）。
 *    - 顯示精簡鏡頭診斷列（實際解析度、鏡頭名稱、倍率、對焦模式與解碼引擎）以利實機除錯。
 * 2. 1:1 可視中央 ROI 與雙引擎解碼：
 *    - 原生 BarcodeDetector 直接讀取原始解析度 video（連續失敗達門檻才降級，避免首幀偶發例外永久停用）。
 *    - 依 object-cover 幾何精準換算畫面中央對準框之 1:1 原始像素區（Center ROI）供 jsQR 執行中央與左右分區解碼（含 Big5 二進位備援），消除縮圖糊化、框外雜訊與主執行緒阻塞。
 * 3. 雙 QR Code 連續辨識與防重複覆蓋：自動區分左側主體碼與右側明細碼（** 開頭），對非發票 QR Code 提供即時提示。
 * 4. 故障降級手動輸入機制：相機無權限或裝置不支援時，無縫切換為手動文字雙碼輸入。
 */

import { ref, computed, onMounted, onUnmounted } from 'vue';
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

/** 鏡頭變焦範圍資訊 */
interface ZoomRange {
  min: number;
  max: number;
  step: number;
}

/** 擴充 MediaTrackCapabilities（涵蓋行動瀏覽器對焦與變焦屬性） */
interface ExtendedTrackCapabilities extends MediaTrackCapabilities {
  focusMode?: string[];
  zoom?: ZoomRange;
}

/** 擴充 MediaTrackSettings（涵蓋行動瀏覽器對焦與變焦設定） */
interface ExtendedTrackSettings extends MediaTrackSettings {
  focusMode?: string;
  zoom?: number;
}

/** 擴充 MediaTrackConstraintSet（涵蓋行動瀏覽器進階對焦與變焦約束） */
interface ExtendedTrackConstraintSet extends MediaTrackConstraintSet {
  focusMode?: string;
  zoom?: number;
}

/** 可供切換之相機裝置項目 */
interface CameraDeviceOption {
  deviceId: string;
  label: string;
}

/** 1:1 原始像素可視裁切區矩形 */
interface SourceCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 記憶使用者偏好後置鏡頭 deviceId 之 localStorage 鍵名 */
const PREFERRED_CAMERA_STORAGE_KEY = 'sanddollar_invoice_scanner_camera_id';

/** 1:1 ROI 單邊安全上限（維持原始像素清晰度，僅在 4K 等極端尺寸下節流） */
const MAX_ROI_EDGE = 1400;

/** 每幀掃描間隔（毫秒） */
const SCAN_INTERVAL_MS = 120;

/** 原生 BarcodeDetector 連續失敗幾次後才停用降級 */
const NATIVE_DETECTOR_MAX_FAILURES = 5;

/** 有原生 BarcodeDetector 時，每隔幾幀才以 jsQR 補救一次（避免阻塞主執行緒與拖慢對焦） */
const JSQR_ASSIST_INTERVAL_TICKS = 5;

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

/** 相機預覽容器參考（用於點擊對焦座標計算） */
const readerContainerRef = ref<HTMLDivElement | null>(null);

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

/** 可切換的相機裝置清單（優先過濾出後置鏡頭） */
const availableCameras = ref<CameraDeviceOption[]>([]);

/** 目前使用中的鏡頭 deviceId */
const currentDeviceId = ref('');

/** 鏡頭硬體變焦範圍（不支援時為 null） */
const zoomRange = ref<ZoomRange | null>(null);

/** 目前套用之變焦倍率 */
const currentZoom = ref<number | null>(null);

/** 點擊對焦視覺回饋座標（百分比）與顯示狀態 */
const focusIndicator = ref<{ x: number; y: number } | null>(null);

/** 實機除錯診斷資訊 */
const diagnosticResolution = ref('');
const diagnosticCameraLabel = ref('');
const diagnosticFocusMode = ref('');
const diagnosticEngine = ref('');

/** 目前啟用中的相機 MediaStream */
let mediaStream: MediaStream | null = null;

/** 掃描排程計時器 */
let scanTimer: ReturnType<typeof setTimeout> | null = null;

/** 點擊對焦回饋隱藏計時器 */
let focusIndicatorTimer: ReturnType<typeof setTimeout> | null = null;

/** 點擊對焦切回 continuous 計時器 */
let refocusRestoreTimer: ReturnType<typeof setTimeout> | null = null;

/** 是否處於掃描迴圈運行狀態 */
let isScanning = false;

/** 元件是否已卸載或關閉（避免非同步相機請求回傳後資源洩漏） */
let isDisposed = false;

/** 防止快速連點切換鏡頭造成並行開流衝突 */
let isSwitchingCamera = false;

/** 複用之離屏 ROI 解碼畫布與 2D 繪圖環境 */
let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;

/** 瀏覽器原生 BarcodeDetector 實例（不支援時為 null） */
let barcodeDetector: BarcodeDetectorInstance | null = null;

/** 原生 BarcodeDetector 連續錯誤次數 */
let nativeDetectorFailCount = 0;

/** 掃描影格計數 */
let scanTickCount = 0;

/** 目前鏡頭在清單中的索引（1-based，供按鈕與診斷顯示） */
const currentCameraIndex = computed(() => {
  if (availableCameras.value.length === 0) return 0;
  const idx = availableCameras.value.findIndex((cam) => cam.deviceId === currentDeviceId.value);
  return idx >= 0 ? idx + 1 : 1;
});

/** 依據硬體支援範圍產生的快捷變焦倍率選項 */
const zoomPresets = computed<number[]>(() => {
  if (!zoomRange.value) return [];
  const { min, max } = zoomRange.value;
  if (max <= min) return [];

  const candidates = [1, 1.5, 2, 3].filter((v) => v >= min - 0.05 && v <= max + 0.05);
  const clamped = candidates.map((v) => Number(Math.min(max, Math.max(min, v)).toFixed(1)));
  const unique = Array.from(new Set(clamped));

  if (unique.length >= 2) {
    return unique;
  }
  return Array.from(new Set([Number(min.toFixed(1)), Number(max.toFixed(1))]));
});

/** 組合精簡診斷列文字 */
const diagnosticSummary = computed(() => {
  const parts: string[] = [];
  if (diagnosticResolution.value) {
    parts.push(diagnosticResolution.value);
  }
  if (diagnosticCameraLabel.value) {
    const indexPrefix =
      availableCameras.value.length > 1 ? `[${currentCameraIndex.value}/${availableCameras.value.length}] ` : '';
    parts.push(`${indexPrefix}${diagnosticCameraLabel.value}`);
  }
  if (currentZoom.value !== null) {
    parts.push(`${currentZoom.value.toFixed(1)}x`);
  } else if (isCameraActive.value) {
    parts.push('無變焦');
  }
  if (diagnosticFocusMode.value) {
    parts.push(`對焦:${diagnosticFocusMode.value}`);
  }
  if (diagnosticEngine.value) {
    parts.push(diagnosticEngine.value);
  }
  return parts.join(' · ');
});

/**
 * 安全讀取記憶之偏好鏡頭 deviceId
 */
function readPreferredCameraId(): string {
  try {
    return window.localStorage.getItem(PREFERRED_CAMERA_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * 安全寫入偏好鏡頭 deviceId
 */
function savePreferredCameraId(deviceId: string) {
  if (!deviceId) return;
  try {
    window.localStorage.setItem(PREFERRED_CAMERA_STORAGE_KEY, deviceId);
  } catch {
    // 無痕模式或儲存受限時安全略過
  }
}

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
 * 更新診斷列中的影片解析度與軌道狀態資訊
 */
function refreshDiagnostics() {
  const video = videoRef.value;
  if (video && video.videoWidth > 0 && video.videoHeight > 0) {
    diagnosticResolution.value = `${video.videoWidth}×${video.videoHeight}`;
  }

  const videoTrack = mediaStream?.getVideoTracks()[0];
  if (videoTrack) {
    const settings = (typeof videoTrack.getSettings === 'function'
      ? videoTrack.getSettings()
      : {}) as ExtendedTrackSettings;
    if (videoTrack.label) {
      diagnosticCameraLabel.value = videoTrack.label;
    }
    if (typeof settings.zoom === 'number' && Number.isFinite(settings.zoom)) {
      currentZoom.value = Number(settings.zoom.toFixed(1));
    }
    if (settings.focusMode) {
      diagnosticFocusMode.value = settings.focusMode;
    }
    if (!diagnosticResolution.value && settings.width && settings.height) {
      diagnosticResolution.value = `${settings.width}×${settings.height}`;
    }
  }

  diagnosticEngine.value = barcodeDetector ? 'Native+ROI' : 'jsQR(1:1 ROI)';
}

/**
 * 列舉可用相機清單並優先過濾出後置鏡頭（供多鏡頭手機切換）
 * 須於取得相機串流授權後呼叫，瀏覽器才會揭露完整裝置標籤與 deviceId。
 */
async function refreshAvailableCameras(activeDeviceId?: string) {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
    if (videoInputs.length === 0) return;

    const backPattern = /back|rear|environment|後|主鏡頭|廣角|望遠|長焦|ultra|tele/i;
    const frontPattern = /front|user|selfie|前/i;

    const rearInputs = videoInputs.filter(
      (d) => backPattern.test(d.label) && !frontPattern.test(d.label)
    );
    const chosenList = rearInputs.length > 0 ? rearInputs : videoInputs;

    availableCameras.value = chosenList.map((d, idx) => ({
      deviceId: d.deviceId,
      label: d.label || `鏡頭 ${idx + 1}`,
    }));

    if (activeDeviceId) {
      currentDeviceId.value = activeDeviceId;
      // 若目前啟用鏡頭未在過濾清單中（例如裝置命名特殊），補入清單確保顯示正確
      if (!availableCameras.value.some((c) => c.deviceId === activeDeviceId)) {
        const activeDevice = videoInputs.find((d) => d.deviceId === activeDeviceId);
        if (activeDevice) {
          availableCameras.value.unshift({
            deviceId: activeDevice.deviceId,
            label: activeDevice.label || '目前鏡頭',
          });
        }
      }
    }
  } catch {
    // 忽略列舉裝置例外，維持現有串流運作
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
 * 計算 object-cover 視覺預覽中，中央對準框對應至原始 video 的 1:1 像素裁切區（Center ROI）
 *
 * @param video - 正在播放相機串流之 HTMLVideoElement
 * @returns 原始影片像素座標系中的裁切矩形
 */
function computeVisibleCenterRoi(video: HTMLVideoElement): SourceCropRect {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const cw = video.clientWidth;
  const ch = video.clientHeight;

  let visX = 0;
  let visY = 0;
  let visW = vw;
  let visH = vh;

  if (cw > 0 && ch > 0) {
    // 模擬 CSS object-cover 的等比裁切關係，還原使用者在畫面上真正看得到的影片範圍
    const coverScale = Math.max(cw / vw, ch / vh);
    visW = Math.min(vw, cw / coverScale);
    visH = Math.min(vh, ch / coverScale);
    visX = (vw - visW) / 2;
    visY = (vh - visH) / 2;
  }

  // 取可視區域中央（寬 88%、高 76%），精準涵蓋視覺對準框並排除框外一維條碼與桌面背景
  const roiW = Math.max(16, Math.round(visW * 0.88));
  const roiH = Math.max(16, Math.round(visH * 0.76));
  const roiX = Math.max(0, Math.min(vw - roiW, Math.round(visX + (visW - roiW) / 2)));
  const roiY = Math.max(0, Math.min(vh - roiH, Math.round(visY + (visH - roiH) / 2)));

  return { x: roiX, y: roiY, width: roiW, height: roiH };
}

/**
 * 將原始 video 的 1:1 可視中央 ROI 繪製至離屏畫布並回傳畫布尺寸
 */
function drawCenterRoiToCanvas(video: HTMLVideoElement): { width: number; height: number } | null {
  const roi = computeVisibleCenterRoi(video);
  const maxEdge = Math.max(roi.width, roi.height);
  // 維持 1:1 原始像素不失真；僅在超過 MAX_ROI_EDGE（例如 4K 串流）時等比節流
  const scale = maxEdge > MAX_ROI_EDGE ? MAX_ROI_EDGE / maxEdge : 1;
  const targetWidth = Math.max(16, Math.round(roi.width * scale));
  const targetHeight = Math.max(16, Math.round(roi.height * scale));

  if (!offscreenCanvas) {
    offscreenCanvas = document.createElement('canvas');
    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!offscreenCtx) return null;

  if (offscreenCanvas.width !== targetWidth || offscreenCanvas.height !== targetHeight) {
    offscreenCanvas.width = targetWidth;
    offscreenCanvas.height = targetHeight;
  }

  offscreenCtx.drawImage(
    video,
    roi.x,
    roi.y,
    roi.width,
    roi.height,
    0,
    0,
    targetWidth,
    targetHeight
  );

  return { width: targetWidth, height: targetHeight };
}

/**
 * 使用 jsQR 對 1:1 可視中央 ROI 畫布進行全框與左右分區解碼
 * 台灣電子發票的左、右兩顆 QR Code 緊鄰並排，分區裁切可避免兩組定位點互相干擾並支援同時讀取雙碼。
 *
 * @param ctx - 已繪製 1:1 可視 ROI 的 2D 畫布環境
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
  const leftWidth = Math.floor(width * 0.58);
  const rightStartX = Math.floor(width * 0.42);
  const rightWidth = width - rightStartX;

  // 僅針對已對齊視覺對準框之 1:1 ROI 執行中央、左半部、右半部掃描
  const regions = [
    { x: 0, y: 0, w: width, h: height },
    { x: 0, y: 0, w: leftWidth, h: height },
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

  // 首次拿到有效影片尺寸時同步更新診斷資訊
  if (!diagnosticResolution.value) {
    refreshDiagnostics();
  }

  scanTickCount += 1;
  const decodedTexts: string[] = [];

  // 引擎 A：原生 BarcodeDetector 直接讀取原始解析度 video，不經縮圖失真
  if (barcodeDetector) {
    try {
      const barcodes = await barcodeDetector.detect(video);
      nativeDetectorFailCount = 0;
      for (const barcode of barcodes) {
        if (barcode.rawValue && barcode.rawValue.trim()) {
          decodedTexts.push(barcode.rawValue.trim());
        }
      }
    } catch {
      nativeDetectorFailCount += 1;
      if (nativeDetectorFailCount >= NATIVE_DETECTOR_MAX_FAILURES) {
        // 連續多次失敗才停用原生引擎，避免剛開流偶發例外造成永久失效
        barcodeDetector = null;
        refreshDiagnostics();
      }
    }
  }

  // 引擎 B：無原生引擎時每幀掃描 1:1 可視 ROI；有原生引擎時低頻補救（避免主執行緒阻塞與拖慢對焦）
  const shouldRunJsQr =
    decodedTexts.length === 0 &&
    (!barcodeDetector || scanTickCount % JSQR_ASSIST_INTERVAL_TICKS === 0);

  if (shouldRunJsQr) {
    const drawn = drawCenterRoiToCanvas(video);
    if (drawn && offscreenCtx) {
      // 若有原生引擎且全畫面未命中，同時再對 1:1 裁切後的 ROI 畫布嘗試一次原生偵測
      if (barcodeDetector && offscreenCanvas) {
        try {
          const roiBarcodes = await barcodeDetector.detect(offscreenCanvas);
          for (const barcode of roiBarcodes) {
            if (barcode.rawValue && barcode.rawValue.trim()) {
              decodedTexts.push(barcode.rawValue.trim());
            }
          }
        } catch {
          // 略過 ROI 補測例外
        }
      }

      if (decodedTexts.length === 0) {
        const jsQrTexts = decodeWithJsQr(offscreenCtx, drawn.width, drawn.height);
        decodedTexts.push(...jsQrTexts);
      }
    }
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
 * 階梯式請求最佳可用的相機串流（1080p -> 720p -> 無解析度約束）
 * 避免 1080p 失敗時直接掉回 640x480 低畫質。
 *
 * @param deviceId - 指定之鏡頭 deviceId（選填）
 */
async function requestCameraStream(deviceId?: string): Promise<MediaStream> {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    throw new Error('瀏覽器不支援相機存取');
  }

  const baseTarget: MediaTrackConstraints = deviceId
    ? { deviceId: { exact: deviceId } }
    : { facingMode: { ideal: 'environment' } };

  const constraintFallbacks: MediaStreamConstraints[] = [
    {
      audio: false,
      video: {
        ...baseTarget,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    },
    {
      audio: false,
      video: {
        ...baseTarget,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    },
    {
      audio: false,
      video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' },
    },
  ];

  // 未指定特定鏡頭時才加入最終任意鏡頭保底
  if (!deviceId) {
    constraintFallbacks.push({ audio: false, video: true });
  }

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
 * 獨立套用單項進階鏡頭約束（拆開對焦與變焦呼叫，避免單項不支援連帶失敗）
 *
 * @param constraint - 欲套用之進階約束物件
 * @returns 是否套用成功
 */
async function applySingleTrackConstraint(
  constraint: ExtendedTrackConstraintSet
): Promise<boolean> {
  const videoTrack = mediaStream?.getVideoTracks()[0];
  if (!videoTrack || typeof videoTrack.applyConstraints !== 'function') {
    return false;
  }

  try {
    await videoTrack.applyConstraints({
      advanced: [constraint],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 讀取鏡頭能力並於開流後分別獨立初始化連續對焦與溫和預設變焦
 *
 * @param preserveZoom - 是否嘗試沿用呼叫前指定的倍率（切換鏡頭時設為 false）
 */
async function initCameraControlsAfterPlay(preserveZoom = false) {
  const videoTrack = mediaStream?.getVideoTracks()[0];
  if (!videoTrack || typeof videoTrack.getCapabilities !== 'function') {
    zoomRange.value = null;
    currentZoom.value = null;
    refreshDiagnostics();
    return;
  }

  let capabilities: ExtendedTrackCapabilities = {};
  try {
    capabilities = videoTrack.getCapabilities() as ExtendedTrackCapabilities;
  } catch {
    capabilities = {};
  }

  // 1. 獨立套用連續自動對焦（於 video.play() 開流後執行以相容 Android Camera2 HAL）
  if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
    const applied = await applySingleTrackConstraint({ focusMode: 'continuous' });
    if (applied) {
      diagnosticFocusMode.value = 'continuous';
    }
  }

  // 2. 獨立讀取硬體變焦範圍並套用溫和預設倍率（讓使用者拉遠至清晰焦距同時放大 QR Code）
  const capZoom = capabilities.zoom;
  if (
    capZoom &&
    typeof capZoom.min === 'number' &&
    typeof capZoom.max === 'number' &&
    capZoom.max > capZoom.min
  ) {
    zoomRange.value = {
      min: capZoom.min,
      max: capZoom.max,
      step: typeof capZoom.step === 'number' && capZoom.step > 0 ? capZoom.step : 0.1,
    };

    let targetZoom: number | null = null;
    if (preserveZoom && currentZoom.value !== null) {
      targetZoom = Math.min(capZoom.max, Math.max(capZoom.min, currentZoom.value));
    } else if (capZoom.min <= 1 && capZoom.max >= 1.5) {
      // 主鏡頭預設溫和拉至 1.8x（避免過度裁切，同時迫使手距保持在 15~20cm 清晰焦段）
      targetZoom = Math.min(capZoom.max, 1.8);
    }

    if (targetZoom !== null) {
      const zoomed = await applySingleTrackConstraint({ zoom: targetZoom });
      if (zoomed) {
        currentZoom.value = Number(targetZoom.toFixed(1));
      }
    }
  } else {
    zoomRange.value = null;
    currentZoom.value = null;
  }

  refreshDiagnostics();
}

/**
 * 手動切換鏡頭變焦倍率
 *
 * @param targetZoom - 欲套用之目標倍率
 */
async function handleSelectZoom(targetZoom: number) {
  if (!zoomRange.value) return;
  const clamped = Number(
    Math.min(zoomRange.value.max, Math.max(zoomRange.value.min, targetZoom)).toFixed(1)
  );
  const applied = await applySingleTrackConstraint({ zoom: clamped });
  if (applied) {
    currentZoom.value = clamped;
    refreshDiagnostics();
  }
}

/**
 * 點擊相機預覽區重新對焦（Tap-to-Focus）
 * 透過先觸發 single-shot（或 manual）再切回 continuous，強制 Android Camera2 HAL 重新啟動自動對焦搜尋。
 */
async function handleTapToFocus(event: MouseEvent) {
  if (!isCameraActive.value || !mediaStream) return;

  const container = readerContainerRef.value;
  if (container && typeof container.getBoundingClientRect === 'function') {
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const xPct = Math.min(92, Math.max(8, ((event.clientX - rect.left) / rect.width) * 100));
      const yPct = Math.min(92, Math.max(8, ((event.clientY - rect.top) / rect.height) * 100));
      focusIndicator.value = { x: xPct, y: yPct };
    } else {
      focusIndicator.value = { x: 50, y: 50 };
    }
  } else {
    focusIndicator.value = { x: 50, y: 50 };
  }

  if (focusIndicatorTimer !== null) {
    clearTimeout(focusIndicatorTimer);
  }
  focusIndicatorTimer = setTimeout(() => {
    focusIndicator.value = null;
  }, 750);

  const videoTrack = mediaStream.getVideoTracks()[0];
  if (!videoTrack || typeof videoTrack.getCapabilities !== 'function') return;

  let focusModes: string[] = [];
  try {
    const caps = videoTrack.getCapabilities() as ExtendedTrackCapabilities;
    if (Array.isArray(caps.focusMode)) {
      focusModes = caps.focusMode;
    }
  } catch {
    return;
  }

  if (refocusRestoreTimer !== null) {
    clearTimeout(refocusRestoreTimer);
    refocusRestoreTimer = null;
  }

  if (focusModes.includes('single-shot')) {
    const shotApplied = await applySingleTrackConstraint({ focusMode: 'single-shot' });
    if (shotApplied) {
      diagnosticFocusMode.value = 'single-shot';
    }
    if (focusModes.includes('continuous')) {
      refocusRestoreTimer = setTimeout(async () => {
        if (!isScanning || isDisposed) return;
        const contApplied = await applySingleTrackConstraint({ focusMode: 'continuous' });
        if (contApplied) {
          diagnosticFocusMode.value = 'continuous';
        }
        refreshDiagnostics();
      }, 350);
    }
  } else if (focusModes.includes('continuous')) {
    await applySingleTrackConstraint({ focusMode: 'continuous' });
    diagnosticFocusMode.value = 'continuous';
  }

  refreshDiagnostics();
}

/**
 * 切換至下一顆可用鏡頭並記憶偏好 deviceId
 */
async function handleSwitchCamera() {
  if (isSwitchingCamera || availableCameras.value.length < 2) return;
  isSwitchingCamera = true;

  try {
    const currentIdx = availableCameras.value.findIndex(
      (cam) => cam.deviceId === currentDeviceId.value
    );
    const nextIdx = (currentIdx + 1) % availableCameras.value.length;
    const nextCamera = availableCameras.value[nextIdx];
    if (!nextCamera) return;

    savePreferredCameraId(nextCamera.deviceId);
    await stopScanner();
    await startScanner(nextCamera.deviceId);
  } finally {
    isSwitchingCamera = false;
  }
}

/**
 * 啟動相機掃描器
 *
 * @param preferredDeviceId - 指定欲啟動的鏡頭 deviceId（未傳時優先嘗試記憶鏡頭或預設後置鏡頭）
 */
async function startScanner(preferredDeviceId?: string) {
  cameraError.value = '';
  cameraWarning.value = '';
  cameraStatus.value = '正在啟動相機...';
  diagnosticResolution.value = '';
  diagnosticFocusMode.value = '';

  const targetDeviceId = preferredDeviceId ?? readPreferredCameraId();

  try {
    let stream: MediaStream;
    try {
      stream = await requestCameraStream(targetDeviceId || undefined);
    } catch (err: unknown) {
      // 若記憶之 deviceId 已失效（例如系統重置裝置 ID），改以預設後置鏡頭重試一次
      if (targetDeviceId && !preferredDeviceId) {
        stream = await requestCameraStream(undefined);
      } else {
        throw err;
      }
    }

    // 若使用者於授權過程中已關閉彈窗，立即釋放相機避免資源洩漏
    if (isDisposed) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    mediaStream = stream;

    const video = videoRef.value;
    if (!video) {
      await stopScanner();
      return;
    }

    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();

    // 開流完成後再取得目前裝置 ID、列舉多鏡頭並套用獨立對焦與變焦約束
    const activeTrack = stream.getVideoTracks()[0];
    const activeSettings =
      activeTrack && typeof activeTrack.getSettings === 'function'
        ? activeTrack.getSettings()
        : {};
    const resolvedDeviceId = activeSettings.deviceId || targetDeviceId || '';
    if (resolvedDeviceId) {
      currentDeviceId.value = resolvedDeviceId;
    }

    await refreshAvailableCameras(resolvedDeviceId || undefined);
    await initCameraControlsAfterPlay(false);

    barcodeDetector = await initBarcodeDetector();
    nativeDetectorFailCount = 0;
    isCameraActive.value = true;
    isScanning = true;
    scanTickCount = 0;
    refreshDiagnostics();

    cameraStatus.value = '相機已就緒，請保持約 15～20 公分對準發票 QR Code';
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
  if (focusIndicatorTimer !== null) {
    clearTimeout(focusIndicatorTimer);
    focusIndicatorTimer = null;
  }
  if (refocusRestoreTimer !== null) {
    clearTimeout(refocusRestoreTimer);
    refocusRestoreTimer = null;
  }
  focusIndicator.value = null;

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
            ref="readerContainerRef"
            class="relative w-full aspect-[4/3] max-h-64 bg-slate-900 rounded-lg overflow-hidden border border-slate-200 text-slate-400 text-xs cursor-crosshair select-none"
            @click="handleTapToFocus"
          >
            <video
              ref="videoRef"
              autoplay
              playsinline
              muted
              class="w-full h-full object-cover"
            ></video>

            <!-- 視覺對準引導框（對應 1:1 可視中央 ROI 範圍） -->
            <div
              v-if="isCameraActive"
              class="pointer-events-none absolute inset-0 flex items-center justify-center p-6"
            >
              <div class="relative w-[84%] h-[72%] max-w-[280px] max-h-[150px] border-2 border-teal-400/80 rounded-lg shadow-[0_0_0_9999px_rgba(15,23,42,0.38)]">
                <span class="absolute -top-0.5 -left-0.5 w-4 h-4 border-t-4 border-l-4 border-teal-300 rounded-tl"></span>
                <span class="absolute -top-0.5 -right-0.5 w-4 h-4 border-t-4 border-r-4 border-teal-300 rounded-tr"></span>
                <span class="absolute -bottom-0.5 -left-0.5 w-4 h-4 border-b-4 border-l-4 border-teal-300 rounded-bl"></span>
                <span class="absolute -bottom-0.5 -right-0.5 w-4 h-4 border-b-4 border-r-4 border-teal-300 rounded-br"></span>
              </div>
            </div>

            <!-- 點擊重新對焦視覺回饋方框 -->
            <div
              v-if="focusIndicator"
              class="pointer-events-none absolute w-12 h-12 -translate-x-1/2 -translate-y-1/2 border-2 border-amber-300 rounded-md animate-ping"
              :style="{ left: `${focusIndicator.x}%`, top: `${focusIndicator.y}%` }"
            ></div>

            <!-- 相機控制工具列（變焦倍率 ＋ 多鏡頭切換） -->
            <div
              v-if="isCameraActive && (zoomPresets.length > 0 || availableCameras.length > 1)"
              class="absolute bottom-2 inset-x-2 flex items-center justify-between gap-2 pointer-events-auto"
              @click.stop
            >
              <!-- 變焦倍率快速切換 -->
              <div v-if="zoomPresets.length > 0" class="flex items-center gap-1 bg-slate-900/70 backdrop-blur-xs px-1.5 py-1 rounded-full">
                <button
                  v-for="preset in zoomPresets"
                  :key="preset"
                  type="button"
                  data-testid="zoom-btn"
                  class="px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors"
                  :class="
                    currentZoom !== null && Math.abs(currentZoom - preset) < 0.15
                      ? 'bg-teal-500 text-white'
                      : 'text-slate-200 hover:bg-slate-700/80'
                  "
                  @click="handleSelectZoom(preset)"
                >
                  {{ preset }}x
                </button>
              </div>
              <div v-else></div>

              <!-- 多鏡頭切換按鈕 -->
              <button
                v-if="availableCameras.length > 1"
                type="button"
                data-testid="switch-camera-btn"
                class="px-2.5 py-1 rounded-full bg-slate-900/75 hover:bg-slate-800 text-white text-[11px] font-medium backdrop-blur-xs border border-white/20"
                @click="handleSwitchCamera"
              >
                切換鏡頭 ({{ currentCameraIndex }}/{{ availableCameras.length }})
              </button>
            </div>

            <!-- 相機尚未就緒時之佔位提示 -->
            <div
              v-if="!isCameraActive"
              class="absolute inset-0 flex items-center justify-center px-4 text-center text-slate-400"
            >
              <span>{{ cameraError ? '相機無法使用，請使用下方手動輸入' : '正在開啟相機鏡頭...' }}</span>
            </div>
          </div>

          <!-- 精簡實機診斷資訊列（解析度 / 鏡頭 / 倍率 / 對焦 / 引擎） -->
          <div
            v-if="diagnosticSummary"
            data-testid="camera-diagnostics"
            class="text-[11px] font-mono text-slate-500 bg-slate-50 border border-slate-200 rounded-md px-2 py-1 truncate"
            :title="diagnosticSummary"
          >
            {{ diagnosticSummary }}
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
          請與發票保持約 15～20 公分對準框內；若畫面模糊可點擊畫面重新對焦、調整倍率或切換後置鏡頭，亦可在下方手動輸入雙碼內容。
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
