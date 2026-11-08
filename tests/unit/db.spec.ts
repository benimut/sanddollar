import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Dexie from 'dexie';
import * as dbModule from '@/db';
import {
  TrackerDatabase,
  db,
  addExpense,
  getExpenses,
  addIncome,
  getIncomes,
  addReward,
  getRewards,
  getDistinctMerchants,
  getItemsByMerchant,
  getDistinctIncomeSources,
  addIncomeSource,
} from '@/db';
import type { ExpenseRecord, IncomeRecord, MonthlyReward, CategoryRecord } from '@/types';

describe('Dexie.js 本地資料庫模型與儲存操作 (TrackerDatabase & db services)', () => {
  beforeEach(async () => {
    // 每個測試前清理資料庫，確保測試環境獨立
    if (db) {
      if (db.expenses) await db.expenses.clear();
      if (db.incomes) await db.incomes.clear();
      if (db.rewards) await db.rewards.clear();
      if (db.incomeSources) await db.incomeSources.clear();
    }
  });

  describe('資料庫結構與實例初始化', () => {
    it('TrackerDatabase 應正確繼承 Dexie 並定義 expenses, incomes, rewards 表格', () => {
      expect(TrackerDatabase).toBeDefined();
      const testDb = new TrackerDatabase();
      expect(testDb).toBeInstanceOf(Dexie);
      expect(testDb.expenses).toBeDefined();
      expect(testDb.incomes).toBeDefined();
      expect(testDb.rewards).toBeDefined();
    });

    it('匯出的預設單例 db 應為 TrackerDatabase 實例', () => {
      expect(db).toBeDefined();
      expect(db).toBeInstanceOf(TrackerDatabase);
    });

    it('TrackerDatabase 與預設單例 db 應正確定義 categories 資料表', () => {
      const testDb = new TrackerDatabase();
      expect((testDb as any).categories).toBeDefined();
      expect((db as any).categories).toBeDefined();
    });

    it('全域單例 db 之名稱應為 MobileExpenseTrackerDB 且版本為 4', () => {
      expect(db.name).toBe('MobileExpenseTrackerDB');
      expect(db.verno).toBe(4);
    });

    it('TrackerDatabase 建構子應支援自訂 dbName 並維持版本 4', () => {
      const customDb = new TrackerDatabase('CustomIsolatedDB');
      expect(customDb.name).toBe('CustomIsolatedDB');
      expect(customDb.verno).toBe(4);
      customDb.close();
    });

    it('TrackerDatabase 無參數建構時應產生隔離之 MobileExpenseTrackerDB_x 實例', () => {
      const isolatedDb = new TrackerDatabase();
      expect(isolatedDb.name).toMatch(/^MobileExpenseTrackerDB_\d+$/);
      isolatedDb.close();
    });
  });

  describe('消費支出操作 (Expense Operations)', () => {
    it('應能成功新增支出記錄並正確讀取，保留商品明細與折扣項', async () => {
      const mockExpense: ExpenseRecord = {
        date: '2026-11-05',
        merchant: '全家便利商店',
        paymentMethod: '信用卡',
        totalAmount: 110,
        isForeign: false,
        items: [
          {
            id: 'item-1',
            type: 'item',
            name: '美式咖啡',
            quantity: 2,
            unitPrice: 45,
            subtotal: 90,
            category: '餐飲食品',
          },
          {
            id: 'item-2',
            type: 'item',
            name: '三明治',
            quantity: 1,
            unitPrice: 35,
            subtotal: 35,
            category: '餐飲食品',
          },
          {
            id: 'disc-1',
            type: 'discount',
            name: '組合優惠折扣',
            quantity: 1,
            unitPrice: -15,
            subtotal: -15,
            category: '餐飲食品',
          },
        ],
        createdAt: 1730818800000,
        updatedAt: 1730818800000,
      };

      const id = await addExpense(mockExpense);
      expect(id).toBeDefined();
      expect(typeof id).toBe('number');

      const expenses = await getExpenses();
      expect(expenses.length).toBe(1);
      expect(expenses[0].merchant).toBe('全家便利商店');
      expect(expenses[0].totalAmount).toBe(110);
      expect(expenses[0].items.length).toBe(3);
      expect(expenses[0].items[2].type).toBe('discount');
      expect(expenses[0].items[2].subtotal).toBe(-15);
    });

    it('應支援外幣消費記錄與匯率資訊之儲存與讀取', async () => {
      const foreignExpense: ExpenseRecord = {
        date: '2026-11-05',
        merchant: 'Amazon US',
        paymentMethod: '信用卡',
        totalAmount: 3248,
        isForeign: true,
        currency: 'USD',
        foreignAmount: 100,
        netTwdAmount: 3200,
        fee: 48,
        exchangeRate: 32.48,
        items: [
          {
            id: 'item-us-1',
            type: 'item',
            name: '電子書閱讀器保護套',
            quantity: 1,
            unitPrice: 3200,
            subtotal: 3200,
            category: '數位3C',
          },
        ],
        createdAt: 1730818800000,
        updatedAt: 1730818800000,
      };

      await addExpense(foreignExpense);
      const expenses = await getExpenses();

      expect(expenses.length).toBe(1);
      expect(expenses[0].isForeign).toBe(true);
      expect(expenses[0].currency).toBe('USD');
      expect(expenses[0].foreignAmount).toBe(100);
      expect(expenses[0].fee).toBe(48);
      expect(expenses[0].exchangeRate).toBeCloseTo(32.48, 4);
    });
  });

  describe('收入記錄操作 (Income Operations)', () => {
    it('應能成功新增收入記錄並取得所有收入', async () => {
      const mockIncome: IncomeRecord = {
        date: '2026-11-05',
        source: '11月正職薪資',
        account: '玉山銀行',
        category: '薪資',
        amount: 65000,
        isForeign: false,
        createdAt: 1730818800000,
        updatedAt: 1730818800000,
      };

      const id = await addIncome(mockIncome);
      expect(id).toBeDefined();

      const incomes = await getIncomes();
      expect(incomes.length).toBe(1);
      expect(incomes[0].source).toBe('11月正職薪資');
      expect(incomes[0].amount).toBe(65000);
      expect(incomes[0].category).toBe('薪資');
    });

    it('應支援外幣收入與反推匯率記錄之儲存', async () => {
      const foreignIncome: IncomeRecord = {
        date: '2026-11-05',
        source: '海外自由工作者美金稿費',
        account: 'LINE Bank',
        category: '兼職',
        amount: 16000,
        isForeign: true,
        currency: 'USD',
        foreignAmount: 500,
        fee: 0,
        exchangeRate: 32.0,
        createdAt: 1730818800000,
        updatedAt: 1730818800000,
      };

      await addIncome(foreignIncome);
      const incomes = await getIncomes();

      expect(incomes.length).toBe(1);
      expect(incomes[0].isForeign).toBe(true);
      expect(incomes[0].currency).toBe('USD');
      expect(incomes[0].foreignAmount).toBe(500);
      expect(incomes[0].exchangeRate).toBe(32.0);
    });
  });

  describe('每月回饋記錄操作 (Reward Operations)', () => {
    it('應能成功新增並取得每月信用卡/行動支付點數回饋記錄', async () => {
      const mockReward: MonthlyReward = {
        yearMonth: '2026-11',
        sourceName: '玉山 Pi 拍錢包 P 幣回饋',
        amount: 350,
        note: '雙 11 刷卡滿額回饋',
        createdAt: 1730818800000,
      };

      const id = await addReward(mockReward);
      expect(id).toBeDefined();

      const rewards = await getRewards();
      expect(rewards.length).toBe(1);
      expect(rewards[0].yearMonth).toBe('2026-11');
      expect(rewards[0].sourceName).toBe('玉山 Pi 拍錢包 P 幣回饋');
      expect(rewards[0].amount).toBe(350);
    });
  });

  describe('歷史店家與商品快速關聯查詢 (Autocomplete & History Linking)', () => {
    it('getDistinctMerchants 應回傳不重複之歷史店家清單', async () => {
      // 尚無記錄時應回傳空陣列
      const emptyMerchants = await getDistinctMerchants();
      expect(emptyMerchants).toEqual([]);

      // 建立多筆消費，包含重複的店家
      await addExpense({
        date: '2026-11-01',
        merchant: '7-ELEVEN',
        paymentMethod: '現金',
        totalAmount: 55,
        isForeign: false,
        items: [],
        createdAt: 1,
        updatedAt: 1,
      });
      await addExpense({
        date: '2026-11-02',
        merchant: '全家便利商店',
        paymentMethod: '信用卡',
        totalAmount: 120,
        isForeign: false,
        items: [],
        createdAt: 2,
        updatedAt: 2,
      });
      await addExpense({
        date: '2026-11-03',
        merchant: '7-ELEVEN',
        paymentMethod: '悠遊卡',
        totalAmount: 70,
        isForeign: false,
        items: [],
        createdAt: 3,
        updatedAt: 3,
      });

      const merchants = await getDistinctMerchants();
      // 應去重，僅含「7-ELEVEN」與「全家便利商店」
      expect(merchants.length).toBe(2);
      expect(merchants).toContain('7-ELEVEN');
      expect(merchants).toContain('全家便利商店');
    });

    it('getItemsByMerchant 應回傳特定店家歷史購買過之商品，並依品名去重且排除純折扣項', async () => {
      // 若無該店家記錄，應回傳空陣列
      const noItems = await getItemsByMerchant('不存在的店家');
      expect(noItems).toEqual([]);

      // 新增店家 A 消費記錄 1
      await addExpense({
        date: '2026-11-01',
        merchant: '星巴克',
        paymentMethod: '信用卡',
        totalAmount: 310,
        isForeign: false,
        items: [
          {
            id: '1',
            type: 'item',
            name: '那堤 (特大杯)',
            quantity: 1,
            unitPrice: 150,
            subtotal: 150,
            category: '餐飲食品',
          },
          {
            id: '2',
            type: 'item',
            name: '巧克力可麗露',
            quantity: 2,
            unitPrice: 80,
            subtotal: 160,
            category: '餐飲食品',
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      });

      // 新增店家 A 消費記錄 2 (再次購買同品名商品，以及獨立折扣項目)
      await addExpense({
        date: '2026-11-03',
        merchant: '星巴克',
        paymentMethod: '信用卡',
        totalAmount: 130,
        isForeign: false,
        items: [
          {
            id: '3',
            type: 'item',
            name: '那堤 (特大杯)', // 重複商品
            quantity: 1,
            unitPrice: 150,
            subtotal: 150,
            category: '餐飲食品',
          },
          {
            id: '4',
            type: 'discount',
            name: '自備環保杯折扣', // 折扣項，不應作為常規商品供選取
            quantity: 1,
            unitPrice: -20,
            subtotal: -20,
            category: '餐飲食品',
          },
        ],
        createdAt: 2,
        updatedAt: 2,
      });

      // 新增另一店家 B 的消費記錄，確認不會混入
      await addExpense({
        date: '2026-11-04',
        merchant: '麥當勞',
        paymentMethod: '現金',
        totalAmount: 150,
        isForeign: false,
        items: [
          {
            id: '5',
            type: 'item',
            name: '麥香雞套餐',
            quantity: 1,
            unitPrice: 150,
            subtotal: 150,
            category: '餐飲食品',
          },
        ],
        createdAt: 3,
        updatedAt: 3,
      });

      const starbucksItems = await getItemsByMerchant('星巴克');

      // 應僅回傳「那堤 (特大杯)」與「巧克力可麗露」2 樣商品（品名去重，且不含自備環保杯折扣）
      expect(starbucksItems.length).toBe(2);

      const itemNames = starbucksItems.map((item) => item.name);
      expect(itemNames).toContain('那堤 (特大杯)');
      expect(itemNames).toContain('巧克力可麗露');
      expect(itemNames).not.toContain('自備環保杯折扣');
      expect(itemNames).not.toContain('麥香雞套餐');

      // 檢查結構符合 { name, unitPrice, category }
      const latte = starbucksItems.find((item) => item.name === '那堤 (特大杯)');
      expect(latte).toBeDefined();
      expect(latte?.unitPrice).toBe(150);
      expect(latte?.category).toBe('餐飲食品');
    });
  });

  describe('分類資料表與自訂分類管理 (Category Operations)', () => {
    it('初始資料庫無預載種子，getCategories() 回傳空陣列 [] 且 categories 表格數量為 0', async () => {
      const getCategories = (dbModule as any).getCategories;
      const allCategories = await getCategories();
      expect(Array.isArray(allCategories)).toBe(true);
      expect(allCategories.length).toBe(0);
    });

    it('getCategories 應支援依 type (expense / income) 進行過濾查詢', async () => {
      const getCategories = (dbModule as any).getCategories;
      const addCategory = (dbModule as any).addCategory;

      await addCategory({ name: '自訂餐飲', type: 'expense', isDefault: false });
      await addCategory({ name: '自訂薪資', type: 'income', isDefault: false });

      const expenseOnly = await getCategories('expense');
      expect(expenseOnly.length).toBe(1);
      expect(expenseOnly.every((c: any) => c.type === 'expense')).toBe(true);
      expect(expenseOnly[0].name).toBe('自訂餐飲');

      const incomeOnly = await getCategories('income');
      expect(incomeOnly.length).toBe(1);
      expect(incomeOnly.every((c: any) => c.type === 'income')).toBe(true);
      expect(incomeOnly[0].name).toBe('自訂薪資');
    });

    it('應支援新增自訂分類，並能正確查詢與識別非預設 (isDefault === false)', async () => {
      const getCategories = (dbModule as any).getCategories;
      expect((db as any).categories).toBeDefined();

      // 新增自訂支出分類
      await (db as any).categories.add({
        name: '寵物毛孩',
        type: 'expense',
        isDefault: false,
      });

      // 新增自訂收入分類
      await (db as any).categories.add({
        name: '股利分紅',
        type: 'income',
        isDefault: false,
      });

      const expenseList = await getCategories('expense');
      const customExpense = expenseList.find((c: any) => c.name === '寵物毛孩');
      expect(customExpense).toBeDefined();
      expect(customExpense.type).toBe('expense');
      expect(customExpense.isDefault).toBe(false);

      const incomeList = await getCategories('income');
      const customIncome = incomeList.find((c: any) => c.name === '股利分紅');
      expect(customIncome).toBeDefined();
      expect(customIncome.type).toBe('income');
      expect(customIncome.isDefault).toBe(false);
    });
  });

  describe('自訂分類維護 API 與防呆防重機制 (addCategory & Deduplication)', () => {
    const addCategory = (dbModule as any).addCategory;
    const getCategories = (dbModule as any).getCategories;

    it('應能成功新增自訂支出分類，回傳數字 ID 且 isDefault 為 false', async () => {
      const id = await addCategory({
        name: '健身運動',
        type: 'expense',
        isDefault: false,
      });
      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);

      const categories = await getCategories('expense');
      const target = categories.find((c: any) => c.name === '健身運動');
      expect(target).toBeDefined();
      expect(target?.type).toBe('expense');
      expect(target?.isDefault).toBe(false);
    });

    it('同類型下重複新增相同名稱時，應拋出已存在錯誤並防止重複寫入', async () => {
      // 先建立「餐飲」支出分類
      await addCategory({ name: '餐飲', type: 'expense', isDefault: false });

      await expect(
        addCategory({ name: '餐飲', type: 'expense', isDefault: false })
      ).rejects.toThrow('分類「餐飲」已存在');

      // 帶有前後空白的「  餐飲  」亦應被防重阻擋
      await expect(
        addCategory({ name: '  餐飲  ', type: 'expense', isDefault: false })
      ).rejects.toThrow('分類「餐飲」已存在');
    });

    it('不同類型下允許相同名稱共存 (如支出與收入各有名稱「其他」或自訂同名)', async () => {
      const expId = await addCategory({ name: '退款補貼', type: 'expense', isDefault: false });
      const incId = await addCategory({ name: '退款補貼', type: 'income', isDefault: false });
      expect(typeof expId).toBe('number');
      expect(typeof incId).toBe('number');

      const expList = await getCategories('expense');
      const incList = await getCategories('income');
      expect(expList.some((c: any) => c.name === '退款補貼')).toBe(true);
      expect(incList.some((c: any) => c.name === '退款補貼')).toBe(true);
    });

    it('名稱前後空白應自動 trim 修剪儲存', async () => {
      await addCategory({ name: '  露營裝備  ', type: 'expense', isDefault: false });
      const list = await getCategories('expense');
      expect(list.some((c: any) => c.name === '露營裝備')).toBe(true);
      expect(list.some((c: any) => c.name === '  露營裝備  ')).toBe(false);
    });

    it('空字串或純空白名稱應自動 fallback 為「其他」並成功回傳 ID', async () => {
      const id1 = await addCategory({ name: '', type: 'expense', isDefault: false });
      expect(typeof id1).toBe('number');

      const cat1 = await (db as any).categories.get(id1);
      expect(cat1?.name).toBe('其他');

      const id2 = await addCategory({ name: '   ', type: 'income', isDefault: false });
      expect(typeof id2).toBe('number');
      const cat2 = await (db as any).categories.get(id2);
      expect(cat2?.name).toBe('其他');
    });

    it('無效的分類類型應拋出無效類型錯誤', async () => {
      await expect(
        addCategory({ name: '非法分類', type: 'invalid' as any, isDefault: false })
      ).rejects.toThrow('無效的分類類型');
    });

    it('高並發競爭下連續新增相同分類，僅允許 1 筆寫入成功 (原子性驗證)', async () => {
      const promises = [
        addCategory({ name: '高並發分類', type: 'income', isDefault: false }),
        addCategory({ name: '高並發分類', type: 'income', isDefault: false }),
      ];
      const results = await Promise.allSettled(promises);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const count = await (db as any).categories
        .where({ name: '高並發分類', type: 'income' })
        .count();
      expect(count).toBe(1);
    });
  });

  describe('收入來源去重查詢與設定表管理 (getDistinctIncomeSources & addIncomeSource)', () => {
    it('當 incomeSources 設定表為空時，即使 incomes 歷史表記錄存在多筆資料，getDistinctIncomeSources 亦必須回傳空陣列 []（嚴禁回退讀取歷史表記錄）', async () => {
      // 確保 incomeSources 設定表為空
      await db.incomeSources.clear();
      await db.incomes.clear();

      // 新增多筆歷史收入記錄
      await addIncome({
        date: '2026-11-01',
        source: '11月薪水',
        account: '玉山銀行',
        category: '薪資',
        amount: 60000,
        isForeign: false,
        createdAt: 1,
        updatedAt: 1,
      });
      await addIncome({
        date: '2026-11-02',
        source: '接案報酬',
        account: 'LINE Bank',
        category: '兼職',
        amount: 15000,
        isForeign: false,
        createdAt: 2,
        updatedAt: 2,
      });

      // 依據 v2.1 規格，getDistinctIncomeSources 僅純讀取 incomeSources 設定表
      // 當設定表為空時，嚴禁回退讀取 incomes 歷史表，必須回傳空陣列 []
      const sources = await getDistinctIncomeSources();
      expect(sources).toEqual([]);
    });

    it('向 incomeSources 設定表新增來源後，getDistinctIncomeSources 應正確回傳去重且修剪前後空白的來源清單', async () => {
      await db.incomeSources.clear();

      await addIncomeSource('  薪資收入  ');
      await addIncomeSource('接案報酬');
      await addIncomeSource('投資獲利');

      const sources = await getDistinctIncomeSources();
      expect(sources.length).toBe(3);
      expect(sources).toContain('薪資收入');
      expect(sources).toContain('接案報酬');
      expect(sources).toContain('投資獲利');
      // 確保前後空白已被修剪
      expect(sources).not.toContain('  薪資收入  ');
    });

    it('驗證 addIncomeSource 防空字串與純空白字串防呆驗證', async () => {
      await expect(addIncomeSource('')).rejects.toThrow('收入來源名稱不可為空');
      await expect(addIncomeSource('   ')).rejects.toThrow('收入來源名稱不可為空');
    });

    it('驗證 addIncomeSource 同名防重與持久化寫入行為', async () => {
      await db.incomeSources.clear();

      const id1 = await addIncomeSource('公司薪資');
      expect(id1).toBeGreaterThan(0);

      // 同名重複新增應拋出錯誤
      await expect(addIncomeSource('公司薪資')).rejects.toThrow('收入來源「公司薪資」已存在');
      // 前後空白修剪後同名亦應拋出錯誤
      await expect(addIncomeSource('  公司薪資  ')).rejects.toThrow('收入來源「公司薪資」已存在');

      // 驗證持久化寫入 IndexedDB 實體表格
      const records = await db.incomeSources.toArray();
      expect(records.length).toBe(1);
      expect(records[0].name).toBe('公司薪資');
      expect(records[0].isDefault).toBe(false);
    });
  });

  describe('純本機儲存隔離與無遠端通訊驗證 (Zero-Sync & Local Storage Isolation)', () => {
    it('呼叫各項 CRUD 函式時，在任何環境下皆絕不觸發 fetch 或發送 /api/sync 網路請求', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const originalVitestEnv = process.env.VITEST;

      try {
        // 模擬真實環境（非測試環境跳過保護標記），確保不是只在測試環境避開 fetch
        delete process.env.VITEST;
        fetchSpy.mockClear();

        await addExpense({
          date: '2026-11-05',
          merchant: '隔離驗證店家',
          paymentMethod: '現金',
          totalAmount: 100,
          isForeign: false,
          items: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        await getExpenses();

        await addIncome({
          date: '2026-11-05',
          source: '隔離驗證收入',
          account: '現金',
          category: '其他',
          amount: 1000,
          isForeign: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        await getIncomes();

        await addReward({
          yearMonth: '2026-11',
          sourceName: '隔離驗證回饋',
          amount: 50,
          createdAt: Date.now(),
        });
        await getRewards();

        // 嚴格斷言：fetch 絕未被呼叫過，完全無 /api/sync 網路通訊
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        process.env.VITEST = originalVitestEnv;
        fetchSpy.mockRestore();
      }
    });
  });

  describe('商戶品項快取邊界保護與清空機制 (merchantItemsCache Capacity & Clear)', () => {
    it('clearMerchantItemsCache 函式應被導出且可成功清空快取', async () => {
      const clearMerchantItemsCache = (dbModule as any).clearMerchantItemsCache;
      expect(typeof clearMerchantItemsCache, 'db 模組應導出 clearMerchantItemsCache 函式').toBe('function');

      // 加入快取
      const cacheMerchantItems = (dbModule as any).cacheMerchantItems;
      cacheMerchantItems('測試快取店家', [
        { id: '1', type: 'item', name: '快取奶茶', unitPrice: 50, category: '餐飲' },
      ]);

      let items = await getItemsByMerchant('測試快取店家');
      expect(items.length).toBe(1);

      // 呼叫清空
      clearMerchantItemsCache();

      items = await getItemsByMerchant('測試快取店家');
      expect(items.length, '清空快取後應查無該店家快取品項').toBe(0);
    });

    it('cacheMerchantItems 加入超過 100 家不同店家時，只保留最多 100 家商戶 (淘汰最早項目)', async () => {
      const clearMerchantItemsCache = (dbModule as any).clearMerchantItemsCache;
      if (typeof clearMerchantItemsCache === 'function') {
        clearMerchantItemsCache();
      }

      const cacheMerchantItems = (dbModule as any).cacheMerchantItems;

      // 依序寫入 105 家不同店家的快取 (商戶_1 ~ 商戶_105)
      for (let i = 1; i <= 105; i++) {
        cacheMerchantItems(`商戶_${i}`, [
          { id: `item_${i}`, type: 'item', name: `商品_${i}`, unitPrice: 10 * i, category: '餐飲' },
        ]);
      }

      // 最早加入的商戶（商戶_1 ~ 商戶_5）應已被淘汰
      for (let i = 1; i <= 5; i++) {
        const items = await getItemsByMerchant(`商戶_${i}`);
        expect(items.length, `最早存入的商戶_${i} 應已被淘汰淘汰出快取`).toBe(0);
      }

      // 最近加入的商戶（商戶_6 ~ 商戶_105，共 100 家）應被完整保留
      for (let i = 6; i <= 105; i++) {
        const items = await getItemsByMerchant(`商戶_${i}`);
        expect(items.length, `商戶_${i} 應保留在最多 100 家的快取容量中`).toBe(1);
        expect(items[0].name).toBe(`商品_${i}`);
      }
    });
  });
});

