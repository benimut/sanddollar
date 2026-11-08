/**
 * @file index.ts
 * @description Sanddollar 系統全域核心資料模型與介面定義
 * 定義 IndexedDB 各資料表（支出表記錄、收入表記錄、回饋記錄、分類記錄）以及運算與摘要的型別契約。
 */

/**
 * 消費明細品項介面
 * 包含一般商品明細與獨立折扣折抵項目
 */
export interface ExpenseItem {
  /** 品項唯一識別碼 (UUID 或隨機識別字串) */
  id: string;
  /** 品項類型：'item' 為一般商品項目，'discount' 為折扣折抵項目 (subtotal 應為負數或扣減值) */
  type: 'item' | 'discount';
  /** 品項名稱 (如：拿鐵咖啡、滿額折扣) */
  name: string;
  /** 購買數量 (通常為大於等於 1 的整數) */
  quantity: number;
  /** 單價 (新台幣金額) */
  unitPrice: number;
  /** 品項小計金額 (新台幣金額；一般品項為單價乘數量，折扣品項為負數) */
  subtotal: number;
  /** 所屬支出分類名稱 (如：餐飲、交通、生活) */
  category: string;
}

/**
 * 消費支出表記錄介面 (IndexedDB expenses 表資料結構)
 * 記錄單筆消費支出交易之完整細節，包含國內與海外交易、發票資訊及明細品項
 */
export interface ExpenseRecord {
  /** 本地資料庫主鍵，自動遞增識別碼 (選填，新增時由 IndexedDB 自動產生) */
  id?: number;
  /** 消費日期 (格式：YYYY-MM-DD) */
  date: string;
  /** 消費店家或商戶名稱 (例如：全家便利商店、星巴克) */
  merchant: string;
  /** 支付管道或方式 (例如：現金、信用卡、LINE Pay、街口支付) */
  paymentMethod: string;
  /** 台幣最終扣款總額 (含海外手續費外加與各項折扣後之實際支付金額) */
  totalAmount: number;
  /** 是否為海外外幣消費交易標記 */
  isForeign: boolean;
  /** 外幣幣別代碼 (例如：USD, JPY, EUR；僅海外消費時有效) */
  currency?: string;
  /** 外幣原始交易金額 (僅海外消費時有效) */
  foreignAmount?: number;
  /** 台幣扣款淨額 (未含手續費之換算台幣金額；僅海外消費時有效) */
  netTwdAmount?: number;
  /** 海外交易手續費金額 (新台幣；預設以 1.5% 計算並四捨五入) */
  fee?: number;
  /** 實質換算匯率 (以台幣最終總額除以外幣金額得出之每 1 外幣實質代價) */
  exchangeRate?: number;
  /** 電子發票字軌號碼 (例如：AB-12345678) */
  invoiceNumber?: string;
  /** 電子發票隨機碼 (4 位數字) */
  invoiceRandomCode?: string;
  /** 購買商品與折扣明細清單陣列 */
  items: ExpenseItem[];
  /** 使用者自訂備註說明 */
  note?: string;
  /** 記錄建立時間戳記 (毫秒 Epoch 時間) */
  createdAt: number;
  /** 記錄最後更新時間戳記 (毫秒 Epoch 時間) */
  updatedAt: number;
}

/**
 * 收入表記錄介面 (IndexedDB incomes 表資料結構)
 * 記錄各類收入來源、入帳帳戶與到帳金額，支援外幣收入與手續費內扣換算
 */
export interface IncomeRecord {
  /** 本地資料庫主鍵，自動遞增識別碼 (選填，新增時由 IndexedDB 自動產生) */
  id?: number;
  /** 收入入帳日期 (格式：YYYY-MM-DD) */
  date: string;
  /** 收入來源名稱 (例如：「11月薪水」、「專案外包」、「小明轉帳」) */
  source: string;
  /** 收入分類名稱 (例如：薪資、轉帳、獎金、兼職、投資、其他) */
  category: string;
  /** 最終實收到帳之台幣金額 (已扣除手續費) */
  amount: number;
  /** 是否為海外外幣收入交易標記 */
  isForeign: boolean;
  /** 外幣幣別代碼 (例如：USD, EUR；僅外幣收入時有效) */
  currency?: string;
  /** 外幣原始收入金額 (僅外幣收入時有效) */
  foreignAmount?: number;
  /** 海外收款手續費金額 (新台幣；預設為 0) */
  fee?: number;
  /** 實質換算匯率 (以實收到帳台幣金額除以外幣金額得出之每 1 外幣實質價值) */
  exchangeRate?: number;
  /** 使用者自訂備註說明 */
  note?: string;
  /** 記錄建立時間戳記 (毫秒 Epoch 時間) */
  createdAt: number;
  /** 記錄最後更新時間戳記 (毫秒 Epoch 時間) */
  updatedAt: number;
}

/**
 * 每月回饋表記錄介面 (IndexedDB rewards 表資料結構)
 * 記錄信用卡回饋、行動支付點數等非固定月份之進帳回饋
 */
export interface MonthlyReward {
  /** 本地資料庫主鍵，自動遞增識別碼 (選填，新增時由 IndexedDB 自動產生) */
  id?: number;
  /** 所屬回饋年月 (格式：YYYY-MM) */
  yearMonth: string;
  /** 回饋來源或活動名稱 (例如：「玉山 Pi 點數折抵」、「LINE POINTS 回饋」) */
  sourceName: string;
  /** 回饋等值新台幣金額 */
  amount: number;
  /** 備註說明事項 */
  note?: string;
  /** 記錄建立時間戳記 (毫秒 Epoch 時間) */
  createdAt: number;
}

/**
 * 財務摘要統計數據結構
 * 用於首頁或報表頁面呈現當月或指定期間之收支綜觀
 */
export interface FinancialSummary {
  /** 總進帳金額 (所有收入記錄金額 + 每月回饋金額加總) */
  totalIncome: number;
  /** 總支出金額 (所有消費記錄扣款金額加總) */
  totalExpense: number;
  /** 當期結餘淨額 (總進帳 - 總支出；大於 0 表示儲蓄，小於 0 表示赤字) */
  balance: number;
}

/**
 * 分類資料表記錄介面 (IndexedDB categories 表資料結構)
 * 依規格書 L56 建立之支出與收入分類維護模型
 */
export interface CategoryRecord {
  /** 本地資料庫主鍵，自動遞增識別碼 (選填，新增時由 IndexedDB 自動產生) */
  id?: number;
  /** 分類名稱 (例如：「餐飲」、「交通」、「薪資」、「投資」) */
  name: string;
  /** 分類歸屬類型：'expense' 為支出分類，'income' 為收入分類 */
  type: 'expense' | 'income';
  /** 是否為系統內建之預設種子分類 (預設分類通常具有保護或預先植入屬性) */
  isDefault: boolean;
}

/**
 * 分類歸屬類型：'expense' 為支出分類，'income' 為收入分類
 */
export type CategoryType = CategoryRecord['type'];

/**
 * 支付方式表記錄介面 (IndexedDB paymentMethods 表資料結構)
 */
export interface PaymentMethodRecord {
  /** 本地資料庫主鍵，自動遞增識別碼 (選填，新增時由 IndexedDB 自動產生) */
  id?: number;
  /** 支付方式名稱 (例如：「現金」、「信用卡」、「街口支付」) */
  name: string;
  /** 是否為系統內建預設支付方式 */
  isDefault?: boolean;
}

/**
 * 跨元件交易編輯目標判別聯集 (Discriminated Union)
 * 供明細列表與記帳主表單跨元件雙向傳遞編輯資料，取代 any
 */
export type TransactionEditTarget =
  | { type: 'expense'; data: ExpenseRecord }
  | { type: 'income'; data: IncomeRecord }
  | { type: 'reward'; data: MonthlyReward };



