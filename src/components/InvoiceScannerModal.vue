<script setup lang="ts">
/**
 * @file InvoiceScannerModal.vue
 * @description 發票整合相機掃描與 AI 辨識彈窗元件（方案 B+ 單一畫面整合）
 *
 * 核心業務職責：
 * 1. 純離線優先掃描：開啟即啟動雙引擎 QR Code 掃描（原生 BarcodeDetector 與 jsQR+Big5 備援），嚴格不觸發任何網路或認證請求。
 * 2. 所見即所掃且整合 AI 快門：單一相機預覽視窗保留「✨📷 AI 辨識／補充」按鈕，點擊當下才檢查 Cloudflare Access 授權並定格畫面。
 * 3. QR + AI 混合互補與自動初框：拍照瞬間先於本機嘗試讀取電子發票 QR 位置與內容，進裁切頁自動預框並把 QR 權威資料送交後端融合補店名與分類。
 * 4. 無阻擋一鍵帶入表單：掃描端不選擇也不阻擋分類，解析後直接預覽並帶入支出表單。
 */

import { ref, computed, onMounted, onUnmounted } from 'vue';
import { SwitchCamera, RotateCcw, Crop, ShieldCheck } from 'lucide-vue-next';
import jsQR from 'jsqr';
import { parseInvoiceQRCode, type ParsedInvoiceResult } from '@/utils/invoiceParser';
import {
  loadAiInvoiceSettings,
  type AiInvoiceModelId,
  type AiMediaResolution,
  type AiThinkingLevel,
} from '@/utils/aiInvoiceSettings';
import type { NormalizedRect } from '@/utils/receiptAutoCrop';
import ReceiptCropper, { type CroppedImagePayload } from './ReceiptCropper.vue';

/** 瀏覽器原生 BarcodeDetector 單筆偵測結果介面 */
interface DetectedBarcode {
  rawValue?: string;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
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

/** 發票掃描與 AI 辨識流程階段 */
type ScannerStep = 'camera' | 'crop' | 'result';

const props = withDefaults(
  defineProps<{
    /** 使用者現有支出分類清單（僅於觸發 AI 辨識時傳給後端做品項分類對應） */
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

/** 當前掃描與 AI 辨識流程階段 */
const scannerStep = ref<ScannerStep>('camera');

/** 由電子發票 QR Code 離線解析出之權威結構骨架（作為 QR+AI 混合補強依據） */
const qrParsedResult = ref<ParsedInvoiceResult | null>(null);

/** 定格照片上偵測到的電子發票 QR 歸一化錨點座標（供自動初框參考） */
const capturedQrAnchorRect = ref<NormalizedRect | null>(null);

/** 紙本發票拍照之暫存影像 URL（Object URL 或降級 Data URL，供正矩形框選裁切） */
const capturedImageUrl = ref('');

/** 由 URL.createObjectURL 建立之 Object URL 參照（供安全回收記憶體） */
let capturedObjectUrl = '';

/** AI 辨識實測效能摘要結構 */
interface PaperParseMetrics {
  model: AiInvoiceModelId | string;
  thinkingLevel: AiThinkingLevel | string;
  mediaResolution: AiMediaResolution | string;
  clientTotalMs: number;
  aiDurationMs?: number;
  imageKB: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
}

/** 最近一次 AI 發票辨識之實測效能與 Token 統計 */
const paperParseMetrics = ref<PaperParseMetrics | null>(null);

/** 是否正在呼叫後端 Gemini API 辨識發票 */
const isAnalyzingPaper = ref(false);

/** 是否正在擷取靜態影像或檢查 AI 授權中 */
const isPreparingAiCapture = ref(false);

/** 單一整合相機頁面的 AI 快門按鈕文案 */
const aiButtonLabel = computed(() =>
  qrParsedResult.value ? '✨📷 AI 辨識補充' : '✨📷 AI 辨識'
);

/** 裁切畫面頂部顯示的電子發票 QR 融合提示 */
const cropperQrHintText = computed(() => {
  const qr = qrParsedResult.value;
  if (!qr) return '';
  const summaryParts = [
    qr.invoiceNumber,
    qr.totalAmount > 0 ? `NT$ ${qr.totalAmount}` : '',
  ].filter(Boolean);
  return summaryParts.length > 0
    ? `已結合電子發票 QR（${summaryParts.join(' · ')}），請確保框選包含發票上方店家名稱`
    : '已結合電子發票 QR，請確保框選包含發票上方店家名稱';
});

/** AI 發票辨識結果預覽區之單行實測效能與成本摘要文字 */
const formattedPaperMetrics = computed(() => {
  const m = paperParseMetrics.value;
  if (!m) return '';

  const totalSec = (m.clientTotalMs / 1000).toFixed(1);
  const timePart =
    typeof m.aiDurationMs === 'number'
      ? `總計 ${totalSec}s（AI ${(m.aiDurationMs / 1000).toFixed(1)}s）`
      : `總計 ${totalSec}s`;

  const tokenParts: string[] = [];
  if (typeof m.inputTokens === 'number') tokenParts.push(`輸入 ${m.inputTokens}`);
  if (typeof m.thoughtTokens === 'number') tokenParts.push(`思考 ${m.thoughtTokens}`);
  if (typeof m.outputTokens === 'number') tokenParts.push(`輸出 ${m.outputTokens}`);

  const costSuffix =
    tokenParts.length > 0 ? ` ｜ 花費成本：${tokenParts.join(' / ')} token` : '';
  return `${m.model} · ${m.thinkingLevel} · ${m.mediaResolution} ｜ ${timePart} · ${m.imageKB} KB${costSuffix}`;
});

/** AI 認證狀態：unknown 未檢查 / checking 檢查中 / authenticated 已通過 / required 需認證 */
type AiAuthState = 'unknown' | 'checking' | 'authenticated' | 'required';

/** AI 辨識授權狀態（預設未檢查，開啟彈窗絕不自動發送認證檢查） */
const aiAuthState = ref<AiAuthState>('unknown');

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

/** 單筆 QR 解碼文字與歸一化座標位置 */
interface DecodedQrHit {
  text: string;
  rect: NormalizedRect | null;
}

/**
 * 判斷解碼字串是否符合台灣電子發票左碼或右碼格式
 */
function isTaiwanInvoiceQrText(text: string): boolean {
  return text.startsWith('**') || (text.length >= 77 && TAIWAN_INVOICE_LEFT_PREFIX.test(text));
}

/**
 * 安全計算 jsQR corner 座標轉換為整張原圖之歸一化正矩形
 */
function computeJsQrNormalizedRect(
  code: ReturnType<typeof jsQR>,
  regionOffsetX: number,
  regionOffsetY: number,
  canvasWidth: number,
  canvasHeight: number
): NormalizedRect | null {
  const loc = code?.location as
    | {
        topLeftCorner?: { x?: number; y?: number };
        topRightCorner?: { x?: number; y?: number };
        bottomLeftCorner?: { x?: number; y?: number };
        bottomRightCorner?: { x?: number; y?: number };
      }
    | undefined;
  if (
    !loc?.topLeftCorner ||
    !loc?.topRightCorner ||
    !loc?.bottomLeftCorner ||
    !loc?.bottomRightCorner ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    return null;
  }

  const corners = [
    loc.topLeftCorner,
    loc.topRightCorner,
    loc.bottomLeftCorner,
    loc.bottomRightCorner,
  ];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const pt of corners) {
    if (typeof pt.x !== 'number' || typeof pt.y !== 'number') return null;
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
    xs.push(pt.x + regionOffsetX);
    ys.push(pt.y + regionOffsetY);
  }

  const minX = Math.max(0, Math.min(...xs) / canvasWidth);
  const maxX = Math.min(1, Math.max(...xs) / canvasWidth);
  const minY = Math.max(0, Math.min(...ys) / canvasHeight);
  const maxY = Math.min(1, Math.max(...ys) / canvasHeight);
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) return null;

  return { x: minX, y: minY, width, height };
}

/**
 * 將原生 BarcodeDetector 的 boundingBox 轉換為歸一化正矩形
 */
function computeBarcodeNormalizedRect(
  box: DetectedBarcode['boundingBox'],
  canvasWidth: number,
  canvasHeight: number
): NormalizedRect | null {
  if (!box || canvasWidth <= 0 || canvasHeight <= 0) return null;
  if (
    !Number.isFinite(box.x) ||
    !Number.isFinite(box.y) ||
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    box.width <= 0 ||
    box.height <= 0
  ) {
    return null;
  }

  const x1 = Math.max(0, box.x / canvasWidth);
  const y1 = Math.max(0, box.y / canvasHeight);
  const x2 = Math.min(1, (box.x + box.width) / canvasWidth);
  const y2 = Math.min(1, (box.y + box.height) / canvasHeight);
  if (x2 <= x1 || y2 <= y1) return null;

  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * 合併多個非空歸一化矩形為單一外接聯集矩形
 */
function mergeNormalizedRects(rects: Array<NormalizedRect | null | undefined>): NormalizedRect | null {
  const valid = rects.filter((r): r is NormalizedRect => Boolean(r && r.width > 0 && r.height > 0));
  if (valid.length === 0) return null;

  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const r of valid) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

/**
 * 將 video 或靜態 canvas 繪製至離屏高解析度畫布供 jsQR 解碼
 */
function drawSourceToOffscreenCanvas(
  source: HTMLVideoElement | HTMLCanvasElement,
  srcWidth: number,
  srcHeight: number
): { width: number; height: number } | null {
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

  offscreenCtx.drawImage(source, 0, 0, targetWidth, targetHeight);
  return { width: targetWidth, height: targetHeight };
}

/**
 * 使用 jsQR 對完整高解析度畫面進行全圖與左右分區解碼（附帶座標位置）
 * 台灣電子發票的左、右兩顆 QR Code 緊鄰並排，分區裁切可避免兩組定位點互相干擾並支援同時讀取雙碼。
 */
function decodeWithJsQrHits(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): DecodedQrHit[] {
  const hitMap = new Map<string, NormalizedRect | null>();
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
      if (text && !hitMap.has(text)) {
        hitMap.set(
          text,
          computeJsQrNormalizedRect(decoded, region.x, region.y, width, height)
        );
      }
    } catch {
      // 略過單一分區讀取異常，避免中斷掃描迴圈
    }
  }

  return Array.from(hitMap.entries()).map(([text, rect]) => ({ text, rect }));
}

/**
 * 使用 jsQR 對完整高解析度畫面進行全圖與左右分區解碼（純文字清單）
 */
function decodeWithJsQr(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): string[] {
  return decodeWithJsQrHits(ctx, width, height).map((hit) => hit.text);
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
    const drawn = drawSourceToOffscreenCanvas(video, video.videoWidth, video.videoHeight);
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

    isScanning = true;
    cameraStatus.value = '請將發票 QR Code 置於畫面中（約 15～20 公分），或直接點擊下方 AI 辨識';
    // 等待短暫畫面穩定後再開始解碼，避免首幀晃動誤掃
    scheduleNextScan(CAMERA_STABILIZE_DELAY_MS);
    scheduleBackgroundRefocus();
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
  qrParsedResult.value = null;
  capturedQrAnchorRect.value = null;
  parsedResult.value = null;
  paperParseMetrics.value = null;
  errorMessage.value = '';
  cameraWarning.value = '';
  isAuthExpired.value = false;
  isScanPaused.value = false;

  if (isCameraActive.value && !isScanning) {
    isScanning = true;
    scanTickCount = 0;
    cameraStatus.value = '請將發票 QR Code 置於畫面中（約 15～20 公分），或直接點擊下方 AI 辨識';
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
 * 檢查是否已通過 Cloudflare Access 之 /api/* 存取認證
 * 僅於使用者主動點擊「✨📷 AI 辨識／補充」按鈕當下呼叫，確保離線掃 QR 完全零 API 請求。
 */
async function checkAiAuth(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    errorMessage.value = '目前處於離線狀態，AI 發票辨識需要網路連線。';
    return false;
  }

  aiAuthState.value = 'checking';
  errorMessage.value = '';
  isAuthExpired.value = false;

  try {
    const response = await fetch('/api/auth?check=1', {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
    });

    const contentType = response.headers.get('content-type') || '';
    if (
      response.type === 'opaqueredirect' ||
      response.redirected ||
      response.status === 401 ||
      response.status === 403 ||
      (response.status >= 300 && response.status < 400) ||
      !contentType.toLowerCase().includes('application/json')
    ) {
      aiAuthState.value = 'required';
      return false;
    }

    if (response.ok) {
      aiAuthState.value = 'authenticated';
      return true;
    }

    aiAuthState.value = 'required';
    return false;
  } catch {
    // 跨網域 Access 登入重導向在部分瀏覽器會以 TypeError 呈現，視為尚未完成認證
    aiAuthState.value = 'required';
    return false;
  }
}

/**
 * 導向同源 /api/auth 觸發 Cloudflare Access 登入認證，完成後自動導回原頁面
 */
function handleStartPaperAuth() {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/api/auth?returnTo=${encodeURIComponent(returnTo)}`);
}

/**
 * 釋放並清空目前拍攝之發票暫存影像 URL（確保 Object URL 記憶體妥善回收）
 */
function releaseCapturedImageUrl() {
  if (capturedObjectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    try {
      URL.revokeObjectURL(capturedObjectUrl);
    } catch {
      // 忽略回收例外
    }
  }
  capturedObjectUrl = '';
  capturedImageUrl.value = '';
}

/**
 * 對已定格之高解析度靜態快照離線執行雙引擎 QR 探測：
 * 1. 若尚無 QR 骨架且拍照當下命中電子發票 QR，自動解析補齊 qrParsedResult。
 * 2. 回傳偵測到之發票 QR 歸一化位置矩形，作為 ReceiptCropper 自動初框的必含錨點。
 */
async function detectQrFromSnapshotCanvas(
  snapshotCanvas: HTMLCanvasElement
): Promise<NormalizedRect | null> {
  const hits: DecodedQrHit[] = [];

  if (barcodeDetector) {
    try {
      const barcodes = await barcodeDetector.detect(snapshotCanvas);
      for (const barcode of barcodes) {
        const text = barcode.rawValue?.trim() || '';
        if (!text) continue;
        hits.push({
          text,
          rect: computeBarcodeNormalizedRect(
            barcode.boundingBox,
            snapshotCanvas.width,
            snapshotCanvas.height
          ),
        });
      }
    } catch {
      // 原生偵測失敗時退回 jsQR
    }
  }

  if (!hits.some((h) => isTaiwanInvoiceQrText(h.text))) {
    const drawn = drawSourceToOffscreenCanvas(
      snapshotCanvas,
      snapshotCanvas.width,
      snapshotCanvas.height
    );
    if (drawn && offscreenCtx) {
      const jsQrHits = decodeWithJsQrHits(offscreenCtx, drawn.width, drawn.height);
      hits.push(...jsQrHits);
    }
  }

  const invoiceHits = hits.filter((h) => isTaiwanInvoiceQrText(h.text));
  if (invoiceHits.length === 0) {
    return null;
  }

  const leftHit = invoiceHits.find((h) => !h.text.startsWith('**'));
  const rightHit = invoiceHits.find((h) => h.text.startsWith('**'));

  let codesUpdated = false;
  if (leftHit && !leftCode.value.trim()) {
    leftCode.value = leftHit.text;
    codesUpdated = true;
  }
  if (rightHit && !rightCode.value.trim()) {
    rightCode.value = rightHit.text;
    codesUpdated = true;
  }

  if (codesUpdated && leftCode.value.trim()) {
    parseCurrentCodes({ quiet: true });
    if (currentDeviceId.value) {
      saveVerifiedCameraId(currentDeviceId.value);
    }
  }

  return mergeNormalizedRects(invoiceHits.map((h) => h.rect));
}

/**
 * 點擊「✨📷 AI 辨識／補充」快門按鈕：
 * 1. 先立即定格高解析度畫面防止認證等待期間手震模糊。
 * 2. 若尚未確認授權，於進裁切前呼叫 GET /api/auth?check=1 檢核。
 * 3. 授權通過後於本機對快照跑一次離線 QR 探測，再帶著錨點與 QR 骨架進入正矩形裁切。
 */
async function handleAiCaptureClick() {
  if (isPreparingAiCapture.value || isAnalyzingPaper.value) return;
  errorMessage.value = '';
  cameraWarning.value = '';
  isAuthExpired.value = false;

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    errorMessage.value = '目前處於離線狀態，AI 辨識需要網路連線（電子發票 QR 仍可離線掃描帶入）。';
    return;
  }

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

  const snapshotCanvas = document.createElement('canvas');
  snapshotCanvas.width = video.videoWidth;
  snapshotCanvas.height = video.videoHeight;
  const snapshotCtx = snapshotCanvas.getContext('2d');
  if (!snapshotCtx) {
    errorMessage.value = '無法擷取相機畫面，請重試。';
    return;
  }

  // 先定格當前影格，避免授權檢查的短暫等待導致手震
  snapshotCtx.drawImage(video, 0, 0, snapshotCanvas.width, snapshotCanvas.height);

  isPreparingAiCapture.value = true;
  try {
    if (aiAuthState.value !== 'authenticated') {
      const authed = await checkAiAuth();
      if (!authed || isDisposed) {
        return;
      }
    }

    // 暫停背景 QR 掃描迴圈，保留既有 qrParsedResult 作為混合辨識骨架
    pauseScanningLoop();

    const detectedAnchor = await detectQrFromSnapshotCanvas(snapshotCanvas);

    let nextImageUrl = '';
    let nextObjectUrl = '';

    if (
      typeof snapshotCanvas.toBlob === 'function' &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function'
    ) {
      const blob = await new Promise<Blob | null>((resolve) => {
        try {
          snapshotCanvas.toBlob((res) => resolve(res), 'image/jpeg', 0.9);
        } catch {
          resolve(null);
        }
      });
      if (blob && blob.size > 0) {
        nextObjectUrl = URL.createObjectURL(blob);
        nextImageUrl = nextObjectUrl;
      }
    }

    if (!nextImageUrl && typeof snapshotCanvas.toDataURL === 'function') {
      nextImageUrl = snapshotCanvas.toDataURL('image/jpeg', 0.9);
    }

    if (isDisposed) {
      if (nextObjectUrl && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(nextObjectUrl);
      }
      return;
    }

    if (!nextImageUrl) {
      errorMessage.value = '無法建立發票預覽影像，請重試。';
      return;
    }

    releaseCapturedImageUrl();
    capturedQrAnchorRect.value = detectedAnchor;
    capturedObjectUrl = nextObjectUrl;
    capturedImageUrl.value = nextImageUrl;
    paperParseMetrics.value = null;
    scannerStep.value = 'crop';
  } finally {
    isPreparingAiCapture.value = false;
  }
}

/**
 * 捨棄目前拍攝畫面並回到相機畫面重拍；若已有離線 QR 結果則一併保留以便重拍或直接帶入
 */
function handlePaperRetake() {
  if (isAnalyzingPaper.value) return;
  releaseCapturedImageUrl();
  capturedQrAnchorRect.value = null;
  paperParseMetrics.value = null;
  errorMessage.value = '';
  isAuthExpired.value = false;
  scannerStep.value = 'camera';

  if (qrParsedResult.value) {
    parsedResult.value = qrParsedResult.value;
    cameraStatus.value =
      '已保留發票 QR 資訊；請將發票上方店名納入畫面後點擊 AI 辨識補充，或直接帶入表單';
  } else {
    parsedResult.value = null;
    isScanPaused.value = false;
    if (isCameraActive.value) {
      isScanning = true;
      scanTickCount = 0;
      cameraStatus.value = '請將發票 QR Code 置於畫面中（約 15～20 公分），或直接點擊下方 AI 辨識';
      scheduleNextScan(SCAN_INTERVAL_MS);
      scheduleBackgroundRefocus();
    }
  }
}

/**
 * 保留已拍攝照片並返回正矩形裁切步驟微調範圍
 */
function handlePaperRecrop() {
  if (isAnalyzingPaper.value || !capturedImageUrl.value) return;
  paperParseMetrics.value = null;
  errorMessage.value = '';
  isAuthExpired.value = false;
  scannerStep.value = 'crop';
}

/**
 * 將正矩形裁切並壓縮後之二進位影像（及選填 QR 骨架）以 FormData 送往同源 Worker API 進行 AI 辨識
 */
async function handlePaperCropConfirm(payload: CroppedImagePayload) {
  if (isAnalyzingPaper.value) return;
  errorMessage.value = '';
  isAuthExpired.value = false;
  paperParseMetrics.value = null;

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    errorMessage.value = '目前處於離線狀態，AI 發票辨識需要網路連線。';
    return;
  }

  const aiSettings = loadAiInvoiceSettings();
  const requestStartMs =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  const formData = new FormData();
  formData.append('image', payload.imageBlob, 'receipt.jpg');
  formData.append('categories', JSON.stringify(props.categories));
  formData.append('model', aiSettings.model);
  formData.append('thinkingLevel', aiSettings.thinkingLevel);
  formData.append('mediaResolution', aiSettings.mediaResolution);
  if (qrParsedResult.value) {
    formData.append('qrContext', JSON.stringify(qrParsedResult.value));
  }

  isAnalyzingPaper.value = true;
  try {
    const response = await fetch('/api/parse-invoice', {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'manual',
      body: formData,
    });

    const responseContentType = response.headers.get('content-type') || '';

    // 若遭遇 Cloudflare Access 未登入或過期，會收到 opaqueredirect、3xx、401/403 或 HTML 登入頁
    if (
      response.type === 'opaqueredirect' ||
      response.redirected ||
      response.status === 401 ||
      response.status === 403 ||
      (response.status >= 300 && response.status < 400) ||
      !responseContentType.toLowerCase().includes('application/json')
    ) {
      aiAuthState.value = 'required';
      isAuthExpired.value = true;
      errorMessage.value =
        '尚未完成 Cloudflare 認證或驗證已過期，請點擊下方按鈕前往認證後再試。';
      return;
    }

    const data = (await response.json()) as {
      result?: ParsedInvoiceResult;
      meta?: {
        model?: string;
        thinkingLevel?: string;
        mediaResolution?: string;
        aiDurationMs?: number;
        workerDurationMs?: number;
        imageBytes?: number;
        inputTokens?: number;
        outputTokens?: number;
        thoughtTokens?: number;
      };
      error?: string;
    };

    if (!response.ok || !data.result) {
      errorMessage.value =
        data.error || `發票辨識失敗（狀態碼 ${response.status}），請確認照片清晰度後重試。`;
      return;
    }

    const requestEndMs =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    const clientTotalMs = Math.max(0, Math.round(requestEndMs - requestStartMs));
    const effectiveBytes = data.meta?.imageBytes ?? payload.sizeBytes ?? payload.imageBlob.size;

    paperParseMetrics.value = {
      model: data.meta?.model || aiSettings.model,
      thinkingLevel: data.meta?.thinkingLevel || aiSettings.thinkingLevel,
      mediaResolution: data.meta?.mediaResolution || aiSettings.mediaResolution,
      clientTotalMs,
      aiDurationMs:
        typeof data.meta?.aiDurationMs === 'number' ? data.meta.aiDurationMs : undefined,
      imageKB: Math.max(1, Math.round(effectiveBytes / 1024)),
      inputTokens: data.meta?.inputTokens,
      outputTokens: data.meta?.outputTokens,
      thoughtTokens: data.meta?.thoughtTokens,
    };

    parsedResult.value = {
      ...data.result,
      source: 'paper',
    };
    scannerStep.value = 'result';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMessage.value = `無法連線至 AI 發票辨識服務 (${msg})，請確認網路連線後重試。`;
  } finally {
    isAnalyzingPaper.value = false;
  }
}

/**
 * 依目前已掃描之左／右 QR Code 內容解析發票資訊，同時寫入權威 qrParsedResult 骨架
 */
function parseCurrentCodes(options?: { quiet?: boolean }) {
  if (!options?.quiet) {
    errorMessage.value = '';
  }
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

    const qrResult: ParsedInvoiceResult = {
      ...result,
      source: 'qr',
    };
    qrParsedResult.value = qrResult;
    parsedResult.value = qrResult;
  } catch (err: unknown) {
    if (!options?.quiet) {
      errorMessage.value =
        err instanceof Error ? err.message : (String(err) || '發票解析失敗，請確認 QR Code 格式');
    }
  }
}

/**
 * 關閉彈窗並安全釋放相機與暫存影像資源
 */
async function handleClose() {
  isDisposed = true;
  releaseCapturedImageUrl();
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
  releaseCapturedImageUrl();
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
  releaseCapturedImageUrl();
  await stopScanner();
});
</script>

<template>
  <div class="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="bg-white rounded-2xl max-w-lg w-full p-5 sm:p-6 shadow-xl max-h-[90vh] flex flex-col overflow-hidden">
      <!-- 標題欄（方案 B+ 單一整合視窗） -->
      <div class="flex items-center justify-between pb-3 border-b border-slate-100">
        <h3 id="modal-title" class="text-lg font-bold text-slate-800">
          發票掃描與 AI 辨識
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

      <!-- 內容區 -->
      <div class="py-3 space-y-3 overflow-y-auto flex-1">
        <!-- 相機預覽容器（預設純離線即時掃描 QR，並提供單顆 AI 辨識快門按鈕） -->
        <div v-show="scannerStep === 'camera'" class="space-y-2.5">
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

          <!-- 左／右雙碼掃描進度與重新掃描按鈕 -->
          <div class="flex items-center justify-between gap-2 text-[11px]">
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

          <!-- AI 辨識／補充快門與按需 Cloudflare 授權區域（點按 AI 按鈕才進行檢查） -->
          <div class="space-y-2 pt-0.5">
            <div
              v-if="aiAuthState === 'checking'"
              class="w-full py-2.5 px-4 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 text-center font-medium"
            >
              正在確認 AI 辨識授權狀態...
            </div>

            <div
              v-else-if="aiAuthState === 'required'"
              data-testid="paper-auth-prompt"
              class="p-3.5 bg-teal-50 border border-teal-200 rounded-xl space-y-2.5 text-center"
            >
              <div class="flex items-center justify-center gap-1.5 text-xs font-bold text-teal-900">
                <ShieldCheck class="w-4 h-4 text-teal-600" />
                <span>啟用 AI 辨識前需先完成 Cloudflare 認證</span>
              </div>
              <p class="text-[11px] text-teal-800/80 leading-relaxed">
                一般記帳與電子發票 QR 掃描皆免登入；認證通過後 1 個月內使用 AI 辨識皆不需重複登入。
              </p>
              <button
                type="button"
                data-testid="paper-auth-btn"
                class="w-full py-2.5 px-4 bg-teal-600 hover:bg-teal-700 active:scale-[0.99] text-white font-bold text-xs rounded-xl shadow-xs transition"
                @click="handleStartPaperAuth"
              >
                前往 Cloudflare 認證
              </button>
            </div>

            <template v-else>
              <button
                type="button"
                data-testid="ai-capture-btn"
                :disabled="!isCameraActive || isPreparingAiCapture || isAnalyzingPaper"
                class="w-full py-2.5 px-4 bg-teal-600 hover:bg-teal-700 active:scale-[0.99] text-white font-bold text-sm rounded-xl shadow-xs transition flex items-center justify-center gap-1.5 disabled:opacity-50"
                @click="handleAiCaptureClick"
              >
                <span>{{ aiButtonLabel }}</span>
              </button>
              <p class="text-[11px] text-slate-400 text-center leading-relaxed">
                {{
                  qrParsedResult
                    ? '可直接點下方「帶入表單」；若要 AI 補店名與分類，請將發票上方店名納入畫面後點擊'
                    : '傳統紙本發票或要識別電子發票店家名稱，請將整張發票納入畫面後點擊（請避開卡號個資）'
                }}
              </p>
            </template>
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

        <!-- 正矩形框選裁切步驟（自動定位初框＋QR 錨點提示） -->
        <ReceiptCropper
          v-if="scannerStep === 'crop' && capturedImageUrl"
          :image-data-url="capturedImageUrl"
          :is-submitting="isAnalyzingPaper"
          :anchor-rect="capturedQrAnchorRect"
          :qr-hint-text="cropperQrHintText"
          @retake="handlePaperRetake"
          @confirm="handlePaperCropConfirm"
        />

        <!-- AI 辨識完成後之快速重拍／重新裁切操作列 -->
        <div
          v-if="scannerStep === 'result'"
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
            @click="handleStartPaperAuth"
          >
            前往 Cloudflare 認證
          </button>
        </div>

        <!-- 解析預覽結果（於相機頁掃到 QR 或 AI 辨識完成時顯示；裁切頁隱藏以留出最大操作空間） -->
        <div v-if="parsedResult && scannerStep !== 'crop'" class="bg-teal-50 border border-teal-200 rounded-xl p-3 space-y-2.5">
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

          <!-- 紙本發票 AI 辨識實測效能摘要列（供對比各模型與參數設定速度） -->
          <div
            v-if="parsedResult.source === 'paper' && formattedPaperMetrics"
            data-testid="paper-parse-metrics"
            class="pt-2 border-t border-teal-200/70 text-[11px] text-teal-800/80 font-mono leading-relaxed break-all"
          >
            {{ formattedPaperMetrics }}
          </div>
        </div>
      </div>

      <!-- 操作按鈕（僅於可帶入表單時顯示，關閉操作統一使用右上角 ✕） -->
      <div
        v-if="parsedResult && scannerStep !== 'crop'"
        class="pt-3 border-t border-slate-100 flex items-center justify-end"
      >
        <button
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
