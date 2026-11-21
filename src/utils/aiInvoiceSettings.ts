/**
 * @file aiInvoiceSettings.ts
 * @description 紙本發票 AI 辨識參數（模型、思考層級、圖片解析度）管理與本機持久化工具模組
 *
 * 核心職責：
 * 1. 定義目前支援的 Gemini 模型清單及各模型對應合法的 thinking_level 範圍。
 * 2. 提供設定值正規化邏輯（normalizeAiInvoiceSettings），切換模型時自動確保思考層級合法。
 * 3. 提供安全的 localStorage 讀寫介面，供設定頁面與發票掃描模組共用。
 */

/** 支援之紙本發票辨識 Gemini 模型代碼 */
export type AiInvoiceModelId =
  | 'gemini-3.6-flash'
  | 'gemini-3.8-flash'
  | 'gemini-3.5-flash-lite'
  | 'gemini-4-hydrogen';

/** 支援之思考層級（對應 Interactions API generation_config.thinking_level） */
export type AiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

/** 支援之圖片輸入解析度（對應 Interactions API ImageContent.resolution） */
export type AiMediaResolution = 'low' | 'medium' | 'high';

/** 紙本發票 AI 辨識設定結構 */
export interface AiInvoiceSettings {
  /** 選用之 Gemini 模型代碼 */
  model: AiInvoiceModelId;
  /** 模型內部思考推理層級 */
  thinkingLevel: AiThinkingLevel;
  /** 圖片輸入視覺 Token 解析度等級 */
  mediaResolution: AiMediaResolution;
}

/** 單一模型選項描述介面 */
export interface AiInvoiceModelOption {
  /** 模型 API 代碼 */
  id: AiInvoiceModelId;
  /** 使用者介面顯示名稱 */
  label: string;
  /** 模型特性簡述 */
  description: string;
  /** 該模型官方支援之合法思考層級清單 */
  supportedThinkingLevels: readonly AiThinkingLevel[];
  /** 該模型建議預設思考層級 */
  defaultThinkingLevel: AiThinkingLevel;
}

/** 思考層級選項描述介面 */
export interface AiThinkingLevelOption {
  value: AiThinkingLevel;
  label: string;
  description: string;
}

/** 圖片解析度選項描述介面 */
export interface AiMediaResolutionOption {
  value: AiMediaResolution;
  label: string;
  description: string;
}

/** 儲存紙本發票 AI 設定之 localStorage 鍵名 */
export const AI_INVOICE_SETTINGS_STORAGE_KEY = 'sanddollar_ai_invoice_settings';

/** 支援的 Gemini 模型與合法思考層級對照清單 */
export const AI_INVOICE_MODELS: readonly AiInvoiceModelOption[] = [
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash（推薦平衡）',
    description: '支援極簡思考，兼顧辨識速度與中文明細準確率，免費層配額穩定',
    supportedThinkingLevels: ['minimal', 'low', 'medium', 'high'],
    defaultThinkingLevel: 'minimal',
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite（極速輕量）',
    description: '高吞吐量結構化抽取最速模型，適合快速辨識清晰發票',
    supportedThinkingLevels: ['minimal', 'low', 'medium', 'high'],
    defaultThinkingLevel: 'minimal',
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash（高精度）',
    description: '較高推理能力與版面理解度；不支援 minimal，最低為 low',
    supportedThinkingLevels: ['low', 'medium', 'high'],
    defaultThinkingLevel: 'low',
  },
  {
    id: 'gemini-4-hydrogen',
    label: 'Gemini 4 Hydrogen（新一代模型）',
    description: '預設思考較深、回應較久，適合極複雜版面發票對比實測',
    supportedThinkingLevels: ['low', 'medium', 'high'],
    defaultThinkingLevel: 'low',
  },
] as const;

/** 思考層級下拉選項定義 */
export const AI_THINKING_LEVEL_OPTIONS: readonly AiThinkingLevelOption[] = [
  {
    value: 'minimal',
    label: 'minimal（極簡，最快）',
    description: '幾乎不產生額外內部推理，大幅縮短等待時間',
  },
  {
    value: 'low',
    label: 'low（低度思考）',
    description: '輕量推理，適合長清單折扣核對或 gemini-3.8 / 4 模型最低設定',
  },
  {
    value: 'medium',
    label: 'medium（中度思考）',
    description: '多模型預設平衡點，等待時間明顯較長',
  },
  {
    value: 'high',
    label: 'high（高度思考，最慢）',
    description: '最深度的推理檢查，僅建議於模糊或極難辨識發票時使用',
  },
] as const;

/** 圖片解析度下拉選項定義 */
export const AI_MEDIA_RESOLUTION_OPTIONS: readonly AiMediaResolutionOption[] = [
  {
    value: 'low',
    label: 'low（280 tokens，最快）',
    description: '視覺輸入最少、延遲最低，適合字體較大且單純的收據',
  },
  {
    value: 'medium',
    label: 'medium（560 tokens，推薦平衡）',
    description: '視覺 token 砍半且多數發票細字已達準確率飽和',
  },
  {
    value: 'high',
    label: 'high（1,120 tokens，高細節）',
    description: '保留最多微小字元細節，適合長清單或反光皺摺熱感紙',
  },
] as const;

/** 預設紙本發票 AI 辨識設定 */
export const DEFAULT_AI_INVOICE_SETTINGS: AiInvoiceSettings = {
  model: 'gemini-3.6-flash',
  thinkingLevel: 'minimal',
  mediaResolution: 'medium',
};

const VALID_MODEL_MAP = new Map<string, AiInvoiceModelOption>(
  AI_INVOICE_MODELS.map((item) => [item.id, item])
);

const VALID_RESOLUTIONS = new Set<AiMediaResolution>(['low', 'medium', 'high']);

/**
 * 取得指定模型官方支援的思考層級清單
 *
 * @param model - Gemini 模型代碼
 * @returns 合法的思考層級陣列
 */
export function getSupportedThinkingLevels(model: AiInvoiceModelId): AiThinkingLevel[] {
  const matched = VALID_MODEL_MAP.get(model);
  return matched ? [...matched.supportedThinkingLevels] : ['minimal', 'low', 'medium', 'high'];
}

/**
 * 驗證並正規化 AI 辨識設定
 * 若模型無效則回退預設模型；若思考層級不被該模型支援，自動切換至該模型的預設合法層級。
 *
 * @param raw - 原始或局部設定物件
 * @returns 保證完全合法且彼此相容的設定物件
 */
export function normalizeAiInvoiceSettings(
  raw?: Partial<AiInvoiceSettings> | null
): AiInvoiceSettings {
  const modelKey = typeof raw?.model === 'string' ? raw.model.trim() : '';
  const modelOption =
    VALID_MODEL_MAP.get(modelKey) || VALID_MODEL_MAP.get(DEFAULT_AI_INVOICE_SETTINGS.model)!;

  const rawThinking = typeof raw?.thinkingLevel === 'string' ? raw.thinkingLevel.trim() : '';
  const thinkingLevel = modelOption.supportedThinkingLevels.includes(rawThinking as AiThinkingLevel)
    ? (rawThinking as AiThinkingLevel)
    : modelOption.defaultThinkingLevel;

  const rawResolution = typeof raw?.mediaResolution === 'string' ? raw.mediaResolution.trim() : '';
  const mediaResolution = VALID_RESOLUTIONS.has(rawResolution as AiMediaResolution)
    ? (rawResolution as AiMediaResolution)
    : DEFAULT_AI_INVOICE_SETTINGS.mediaResolution;

  return {
    model: modelOption.id,
    thinkingLevel,
    mediaResolution,
  };
}

/**
 * 從 localStorage 安全讀取並正規化紙本發票 AI 設定
 * 若無痕模式、尚未設定或內容損毀，安全回傳 DEFAULT_AI_INVOICE_SETTINGS。
 *
 * @returns 正規化後的 AI 辨識設定
 */
export function loadAiInvoiceSettings(): AiInvoiceSettings {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return { ...DEFAULT_AI_INVOICE_SETTINGS };
    }
    const rawText = window.localStorage.getItem(AI_INVOICE_SETTINGS_STORAGE_KEY);
    if (!rawText) {
      return { ...DEFAULT_AI_INVOICE_SETTINGS };
    }
    const parsed = JSON.parse(rawText) as Partial<AiInvoiceSettings> | null;
    return normalizeAiInvoiceSettings(parsed);
  } catch {
    return { ...DEFAULT_AI_INVOICE_SETTINGS };
  }
}

/**
 * 正規化並寫入紙本發票 AI 設定至 localStorage
 *
 * @param settings - 欲儲存的設定物件
 * @returns 實際正規化並儲存的設定物件
 */
export function saveAiInvoiceSettings(settings: Partial<AiInvoiceSettings>): AiInvoiceSettings {
  const normalized = normalizeAiInvoiceSettings(settings);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(AI_INVOICE_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    }
  } catch {
    // 無痕模式或儲存受限時安全略過
  }
  return normalized;
}
