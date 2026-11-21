/**
 * @file worker/index.ts
 * @description Sanddollar Cloudflare Worker 後端入口（整合 Static Assets 與紙本發票 AI 辨識 API）
 *
 * 核心職責：
 * 1. 提供同源 POST /api/parse-invoice 端點，支援 multipart/form-data 二進位上傳（主力）與 JSON Base64（向下相容）。
 * 2. 以原生 fetch() 直呼 Gemini Interactions REST API（v1beta + Api-Revision: 2026-05-20），移除龐大 SDK 相依以消除冷啟動。
 * 3. 依據前端設定頁選擇（模型、thinking_level、resolution）經白名單與相容性檢核後呼叫模型並回傳結構化 JSON 與效能遙測。
 * 4. 提供 GET /api/auth 檢查／完成 Cloudflare Access 認證；非 /api/* 路徑委派予 Workers Static Assets 託管 Vue SPA。
 * 5. 提供 POST /api/report-bug 端點，驗證錯誤回報請求並透過 GitHub REST API 自動建立 Issue。
 */

/** Cloudflare Worker 環境綁定與 Secret 介面 */
interface Env {
  /** Workers Static Assets 靜態資源綁定 */
  ASSETS: Fetcher;
  /** 透過 Cloudflare Worker Secret 注入之 Gemini API 金鑰 */
  GEMINI_API_KEY?: string;
  /** 透過 Cloudflare Worker Secret 注入之 GitHub Fine-grained PAT（僅需 Issues 讀寫權限） */
  GITHUB_TOKEN?: string;
  /** 目標 GitHub 倉庫擁有者（預設為 benimut） */
  GITHUB_OWNER?: string;
  /** 目標 GitHub 倉庫名稱（預設為 sanddollar） */
  GITHUB_REPO?: string;
}

/** 支援之圖片 MIME 類型白名單 */
type SupportedImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

/** 支援之 Gemini 模型白名單 */
type SupportedModelId =
  | 'gemini-3.6-flash'
  | 'gemini-3.8-flash'
  | 'gemini-3.5-flash-lite'
  | 'gemini-4-hydrogen';

/** 支援之思考層級 */
type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

/** 支援之圖片解析度等級 */
type MediaResolution = 'low' | 'medium' | 'high';

/** 前端以 JSON 送入之紙本發票辨識請求酬載（向下相容保留） */
interface ParseInvoiceJsonBody {
  imageBase64?: unknown;
  mimeType?: unknown;
  categories?: unknown;
  qrContext?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
  mediaResolution?: unknown;
}

/** 前端由電子發票 QR Code 離線預先解出之結構化上下文 */
interface ParsedQrContext {
  invoiceNumber: string;
  date: string;
  randomCode: string;
  totalAmount: number;
  items: NormalizedInvoiceItem[];
}

/** 解析後統一之發票請求輸入結構 */
interface ExtractedInvoiceRequest {
  imageBase64: string;
  mimeType: SupportedImageMimeType;
  imageBytes: number;
  categories: string[];
  qrContext: ParsedQrContext | null;
  model: SupportedModelId;
  thinkingLevel: ThinkingLevel;
  mediaResolution: MediaResolution;
}

/** 回傳予前端之商品明細結構 */
interface NormalizedInvoiceItem {
  name: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  category: string;
}

/** 回傳予前端之折抵項目結構 */
interface NormalizedInvoiceDiscount {
  name: string;
  amount: number;
  category: string;
}

/** 回傳予前端之完整辨識結果結構（對齊前端 ParsedInvoiceResult） */
interface NormalizedPaperInvoiceResult {
  merchant: string;
  invoiceNumber: string;
  date: string;
  randomCode: string;
  totalAmount: number;
  items: NormalizedInvoiceItem[];
  discounts: NormalizedInvoiceDiscount[];
  source: 'paper';
}

/** 回傳予前端之效能與 Token 遙測中繼資料 */
interface ParseInvoiceMeta {
  model: SupportedModelId;
  thinkingLevel: ThinkingLevel;
  mediaResolution: MediaResolution;
  aiDurationMs: number;
  workerDurationMs: number;
  imageBytes: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
}

/** Gemini Interactions REST API 回應內容部分結構 */
interface InteractionContentPart {
  type?: string;
  text?: string;
}

/** Gemini Interactions REST API 回應步驟結構（2026-05-20 修訂） */
interface InteractionStep {
  type?: string;
  content?: InteractionContentPart[];
}

/** Gemini Interactions REST API Token 使用量統計結構 */
interface InteractionUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  total_tokens?: number;
}

/** Gemini Interactions REST API 回應主體 */
interface InteractionApiResponse {
  status?: string;
  steps?: InteractionStep[];
  output_text?: string;
  outputs?: Array<{ type?: string; text?: string }>;
  usage?: InteractionUsage;
  error?: { message?: string; status?: string; code?: number };
}

/** Gemini Interactions REST API 端點 */
const GEMINI_INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/** Gemini Interactions API 修訂版本標頭（啟用新版 steps 與 response_format 結構） */
const GEMINI_API_REVISION = '2026-05-20';

/** 允許之圖片 MIME 類型白名單 */
const ALLOWED_MIME_TYPES = new Set<SupportedImageMimeType>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** 二進位上傳圖片最大位元組數（2MB） */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** JSON 請求本文最大位元組數（約 3MB） */
const MAX_REQUEST_BYTES = 3 * 1024 * 1024;

/** 單張圖片 Base64 字串長度上限（約對應原始影像 2MB） */
const MAX_BASE64_LENGTH = 2_800_000;

/** 最多接受之支出分類筆數 */
const MAX_CATEGORIES_COUNT = 60;

/** 單一分類名稱最大字元長度 */
const MAX_CATEGORY_NAME_LENGTH = 40;

/** 預設模型與圖片解析度 */
const DEFAULT_MODEL: SupportedModelId = 'gemini-3.6-flash';
const DEFAULT_MEDIA_RESOLUTION: MediaResolution = 'medium';

/** 各模型支援之思考層級規則與預設值 */
const MODEL_THINKING_RULES: Record<
  SupportedModelId,
  { allowed: readonly ThinkingLevel[]; defaultLevel: ThinkingLevel }
> = {
  'gemini-3.6-flash': {
    allowed: ['minimal', 'low', 'medium', 'high'],
    defaultLevel: 'minimal',
  },
  'gemini-3.5-flash-lite': {
    allowed: ['minimal', 'low', 'medium', 'high'],
    defaultLevel: 'minimal',
  },
  'gemini-3.8-flash': {
    allowed: ['low', 'medium', 'high'],
    defaultLevel: 'low',
  },
  'gemini-4-hydrogen': {
    allowed: ['low', 'medium', 'high'],
    defaultLevel: 'low',
  },
};

/** 允許之圖片解析度集合 */
const ALLOWED_RESOLUTIONS = new Set<MediaResolution>(['low', 'medium', 'high']);

/** 強制模型輸出結構化發票結果之精簡 JSON Schema */
const PAPER_INVOICE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    merchant: {
      type: 'string',
      description: '照片實際印出之店家名稱；未顯示則回傳空字串。',
    },
    invoiceNumber: {
      type: 'string',
      description: '統一發票號碼（2大寫英文+8數字，去連字號）；無則回傳空字串。',
    },
    date: {
      type: 'string',
      description: '西元開立日期 YYYY-MM-DD；僅有期別無日或無法辨識則回傳空字串。',
    },
    randomCode: {
      type: 'string',
      description: '4碼數字隨機碼；無則回傳空字串。',
    },
    totalAmount: {
      type: 'number',
      description: '最終實付總計整數金額（非負數）。',
    },
    items: {
      type: 'array',
      description: '正向購買商品明細（不含獨立折扣）。',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '商品名稱' },
          quantity: { type: 'number', description: '數量（大於 0）' },
          unitPrice: { type: 'number', description: '單價（非負數）' },
          subtotal: { type: 'number', description: '品項實計小計（非負數）' },
          category: { type: 'string', description: '支出分類名稱或空字串' },
        },
        required: ['name', 'quantity', 'unitPrice', 'subtotal', 'category'],
      },
    },
    discounts: {
      type: 'array',
      description: '獨立折扣、滿額折或點數折抵項目。',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '折扣名稱，未印出則回傳空字串' },
          amount: { type: 'number', description: '折抵正數金額' },
          category: { type: 'string', description: '對應分類名稱或空字串' },
        },
        required: ['name', 'amount', 'category'],
      },
    },
  },
  required: ['merchant', 'invoiceNumber', 'date', 'randomCode', 'totalAmount', 'items', 'discounts'],
};

/**
 * 建構標準 JSON 回應並附上基礎安全與禁快取標頭
 */
function jsonResponse(
  payload: unknown,
  status = 200,
  extraHeaders?: Record<string, string>
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };
  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}

/**
 * 將二進位 ArrayBuffer 分塊轉換為 Base64 字串，避免單次展開大陣列導致呼叫堆疊溢位
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

/**
 * 驗證並正規化 AI 模型、思考層級與圖片解析度設定
 */
function sanitizeAiParams(
  rawModel: unknown,
  rawThinkingLevel: unknown,
  rawMediaResolution: unknown
): {
  model: SupportedModelId;
  thinkingLevel: ThinkingLevel;
  mediaResolution: MediaResolution;
} {
  const modelCandidate = typeof rawModel === 'string' ? rawModel.trim() : '';
  const model: SupportedModelId =
    modelCandidate in MODEL_THINKING_RULES ? (modelCandidate as SupportedModelId) : DEFAULT_MODEL;

  const rule = MODEL_THINKING_RULES[model];
  const thinkingCandidate = typeof rawThinkingLevel === 'string' ? rawThinkingLevel.trim() : '';
  const thinkingLevel: ThinkingLevel = rule.allowed.includes(thinkingCandidate as ThinkingLevel)
    ? (thinkingCandidate as ThinkingLevel)
    : rule.defaultLevel;

  const resolutionCandidate =
    typeof rawMediaResolution === 'string' ? rawMediaResolution.trim() : '';
  const mediaResolution: MediaResolution = ALLOWED_RESOLUTIONS.has(
    resolutionCandidate as MediaResolution
  )
    ? (resolutionCandidate as MediaResolution)
    : DEFAULT_MEDIA_RESOLUTION;

  return { model, thinkingLevel, mediaResolution };
}

/**
 * 驗證並正規化前端傳入之支出分類清單
 */
function sanitizeCategories(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const cleaned = entry.trim().slice(0, MAX_CATEGORY_NAME_LENGTH);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= MAX_CATEGORIES_COUNT) break;
  }

  return result;
}

/**
 * 驗證並正規化前端傳入之電子發票 QR Code 上下文資料
 * 若缺乏有效發票號碼、總金額或品項則回傳 null，視為純紙本模式。
 */
function sanitizeQrContext(raw: unknown): ParsedQrContext | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const invoiceNumber = normalizeInvoiceNumber(obj.invoiceNumber);
  const date = normalizeValidDate(obj.date);
  const randomCode = normalizeRandomCode(obj.randomCode);
  const parsedTotal = Number(obj.totalAmount);
  const totalAmount =
    Number.isFinite(parsedTotal) && parsedTotal > 0 ? Math.round(parsedTotal) : 0;

  const items: NormalizedInvoiceItem[] = [];
  if (Array.isArray(obj.items)) {
    for (const entry of obj.items) {
      if (!entry || typeof entry !== 'object') continue;
      const itemObj = entry as Record<string, unknown>;
      const name = typeof itemObj.name === 'string' ? itemObj.name.trim().slice(0, 80) : '';
      if (!name) continue;

      const parsedQty = Number(itemObj.quantity);
      const quantity = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1;
      const parsedUnitPrice = Number(itemObj.unitPrice);
      const parsedSubtotal = Number(itemObj.subtotal);
      let unitPrice =
        Number.isFinite(parsedUnitPrice) && parsedUnitPrice >= 0 ? parsedUnitPrice : 0;
      const subtotal =
        Number.isFinite(parsedSubtotal) && parsedSubtotal >= 0
          ? Math.round(parsedSubtotal)
          : Math.round(quantity * unitPrice);

      if (unitPrice === 0 && subtotal > 0 && quantity > 0) {
        unitPrice = Math.round((subtotal / quantity) * 100) / 100;
      }

      items.push({
        name,
        quantity,
        unitPrice,
        subtotal,
        category: '',
      });
      if (items.length >= 40) break;
    }
  }

  if (!invoiceNumber && totalAmount <= 0 && items.length === 0) {
    return null;
  }

  return {
    invoiceNumber,
    date,
    randomCode,
    totalAmount,
    items,
  };
}

/**
 * 解析來自 multipart/form-data 或 application/json 的發票辨識請求內容
 */
async function extractParseInvoiceRequest(
  request: Request
): Promise<{ ok: true; data: ExtractedInvoiceRequest } | { ok: false; response: Response }> {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();

  // 路徑 A：multipart/form-data（二進位檔案上傳，省去 Base64 網路膨脹）
  if (contentType.includes('multipart/form-data')) {
    const contentLengthHeader = request.headers.get('content-length');
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_REQUEST_BYTES) {
      return {
        ok: false,
        response: jsonResponse({ error: '上傳影像體積過大，請重新框選較小範圍或重拍。' }, 413),
      };
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return {
        ok: false,
        response: jsonResponse({ error: '無法讀取表單影像資料，請重試。' }, 400),
      };
    }

    const imageEntry = formData.get('image');
    if (
      !imageEntry ||
      typeof imageEntry !== 'object' ||
      typeof (imageEntry as Blob).arrayBuffer !== 'function'
    ) {
      return {
        ok: false,
        response: jsonResponse({ error: '缺少發票影像資料' }, 400),
      };
    }

    const imageBlob = imageEntry as Blob;
    if (imageBlob.size <= 0) {
      return {
        ok: false,
        response: jsonResponse({ error: '缺少發票影像資料' }, 400),
      };
    }

    if (imageBlob.size > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        response: jsonResponse({ error: '裁切後影像仍超過 2MB 上限，請縮小選取範圍後重試。' }, 413),
      };
    }

    const fallbackMime = formData.get('mimeType');
    const rawMime = (
      imageBlob.type || (typeof fallbackMime === 'string' ? fallbackMime : '')
    )
      .trim()
      .toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(rawMime as SupportedImageMimeType)) {
      return {
        ok: false,
        response: jsonResponse({ error: '不支援的影像格式，僅支援 JPEG、PNG 或 WebP。' }, 400),
      };
    }

    let rawCategories: unknown = [];
    const categoriesEntry = formData.get('categories');
    if (typeof categoriesEntry === 'string' && categoriesEntry.trim()) {
      try {
        rawCategories = JSON.parse(categoriesEntry);
      } catch {
        rawCategories = [];
      }
    }

    let rawQrContext: unknown = null;
    const qrContextEntry = formData.get('qrContext');
    if (typeof qrContextEntry === 'string' && qrContextEntry.trim()) {
      try {
        rawQrContext = JSON.parse(qrContextEntry);
      } catch {
        rawQrContext = null;
      }
    }

    const buffer = await imageBlob.arrayBuffer();
    const imageBase64 = arrayBufferToBase64(buffer);
    const { model, thinkingLevel, mediaResolution } = sanitizeAiParams(
      formData.get('model'),
      formData.get('thinkingLevel'),
      formData.get('mediaResolution')
    );

    return {
      ok: true,
      data: {
        imageBase64,
        mimeType: rawMime as SupportedImageMimeType,
        imageBytes: imageBlob.size,
        categories: sanitizeCategories(rawCategories),
        qrContext: sanitizeQrContext(rawQrContext),
        model,
        thinkingLevel,
        mediaResolution,
      },
    };
  }

  // 路徑 B：application/json（向下相容既有測試與呼叫端）
  if (contentType.includes('application/json')) {
    const contentLengthHeader = request.headers.get('content-length');
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_REQUEST_BYTES) {
      return {
        ok: false,
        response: jsonResponse({ error: '上傳影像體積過大，請重新框選較小範圍或重拍。' }, 413),
      };
    }

    let rawText: string;
    try {
      rawText = await request.text();
    } catch {
      return { ok: false, response: jsonResponse({ error: '無法讀取請求內容' }, 400) };
    }

    if (rawText.length > MAX_REQUEST_BYTES) {
      return {
        ok: false,
        response: jsonResponse({ error: '上傳影像體積過大，請重新框選較小範圍或重拍。' }, 413),
      };
    }

    let body: ParseInvoiceJsonBody;
    try {
      body = JSON.parse(rawText) as ParseInvoiceJsonBody;
    } catch {
      return { ok: false, response: jsonResponse({ error: '無效的 JSON 請求格式' }, 400) };
    }

    const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.trim() : '';
    const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';

    if (!imageBase64) {
      return { ok: false, response: jsonResponse({ error: '缺少發票影像資料' }, 400) };
    }

    if (imageBase64.length > MAX_BASE64_LENGTH) {
      return {
        ok: false,
        response: jsonResponse({ error: '裁切後影像仍超過 2MB 上限，請縮小選取範圍後重試。' }, 413),
      };
    }

    if (!ALLOWED_MIME_TYPES.has(mimeType as SupportedImageMimeType)) {
      return {
        ok: false,
        response: jsonResponse({ error: '不支援的影像格式，僅支援 JPEG、PNG 或 WebP。' }, 400),
      };
    }

    const { model, thinkingLevel, mediaResolution } = sanitizeAiParams(
      body.model,
      body.thinkingLevel,
      body.mediaResolution
    );

    return {
      ok: true,
      data: {
        imageBase64,
        mimeType: mimeType as SupportedImageMimeType,
        imageBytes: Math.floor((imageBase64.length * 3) / 4),
        categories: sanitizeCategories(body.categories),
        qrContext: sanitizeQrContext(body.qrContext),
        model,
        thinkingLevel,
        mediaResolution,
      },
    };
  }

  return {
    ok: false,
    response: jsonResponse({ error: '請求格式必須為 multipart/form-data 或 application/json' }, 415),
  };
}

/**
 * 驗證西元 YYYY-MM-DD 日期是否為合法曆法日期
 */
function normalizeValidDate(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return '';

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return '';
  }

  const testDate = new Date(Date.UTC(year, month - 1, day));
  if (
    testDate.getUTCFullYear() !== year ||
    testDate.getUTCMonth() !== month - 1 ||
    testDate.getUTCDate() !== day
  ) {
    return '';
  }

  return trimmed;
}

/**
 * 正規化統一發票號碼（移除連字號與空白並轉大寫）
 */
function normalizeInvoiceNumber(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z]{2}\d{8}$/.test(cleaned) ? cleaned : '';
}

/**
 * 正規化 4 碼隨機碼
 */
function normalizeRandomCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.trim();
  return /^\d{4}$/.test(cleaned) ? cleaned : '';
}

/**
 * 將模型回傳的原始物件做嚴格型別防禦與正規化，確保符合前端契約
 * 當提供 QR Code 精準上下文時，以 QR 的發票號碼、日期、隨機碼與總金額作為權威保底覆寫，杜絕 OCR 數字錯字。
 */
function normalizeModelOutput(
  raw: Record<string, unknown>,
  allowedCategories: string[],
  qrContext?: ParsedQrContext | null
): NormalizedPaperInvoiceResult {
  const categorySet = new Set(allowedCategories);

  const merchant = typeof raw.merchant === 'string' ? raw.merchant.trim() : '';
  const modelInvoiceNumber = normalizeInvoiceNumber(raw.invoiceNumber);
  const modelDate = normalizeValidDate(raw.date);
  const modelRandomCode = normalizeRandomCode(raw.randomCode);

  const invoiceNumber = qrContext?.invoiceNumber || modelInvoiceNumber;
  const date = qrContext?.date || modelDate;
  const randomCode = qrContext?.randomCode || modelRandomCode;

  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const parsedItems: NormalizedInvoiceItem[] = [];

  for (const entry of rawItems) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) continue;

    const parsedQty = Number(obj.quantity);
    const quantity = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1;

    const parsedUnitPrice = Number(obj.unitPrice);
    const parsedSubtotal = Number(obj.subtotal);

    let unitPrice = Number.isFinite(parsedUnitPrice) && parsedUnitPrice >= 0 ? parsedUnitPrice : 0;
    const subtotal =
      Number.isFinite(parsedSubtotal) && parsedSubtotal >= 0
        ? Math.round(parsedSubtotal)
        : Math.round(quantity * unitPrice);

    if (unitPrice === 0 && subtotal > 0 && quantity > 0) {
      unitPrice = Math.round((subtotal / quantity) * 100) / 100;
    }

    const rawCat = typeof obj.category === 'string' ? obj.category.trim() : '';
    const category = categorySet.has(rawCat) ? rawCat : '';

    parsedItems.push({
      name,
      quantity,
      unitPrice,
      subtotal,
      category,
    });
  }

  // 若 QR 原有明確品項而模型未回傳任何明細時，保底沿用 QR 既有品項確保不遺失明細
  const items =
    qrContext && qrContext.items.length > 0 && parsedItems.length === 0
      ? qrContext.items
      : parsedItems;

  const rawDiscounts = Array.isArray(raw.discounts) ? raw.discounts : [];
  const discounts: NormalizedInvoiceDiscount[] = [];

  for (const entry of rawDiscounts) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const rawAmount = Number(obj.amount);
    if (!Number.isFinite(rawAmount)) continue;
    const amount = Math.abs(Math.round(rawAmount));
    if (amount <= 0) continue;

    // 若照片未印折扣名稱，刻意保留空字串交由使用者於表單填寫
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const rawCat = typeof obj.category === 'string' ? obj.category.trim() : '';
    const category = categorySet.has(rawCat) ? rawCat : '';

    discounts.push({
      name,
      amount,
      category,
    });
  }

  const parsedTotal = Number(raw.totalAmount);
  const computedFallbackTotal = Math.max(
    0,
    items.reduce((sum, it) => sum + it.subtotal, 0) -
      discounts.reduce((sum, d) => sum + d.amount, 0)
  );
  const modelTotalAmount =
    Number.isFinite(parsedTotal) && parsedTotal > 0
      ? Math.round(parsedTotal)
      : Math.round(computedFallbackTotal);
  const totalAmount =
    qrContext && qrContext.totalAmount > 0 ? qrContext.totalAmount : modelTotalAmount;

  return {
    merchant,
    invoiceNumber,
    date,
    randomCode,
    totalAmount,
    items,
    discounts,
    source: 'paper',
  };
}

/**
 * 建構提供予 Gemini 模型之精簡繁體中文發票解析指令
 * 若附帶電子發票 QR 上下文，切換為「QR 混合補強指令」由模型專注補出店家名稱、分類與缺漏明細折扣。
 */
function buildPromptText(categories: string[], qrContext?: ParsedQrContext | null): string {
  const categoryGuide =
    categories.length > 0
      ? `支出分類清單：[${categories.map((c) => `"${c}"`).join(', ')}]，僅挑選完全一致字串，無合適則填 ""。`
      : '未提供分類清單，category 欄位一律填 ""。';

  if (qrContext) {
    const qrFacts: string[] = [];
    if (qrContext.invoiceNumber) qrFacts.push(`發票號碼=${qrContext.invoiceNumber}`);
    if (qrContext.date) qrFacts.push(`日期=${qrContext.date}`);
    if (qrContext.randomCode) qrFacts.push(`隨機碼=${qrContext.randomCode}`);
    if (qrContext.totalAmount > 0) qrFacts.push(`總金額=${qrContext.totalAmount}`);

    const qrItemsSummary =
      qrContext.items.length > 0
        ? `QR已解出品項：\n${qrContext.items
            .map((it) => `- ${it.name} × ${it.quantity} (單價 ${it.unitPrice}, 小計 ${it.subtotal})`)
            .join('\n')}`
        : 'QR未含商品明細（純金額碼或明細缺漏）。';

    return [
      '以下提供同一張台灣電子發票的「已離線解出 QR 權威資訊」與實拍照片，請結合兩者嚴格依 JSON Schema 輸出：',
      `已知 QR 欄位：${qrFacts.join('、') || '無'}`,
      qrItemsSummary,
      '規則如下：',
      '1. merchant：從照片上方或標題處辨識實際印出的店家／商號文字（含門市別），勿猜測杜撰，看不到填 ""。',
      '2. invoiceNumber / date / randomCode / totalAmount：一律沿用上方已知 QR 權威數值（無者依圖片補上）。',
      '3. items：若上方 QR 已有完整品項且照片沒有多出未列明細，請保留 QR 既有品項與金額並依分類清單補填 category；若照片下方連印交易明細且 QR 未包含或缺漏，請從照片補齊品項與分類；若 QR 無品項且照片亦無印明細，items 輸出空陣列 [] 勿杜撰。',
      '4. discounts：若照片交易明細有獨立折扣、滿額折或點數折抵，請拆至此處並填正數 amount（無名稱填 ""，勿補字）。',
      `5. category：${categoryGuide}`,
    ].join('\n');
  }

  return [
    '辨識台灣紙本發票或收據照片，嚴格依 JSON Schema 輸出：',
    '1. merchant：僅取照片實際印出店名，勿猜測改寫，看不到填 ""。',
    '2. date：西元 YYYY-MM-DD（民國年+1911，例 115/11/20 -> 2026-11-20）；僅印期別無確切日期填 ""。',
    '3. invoiceNumber：2碼英文+8碼數字（去連字號），無則 ""；randomCode：4碼數字，無則 ""。',
    '4. items：列出正向商品品名、數量、單價、小計；未分開標示時 quantity=1、unitPrice=subtotal。',
    '5. discounts：折扣、滿額折、點數折抵等負向項目拆至此處，amount 填正數；照片無名稱則填 ""，勿補字。',
    `6. category：${categoryGuide}`,
    '7. totalAmount：發票最終實付整數金額。',
  ].join('\n');
}

/**
 * 從 Interactions REST API 回應物件抽取模型文字輸出
 * 嚴格篩選 model_output 步驟，避免把內部 thought 步驟混入結構化 JSON。
 */
function extractInteractionOutputText(payload: InteractionApiResponse): string {
  if (Array.isArray(payload.steps)) {
    const modelChunks: string[] = [];
    for (const step of payload.steps) {
      if (step?.type !== 'model_output' || !Array.isArray(step.content)) continue;
      for (const part of step.content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          modelChunks.push(part.text);
        }
      }
    }
    const joined = modelChunks.join('').trim();
    if (joined) return joined;
  }

  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  if (Array.isArray(payload.outputs)) {
    const legacyChunks = payload.outputs
      .filter((out) => typeof out?.text === 'string')
      .map((out) => out.text as string);
    const joined = legacyChunks.join('').trim();
    if (joined) return joined;
  }

  return '';
}

/**
 * 安全轉換可選 Token 計數為非負整數
 */
function toOptionalTokenCount(val: unknown): number | undefined {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
    return undefined;
  }
  return Math.round(val);
}

/**
 * 安全解析 Gemini API 拋出或回傳之錯誤訊息，擷取狀態碼與摘要（絕不外洩 API Key）
 */
function extractSafeGeminiError(err: unknown): { status?: number; summary: string } {
  if (!err || typeof err !== 'object') {
    return { summary: String(err || '未知錯誤').slice(0, 200) };
  }

  const errObj = err as {
    statusCode?: unknown;
    status?: unknown;
    body?: unknown;
    message?: unknown;
  };

  const status =
    typeof errObj.statusCode === 'number'
      ? errObj.statusCode
      : typeof errObj.status === 'number'
        ? errObj.status
        : undefined;

  let detail = '';

  if (typeof errObj.body === 'string' && errObj.body.trim()) {
    try {
      const rawParsed = JSON.parse(errObj.body) as unknown;
      const parsed = (Array.isArray(rawParsed) ? rawParsed[0] : rawParsed) as {
        error?: { message?: string; status?: string; code?: number };
        message?: string;
      };
      if (parsed?.error?.message) {
        const codePart = parsed.error.status ? `${parsed.error.status}: ` : '';
        detail = `${codePart}${parsed.error.message}`;
      } else if (parsed?.message) {
        detail = parsed.message;
      } else {
        detail = errObj.body.trim();
      }
    } catch {
      detail = errObj.body.trim();
    }
  } else if (errObj.body && typeof errObj.body === 'object') {
    const bodyObj = errObj.body as { error?: { message?: string; status?: string } };
    if (bodyObj.error?.message) {
      detail = bodyObj.error.message;
    }
  }

  if (!detail && typeof errObj.message === 'string') {
    detail = errObj.message;
  }

  // 防禦性過濾：避免任何類似 Google API Key 字樣外洩到前端訊息
  const sanitized = detail.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]').slice(0, 240);
  return { status, summary: sanitized || '未知上游錯誤' };
}

/**
 * 處理紙本發票辨識 API 請求 (POST /api/parse-invoice)
 */
async function handleParseInvoice(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: '僅支援 POST 請求' }, 405);
  }

  const apiKey = typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
  if (!apiKey) {
    return jsonResponse(
      { error: '伺服器尚未設定 GEMINI_API_KEY，請先於 Cloudflare Worker Secrets 完成設定。' },
      503
    );
  }

  const reqStartMs = performance.now();
  const extracted = await extractParseInvoiceRequest(request);
  if (!extracted.ok) {
    return extracted.response;
  }

  const {
    imageBase64,
    mimeType,
    imageBytes,
    categories,
    qrContext,
    model,
    thinkingLevel,
    mediaResolution,
  } = extracted.data;
  const prepDurationMs = Math.max(0, Math.round(performance.now() - reqStartMs));

  try {
    const aiStartMs = performance.now();
    const geminiResponse = await fetch(GEMINI_INTERACTIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Api-Revision': GEMINI_API_REVISION,
      },
      body: JSON.stringify({
        model,
        store: false,
        system_instruction:
          '你是專精台灣發票與收據辨識的記帳助理，只根據圖片與已知權威資訊輸出嚴格合法 JSON，絕不杜撰不存在資訊。',
        generation_config: {
          thinking_level: thinkingLevel,
        },
        input: [
          { type: 'text', text: buildPromptText(categories, qrContext) },
          {
            type: 'image',
            data: imageBase64,
            mime_type: mimeType,
            resolution: mediaResolution,
          },
        ],
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: PAPER_INVOICE_RESPONSE_SCHEMA,
        },
      }),
    });

    if (!geminiResponse.ok) {
      const errBodyText = await geminiResponse.text().catch(() => '');
      const { status, summary } = extractSafeGeminiError({
        statusCode: geminiResponse.status,
        body: errBodyText,
      });
      console.error('[parse-invoice] Gemini API 呼叫失敗:', status ?? 'unknown', summary);
      const statusLabel = status ? `HTTP ${status}` : '呼叫異常';
      return jsonResponse(
        { error: `紙本發票辨識失敗（${statusLabel}）：${summary}` },
        502
      );
    }

    const interaction = (await geminiResponse.json()) as InteractionApiResponse;
    const aiDurationMs = Math.max(0, Math.round(performance.now() - aiStartMs));
    const outputText = extractInteractionOutputText(interaction);

    if (!outputText) {
      return jsonResponse({ error: 'AI 未能回傳有效辨識內容，請確認照片清晰度後重拍。' }, 502);
    }

    let parsedJson: Record<string, unknown>;
    try {
      parsedJson = JSON.parse(outputText) as Record<string, unknown>;
    } catch {
      return jsonResponse({ error: 'AI 回傳格式異常，請重新辨識。' }, 502);
    }

    const result = normalizeModelOutput(parsedJson, categories, qrContext);
    const workerDurationMs = Math.max(0, Math.round(performance.now() - reqStartMs));
    const meta: ParseInvoiceMeta = {
      model,
      thinkingLevel,
      mediaResolution,
      aiDurationMs,
      workerDurationMs,
      imageBytes,
      inputTokens: toOptionalTokenCount(interaction.usage?.total_input_tokens),
      outputTokens: toOptionalTokenCount(interaction.usage?.total_output_tokens),
      thoughtTokens: toOptionalTokenCount(interaction.usage?.total_thought_tokens),
    };

    const serverTiming = `prep;dur=${prepDurationMs}, gemini;dur=${aiDurationMs}, total;dur=${workerDurationMs}`;
    return jsonResponse({ result, meta }, 200, { 'Server-Timing': serverTiming });
  } catch (err: unknown) {
    const { status, summary } = extractSafeGeminiError(err);
    console.error('[parse-invoice] Gemini API 連線異常:', status ?? 'unknown', summary);
    const statusLabel = status ? `HTTP ${status}` : '連線異常';
    return jsonResponse(
      { error: `紙本發票辨識失敗（${statusLabel}）：${summary}` },
      502
    );
  }
}

/**
 * 從 Cloudflare Access 傳入之 Cf-Access-Jwt-Assertion 標頭動態解析帳號 Team Domain (iss)
 * 嚴格檢核網域格式為 https://<team-name>.cloudflareaccess.com，避免寫死網址或 Open Redirect。
 */
function extractAccessTeamDomain(request: Request): string | null {
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!jwt) return null;

  const segments = jwt.split('.');
  if (segments.length < 2 || !segments[1]) return null;

  try {
    const base64 = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { iss?: unknown };
    if (typeof payload.iss !== 'string') return null;

    const candidate = payload.iss.trim().replace(/\/+$/, '');
    if (/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/i.test(candidate)) {
      return candidate.toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 處理 AI 認證檢查、動態登出與登入導回端點 (GET /api/auth)
 * 由於位於受 Cloudflare Access 保護之 /api/* 路徑下：
 * - ?check=1：能到達 Worker 即代表已通過 Access 認證，回傳 200 JSON。
 * - ?logout=1：動態讀取 JWT 之 Team Domain 並清除本站 Cookie，302 導向全域登出後返回站內。
 * - 一般瀏覽器導向：完成 Cloudflare Access 驗證後安全導回站內頁面（預設首頁 /）。
 */
function handleAuthEndpoint(request: Request, url: URL): Response {
  if (request.method !== 'GET') {
    return jsonResponse({ error: '僅支援 GET 請求' }, 405);
  }

  if (url.searchParams.get('check') === '1') {
    return jsonResponse({ authenticated: true }, 200);
  }

  const rawReturnTo = url.searchParams.get('returnTo') || '/';
  // 僅允許站內相對路徑（單一 / 開頭且不為 //），防止 Open Redirect
  const safeReturnTo =
    rawReturnTo.startsWith('/') && !rawReturnTo.startsWith('//') ? rawReturnTo : '/';
  const redirectTarget = new URL(safeReturnTo, url.origin).toString();

  if (url.searchParams.get('logout') === '1') {
    const teamDomain = extractAccessTeamDomain(request);
    const logoutTarget = teamDomain
      ? `${teamDomain}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(redirectTarget)}`
      : redirectTarget;

    const headers = new Headers({
      Location: logoutTarget,
      'Cache-Control': 'no-store',
    });
    // 立即刪除本站之 Access App Cookie（不影響瀏覽器 IndexedDB 本機記帳資料）
    headers.append(
      'Set-Cookie',
      'CF_Authorization=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax'
    );
    headers.append(
      'Set-Cookie',
      'CF_AppSession=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax'
    );

    return new Response(null, {
      status: 302,
      headers,
    });
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectTarget,
      'Cache-Control': 'no-store',
    },
  });
}

// ==================== 錯誤回報自動建立 GitHub Issue ====================

/** 錯誤回報請求本文最大位元組數（16 KB，防範無界請求緩衝耗盡記憶體） */
const MAX_BUG_REPORT_BYTES = 16 * 1024;
/** 錯誤回報標題最大字元數 */
const MAX_BUG_TITLE_LENGTH = 120;
/** 錯誤回報詳細說明最大字元數 */
const MAX_BUG_DESCRIPTION_LENGTH = 4000;
/** GitHub REST API 版本標頭 */
const GITHUB_API_VERSION = '2022-11-28';

/** 支援之錯誤回報問題類型白名單 */
type BugReportCategory = 'bug' | 'ui' | 'ai-invoice' | 'enhancement';

/** 各問題類型對應之 Issue 標題前綴與 GitHub Labels */
const BUG_REPORT_CATEGORY_CONFIG: Record<
  BugReportCategory,
  { prefix: string; labels: readonly string[] }
> = {
  bug: { prefix: '功能異常', labels: ['bug', 'user-report'] },
  ui: { prefix: '畫面顯示', labels: ['bug', 'ui', 'user-report'] },
  'ai-invoice': { prefix: 'AI 發票辨識', labels: ['bug', 'ai-invoice', 'user-report'] },
  enhancement: { prefix: '功能建議', labels: ['enhancement', 'user-report'] },
};

/** 清洗後之可選環境診斷資訊結構 */
interface SanitizedBugDiagnostics {
  appVersion?: string;
  reportedAt?: string;
  userAgent?: string;
  viewport?: string;
  displayMode?: string;
  language?: string;
  aiSettings?: string;
}

/** 驗證後之錯誤回報請求內容 */
interface ExtractedBugReportRequest {
  category: BugReportCategory;
  title: string;
  description: string;
  diagnostics: SanitizedBugDiagnostics | null;
}

/**
 * 將字串清洗為單行文字：移除換行與控制字元並依上限截斷
 */
function sanitizeSingleLine(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLen);
}

/**
 * 清洗來自前端之裝置與環境診斷資訊（白名單過濾與欄位截斷）
 */
function sanitizeDiagnostics(raw: unknown): SanitizedBugDiagnostics | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const cleaned: SanitizedBugDiagnostics = {};

  const appVersion = sanitizeSingleLine(obj.appVersion, 40);
  if (appVersion) cleaned.appVersion = appVersion;

  const reportedAt = sanitizeSingleLine(obj.reportedAt, 64);
  if (reportedAt) cleaned.reportedAt = reportedAt;

  const userAgent = sanitizeSingleLine(obj.userAgent, 300);
  if (userAgent) cleaned.userAgent = userAgent;

  const viewport = sanitizeSingleLine(obj.viewport, 60);
  if (viewport) cleaned.viewport = viewport;

  const displayMode = sanitizeSingleLine(obj.displayMode, 40);
  if (displayMode) cleaned.displayMode = displayMode;

  const language = sanitizeSingleLine(obj.language, 32);
  if (language) cleaned.language = language;

  const aiSettings = sanitizeSingleLine(obj.aiSettings, 160);
  if (aiSettings) cleaned.aiSettings = aiSettings;

  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

/**
 * 解析並嚴格驗證 POST /api/report-bug 的 JSON 請求內容
 */
async function extractBugReportRequest(
  request: Request
): Promise<{ ok: true; data: ExtractedBugReportRequest } | { ok: false; response: Response }> {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return {
      ok: false,
      response: jsonResponse({ error: '請求格式必須為 application/json' }, 415),
    };
  }

  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader && Number(contentLengthHeader) > MAX_BUG_REPORT_BYTES) {
    return {
      ok: false,
      response: jsonResponse({ error: '回報內容過大（上限 16 KB），請精簡說明後重試。' }, 413),
    };
  }

  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    return { ok: false, response: jsonResponse({ error: '無法讀取請求內容' }, 400) };
  }

  const actualBytes = new TextEncoder().encode(rawText).byteLength;
  if (actualBytes > MAX_BUG_REPORT_BYTES) {
    return {
      ok: false,
      response: jsonResponse({ error: '回報內容過大（上限 16 KB），請精簡說明後重試。' }, 413),
    };
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawText);
  } catch {
    return { ok: false, response: jsonResponse({ error: '無效的 JSON 請求格式' }, 400) };
  }

  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return { ok: false, response: jsonResponse({ error: '無效的回報請求資料' }, 400) };
  }

  const body = parsedBody as Record<string, unknown>;
  const categoryRaw = typeof body.category === 'string' ? body.category.trim() : '';
  if (!(categoryRaw in BUG_REPORT_CATEGORY_CONFIG)) {
    return { ok: false, response: jsonResponse({ error: '請選擇有效的問題類型' }, 400) };
  }
  const category = categoryRaw as BugReportCategory;

  // 標題強制轉為單行並檢查去除空白後不可為空
  const title = sanitizeSingleLine(body.title, MAX_BUG_TITLE_LENGTH);
  if (!title) {
    return { ok: false, response: jsonResponse({ error: '請填寫問題標題' }, 400) };
  }

  // 詳細說明保留換行結構，但移除除 \n/\t 外的控制字元
  const rawDescription = typeof body.description === 'string' ? body.description : '';
  const description = rawDescription
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_BUG_DESCRIPTION_LENGTH);

  if (!description) {
    return {
      ok: false,
      response: jsonResponse({ error: '請填寫詳細說明或重現步驟' }, 400),
    };
  }

  return {
    ok: true,
    data: {
      category,
      title,
      description,
      diagnostics: sanitizeDiagnostics(body.diagnostics),
    },
  };
}

/**
 * 跳脫 Markdown 表格儲存格內的管線符號、反引號與換行，避免破壞表格版面
 */
function escapeMarkdownCell(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').replace(/`/g, '\\`');
}

/**
 * 組裝送往 GitHub Issues REST API 的繁體中文 Markdown 內文
 */
function buildGitHubIssueBody(data: ExtractedBugReportRequest): string {
  const categoryLabel = BUG_REPORT_CATEGORY_CONFIG[data.category].prefix;
  const sections: string[] = [
    '## 問題分類',
    categoryLabel,
    '',
    '## 詳細說明與重現步驟',
    data.description,
  ];

  if (data.diagnostics) {
    const diagRows: Array<[string, string | undefined]> = [
      ['App 版本', data.diagnostics.appVersion],
      ['回報時間', data.diagnostics.reportedAt],
      ['PWA 顯示模式', data.diagnostics.displayMode],
      ['螢幕／視窗尺寸', data.diagnostics.viewport],
      ['系統語系', data.diagnostics.language],
      ['AI 發票設定', data.diagnostics.aiSettings],
      ['瀏覽器 User-Agent', data.diagnostics.userAgent],
    ];

    const populatedRows = diagRows.filter(([, val]) => Boolean(val));
    if (populatedRows.length > 0) {
      sections.push('', '## 裝置與環境診斷資訊', '| 項目 | 數值 |', '| :--- | :--- |');
      for (const [label, val] of populatedRows) {
        sections.push(`| ${label} | ${escapeMarkdownCell(val as string)} |`);
      }
    }
  }

  sections.push('', '---', '*由 Sand Dollar 設定頁錯誤回報表單自動建立*');
  return sections.join('\n');
}

/**
 * 安全解析 GitHub API 錯誤訊息，並遮罩任何潛在 Token 格式以防洩漏
 */
function extractSafeGitHubError(
  status: number | undefined,
  bodyText: string
): { status?: number; summary: string } {
  let detail = '';

  if (bodyText.trim()) {
    try {
      const parsed = JSON.parse(bodyText) as {
        message?: unknown;
        errors?: Array<{ message?: unknown; code?: unknown; field?: unknown }>;
      };
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        detail = parsed.message.trim();
      }
      if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        const firstErr = parsed.errors[0];
        const errPart =
          typeof firstErr?.message === 'string'
            ? firstErr.message
            : typeof firstErr?.code === 'string'
              ? `${firstErr.field ? `${String(firstErr.field)}: ` : ''}${firstErr.code}`
              : '';
        if (errPart) {
          detail = detail ? `${detail} (${errPart})` : errPart;
        }
      }
    } catch {
      detail = bodyText.trim();
    }
  }

  // 防禦性遮罩 GitHub Token 字樣（Classic PAT 與 Fine-grained PAT）
  const sanitized = detail
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[REDACTED]')
    .slice(0, 240);

  return { status, summary: sanitized || 'GitHub API 回應異常' };
}

/**
 * 處理錯誤回報並自動建立 GitHub Issue (POST /api/report-bug)
 */
async function handleReportBug(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: '僅支援 POST 請求' }, 405);
  }

  const githubToken = typeof env.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN.trim() : '';
  if (!githubToken) {
    return jsonResponse(
      { error: '伺服器尚未設定 GITHUB_TOKEN，請先於 Cloudflare Worker Secrets 完成設定。' },
      503
    );
  }

  const owner = (typeof env.GITHUB_OWNER === 'string' ? env.GITHUB_OWNER.trim() : '') || 'benimut';
  const repo = (typeof env.GITHUB_REPO === 'string' ? env.GITHUB_REPO.trim() : '') || 'sanddollar';
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    console.error(JSON.stringify({ event: 'report-bug-invalid-repo-config', owner, repo }));
    return jsonResponse({ error: '伺服器 GitHub 倉庫設定格式錯誤，請檢查環境變數。' }, 500);
  }

  const extracted = await extractBugReportRequest(request);
  if (!extracted.ok) {
    return extracted.response;
  }

  const config = BUG_REPORT_CATEGORY_CONFIG[extracted.data.category];
  const issueTitle = `[${config.prefix}] ${extracted.data.title}`;
  const issueBody = buildGitHubIssueBody(extracted.data);
  const endpoint = `https://api.github.com/repos/${owner}/${repo}/issues`;

  const requestHeaders = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${githubToken}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'sanddollar-worker',
    'Content-Type': 'application/json; charset=utf-8',
  };

  try {
    let githubResponse = await fetch(endpoint, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({
        title: issueTitle,
        body: issueBody,
        labels: config.labels,
      }),
    });

    // 若因標籤權限或欄位驗證被拒（422），降級不帶 labels 重試一次以確保回報不遺失
    if (githubResponse.status === 422) {
      const firstErrText = await githubResponse.text().catch(() => '');
      if (/label/i.test(firstErrText)) {
        githubResponse = await fetch(endpoint, {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify({
            title: issueTitle,
            body: issueBody,
          }),
        });
      } else {
        const { status, summary } = extractSafeGitHubError(githubResponse.status, firstErrText);
        console.error(JSON.stringify({ event: 'report-bug-failed', status, summary }));
        return jsonResponse({ error: `無法建立 GitHub Issue（HTTP 422）：${summary}` }, 502);
      }
    }

    if (!githubResponse.ok) {
      const errText = await githubResponse.text().catch(() => '');
      const { status, summary } = extractSafeGitHubError(githubResponse.status, errText);
      console.error(JSON.stringify({ event: 'report-bug-failed', status, summary }));
      return jsonResponse(
        { error: `無法建立 GitHub Issue（HTTP ${githubResponse.status}）：${summary}` },
        502
      );
    }

    const created = (await githubResponse.json()) as { number?: unknown };
    if (typeof created.number !== 'number' || !Number.isFinite(created.number)) {
      console.error(JSON.stringify({ event: 'report-bug-invalid-response' }));
      return jsonResponse({ error: 'GitHub API 回傳格式異常，請稍後再試。' }, 502);
    }

    // 依需求僅回傳追蹤編號，不暴露外部 GitHub Issue URL
    return jsonResponse({ issueNumber: created.number }, 201);
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err || '連線異常');
    const { summary } = extractSafeGitHubError(undefined, rawMsg);
    console.error(JSON.stringify({ event: 'report-bug-network-error', summary }));
    return jsonResponse({ error: `建立錯誤回報連線異常：${summary}` }, 502);
  }
}

export default {
  /**
   * Cloudflare Worker 主 fetch 進入點
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/auth') {
      return handleAuthEndpoint(request, url);
    }

    if (url.pathname === '/api/parse-invoice') {
      return handleParseInvoice(request, env);
    }

    if (url.pathname === '/api/report-bug') {
      return handleReportBug(request, env);
    }

    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ error: '找不到對應的 API 路徑' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
