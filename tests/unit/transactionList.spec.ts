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

        const editBtns = Array.from(container.querySelectorAll<HTMLButtonElement>('button.btn-edit'));
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
        const editBtn = container.querySelector<HTMLButtonElement>('button.btn-edit');
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
        const editBtn = container.querySelector<HTMLButtonElement>('button.btn-edit');
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

  describe('6. 明細排序與分類選單自然文字排序測試', () => {
    it('支出與收入明細應依日期由新到舊排序，日期相同時依寫入順序由後到前排序', async () => {
      // 寫入不同日期與同日期的多筆支出
      await addExpense({
        date: '2026-11-02',
        merchant: '店家A-1102',
        paymentMethod: '現金',
        items: [{ id: 'i1', type: 'item', name: '商品1', quantity: 1, unitPrice: 100, subtotal: 100, category: '餐飲' }],
        totalAmount: 100,
        isForeign: false,
        createdAt: 1000,
        updatedAt: 1000,
      });
      await addExpense({
        date: '2026-11-05',
        merchant: '店家B-1105早',
        paymentMethod: '現金',
        items: [{ id: 'i2', type: 'item', name: '商品2', quantity: 1, unitPrice: 200, subtotal: 200, category: '餐飲' }],
        totalAmount: 200,
        isForeign: false,
        createdAt: 2000,
        updatedAt: 2000,
      });
      await addExpense({
        date: '2026-11-05',
        merchant: '店家C-1105晚',
        paymentMethod: '現金',
        items: [{ id: 'i3', type: 'item', name: '商品3', quantity: 1, unitPrice: 300, subtotal: 300, category: '餐飲' }],
        totalAmount: 300,
        isForeign: false,
        createdAt: 3000,
        updatedAt: 3000,
      });

      // 寫入同日期與不同日期的收入
      await addIncome({
        date: '2026-11-01',
        source: '來源1-1101',
        category: '薪資',
        amount: 1000,
        isForeign: false,
        createdAt: 1000,
        updatedAt: 1000,
      });
      await addIncome({
        date: '2026-11-04',
        source: '來源2-1104早',
        category: '兼職',
        amount: 2000,
        isForeign: false,
        createdAt: 2000,
        updatedAt: 2000,
      });
      await addIncome({
        date: '2026-11-04',
        source: '來源3-1104晚',
        category: '兼職',
        amount: 3000,
        isForeign: false,
        createdAt: 3000,
        updatedAt: 3000,
      });

      const { container, cleanup } = mountComponent(TransactionList, {
        initialMonth: '2026-11',
      });

      try {
        await flushAsync(100);
        const text = container.textContent || '';

        // 支出應依 店家C-1105晚 -> 店家B-1105早 -> 店家A-1102 排列
        const posC = text.indexOf('店家C-1105晚');
        const posB = text.indexOf('店家B-1105早');
        const posA = text.indexOf('店家A-1102');
        expect(posC).toBeGreaterThan(-1);
        expect(posB).toBeGreaterThan(posC);
        expect(posA).toBeGreaterThan(posB);

        // 收入應依 來源3-1104晚 -> 來源2-1104早 -> 來源1-1101 排列
        const inc3 = text.indexOf('來源3-1104晚');
        const inc2 = text.indexOf('來源2-1104早');
        const inc1 = text.indexOf('來源1-1101');
        expect(inc3).toBeGreaterThan(-1);
        expect(inc2).toBeGreaterThan(inc3);
        expect(inc1).toBeGreaterThan(inc2);
      } finally {
        cleanup();
      }
    });

    it('分類篩選下拉選單應依自然文字順序排序', async () => {
      await addExpense({
        date: '2026-11-01',
        merchant: '測試店',
        paymentMethod: '現金',
        items: [
          { id: 'c1', type: 'item', name: 'A', quantity: 1, unitPrice: 10, subtotal: 10, category: '分類10' },
          { id: 'c2', type: 'item', name: 'B', quantity: 1, unitPrice: 10, subtotal: 10, category: '分類2' },
          { id: 'c3', type: 'item', name: 'C', quantity: 1, unitPrice: 10, subtotal: 10, category: '分類1' },
        ],
        totalAmount: 30,
        isForeign: false,
        createdAt: 1000,
        updatedAt: 1000,
      });

      const { container, cleanup } = mountComponent(TransactionList, {
        initialMonth: '2026-11',
      });

      try {
        await flushAsync(100);
        const options = Array.from(
          container.querySelectorAll<HTMLOptionElement>('#filter-category option')
        ).map((opt) => opt.value);

        // 第一個是空字串「全部分類」，後續應依自然數字順序排列
        expect(options).toEqual(['', '分類1', '分類2', '分類10']);
      } finally {
        cleanup();
      }
    });
  });

  describe('7. 明細列表顏色識別、欄位對齊與圖示按鈕排列測試', () => {
    it('明細項目不應顯示「支出/收入/回饋」文字標籤，應以顏色區分並將編輯/刪除按鈕垂直排列且以符號取代文字', async () => {
      await addExpense({
        date: '2026-11-10',
        merchant: '測試商店名稱非常長可能會影響排版對齊的測試商店',
        paymentMethod: '現金',
        items: [{ id: 'i1', type: 'item', name: '商品', quantity: 1, unitPrice: 150, subtotal: 150, category: '餐飲' }],
        totalAmount: 150,
        isForeign: false,
        createdAt: 1000,
        updatedAt: 1000,
      });
      await addIncome({
        date: '2026-11-09',
        source: '短來源',
        category: '薪資',
        amount: 5000,
        isForeign: false,
        createdAt: 2000,
        updatedAt: 2000,
      });
      await addReward({
        yearMonth: '2026-11',
        sourceName: '信用卡回饋',
        amount: 200,
        createdAt: 3000,
        updatedAt: 3000,
      });

      const { container, cleanup } = mountComponent(TransactionList, {
        initialMonth: '2026-11',
      });

      try {
        await flushAsync(100);
        const cards = Array.from(container.querySelectorAll<HTMLElement>('div.rounded-xl')).filter((el) =>
          el.querySelector('.btn-edit')
        );
        expect(cards).toHaveLength(3);

        // 1. 卡片內不應出現「支出」、「收入」、「回饋」類型標籤文字，並具備對應顏色與左側色條
        const [expCard, incCard, rewCard] = cards;
        expect(expCard.className).toContain('border-l-rose-500');
        expect(incCard.className).toContain('border-l-emerald-500');
        expect(rewCard.className).toContain('border-l-blue-500');

        for (const card of cards) {
          const badgeTexts = Array.from(card.querySelectorAll('span')).map((s) => s.textContent?.trim());
          expect(badgeTexts).not.toContain('支出');
          expect(badgeTexts).not.toContain('收入');
          expect(badgeTexts).not.toContain('回饋');
        }

        // 2. 編輯與刪除按鈕垂直排列 (flex-col)，且按鈕內不含「編輯」「刪除」文字，改為 SVG 圖示
        for (const card of cards) {
          const editBtn = card.querySelector<HTMLButtonElement>('.btn-edit');
          const deleteBtn = card.querySelector<HTMLButtonElement>('.btn-delete');
          expect(editBtn).toBeTruthy();
          expect(deleteBtn).toBeTruthy();
          expect(editBtn!.parentElement?.className).toContain('flex-col');
          expect(editBtn!.textContent?.trim()).toBe('');
          expect(deleteBtn!.textContent?.trim()).toBe('');
          expect(editBtn!.querySelector('svg')).toBeTruthy();
          expect(deleteBtn!.querySelector('svg')).toBeTruthy();
          expect(editBtn!.getAttribute('aria-label')).toBeTruthy();
          expect(deleteBtn!.getAttribute('aria-label')).toBeTruthy();

          // 3. 日期與總金額垂直排列（同處於 flex-col 容器內）
          const amountEl = card.querySelector('.text-sm.font-extrabold');
          expect(amountEl).toBeTruthy();
          const dateAndAmountBox = amountEl!.parentElement;
          expect(dateAndAmountBox?.className).toContain('flex-col');
          expect(dateAndAmountBox?.textContent).toMatch(/2026-11/);
        }

        // 4. 收入分類應位於來源名稱上方，並採垂直排列
        const incHeaderSpans = Array.from(incCard.querySelectorAll('.flex-col > span'));
        expect(incHeaderSpans.length).toBeGreaterThanOrEqual(2);
        expect(incHeaderSpans[0].textContent?.trim()).toBe('薪資');
        expect(incHeaderSpans[1].textContent?.trim()).toBe('短來源');
        expect(incHeaderSpans[0].parentElement?.className).toContain('flex-col');
      } finally {
        cleanup();
      }
    });

    it('商品明細應一筆一行顯示，最多只顯示前三筆，超過三筆時應顯示 ...', async () => {
      await addExpense({
        date: '2026-11-12',
        merchant: '大賣場',
        paymentMethod: '現金',
        items: [
          { id: 'p1', type: 'item', name: '商品一', quantity: 1, unitPrice: 10, subtotal: 10, category: '生活' },
          { id: 'p2', type: 'item', name: '商品二', quantity: 2, unitPrice: 20, subtotal: 40, category: '生活' },
          { id: 'p3', type: 'item', name: '商品三', quantity: 1, unitPrice: 30, subtotal: 30, category: '生活' },
          { id: 'p4', type: 'item', name: '商品四不應顯示', quantity: 1, unitPrice: 40, subtotal: 40, category: '生活' },
        ],
        totalAmount: 120,
        isForeign: false,
        createdAt: 1000,
        updatedAt: 1000,
      });

      const { container, cleanup } = mountComponent(TransactionList, {
        initialMonth: '2026-11',
      });

      try {
        await flushAsync(100);
        const card = container.querySelector<HTMLElement>('div.rounded-xl.border-l-rose-500');
        expect(card).toBeTruthy();

        const cardText = card!.textContent || '';
        expect(cardText).toContain('商品一 (1x$10)');
        expect(cardText).toContain('商品二 (2x$20)');
        expect(cardText).toContain('商品三 (1x$30)');
        expect(cardText).not.toContain('商品四不應顯示');
        expect(cardText).toContain('...');

        // 確認商品明細為一筆一行（各自獨立的 div）
        const itemLines = Array.from(card!.querySelectorAll('.text-slate-500 > div'));
        expect(itemLines.length).toBe(4); // 前三筆商品 + "..." 一行
        expect(itemLines[0].textContent?.trim()).toBe('商品一 (1x$10)');
        expect(itemLines[1].textContent?.trim()).toBe('商品二 (2x$20)');
        expect(itemLines[2].textContent?.trim()).toBe('商品三 (1x$30)');
        expect(itemLines[3].textContent?.trim()).toBe('...');
      } finally {
        cleanup();
      }
    });
  });
});
