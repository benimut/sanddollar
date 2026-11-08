import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { TrackerDatabase, db } from '@/db';
import { exportBackupData, importBackupData } from '@/utils/backup';
import type { ExpenseRecord, IncomeRecord, MonthlyReward, CategoryRecord } from '@/types';

describe('純本地 JSON 匯出與還原模組 (backup.ts)', () => {
  beforeEach(async () => {
    // 每個測試前清理預設資料庫
    if (db) {
      if (db.expenses) await db.expenses.clear();
      if (db.incomes) await db.incomes.clear();
      if (db.rewards) await db.rewards.clear();
      if (db.categories) await db.categories.clear();
      if (db.paymentMethods) await db.paymentMethods.clear();
    }
  });

  const mockExpenses: ExpenseRecord[] = [
    {
      id: 1,
      date: '2026-11-01',
      merchant: '統一超商',
      paymentMethod: '悠遊卡',
      totalAmount: 85,
      isForeign: false,
      items: [
        {
          id: 'item-1',
          type: 'item',
          name: '御飯糰',
          quantity: 2,
          unitPrice: 35,
          subtotal: 70,
          category: '餐飲食品',
        },
        {
          id: 'item-2',
          type: 'item',
          name: '無糖綠茶',
          quantity: 1,
          unitPrice: 25,
          subtotal: 25,
          category: '餐飲食品',
        },
        {
          id: 'disc-1',
          type: 'discount',
          name: '超值組合折抵',
          quantity: 1,
          unitPrice: -10,
          subtotal: -10,
          category: '餐飲食品',
        },
      ],
      createdAt: 1730419200000,
      updatedAt: 1730419200000,
    },
    {
      id: 2,
      date: '2026-11-02',
      merchant: 'Amazon JP',
      paymentMethod: '信用卡',
      totalAmount: 1100,
      isForeign: true,
      currency: 'JPY',
      foreignAmount: 5000,
      netTwdAmount: 1084,
      fee: 16,
      exchangeRate: 0.22,
      items: [
        {
          id: 'item-3',
          type: 'item',
          name: '日文書籍',
          quantity: 1,
          unitPrice: 5000,
          subtotal: 5000,
          category: '教育學習',
        },
      ],
      createdAt: 1730505600000,
      updatedAt: 1730505600000,
    },
  ];

  const mockIncomes: IncomeRecord[] = [
    {
      id: 1,
      date: '2026-11-05',
      source: '11月薪資',
      account: '台新銀行',
      category: '薪資',
      amount: 60000,
      isForeign: false,
      fee: 0,
      createdAt: 1730764800000,
      updatedAt: 1730764800000,
    },
    {
      id: 2,
      date: '2026-11-06',
      source: '美股股利',
      account: '富邦銀行',
      category: '投資',
      amount: 3200,
      isForeign: true,
      currency: 'USD',
      foreignAmount: 100,
      fee: 0,
      exchangeRate: 32.0,
      createdAt: 1730851200000,
      updatedAt: 1730851200000,
    },
  ];

  const mockRewards: MonthlyReward[] = [
    {
      id: 1,
      yearMonth: '2026-11',
      sourceName: '台新黑狗卡回饋',
      amount: 350,
      note: '街口支付 3.8%',
      createdAt: 1730851200000,
    },
  ];

  describe('exportBackupData 匯出功能', () => {
    it('空資料庫時應產出符合規格的合法 JSON 字串，內含 version、exportedAt 及空的陣列', async () => {
      const jsonStr = await exportBackupData();
      expect(typeof jsonStr).toBe('string');

      const parsed = JSON.parse(jsonStr);
      expect(parsed).toHaveProperty('version');
      expect(parsed).toHaveProperty('exportedAt');
      expect(typeof parsed.exportedAt).toBe('string');
      // 驗證 ISO 日期字串格式
      expect(new Date(parsed.exportedAt).toISOString()).toBe(parsed.exportedAt);

      // 嚴格單一層級契約：根節點僅允許 version, exportedAt, data，不得含有任何資料表陣列
      expect(parsed).toHaveProperty('data');
      expect(parsed).not.toHaveProperty('expenses');
      expect(parsed).not.toHaveProperty('incomes');
      expect(parsed).not.toHaveProperty('rewards');
      expect(parsed).not.toHaveProperty('categories');
      expect(parsed).not.toHaveProperty('paymentMethods');
      expect(Object.keys(parsed).sort()).toEqual(['data', 'exportedAt', 'version']);

      // data 節點內必須完整包含四個表格陣列
      expect(Array.isArray(parsed.data.expenses)).toBe(true);
      expect(Array.isArray(parsed.data.incomes)).toBe(true);
      expect(Array.isArray(parsed.data.rewards)).toBe(true);
      expect(Array.isArray(parsed.data.categories)).toBe(true);
      expect(parsed.data.expenses.length).toBe(0);
      expect(parsed.data.incomes.length).toBe(0);
      expect(parsed.data.rewards.length).toBe(0);
      expect(parsed.data.categories.length).toBe(0);
    });

    it('資料庫有支出、收入與回饋時，應能完整將所有資料導出為 JSON', async () => {
      // 注入資料
      for (const e of mockExpenses) await db.expenses.add(e);
      for (const i of mockIncomes) await db.incomes.add(i);
      for (const r of mockRewards) await db.rewards.add(r);

      const jsonStr = await exportBackupData();
      const parsed = JSON.parse(jsonStr);

      // 驗證根節點無資料表陣列
      expect(parsed).not.toHaveProperty('expenses');
      expect(parsed).not.toHaveProperty('incomes');
      expect(parsed).not.toHaveProperty('rewards');
      expect(parsed).not.toHaveProperty('categories');
      expect(parsed).not.toHaveProperty('paymentMethods');

      expect(parsed.data.expenses).toHaveLength(2);
      expect(parsed.data.incomes).toHaveLength(2);
      expect(parsed.data.rewards).toHaveLength(1);
      expect(Array.isArray(parsed.data.categories)).toBe(true);

      // 驗證明細項與外幣屬性是否完整保留
      expect(parsed.data.expenses[0].merchant).toBe('統一超商');
      expect(parsed.data.expenses[0].items).toHaveLength(3);
      expect(parsed.data.expenses[1].isForeign).toBe(true);
      expect(parsed.data.incomes[0].amount).toBe(60000);
      expect(parsed.data.rewards[0].sourceName).toBe('台新黑狗卡回饋');
    });

    it('應能支援傳入自訂的 dbInstance', async () => {
      const customDb = new TrackerDatabase();
      await customDb.expenses.clear();
      await customDb.incomes.clear();
      await customDb.rewards.clear();

      await customDb.expenses.add(mockExpenses[0]);

      const jsonStr = await exportBackupData(customDb);
      const parsed = JSON.parse(jsonStr);

      expect(parsed).not.toHaveProperty('expenses');
      expect(parsed.data.expenses).toHaveLength(1);
      expect(parsed.data.expenses[0].merchant).toBe('統一超商');

      // 預設 db 應該仍是空的
      const defaultExpenses = await db.expenses.toArray();
      expect(defaultExpenses).toHaveLength(0);

      await customDb.delete();
    });

    it('exportBackupData 匯出 JSON 應包含完整 categories 資料表 (含預設與自訂分類)', async () => {
      // 確保至少有一筆自訂分類
      await (db as any).categories.add({
        name: '特設自訂分類',
        type: 'expense',
        isDefault: false,
      });

      const jsonStr = await exportBackupData(db);
      const parsed = JSON.parse(jsonStr);

      // 檢查 root 層不含 categories，僅在 data 層包含完整 categories
      expect(parsed.data).toBeDefined();
      expect(Array.isArray(parsed.data.categories)).toBe(true);
      expect(parsed.data.categories.length).toBeGreaterThan(0);
      expect(parsed).not.toHaveProperty('categories');
      expect(parsed).not.toHaveProperty('expenses');
      expect(parsed).not.toHaveProperty('incomes');
      expect(parsed).not.toHaveProperty('rewards');
      expect(parsed).not.toHaveProperty('paymentMethods');

      const hasCustom = parsed.data.categories.some(
        (c: CategoryRecord) => c.name === '特設自訂分類' && c.isDefault === false
      );
      expect(hasCustom).toBe(true);
    });
  });

  describe('importBackupData 資料驗證與錯誤處理', () => {
    it('傳入非合法 JSON 字串時應失敗（回傳 success: false 或拋出 Error）', async () => {
      const invalidJson = '{ not-a-valid-json';
      let errorThrown = false;
      let result;

      try {
        result = await importBackupData(invalidJson);
      } catch (err) {
        errorThrown = true;
      }

      // 滿足「拋出 Error 或回傳 success: false」
      if (!errorThrown) {
        expect(result?.success).toBe(false);
      } else {
        expect(errorThrown).toBe(true);
      }
    });

    it('傳入缺少 version 或 data 或 data 結構不完整的 JSON 時應失敗', async () => {
      const malformedPayloads = [
        JSON.stringify({ exportedAt: new Date().toISOString() }), // 缺少 version, data
        JSON.stringify({ version: 1, exportedAt: new Date().toISOString() }), // 缺少 data
        JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), data: 'not an object' }),
        JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), data: { expenses: 'invalid' } }),
        JSON.stringify({
          version: 1,
          exportedAt: new Date().toISOString(),
          data: { expenses: [], incomes: [], rewards: [] }, // 缺少 categories
        }),
        JSON.stringify({
          version: 1,
          exportedAt: new Date().toISOString(),
          data: { expenses: [], incomes: [], rewards: [], categories: 'not-an-array' },
        }),
      ];

      for (const payload of malformedPayloads) {
        let errorThrown = false;
        let result;
        try {
          result = await importBackupData(payload);
        } catch {
          errorThrown = true;
        }

        if (!errorThrown) {
          expect(result?.success).toBe(false);
        } else {
          expect(errorThrown).toBe(true);
        }
      }
    });
  });

  describe('importBackupData overwrite 覆寫模式 (預設行為)', () => {
    it('未指定 mode 時預設為 overwrite，應先清空現有資料再匯入備份資料', async () => {
      // 先向 db 寫入原有舊資料
      await db.expenses.add({
        date: '2026-10-01',
        merchant: '舊有的商店',
        paymentMethod: '現金',
        totalAmount: 100,
        isForeign: false,
        items: [],
        createdAt: 1727740800000,
        updatedAt: 1727740800000,
      });

      const backupPayload = JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
          expenses: mockExpenses,
          incomes: mockIncomes,
          rewards: mockRewards,
          categories: [],
          paymentMethods: [],
        },
      });

      const res = await importBackupData(backupPayload);
      expect(res.success).toBe(true);
      expect(res.importedCount).toMatchObject({
        expenses: 2,
        incomes: 2,
        rewards: 1,
        categories: 0,
      });

      // 檢查資料庫內容：舊有的商店應已被清空
      const currentExpenses = await db.expenses.toArray();
      expect(currentExpenses).toHaveLength(2);
      expect(currentExpenses.some((e) => e.merchant === '舊有的商店')).toBe(false);
      expect(currentExpenses.some((e) => e.merchant === '統一超商')).toBe(true);

      const currentIncomes = await db.incomes.toArray();
      expect(currentIncomes).toHaveLength(2);

      const currentRewards = await db.rewards.toArray();
      expect(currentRewards).toHaveLength(1);
    });

    it('明確指定 mode 为 overwrite 時，應正確覆寫', async () => {
      await db.incomes.add({
        date: '2026-10-05',
        source: '舊收入',
        account: '舊帳戶',
        category: '兼職',
        amount: 5000,
        isForeign: false,
        fee: 0,
        createdAt: 1728086400000,
        updatedAt: 1728086400000,
      });

      const backupPayload = JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
          expenses: [],
          incomes: mockIncomes,
          rewards: [],
          categories: [],
          paymentMethods: [],
        },
      });

      const res = await importBackupData(backupPayload, 'overwrite');
      expect(res.success).toBe(true);
      expect(res.importedCount.incomes).toBe(2);
      expect(res.importedCount.categories).toBe(0);

      const incomes = await db.incomes.toArray();
      expect(incomes).toHaveLength(2);
      expect(incomes.some((i) => i.source === '舊收入')).toBe(false);
    });

    it('importBackupData overwrite 模式應能還原 categories 並覆寫舊有分類', async () => {
      // 原有分類中加入舊自訂分類
      await (db as any).categories.add({
        name: '舊有即將被清空的分類',
        type: 'expense',
        isDefault: false,
      });

      const backupPayload = JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
          expenses: [],
          incomes: [],
          rewards: [],
          categories: [
            { name: '新還原的支出分類', type: 'expense', isDefault: false },
            { name: '新還原的收入分類', type: 'income', isDefault: false },
          ],
          paymentMethods: [],
        },
      });

      const res = await importBackupData(backupPayload, 'overwrite');
      expect(res.success).toBe(true);
      expect(res.importedCount.categories).toBe(2);

      const currentCategories = await (db as any).categories.toArray();
      expect(currentCategories).toHaveLength(2);
      expect(currentCategories.some((c: CategoryRecord) => c.name === '舊有即將被清空的分類')).toBe(false);
      expect(currentCategories.some((c: CategoryRecord) => c.name === '新還原的支出分類')).toBe(true);
      expect(currentCategories.some((c: CategoryRecord) => c.name === '新還原的收入分類')).toBe(true);
    });
  });

  describe('importBackupData merge 合併模式', () => {
    it('指定 mode: merge 時，應保留現有資料並追加新匯入之資料', async () => {
      // 寫入原有資料
      await db.expenses.add({
        date: '2026-10-01',
        merchant: '原有支出商店',
        paymentMethod: '現金',
        totalAmount: 200,
        isForeign: false,
        items: [],
        createdAt: 1727740800000,
        updatedAt: 1727740800000,
      });

      const backupPayload = JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
          expenses: mockExpenses,
          incomes: mockIncomes,
          rewards: mockRewards,
          categories: [],
          paymentMethods: [],
        },
      });

      const res = await importBackupData(backupPayload, 'merge');
      expect(res.success).toBe(true);
      expect(res.importedCount).toMatchObject({
        expenses: 2,
        incomes: 2,
        rewards: 1,
        categories: 0,
      });

      const expenses = await db.expenses.toArray();
      expect(expenses).toHaveLength(3); // 原有 1 筆 + 匯入 2 筆
      expect(expenses.some((e) => e.merchant === '原有支出商店')).toBe(true);
      expect(expenses.some((e) => e.merchant === '統一超商')).toBe(true);

      const incomes = await db.incomes.toArray();
      expect(incomes).toHaveLength(2);
    });

    it('merge 模式下，若匯入資料帶有現存 id，應重新指派新 id 或安全自增，不產生主鍵衝突也不覆蓋既有資料', async () => {
      // 先加入一筆 id 為 1 的記錄
      const existingId = await db.expenses.add({
        date: '2026-10-01',
        merchant: '既有ID為1的記錄',
        paymentMethod: '現金',
        totalAmount: 50,
        isForeign: false,
        items: [],
        createdAt: 1727740800000,
        updatedAt: 1727740800000,
      });
      expect(existingId).toBe(1);

      // 備份中也有 id 為 1 的記錄 (mockExpenses[0].id === 1)
      const backupPayload = JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
          expenses: [mockExpenses[0]],
          incomes: [],
          rewards: [],
          categories: [],
          paymentMethods: [],
        },
      });

      const res = await importBackupData(backupPayload, 'merge');
      expect(res.success).toBe(true);

      const expenses = await db.expenses.toArray();
      expect(expenses).toHaveLength(2);

      // 原有記錄依然存在
      const original = expenses.find((e) => e.merchant === '既有ID為1的記錄');
      expect(original).toBeDefined();

      // 新匯入的記錄也存在，且兩者 id 不相同
      const imported = expenses.find((e) => e.merchant === '統一超商');
      expect(imported).toBeDefined();
      expect(imported?.id).not.toBe(original?.id);
    });

    it('importBackupData merge 模式應能正確追加新分類並對重複同名同類型分類去重', async () => {
      // 先清空預設 db categories 並建立指定基準資料
      await (db as any).categories.clear();
      await (db as any).categories.bulkAdd([
        { name: '餐飲食品', type: 'expense', isDefault: true },
        { name: '既有專屬分類', type: 'expense', isDefault: false },
      ]);

      const backupPayload = JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
          expenses: [],
          incomes: [],
          rewards: [],
          categories: [
            { name: '餐飲食品', type: 'expense', isDefault: true }, // 重複，應略過
            { name: '全新匯入分類', type: 'expense', isDefault: false }, // 新分類，應追加
            { name: '餐飲食品', type: 'income', isDefault: false }, // 名稱相同但類型不同，應允許新增
          ],
          paymentMethods: [],
        },
      });

      const res = await importBackupData(backupPayload, 'merge');
      expect(res.success).toBe(true);
      expect(res.importedCount.categories).toBe(3);

      const allCategories = await (db as any).categories.toArray();
      // 應有：餐飲食品(expense)、既有專屬分類(expense)、全新匯入分類(expense)、餐飲食品(income) 共 4 筆
      expect(allCategories).toHaveLength(4);

      const dupExpense = allCategories.filter((c: CategoryRecord) => c.name === '餐飲食品' && c.type === 'expense');
      expect(dupExpense).toHaveLength(1);

      expect(allCategories.some((c: CategoryRecord) => c.name === '全新匯入分類')).toBe(true);
      expect(allCategories.some((c: CategoryRecord) => c.name === '既有專屬分類')).toBe(true);
      expect(allCategories.some((c: CategoryRecord) => c.name === '餐飲食品' && c.type === 'income')).toBe(true);
    });
  });

  describe('單一契約驗證與異常格式防禦 (Contract Validation & No Downward Compatibility)', () => {
    it('importBackupData 還原缺少 categories 的舊版備份檔案時應視為無效格式並拒絕還原（回傳驗證錯誤，不支援向下相容 fallback）', async () => {
      // 確保目前資料庫中有分類
      await (db as any).categories.add({ name: '既有分類', type: 'expense', isDefault: true });
      const beforeCount = await (db as any).categories.count();
      expect(beforeCount).toBeGreaterThan(0);

      // 構造完全不含 categories 的舊版資料
      const legacyBackupPayload = JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
          expenses: mockExpenses,
          incomes: mockIncomes,
          rewards: mockRewards,
        },
      });

      const res = await importBackupData(legacyBackupPayload, 'overwrite');
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/categories|缺少或無效/i);

      // 驗證拒絕還原後既有分類依然健全，未被 overwrite 清空或更動
      const afterCount = await (db as any).categories.count();
      expect(afterCount).toBe(beforeCount);
    });

    it('importBackupData 當 categories 欄位型態不為陣列時應回傳格式錯誤', async () => {
      const invalidPayload = JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
          expenses: [],
          incomes: [],
          rewards: [],
          categories: 'not-an-array',
          paymentMethods: [],
        },
      });

      const res = await importBackupData(invalidPayload);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/categories 必須為陣列/);
    });

    it('importBackupData 若缺少 expenses、incomes 或 rewards 任一資料表時均應拒絕還原', async () => {
      const missingExpenses = JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
          incomes: [],
          rewards: [],
          categories: [],
          paymentMethods: [],
        },
      });

      const res = await importBackupData(missingExpenses);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/expenses|缺少或無效/i);
    });
  });

  describe('支付方式 (paymentMethods) 匯出與還原支援', () => {
    it('exportBackupData 匯出的 JSON 應完整包含 data.paymentMethods 陣列', async () => {
      await db.paymentMethods.bulkAdd([
        { id: 1, name: '街口支付', isDefault: false },
        { id: 2, name: 'LINE Pay', isDefault: false },
      ]);

      const jsonStr = await exportBackupData();
      const parsed = JSON.parse(jsonStr);

      expect(parsed).not.toHaveProperty('paymentMethods');
      expect(Array.isArray(parsed.data.paymentMethods)).toBe(true);
      expect(parsed.data.paymentMethods).toHaveLength(2);
      expect(parsed.data.paymentMethods.map((p: any) => p.name)).toContain('街口支付');
    });

    it('importBackupData merge 模式支援同名支付方式安全去重追加', async () => {
      await db.paymentMethods.bulkAdd([
        { id: 1, name: '現金', isDefault: true },
        { id: 2, name: '玉山信用卡', isDefault: false },
      ]);

      const backupPayload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
          expenses: [],
          incomes: [],
          rewards: [],
          categories: [],
          paymentMethods: [
            { id: 99, name: '現金', isDefault: true },
            { id: 100, name: '街口支付', isDefault: false },
          ],
        },
      };

      const result = await importBackupData(JSON.stringify(backupPayload), 'merge');
      expect(result.success).toBe(true);

      const allMethods = await db.paymentMethods.toArray();
      expect(allMethods).toHaveLength(3);
      expect(allMethods.filter((m: any) => m.name === '現金')).toHaveLength(1);
      expect(allMethods.some((m: any) => m.name === '街口支付')).toBe(true);
    });
  });

  describe('端到端匯出與還原往返 (Roundtrip)', () => {
    it('匯出完整資料庫後，於另一個資料庫實例完整還原，所有數據欄位應完全一致', async () => {
      // 1. 在預設 db 中塞入多筆資料
      for (const e of mockExpenses) await db.expenses.add(e);
      for (const i of mockIncomes) await db.incomes.add(i);
      for (const r of mockRewards) await db.rewards.add(r);
      await (db as any).categories.add({ name: '餐飲食品', type: 'expense', isDefault: true });

      // 2. 匯出
      const backupJson = await exportBackupData(db);

      // 3. 建立目標資料庫並執行還原
      const targetDb = new TrackerDatabase();
      await targetDb.expenses.clear();
      await targetDb.incomes.clear();
      await targetDb.rewards.clear();
      await (targetDb as any).categories.clear();

      const importResult = await importBackupData(backupJson, 'overwrite', targetDb);
      expect(importResult.success).toBe(true);
      expect(importResult.importedCount).toMatchObject({
        expenses: 2,
        incomes: 2,
        rewards: 1,
        categories: expect.any(Number),
      });

      // 4. 驗證目標資料庫與原資料
      const restoredExpenses = await targetDb.expenses.toArray();
      const restoredIncomes = await targetDb.incomes.toArray();
      const restoredRewards = await targetDb.rewards.toArray();
      const restoredCategories = await (targetDb as any).categories.toArray();

      expect(restoredExpenses).toHaveLength(2);
      expect(restoredIncomes).toHaveLength(2);
      expect(restoredRewards).toHaveLength(1);
      expect(restoredCategories.length).toBeGreaterThan(0);

      // 比對內容深度細節
      expect(restoredExpenses[0].merchant).toBe(mockExpenses[0].merchant);
      expect(restoredExpenses[0].items).toEqual(mockExpenses[0].items);
      expect(restoredExpenses[1].currency).toBe('JPY');
      expect(restoredExpenses[1].fee).toBe(16);

      expect(restoredIncomes[1].source).toBe('美股股利');
      expect(restoredIncomes[1].exchangeRate).toBe(32.0);

      expect(restoredRewards[0].sourceName).toBe('台新黑狗卡回饋');
      expect(restoredRewards[0].amount).toBe(350);

      await targetDb.delete();
    });
  });
});
