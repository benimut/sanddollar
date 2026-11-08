/**
 * @file transactionList_full_edit.spec.ts
 * @description 明細列表完整編輯流程與跨元件聯動單元測試套件 (TransactionList Full Edit Suite)
 *
 * 定案規格：
 * 1. 在 TransactionList.vue 點擊「編輯」時，emit 'edit' 事件通知父元件（App.vue）。
 * 2. 父元件收到後切換回「記帳」頁籤，並將完整資料帶入記帳表單 (TransactionForm.vue)。
 * 3. 記帳表單進入編輯模式（顯示「修改支出/收入/回饋記錄」），完整填入原有品項、店家、日期、金額等。
 * 4. 儲存完成後，呼叫 updateExpense / updateIncome / updateReward 更新 IndexedDB，並自動切換回「明細」分頁重新呈現。
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import {
  db,
  addExpense,
  addIncome,
  addReward,
  getExpenses,
  getIncomes,
  getRewards,
} from '@/db';
import type { ExpenseRecord, IncomeRecord, MonthlyReward } from '@/types';
import TransactionList from '@/components/TransactionList.vue';
import App from '@/App.vue';

describe('明細列表編輯聯動與完整編輯流程測試 (TransactionList & App Edit Workflow)', () => {
  interface MountResult {
    app: any;
    vm: any;
    container: HTMLElement;
    cleanup: () => void;
  }

  function mountComponent(Component: any, props = {}): MountResult {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = createApp(Component, props);
    const vm = app.mount(container);

    return {
      app,
      vm,
      container,
      cleanup: () => {
        app.unmount();
        container.remove();
      },
    };
  }

  async function flushAsync(ms = 80) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, ms));
    await nextTick();
  }

  beforeEach(async () => {
    if (db) {
      if (db.expenses) await db.expenses.clear();
      if (db.incomes) await db.incomes.clear();
      if (db.rewards) await db.rewards.clear();
      if (db.categories) await db.categories.clear();
      if (db.paymentMethods) await db.paymentMethods.clear();
    }
  });

  describe('1. TransactionList.vue 編輯按鈕觸發事件契約', () => {
    it('點擊支出記錄之「編輯」按鈕，應觸發 emit("edit", { type: "expense", data: ... }) 並攜帶完整資料', async () => {
      const expense: ExpenseRecord = {
        date: '2026-11-10',
        merchant: '星巴克',
        paymentMethod: '信用卡',
        items: [
          {
            id: 'item-1',
            name: '焦糖瑪奇朵',
            category: '餐飲',
            quantity: 1,
            unitPrice: 165,
          },
        ],
        totalAmount: 165,
        note: '下午茶',
        isForeign: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const expId = await addExpense(expense);
      const onEdit = vi.fn();

      const { container, cleanup } = mountComponent(TransactionList, {
        initialMonth: '2026-11',
        onEdit,
      });

      try {
        await flushAsync(100);

        const editBtns = Array.from(container.querySelectorAll('button')).filter((b) =>
          b.textContent?.trim().includes('編輯')
        );
        expect(editBtns.length).toBeGreaterThan(0);

        // 點擊編輯按鈕
        editBtns[0].click();
        await flushAsync(50);

        expect(onEdit).toHaveBeenCalledTimes(1);
        const emitted = onEdit.mock.calls[0][0];
        expect(emitted.type).toBe('expense');
        expect(emitted.data.id).toBe(expId);
        expect(emitted.data.merchant).toBe('星巴克');
        expect(emitted.data.items[0].name).toBe('焦糖瑪奇朵');
      } finally {
        cleanup();
      }
    });
  });

  describe('2. App.vue 頂層完整編輯聯動流程 (End-to-End Workflow)', () => {
    it('在明細點擊支出「編輯」後切換至「記帳」頁籤進入編輯模式，修改品項與金額儲存後自動返回明細頁籤', async () => {
      // 1. 建立初始支出記錄
      const initialExpense: ExpenseRecord = {
        date: '2026-11-10',
        merchant: '摩斯漢堡',
        paymentMethod: '現金',
        items: [
          {
            id: 'item-1',
            name: '藜麥燒肉珍珠堡',
            category: '餐飲',
            quantity: 1,
            unitPrice: 105,
          },
        ],
        totalAmount: 105,
        note: '晚餐',
        isForeign: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const expId = await addExpense(initialExpense);

      // 掛載 App.vue
      const { container, cleanup } = mountComponent(App);

      try {
        await flushAsync(100);

        // 2. 切換至「明細」分頁
        const listNavBtn = Array.from(container.querySelectorAll('nav button')).find((b) =>
          b.textContent?.includes('明細')
        );
        expect(listNavBtn).toBeTruthy();
        listNavBtn!.click();
        await flushAsync(100);

        // 3. 在明細列表中尋找編輯按鈕並點擊
        const editBtn = Array.from(container.querySelectorAll('button')).find((b) =>
          b.textContent?.trim().includes('編輯')
        );
        expect(editBtn, '明細列表應有編輯按鈕').toBeTruthy();
        editBtn!.click();
        await flushAsync(100);

        // 4. 驗證 App 自動切換回「記帳」分頁
        const transactionNavBtn = Array.from(container.querySelectorAll('nav button')).find((b) =>
          b.textContent?.includes('記帳')
        );
        expect(transactionNavBtn?.getAttribute('aria-selected')).toBe('true');

        // 5. 驗證表單呈現編輯模式（例如包含「修改支出」字樣）
        const formTitleOrSubmit = container.textContent;
        expect(
          formTitleOrSubmit?.includes('修改支出') || formTitleOrSubmit?.includes('更新支出'),
          '記帳表單應進入修改支出模式'
        ).toBe(true);

        // 6. 驗證品名輸入框已帶入「藜麥燒肉珍珠堡」
        const nameInput = container.querySelector<HTMLInputElement>('#expense-name');
        expect(nameInput?.value).toBe('藜麥燒肉珍珠堡');

        // 7. 使用者修改單價為 120
        const priceInput = container.querySelector<HTMLInputElement>('#expense-amount');
        expect(priceInput).toBeTruthy();
        priceInput!.value = '120';
        priceInput!.dispatchEvent(new Event('input'));
        await flushAsync(50);

        // 8. 點擊「修改支出記錄」/「儲存」按鈕
        const submitBtn = container.querySelector<HTMLButtonElement>(
          '#btn-submit-expense, button[type="submit"]'
        );
        expect(submitBtn).toBeTruthy();
        submitBtn!.click();
        await flushAsync(120);

        // 9. 驗證 IndexedDB 該筆記錄已更新，單價為 120，總金額為 120
        const expenses = await getExpenses();
        const updated = expenses.find((e) => e.id === expId);
        expect(updated).toBeDefined();
        expect(updated?.items[0].unitPrice).toBe(120);
        expect(updated?.totalAmount).toBe(120);

        // 10. 驗證儲存完成後自動切換回「明細」分頁
        expect(listNavBtn?.getAttribute('aria-selected')).toBe('true');
      } finally {
        cleanup();
      }
    });

    it('在明細點擊收入「編輯」後切換至「記帳」頁籤進入編輯模式，修改金額儲存後自動返回明細頁籤', async () => {
      const initialIncome: IncomeRecord = {
        date: '2026-11-05',
        source: '舊公司外包',
        category: '兼職',
        amount: 8000,
        note: '專案結案',
        isForeign: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const incId = await addIncome(initialIncome);

      const { container, cleanup } = mountComponent(App);

      try {
        await flushAsync(100);

        // 切換至「明細」分頁
        const listNavBtn = Array.from(container.querySelectorAll('nav button')).find((b) =>
          b.textContent?.includes('明細')
        );
        listNavBtn!.click();
        await flushAsync(100);

        // 點擊編輯
        const editBtn = Array.from(container.querySelectorAll('button')).find((b) =>
          b.textContent?.trim().includes('編輯')
        );
        editBtn!.click();
        await flushAsync(100);

        // 驗證進入修改收入模式
        expect(
          container.textContent?.includes('修改收入') || container.textContent?.includes('更新收入'),
          '記帳表單應進入修改收入模式'
        ).toBe(true);

        // 修改金額為 9500
        const amountInput = container.querySelector<HTMLInputElement>('#income-amount');
        expect(amountInput).toBeTruthy();
        amountInput!.value = '9500';
        amountInput!.dispatchEvent(new Event('input'));
        await flushAsync(50);

        // 點擊儲存
        const submitBtn = container.querySelector<HTMLButtonElement>(
          '#btn-submit-income, button[type="submit"]'
        );
        submitBtn!.click();
        await flushAsync(120);

        // 驗證 IndexedDB 更新
        const incomes = await getIncomes();
        const updated = incomes.find((i) => i.id === incId);
        expect(updated?.amount).toBe(9500);

        // 驗證自動返回明細頁
        expect(listNavBtn?.getAttribute('aria-selected')).toBe('true');
      } finally {
        cleanup();
      }
    });
  });

  describe('3. 明細列表分類篩選與關鍵字搜尋功能 (Filter & Search Workflow)', () => {
    beforeEach(async () => {
      // 建立測試資料
      await addExpense({
        date: '2026-11-02',
        merchant: '星巴克',
        paymentMethod: '信用卡',
        items: [
          {
            id: 'item-1',
            name: '焦糖瑪奇朵',
            category: '餐飲',
            quantity: 1,
            unitPrice: 165,
          },
        ],
        totalAmount: 165,
        note: '下午茶',
        isForeign: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await addExpense({
        date: '2026-11-03',
        merchant: '誠品書店',
        paymentMethod: '悠遊卡',
        items: [
          {
            id: 'item-2',
            name: '精美手帳筆記本',
            category: '文具',
            quantity: 1,
            unitPrice: 320,
          },
        ],
        totalAmount: 320,
        note: '文具用品',
        isForeign: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await addIncome({
        date: '2026-11-05',
        source: '舊公司外包',
        category: '兼職',
        amount: 8000,
        note: '專案結案',
        isForeign: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    it('明細列表畫面應具備 #filter-category 分類下拉選單與 #filter-keyword 關鍵字搜尋框', async () => {
      const { container, cleanup } = mountComponent(TransactionList, {
        initialMonth: '2026-11',
      });

      try {
        await flushAsync(100);

        const categoryFilter = container.querySelector<HTMLSelectElement>('#filter-category');
        const keywordFilter = container.querySelector<HTMLInputElement>('#filter-keyword');

        expect(categoryFilter, '明細列表應包含 #filter-category 分類下拉選單').not.toBeNull();
        expect(keywordFilter, '明細列表應包含 #filter-keyword 關鍵字搜尋輸入框').not.toBeNull();
      } finally {
        cleanup();
      }
    });

    it('選擇特定分類時，明細列表僅顯示符合該分類的記錄', async () => {
      const { container, cleanup } = mountComponent(TransactionList, {
        initialMonth: '2026-11',
      });

      try {
        await flushAsync(100);

        const categoryFilter = container.querySelector<HTMLSelectElement>('#filter-category');
        expect(categoryFilter).not.toBeNull();

        // 選擇「餐飲」分類
        categoryFilter!.value = '餐飲';
        categoryFilter!.dispatchEvent(new Event('change'));
        await flushAsync(50);

        const content = container.textContent || '';
        expect(content).toContain('星巴克');
        expect(content).toContain('焦糖瑪奇朵');
        expect(content).not.toContain('誠品書店');
        expect(content).not.toContain('精美手帳筆記本');
        expect(content).not.toContain('舊公司外包');
      } finally {
        cleanup();
      }
    });

    it('輸入關鍵字時，僅顯示符合品名或店家的記錄', async () => {
      const { container, cleanup } = mountComponent(TransactionList, {
        initialMonth: '2026-11',
      });

      try {
        await flushAsync(100);

        const keywordFilter = container.querySelector<HTMLInputElement>('#filter-keyword');
        expect(keywordFilter).not.toBeNull();

        // 搜尋店家「誠品」
        keywordFilter!.value = '誠品';
        keywordFilter!.dispatchEvent(new Event('input'));
        await flushAsync(50);

        let content = container.textContent || '';
        expect(content).toContain('誠品書店');
        expect(content).not.toContain('星巴克');

        // 搜尋品名「焦糖」
        keywordFilter!.value = '焦糖';
        keywordFilter!.dispatchEvent(new Event('input'));
        await flushAsync(50);

        content = container.textContent || '';
        expect(content).toContain('星巴克');
        expect(content).toContain('焦糖瑪奇朵');
        expect(content).not.toContain('誠品書店');
      } finally {
        cleanup();
      }
    });
  });

  describe('4. 規格 v1.3: 分類篩選時金額統計精確化 (Category Filter Subtotal Precision)', () => {
    beforeEach(async () => {
      if (db) {
        if (db.expenses) await db.expenses.clear();
        if (db.incomes) await db.incomes.clear();
        if (db.rewards) await db.rewards.clear();
      }

      // 建立一筆多品項不同分類的消費：品項 A「餐飲」200元、品項 B「生活」500元，整筆總額 700元
      await addExpense({
        date: '2026-11-15',
        merchant: '複合生活選物',
        paymentMethod: '信用卡',
        items: [
          {
            id: 'item-food',
            name: '午餐定食',
            category: '餐飲',
            quantity: 1,
            unitPrice: 200,
            subtotal: 200,
          },
          {
            id: 'item-life',
            name: '收納整理盒',
            category: '生活',
            quantity: 1,
            unitPrice: 500,
            subtotal: 500,
          },
        ],
        totalAmount: 700,
        note: '多品項混合消費',
        isForeign: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    it('當明細包含多品項不同分類時，分類篩選時統計卡片之當月支出應為命中該分類品項之小計，而非整筆總額', async () => {
      const { container, cleanup } = mountComponent(TransactionList, {
        initialMonth: '2026-11',
      });

      try {
        await flushAsync(100);

        const categoryFilter = container.querySelector<HTMLSelectElement>('#filter-category');
        expect(categoryFilter, '應具備分類篩選下拉選單').not.toBeNull();

        // 輔助函式：取得統計卡片中「當月支出」顯示的文字
        const getExpenseCardText = () => {
          const expenseLabel = Array.from(container.querySelectorAll('span')).find(
            (s) => s.textContent?.trim() === '當月支出'
          );
          return expenseLabel?.parentElement?.textContent || '';
        };

        // 1. 未篩選特定分類（全部分類）時，總支出應為整筆 700 元
        expect(getExpenseCardText()).toContain('700');

        // 2. 篩選「餐飲」分類時，統計卡片上的「當月支出」應為 200 元（而非整筆 700 元）
        categoryFilter!.value = '餐飲';
        categoryFilter!.dispatchEvent(new Event('change'));
        await flushAsync(50);

        expect(getExpenseCardText()).toContain('200');
        expect(getExpenseCardText()).not.toContain('700');

        // 3. 篩選「生活」分類時，統計卡片上的「當月支出」應為 500 元（而非整筆 700 元）
        categoryFilter!.value = '生活';
        categoryFilter!.dispatchEvent(new Event('change'));
        await flushAsync(50);

        expect(getExpenseCardText()).toContain('500');
        expect(getExpenseCardText()).not.toContain('700');
      } finally {
        cleanup();
      }
    });

    it('規格 v1.4: 分類篩選時單筆明細卡片右側顯示金額應精確反映命中該分類品項之小計，維持與頂部統計卡片口徑一致', async () => {
      const { container, cleanup } = mountComponent(TransactionList, {
        initialMonth: '2026-11',
      });

      try {
        await flushAsync(100);

        const categoryFilter = container.querySelector<HTMLSelectElement>('#filter-category');
        expect(categoryFilter, '應具備分類篩選下拉選單').not.toBeNull();

        // 取得單筆支出明細卡片右側金額元素文字（排除頂部統計卡片）
        const getDetailCardAmountText = () => {
          const editBtn = container.querySelector('.btn-edit');
          const card = editBtn?.closest('div.rounded-xl');
          const amountSpan = card?.querySelector('.text-sm.font-extrabold.text-rose-600');
          return amountSpan?.textContent?.trim() || '';
        };

        // 1. 未篩選特定分類（全部分類）時，單筆明細卡片顯示金額為整筆 700 元
        expect(getDetailCardAmountText()).toContain('700');

        // 2. 篩選「餐飲」分類時，單筆明細卡片顯示金額應為 200 元（反映該筆在餐飲分類之小計，而非整筆 700 元）
        categoryFilter!.value = '餐飲';
        categoryFilter!.dispatchEvent(new Event('change'));
        await flushAsync(50);

        expect(
          getDetailCardAmountText(),
          '篩選「餐飲」時，單筆明細卡片顯示金額需精確反映該分類小計 200 元'
        ).toContain('200');
        expect(
          getDetailCardAmountText(),
          '篩選「餐飲」時，單筆明細卡片顯示金額不得再顯示整筆全額 700 元'
        ).not.toContain('700');

        // 3. 篩選「生活」分類時，單筆明細卡片顯示金額應為 500 元（反映該筆在生活分類之小計，而非整筆 700 元）
        categoryFilter!.value = '生活';
        categoryFilter!.dispatchEvent(new Event('change'));
        await flushAsync(50);

        expect(
          getDetailCardAmountText(),
          '篩選「生活」時，單筆明細卡片顯示金額需精確反映該分類小計 500 元'
        ).toContain('500');
        expect(
          getDetailCardAmountText(),
          '篩選「生活」時，單筆明細卡片顯示金額不得再顯示整筆全額 700 元'
        ).not.toContain('700');
      } finally {
        cleanup();
      }
    });

    it('規格 v1.5: 當選取 #filter-category 為特定分類（例如「餐飲」）時，單筆支出卡片右側顯示文字必須包含分類標註；未篩選分類時不得出現此特定分類括號標註', async () => {
      const { container, cleanup } = mountComponent(TransactionList, {
        initialMonth: '2026-11',
      });

      try {
        await flushAsync(100);

        const categoryFilter = container.querySelector<HTMLSelectElement>('#filter-category');
        expect(categoryFilter, '應具備分類篩選下拉選單').not.toBeNull();

        // 取得單筆支出明細卡片右側金額區塊顯示之完整文字
        const getDetailCardRightText = () => {
          const editBtn = container.querySelector('.btn-edit');
          const card = editBtn?.closest('div.rounded-xl');
          const amountSpan = card?.querySelector('.text-sm.font-extrabold.text-rose-600');
          return amountSpan?.textContent?.trim() || '';
        };

        // 1. 未篩選特定分類（全部分類）時，單筆支出卡片右側顯示純金額 700，不得出現特定分類括號標註（如 (餐飲) 或 (生活)）
        const allText = getDetailCardRightText();
        expect(allText).toContain('700');
        expect(allText).not.toContain('(餐飲)');
        expect(allText).not.toContain('(生活)');

        // 2. 篩選「餐飲」分類時，單筆支出卡片右側顯示文字必須包含金額小計 200 與分類標註「(餐飲)」
        categoryFilter!.value = '餐飲';
        categoryFilter!.dispatchEvent(new Event('change'));
        await flushAsync(50);

        const foodText = getDetailCardRightText();
        expect(foodText, '篩選「餐飲」時，單筆支出卡片右側應顯示金額 200').toContain('200');
        expect(foodText, '篩選「餐飲」時，單筆支出卡片右側文字必須明確標註「(餐飲)」').toContain('(餐飲)');

        // 3. 篩選「生活」分類時，單筆支出卡片右側顯示文字必須包含金額小計 500 與分類標註「(生活)」
        categoryFilter!.value = '生活';
        categoryFilter!.dispatchEvent(new Event('change'));
        await flushAsync(50);

        const lifeText = getDetailCardRightText();
        expect(lifeText, '篩選「生活」時，單筆支出卡片右側應顯示金額 500').toContain('500');
        expect(lifeText, '篩選「生活」時，單筆支出卡片右側文字必須明確標註「(生活)」').toContain('(生活)');
      } finally {
        cleanup();
      }
    });
  });

  describe('5. 規格 v1.3: TransactionList 時區防護行為測試 (Timezone Safeguard)', () => {
    it('在無傳入 initialMonth prop 且處於跨月邊界的清晨時區時，預設月份應採用本地時區年月而非 UTC 年月', async () => {
      // 模擬情境：本地時間為 2026-11-01 02:30:00 (台灣時間 GMT+8)，此時 UTC 時間為 2026-10-31 18:30:00 (10月份)
      // 若使用 new Date().toISOString().slice(0, 7) 會誤算為 2026-10
      // 規範要求必須依本地時區計算為 2026-11
      const fakeDate = new Date('2026-11-01T02:30:00+08:00');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(fakeDate);

      // 取得本地時區之正確 YYYY-MM
      const expectedLocalMonth = `${fakeDate.getFullYear()}-${String(fakeDate.getMonth() + 1).padStart(2, '0')}`;

      try {
        const { container, cleanup } = mountComponent(TransactionList);
        await flushAsync(50);

        try {
          const monthInput = container.querySelector<HTMLInputElement>('#list-month-selector');
          expect(monthInput, '應存在 #list-month-selector 月份選擇框').not.toBeNull();
          expect(monthInput?.value, '月份選擇框預設值應為本地時區年月').toBe(expectedLocalMonth);
        } finally {
          cleanup();
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
