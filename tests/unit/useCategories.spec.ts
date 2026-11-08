import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dbModule from '@/db';
import { useCategories } from '@/composables/useCategories';

/**
 * useCategories 組合式函式 (Composable) 單元測試套件
 *
 * 測試範疇：
 * 1. 初始狀態與收支類型隔離 (Initialization & Scoping)
 * 2. 資料庫分類動態載入、增量合併與去重機制 (loadCategories)
 * 3. 自訂分類建立、回呼觸發與狀態重設 (handleCreateCategory)
 * 4. 防呆檢驗 (全形/半形空白/跳位字元) 與重複分類異常捕獲
 * 5. Vue Template 事件傳遞相容性 (傳入 MouseEvent 時防呆解析)
 * 6. 資料庫查詢異常時之靜默降級保護
 */

// Mock @/db 模組
vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>();
  return {
    ...actual,
    getCategories: vi.fn(),
    addCategory: vi.fn(),
  };
});

describe('useCategories Composable 單元測試', () => {
  const mockedGetCategories = vi.mocked(dbModule.getCategories);
  const mockedAddCategory = vi.mocked(dbModule.addCategory);

  beforeEach(() => {
    vi.clearAllMocks();

    // 預設 getCategories 模擬回傳
    mockedGetCategories.mockImplementation(async (type?: 'expense' | 'income') => {
      const records = [
        { id: 1, name: '餐飲', type: 'expense' as const, isDefault: true },
        { id: 2, name: '交通', type: 'expense' as const, isDefault: true },
        { id: 3, name: '生活', type: 'expense' as const, isDefault: true },
        { id: 4, name: '娛樂', type: 'expense' as const, isDefault: true },
        { id: 5, name: '醫療', type: 'expense' as const, isDefault: true },
        { id: 6, name: '其他', type: 'expense' as const, isDefault: true },
        { id: 7, name: '薪資', type: 'income' as const, isDefault: true },
        { id: 8, name: '轉帳', type: 'income' as const, isDefault: true },
        { id: 9, name: '獎金', type: 'income' as const, isDefault: true },
        { id: 10, name: '兼職', type: 'income' as const, isDefault: true },
        { id: 11, name: '投資', type: 'income' as const, isDefault: true },
        { id: 12, name: '其他', type: 'income' as const, isDefault: true },
      ];
      if (!type) return records;
      return records.filter((r) => r.type === type);
    });

    // 預設 addCategory 模擬回傳新增 ID
    mockedAddCategory.mockResolvedValue(100);
  });

  describe('1. 初始狀態與收支類型隔離 (Initialization & Scoping)', () => {
    it('useCategories("expense") 初始清單在未指定 initialCategories 時應預設為空陣列 []', () => {
      const { categories } = useCategories('expense');
      expect(categories.value).toEqual([]);
    });

    it('useCategories("income") 初始清單在未指定 initialCategories 時應預設為空陣列 []', () => {
      const { categories } = useCategories('income');
      expect(categories.value).toEqual([]);
    });

    it('初始響應式狀態應為預設值：showAddCategory 為 false，newCategoryName 與 categoryError 為空字串', () => {
      const { showAddCategory, newCategoryName, categoryError } = useCategories('expense');

      expect(showAddCategory.value).toBe(false);
      expect(newCategoryName.value).toBe('');
      expect(categoryError.value).toBe('');
    });

    it('支援透過 options.initialCategories 指定自訂初始分類清單', () => {
      const customInitial = ['自訂A', '自訂B'];
      const { categories } = useCategories('expense', { initialCategories: customInitial });

      expect(categories.value).toEqual(['自訂A', '自訂B']);
    });
  });

  describe('2. 資料庫分類動態載入、增量合併與去重 (loadCategories)', () => {
    it('loadCategories 應正確調用 db.getCategories 並將資料庫分類增量合併至 categories 清單', async () => {
      mockedGetCategories.mockResolvedValueOnce([
        { id: 1, name: '餐飲', type: 'expense', isDefault: true },
        { id: 99, name: '自訂露營', type: 'expense', isDefault: false },
      ]);

      const { categories, loadCategories } = useCategories('expense');
      await loadCategories();

      expect(mockedGetCategories).toHaveBeenCalledWith('expense');
      expect(categories.value).toContain('自訂露營');
      expect(categories.value).toContain('餐飲');
    });

    it('loadCategories 遇到與現有分類重複之名稱時自動去重，不產生重複項目', async () => {
      mockedGetCategories.mockResolvedValueOnce([
        { id: 1, name: '餐飲', type: 'expense', isDefault: true },
        { id: 2, name: '餐飲', type: 'expense', isDefault: false },
        { id: 3, name: '交通', type: 'expense', isDefault: true },
      ]);

      const { categories, loadCategories } = useCategories('expense');
      await loadCategories();

      const diningCount = categories.value.filter((c) => c === '餐飲').length;
      expect(diningCount).toBe(1);
    });

    it('當 db.getCategories 拋出異常時，loadCategories 應靜默降級，不拋出錯誤並保留原分類清單', async () => {
      mockedGetCategories.mockRejectedValueOnce(new Error('IndexedDB 連線逾時'));

      const { categories, loadCategories } = useCategories('expense', { initialCategories: ['餐飲'] });
      const beforeLength = categories.value.length;

      // 應安全執行不拋出異常
      await expect(loadCategories()).resolves.toBeUndefined();
      // 分類清單仍維持原狀
      expect(categories.value.length).toBe(beforeLength);
      expect(categories.value).toContain('餐飲');
    });
  });

  describe('3. 新增自訂分類成功流程 (handleCreateCategory - Success)', () => {
    it('handleCreateCategory 依據 newCategoryName 寫入 addCategory，並自動重新載入增量更新 categories 清單', async () => {
      const { categories, newCategoryName, handleCreateCategory } = useCategories('expense');

      newCategoryName.value = '健身運動';

      mockedGetCategories.mockResolvedValueOnce([
        { id: 1, name: '餐飲', type: 'expense', isDefault: true },
        { id: 101, name: '健身運動', type: 'expense', isDefault: false },
      ]);

      const result = await handleCreateCategory();

      expect(mockedAddCategory).toHaveBeenCalledWith({
        name: '健身運動',
        type: 'expense',
        isDefault: false,
      });
      expect(result).toBe('健身運動');
      expect(categories.value).toContain('健身運動');
    });

    it('新增成功後應將 newCategoryName 清空、showAddCategory 設為 false、categoryError 清空', async () => {
      const { showAddCategory, newCategoryName, categoryError, handleCreateCategory } = useCategories('expense');

      showAddCategory.value = true;
      newCategoryName.value = '旅遊休閒';
      categoryError.value = '先前的暫存錯誤';

      await handleCreateCategory();

      expect(newCategoryName.value).toBe('');
      expect(showAddCategory.value).toBe(false);
      expect(categoryError.value).toBe('');
    });

    it('新增成功後應觸發 options.onCreated 回呼，並傳入去除頭尾空白之新分類名稱', async () => {
      const onCreatedSpy = vi.fn();
      const { newCategoryName, handleCreateCategory } = useCategories('expense', {
        onCreated: onCreatedSpy,
      });

      newCategoryName.value = '  寵物開銷  ';
      await handleCreateCategory();

      expect(onCreatedSpy).toHaveBeenCalledTimes(1);
      expect(onCreatedSpy).toHaveBeenCalledWith('寵物開銷');
    });

    it('支援直接傳入自訂字串參數 (nameOrEvent 為字串)，優先以該字串進行新增', async () => {
      const { newCategoryName, handleCreateCategory } = useCategories('income');

      newCategoryName.value = '備用字串';
      const result = await handleCreateCategory('外部代入收入');

      expect(mockedAddCategory).toHaveBeenCalledWith({
        name: '外部代入收入',
        type: 'income',
        isDefault: false,
      });
      expect(result).toBe('外部代入收入');
    });

    it('相容 Vue template @click 事件觸發：傳入 MouseEvent 時防呆讀取 newCategoryName.value 而非將事件當成名稱', async () => {
      const { newCategoryName, handleCreateCategory } = useCategories('expense');

      newCategoryName.value = '展覽門票';

      // 模擬 template 綁定 @click="handleCreateCategory" 時傳遞之 MouseEvent 物件
      const mockClickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });

      const result = await handleCreateCategory(mockClickEvent);

      expect(mockedAddCategory).toHaveBeenCalledWith({
        name: '展覽門票',
        type: 'expense',
        isDefault: false,
      });
      expect(result).toBe('展覽門票');
    });
  });

  describe('4. 防呆驗證與異常處理 (handleCreateCategory - Validation & Error Handling)', () => {
    it('輸入全形空白、半形空格、跳位字元 (Tab) 或換行時，應阻止呼叫 addCategory，設定 categoryError 並回傳 null', async () => {
      const { newCategoryName, categoryError, handleCreateCategory } = useCategories('expense');

      // 測試包含純全形空白、跳位字元、多個空格
      const invalidInputs = ['', '   ', '　　', '\t\t', ' \n\t　 '];

      for (const input of invalidInputs) {
        newCategoryName.value = input;
        categoryError.value = '';

        const result = await handleCreateCategory();

        expect(result).toBeNull();
        expect(categoryError.value).toBe('分類名稱不可為空');
        expect(mockedAddCategory).not.toHaveBeenCalled();
      }
    });

    it('當 addCategory 拋出同名已存在錯誤時，應捕獲錯誤訊息並設定至 categoryError，且回傳 null', async () => {
      mockedAddCategory.mockRejectedValueOnce(new Error('分類「餐飲」已存在'));

      const { newCategoryName, categoryError, handleCreateCategory } = useCategories('expense');
      newCategoryName.value = '餐飲';

      const result = await handleCreateCategory();

      expect(result).toBeNull();
      expect(categoryError.value).toBe('分類「餐飲」已存在');
    });

    it('當 addCategory 拋出非 Error 實例之異常（如純字串或非標準物件）時，應安全轉換字串並設定至 categoryError', async () => {
      mockedAddCategory.mockRejectedValueOnce('資料庫未預期拒絕寫入');

      const { newCategoryName, categoryError, handleCreateCategory } = useCategories('expense');
      newCategoryName.value = '神秘開銷';

      const result = await handleCreateCategory();

      expect(result).toBeNull();
      expect(categoryError.value).toBe('資料庫未預期拒絕寫入');
    });
  });

  describe('5. 狀態重設 (resetCategoryState)', () => {
    it('resetCategoryState 應將 newCategoryName 與 categoryError 清空，並將 showAddCategory 重設為 false', () => {
      const { showAddCategory, newCategoryName, categoryError, resetCategoryState } = useCategories('expense');

      showAddCategory.value = true;
      newCategoryName.value = '未完成輸入';
      categoryError.value = '先前發生的錯誤';

      resetCategoryState();

      expect(showAddCategory.value).toBe(false);
      expect(newCategoryName.value).toBe('');
      expect(categoryError.value).toBe('');
    });
  });
});
