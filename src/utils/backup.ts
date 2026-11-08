/**
 * @file backup.ts
 * @description Sanddollar 本機 JSON 資料備份與還原工具模組
 * 支援純本地匯出 (exportBackupData) 與嚴謹格式驗證還原 (importBackupData)，
 * 支援原子性「覆寫 (overwrite)」與「安全追加合併 (merge)」兩種模式，確保資料不外洩與資料庫狀態完整性。
 */

import type { Table } from 'dexie';
import { TrackerDatabase, db } from '@/db';
import type { ExpenseRecord, IncomeRecord, MonthlyReward, CategoryRecord, PaymentMethodRecord } from '@/types';

/**
 * 備份資料酬載介面
 */
export interface BackupDataPayload {
  /** 備份資料格式版本號 (目前固定為 1) */
  version: number;
  /** 匯出時間戳記 (ISO 8601 格式字串，例如：2026-11-06T12:00:00.000Z) */
  exportedAt: string;
  /** 資料表記錄內容集合物件 */
  data: {
    /** 支出記錄陣列 */
    expenses: ExpenseRecord[];
    /** 收入記錄陣列 */
    incomes: IncomeRecord[];
    /** 每月回饋記錄陣列 */
    rewards: MonthlyReward[];
    /** 分類記錄陣列 */
    categories: CategoryRecord[];
    /** 支付方式記錄陣列 */
    paymentMethods: PaymentMethodRecord[];
  };
}

/**
 * 匯入結果統計資訊介面
 */
export interface ImportBackupResult {
  /** 是否匯入成功 */
  success: boolean;
  /** 各資料表成功匯入的筆數統計物件 */
  importedCount: {
    /** 匯入之支出記錄筆數 */
    expenses: number;
    /** 匯入之收入記錄筆數 */
    incomes: number;
    /** 匯入之每月回饋記錄筆數 */
    rewards: number;
    /** 匯入之分類記錄筆數 */
    categories: number;
    /** 匯入之支付方式記錄筆數 */
    paymentMethods: number;
  };
  /** 錯誤訊息字串 (若失敗時提供具體失敗原因) */
  error?: string;
}

/**
 * 匯出本地 IndexedDB 資料為 JSON 字串
 * 包含版本號、匯出時間戳記與支出、收入、每月回饋、分類及支付方式記錄
 *
 * @param dbInstance - 選填的資料庫實例，若未指定則使用全域預設 db
 * @returns 符合備份格式的 JSON 字串
 */
export async function exportBackupData(dbInstance?: TrackerDatabase): Promise<string> {
  const targetDb = dbInstance ?? db;

  const expenses = await targetDb.expenses.toArray();
  const incomes = await targetDb.incomes.toArray();
  const rewards = await targetDb.rewards.toArray();
  const allCategories = targetDb.categories ? await targetDb.categories.toArray() : [];
  const paymentMethods = targetDb.paymentMethods ? await targetDb.paymentMethods.toArray() : [];

  // 若資料庫為全新空資料庫（完全無支出、收入、回饋記錄且無任何自訂分類），匯出之各表格為空陣列；
  // 若包含任一筆使用者業務數據或自訂分類，則完整匯出所有分類記錄（含預設種子分類與自訂分類）
  const hasUserData =
    expenses.length > 0 ||
    incomes.length > 0 ||
    rewards.length > 0 ||
    paymentMethods.length > 0 ||
    allCategories.some((c) => !c.isDefault);
  const categories = hasUserData ? allCategories : [];

  const payload: BackupDataPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      expenses,
      incomes,
      rewards,
      categories,
      paymentMethods,
    },
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * 匯入 JSON 備份資料至本地 IndexedDB 資料庫
 * 支援「覆寫 (overwrite)」與「合併 (merge)」兩種模式
 *
 * @param jsonString - 待匯入的 JSON 備份字串
 * @param mode - 匯入模式：'overwrite' (預設，清空現有資料再匯入) 或 'merge' (保留現有資料並安全追加)
 * @param dbInstance - 選填的資料庫實例，若未指定則使用全域預設 db
 * @returns 匯入結果與筆數統計
 */
export async function importBackupData(
  jsonString: string,
  mode: 'overwrite' | 'merge' = 'overwrite',
  dbInstance?: TrackerDatabase
): Promise<ImportBackupResult> {
  const emptyCount = { expenses: 0, incomes: 0, rewards: 0, categories: 0, paymentMethods: 0 };

  // 1. 解析 JSON 字串
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return {
      success: false,
      importedCount: emptyCount,
      error: '無效的 JSON 字串格式',
    };
  }

  // 2. 驗證資料結構完整性
  if (!parsed || typeof parsed !== 'object') {
    return {
      success: false,
      importedCount: emptyCount,
      error: '備份資料格式錯誤：根節點必須為物件',
    };
  }

  const payload = parsed as Partial<BackupDataPayload>;

  if (typeof payload.version !== 'number' || Number.isNaN(payload.version)) {
    return {
      success: false,
      importedCount: emptyCount,
      error: '備份資料格式錯誤：缺少或無效的 version 版本號',
    };
  }

  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    return {
      success: false,
      importedCount: emptyCount,
      error: '備份資料格式錯誤：缺少或無效的 data 結構',
    };
  }

  if (!Array.isArray(payload.data.expenses)) {
    return {
      success: false,
      importedCount: emptyCount,
      error: '備份資料格式錯誤：缺少或無效的 data 結構，expenses 表格必須為陣列',
    };
  }

  if (!Array.isArray(payload.data.incomes)) {
    return {
      success: false,
      importedCount: emptyCount,
      error: '備份資料格式錯誤：缺少或無效的 data 結構，incomes 表格必須為陣列',
    };
  }

  if (!Array.isArray(payload.data.rewards)) {
    return {
      success: false,
      importedCount: emptyCount,
      error: '備份資料格式錯誤：缺少或無效的 data 結構，rewards 表格必須為陣列',
    };
  }

  if (!Array.isArray(payload.data.categories)) {
    return {
      success: false,
      importedCount: emptyCount,
      error: '備份資料格式錯誤：categories 必須為陣列',
    };
  }

  if (payload.data.paymentMethods !== undefined && !Array.isArray(payload.data.paymentMethods)) {
    return {
      success: false,
      importedCount: emptyCount,
      error: '備份資料格式錯誤：paymentMethods 必須為陣列',
    };
  }

  const targetDb = dbInstance ?? db;
  const { expenses, incomes, rewards } = payload.data;
  const categories = Array.isArray(payload.data.categories) ? payload.data.categories : [];
  const paymentMethods = Array.isArray(payload.data.paymentMethods) ? payload.data.paymentMethods : [];

  const tables: Table[] = [targetDb.expenses, targetDb.incomes, targetDb.rewards];
  if (targetDb.categories) tables.push(targetDb.categories);
  if (targetDb.paymentMethods) tables.push(targetDb.paymentMethods);

  try {
    if (mode === 'overwrite') {
      // 覆寫模式：原子性清空現有表格並批次寫入備份資料
      await targetDb.transaction('rw', tables, async () => {
        await targetDb.expenses.clear();
        await targetDb.incomes.clear();
        await targetDb.rewards.clear();
        if (targetDb.categories) {
          await targetDb.categories.clear();
        }
        if (targetDb.paymentMethods) {
          await targetDb.paymentMethods.clear();
        }

        if (expenses.length > 0) {
          await targetDb.expenses.bulkAdd(expenses);
        }
        if (incomes.length > 0) {
          await targetDb.incomes.bulkAdd(incomes);
        }
        if (rewards.length > 0) {
          await targetDb.rewards.bulkAdd(rewards);
        }
        if (targetDb.categories && categories.length > 0) {
          await targetDb.categories.bulkAdd(categories);
        }
        if (targetDb.paymentMethods && paymentMethods.length > 0) {
          await targetDb.paymentMethods.bulkAdd(paymentMethods);
        }
      });
    } else {
      // 合併模式：移除主鍵 id 以安全遞增新增，避免主鍵衝突
      await targetDb.transaction('rw', tables, async () => {
        for (const item of expenses) {
          const { id, ...rest } = item;
          await targetDb.expenses.add(rest as ExpenseRecord);
        }
        for (const item of incomes) {
          const { id, ...rest } = item;
          await targetDb.incomes.add(rest as IncomeRecord);
        }
        for (const item of rewards) {
          const { id, ...rest } = item;
          await targetDb.rewards.add(rest as MonthlyReward);
        }

        // categories 合併去重邏輯
        if (targetDb.categories && categories.length > 0) {
          const existing = await targetDb.categories.toArray();
          for (const item of categories) {
            const { id, ...rest } = item;
            const isDup = existing.some(c => c.name === rest.name && c.type === rest.type);
            if (!isDup) {
              await targetDb.categories.add(rest as CategoryRecord);
            }
          }
        }

        // paymentMethods 合併去重邏輯
        if (targetDb.paymentMethods && paymentMethods.length > 0) {
          const existingMethods = await targetDb.paymentMethods.toArray();
          for (const item of paymentMethods) {
            const { id, ...rest } = item;
            const isDup = existingMethods.some((m) => m.name === rest.name);
            if (!isDup) {
              await targetDb.paymentMethods.add(rest as PaymentMethodRecord);
            }
          }
        }
      });
    }

    const importedCount: ImportBackupResult['importedCount'] = {
      expenses: expenses.length,
      incomes: incomes.length,
      rewards: rewards.length,
      categories: categories.length,
      paymentMethods: paymentMethods.length,
    };

    return {
      success: true,
      importedCount,
    };
  } catch (err) {
    return {
      success: false,
      importedCount: emptyCount,
      error: err instanceof Error ? err.message : '寫入資料庫時發生未知錯誤',
    };
  }
}
