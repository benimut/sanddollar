<script setup lang="ts">
/**
 * @file InvoiceScannerModal.vue
 * @description 電子發票雙 QR Code 相機掃描彈窗元件
 *
 * 核心業務職責：
 * 1. 所見即所掃的完整相機預覽：使用 object-contain 完整呈現鏡頭畫面不裁切，確保螢幕看到的區域即為掃描範圍，不出現畫面外提前誤掃。
 * 2. 免手動調整的智慧選鏡與自動對焦：
 *    - 優先使用曾成功掃出發票的記憶鏡頭；若預設鏡頭不支援自動對焦，自動靜默切換其他後置鏡頭。
 *    - 維持連續自動對焦並於久未解碼時溫和背景重對焦；多後置鏡頭時僅於角落保留精巧圖示按鈕作為切換逃生口。
 * 3. 雙引擎高解析度解碼：優先使用瀏覽器原生 BarcodeDetector（單幀可同時讀取左右雙碼），不支援或未命中時以 jsQR 全圖＋左右分區與 Big5 備援解碼。
 * 4. 無阻擋一鍵帶入表單：掃描端不選擇也不阻擋分類，解析後直接預覽並帶入支出表單，交由表單儲存時驗證分類。
 */

import { ref, onMounted, onUnmounted } from 'vue';
import { SwitchCamera, RotateCcw, Camera, Crop } from 'lucide-vue-next';
import jsQR from 'jsqr';
import { parseInvoiceQRCode, type ParsedInvoiceResult } from '@/utils/invoiceParser';
import ReceiptCropper, { type CroppedImagePayload } from './ReceiptCropper.vue';

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

/** 擴充 MediaTrackCapabilities（涵蓋行動瀏覽器對焦能力屬性） */
interface ExtendedTrackCapabilities extends MediaTrackCapabilities {
  focusMode?: string[];
}

/** 擴充 MediaTrackConstraintSet（涵蓋行動瀏覽器對焦約束屬性） */
interface ExtendedTrackConstraintSet extends MediaTrackConstraintSet {
  focusMode?: string;
}

/** 可供切換之相機裝置項目 */
interface CameraDeviceOption {
  deviceId: string;
  label: string;
}

/** 僅於成功掃出有效電子發票時寫入之偏好鏡頭 deviceId 鍵名 */
const VERIFIED_CAMERA_STORAGE_KEY = 'sanddollar_invoice_scanner_verified_camera_id';

/** jsQR 離屏解碼畫布最大邊長上限 */
const MAX_JSQR_DIMENSION = 1280;

/** 每幀掃描間隔（毫秒） */
const SCAN_INTERVAL_MS = 120;

/** 開啟或切換鏡頭後等待畫面穩定的延遲（毫秒），避免晃動首幀誤掃 */
const CAMERA_STABILIZE_DELAY_MS = 250;

/** 原生 BarcodeDetector 連續失敗幾次後才停用降級 */
const NATIVE_DETECTOR_MAX_FAILURES = 5;

/** 有原生 BarcodeDetector 時，每隔幾幀才以 jsQR 補救一次（避免主執行緒卡頓） */
const JSQR_ASSIST_INTERVAL_TICKS = 5;

/** 尚未掃出左碼時，每隔多久背景溫和重觸發一次自動對焦（毫秒） */
const BACKGROUND_REFOCUS_INTERVAL_MS = 4500;

/** 單次對焦收斂等待時間（毫秒） */
const SINGLE_SHOT_SETTLE_MS = 750;

/** 無自動對焦鏡頭時，最多自動靜默嘗試幾顆其他後置鏡頭 */
const MAX_AUTO_FALLBACK_CAMERAS = 2;

/** 台灣電子發票左側主體碼格式（至少 77 碼且前 10 碼為 2 碼大寫英文 + 8 碼數字） */
const TAIWAN_INVOICE_LEFT_PREFIX = /^[A-Z]{2}\d{8}/;

/** 掃描模式：電子發票雙 QR Code 或紙本發票拍照辨識 */
type ScanMode = 'qr' | 'paper';

/** 紙本發票拍照流程階段 */
type PaperStep = 'camera' | 'crop' | 'result';

const props = withDefaults(
  defineProps<{
    /** 使用者現有支出分類清單（僅於紙本發票模式傳給後端做品項分類對應） */
    categories?: string[];
  }>(),
  {
    categories: () => [],
  }
);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'parsed', result: ParsedInvoiceResult): void;
}>();

/** 當前掃描模式（預設電子發票 QR Code） */
const scanMode = ref<ScanMode>('qr');

/** 紙本發票流程目前階段 */
const paperStep = ref<PaperStep>('camera');

/** 紙本發票拍下之原始影像 Data URL（供正矩形框選裁切） */
const capturedImageUrl = ref('');

/** 是否正在呼叫後端 Gemini API 辨識紙本發票 */
const isAnalyzingPaper = ref(false);

/** 是否因 Cloudflare Access 登入過期導致 API 驗證失敗 */
const isAuthExpired = ref(false);

/** 相機即時預覽 video 元素參考 */
const videoRef = ref<HTMLVideoElement | null>(null);

/** 左側 QR Code 字串（含金額、發票號碼等 77 碼以上資訊） */
const leftCode = ref('');

/** 右側 QR Code 字串（延伸品項明細） */
const rightCode = ref('');

/** 發票解析錯誤提示訊息 */
const errorMessage = ref('');

/** 相機啟動與存取錯誤提示訊息 */
const cameraError = ref('');

/** 掃描到非發票 QR Code 時的即時提醒訊息 */
const cameraWarning = ref('');

/** 相機掃描狀態導引提示 */
const cameraStatus = ref('');

/** 相機是否已成功啟動並開始播放畫面 */
const isCameraActive = ref(false);

/** 是否因左、右雙碼皆讀取完成而暫停掃描 */
const isScanPaused = ref(false);

/** 解析後之發票結構資料 */
const parsedResult = ref<ParsedInvoiceResult | null>(null);

/** 可切換的後置相機裝置清單 */
const availableCameras = ref<CameraDeviceOption[]>([]);

/** 目前使用中的鏡頭 deviceId */
const currentDeviceId = ref('');

/** 目前啟用中的相機 MediaStream */
let mediaStream: MediaStream | null = null;

/** 掃描排程計時器 */
let scanTimer: ReturnType<typeof setTimeout> | null = null;

/** 背景溫和重對焦排程計時器 */
let backgroundRefocusTimer: ReturnType<typeof setTimeout> | null = null;

/** 單次對焦後恢復連續對焦的計時器 */
let refocusRestoreTimer: ReturnType<typeof setTimeout> | null = null;

/** 是否處於掃描迴圈運行狀態 */
let isScanning = false;

/** 元件是否已卸載或關閉（避免非同步相機請求回傳後資源洩漏） */
let isDisposed = false;

/** 防止快速連點切換鏡頭造成並行開啟衝突 */
let isSwitchingCamera = false;

/** 複用之離屏解碼畫布與 2D 繪圖環境 */
let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;

/** 瀏覽器原生 BarcodeDetector 實例（不支援時為 null） */
let barcodeDetector: BarcodeDetectorInstance | null = null;

/** 原生 BarcodeDetector 連續錯誤次數 */
let nativeDetectorFailCount = 0;

/** 掃描影格計數 */
let scanTickCount = 0;

/** 記錄已由自動選鏡嘗試過的無對焦鏡頭，避免重複循環 */
const triedNonAfDeviceIds = new Set<string>();

/**
 * 安全讀取曾成功掃出發票的記憶鏡頭 deviceId
 */
function readVerifiedCameraId(): string {
  try {
    return window.localStorage.getItem(VERIFIED_CAMERA_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * 僅在成功辨識出有效電子發票時記憶目前鏡頭 deviceId
 */
function saveVerifiedCameraId(deviceId: string) {
  if (!deviceId) return;
  try {
    window.localStorage.setItem(VERIFIED_CAMERA_STORAGE_KEY, deviceId);
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
 * 列舉可用相機清單並優先過濾出後置鏡頭
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
 * 讀取目前相機軌道的支援對焦模式清單
 */
function getTrackFocusModes(stream: MediaStream | null): string[] {
  const videoTrack = stream?.getVideoTracks()[0];
  if (!videoTrack || typeof videoTrack.getCapabilities !== 'function') {
    return [];
  }
  try {
    const caps = videoTrack.getCapabilities() as ExtendedTrackCapabilities;
    return Array.isArray(caps.focusMode) ? caps.focusMode : [];
  } catch {
    return [];
  }
}

/**
 * 獨立套用單項鏡頭對焦約束
 */
async function applyFocusConstraint(focusMode: string): Promise<boolean> {
  const videoTrack = mediaStream?.getVideoTracks()[0];
  if (!videoTrack || typeof videoTrack.applyConstraints !== 'function') {
    return false;
  }

  try {
    const constraint: ExtendedTrackConstraintSet = { focusMode };
    await videoTrack.applyConstraints({ advanced: [constraint] });
    return true;
  } catch {
    return false;
  }
}

/**
 * 清除背景重對焦相關計時器
 */
function clearRefocusTimers() {
  if (backgroundRefocusTimer !== null) {
    clearTimeout(backgroundRefocusTimer);
    backgroundRefocusTimer = null;
  }
  if (refocusRestoreTimer !== null) {
    clearTimeout(refocusRestoreTimer);
    refocusRestoreTimer = null;
  }
}

/**
 * 排程背景溫和自動重對焦
 * 僅在左碼尚未掃出、且鏡頭同時支援 single-shot 與 continuous 時低頻觸發，避免干擾正常手持對準。
 */
function scheduleBackgroundRefocus() {
  clearRefocusTimers();
  if (!isScanning || isDisposed || leftCode.value.trim()) return;

  const focusModes = getTrackFocusModes(mediaStream);
  if (!focusModes.includes('single-shot') || !focusModes.includes('continuous')) {
    return;
  }

  backgroundRefocusTimer = setTimeout(async () => {
    if (!isScanning || isDisposed || leftCode.value.trim()) return;

    await applyFocusConstraint('single-shot');
    refocusRestoreTimer = setTimeout(async () => {
      if (!isScanning || isDisposed) return;
      await applyFocusConstraint('continuous');
      scheduleBackgroundRefocus();
    }, SINGLE_SHOT_SETTLE_MS);
  }, BACKGROUND_REFOCUS_INTERVAL_MS);
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
 * 將目前完整相機畫面繪製至離屏高解析度畫布供 jsQR 解碼
 */
function drawFullFrameToCanvas(video: HTMLVideoElement): { width: number; height: number } | null {
  const srcWidth = video.videoWidth;
  const srcHeight = video.videoHeight;
  const maxSide = Math.max(srcWidth, srcHeight);
  const scale = maxSide > MAX_JSQR_DIMENSION ? MAX_JSQR_DIMENSION / maxSide : 1;
  const targetWidth = Math.max(16, Math.round(srcWidth * scale));
  const targetHeight = Math.max(16, Math.round(srcHeight * scale));

  if (!offscreenCanvas) {
    offscreenCanvas = document.createElement('canvas');
    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!offscreenCtx) return null;

  if (offscreenCanvas.width !== targetWidth || offscreenCanvas.height !== targetHeight) {
    offscreenCanvas.width = targetWidth;
    offscreenCanvas.height = targetHeight;
  }

  offscreenCtx.drawImage(video, 0, 0, targetWidth, targetHeight);
  return { width: targetWidth, height: targetHeight };
}

/**
 * 使用 jsQR 對完整高解析度畫面進行全圖與左右分區解碼
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
  const leftWidth = Math.floor(width * 0.6);
  const rightStartX = Math.floor(width * 0.4);
  const rightWidth = width - rightStartX;

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
 * 暫停背景掃描迴圈（維持預覽畫面但停止解碼，避免雙碼掃齊後誤掃旁邊條碼）
 */
function pauseScanningLoop() {
  isScanning = false;
  isScanPaused.value = true;
  clearRefocusTimers();
  if (scanTimer !== null) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
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
    if (currentDeviceId.value) {
      saveVerifiedCameraId(currentDeviceId.value);
    }
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(40);
    }

    if (leftCode.value.trim()) {
      cameraStatus.value = '已讀取左、右雙 QR Code，請確認後帶入表單';
      parseCurrentCodes();
      pauseScanningLoop();
    } else {
      cameraStatus.value = '已讀取右側明細碼，請繼續對準左側 QR Code';
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
    clearRefocusTimers();
    if (currentDeviceId.value) {
      saveVerifiedCameraId(currentDeviceId.value);
    }
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(40);
    }

    parseCurrentCodes();
    if (rightCode.value.trim()) {
      cameraStatus.value = '已讀取左、右雙 QR Code，請確認後帶入表單';
      pauseScanningLoop();
    } else {
      cameraStatus.value = '已讀取左側 QR Code，若有右側明細碼請接續掃描或直接帶入';
    }
    return;
  }

  // 掃描到非台灣電子發票格式之 QR Code，提供即時提醒且不覆蓋已掃描資料
  cameraWarning.value = '偵測到非電子發票 QR Code，請對準發票上的左右方塊 QR Code';
}

/**
 * 執行單一相機影格的高解析度雙引擎解碼
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

  scanTickCount += 1;
  const decodedTexts: string[] = [];

  // 引擎 A：原生 BarcodeDetector 直接讀取完整高解析度 video（與 object-contain 所見畫面一致）
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
        barcodeDetector = null;
      }
    }
  }

  // 引擎 B：無原生引擎時每幀掃描；有原生引擎時低頻補救（避免阻塞主執行緒影響對焦）
  const shouldRunJsQr =
    decodedTexts.length === 0 &&
    (!barcodeDetector || scanTickCount % JSQR_ASSIST_INTERVAL_TICKS === 0);

  if (shouldRunJsQr) {
    const drawn = drawFullFrameToCanvas(video);
    if (drawn && offscreenCtx) {
      const jsQrTexts = decodeWithJsQr(offscreenCtx, drawn.width, drawn.height);
      decodedTexts.push(...jsQrTexts);
    }
  }

  // 處理所有解碼結果（先左碼再右碼，確保同時掃出雙碼時一次完成合併）
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
 *
 * @param delayMs - 距離下次掃描之延遲毫秒數
 */
function scheduleNextScan(delayMs = SCAN_INTERVAL_MS) {
  if (!isScanning || isDisposed) return;

  scanTimer = setTimeout(async () => {
    try {
      await scanSingleFrame();
    } finally {
      scheduleNextScan(SCAN_INTERVAL_MS);
    }
  }, delayMs);
}

/**
 * 階梯式請求最佳可用的相機串流（1080p -> 720p -> 無解析度約束）
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

  if (!deviceId) {
    constraintFallbacks.push({ audio: false, video: true });
  }

  let lastError: unknown = null;
  for (const constraints of constraintFallbacks) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err: unknown) {
      lastError = err;
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        throw err;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('無法取得相機串流');
}

/**
 * 啟動相機掃描器
 *
 * @param options - 啟動參數（指定鏡頭 ID 與是否為使用者手動切換）
 */
async function startScanner(options?: {
  deviceId?: string;
  isManualSwitch?: boolean;
}) {
  cameraError.value = '';
  cameraWarning.value = '';
  isScanPaused.value = false;
  cameraStatus.value = '正在開啟相機...';

  const isManualSwitch = options?.isManualSwitch === true;
  const requestedDeviceId = options?.deviceId;
  const targetDeviceId = requestedDeviceId ?? readVerifiedCameraId();

  try {
    let stream: MediaStream;
    try {
      stream = await requestCameraStream(targetDeviceId || undefined);
    } catch (err: unknown) {
      // 若記憶之鏡頭 ID 已失效，改以預設後置鏡頭重試一次
      if (targetDeviceId && !requestedDeviceId) {
        stream = await requestCameraStream(undefined);
      } else {
        throw err;
      }
    }

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

    // 智慧自動選鏡：若預設開啟的鏡頭完全不支援自動對焦，靜默切換其他候選後置鏡頭（最多嘗試 2 顆）
    const focusModes = getTrackFocusModes(stream);
    const hasAutoFocus =
      focusModes.includes('continuous') || focusModes.includes('single-shot');

    if (
      !isManualSwitch &&
      !hasAutoFocus &&
      resolvedDeviceId &&
      availableCameras.value.length > 1 &&
      triedNonAfDeviceIds.size < MAX_AUTO_FALLBACK_CAMERAS
    ) {
      triedNonAfDeviceIds.add(resolvedDeviceId);
      const nextCandidate = availableCameras.value.find(
        (cam) => !triedNonAfDeviceIds.has(cam.deviceId)
      );
      if (nextCandidate) {
        await stopScanner();
        await startScanner({ deviceId: nextCandidate.deviceId, isManualSwitch: false });
        return;
      }
    }

    // 畫面開始播放後套用連續自動對焦
    if (focusModes.includes('continuous')) {
      await applyFocusConstraint('continuous');
    }

    barcodeDetector = await initBarcodeDetector();
    nativeDetectorFailCount = 0;
    isCameraActive.value = true;
    scanTickCount = 0;

    if (scanMode.value === 'qr') {
      isScanning = true;
      cameraStatus.value = '請將發票 QR Code 置於畫面中並保持約 15～20 公分';
      // 等待短暫畫面穩定後再開始解碼，避免首幀晃動誤掃
      scheduleNextScan(CAMERA_STABILIZE_DELAY_MS);
      scheduleBackgroundRefocus();
    } else {
      isScanning = false;
      cameraStatus.value = '請將紙本發票置於畫面中，對焦清晰後按下拍照';
    }
  } catch (err: unknown) {
    await stopScanner();
    const msg = err instanceof Error ? err.message : String(err);
    cameraStatus.value = '';
    cameraError.value = `相機啟動失敗或權限遭拒 (${msg})，請確認瀏覽器相機權限後重試。`;
  }
}

/**
 * 切換至下一顆後置鏡頭（逃生口；切換當下不寫入偏好，待成功掃出發票才記憶）
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

    await stopScanner();
    await startScanner({ deviceId: nextCamera.deviceId, isManualSwitch: true });
  } finally {
    isSwitchingCamera = false;
  }
}

/**
 * 清空已讀取資料並重新啟動即時掃描
 */
function handleRescan() {
  leftCode.value = '';
  rightCode.value = '';
  parsedResult.value = null;
  errorMessage.value = '';
  cameraWarning.value = '';
  isScanPaused.value = false;

  if (isCameraActive.value && !isScanning) {
    isScanning = true;
    scanTickCount = 0;
    cameraStatus.value = '請將發票 QR Code 置於畫面中並保持約 15～20 公分';
    scheduleNextScan(SCAN_INTERVAL_MS);
    scheduleBackgroundRefocus();
  }
}

/**
 * 安全停止並清理相機與掃描迴圈資源
 */
async function stopScanner() {
  isScanning = false;
  isCameraActive.value = false;
  clearRefocusTimers();

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
 * 切換掃描模式（電子發票 QR Code / 紙本發票拍照辨識）
 * 切換時共用既有相機串流不重開鏡頭，降低延遲與權限干擾。
 */
function handleSwitchMode(mode: ScanMode) {
  if (scanMode.value === mode || isAnalyzingPaper.value) return;

  scanMode.value = mode;
  errorMessage.value = '';
  cameraWarning.value = '';
  isAuthExpired.value = false;
  parsedResult.value = null;

  if (mode === 'paper') {
    pauseScanningLoop();
    leftCode.value = '';
    rightCode.value = '';
    paperStep.value = 'camera';
    capturedImageUrl.value = '';
    cameraStatus.value = isCameraActive.value
      ? '請將紙本發票置於畫面中，對焦清晰後按下拍照'
      : '';
  } else {
    paperStep.value = 'camera';
    capturedImageUrl.value = '';
    isScanPaused.value = false;
    if (isCameraActive.value) {
      isScanning = true;
      scanTickCount = 0;
      cameraStatus.value = '請將發票 QR Code 置於畫面中並保持約 15～20 公分';
      scheduleNextScan(SCAN_INTERVAL_MS);
      scheduleBackgroundRefocus();
    }
  }
}

/**
 * 紙本發票模式：擷取目前相機高解析度影格，進入正矩形框選裁切步驟
 */
function handleCapturePaperPhoto() {
  errorMessage.value = '';
  isAuthExpired.value = false;

  const video = videoRef.value;
  if (
    !video ||
    !isCameraActive.value ||
    video.readyState < 2 ||
    video.videoWidth <= 0 ||
    video.videoHeight <= 0
  ) {
    errorMessage.value = '相機畫面尚未就緒，請稍候再按下拍照。';
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    errorMessage.value = '無法擷取相機畫面，請重試。';
    return;
  }

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  capturedImageUrl.value = canvas.toDataURL('image/jpeg', 0.92);
  parsedResult.value = null;
  paperStep.value = 'crop';
}

/**
 * 紙本發票模式：捨棄目前拍攝畫面，回到即時取景重拍
 */
function handlePaperRetake() {
  if (isAnalyzingPaper.value) return;
  capturedImageUrl.value = '';
  parsedResult.value = null;
  errorMessage.value = '';
  isAuthExpired.value = false;
  paperStep.value = 'camera';
  cameraStatus.value = isCameraActive.value
    ? '請將紙本發票置於畫面中，對焦清晰後按下拍照'
    : '';
}

/**
 * 紙本發票模式：保留已拍攝照片並返回正矩形裁切步驟微調範圍
 */
function handlePaperRecrop() {
  if (isAnalyzingPaper.value || !capturedImageUrl.value) return;
  parsedResult.value = null;
  errorMessage.value = '';
  isAuthExpired.value = false;
  paperStep.value = 'crop';
}

/**
 * 重新整理頁面以完成 Cloudflare Access 登入驗證續期
 */
function handleReloadForAuth() {
  window.location.reload();
}

/**
 * 紙本發票模式：將正矩形裁切並壓縮後之影像送往同源 Worker API 進行 Gemini AI 辨識
 */
async function handlePaperCropConfirm(payload: CroppedImagePayload) {
  if (isAnalyzingPaper.value) return;
  errorMessage.value = '';
  isAuthExpired.value = false;

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    errorMessage.value = '目前處於離線狀態，紙本發票 AI 辨識需要網路連線。';
    return;
  }

  isAnalyzingPaper.value = true;
  try {
    const response = await fetch('/api/parse-invoice', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        imageBase64: payload.imageBase64,
        mimeType: payload.mimeType,
        categories: props.categories,
      }),
    });

    const responseContentType = response.headers.get('content-type') || '';

    // 若遭遇 Cloudflare Access 登入過期，可能會收到 401/403 或被重導向至 HTML 登入頁
    if (
      response.redirected ||
      response.status === 401 ||
      response.status === 403 ||
      !responseContentType.toLowerCase().includes('application/json')
    ) {
      isAuthExpired.value = true;
      errorMessage.value =
        '登入驗證可能已過期，請重新整理頁面完成 Cloudflare Access 驗證後再試。';
      return;
    }

    const data = (await response.json()) as {
      result?: ParsedInvoiceResult;
      error?: string;
    };

    if (!response.ok || !data.result) {
      errorMessage.value =
        data.error || `發票辨識失敗（狀態碼 ${response.status}），請確認照片清晰度後重試。`;
      return;
    }

    parsedResult.value = {
      ...data.result,
      source: 'paper',
    };
    paperStep.value = 'result';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMessage.value = `無法連線至紙本發票辨識服務 (${msg})，請確認網路連線後重試。`;
  } finally {
    isAnalyzingPaper.value = false;
  }
}

/**
 * 依目前已掃描之左／右 QR Code 內容解析發票資訊
 * 商品分類統一留空，帶入支出表單後再依表單規則處理與驗證。
 */
function parseCurrentCodes() {
  errorMessage.value = '';
  if (!leftCode.value.trim()) {
    return;
  }

  try {
    const result = parseInvoiceQRCode(leftCode.value.trim(), rightCode.value.trim() || undefined);

    if (result.items && result.items.length > 0) {
      for (const item of result.items) {
        item.category = '';
      }
    }

    parsedResult.value = {
      ...result,
      source: 'qr',
    };
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
 * 確認並直接套用解析結果至支出記帳表單（不於掃描階段阻擋分類）
 */
async function handleApply() {
  if (!parsedResult.value) return;

  emit('parsed', parsedResult.value);
  isDisposed = true;
  await stopScanner();
  emit('close');
}

onMounted(async () => {
  isDisposed = false;
  triedNonAfDeviceIds.clear();
  await startScanner();
});

onUnmounted(async () => {
  isDisposed = true;
  await stopScanner();
});
</script>

<template>
  <div class="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="bg-white rounded-2xl max-w-lg w-full p-5 sm:p-6 shadow-xl max-h-[90vh] flex flex-col overflow-hidden">
      <!-- 標題欄 -->
      <div class="flex items-center justify-between pb-3 border-b border-slate-100">
        <h3 id="modal-title" class="text-lg font-bold text-slate-800">
          {{ scanMode === 'qr' ? '電子發票掃描' : '紙本發票拍照辨識' }}
        </h3>
        <button
          type="button"
          class="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
          @click="handleClose"
          aria-label="關閉"
        >
          ✕
        </button>
      </div>

      <!-- 模式切換列（電子發票雙 QR / 紙本發票拍照） -->
      <div class="pt-3">
        <div class="flex rounded-xl bg-slate-100 p-1" role="tablist" aria-label="發票掃描模式">
          <button
            type="button"
            role="tab"
            data-testid="mode-qr-btn"
            :aria-selected="scanMode === 'qr'"
            :disabled="isAnalyzingPaper"
            class="flex-1 py-1.5 text-xs font-bold rounded-lg transition-all"
            :class="
              scanMode === 'qr'
                ? 'bg-white text-teal-700 shadow-xs'
                : 'text-slate-500 hover:text-slate-800'
            "
            @click="handleSwitchMode('qr')"
          >
            電子發票 QR
          </button>
          <button
            type="button"
            role="tab"
            data-testid="mode-paper-btn"
            :aria-selected="scanMode === 'paper'"
            :disabled="isAnalyzingPaper"
            class="flex-1 py-1.5 text-xs font-bold rounded-lg transition-all"
            :class="
              scanMode === 'paper'
                ? 'bg-white text-teal-700 shadow-xs'
                : 'text-slate-500 hover:text-slate-800'
            "
            @click="handleSwitchMode('paper')"
          >
            紙本發票拍照
          </button>
        </div>
      </div>

      <!-- 內容區 -->
      <div class="py-3 space-y-3 overflow-y-auto flex-1">
        <!-- 相機預覽容器（QR 模式全程顯示；紙本模式於 camera 階段顯示，以 v-show 保持串流不斷線） -->
        <div v-show="scanMode === 'qr' || paperStep === 'camera'" class="space-y-2">
          <div v-if="cameraStatus" class="text-xs text-teal-600 font-medium">
            {{ cameraStatus }}
          </div>

          <div
            id="qr-reader"
            class="relative w-full h-72 sm:h-80 bg-slate-950 rounded-xl overflow-hidden border border-slate-200 flex items-center justify-center"
          >
            <video
              ref="videoRef"
              autoplay
              playsinline
              muted
              class="w-full h-full object-contain"
            ></video>

            <!-- 角落極簡切換鏡頭圖示按鈕（多後置鏡頭時顯示，減少畫面占用） -->
            <button
              v-if="isCameraActive && availableCameras.length > 1"
              type="button"
              data-testid="switch-camera-btn"
              class="absolute bottom-2.5 right-2.5 w-9 h-9 rounded-full bg-slate-900/75 hover:bg-slate-800 active:scale-95 text-white flex items-center justify-center border border-white/25 shadow-md transition"
              aria-label="切換鏡頭"
              title="切換鏡頭"
              @click="handleSwitchCamera"
            >
              <SwitchCamera class="w-4 h-4" />
            </button>

            <!-- 相機尚未就緒時之佔位提示 -->
            <div
              v-if="!isCameraActive"
              class="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-slate-400"
            >
              <span>{{ cameraError ? '無法開啟相機鏡頭' : '正在開啟相機鏡頭...' }}</span>
            </div>
          </div>

          <!-- 電子發票模式：左／右雙碼掃描進度與重新掃描按鈕 -->
          <div v-if="scanMode === 'qr'" class="flex items-center justify-between gap-2 text-[11px]">
            <div class="flex items-center gap-2">
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

            <button
              v-if="leftCode.trim() || rightCode.trim() || isScanPaused"
              type="button"
              data-testid="rescan-btn"
              class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-slate-600 hover:bg-slate-100 font-medium"
              @click="handleRescan"
            >
              <RotateCcw class="w-3 h-3" />
              <span>重新掃描</span>
            </button>
          </div>

          <!-- 紙本發票模式：拍照快門按鈕（僅支援即時拍照，不提供相簿上傳） -->
          <div v-else class="space-y-2 pt-1">
            <button
              type="button"
              data-testid="capture-paper-btn"
              :disabled="!isCameraActive"
              class="w-full py-2.5 px-4 bg-teal-600 hover:bg-teal-700 active:scale-[0.99] text-white font-bold text-sm rounded-xl shadow-xs transition flex items-center justify-center gap-2 disabled:opacity-50"
              @click="handleCapturePaperPhoto"
            >
              <Camera class="w-4 h-4" />
              <span>拍照並框選範圍</span>
            </button>
            <p class="text-[11px] text-slate-400 text-center">
              拍照後可先以正矩形裁切發票文字區域，再送交 Gemini AI 辨識（請避開完整卡號等個資）
            </p>
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

        <!-- 紙本發票模式：正矩形框選裁切步驟 -->
        <ReceiptCropper
          v-if="scanMode === 'paper' && paperStep === 'crop' && capturedImageUrl"
          :image-data-url="capturedImageUrl"
          :is-submitting="isAnalyzingPaper"
          @retake="handlePaperRetake"
          @confirm="handlePaperCropConfirm"
        />

        <!-- 紙本發票模式：辨識完成後之快速重拍／重新裁切操作列 -->
        <div
          v-if="scanMode === 'paper' && paperStep === 'result'"
          class="flex items-center justify-between gap-2 text-xs"
        >
          <span class="text-teal-700 font-semibold">AI 辨識完成，請核對後帶入表單</span>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="recrop-paper-btn"
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium"
              @click="handlePaperRecrop"
            >
              <Crop class="w-3 h-3" />
              <span>重新裁切</span>
            </button>
            <button
              type="button"
              data-testid="retake-after-result-btn"
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium"
              @click="handlePaperRetake"
            >
              <RotateCcw class="w-3 h-3" />
              <span>重拍</span>
            </button>
          </div>
        </div>

        <!-- 格式解析／AI 辨識錯誤提示 -->
        <div v-if="errorMessage" class="text-xs text-rose-600 bg-rose-50 p-2.5 rounded-lg border border-rose-200 space-y-2">
          <div>{{ errorMessage }}</div>
          <button
            v-if="isAuthExpired"
            type="button"
            class="px-2.5 py-1 rounded-md bg-rose-600 text-white font-semibold hover:bg-rose-700"
            @click="handleReloadForAuth"
          >
            重新整理完成驗證
          </button>
        </div>

        <!-- 解析預覽結果（緊鄰相機或裁切區下方，辨識完成即可確認並帶入表單） -->
        <div v-if="parsedResult" class="bg-teal-50 border border-teal-200 rounded-xl p-3 space-y-2.5">
          <div v-if="parsedResult.merchant" class="text-xs text-teal-950 font-bold">
            店家名稱：{{ parsedResult.merchant }}
          </div>
          <div class="flex justify-between text-xs text-teal-800 font-semibold gap-2 flex-wrap">
            <span>發票號碼：{{ parsedResult.invoiceNumber || '無' }}</span>
            <span>開立日期：{{ parsedResult.date || '未辨識' }}</span>
          </div>
          <div class="text-xs text-teal-900 font-bold">
            總計金額：NT$ {{ parsedResult.totalAmount }}
          </div>

          <!-- 商品明細純預覽（紙本模式一併顯示對應分類標籤） -->
          <div v-if="parsedResult.items && parsedResult.items.length > 0" class="space-y-1.5">
            <span class="block text-xs font-semibold text-teal-950">
              商品明細 ({{ parsedResult.items.length }} 項)：
            </span>
            <div class="space-y-1.5 max-h-40 overflow-y-auto pr-1">
              <div
                v-for="(item, idx) in parsedResult.items"
                :key="idx"
                class="flex items-center justify-between p-2 bg-white rounded-lg border border-teal-100 text-xs gap-2"
              >
                <div class="min-w-0 flex items-center gap-1.5">
                  <span class="font-medium text-slate-800 truncate" :title="item.name">
                    {{ item.name }}
                  </span>
                  <span
                    v-if="item.category"
                    class="px-1.5 py-0.5 rounded bg-teal-100 text-teal-800 text-[10px] font-medium shrink-0"
                  >
                    {{ item.category }}
                  </span>
                </div>
                <span class="text-slate-500 text-[11px] shrink-0">
                  {{ item.quantity }} × NT$ {{ item.unitPrice }} = NT$ {{ item.subtotal }}
                </span>
              </div>
            </div>
          </div>
          <div v-else class="text-xs text-slate-500 italic">
            無商品品項明細（純金額發票）
          </div>

          <!-- 紙本發票辨識出之折扣明細預覽 -->
          <div v-if="parsedResult.discounts && parsedResult.discounts.length > 0" class="space-y-1.5 pt-1 border-t border-teal-200/70">
            <span class="block text-xs font-semibold text-rose-700">
              折抵項目 ({{ parsedResult.discounts.length }} 項)：
            </span>
            <div class="space-y-1">
              <div
                v-for="(disc, dIdx) in parsedResult.discounts"
                :key="dIdx"
                class="flex items-center justify-between p-2 bg-white rounded-lg border border-rose-100 text-xs gap-2"
              >
                <div class="min-w-0 flex items-center gap-1.5">
                  <span class="font-medium text-slate-700 truncate">
                    {{ disc.name || '（未命名，帶入後請填寫）' }}
                  </span>
                  <span
                    v-if="disc.category"
                    class="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 text-[10px] font-medium shrink-0"
                  >
                    {{ disc.category }}
                  </span>
                </div>
                <span class="text-rose-600 font-semibold text-[11px] shrink-0">
                  -NT$ {{ disc.amount }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 操作按鈕（僅保留取消與帶入表單） -->
      <div class="pt-3 border-t border-slate-100 flex items-center justify-end space-x-2">
        <button
          type="button"
          class="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
          @click="handleClose"
        >
          取消
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
