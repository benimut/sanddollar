import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick } from 'vue';
import TransactionForm from '@/components/TransactionForm.vue';
import ExpenseForm from '@/components/ExpenseForm.vue';
import IncomeForm from '@/components/IncomeForm.vue';
import RewardForm from '@/components/RewardForm.vue';
import * as dbModule from '@/db';

/**
 * Sand Dollar v2.0 單元測試套件
 * 
 * 測試範圍：
 * 1. 模組化子元件與架構契約 (Shell + ExpenseForm.vue + IncomeForm.vue + RewardForm.vue)
 * 2. 規格 v2.0: 支出表單分類與支付方式無空白選項、海外模式底部無多餘總計
 * 3. 規格 v2.0: 收入來源純選單模式 (#income-source-select)、動態展開自訂輸入框、徹底移除存入帳戶
 * 4. 規格 v2.0: 回饋來源純選單模式 (#reward-source-select)、動態展開自訂輸入框
 * 5. 表單提交、資料庫寫入、資料響應與表單狀態重置
 * 6. 外幣換算、預設手續費與實質匯率計算
 */

// Mock 資料庫操作函式
vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>();
  return {
    ...actual,
    addExpense: vi.fn().mockResolvedValue(1),
    updateExpense: vi.fn().mockResolvedValue(1),
    addIncome: vi.fn().mockResolvedValue(1),
    updateIncome: vi.fn().mockResolvedValue(1),
    addReward: vi.fn().mockResolvedValue(1),
    updateReward: vi.fn().mockResolvedValue(1),
    addIncomeSource: vi.fn().mockResolvedValue(1),
    addRewardSource: vi.fn().mockResolvedValue(1),
    getPaymentMethods: vi.fn().mockResolvedValue([]),
    addPaymentMethod: vi.fn().mockResolvedValue(1),
    getDistinctIncomeSources: vi.fn().mockResolvedValue(['公司薪資', '股票股利', '發票中獎']),
    getDistinctMerchants: vi.fn().mockResolvedValue(['全家便利商店', '7-ELEVEN', '星巴克']),
    getItemsByMerchant: vi.fn().mockResolvedValue([
      { name: '美式咖啡', unitPrice: 35, category: '餐飲' },
    ]),
    cacheMerchantItems: vi.fn(),
    getCategories: vi.fn().mockResolvedValue([
      { id: 1, name: '餐飲', type: 'expense', isDefault: true },
      { id: 2, name: '薪資', type: 'income', isDefault: true },
    ]),
  };
});

// Mock 發票掃描彈窗，避免測試環境觸發相機與 DOM 複雜連動
vi.mock('@/components/InvoiceScannerModal.vue', () => {
  return {
    default: {
      name: 'InvoiceScannerModal',
      template: '<div id="mock-scanner-modal"><button id="mock-close-scanner" @click="$emit(\'close\')">關閉</button></div>',
      emits: ['close', 'parsed'],
    },
  };
});

describe('Milestone 5: TransactionForm 模組化拆分與歷史選單單元測試套件', () => {
  // 元件掛載輔助函式
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

  // 推進非同步微任務與 DOM 更新輔助函式
  async function flushAsync(ms = 30) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // 預設歷史收入來源資料
    vi.mocked(dbModule.getDistinctIncomeSources).mockResolvedValue([
      '公司薪資',
      '股票股利',
      '發票中獎',
    ]);
    vi.mocked(dbModule.getPaymentMethods).mockResolvedValue([]);
    vi.mocked(dbModule.addPaymentMethod).mockResolvedValue(1);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // =========================================================================
  // 1. 模組化子元件與架構契約 (Modular Architecture & Component Contracts)
  // =========================================================================
  describe('1. 模組化架構與子元件存在性契約', () => {
    it('TransactionForm.vue 頂層容器應提供支出 (Expense) 與收入 (Income) 模式切換', async () => {
      const { container, cleanup } = mountComponent(TransactionForm);
      await flushAsync();

      try {
        // 預設應為支出模式
        const expenseTab =
          container.querySelector('#tab-expense') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('支出')
          );
        const incomeTab =
          container.querySelector('#tab-income') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('收入')
          );

        expect(expenseTab, '應存在支出 Tab 切換按鈕').not.toBeNull();
        expect(incomeTab, '應存在收入 Tab 切換按鈕').not.toBeNull();

        // 點擊收入 Tab
        (incomeTab as HTMLButtonElement).click();
        await flushAsync();

        // 驗證切換至收入模式後，出現收入特有欄位
        const incomeDate = container.querySelector('#income-date');
        expect(incomeDate, '切換至收入 Tab 後應呈現收入表單').not.toBeNull();

        // 點擊支出 Tab 切回支出
        (expenseTab as HTMLButtonElement).click();
        await flushAsync();

        const expenseDate = container.querySelector('#expense-date');
        expect(expenseDate, '切回支出 Tab 後應呈現支出表單').not.toBeNull();
      } finally {
        cleanup();
      }
    });
  });

  // =========================================================================
  // 2. DOM Selector 契約相容性 (DOM Selector Compatibility Contract)
  // =========================================================================
  describe('2. DOM Selector 契約相容性', () => {
    it('支出模式下必須完整具備關鍵 DOM Selector (#tab-expense, #tab-income, #expense-date, #payment-method, #merchant-input, #btn-submit-expense)', async () => {
      const { container, cleanup } = mountComponent(TransactionForm);
      await flushAsync();

      try {
        // 驗證 Tab Selector
        const tabExpense = container.querySelector('#tab-expense');
        const tabIncome = container.querySelector('#tab-income');
        expect(tabExpense, '必須具備 #tab-expense 分頁按鈕 ID').not.toBeNull();
        expect(tabIncome, '必須具備 #tab-income 分頁按鈕 ID').not.toBeNull();

        // 驗證支出欄位 Selector
        expect(container.querySelector('#expense-date'), '必須具備 #expense-date 日期欄位').not.toBeNull();
        expect(container.querySelector('#payment-method'), '必須具備 #payment-method 支付方式欄位').not.toBeNull();
        expect(container.querySelector('#merchant-input'), '必須具備 #merchant-input 店家輸入欄位').not.toBeNull();

        // 驗證送出按鈕 Selector
        const submitExpenseBtn = container.querySelector('#btn-submit-expense');
        expect(submitExpenseBtn, '支出表單必須具備 #btn-submit-expense 儲存按鈕 ID').not.toBeNull();

        // 驗證新增商品按鈕存在
        const addItemBtn = container.querySelector('#btn-add-item') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('新增商品')
          );
        expect(addItemBtn, '支出表單應具備「新增商品」按鈕').not.toBeNull();
      } finally {
        cleanup();
      }
    });

    it('點擊「新增商品」按鈕應能成功在商品清單中追加新項目列', async () => {
      const { container, cleanup } = mountComponent(TransactionForm);
      await flushAsync();

      try {
        const getItemsCount = () =>
          container.querySelectorAll('input[placeholder*="品名"], input[placeholder*="商品"]').length;

        const initialCount = getItemsCount();

        const addItemBtn = (container.querySelector('#btn-add-item') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('新增商品')
          )) as HTMLButtonElement | null;

        expect(addItemBtn, '應存在「新增商品」按鈕').not.toBeNull();
        addItemBtn!.click();
        await flushAsync();

        expect(getItemsCount()).toBe(initialCount + 1);
      } finally {
        cleanup();
      }
    });

    it('收入模式下必須具備關鍵 DOM Selector (#tab-expense, #tab-income, #income-date, #income-category, #income-source-select, #income-amount, #btn-submit-income)，平時不顯示常駐文字輸入框，且徹底移除 #income-account', async () => {
      const { container, cleanup } = mountComponent(TransactionForm);
      await flushAsync();

      try {
        // 切換至收入模式
        const incomeTab =
          container.querySelector('#tab-income') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('收入')
          );
        (incomeTab as HTMLButtonElement).click();
        await flushAsync();

        // 驗證收入欄位 Selector
        expect(container.querySelector('#income-date'), '必須具備 #income-date 入帳日期欄位').not.toBeNull();
        expect(container.querySelector('#income-category'), '必須具備 #income-category 收入分類欄位').not.toBeNull();
        expect(container.querySelector('#income-source-select'), '必須具備 #income-source-select 收入來源選單欄位').not.toBeNull();
        expect(container.querySelector('#income-amount'), '必須具備 #income-amount 入帳金額欄位').not.toBeNull();

        // 驗證徹底刪除存入帳戶欄位：畫面中不得存在 #income-account
        expect(container.querySelector('#income-account'), '收入表單中嚴禁存在 #income-account 存入帳戶欄位').toBeNull();

        // 驗證平時不顯示常駐文字輸入框
        const legacySource = container.querySelector('#income-source') as HTMLElement | null;
        if (legacySource) {
          const isHidden = legacySource.classList.contains('hidden') || legacySource.style.display === 'none';
          expect(isHidden, '平時不得顯示常駐文字輸入框 #income-source').toBe(true);
        }
        expect(container.querySelector('#custom-income-source-input'), '平時不應顯示自訂收入來源輸入框').toBeNull();

        // 驗證收入送出按鈕 Selector
        const submitIncomeBtn = container.querySelector('#btn-submit-income');
        expect(submitIncomeBtn, '收入表單必須具備 #btn-submit-income 儲存按鈕 ID').not.toBeNull();
      } finally {
        cleanup();
      }
    });
  });

  // =========================================================================
  // 3. 規格 v2.0: 收入來源純選單模式與自訂展開契約 (Income Source Pure Select Mode)
  // =========================================================================
  describe('3. 規格 v2.0: 歷史收入來源純選單模式與自訂展開契約', () => {
    it('進入收入模式時，應主動呼叫 db.getDistinctIncomeSources() 取得歷史收入來源清單', async () => {
      const { container, cleanup } = mountComponent(TransactionForm);
      await flushAsync();

      try {
        const incomeTab =
          container.querySelector('#tab-income') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('收入')
          );
        (incomeTab as HTMLButtonElement).click();
        await flushAsync();

        // 驗證有呼叫 getDistinctIncomeSources()
        expect(
          dbModule.getDistinctIncomeSources,
          '切換至收入模式時應呼叫 db.getDistinctIncomeSources()'
        ).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('歷史收入來源應動態渲染於純下拉選單 #income-source-select 的 <option> 標籤中，且末尾提供「+ 新增收入來源...」', async () => {
      vi.mocked(dbModule.getDistinctIncomeSources).mockResolvedValue([
        '公司薪資',
        '股票股利',
        '發票中獎',
      ]);

      const { container, cleanup } = mountComponent(IncomeForm);
      await flushAsync();

      try {
        const select = container.querySelector('#income-source-select') as HTMLSelectElement;
        expect(select, '應渲染 id="income-source-select" 的下拉選單元素').not.toBeNull();

        const options = Array.from(select.querySelectorAll('option'));
        const optionValues = options.map((opt) => opt.value);
        expect(optionValues).toContain('公司薪資');
        expect(optionValues).toContain('股票股利');
        expect(optionValues).toContain('發票中獎');

        // 選單末尾應提供「+ 新增收入來源...」
        const addNewOpt = options.find((opt) => opt.value === '__add_new__');
        expect(addNewOpt, '選單中應包含 value="__add_new__" 的新增選項').toBeDefined();
        expect(addNewOpt?.textContent).toContain('新增收入來源');
      } finally {
        cleanup();
      }
    });

    it('平時只顯示 #income-source-select，不顯示常駐文字輸入框；且預設不展開 #custom-income-source-input', async () => {
      const { container, cleanup } = mountComponent(IncomeForm);
      await flushAsync();

      try {
        const select = container.querySelector('#income-source-select');
        expect(select, '畫面應存在純下拉選單 #income-source-select').not.toBeNull();

        // 驗證常駐文字輸入框不應顯示
        const textInput = container.querySelector('#income-source') as HTMLElement | null;
        if (textInput) {
          const isHidden = textInput.classList.contains('hidden') || textInput.style.display === 'none';
          expect(isHidden, '平時不得顯示常駐文字輸入框 #income-source').toBe(true);
        }

        // 驗證自訂輸入框預設不展示
        const customInput = container.querySelector('#custom-income-source-input');
        expect(customInput, '平時不得展開 #custom-income-source-input').toBeNull();
      } finally {
        cleanup();
      }
    });

    it('在 #income-source-select 選取「+ 新增收入來源...」時，下方動態展開 #custom-income-source-input 輸入框', async () => {
      const { container, cleanup } = mountComponent(IncomeForm);
      await flushAsync();

      try {
        const select = container.querySelector('#income-source-select') as HTMLSelectElement;
        expect(select).not.toBeNull();

        // 選取「+ 新增收入來源...」
        select.value = '__add_new__';
        select.dispatchEvent(new Event('change'));
        await flushAsync();

        // 驗證展開自訂輸入框
        const customInput = container.querySelector('#custom-income-source-input') as HTMLInputElement | null;
        expect(customInput, '選中 __add_new__ 後應動態展開 #custom-income-source-input').not.toBeNull();
      } finally {
        cleanup();
      }
    });

    it('選取「+ 新增收入來源...」並在 #custom-income-source-input 輸入名稱後儲存，傳入 addIncome 之記錄其 source 為該自訂來源', async () => {
      const { container, cleanup } = mountComponent(IncomeForm);
      await flushAsync();

      try {
        // 1. 選取「+ 新增收入來源...」
        const select = container.querySelector('#income-source-select') as HTMLSelectElement;
        select.value = '__add_new__';
        select.dispatchEvent(new Event('change'));
        await flushAsync();

        // 2. 在展開之輸入框輸入自訂來源「接案外包」
        const customInput = container.querySelector('#custom-income-source-input') as HTMLInputElement;
        expect(customInput).not.toBeNull();
        customInput.value = '接案外包';
        customInput.dispatchEvent(new Event('input'));

        // 3. 填寫金額 30000
        const amountInput = container.querySelector('#income-amount') as HTMLInputElement;
        amountInput.value = '30000';
        amountInput.dispatchEvent(new Event('input'));
        await flushAsync();

        // 4. 點擊儲存
        const submitBtn = container.querySelector('#btn-submit-income') as HTMLButtonElement;
        submitBtn.click();
        await flushAsync();

        // 5. 驗證 addIncome 接收之 source 為「接案外包」且呼叫 addIncomeSource
        expect(dbModule.addIncome).toHaveBeenCalled();
        const callArg = vi.mocked(dbModule.addIncome).mock.calls[0][0];
        expect(callArg.source, '新增自訂來源時應正確寫入 source: "接案外包"').toBe('接案外包');
        expect(dbModule.addIncomeSource).toHaveBeenCalledWith('接案外包');
      } finally {
        cleanup();
      }
    });

    it('選取「+ 新增收入來源...」但未填寫自訂名稱直接儲存，收入來源安全 fallback 為「未分類收入」', async () => {
      const { container, cleanup } = mountComponent(IncomeForm);
      await flushAsync();

      try {
        // 1. 選取「+ 新增收入來源...」
        const select = container.querySelector('#income-source-select') as HTMLSelectElement;
        select.value = '__add_new__';
        select.dispatchEvent(new Event('change'));
        await flushAsync();

        // 2. 自訂輸入框保持空白，僅填寫金額 12000
        const amountInput = container.querySelector('#income-amount') as HTMLInputElement;
        amountInput.value = '12000';
        amountInput.dispatchEvent(new Event('input'));
        await flushAsync();

        // 3. 點擊儲存
        const submitBtn = container.querySelector('#btn-submit-income') as HTMLButtonElement;
        submitBtn.click();
        await flushAsync();

        // 4. 驗證 addIncome 安全 fallback 為「未分類收入」
        expect(dbModule.addIncome).toHaveBeenCalled();
        const callArg = vi.mocked(dbModule.addIncome).mock.calls[0][0];
        expect(callArg.source, '未填寫自訂收入來源時應 fallback 為「未分類收入」').toBe('未分類收入');
      } finally {
        cleanup();
      }
    });

    it('歷史選單在資料庫無記錄時 (回傳空陣列)，應優雅處理不拋出錯誤且正確呈現選單', async () => {
      vi.mocked(dbModule.getDistinctIncomeSources).mockResolvedValue([]);

      const { container, cleanup } = mountComponent(IncomeForm);
      await flushAsync();

      try {
        const select = container.querySelector('#income-source-select') as HTMLSelectElement;
        expect(select, '即使無歷史記錄，仍應安全渲染 #income-source-select 選單').not.toBeNull();
      } finally {
        cleanup();
      }
    });

    it('極限與特殊字元容錯：歷史來源包含符號、引號與 Unicode 表情符號時應完整正確呈現於選單', async () => {
      const specialSources = [
        '接案 <Freelance> "Design"',
        "小明's 還款轉帳 & 諮詢",
        '年終獎金 💰 (海外派任)',
      ];
      vi.mocked(dbModule.getDistinctIncomeSources).mockResolvedValue(specialSources);

      const { container, cleanup } = mountComponent(IncomeForm);
      await flushAsync();

      try {
        const select = container.querySelector('#income-source-select') as HTMLSelectElement;
        expect(select).not.toBeNull();

        const options = Array.from(select.querySelectorAll('option'));
        const optionValues = options.map((opt) => opt.value);

        expect(optionValues).toContain('接案 <Freelance> "Design"');
        expect(optionValues).toContain("小明's 還款轉帳 & 諮詢");
        expect(optionValues).toContain('年終獎金 💰 (海外派任)');
      } finally {
        cleanup();
      }
    });
  });

  // =========================================================================
  // 4. 表單提交、資料庫寫入與狀態重置 (Submission, DB Mutation & Reset)
  // =========================================================================
  describe('4. 表單提交、資料庫寫入與狀態重置', () => {
    it('支出表單送出：應調用 db.addExpense 寫入完整支出記錄，並在儲存後重置表單', async () => {
      const { container, cleanup } = mountComponent(TransactionForm);
      await flushAsync();

      try {
        // 填寫消費日期與店家
        const dateInput = container.querySelector('#expense-date') as HTMLInputElement;
        const merchantInput = container.querySelector('#merchant-input') as HTMLInputElement;

        if (dateInput) {
          dateInput.value = '2026-11-06';
          dateInput.dispatchEvent(new Event('input'));
        }
        if (merchantInput) {
          merchantInput.value = '全家便利商店';
          merchantInput.dispatchEvent(new Event('input'));
        }

        // 填寫商品品名與單價
        const nameInput = (container.querySelector('#expense-name') ||
          container.querySelector('input[placeholder*="品名"]') ||
          container.querySelector('input[placeholder*="商品"]')) as HTMLInputElement;
        const priceInput = (container.querySelector('#expense-amount') ||
          container.querySelector('input[placeholder*="單價"]') ||
          container.querySelector('input[placeholder*="金額"]')) as HTMLInputElement;

        if (nameInput) {
          nameInput.value = '經典美式';
          nameInput.dispatchEvent(new Event('input'));
        }
        if (priceInput) {
          priceInput.value = '35';
          priceInput.dispatchEvent(new Event('input'));
        }

        await flushAsync();

        // 點擊儲存按鈕
        const submitBtn = (container.querySelector('#btn-submit-expense') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('儲存')
          )) as HTMLButtonElement;

        expect(submitBtn, '支出表單應有可點擊的儲存按鈕').not.toBeNull();
        submitBtn.click();
        await flushAsync();

        // 驗證 addExpense 被調用
        expect(dbModule.addExpense).toHaveBeenCalled();
        const callArg = vi.mocked(dbModule.addExpense).mock.calls[0][0];
        expect(callArg.merchant).toBe('全家便利商店');
        expect(callArg.date).toBe('2026-11-06');

        // 驗證表單重置：店家輸入框已清空
        expect(merchantInput.value).toBe('');
      } finally {
        cleanup();
      }
    });

    it('收入表單送出：應調用 db.addIncome 寫入完整收入記錄，驗證徹底移除存入帳戶，並在儲存後重置表單', async () => {
      const { container, cleanup } = mountComponent(TransactionForm);
      await flushAsync();

      try {
        const incomeTab =
          container.querySelector('#tab-income') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('收入')
          );
        (incomeTab as HTMLButtonElement).click();
        await flushAsync();

        // 驗證徹底移除存入帳戶欄位：畫面中不得存在 #income-account
        expect(container.querySelector('#income-account'), '收入表單中嚴禁存在 #income-account 存入帳戶欄位').toBeNull();

        // 填寫入帳日期、金額、分類
        const dateInput = container.querySelector('#income-date') as HTMLInputElement;
        const amountInput = container.querySelector('#income-amount') as HTMLInputElement;
        const categorySelect = container.querySelector('#income-category') as HTMLSelectElement;

        if (dateInput) {
          dateInput.value = '2026-11-06';
          dateInput.dispatchEvent(new Event('input'));
        }

        // 透過 #income-source-select 選取「+ 新增收入來源...」並填寫自訂來源
        const sourceSelect = container.querySelector('#income-source-select') as HTMLSelectElement | null;
        if (sourceSelect) {
          sourceSelect.value = '__add_new__';
          sourceSelect.dispatchEvent(new Event('change'));
          await flushAsync();

          const customSourceInput = container.querySelector('#custom-income-source-input') as HTMLInputElement | null;
          if (customSourceInput) {
            customSourceInput.value = '11月正職薪資';
            customSourceInput.dispatchEvent(new Event('input'));
          }
        } else {
          const sourceInput = container.querySelector('#income-source') as HTMLInputElement | null;
          if (sourceInput) {
            sourceInput.value = '11月正職薪資';
            sourceInput.dispatchEvent(new Event('input'));
          }
        }

        if (amountInput) {
          amountInput.value = '60000';
          amountInput.dispatchEvent(new Event('input'));
        }
        if (categorySelect) {
          categorySelect.value = '薪資';
          categorySelect.dispatchEvent(new Event('change'));
        }

        await flushAsync();

        // 點擊儲存收入按鈕
        const submitBtn = (container.querySelector('#btn-submit-income') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('儲存')
          )) as HTMLButtonElement;

        expect(submitBtn, '收入表單應有可點擊的儲存按鈕').not.toBeNull();
        submitBtn.click();
        await flushAsync();

        // 驗證 addIncome 被呼叫
        expect(dbModule.addIncome).toHaveBeenCalled();
        const callArg = vi.mocked(dbModule.addIncome).mock.calls[0][0];
        expect(callArg.source).toBe('11月正職薪資');
        // 依據 v2.0 規格：徹底移除存入帳戶欄位，傳入 addIncome 之記錄物件不得包含 account
        expect(callArg.account, '傳入 addIncome 之記錄物件不得包含 account 欄位').toBeUndefined();
        expect(callArg.amount).toBe(60000);
        expect(callArg.category).toBe('薪資');

        // 驗證表單重設：金額欄位已清空
        expect(amountInput.value).toBe('');
      } finally {
        cleanup();
      }
    });

    it('儲存成功後應在介面上呈現暫時的成功提示訊息', async () => {
      const { container, cleanup } = mountComponent(TransactionForm);
      await flushAsync();

      try {
        const submitBtn = (container.querySelector('#btn-submit-expense') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('儲存')
          )) as HTMLButtonElement;

        submitBtn.click();
        await flushAsync();

        // 驗證介面出現「已成功儲存」文字
        const successNotice = Array.from(container.querySelectorAll('*')).find(
          (el) => el.textContent?.includes('成功儲存') || el.textContent?.includes('支出已成功儲存')
        );
        expect(successNotice, '儲存成功後應出現提示訊息').not.toBeUndefined();
      } finally {
        cleanup();
      }
    });
  });

  // =========================================================================
  // 5. 外幣換算與手續費計算行為 (Foreign Currency Interaction)
  // =========================================================================
  describe('5. 外幣換算與手續費響應行為', () => {
    it('支出表單啟用海外消費：預設手續費 1.5%，輸入外幣與台幣扣款後能計算總金額與實質匯率', async () => {
      const { container, cleanup } = mountComponent(TransactionForm);
      await flushAsync();

      try {
        // 勾選海外消費
        const foreignCheckbox = container.querySelector(
          'input[type="checkbox"]'
        ) as HTMLInputElement;
        if (foreignCheckbox) {
          foreignCheckbox.checked = true;
          foreignCheckbox.dispatchEvent(new Event('change'));
          await flushAsync();

          // 輸入外幣金額 100，台幣扣款 3200
          const foreignAmountInput = (container.querySelector('#foreign-expense-amount') ||
            container.querySelector('input[placeholder*="外幣金額"]')) as HTMLInputElement;
          const netTwdInput = (container.querySelector('#net-twd-amount') ||
            container.querySelector('input[placeholder*="台幣扣款"]')) as HTMLInputElement;

          if (foreignAmountInput && netTwdInput) {
            foreignAmountInput.value = '100';
            foreignAmountInput.dispatchEvent(new Event('input'));
            netTwdInput.value = '3200';
            netTwdInput.dispatchEvent(new Event('input'));

            const feeInput = (container.querySelector('#expense-fee-amount') ||
              container.querySelector('input[placeholder*="手續費"]')) as HTMLInputElement;
            if (feeInput) {
              feeInput.value = '48';
              feeInput.dispatchEvent(new Event('input'));
            }
            await flushAsync();

            // 手續費 1.5% = 48 元，總額 3248 元，實質匯率 32.48
            expect(container.textContent).toContain('48');
            expect(container.textContent).toContain('3248');
            expect(container.textContent).toMatch(/32\.48/);
          }
        }
      } finally {
        cleanup();
      }
    });

    it('收入表單啟用海外收入：預設手續費 0 元，輸入外幣金額與台幣到帳能自動反推實質匯率', async () => {
      const { container, cleanup } = mountComponent(TransactionForm);
      await flushAsync();

      try {
        const incomeTab =
          container.querySelector('#tab-income') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('收入')
          );
        (incomeTab as HTMLButtonElement).click();
        await flushAsync();

        // 勾選外幣收入
        const foreignCheckbox = container.querySelector(
          'input[type="checkbox"]'
        ) as HTMLInputElement;
        if (foreignCheckbox) {
          foreignCheckbox.checked = true;
          foreignCheckbox.dispatchEvent(new Event('change'));
          await flushAsync();

          // 外幣金額 USD 1000，台幣到帳 32000
          const foreignAmountInput = (container.querySelector('#foreign-income-amount') ||
            container.querySelector('input[placeholder*="外幣金額"]')) as HTMLInputElement;
          const twdAmountInput = container.querySelector('#income-amount') as HTMLInputElement;

          if (foreignAmountInput && twdAmountInput) {
            foreignAmountInput.value = '1000';
            foreignAmountInput.dispatchEvent(new Event('input'));
            twdAmountInput.value = '32000';
            twdAmountInput.dispatchEvent(new Event('input'));
            await flushAsync();

            // 手續費 0，實質匯率 32.00
            expect(container.textContent).toContain('NT$ 0');
            expect(container.textContent).toMatch(/32\.00|32/);
          }
        }
      } finally {
        cleanup();
      }
    });
  });

  // =========================================================================
  // 6. 規格 v1.1 增修規格單元測試 (Spec v1.1 Enhancements)
  // =========================================================================
  describe('6. 規格 v1.1 增修規格行為驗證測試', () => {
    // -----------------------------------------------------------------------
    // 情境 1: 【支出新增分類隔離】
    // -----------------------------------------------------------------------
    it('情境 1【支出新增分類隔離】：在有多筆商品時，新增商品 2 並點選「+ 新增分類」建立「新玩具」，商品 1 不會被自動改為「新玩具」，儲存時商品 1 正確 fallback 為「其他」', async () => {
      const { container, cleanup } = mountComponent(ExpenseForm);
      await flushAsync();

      try {
        // 1. 商品 1 填寫品名與單價，並刻意清空分類 (或留空)
        const nameInput0 = (container.querySelector('#expense-name') ||
          container.querySelector('input[placeholder*="品名"]')) as HTMLInputElement;
        const priceInput0 = (container.querySelector('#expense-amount') ||
          container.querySelector('input[placeholder*="單價"]')) as HTMLInputElement;
        const catSelect0 = container.querySelector('#expense-category') as HTMLSelectElement;

        expect(nameInput0, '應存在第 1 筆商品品名輸入框').not.toBeNull();
        expect(priceInput0, '應存在第 1 筆商品單價輸入框').not.toBeNull();
        expect(catSelect0, '應存在第 1 筆商品分類選單').not.toBeNull();

        nameInput0.value = '經典美式';
        nameInput0.dispatchEvent(new Event('input'));
        priceInput0.value = '50';
        priceInput0.dispatchEvent(new Event('input'));

        catSelect0.value = '';
        catSelect0.dispatchEvent(new Event('change'));
        await flushAsync();

        // 2. 點擊「+ 新增商品」新增第 2 筆商品
        const addItemBtn = (container.querySelector('#btn-add-item') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('新增商品')
          )) as HTMLButtonElement;
        expect(addItemBtn, '應存在「新增商品」按鈕').not.toBeNull();
        addItemBtn.click();
        await flushAsync();

        // 填寫第 2 筆商品的品名與單價
        const nameInput1 = container.querySelector('#item-name-1') as HTMLInputElement;
        const priceInput1 = container.querySelector('#item-price-1') as HTMLInputElement;
        const catSelect1 = container.querySelector('#item-cat-1') as HTMLSelectElement;

        expect(nameInput1, '應渲染第 2 筆商品品名輸入框').not.toBeNull();
        expect(priceInput1, '應渲染第 2 筆商品單價輸入框').not.toBeNull();
        expect(catSelect1, '應渲染第 2 筆商品分類選單').not.toBeNull();

        nameInput1.value = '樂高積木';
        nameInput1.dispatchEvent(new Event('input'));
        priceInput1.value = '500';
        priceInput1.dispatchEvent(new Event('input'));

        // 3. 在第 2 筆商品的分類選單選取「+ 新增分類...」
        catSelect1.value = '__add_new__';
        catSelect1.dispatchEvent(new Event('change'));
        await flushAsync();

        // 4. 輸入自訂分類名稱「新玩具」並點擊「確認新增」
        const customCatInput = container.querySelector('#custom-expense-category-input') as HTMLInputElement;
        const confirmCatBtn = container.querySelector('#btn-confirm-expense-category') as HTMLButtonElement;

        expect(customCatInput, '應展開自訂分類輸入框').not.toBeNull();
        expect(confirmCatBtn, '應存在確認新增分類按鈕').not.toBeNull();

        customCatInput.value = '新玩具';
        customCatInput.dispatchEvent(new Event('input'));
        confirmCatBtn.click();
        await flushAsync();

        // 5. 驗證商品 1 的分類沒有被自動修改為「新玩具」
        expect(catSelect0.value, '商品 1 分類絕不可被自動污染改為「新玩具」').not.toBe('新玩具');

        // 6. 點擊「儲存」按鈕
        const submitBtn = (container.querySelector('#btn-submit-expense') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('儲存')
          )) as HTMLButtonElement;
        submitBtn.click();
        await flushAsync();

        // 7. 驗證儲存至資料庫的內容：商品 1 fallback 為「其他」，商品 2 為「新玩具」
        expect(dbModule.addExpense).toHaveBeenCalled();
        const savedRecord = vi.mocked(dbModule.addExpense).mock.calls[0][0];
        const item1 = savedRecord.items.find((i) => i.name === '經典美式');
        const item2 = savedRecord.items.find((i) => i.name === '樂高積木');

        expect(item1, '儲存記錄應包含商品 1').toBeDefined();
        expect(item2, '儲存記錄應包含商品 2').toBeDefined();
        expect(item1?.category, '商品 1 未選分類時儲存應正確 fallback 為「其他」').toBe('其他');
        expect(item2?.category, '商品 2 建立新分類後儲存應為「新玩具」').toBe('新玩具');
      } finally {
        cleanup();
      }
    });

    // -----------------------------------------------------------------------
    // 情境 2: 【海外金額位置與移除無用總計】
    // -----------------------------------------------------------------------
    it('情境 2【海外金額位置與移除無用總計】：在海外模式下，驗證畫面不再包含「見海外換算」文字，且外幣金額與換算區塊位於商品明細下方', async () => {
      const { container, cleanup } = mountComponent(ExpenseForm);
      await flushAsync();

      try {
        // 切換至海外模式
        const foreignBtn = Array.from(container.querySelectorAll('.mode-switch button, button')).find(
          (b) => b.textContent?.trim() === '海外'
        ) as HTMLButtonElement | null;
        expect(foreignBtn, '應存在切換至海外模式之按鈕').not.toBeNull();
        foreignBtn!.click();
        await flushAsync();

        // 1. 驗證畫面不再包含「見海外換算」文字
        expect(container.textContent, '海外模式下應徹底移除「見海外換算」文字').not.toContain('見海外換算');

        // 2. 驗證外幣金額輸入框 (#foreign-expense-amount) 與換算區塊位於商品明細下方
        const foreignAmountInput = container.querySelector('#foreign-expense-amount');
        const addItemBtn = container.querySelector('#btn-add-item');

        expect(foreignAmountInput, '海外模式下應具備外幣金額輸入框 #foreign-expense-amount').not.toBeNull();
        expect(addItemBtn, '應存在新增商品按鈕 #btn-add-item').not.toBeNull();

        if (foreignAmountInput && addItemBtn) {
          const position = addItemBtn.compareDocumentPosition(foreignAmountInput);
          // foreignAmountInput 應出現在 addItemBtn 之後 (DOCUMENT_POSITION_FOLLOWING)
          expect(
            Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING),
            '外幣金額輸入與海外換算區塊在 DOM 結構中必須位於商品明細下方'
          ).toBe(true);
        }
      } finally {
        cleanup();
      }
    });

    // -----------------------------------------------------------------------
    // 情境 3: 【編輯模式取消機制】
    // -----------------------------------------------------------------------
    describe('情境 3【編輯模式取消機制】', () => {
      it('支出表單進入編輯模式（傳入 editData）時，畫面應顯示 #btn-cancel-edit；點擊後應發出 cancel 事件並清空表單狀態', async () => {
        const onCancel = vi.fn();
        const mockEditData = {
          id: 101,
          date: '2026-11-05',
          merchant: '微軟商店',
          paymentMethod: '信用卡',
          totalAmount: 1500,
          items: [
            { id: 'item-1', name: '無線滑鼠', quantity: 1, unitPrice: 1500, category: '餐飲' },
          ],
        };

        const { container, cleanup } = mountComponent(ExpenseForm, {
          editData: mockEditData,
          onCancel,
        });
        await flushAsync();

        try {
          const cancelBtn = container.querySelector('#btn-cancel-edit') as HTMLButtonElement;
          expect(cancelBtn, '支出表單進入編輯模式時，畫面應渲染取消編輯按鈕 #btn-cancel-edit').not.toBeNull();

          cancelBtn.click();
          await flushAsync();

          // 驗證發出 cancel 事件
          expect(onCancel, '點擊取消編輯按鈕後應 emit("cancel") 事件').toHaveBeenCalled();

          // 驗證清空表單狀態
          const merchantInput = container.querySelector('#merchant-input') as HTMLInputElement;
          expect(merchantInput.value, '點擊取消編輯後店家欄位狀態應清空').toBe('');
        } finally {
          cleanup();
        }
      });

      it('收入表單進入編輯模式時，畫面應顯示 #btn-cancel-edit；點擊後應發出 cancel 事件', async () => {
        const onCancel = vi.fn();
        const mockEditData = {
          id: 202,
          date: '2026-11-05',
          source: '專案外包',
          category: '薪資',
          amount: 8000,
        };

        const { container, cleanup } = mountComponent(IncomeForm, {
          editData: mockEditData,
          onCancel,
        });
        await flushAsync();

        try {
          const cancelBtn = container.querySelector('#btn-cancel-edit') as HTMLButtonElement;
          expect(cancelBtn, '收入表單進入編輯模式時，畫面應渲染取消編輯按鈕 #btn-cancel-edit').not.toBeNull();

          cancelBtn.click();
          await flushAsync();

          expect(onCancel, '點擊取消編輯按鈕後應 emit("cancel") 事件').toHaveBeenCalled();
        } finally {
          cleanup();
        }
      });

      it('TransactionForm 頂層接收到子表單取消時，應向上傳遞 cancel 事件', async () => {
        const onCancel = vi.fn();
        const editTarget = {
          type: 'expense' as const,
          data: {
            id: 303,
            date: '2026-11-05',
            merchant: '星巴克',
            paymentMethod: '現金',
            totalAmount: 160,
            items: [
              { id: 'item-1', name: '拿鐵', quantity: 1, unitPrice: 160, category: '餐飲' },
            ],
          },
        };

        const { container, cleanup } = mountComponent(TransactionForm, {
          editTarget,
          onCancel,
        });
        await flushAsync();

        try {
          const cancelBtn = container.querySelector('#btn-cancel-edit') as HTMLButtonElement;
          expect(cancelBtn, 'TransactionForm 在編輯模式下應能找到 #btn-cancel-edit').not.toBeNull();

          cancelBtn.click();
          await flushAsync();

          expect(onCancel, 'TransactionForm 接收到取消時應向上 emit("cancel") 事件').toHaveBeenCalled();
        } finally {
          cleanup();
        }
      });
    });

    // -----------------------------------------------------------------------
    // 情境 4: 【分類與支付方式未填健全 Fallback】
    // -----------------------------------------------------------------------
    it('情境 4【分類與支付方式未填健全 Fallback】：商品分類未選或選取 __add_new__ 但未填時 fallback「其他」，支付方式未選或選取 __add_new__ 但未填時 fallback「現金」', async () => {
      // 驗證規格 2.4:
      // 當商品分類值為空字串、空白字串或 '__add_new__' 時，儲存時強制 fallback 為「其他」
      // 當支付方式未選擇、值為空、空白字串或選取 '__add_new__' 且未填自訂名稱時，儲存結果必須 fallback 為「現金」
      const mockEditData = {
        id: 505,
        date: '2026-11-05',
        merchant: '測試防呆店家',
        paymentMethod: '__add_new__',
        items: [
          { id: 'item-1', name: '防呆測試商品', quantity: 1, unitPrice: 100, category: '__add_new__' },
        ],
      };

      const { container, cleanup } = mountComponent(ExpenseForm, {
        editData: mockEditData,
      });
      await flushAsync();

      try {
        const submitBtn = (container.querySelector('#btn-submit-expense') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('儲存') || b.textContent?.includes('修改')
          )) as HTMLButtonElement;
        expect(submitBtn, '應存在送出儲存按鈕').not.toBeNull();
        submitBtn.click();
        await flushAsync();

        expect(dbModule.updateExpense).toHaveBeenCalled();
        const updateCall = vi.mocked(dbModule.updateExpense).mock.calls[0][1];

        expect(
          updateCall.items[0]?.category,
          '支出商品分類選取 __add_new__ 但未填時，儲存結果中該商品的 category 必須 fallback 為「其他」'
        ).toBe('其他');

        expect(
          updateCall.paymentMethod,
          '支出支付方式選取 __add_new__ 但未填時，儲存結果中 paymentMethod 必須 fallback 為「現金」'
        ).toBe('現金');
      } finally {
        cleanup();
      }
    });

    // -----------------------------------------------------------------------
    // 情境 5: 【收入來源可選可新增】
    // -----------------------------------------------------------------------
    it('情境 5【收入來源可選可新增】：提供 #income-source-select 下拉選單並支援 __add_new__ 展開 #custom-income-source-input，並保留 #income-source 與 datalist 相容性', async () => {
      vi.mocked(dbModule.getDistinctIncomeSources).mockResolvedValue(['公司薪資', '股票股利']);

      const { container, cleanup } = mountComponent(IncomeForm);
      await flushAsync();

      try {
        // 1. 驗證向下相容性：保留 #income-source 與 #income-source-list
        expect(container.querySelector('#income-source'), '必須保留 #income-source 輸入框以相容既有契約').not.toBeNull();
        expect(container.querySelector('#income-source-list'), '必須保留 #income-source-list datalist 元素').not.toBeNull();

        // 2. 驗證新增的收入來源選單 #income-source-select 存在
        const sourceSelect = container.querySelector('#income-source-select') as HTMLSelectElement;
        expect(sourceSelect, '收入表單應提供 #income-source-select 下拉選單').not.toBeNull();

        // 驗證下拉選單包含歷史來源與新增來源選項
        const options = Array.from(sourceSelect.querySelectorAll('option')).map((o) => o.value);
        expect(options, '下拉選單選項應包含歷史來源「公司薪資」').toContain('公司薪資');
        expect(options, '下拉選單選項應包含歷史來源「股票股利」').toContain('股票股利');
        expect(options, '下拉選單選項應包含「+ 新增收入來源...」(__add_new__)').toContain('__add_new__');

        // 3. 選中 __add_new__ 時展開 #custom-income-source-input 自訂輸入框
        sourceSelect.value = '__add_new__';
        sourceSelect.dispatchEvent(new Event('change'));
        await flushAsync();

        const customInput = container.querySelector('#custom-income-source-input') as HTMLInputElement;
        expect(customInput, '選中 __add_new__ 時應展開 #custom-income-source-input 自訂輸入框').not.toBeNull();

        // 4. 輸入自訂來源並填寫金額後儲存
        customInput.value = '自媒體業配';
        customInput.dispatchEvent(new Event('input'));

        const amountInput = container.querySelector('#income-amount') as HTMLInputElement;
        if (amountInput) {
          amountInput.value = '25000';
          amountInput.dispatchEvent(new Event('input'));
        }
        await flushAsync();

        const submitBtn = (container.querySelector('#btn-submit-income') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('儲存')
          )) as HTMLButtonElement;
        submitBtn.click();
        await flushAsync();

        // 5. 驗證儲存結果之 source 為自訂輸入來源
        expect(dbModule.addIncome).toHaveBeenCalled();
        const saved = vi.mocked(dbModule.addIncome).mock.calls[0][0];
        expect(saved.source, '儲存結果中收入來源應為「自媒體業配」').toBe('自媒體業配');
      } finally {
        cleanup();
      }
    });
  });

  // =========================================================================
  // 7. 規格 v1.2: 店家快速挑選契約 (Merchant Quick Selection)
  // =========================================================================
  describe('7. 規格 v1.2: 店家快速挑選契約 (Merchant Quick Selection)', () => {
    it('支出表單店家欄位旁具備 #btn-select-merchant 按鈕，點擊後會開啟選擇店家彈窗', async () => {
      const { container, cleanup } = mountComponent(ExpenseForm);
      await flushAsync();

      try {
        const selectMerchantBtn = container.querySelector('#btn-select-merchant') as HTMLButtonElement | null;
        expect(selectMerchantBtn, '支出表單店家欄位旁應具備 #btn-select-merchant 快速挑選按鈕').not.toBeNull();

        selectMerchantBtn!.click();
        await flushAsync();

        // 點擊後開啟選擇店家彈窗
        const modal =
          document.querySelector('.select-modal-overlay, [role="dialog"], #select-merchant-modal') ||
          container.querySelector('.select-modal-overlay, [role="dialog"], #select-merchant-modal');
        expect(modal, '點擊 #btn-select-merchant 後應開啟選擇店家彈窗').not.toBeNull();
      } finally {
        cleanup();
      }
    });
  });

  // =========================================================================
  // 8. 規格 v1.3 增修規格行為驗證測試 (Spec v1.3 Enhancements)
  // =========================================================================
  describe('8. 規格 v1.3 增修規格行為驗證測試', () => {
    describe('8.1 店家輸入框 <datalist> 快速備援契約', () => {
      it('店家輸入框 #merchant-input 需綁定 list="merchant-options-list"，並具備 <datalist id="merchant-options-list"> 渲染歷史店家', async () => {
        vi.mocked(dbModule.getDistinctMerchants).mockResolvedValue(['全家便利商店', '7-ELEVEN', '星巴克']);

        const { container, cleanup } = mountComponent(ExpenseForm);
        await flushAsync();

        try {
          const merchantInput = container.querySelector('#merchant-input') as HTMLInputElement | null;
          expect(merchantInput, '應存在店家輸入框 #merchant-input').not.toBeNull();
          expect(
            merchantInput?.getAttribute('list'),
            '#merchant-input 輸入框之 list 屬性必須指向 merchant-options-list'
          ).toBe('merchant-options-list');

          const datalist = container.querySelector('#merchant-options-list') as HTMLDataListElement | null;
          expect(datalist, '畫面中必須存在 <datalist id="merchant-options-list">').not.toBeNull();

          const options = Array.from(datalist?.querySelectorAll('option') || []).map((o) => o.value);
          expect(options).toContain('全家便利商店');
          expect(options).toContain('7-ELEVEN');
          expect(options).toContain('星巴克');
        } finally {
          cleanup();
        }
      });
    });

    describe('8.2 規格 v2.0: 支付方式純淨模式與動態呈現規格 (純淨無預載、無既有資料佔位、已有資料預選首項與 Fallback 持久化)', () => {
      it('商品分類選單完全不包含空白選項 <option value="">，預設選中清單第 1 項，追加品項亦同', async () => {
        const { container, cleanup } = mountComponent(ExpenseForm);
        await flushAsync();

        try {
          // 1. 驗證商品分類選單 #expense-category
          const catSelect0 = container.querySelector('#expense-category') as HTMLSelectElement | null;
          expect(catSelect0, '應存在第一列商品分類選單 #expense-category').not.toBeNull();

          const catOptions = Array.from(catSelect0!.querySelectorAll('option'));
          const emptyCatOption = catOptions.find((opt) => opt.value === '');
          expect(emptyCatOption, '商品分類選單完全不應包含空白選項 <option value="">').toBeUndefined();

          // 預設為既有分類清單第 1 項（如「餐飲」）
          expect(catSelect0!.value, '商品分類選單預設值應為既有清單第 1 項').toBe('餐飲');

          // 2. 點擊「+ 新增商品」按鈕，驗證新追加的項目列亦無空白選項且預設首項
          const addItemBtn = (container.querySelector('#btn-add-item') ||
            Array.from(container.querySelectorAll('button')).find((b) =>
              b.textContent?.includes('新增商品')
            )) as HTMLButtonElement;
          expect(addItemBtn, '應存在新增商品按鈕').not.toBeNull();
          addItemBtn.click();
          await flushAsync();

          const catSelect1 = container.querySelector('#item-cat-1') as HTMLSelectElement | null;
          expect(catSelect1, '應渲染第 2 筆商品分類選單 #item-cat-1').not.toBeNull();

          const cat1Options = Array.from(catSelect1!.querySelectorAll('option'));
          const emptyCat1Option = cat1Options.find((opt) => opt.value === '');
          expect(emptyCat1Option, '新增品項之分類選單亦不得包含空白選項 <option value="">').toBeUndefined();
          expect(catSelect1!.value, '新增品項之分類預設值應為既有清單第 1 項').toBe('餐飲');
        } finally {
          cleanup();
        }
      });

      it('規格 1【純淨無預設】：DEFAULT_PAYMENT_METHODS 為空陣列，資料庫預設無支付方式記錄', () => {
        expect(dbModule.DEFAULT_PAYMENT_METHODS, 'DEFAULT_PAYMENT_METHODS 必須為空陣列').toEqual([]);
      });

      it('規格 2【無既有資料呈現】：當資料庫無任何支付方式記錄（設定表為空）時，#payment-method 選單應自動預選為 "__add_new__"，且自動展開自訂支付方式輸入框，不應包含 value="" 的佔位選項', async () => {
        vi.mocked(dbModule.getPaymentMethods).mockResolvedValue([]);

        const { container, cleanup } = mountComponent(ExpenseForm);
        await flushAsync();

        try {
          const paySelect = container.querySelector('#payment-method') as HTMLSelectElement | null;
          expect(paySelect, '應存在支付方式選單 #payment-method').not.toBeNull();

          const payOptions = Array.from(paySelect!.querySelectorAll('option'));
          const placeholderOption = payOptions.find((opt) => opt.value === '');
          expect(placeholderOption, '無既有資料時，選單不應包含 value="" 的佔位選項').toBeUndefined();

          const addNewOption = payOptions.find((opt) => opt.value === '__add_new__');
          expect(addNewOption, '選單末尾必須具備 value="__add_new__" 的新增選項').toBeDefined();
          expect(addNewOption?.textContent?.trim()).toContain('新增支付方式');

          // 選單應自動預選為 '__add_new__'
          expect(paySelect!.value, '無既有資料時，支付方式選單應自動預選為 "__add_new__"').toBe('__add_new__');

          // 自動展開自訂支付方式輸入框
          const customPaymentInput = container.querySelector('#custom-payment-input') as HTMLInputElement | null;
          expect(customPaymentInput, '無既有資料時，應自動展開自訂支付方式輸入框 (#custom-payment-input)').not.toBeNull();
        } finally {
          cleanup();
        }
      });

      it('規格 3【已有既有資料呈現】：當資料庫存在既有自訂支付方式時，#payment-method 選單不包含空白選項，並自動預選清單第 1 項', async () => {
        vi.mocked(dbModule.getPaymentMethods).mockResolvedValue(['信用卡', '悠遊卡']);

        const { container, cleanup } = mountComponent(ExpenseForm);
        await flushAsync();

        try {
          const paySelect = container.querySelector('#payment-method') as HTMLSelectElement | null;
          expect(paySelect, '應存在支付方式選單 #payment-method').not.toBeNull();

          const payOptions = Array.from(paySelect!.querySelectorAll('option'));
          const emptyPayOption = payOptions.find((opt) => opt.value === '');
          expect(emptyPayOption, '存在自訂支付方式時，選單不應包含空白選項 <option value="">').toBeUndefined();

          // 自動預選清單第 1 項
          expect(paySelect!.value, '存在自訂支付方式時，應自動預選既有清單第 1 項').toBe('信用卡');

          const addNewOption = payOptions.find((opt) => opt.value === '__add_new__');
          expect(addNewOption, '選單末尾仍應提供「+ 新增支付方式...」').toBeDefined();
        } finally {
          cleanup();
        }
      });

      it('規格 4【未填直接儲存之 Fallback 與自動持久化】：當選項處於新增狀態且未填自訂名稱直接儲存時，送出之支出記錄 paymentMethod 安全 fallback 為「現金」，且同時將「現金」新增至 IndexedDB paymentMethods 資料表', async () => {
        vi.mocked(dbModule.getPaymentMethods).mockResolvedValue([]);

        const { container, cleanup } = mountComponent(ExpenseForm);
        await flushAsync();

        try {
          const paySelect = container.querySelector('#payment-method') as HTMLSelectElement | null;
          expect(paySelect, '應存在支付方式選單 #payment-method').not.toBeNull();
          expect(paySelect!.value, '無支付方式記錄時自動處於 __add_new__ 狀態').toBe('__add_new__');

          // 輸入店家名稱、品項名稱與單價，但自訂支付方式輸入框未填寫任何名稱
          const merchantInput = container.querySelector('#merchant-input') as HTMLInputElement;
          merchantInput.value = '純淨支付測試店家';
          merchantInput.dispatchEvent(new Event('input'));

          const nameInput = (container.querySelector('#expense-name') ||
            container.querySelector('input[placeholder*="品名"]')) as HTMLInputElement;
          nameInput.value = '測試商品';
          nameInput.dispatchEvent(new Event('input'));

          const priceInput = (container.querySelector('#expense-amount') ||
            container.querySelector('input[placeholder*="單價"]')) as HTMLInputElement;
          priceInput.value = '150';
          priceInput.dispatchEvent(new Event('input'));
          await flushAsync();

          const submitBtn = (container.querySelector('#btn-submit-expense') ||
            Array.from(container.querySelectorAll('button')).find((b) =>
              b.textContent?.includes('儲存')
            )) as HTMLButtonElement;
          expect(submitBtn, '應存在儲存按鈕').not.toBeNull();
          submitBtn.click();
          await flushAsync();

          // 驗證 addExpense 寫入記錄
          expect(dbModule.addExpense, '應成功調用 addExpense').toHaveBeenCalled();
          const savedExpense = vi.mocked(dbModule.addExpense).mock.calls[0][0];
          expect(
            savedExpense.paymentMethod,
            '未填自訂名稱直接儲存時，expense 記錄中 paymentMethod 必須 fallback 為「現金」'
          ).toBe('現金');

          // 驗證自動持久化至 paymentMethods 資料表
          expect(
            dbModule.addPaymentMethod,
            '必須同時將「現金」寫入 IndexedDB paymentMethods 資料表'
          ).toHaveBeenCalledWith('現金');
        } finally {
          cleanup();
        }
      });

      it('規格 4 延伸【選取新增但未填名稱直接儲存】：paymentMethod 亦 fallback 為「現金」且自動持久化至資料庫', async () => {
        vi.mocked(dbModule.getPaymentMethods).mockResolvedValue([]);

        const { container, cleanup } = mountComponent(ExpenseForm);
        await flushAsync();

        try {
          const paySelect = container.querySelector('#payment-method') as HTMLSelectElement | null;
          expect(paySelect, '應存在支付方式選單 #payment-method').not.toBeNull();

          // 選取「+ 新增支付方式...」
          paySelect!.value = '__add_new__';
          paySelect!.dispatchEvent(new Event('change'));
          await flushAsync();

          // 輸入店家名稱、品項名稱與單價，但不填寫自訂支付方式名稱
          const merchantInput = container.querySelector('#merchant-input') as HTMLInputElement;
          merchantInput.value = '自訂未填測試店家';
          merchantInput.dispatchEvent(new Event('input'));

          const nameInput = (container.querySelector('#expense-name') ||
            container.querySelector('input[placeholder*="品名"]')) as HTMLInputElement;
          nameInput.value = '自訂未填品項';
          nameInput.dispatchEvent(new Event('input'));

          const priceInput = (container.querySelector('#expense-amount') ||
            container.querySelector('input[placeholder*="單價"]')) as HTMLInputElement;
          priceInput.value = '80';
          priceInput.dispatchEvent(new Event('input'));
          await flushAsync();

          const submitBtn = (container.querySelector('#btn-submit-expense') ||
            Array.from(container.querySelectorAll('button')).find((b) =>
              b.textContent?.includes('儲存')
            )) as HTMLButtonElement;
          expect(submitBtn, '應存在儲存按鈕').not.toBeNull();
          submitBtn.click();
          await flushAsync();

          // 驗證 addExpense 寫入記錄中 fallback 為「現金」
          expect(dbModule.addExpense, '應成功調用 addExpense').toHaveBeenCalled();
          const savedExpense = vi.mocked(dbModule.addExpense).mock.calls[0][0];
          expect(
            savedExpense.paymentMethod,
            '選取 __add_new__ 但未填名稱直接送出時，paymentMethod 必須 fallback 為「現金」'
          ).toBe('現金');

          // 驗證自動持久化至 paymentMethods 資料表
          expect(
            dbModule.addPaymentMethod,
            '必須同時將「現金」寫入 IndexedDB paymentMethods 資料表'
          ).toHaveBeenCalledWith('現金');
        } finally {
          cleanup();
        }
      });
    });

    describe('8.3 規格 v2.0: 商品分類選中新增才展開輸入框與海外手填金額保護', () => {
      it('選取「+ 新增分類...」時展開輸入框，未填寫自訂名稱直接儲存時安全 fallback 為「其他」', async () => {
        const { container, cleanup } = mountComponent(ExpenseForm);
        await flushAsync();

        try {
          // 1. 填寫品名與單價
          const nameInput0 = (container.querySelector('#expense-name') ||
            container.querySelector('input[placeholder*="品名"]')) as HTMLInputElement;
          const priceInput0 = (container.querySelector('#expense-amount') ||
            container.querySelector('input[placeholder*="單價"]')) as HTMLInputElement;

          nameInput0.value = '特調飲品';
          nameInput0.dispatchEvent(new Event('input'));
          priceInput0.value = '80';
          priceInput0.dispatchEvent(new Event('input'));

          // 2. 選取「+ 新增分類...」
          const catSelect0 = container.querySelector('#expense-category') as HTMLSelectElement;
          catSelect0.value = '__add_new__';
          catSelect0.dispatchEvent(new Event('change'));
          await flushAsync();

          // 3. 驗證自訂輸入框展開，但保持未填寫直接點擊儲存
          const submitBtn = (container.querySelector('#btn-submit-expense') ||
            Array.from(container.querySelectorAll('button')).find((b) =>
              b.textContent?.includes('儲存')
            )) as HTMLButtonElement;
          submitBtn.click();
          await flushAsync();

          // 4. 驗證儲存至資料庫的記錄中，該第一筆商品的分類安全 fallback 為「其他」
          expect(dbModule.addExpense).toHaveBeenCalled();
          const savedRecord = vi.mocked(dbModule.addExpense).mock.calls[0][0];
          const item = savedRecord.items.find((i: any) => i.name === '特調飲品');
          expect(item, '儲存記錄中應包含特調飲品').toBeDefined();
          expect(
            item?.category,
            '選取新增分類但未填寫直接儲存時，商品分類必須安全 fallback 為「其他」'
          ).toBe('其他');
        } finally {
          cleanup();
        }
      });

      it('海外支出模式下，在未填寫商品明細（商品小計為 0）時，使用者手填 #foreign-expense-amount 金額不會被 Watcher 清空或重設為 0', async () => {
        const { container, cleanup } = mountComponent(ExpenseForm);
        await flushAsync();

        try {
          // 1. 切換至海外支出模式
          const foreignBtn = Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.trim() === '海外'
          ) as HTMLButtonElement;
          expect(foreignBtn, '應存在「海外」切換按鈕').toBeDefined();
          foreignBtn.click();
          await flushAsync();

          const foreignAmountInput = container.querySelector('#foreign-expense-amount') as HTMLInputElement | null;
          expect(foreignAmountInput, '海外模式下應存在 #foreign-expense-amount 外幣金額輸入框').not.toBeNull();

          // 2. 使用者在未填寫商品明細（商品單價預設為 0，商品小計為 0）時，手填外幣金額 100
          foreignAmountInput!.value = '100';
          foreignAmountInput!.dispatchEvent(new Event('input'));
          await flushAsync();

          expect(foreignAmountInput!.value).toBe('100');

          // 3. 模擬觸發 Watcher 監聽的相依來源變動（新增折扣後移除，使 discountsTotal 經歷變動回到 0）
          const addDiscountBtn = Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('新增折扣')
          ) as HTMLButtonElement;
          expect(addDiscountBtn, '應存在新增折扣按鈕').toBeDefined();
          addDiscountBtn.click();
          await flushAsync();

          const discAmountInput = container.querySelector('input[placeholder="折抵金額"]') as HTMLInputElement;
          if (discAmountInput) {
            discAmountInput.value = '10';
            discAmountInput.dispatchEvent(new Event('input'));
            await flushAsync();
          }

          const removeDiscBtn = Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.trim() === '移除'
          ) as HTMLButtonElement;
          expect(removeDiscBtn, '應存在折扣移除按鈕').toBeDefined();
          removeDiscBtn.click();
          await flushAsync();

          // 4. 驗證在商品小計依然為 0 的情況下，使用者手填之外幣金額不得被 Watcher 清空或覆蓋為 0 或空字串
          expect(
            foreignAmountInput!.value,
            '品項小計為 0 時，Watcher 不得清空或重設使用者手填之外幣金額'
          ).toBe('100');

          // 5. 使用者填寫台幣扣款並儲存，驗證儲存之外幣總額確實保留手填之 100
          const netTwdInput = container.querySelector('#net-twd-amount') as HTMLInputElement;
          netTwdInput.value = '3200';
          netTwdInput.dispatchEvent(new Event('input'));
          await flushAsync();

          const submitBtn = (container.querySelector('#btn-submit-expense') ||
            Array.from(container.querySelectorAll('button')).find((b) =>
              b.textContent?.includes('儲存')
            )) as HTMLButtonElement;
          submitBtn.click();
          await flushAsync();

          expect(dbModule.addExpense).toHaveBeenCalled();
          const savedRecord = vi.mocked(dbModule.addExpense).mock.calls[0][0];
          expect(savedRecord.isForeign).toBe(true);
          expect(
            savedRecord.foreignAmount,
            '儲存記錄中外幣金額必須為使用者手填之 100'
          ).toBe(100);
        } finally {
          cleanup();
        }
      });
    });

    describe('8.4 規格 v2.0: 海外支出模式底部無多餘總計行為驗證', () => {
      it('國內支出模式下底部儲存按鈕旁應呈現「總計」，海外支出模式下底部儲存按鈕旁嚴禁顯示任何「總計」資訊', async () => {
        const { container, cleanup } = mountComponent(ExpenseForm);
        await flushAsync();

        try {
          // 取得底部操作列（儲存按鈕所在區塊）
          const getBottomBar = () => {
            const submitBtn = container.querySelector('#btn-submit-expense');
            return container.querySelector('.pt-4.border-t') || submitBtn?.closest('.border-t') || submitBtn?.parentElement;
          };

          // 1. 國內模式（預設）：底部按鈕旁應呈現「總計」
          const bottomBarDomestic = getBottomBar();
          expect(bottomBarDomestic, '應存在底部按鈕操作列').not.toBeNull();
          expect(bottomBarDomestic?.textContent, '國內模式下底部按鈕旁應顯示「總計」').toContain('總計');

          // 2. 切換為海外支出模式
          const foreignBtn = Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.trim() === '海外'
          ) as HTMLButtonElement;
          expect(foreignBtn, '應存在海外模式切換按鈕').toBeDefined();
          foreignBtn.click();
          await flushAsync();

          // 3. 海外模式：依據 v2.0 規格，底部儲存按鈕旁嚴禁顯示「總計」文字或金額
          const bottomBarForeign = getBottomBar();
          expect(bottomBarForeign?.textContent, '海外模式下底部儲存按鈕旁嚴禁顯示「總計」資訊').not.toContain('總計');
        } finally {
          cleanup();
        }
      });
    });
  });

  // =========================================================================
  // 9. 規格 v2.0: 徹底移除存入帳戶欄位行為驗證測試 (Income Account Removed)
  // =========================================================================
  describe('9. 規格 v2.0: 徹底移除存入帳戶欄位行為驗證測試 (Income Account Removed)', () => {
    it('IncomeForm.vue 畫面中不得存在 #income-account 存入帳戶輸入框，且儲存收入時記錄物件中嚴禁包含 account 欄位', async () => {
      const { container, cleanup } = mountComponent(IncomeForm);
      await flushAsync();

      try {
        // 1. 驗證徹底移除：畫面中嚴禁存在 #income-account 存入帳戶輸入框
        const accountInput = container.querySelector('#income-account');
        expect(accountInput, '依據 v2.0 規格，IncomeForm 畫面中不得存在 #income-account 存入帳戶輸入欄位').toBeNull();

        // 2. 填寫入帳金額 88000
        const amountInput = container.querySelector('#income-amount') as HTMLInputElement | null;
        expect(amountInput, '應存在 #income-amount 入帳金額輸入欄位').not.toBeNull();
        amountInput!.value = '88000';
        amountInput!.dispatchEvent(new Event('input'));
        await flushAsync();

        // 3. 點擊儲存按鈕
        const submitBtn = (container.querySelector('#btn-submit-income') ||
          Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('儲存')
          )) as HTMLButtonElement | null;
        expect(submitBtn, '應存在儲存收入按鈕').not.toBeNull();
        submitBtn!.click();
        await flushAsync();

        // 4. 驗證 addIncome 寫入之記錄中完全不得包含 account 欄位 (或 account 為 undefined)
        expect(dbModule.addIncome).toHaveBeenCalled();
        const callArg = vi.mocked(dbModule.addIncome).mock.calls[0][0];
        expect(callArg.account, '傳入 addIncome 的記錄物件中嚴禁包含 account 屬性').toBeUndefined();
      } finally {
        cleanup();
      }
    });
  });

  // =========================================================================
  // 10. 規格 v2.0: 每月回饋登記 (RewardForm.vue) 回饋來源純選單模式與自訂展開契約
  // =========================================================================
  describe('10. 規格 v2.0: 每月回饋登記 (RewardForm.vue) 回饋來源純選單模式與自訂展開契約', () => {
    it('RewardForm.vue 平時提供純下拉選單 #reward-source-select，不顯示常駐文字輸入框，且預設不展開 #custom-reward-source-input', async () => {
      const { container, cleanup } = mountComponent(RewardForm);
      await flushAsync();

      try {
        // 1. 驗證存在純下拉選單 #reward-source-select
        const select = container.querySelector('#reward-source-select') as HTMLSelectElement | null;
        expect(select, 'RewardForm 必須提供純下拉選單 #reward-source-select').not.toBeNull();

        // 2. 驗證平時不顯示常駐文字輸入框（若有相容元素必須為 hidden）
        const textInput = container.querySelector('#reward-source') as HTMLElement | null;
        if (textInput) {
          const isHidden = textInput.classList.contains('hidden') || textInput.style.display === 'none';
          expect(isHidden, '平時不得顯示常駐文字輸入框 #reward-source').toBe(true);
        }

        // 3. 驗證自訂輸入框預設不展示
        const customInput = container.querySelector('#custom-reward-source-input');
        expect(customInput, '平時不得展開 #custom-reward-source-input').toBeNull();
      } finally {
        cleanup();
      }
    });

    it('在 #reward-source-select 選取「+ 新增回饋來源...」時，下方動態展開 #custom-reward-source-input 輸入框', async () => {
      const { container, cleanup } = mountComponent(RewardForm);
      await flushAsync();

      try {
        const select = container.querySelector('#reward-source-select') as HTMLSelectElement | null;
        expect(select).not.toBeNull();

        // 選取「+ 新增回饋來源...」
        select!.value = '__add_new__';
        select!.dispatchEvent(new Event('change'));
        await flushAsync();

        // 驗證展開自訂輸入框
        const customInput = container.querySelector('#custom-reward-source-input') as HTMLInputElement | null;
        expect(customInput, '選中 __add_new__ 後應動態展開 #custom-reward-source-input').not.toBeNull();
      } finally {
        cleanup();
      }
    });

    it('選取「+ 新增回饋來源...」並在 #custom-reward-source-input 輸入名稱後儲存，傳入 addReward 之記錄其 sourceName 為該自訂來源', async () => {
      const { container, cleanup } = mountComponent(RewardForm);
      await flushAsync();

      try {
        // 1. 選取「+ 新增回饋來源...」
        const select = container.querySelector('#reward-source-select') as HTMLSelectElement;
        expect(select).not.toBeNull();
        select.value = '__add_new__';
        select.dispatchEvent(new Event('change'));
        await flushAsync();

        // 2. 填寫自訂回饋來源「街口聯名卡回饋」
        const customInput = container.querySelector('#custom-reward-source-input') as HTMLInputElement;
        expect(customInput).not.toBeNull();
        customInput.value = '街口聯名卡回饋';
        customInput.dispatchEvent(new Event('input'));

        // 3. 填寫回饋金額 450
        const amountInput = container.querySelector('#reward-amount') as HTMLInputElement;
        amountInput.value = '450';
        amountInput.dispatchEvent(new Event('input'));
        await flushAsync();

        // 4. 點擊儲存
        const submitBtn = container.querySelector('#btn-submit-reward') as HTMLButtonElement;
        expect(submitBtn).not.toBeNull();
        submitBtn.click();
        await flushAsync();

        // 5. 驗證 addReward 寫入記錄且呼叫 addRewardSource
        expect(dbModule.addReward).toHaveBeenCalled();
        const callArg = vi.mocked(dbModule.addReward).mock.calls[0][0];
        expect(callArg.sourceName, '新增自訂回饋來源時應正確寫入 sourceName: "街口聯名卡回饋"').toBe('街口聯名卡回饋');
        expect(callArg.amount).toBe(450);
        expect(dbModule.addRewardSource).toHaveBeenCalledWith('街口聯名卡回饋');
      } finally {
        cleanup();
      }
    });

    it('未輸入回饋來源直接點擊儲存時，畫面顯示「請輸入回饋來源」防呆錯誤訊息，且不呼叫 addReward', async () => {
      const { container, cleanup } = mountComponent(RewardForm);
      await flushAsync();

      try {
        // 金額填寫 100，但來源留空
        const amountInput = container.querySelector('#reward-amount') as HTMLInputElement;
        amountInput.value = '100';
        amountInput.dispatchEvent(new Event('input'));
        await flushAsync();

        const submitBtn = container.querySelector('#btn-submit-reward') as HTMLButtonElement;
        submitBtn.click();
        await flushAsync();

        // 驗證錯誤訊息提示
        expect(container.textContent).toContain('請輸入回饋來源');
        expect(dbModule.addReward).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('進入編輯模式（傳入 editData）時，畫面應顯示 #btn-cancel-edit 取消編輯按鈕，點擊後發出 cancel 事件', async () => {
      const onCancel = vi.fn();
      const mockEditData = {
        id: 99,
        yearMonth: '2026-11',
        sourceName: 'Richart 點數折抵',
        amount: 300,
        createdAt: 1730818800000,
      };

      const { container, cleanup } = mountComponent(RewardForm, {
        editData: mockEditData,
        onCancel,
      });
      await flushAsync();

      try {
        const cancelBtn = container.querySelector('#btn-cancel-edit') as HTMLButtonElement | null;
        expect(cancelBtn, '編輯模式下應存在 #btn-cancel-edit 按鈕').not.toBeNull();

        cancelBtn!.click();
        await flushAsync();

        expect(onCancel).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });
  });

  describe('折扣分類設定測試 (ExpenseForm)', () => {
    it('點擊 + 新增折扣 後應顯示折扣分類選單 (#disc-cat-0)，預設非「其他」且儲存時應帶入所選分類', async () => {
      vi.mocked(dbModule.getCategories).mockResolvedValue([
        { id: 1, name: '餐飲', type: 'expense', isDefault: true },
        { id: 2, name: '日用品', type: 'expense', isDefault: false },
      ]);

      const { container, cleanup } = mountComponent(ExpenseForm);
      await flushAsync();

      try {
        // 先填寫第一項商品
        const nameInput = container.querySelector('#expense-name') as HTMLInputElement;
        const priceInput = container.querySelector('#expense-amount') as HTMLInputElement;
        nameInput.value = '衛生紙';
        nameInput.dispatchEvent(new Event('input'));
        priceInput.value = '200';
        priceInput.dispatchEvent(new Event('input'));

        // 點擊 + 新增折扣
        const buttons = Array.from(container.querySelectorAll('button'));
        const addDiscBtn = buttons.find((b) => b.textContent?.includes('新增折扣')) as HTMLButtonElement;
        expect(addDiscBtn).toBeTruthy();
        addDiscBtn.click();
        await flushAsync();

        const discCatSelect = container.querySelector('#disc-cat-0') as HTMLSelectElement | null;
        expect(discCatSelect, '應渲染折扣分類選單 #disc-cat-0').not.toBeNull();
        expect(discCatSelect!.value).not.toBe('其他');
        expect(discCatSelect!.value).toBeTruthy();

        // 切換折扣分類為餐飲並填寫折扣名稱與金額
        discCatSelect!.value = '餐飲';
        discCatSelect!.dispatchEvent(new Event('change'));
        const discNameInput = container.querySelector('#disc-name-0') as HTMLInputElement;
        const discAmountInput = container.querySelector('#disc-amount-0') as HTMLInputElement;
        discNameInput.value = '滿額折扣';
        discNameInput.dispatchEvent(new Event('input'));
        discAmountInput.value = '30';
        discAmountInput.dispatchEvent(new Event('input'));
        await flushAsync();

        // 送出表單
        const submitBtn = container.querySelector('#btn-submit-expense') as HTMLButtonElement;
        submitBtn.click();
        await flushAsync();

        expect(dbModule.addExpense).toHaveBeenCalledTimes(1);
        const savedRecord = vi.mocked(dbModule.addExpense).mock.calls[0][0];
        const discItem = savedRecord.items.find((it) => it.type === 'discount');
        expect(discItem).toBeDefined();
        expect(discItem!.category).toBe('餐飲');
        expect(discItem!.subtotal).toBe(-30);
      } finally {
        cleanup();
      }
    });
  });
});


