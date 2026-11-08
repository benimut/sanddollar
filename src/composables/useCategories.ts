/**
 * @file useCategories.ts
 * @description Sanddollar 系統分類管理共用 Composable (組合式函式)
 *
 * 核心職責：
 * 1. 根據收支類別 ('expense' | 'income') 初始化種子分類清單。
 * 2. 封裝 IndexedDB categories 資料表之非同步載入、去重增量合併與靜默降級保護 (loadCategories)。
 * 3. 封裝自訂分類介面響應式狀態 (showAddCategory, newCategoryName, categoryError)。
 * 4. 封裝自訂分類防呆驗證與持久化寫入 (handleCreateCategory)，支援成功回呼與選取連動。
 * 5. 提供狀態重設函式 (resetCategoryState)。
 */

import { ref, type Ref } from 'vue';
import type { CategoryType } from '@/types';
import { getCategories, addCategory } from '@/db';

/**
 * useCategories 參數選項介面
 */
export interface UseCategoriesOptions {
  /**
   * 自訂分類新增成功時觸發之回呼函式
   * 用於讓呼叫端元件自動更新選取項目 (例如更新 items[0].category 或 incomeCategory)
   *
   * @param categoryName - 新增成功且去除頭尾空白之分類名稱
   */
  onCreated?: (categoryName: string) => void;

  /**
   * 自訂初始分類清單 (選填，若未指定則自動根據 type 載入 DEFAULT_CATEGORIES)
   */
  initialCategories?: string[];
}

/**
 * useCategories 回傳方法與響應式狀態契約介面
 */
export interface UseCategoriesReturn {
  /** 當前分類名稱字串清單 (響應式陣列) */
  categories: Ref<string[]>;

  /** 是否展開自訂分類輸入介面 (響應式布林值) */
  showAddCategory: Ref<boolean>;

  /** 新增自訂分類輸入框雙向綁定值 (響應式字串) */
  newCategoryName: Ref<string>;

  /** 自訂分類錯誤提示文字 (響應式字串，無錯誤時為空字串) */
  categoryError: Ref<string>;

  /**
   * 從本機 IndexedDB 載入並增量去重合併分類清單
   * 具備錯誤降級保護機制，若讀取失敗則保留既有清單不拋出錯誤
   *
   * @returns 非同步 Promise，載入完成後解析
   */
  loadCategories: () => Promise<void>;

  /**
   * 處理新增自訂分類
   * 具備前後空白修剪、空白防呆、同名重複錯誤攔截與狀態重設
   *
   * @param nameOrEvent - 可選傳入分類名稱字串；若為 Vue 點擊事件 (Event) 或未傳入，則採用 newCategoryName.value
   * @returns 新增成功回傳分類名稱字串，驗證失敗或寫入異常則回傳 null
   */
  handleCreateCategory: (nameOrEvent?: unknown) => Promise<string | null>;

  /**
   * 重設自訂分類輸入介面狀態 (清空輸入字串、清空錯誤並收合輸入介面)
   */
  resetCategoryState: () => void;
}

/**
 * 分類管理共用組合式函式 (Composable)
 *
 * @param type - 分類類型：'expense' (支出) 或 'income' (收入)
 * @param options - 選填設定選項，可傳入 onCreated 回呼函式與 initialCategories
 * @returns 包含 categories, loadCategories, handleCreateCategory 等屬性之操作介面物件
 */
export function useCategories(
  type: CategoryType,
  options: UseCategoriesOptions = {}
): UseCategoriesReturn {
  // 1. 初始化分類清單（純淨模式：未指定 initialCategories 時預設為空陣列 []）
  const defaultList = options.initialCategories
    ? [...options.initialCategories]
    : [];

  const categories = ref<string[]>([...defaultList]);
  const showAddCategory = ref(false);
  const newCategoryName = ref('');
  const categoryError = ref('');

  /**
   * 重設自訂分類介面狀態 (清空輸入名稱、收起輸入框、清空錯誤訊息)
   */
  function resetCategoryState(): void {
    newCategoryName.value = '';
    showAddCategory.value = false;
    categoryError.value = '';
  }

  /**
   * 從本機資料庫動態載入並增量去重合併分類清單
   * 若讀取發生例外則維持現有清單，不拋出錯誤
   */
  async function loadCategories(): Promise<void> {
    try {
      const records = await getCategories(type);
      if (records && records.length > 0) {
        const merged = new Set([
          ...categories.value,
          ...records.map((r) => r.name),
        ]);
        categories.value = Array.from(merged);
      }
    } catch {
      // 讀取異常時靜默降級，維持現有分類
    }
  }

  /**
   * 處理新增自訂分類
   *
   * @param nameOrEvent - 傳入字串時直接作為名稱，傳入事件或未傳時取 newCategoryName.value
   * @returns 成功建立回傳分類名稱，驗證失敗或寫入異常則回傳 null
   */
  async function handleCreateCategory(nameOrEvent?: unknown): Promise<string | null> {
    // 若傳入字串則使用該字串，若為 Event 物件或其他型別則讀取 newCategoryName.value
    const rawName = typeof nameOrEvent === 'string' ? nameOrEvent : newCategoryName.value;
    // 修剪所有前後空白字元 (包含全形空白 \u3000 與標準空格、換行、跳位字元)
    const cleanName = (rawName ?? '').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '').trim();

    if (!cleanName) {
      categoryError.value = '分類名稱不可為空';
      return null;
    }

    try {
      await addCategory({
        name: cleanName,
        type,
        isDefault: false,
      });

      // 重新從資料庫載入最新分類
      await loadCategories();

      // 保底確保新分類立即存在於 categories 中
      if (!categories.value.includes(cleanName)) {
        categories.value.push(cleanName);
      }

      // 觸發新增成功回呼
      if (options.onCreated) {
        options.onCreated(cleanName);
      }

      // 重設輸入介面狀態
      resetCategoryState();
      return cleanName;
    } catch (err: unknown) {
      // 捕獲異常並安全處理錯誤訊息字串
      categoryError.value = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  return {
    categories,
    showAddCategory,
    newCategoryName,
    categoryError,
    loadCategories,
    handleCreateCategory,
    resetCategoryState,
  };
}
