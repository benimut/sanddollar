/**
 * @file index.ts
 * @description Sanddollar 本機 IndexedDB 核心資料庫模組
 * 基於 Dexie.js 實現純前端瀏覽器端儲存，絕無任何遠端通訊或 /api/sync 端點（符合無外洩隱私規格）。
 * 提供支出 (expenses)、收入 (incomes)、回饋 (rewards) 與分類 (categories) 之 CRUD 與去重查詢。
 */

import Dexie, { type Table } from 'dexie';
import type { ExpenseRecord, IncomeRecord, MonthlyReward, ExpenseItem, CategoryRecord, PaymentMethodRecord } from '@/types';

/** 資料庫實例計數器，用於在測試環境建立隔離之資料庫實例 */
let dbCounter = 0;

/**
 * 預設分類種子資料 (支出 6 種、收入 6 種)
 * 符合軟體規格書 L56 預設分類定義
 */
export const DEFAULT_CATEGORIES: Array<Omit<CategoryRecord, 'id'>> = [
  // 支出分類
  { name: '餐飲', type: 'expense', isDefault: true },
  { name: '交通', type: 'expense', isDefault: true },
  { name: '生活', type: 'expense', isDefault: true },
  { name: '娛樂', type: 'expense', isDefault: true },
  { name: '醫療', type: 'expense', isDefault: true },
  { name: '其他', type: 'expense', isDefault: true },
  // 收入分類
  { name: '薪資', type: 'income', isDefault: true },
  { name: '轉帳', type: 'income', isDefault: true },
  { name: '獎金', type: 'income', isDefault: true },
  { name: '兼職', type: 'income', isDefault: true },
  { name: '投資', type: 'income', isDefault: true },
  { name: '其他', type: 'income', isDefault: true },
];

/**
 * 記帳應用程式本機 IndexedDB 資料庫類別
 * 繼承自 Dexie，管理支出、收入、每月回饋與分類資料表
 */
export class TrackerDatabase extends Dexie {
  /** 支出表記錄資料表 (支援 date, merchant, paymentMethod, totalAmount, isForeign 索引) */
  expenses!: Table<ExpenseRecord, number>;
  /** 收入表記錄資料表 (支援 date, source, category, amount, isForeign 索引) */
  incomes!: Table<IncomeRecord, number>;
  /** 每月回饋記錄資料表 (支援 yearMonth, sourceName 索引) */
  rewards!: Table<MonthlyReward, number>;
  /** 分類表記錄資料表 (支援 name, type, isDefault 索引) */
  categories!: Table<CategoryRecord, number>;
  /** 支付方式表記錄資料表 (支援 name, isDefault 索引) */
  paymentMethods!: Table<PaymentMethodRecord, number>;

  /**
   * 初始化 TrackerDatabase 資料庫結構與版本定義
   *
   * @param dbName - 資料庫名稱，預設為 'MobileExpenseTrackerDB' 或依序生成的唯一名稱
   */
  constructor(dbName?: string) {
    const name = dbName ?? (dbCounter === 0 ? 'MobileExpenseTrackerDB' : `MobileExpenseTrackerDB_${dbCounter}`);
    dbCounter++;
    super(name);

    // 定義資料庫表格與索引欄位
    this.version(3).stores({
      expenses: '++id, date, merchant, paymentMethod, totalAmount, isForeign',
      incomes: '++id, date, source, category, amount, isForeign',
      rewards: '++id, yearMonth, sourceName',
      categories: '++id, name, type, isDefault, [type+name]',
      paymentMethods: '++id, name, isDefault',
    });

    this.setupAutoIncrementReset(this.expenses);
    this.setupAutoIncrementReset(this.incomes);
    this.setupAutoIncrementReset(this.rewards);
    this.setupAutoIncrementReset(this.categories);
    this.setupAutoIncrementReset(this.paymentMethods);
  }

  /**
   * 封裝 table.clear 方法，在清空資料時重設假資料庫之 autoIncrement 計數器，確保測試隔離性
   */
  private setupAutoIncrementReset(table: Table) {
    const origClear = table.clear.bind(table);
    (table as unknown as { clear: () => Promise<void> }).clear = async () => {
      const res = await origClear();
      try {
        const backend = (
          this as unknown as {
            backendDB?: () => {
              _rawDatabase?: {
                rawObjectStores?: Map<string, { keyGenerator?: { num: number } }>;
              };
            };
          }
        ).backendDB?.();
        const rawStore = backend?._rawDatabase?.rawObjectStores?.get(table.name);
        if (rawStore?.keyGenerator) {
          rawStore.keyGenerator.num = 0;
        }
      } catch {
        // 在正式瀏覽器環境或不支援底層存取時安全忽略
      }
      return res;
    };
  }
}

/**
 * 全域預設單例資料庫實例
 */
export const db = new TrackerDatabase();

/**
 * 取得分類清單，可選依支出或收入類別進行過濾
 * 純淨資料庫模式：不自動塞入預設種子分類，完全依據資料庫實際記錄回傳
 *
 * @param type - 選填分類類型 ('expense' | 'income')
 * @returns 分類記錄陣列
 */
export async function getCategories(type?: 'expense' | 'income'): Promise<CategoryRecord[]> {
  if (type !== undefined) {
    return await db.categories.where('type').equals(type).toArray();
  }
  return await db.categories.toArray();
}

/**
 * 新增一筆分類記錄至本機 categories 資料表
 * 具備字串修剪 (trim)、未填自動 Fallback「其他」、型別防呆檢查與同類型防重複 (Deduplication) 機制
 *
 * @param category - 分類物件 (包含 name, type, isDefault)
 * @returns 新增記錄的自動遞增識別碼 (ID)
 * @throws {Error} 當分類類型無效或該類型下已存在同名自訂分類時拋出錯誤
 */
export async function addCategory(category: Omit<CategoryRecord, 'id'>): Promise<number> {
  // 1. 防呆驗證：分類類型
  if (!category || (category.type !== 'expense' && category.type !== 'income')) {
    throw new Error('無效的分類類型');
  }

  // 2. 名稱處理與未填寫自動 Fallback「其他」
  const rawName = typeof category.name === 'string' ? category.name.trim() : '';
  const cleanName = rawName.length > 0 ? rawName : '其他';

  // 3. 原子交易與去重檢查
  return await db.transaction('rw', db.categories, async () => {
    const existing = await db.categories
      .where('[type+name]')
      .equals([category.type, cleanName])
      .first();

    if (existing) {
      if (rawName.length === 0) {
        // Fallback 為「其他」且已存在時，安全回傳既有識別碼
        return existing.id as number;
      }
      throw new Error(`分類「${cleanName}」已存在`);
    }

    const id = await db.categories.add({
      name: cleanName,
      type: category.type,
      isDefault: category.isDefault ?? false,
    });
    return id as number;
  });
}


/**
 * 取得歷史收入記錄中所有不重複且非空的收入來源清單
 * 自動去除前後空白，去重並排除純空白與空字串
 *
 * @returns 收入來源字串陣列
 */
export async function getDistinctIncomeSources(): Promise<string[]> {
  const incomes = await db.incomes.toArray();
  const sourceSet = new Set<string>();

  for (const income of incomes) {
    if (income.source && typeof income.source === 'string') {
      const trimmed = income.source.trim();
      if (trimmed.length > 0) {
        sourceSet.add(trimmed);
      }
    }
  }

  return Array.from(sourceSet);
}

/**
 * 新增一筆支出記錄
 *
 * @param record - 支出記錄物件
 * @returns 新增記錄的自動遞增識別碼 (ID)
 */
export async function addExpense(record: ExpenseRecord): Promise<number> {
  const id = await db.expenses.add(record);
  return id as number;
}

/**
 * 取得所有支出記錄清單
 *
 * @returns 支出記錄陣列
 */
export async function getExpenses(): Promise<ExpenseRecord[]> {
  return await db.expenses.toArray();
}

/**
 * 新增一筆收入記錄
 *
 * @param record - 收入記錄物件
 * @returns 新增記錄的自動遞增識別碼 (ID)
 */
export async function addIncome(record: IncomeRecord): Promise<number> {
  const id = await db.incomes.add(record);
  return id as number;
}

/**
 * 取得所有收入記錄清單
 *
 * @returns 收入記錄陣列
 */
export async function getIncomes(): Promise<IncomeRecord[]> {
  return await db.incomes.toArray();
}

/**
 * 新增一筆每月回饋記錄
 *
 * @param record - 每月回饋記錄物件
 * @returns 新增記錄的自動遞增識別碼 (ID)
 */
export async function addReward(record: MonthlyReward): Promise<number> {
  const id = await db.rewards.add(record);
  return id as number;
}

/**
 * 取得所有每月回饋記錄清單
 *
 * @returns 每月回饋記錄陣列
 */
export async function getRewards(): Promise<MonthlyReward[]> {
  return await db.rewards.toArray();
}

/**
 * 刪除指定 ID 之支出記錄
 *
 * @param id - 支出記錄 ID
 */
export async function deleteExpense(id: number): Promise<void> {
  await db.expenses.delete(id);
}

/**
 * 更新指定 ID 之支出記錄
 *
 * @param id - 支出記錄 ID
 * @param changes - 欲局部更新之欄位物件
 * @returns 受影響之筆數 (1 為成功，0 為無記錄)
 */
export async function updateExpense(
  id: number,
  changes: Partial<ExpenseRecord>
): Promise<number> {
  return await db.expenses.update(id, changes);
}

/**
 * 刪除指定 ID 之收入記錄
 *
 * @param id - 收入記錄 ID
 */
export async function deleteIncome(id: number): Promise<void> {
  await db.incomes.delete(id);
}

/**
 * 更新指定 ID 之收入記錄
 *
 * @param id - 收入記錄 ID
 * @param changes - 欲局部更新之欄位物件
 * @returns 受影響之筆數 (1 為成功，0 為無記錄)
 */
export async function updateIncome(
  id: number,
  changes: Partial<IncomeRecord>
): Promise<number> {
  return await db.incomes.update(id, changes);
}

/**
 * 刪除指定 ID 之每月回饋記錄
 *
 * @param id - 回饋記錄 ID
 */
export async function deleteReward(id: number): Promise<void> {
  await db.rewards.delete(id);
}

/**
 * 更新指定 ID 之每月回饋記錄
 *
 * @param id - 回饋記錄 ID
 * @param changes - 欲局部更新之欄位物件
 * @returns 受影響之筆數
 */
export async function updateReward(
  id: number,
  changes: Partial<MonthlyReward>
): Promise<number> {
  return await db.rewards.update(id, changes);
}

/**
 * 系統預設常用支付方式清單
 */
export const DEFAULT_PAYMENT_METHODS: string[] = [
  '現金',
  '信用卡',
  '行動支付',
  '悠遊卡/一卡通',
  '銀行轉帳',
];

/**
 * 取得支付方式清單
 * 純淨資料庫模式：完全依據資料庫實際記錄回傳，不預載種子
 *
 * @returns 支付方式字串陣列
 */
export async function getPaymentMethods(): Promise<string[]> {
  const customRecords = db.paymentMethods ? await db.paymentMethods.toArray() : [];
  const set = new Set<string>();
  for (const r of customRecords) {
    if (r.name && r.name.trim()) {
      set.add(r.name.trim());
    }
  }
  return Array.from(set);
}

/**
 * 新增自訂支付方式
 * 具備字串修剪 (trim)、未填自動 Fallback「現金」、型別防呆檢查與防重複 (Deduplication) 機制
 *
 * @param name - 支付方式名稱
 * @returns 新增記錄之自動遞增 ID
 * @throws {Error} 當名稱無效或已存在同名支付方式時拋出錯誤
 */
export async function addPaymentMethod(name: string): Promise<number> {
  const rawName = typeof name === 'string' ? name.trim() : '';
  const cleanName = rawName.length > 0 ? rawName : '現金';

  const existingRecords = db.paymentMethods ? await db.paymentMethods.toArray() : [];
  const existing = existingRecords.find((m) => m.name.trim() === cleanName);

  if (existing) {
    if (rawName.length === 0) {
      // 未填寫 Fallback「現金」且已存在時，安全回傳既有識別碼
      return existing.id as number;
    }
    throw new Error(`支付方式「${cleanName}」已存在`);
  }

  const id = await db.paymentMethods.add({
    name: cleanName,
    isDefault: false,
  });
  return id as number;
}

/**
 * 取得歷史消費記錄中所有不重複的店家名稱清單
 *
 * @returns 店家名稱字串陣列
 */
export async function getDistinctMerchants(): Promise<string[]> {
  const expenses = await db.expenses.toArray();
  const merchants = new Set<string>();

  for (const expense of expenses) {
    if (expense.merchant && expense.merchant.trim() !== '') {
      merchants.add(expense.merchant.trim());
    }
  }

  return Array.from(merchants);
}

/**
 * 記憶體快取：儲存各店家的常買推薦品項，提供 0 延遲即時查詢
 * 限制最多保留 100 家店家資料，防止記憶體無限增長
 */
const MAX_MERCHANT_CACHE_SIZE = 100;
const merchantItemsCache = new Map<string, Array<{ name: string; unitPrice: number; category: string }>>();

/**
 * 清空店家推薦品項之記憶體快取（主要供測試隔離或重置使用）
 */
export function clearMerchantItemsCache(): void {
  merchantItemsCache.clear();
}

/**
 * 將指定店家的品項明細寫入記憶體快取中
 * 自動排除折扣項目 (type === 'discount') 並依商品名稱去重，提供即時商品推薦
 *
 * @param merchant - 目標店家名稱
 * @param items - 該筆消費之商品明細陣列
 */
export function cacheMerchantItems(merchant: string, items: ExpenseItem[]): void {
  if (!merchant || !items || items.length === 0) return;
  const list = merchantItemsCache.get(merchant) || [];
  for (const it of items) {
    if (it.type !== 'discount' && it.name && !list.some(x => x.name === it.name)) {
      list.push({ name: it.name, unitPrice: it.unitPrice, category: it.category });
    }
  }
  // 若快取超出上限且此商家為新鍵，移除最舊的一筆 (FIFO)
  if (!merchantItemsCache.has(merchant) && merchantItemsCache.size >= MAX_MERCHANT_CACHE_SIZE) {
    const oldestKey = merchantItemsCache.keys().next().value;
    if (oldestKey !== undefined) {
      merchantItemsCache.delete(oldestKey);
    }
  }
  merchantItemsCache.set(merchant, list);
}

/**
 * 根據店家名稱查詢曾購買過的歷史商品清單
 * 依商品名稱進行去重，並排除純折扣項目 (type === 'discount')
 *
 * @param merchant - 目標店家名稱
 * @returns 商品簡要資訊清單 (包含名稱、單價、分類)
 */
export async function getItemsByMerchant(
  merchant: string
): Promise<Array<{ name: string; unitPrice: number; category: string }>> {
  if (!merchant || merchant.trim() === '') {
    return [];
  }

  const cleanMerchant = merchant.trim();
  const itemMap = new Map<string, { name: string; unitPrice: number; category: string }>();

  // 1. 優先從記憶體快取讀取（提供即時連動推薦）
  const cached = merchantItemsCache.get(cleanMerchant);
  if (cached && Array.isArray(cached)) {
    for (const it of cached) {
      itemMap.set(it.name, it);
    }
  }

  // 2. 查詢該店家的所有消費記錄
  const expenses = await db.expenses
    .where('merchant')
    .equals(cleanMerchant)
    .toArray();

  for (const expense of expenses) {
    if (!expense.items || !Array.isArray(expense.items)) {
      continue;
    }

    for (const item of expense.items) {
      // 排除折扣項目
      if (item.type === 'discount') {
        continue;
      }

      // 依品名去重，若未曾加入則收錄
      if (item.name && !itemMap.has(item.name)) {
        itemMap.set(item.name, {
          name: item.name,
          unitPrice: item.unitPrice,
          category: item.category,
        });
      }
    }
  }

  return Array.from(itemMap.values());
}
