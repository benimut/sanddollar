/**
 * @file worker/index.ts
 * @description Sanddollar Cloudflare Worker 後端入口（整合 Static Assets 與紙本發票 AI 辨識 API）
 *
 * 核心職責：
 * 1. 提供同源 POST /api/parse-invoice 端點，支援 multipart/form-data 二進位上傳（主力）與 JSON Base64（向下相容）。
 * 2. 以原生 fetch() 直呼 Gemini Interactions REST API（v1beta + Api-Revision: 2026-05-20），移除龐大 SDK 相依以消除冷啟動。
 * 3. 依據前端設定頁選擇（模型、thinking_level、resolution）經白名單與相容性檢核後呼叫模型並回傳結構化 JSON 與效能遙測。
 * 4. 提供 GET /api/auth 檢查／完成 Cloudflare Access 認證；非 /api/* 路徑委派予 Workers Static Assets 託管 Vue SPA。
 */

/** Cloudflare Worker 環境綁定與 Secret 介面 */
interface Env {
  /** Workers Static Assets 靜態資源綁定 */
  ASSETS: Fetcher;
  /** 透過 Cloudflare Worker Secret 注入之 Gemini API 金鑰 */
  GEMINI_API_KEY?: string;
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
  model?: unknown;
  thinkingLevel?: unknown;
  mediaResolution?: unknown;
}

/** 解析後統一之發票請求輸入結構 */
interface ExtractedInvoiceRequest {
  imageBase64: string;
  mimeType: SupportedImageMimeType;
  imageBytes: number;
  categories: string[];
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
 */
function normalizeModelOutput(
  raw: Record<string, unknown>,
  allowedCategories: string[]
): NormalizedPaperInvoiceResult {
  const categorySet = new Set(allowedCategories);

  const merchant = typeof raw.merchant === 'string' ? raw.merchant.trim() : '';
  const invoiceNumber = normalizeInvoiceNumber(raw.invoiceNumber);
  const date = normalizeValidDate(raw.date);
  const randomCode = normalizeRandomCode(raw.randomCode);

  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const items: NormalizedInvoiceItem[] = [];

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

    items.push({
      name,
      quantity,
      unitPrice,
      subtotal,
      category,
    });
  }

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
  const totalAmount =
    Number.isFinite(parsedTotal) && parsedTotal > 0
      ? Math.round(parsedTotal)
      : Math.round(computedFallbackTotal);

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
 */
function buildPromptText(categories: string[]): string {
  const categoryGuide =
    categories.length > 0
      ? `支出分類清單：[${categories.map((c) => `"${c}"`).join(', ')}]，僅挑選完全一致字串，無合適則填 ""。`
      : '未提供分類清單，category 欄位一律填 ""。';

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
          '你是專精台灣紙本發票與收據辨識的記帳助理，只根據圖片實際內容輸出嚴格合法 JSON，絕不杜撰不存在資訊。',
        generation_config: {
          thinking_level: thinkingLevel,
        },
        input: [
          { type: 'text', text: buildPromptText(categories) },
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

    const result = normalizeModelOutput(parsedJson, categories);
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
 * 處理 AI 認證檢查與登入導回端點 (GET /api/auth)
 * 由於位於受 Cloudflare Access 保護之 /api/* 路徑下：
 * - ?check=1：能到達 Worker 即代表已通過 Access 認證，回傳 200 JSON。
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

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectTarget,
      'Cache-Control': 'no-store',
    },
  });
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

    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ error: '找不到對應的 API 路徑' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
