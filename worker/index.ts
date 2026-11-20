/**
 * @file worker/index.ts
 * @description Sanddollar Cloudflare Worker 後端入口（整合 Static Assets 與紙本發票 AI 辨識 API）
 *
 * 核心職責：
 * 1. 提供同源 POST /api/parse-invoice 端點，接收前端正矩形裁切並壓縮後之紙本發票影像。
 * 2. 透過 Cloudflare Worker Secret (GEMINI_API_KEY) 呼叫最新 @google/genai SDK (gemini-4-hydrogen)，
 *    以 Structured Outputs 回傳符合前端 ParsedInvoiceResult 契約之結構化 JSON。
 * 3. 非 /api/* 路徑委派予 Workers Static Assets 託管 Vue SPA。
 */

import { GoogleGenAI } from '@google/genai';

/** Cloudflare Worker 環境綁定與 Secret 介面 */
interface Env {
  /** Workers Static Assets 靜態資源綁定 */
  ASSETS: Fetcher;
  /** 透過 Cloudflare Worker Secret 注入之 Gemini API 金鑰 */
  GEMINI_API_KEY?: string;
}

/** 前端送入之紙本發票辨識請求酬載 */
interface ParseInvoiceRequestBody {
  /** 不含 data URL 前綴之圖片 Base64 字串 */
  imageBase64?: unknown;
  /** 圖片 MIME 類型（僅支援 image/jpeg, image/png, image/webp） */
  mimeType?: unknown;
  /** 使用者現有之支出分類清單（僅用於品項分類對應，不含店家清單） */
  categories?: unknown;
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

/** 允許之圖片 MIME 類型白名單 */
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** 請求本文最大位元組數（約 3MB JSON） */
const MAX_REQUEST_BYTES = 3 * 1024 * 1024;

/** 單張圖片 Base64 字串長度上限（約對應原始影像 2MB） */
const MAX_BASE64_LENGTH = 2_800_000;

/** 最多接受之支出分類筆數 */
const MAX_CATEGORIES_COUNT = 60;

/** 單一分類名稱最大字元長度 */
const MAX_CATEGORY_NAME_LENGTH = 40;

/** 使用之 Gemini 模型名稱 */
const GEMINI_MODEL = 'gemini-4-hydrogen';

/** 強制模型輸出結構化發票結果之 JSON Schema */
const PAPER_INVOICE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    merchant: {
      type: 'string',
      description: '照片上實際印出的店家或商號名稱文字；若照片未顯示或無法辨識則回傳空字串。不可猜測或杜撰。',
    },
    invoiceNumber: {
      type: 'string',
      description: '統一發票字軌號碼（2碼大寫英文+8碼數字，移除連字號如 AB12345678）；若非發票或無法辨識則回傳空字串。',
    },
    date: {
      type: 'string',
      description: '消費開立日期，格式必須為西元 YYYY-MM-DD（民國年須加1911轉換）；若僅有期別無確切日期或無法辨識則回傳空字串。',
    },
    randomCode: {
      type: 'string',
      description: '4碼數字隨機碼（僅限電子發票證明聯）；傳統紙本發票或無隨機碼則回傳空字串。',
    },
    totalAmount: {
      type: 'number',
      description: '最終實付總計金額（非負數）。',
    },
    items: {
      type: 'array',
      description: '購買商品明細清單（僅含正向商品，不含獨立折扣折抵項）。',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '商品品名' },
          quantity: { type: 'number', description: '購買數量（大於 0，未標示則為 1）' },
          unitPrice: { type: 'number', description: '商品單價（非負數）' },
          subtotal: { type: 'number', description: '品項小計金額（非負數）' },
          category: {
            type: 'string',
            description: '從提供的現有支出分類清單中挑選完全相符的分類名稱；無合適者或清單為空則回傳空字串。',
          },
        },
        required: ['name', 'quantity', 'unitPrice', 'subtotal', 'category'],
      },
    },
    discounts: {
      type: 'array',
      description: '獨立折扣、滿額折抵、點數折抵等負向扣減項目清單。',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '折扣名稱說明；若照片未印出名稱則回傳空字串，不可自行補字。',
          },
          amount: { type: 'number', description: '折抵金額（請輸出大於 0 的正數）' },
          category: {
            type: 'string',
            description: '若該折扣明確對應特定商品分類且存在於提供的分類清單中，填入該分類名稱；否則回傳空字串。',
          },
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
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
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
    let subtotal =
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
 * 建構提供予 Gemini 模型之繁體中文發票解析指令
 */
function buildPromptText(categories: string[]): string {
  const categoryGuide =
    categories.length > 0
      ? `使用者現有支出分類清單：[${categories.map((c) => `"${c}"`).join(', ')}]。請僅從此清單挑選完全一致的分類字串，嚴禁自創清單以外的分類；若無法判斷請填入空字串 ""。`
      : '使用者尚未提供支出分類清單，所有品項與折扣的 category 欄位一律回傳空字串 ""。';

  return [
    '請仔細辨識這張台灣紙本發票或收據照片，並嚴格依照 JSON Schema 輸出辨識結果。',
    '規則如下：',
    '1. 店家名稱 (merchant)：僅提取照片上實際印出的店名或商號文字，不要猜測、不要改寫、看不到就回傳空字串 ""。',
    '2. 開立日期 (date)：請轉換為西元 YYYY-MM-DD（台灣民國年請加 1911，例如 115/11/20 -> 2026-11-20）。若照片只印月份期別（如 115年11-12月）而無確切日期，請回傳空字串 ""。',
    '3. 發票號碼 (invoiceNumber)：若有統一發票號碼（2碼英文+8碼數字）請去掉連字號回傳，如 AB12345678；無則回傳 ""。',
    '4. 購買品項 (items)：列出每個購買商品的品名、數量、單價與小計；若單價與數量未分開標示，數量設為 1、單價等於該項金額。',
    '5. 獨立折扣 (discounts)：若發票含有折扣、滿額折、會員折抵、負數折讓等項目，請拆分至 discounts 陣列，amount 輸出正數；若照片沒寫折扣名稱請保留空字串 ""，切勿自行補上「折扣」字樣。',
    `6. 支出分類對應：${categoryGuide}`,
    '7. 總計金額 (totalAmount)：輸出發票上最終實付總金額（整數）。',
  ].join('\n');
}

/**
 * 處理紙本發票辨識 API 請求 (POST /api/parse-invoice)
 */
async function handleParseInvoice(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: '僅支援 POST 請求' }, 405);
  }

  if (!env.GEMINI_API_KEY) {
    return jsonResponse(
      { error: '伺服器尚未設定 GEMINI_API_KEY，請先於 Cloudflare Worker Secrets 完成設定。' },
      503
    );
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return jsonResponse({ error: '請求格式必須為 application/json' }, 415);
  }

  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader && Number(contentLengthHeader) > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: '上傳影像體積過大，請重新框選較小範圍或重拍。' }, 413);
  }

  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    return jsonResponse({ error: '無法讀取請求內容' }, 400);
  }

  if (rawText.length > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: '上傳影像體積過大，請重新框選較小範圍或重拍。' }, 413);
  }

  let body: ParseInvoiceRequestBody;
  try {
    body = JSON.parse(rawText) as ParseInvoiceRequestBody;
  } catch {
    return jsonResponse({ error: '無效的 JSON 請求格式' }, 400);
  }

  const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.trim() : '';
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';

  if (!imageBase64) {
    return jsonResponse({ error: '缺少發票影像資料' }, 400);
  }

  if (imageBase64.length > MAX_BASE64_LENGTH) {
    return jsonResponse({ error: '裁切後影像仍超過 2MB 上限，請縮小選取範圍後重試。' }, 413);
  }

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return jsonResponse({ error: '不支援的影像格式，僅支援 JPEG、PNG 或 WebP。' }, 400);
  }

  const categories = sanitizeCategories(body.categories);

  try {
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

    const interaction = await ai.interactions.create({
      model: GEMINI_MODEL,
      store: false,
      system_instruction:
        '你是專精台灣傳統紙本統一發票與收據辨識的記帳助理，只根據圖片實際內容輸出嚴格合法的 JSON，絕不杜撰圖片中不存在的資訊。',
      input: [
        { type: 'text', text: buildPromptText(categories) },
        {
          type: 'image',
          data: imageBase64,
          mime_type: mimeType as 'image/jpeg' | 'image/png' | 'image/webp',
        },
      ],
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: PAPER_INVOICE_RESPONSE_SCHEMA,
      },
    });

    const outputText = interaction.output_text?.trim();
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
    return jsonResponse({ result }, 200);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[parse-invoice] Gemini API 呼叫失敗:', detail);
    return jsonResponse(
      { error: '紙本發票辨識服務暫時無法使用，請稍後再試或檢查 API 配額。' },
      502
    );
  }
}

export default {
  /**
   * Cloudflare Worker 主 fetch 進入點
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/parse-invoice') {
      return handleParseInvoice(request, env);
    }

    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ error: '找不到對應的 API 路徑' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
