/**
 * @file settings_db.spec.ts
 * @description Sand Dollar 設定頁面所需資料庫操作與 CRUD 函式單元測試
 * 涵蓋分類 (categories)、支付方式 (paymentMethods)、收入來源 (incomeSources)、
 * 回饋來源 (rewardSources) 之 CRUD 操作，以及清空全庫資料 (clearAllDatabaseData)。
 */

import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, it, expect, beforeEach } from 'vitest';
import * as dbModule from '@/db';
import {
  db,
  TrackerDatabase,
  updateCategory,
  deleteCategory,
  addCategory,
  getCategories,
  getPaymentMethodRecords,
  addPaymentMethod,
  updatePaymentMethod,
  deletePaymentMethod,
  getIncomeSourceRecords,
  addIncomeSource,
  updateIncomeSource,
  deleteIncomeSource,
  getDistinctIncomeSources,
  getRewardSourceRecords,
  addRewardSource,
  updateRewardSource,
  deleteRewardSource,
  clearAllDatabaseData,
  clearMerchantItemsCache,
  cacheMerchantItems,
  getItemsByMerchant,
  addExpense,
  getExpenses,
  addIncome,
  getIncomes,
  addReward,
  getRewards,
} from '@/db';

describe('Sand Dollar 設定頁面資料庫 CRUD 與全庫清空單元測試 (settings_db.spec.ts)', () => {
  beforeEach(async () => {
    // 每個測試執行前清空資料庫與記憶體快取，確保測試環境完全隔離
    await clearAllDatabaseData();
    clearMerchantItemsCache();
  });

  // ==========================================
  // 1. 分類管理 (Categories) CRUD 測試
  // ==========================================
  describe('分類管理 (Categories) 更新與刪除操作', () => {
    it('updateCategory 應能正常更新指定分類名稱並回傳受影響筆數 1', async () => {
      const id = await addCategory({ name: '午餐', type: 'expense', isDefault: false });
      const affected = await updateCategory(id, '早午餐');

      expect(affected).toBe(1);
      const list = await getCategories('expense');
      const updated = list.find((c) => c.id === id);
      expect(updated?.name).toBe('早午餐');
    });

    it('updateCategory 傳入帶有前後空白之名稱時，應自動進行 trim 修剪', async () => {
      const id = await addCategory({ name: '晚餐', type: 'expense', isDefault: false });
      const affected = await updateCategory(id, '   美味晚餐   ');

      expect(affected).toBe(1);
      const list = await getCategories('expense');
      const updated = list.find((c) => c.id === id);
      expect(updated?.name).toBe('美味晚餐');
    });

    it('updateCategory 傳入空字串或純空白字串時，應防呆拋出錯誤', async () => {
      const id = await addCategory({ name: '點心', type: 'expense', isDefault: false });

      await expect(updateCategory(id, '')).rejects.toThrow('分類名稱不可為空');
      await expect(updateCategory(id, '    ')).rejects.toThrow('分類名稱不可為空');

      // 確認原始資料未被修改
      const list = await getCategories('expense');
      const record = list.find((c) => c.id === id);
      expect(record?.name).toBe('點心');
    });

    it('updateCategory 自身同名允許正常更新不拋錯', async () => {
      const id = await addCategory({ name: '交通', type: 'expense', isDefault: false });
      const affected = await updateCategory(id, '交通');

      expect(affected).toBe(1);
      const list = await getCategories('expense');
      expect(list.find((c) => c.id === id)?.name).toBe('交通');
    });

    it('updateCategory 同類型下多筆分類更新彼此獨立互不干擾', async () => {
      const id1 = await addCategory({ name: '捷運', type: 'expense', isDefault: false });
      const id2 = await addCategory({ name: '公車', type: 'expense', isDefault: false });

      await updateCategory(id1, '高鐵');

      const list = await getCategories('expense');
      expect(list.find((c) => c.id === id1)?.name).toBe('高鐵');
      expect(list.find((c) => c.id === id2)?.name).toBe('公車');
    });

    it('updateCategory 對不存在之分類 ID 執行更新時應安全回傳受影響筆數 0', async () => {
      const affected = await updateCategory(99999, '不存在的分類');
      expect(affected).toBe(0);
    });

    it('updateCategory 若更新目標名稱與同一 type 下之其他分類重複時，必須拋出錯誤且不更動資料', async () => {
      const id1 = await addCategory({ name: '餐飲', type: 'expense', isDefault: false });
      const id2 = await addCategory({ name: '交通', type: 'expense', isDefault: false });

      // 嘗試將 id2 更新為已存在的同類型名稱 '餐飲'
      await expect(updateCategory(id2, '餐飲')).rejects.toThrow(/已存在/);
      await expect(updateCategory(id2, '  餐飲  ')).rejects.toThrow(/已存在/);

      // 確認原始資料未被異動
      const list = await getCategories('expense');
      expect(list.find((c) => c.id === id2)?.name).toBe('交通');
    });

    it('updateCategory 若更新名稱與不同 type 之分類名稱相同時，應允許正常更新', async () => {
      // 收入分類已有「投資」
      await addCategory({ name: '投資', type: 'income', isDefault: false });
      // 支出分類新增「理財」
      const expId = await addCategory({ name: '理財', type: 'expense', isDefault: false });

      // 將支出分類「理財」更新為「投資」，因為 type 不同，應允許成功
      const affected = await updateCategory(expId, '投資');
      expect(affected).toBe(1);

      const expList = await getCategories('expense');
      expect(expList.find((c) => c.id === expId)?.name).toBe('投資');
    });

    it('updateCategory 修改支出分類成功時，所有歷史 expenses 記錄中品項 category 必須被同步批次替換', async () => {
      const catId = await addCategory({ name: '餐飲', type: 'expense', isDefault: false });

      // 建立包含 '餐飲' 與其他分類品項的歷史支出記錄
      await addExpense({
        date: '2026-11-01',
        merchant: '麥當勞',
        paymentMethod: '現金',
        totalAmount: 200,
        isForeign: false,
        items: [
          { id: '1', type: 'item', name: '大麥克套餐', quantity: 1, unitPrice: 150, subtotal: 150, category: '餐飲' },
          { id: '2', type: 'item', name: '環保袋', quantity: 1, unitPrice: 50, subtotal: 50, category: '生活' },
        ],
      });
      await addExpense({
        date: '2026-11-02',
        merchant: '肯德基',
        paymentMethod: '信用卡',
        totalAmount: 180,
        isForeign: false,
        items: [
          { id: '3', type: 'item', name: '蛋撻禮盒', quantity: 1, unitPrice: 180, subtotal: 180, category: '餐飲' },
        ],
      });

      // 將「餐飲」更新為「飲食」
      const affected = await updateCategory(catId, '飲食');
      expect(affected).toBe(1);

      // 驗證歷史支出記錄中的品項分類是否已批次替換
      const expenses = await getExpenses();
      const exp1 = expenses.find((e) => e.merchant === '麥當勞');
      const exp2 = expenses.find((e) => e.merchant === '肯德基');

      expect(exp1?.items[0].category).toBe('飲食');
      expect(exp1?.items[1].category).toBe('生活');
      expect(exp2?.items[0].category).toBe('飲食');
    });

    it('updateCategory 修改收入分類成功時，所有歷史 incomes 記錄中 category 必須被同步批次替換', async () => {
      const catId = await addCategory({ name: '獎金', type: 'income', isDefault: false });

      await addIncome({
        date: '2026-11-01',
        source: '公司',
        category: '獎金',
        amount: 20000,
        isForeign: false,
      });
      await addIncome({
        date: '2026-11-02',
        source: '公司',
        category: '薪資',
        amount: 60000,
        isForeign: false,
      });

      // 將「獎金」更新為「業績獎金」
      const affected = await updateCategory(catId, '業績獎金');
      expect(affected).toBe(1);

      // 驗證歷史收入記錄中的 category 是否已批次替換
      const incomes = await getIncomes();
      const inc1 = incomes.find((i) => i.amount === 20000);
      const inc2 = incomes.find((i) => i.amount === 60000);

      expect(inc1?.category).toBe('業績獎金');
      expect(inc2?.category).toBe('薪資');
    });

    it('deleteCategory 應能成功刪除指定 ID 之分類記錄', async () => {
      const id = await addCategory({ name: '電影', type: 'expense', isDefault: false });
      let list = await getCategories('expense');
      expect(list.some((c) => c.id === id)).toBe(true);

      await deleteCategory(id);

      list = await getCategories('expense');
      expect(list.some((c) => c.id === id)).toBe(false);
    });

    it('deleteCategory 刪除不存在之分類 ID 時應安全完成不報錯', async () => {
      await expect(deleteCategory(99999)).resolves.not.toThrow();
    });
  });

  // ==========================================
  // 2. 支付方式管理 (PaymentMethods) CRUD 測試
  // ==========================================
  describe('支付方式管理 (PaymentMethods) CRUD 操作', () => {
    it('getPaymentMethodRecords 在資料庫無資料時應回傳空陣列', async () => {
      const records = await getPaymentMethodRecords();
      expect(records).toEqual([]);
    });

    it('addPaymentMethod 應能成功新增自訂支付方式並回傳自動遞增 ID', async () => {
      const id1 = await addPaymentMethod('信用卡');
      const id2 = await addPaymentMethod('行動支付');

      expect(id1).toBe(1);
      expect(id2).toBe(2);

      const records = await getPaymentMethodRecords();
      expect(records.length).toBe(2);
      expect(records[0]).toMatchObject({ id: 1, name: '信用卡', isDefault: false });
      expect(records[1]).toMatchObject({ id: 2, name: '行動支付', isDefault: false });
    });

    it('addPaymentMethod 傳入空白時應自動 Fallback 為「現金」', async () => {
      const id = await addPaymentMethod('   ');
      expect(id).toBe(1);

      const records = await getPaymentMethodRecords();
      expect(records[0].name).toBe('現金');
    });

    it('addPaymentMethod 新增重複之支付方式名稱時應防呆拋出錯誤', async () => {
      await addPaymentMethod('悠遊卡');

      await expect(addPaymentMethod('悠遊卡')).rejects.toThrow('支付方式「悠遊卡」已存在');
      await expect(addPaymentMethod('  悠遊卡  ')).rejects.toThrow('支付方式「悠遊卡」已存在');
    });

    it('updatePaymentMethod 應能正常更新支付方式名稱並回傳受影響筆數 1', async () => {
      const id = await addPaymentMethod('舊卡');
      const affected = await updatePaymentMethod(id, '新卡');

      expect(affected).toBe(1);
      const records = await getPaymentMethodRecords();
      expect(records.find((r) => r.id === id)?.name).toBe('新卡');
    });

    it('updatePaymentMethod 傳入帶前後空白之名稱時應自動進行 trim 修剪', async () => {
      const id = await addPaymentMethod('銀行轉帳');
      const affected = await updatePaymentMethod(id, '   網銀轉帳   ');

      expect(affected).toBe(1);
      const records = await getPaymentMethodRecords();
      expect(records.find((r) => r.id === id)?.name).toBe('網銀轉帳');
    });

    it('updatePaymentMethod 傳入空字串或純空白字串時應防呆拋出錯誤', async () => {
      const id = await addPaymentMethod('零錢');

      await expect(updatePaymentMethod(id, '')).rejects.toThrow('支付方式名稱不可為空');
      await expect(updatePaymentMethod(id, '    ')).rejects.toThrow('支付方式名稱不可為空');

      const records = await getPaymentMethodRecords();
      expect(records.find((r) => r.id === id)?.name).toBe('零錢');
    });

    it('updatePaymentMethod 自身同名更新時允許正常更新不拋錯', async () => {
      const id = await addPaymentMethod('LINE Pay');
      const affected = await updatePaymentMethod(id, 'LINE Pay');

      expect(affected).toBe(1);
      const records = await getPaymentMethodRecords();
      expect(records.find((r) => r.id === id)?.name).toBe('LINE Pay');
    });

    it('updatePaymentMethod 對不存在之 ID 更新時回傳 0', async () => {
      const affected = await updatePaymentMethod(99999, '不存在的支付方式');
      expect(affected).toBe(0);
    });

    it('updatePaymentMethod 若目標名稱與其他既有支付方式重複時，必須拋出錯誤且不更動資料', async () => {
      const id1 = await addPaymentMethod('現金');
      const id2 = await addPaymentMethod('信用卡');

      await expect(updatePaymentMethod(id2, '現金')).rejects.toThrow(/已存在/);
      await expect(updatePaymentMethod(id2, '   現金   ')).rejects.toThrow(/已存在/);

      const records = await getPaymentMethodRecords();
      expect(records.find((r) => r.id === id2)?.name).toBe('信用卡');
    });

    it('updatePaymentMethod 更新成功時，所有歷史 expenses 記錄中 paymentMethod 必須被同步批次替換', async () => {
      const payId = await addPaymentMethod('現金');

      await addExpense({
        date: '2026-11-01',
        merchant: '7-11',
        paymentMethod: '現金',
        totalAmount: 100,
        isForeign: false,
        items: [],
      });
      await addExpense({
        date: '2026-11-02',
        merchant: '全家',
        paymentMethod: '信用卡',
        totalAmount: 150,
        isForeign: false,
        items: [],
      });

      // 將「現金」更新為「實體現金」
      const affected = await updatePaymentMethod(payId, '實體現金');
      expect(affected).toBe(1);

      // 驗證歷史支出記錄中的 paymentMethod 是否已同步變更
      const expenses = await getExpenses();
      const exp1 = expenses.find((e) => e.merchant === '7-11');
      const exp2 = expenses.find((e) => e.merchant === '全家');

      expect(exp1?.paymentMethod).toBe('實體現金');
      expect(exp2?.paymentMethod).toBe('信用卡');
    });

    it('deletePaymentMethod 應能成功刪除指定 ID 之支付方式記錄', async () => {
      const id = await addPaymentMethod('街口支付');
      let records = await getPaymentMethodRecords();
      expect(records.some((r) => r.id === id)).toBe(true);

      await deletePaymentMethod(id);

      records = await getPaymentMethodRecords();
      expect(records.some((r) => r.id === id)).toBe(false);
    });

    it('deletePaymentMethod 刪除不存在之 ID 時應安全完成不報錯', async () => {
      await expect(deletePaymentMethod(99999)).resolves.not.toThrow();
    });
  });

  // ==========================================
  // 3. 收入來源管理 (IncomeSources) CRUD 測試
  // ==========================================
  describe('收入來源管理 (IncomeSources) CRUD 操作', () => {
    it('getIncomeSourceRecords 在資料庫無資料時應回傳空陣列', async () => {
      const records = await getIncomeSourceRecords();
      expect(records).toEqual([]);
    });

    it('addIncomeSource 應能成功新增自訂收入來源並回傳自動遞增 ID', async () => {
      const id1 = await addIncomeSource('正職月薪');
      const id2 = await addIncomeSource('股票股利');

      expect(id1).toBe(1);
      expect(id2).toBe(2);

      const records = await getIncomeSourceRecords();
      expect(records.length).toBe(2);
      expect(records[0]).toMatchObject({ id: 1, name: '正職月薪', isDefault: false });
      expect(records[1]).toMatchObject({ id: 2, name: '股票股利', isDefault: false });
    });

    it('addIncomeSource 傳入空字串或純空白時必須拒絕並拋出錯誤，嚴禁 fallback 為「薪資」', async () => {
      await expect(addIncomeSource('')).rejects.toThrow(/不可為空/);
      await expect(addIncomeSource('   ')).rejects.toThrow(/不可為空/);

      // 確認未寫入任何 fallback 資料
      const records = await getIncomeSourceRecords();
      expect(records).toEqual([]);
    });

    it('addIncomeSource 新增重複之收入來源名稱時應防呆拋出錯誤', async () => {
      await addIncomeSource('兼職接案');

      await expect(addIncomeSource('兼職接案')).rejects.toThrow('收入來源「兼職接案」已存在');
      await expect(addIncomeSource('  兼職接案  ')).rejects.toThrow('收入來源「兼職接案」已存在');
    });

    it('updateIncomeSource 應能正常更新收入來源名稱並回傳受影響筆數 1', async () => {
      const id = await addIncomeSource('專案獎金');
      const affected = await updateIncomeSource(id, '年終獎金');

      expect(affected).toBe(1);
      const records = await getIncomeSourceRecords();
      expect(records.find((r) => r.id === id)?.name).toBe('年終獎金');
    });

    it('updateIncomeSource 傳入帶前後空白之名稱時應自動進行 trim 修剪', async () => {
      const id = await addIncomeSource('租金');
      const affected = await updateIncomeSource(id, '   房屋租金   ');

      expect(affected).toBe(1);
      const records = await getIncomeSourceRecords();
      expect(records.find((r) => r.id === id)?.name).toBe('房屋租金');
    });

    it('updateIncomeSource 傳入空字串或純空白字串時應防呆拋出錯誤', async () => {
      const id = await addIncomeSource('稿費');

      await expect(updateIncomeSource(id, '')).rejects.toThrow('收入來源名稱不可為空');
      await expect(updateIncomeSource(id, '    ')).rejects.toThrow('收入來源名稱不可為空');

      const records = await getIncomeSourceRecords();
      expect(records.find((r) => r.id === id)?.name).toBe('稿費');
    });

    it('updateIncomeSource 自身同名更新時允許正常更新不拋錯', async () => {
      const id = await addIncomeSource('利息收入');
      const affected = await updateIncomeSource(id, '利息收入');

      expect(affected).toBe(1);
      const records = await getIncomeSourceRecords();
      expect(records.find((r) => r.id === id)?.name).toBe('利息收入');
    });

    it('updateIncomeSource 對不存在之 ID 更新時回傳 0', async () => {
      const affected = await updateIncomeSource(99999, '不存在的收入來源');
      expect(affected).toBe(0);
    });

    it('updateIncomeSource 若目標名稱與其他既有收入來源重複時，必須拋出錯誤且不更動資料', async () => {
      const id1 = await addIncomeSource('薪水');
      const id2 = await addIncomeSource('股票股利');

      await expect(updateIncomeSource(id2, '薪水')).rejects.toThrow(/已存在/);
      await expect(updateIncomeSource(id2, '   薪水   ')).rejects.toThrow(/已存在/);

      const records = await getIncomeSourceRecords();
      expect(records.find((r) => r.id === id2)?.name).toBe('股票股利');
    });

    it('updateIncomeSource 更新成功時，所有歷史 incomes 記錄中 source 必須被同步批次替換', async () => {
      const incId = await addIncomeSource('薪水');

      await addIncome({
        date: '2026-11-01',
        source: '薪水',
        category: '薪資',
        amount: 50000,
        isForeign: false,
      });
      await addIncome({
        date: '2026-11-02',
        source: '兼職',
        category: '兼職',
        amount: 8000,
        isForeign: false,
      });

      // 將「薪水」更新為「正職月薪」
      const affected = await updateIncomeSource(incId, '正職月薪');
      expect(affected).toBe(1);

      // 驗證歷史收入記錄中的 source 是否已同步變更
      const incomes = await getIncomes();
      const inc1 = incomes.find((i) => i.amount === 50000);
      const inc2 = incomes.find((i) => i.amount === 8000);

      expect(inc1?.source).toBe('正職月薪');
      expect(inc2?.source).toBe('兼職');
    });

    it('deleteIncomeSource 應能成功刪除指定 ID 之收入來源記錄', async () => {
      const id = await addIncomeSource('二手拍賣');
      let records = await getIncomeSourceRecords();
      expect(records.some((r) => r.id === id)).toBe(true);

      await deleteIncomeSource(id);

      records = await getIncomeSourceRecords();
      expect(records.some((r) => r.id === id)).toBe(false);
    });

    it('deleteIncomeSource 刪除不存在之 ID 時應安全完成不報錯', async () => {
      await expect(deleteIncomeSource(99999)).resolves.not.toThrow();
    });

    it('getDistinctIncomeSources 應只讀取 incomeSources 設定表，當自設定表刪除後立即不再出現（即使歷史表記錄中仍有該同名來源）', async () => {
      // 1. 新增設定表記錄
      const id1 = await addIncomeSource('薪資收入');
      const id2 = await addIncomeSource('外包接案');

      // 2. 建立包含「外包接案」與僅存在於歷史表記錄的「舊歷史收入」
      await addIncome({
        date: '2026-11-01',
        source: '外包接案',
        category: '薪資',
        amount: 25000,
        isForeign: false,
      });
      await addIncome({
        date: '2026-10-15',
        source: '舊歷史收入',
        category: '兼職',
        amount: 10000,
        isForeign: false,
      });

      // 3. 初始讀取：應只包含設定表之項目，歷史表記錄的「舊歷史收入」不應被讀出
      let distinct = await getDistinctIncomeSources();
      expect(distinct).toContain('薪資收入');
      expect(distinct).toContain('外包接案');
      expect(distinct).not.toContain('舊歷史收入');

      // 4. 自 incomeSources 設定表刪除「外包接案」
      await deleteIncomeSource(id2);

      // 5. 再次呼叫 getDistinctIncomeSources()，即使 incomes 表中仍有「外包接案」，也不應再出現
      distinct = await getDistinctIncomeSources();
      expect(distinct).toContain('薪資收入');
      expect(distinct).not.toContain('外包接案');
      expect(distinct).not.toContain('舊歷史收入');
    });

    it('getDistinctIncomeSources 當 incomeSources 設定表為空（0 筆）時，即使 incomes 歷史表記錄中存在多筆歷史來源，必須回傳空陣列 []，嚴禁回退讀取歷史表記錄', async () => {
      // 確保 incomeSources 設定表為空（0 筆）
      expect(await db.incomeSources.count()).toBe(0);

      // 寫入多筆歷史收入記錄（模擬曾有記帳歷史但設定表尚未建立或已被全部清空的情境）
      await addIncome({
        date: '2026-11-01',
        source: '歷史正職薪水',
        category: '薪資',
        amount: 50000,
        isForeign: false,
      });
      await addIncome({
        date: '2026-11-02',
        source: '歷史外包接案',
        category: '兼職',
        amount: 20000,
        isForeign: false,
      });

      // 驗證 incomes 表確實存在歷史資料
      expect(await db.incomes.count()).toBe(2);

      // 呼叫 getDistinctIncomeSources()，依據新規格必須回傳空陣列 []，嚴禁回退讀取 incomes 歷史記錄（防止刪除所有設定後歷史來源死灰復燃）
      const distinct = await getDistinctIncomeSources();
      expect(distinct).toEqual([]);
    });
  });

  // ==========================================
  // 4. 回饋來源管理 (RewardSources) CRUD 測試
  // ==========================================
  describe('回饋來源管理 (RewardSources) CRUD 操作', () => {
    it('getRewardSourceRecords 在資料庫無資料時應回傳空陣列', async () => {
      const records = await getRewardSourceRecords();
      expect(records).toEqual([]);
    });

    it('addRewardSource 應能成功新增自訂回饋來源並回傳自動遞增 ID', async () => {
      const id1 = await addRewardSource('LINE Points');
      const id2 = await addRewardSource('信用卡現金回饋');

      expect(id1).toBe(1);
      expect(id2).toBe(2);

      const records = await getRewardSourceRecords();
      expect(records.length).toBe(2);
      expect(records[0]).toMatchObject({ id: 1, name: 'LINE Points', isDefault: false });
      expect(records[1]).toMatchObject({ id: 2, name: '信用卡現金回饋', isDefault: false });
    });

    it('addRewardSource 傳入空字串或純空白時必須拒絕並拋出錯誤，嚴禁 fallback 為「一般回饋」', async () => {
      await expect(addRewardSource('')).rejects.toThrow(/不可為空/);
      await expect(addRewardSource('   ')).rejects.toThrow(/不可為空/);

      // 確認未寫入任何 fallback 資料
      const records = await getRewardSourceRecords();
      expect(records).toEqual([]);
    });

    it('addRewardSource 新增重複之回饋來源名稱時應防呆拋出錯誤', async () => {
      await addRewardSource('Pi拍錢包回饋');

      await expect(addRewardSource('Pi拍錢包回饋')).rejects.toThrow('回饋來源「Pi拍錢包回饋」已存在');
      await expect(addRewardSource('  Pi拍錢包回饋  ')).rejects.toThrow('回饋來源「Pi拍錢包回饋」已存在');
    });

    it('updateRewardSource 應能正常更新回饋來源名稱並回傳受影響筆數 1', async () => {
      const id = await addRewardSource('街口幣');
      const affected = await updateRewardSource(id, '全支付點數');

      expect(affected).toBe(1);
      const records = await getRewardSourceRecords();
      expect(records.find((r) => r.id === id)?.name).toBe('全支付點數');
    });

    it('updateRewardSource 傳入帶前後空白之名稱時應自動進行 trim 修剪', async () => {
      const id = await addRewardSource('悠遊付回饋');
      const affected = await updateRewardSource(id, '   悠遊付儲值金   ');

      expect(affected).toBe(1);
      const records = await getRewardSourceRecords();
      expect(records.find((r) => r.id === id)?.name).toBe('悠遊付儲值金');
    });

    it('updateRewardSource 傳入空字串或純空白字串時應防呆拋出錯誤', async () => {
      const id = await addRewardSource('紅利點數');

      await expect(updateRewardSource(id, '')).rejects.toThrow('回饋來源名稱不可為空');
      await expect(updateRewardSource(id, '    ')).rejects.toThrow('回饋來源名稱不可為空');

      const records = await getRewardSourceRecords();
      expect(records.find((r) => r.id === id)?.name).toBe('紅利點數');
    });

    it('updateRewardSource 自身同名更新時允許正常更新不拋錯', async () => {
      const id = await addRewardSource('OPENPOINT');
      const affected = await updateRewardSource(id, 'OPENPOINT');

      expect(affected).toBe(1);
      const records = await getRewardSourceRecords();
      expect(records.find((r) => r.id === id)?.name).toBe('OPENPOINT');
    });

    it('updateRewardSource 對不存在之 ID 更新時回傳 0', async () => {
      const affected = await updateRewardSource(99999, '不存在的回饋來源');
      expect(affected).toBe(0);
    });

    it('updateRewardSource 若目標名稱與其他既有回饋來源重複時，必須拋出錯誤且不更動資料', async () => {
      const id1 = await addRewardSource('街口幣');
      const id2 = await addRewardSource('LINE Points');

      await expect(updateRewardSource(id2, '街口幣')).rejects.toThrow(/已存在/);
      await expect(updateRewardSource(id2, '   街口幣   ')).rejects.toThrow(/已存在/);

      const records = await getRewardSourceRecords();
      expect(records.find((r) => r.id === id2)?.name).toBe('LINE Points');
    });

    it('updateRewardSource 更新成功時，所有歷史 rewards 記錄中 sourceName 必須被同步批次替換', async () => {
      const rewId = await addRewardSource('街口幣');

      await addReward({
        yearMonth: '2026-11',
        sourceName: '街口幣',
        amount: 120,
      });
      await addReward({
        yearMonth: '2026-11',
        sourceName: 'OPENPOINT',
        amount: 50,
      });

      // 將「街口幣」更新為「街口幣點數」
      const affected = await updateRewardSource(rewId, '街口幣點數');
      expect(affected).toBe(1);

      // 驗證歷史回饋記錄中的 sourceName 是否已同步變更
      const rewards = await getRewards();
      const rew1 = rewards.find((r) => r.amount === 120);
      const rew2 = rewards.find((r) => r.amount === 50);

      expect(rew1?.sourceName).toBe('街口幣點數');
      expect(rew2?.sourceName).toBe('OPENPOINT');
    });

    it('deleteRewardSource 應能成功刪除指定 ID 之回饋來源記錄', async () => {
      const id = await addRewardSource('HAPPY GO');
      let records = await getRewardSourceRecords();
      expect(records.some((r) => r.id === id)).toBe(true);

      await deleteRewardSource(id);

      records = await getRewardSourceRecords();
      expect(records.some((r) => r.id === id)).toBe(false);
    });

    it('deleteRewardSource 刪除不存在之 ID 時應安全完成不報錯', async () => {
      await expect(deleteRewardSource(99999)).resolves.not.toThrow();
    });

    it('getDistinctRewardSources 必須公開導出，且只讀取 rewardSources 設定表，當自設定表刪除後立即不再出現（即使歷史表記錄中仍有同名來源）', async () => {
      const getDistinctRewardSources = (dbModule as any).getDistinctRewardSources;
      expect(typeof getDistinctRewardSources, 'getDistinctRewardSources 必須為公開導出之函式').toBe('function');

      // 1. 新增設定表記錄
      const id1 = await addRewardSource('LINE Points');
      const id2 = await addRewardSource('街口幣');

      // 2. 建立包含「街口幣」與僅存在於歷史表的「舊全聯點數」之記錄
      await addReward({
        yearMonth: '2026-11',
        sourceName: '街口幣',
        amount: 150,
      });
      await addReward({
        yearMonth: '2026-10',
        sourceName: '舊全聯點數',
        amount: 80,
      });

      // 3. 初始讀取：應只包含設定表之項目，歷史表記錄的「舊全聯點數」不應出現
      let distinct = await getDistinctRewardSources();
      expect(distinct).toContain('LINE Points');
      expect(distinct).toContain('街口幣');
      expect(distinct).not.toContain('舊全聯點數');

      // 4. 自 rewardSources 設定表刪除「街口幣」
      await deleteRewardSource(id2);

      // 5. 再次呼叫 getDistinctRewardSources()，即使 rewards 歷史表記錄中仍有「街口幣」，也不應再出現
      distinct = await getDistinctRewardSources();
      expect(distinct).toContain('LINE Points');
      expect(distinct).not.toContain('街口幣');
      expect(distinct).not.toContain('舊全聯點數');
    });
  });

  // ==========================================
  // 5. 清空全庫資料 (clearAllDatabaseData) 與重設測試
  // ==========================================
  describe('全庫資料清空 (clearAllDatabaseData) 與計數器重設', () => {
    it('clearAllDatabaseData 應能一次清空 7 個資料表之全部內容', async () => {
      // 1. 在 7 個資料表中各填入一筆測試資料
      await addExpense({
        date: '2026-11-08',
        merchant: '7-11',
        paymentMethod: '現金',
        totalAmount: 100,
        isForeign: false,
        items: [],
      });
      await addIncome({
        date: '2026-11-08',
        source: '薪資',
        category: '薪資',
        amount: 50000,
        isForeign: false,
      });
      await addReward({
        yearMonth: '2026-11',
        sourceName: '信用卡',
        amount: 300,
      });
      await addCategory({ name: '測試分類', type: 'expense', isDefault: false });
      await addPaymentMethod('測試支付');
      await addIncomeSource('測試收入');
      await addRewardSource('測試回饋');

      // 驗證寫入成功
      expect(await db.expenses.count()).toBe(1);
      expect(await db.incomes.count()).toBe(1);
      expect(await db.rewards.count()).toBe(1);
      expect(await db.categories.count()).toBe(1);
      expect(await db.paymentMethods.count()).toBe(1);
      expect(await db.incomeSources.count()).toBe(1);
      expect(await db.rewardSources.count()).toBe(1);

      // 2. 執行全庫清空
      await clearAllDatabaseData();

      // 3. 驗證 7 個表格筆數全為 0
      expect(await db.expenses.count()).toBe(0);
      expect(await db.incomes.count()).toBe(0);
      expect(await db.rewards.count()).toBe(0);
      expect(await db.categories.count()).toBe(0);
      expect(await db.paymentMethods.count()).toBe(0);
      expect(await db.incomeSources.count()).toBe(0);
      expect(await db.rewardSources.count()).toBe(0);
    });

    it('clearAllDatabaseData 執行後，各表之 autoIncrement 計數器應重設，新增記錄由 ID 1 開始', async () => {
      // 填入並清空
      await addCategory({ name: '舊分類', type: 'expense', isDefault: false });
      await addPaymentMethod('舊支付');
      await addIncomeSource('舊收入');
      await addRewardSource('舊回饋');

      await clearAllDatabaseData();

      // 清空後再次新增，檢驗 ID 是否重新從 1 開始計算
      const catId = await addCategory({ name: '新分類', type: 'expense', isDefault: false });
      const payId = await addPaymentMethod('新支付');
      const incId = await addIncomeSource('新收入');
      const rewId = await addRewardSource('新回饋');

      expect(catId).toBe(1);
      expect(payId).toBe(1);
      expect(incId).toBe(1);
      expect(rewId).toBe(1);
    });

    it('clearMerchantItemsCache 能正確清空記憶體中的商家商品快取', async () => {
      // 寫入商品快取
      cacheMerchantItems('測試咖啡廳', [
        { id: '1', type: 'item', name: '拿鐵', quantity: 1, unitPrice: 85, subtotal: 85, category: '餐飲' },
      ]);

      let items = await getItemsByMerchant('測試咖啡廳');
      expect(items.length).toBe(1);
      expect(items[0].name).toBe('拿鐵');

      // 清空快取
      clearMerchantItemsCache();

      items = await getItemsByMerchant('測試咖啡廳');
      expect(items.length).toBe(0);
    });

    it('clearAllDatabaseData 執行後應一併清空商家商品之記憶體快取', async () => {
      // 1. 寫入商品快取至記憶體
      cacheMerchantItems('快取測試店家', [
        { id: '1', type: 'item', name: '招牌奶茶', quantity: 1, unitPrice: 50, subtotal: 50, category: '餐飲' },
      ]);

      // 驗證快取確實存在
      let cachedItems = await getItemsByMerchant('快取測試店家');
      expect(cachedItems.length).toBe(1);
      expect(cachedItems[0].name).toBe('招牌奶茶');

      // 2. 僅呼叫 clearAllDatabaseData()，不手動呼叫 clearMerchantItemsCache()
      await clearAllDatabaseData();

      // 3. 驗證記憶體快取已被徹底清空
      cachedItems = await getItemsByMerchant('快取測試店家');
      expect(cachedItems.length).toBe(0);
    });
  });

  // ==========================================
  // 6. 資料庫版本升級 (version 4) 與歷史來源自動遷移測試
  // ==========================================
  describe('資料庫版本升級 (version 4) 與歷史來源自動遷移', () => {
    it('TrackerDatabase 應宣告 version(4) 並包含 incomeSources 與 rewardSources 資料表', async () => {
      // 驗證目前資料庫版本號為 4
      expect(db.verno).toBe(4);

      // 驗證 7 個表格皆正常宣告存在
      expect(db.tables.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          'expenses',
          'incomes',
          'rewards',
          'categories',
          'paymentMethods',
          'incomeSources',
          'rewardSources',
        ])
      );
    });

    it('version(4) upgrade 遷移應自動從歷史 incomes 與 rewards 提取不重複非空來源寫入新表', async () => {
      const upgradeDbName = `UpgradeTestDB_${Date.now()}`;

      // 1. 建立舊版本資料庫 (模擬 Version 3，尚無 incomeSources / rewardSources 表)
      const oldDb = new Dexie(upgradeDbName);
      oldDb.version(3).stores({
        expenses: '++id, date, merchant, paymentMethod, totalAmount, isForeign',
        incomes: '++id, date, source, category, amount, isForeign',
        rewards: '++id, yearMonth, sourceName',
        categories: '++id, name, type, isDefault, [type+name]',
        paymentMethods: '++id, name, isDefault',
      });
      await oldDb.open();

      // 寫入包含重複、前後空白與空白值的歷史收入與回饋記錄
      await oldDb.table('incomes').bulkAdd([
        { date: '2026-11-01', source: '正職薪水', category: '薪資', amount: 50000, isForeign: false },
        { date: '2026-11-02', source: '  正職薪水  ', category: '薪資', amount: 3000, isForeign: false },
        { date: '2026-11-03', source: '股票股利', category: '投資', amount: 2000, isForeign: false },
        { date: '2026-11-04', source: '   ', category: '其他', amount: 100, isForeign: false },
      ]);

      await oldDb.table('rewards').bulkAdd([
        { yearMonth: '2026-11', sourceName: 'LINE Points', amount: 100 },
        { yearMonth: '2026-11', sourceName: '  LINE Points  ', amount: 50 },
        { yearMonth: '2026-11', sourceName: '街口幣', amount: 200 },
        { yearMonth: '2026-11', sourceName: '', amount: 0 },
      ]);

      oldDb.close();

      // 2. 使用新版 TrackerDatabase 開啟同一資料庫以觸發 version(4) upgrade 遷移
      const upgradedDb = new TrackerDatabase(upgradeDbName);
      await upgradedDb.open();

      expect(upgradedDb.verno).toBe(4);

      // 3. 驗證 incomeSources 自動提取與去重結果
      const incomeSources = await upgradedDb.incomeSources.toArray();
      const incomeSourceNames = incomeSources.map((s) => s.name);
      expect(incomeSourceNames).toHaveLength(2);
      expect(incomeSourceNames).toEqual(expect.arrayContaining(['正職薪水', '股票股利']));

      // 4. 驗證 rewardSources 自動提取與去重結果
      const rewardSources = await upgradedDb.rewardSources.toArray();
      const rewardSourceNames = rewardSources.map((r) => r.name);
      expect(rewardSourceNames).toHaveLength(2);
      expect(rewardSourceNames).toEqual(expect.arrayContaining(['LINE Points', '街口幣']));

      upgradedDb.close();
      await Dexie.delete(upgradeDbName);
    });
  });
});
