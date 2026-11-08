/**
 * @file settings_view.spec.ts
 * @description Sand Dollar 設定頁面 (SettingsView.vue) 與 App.vue 導覽整合、表單連動及測試斷言強化（切片 B）單元測試套件
 *
 * 涵蓋測試範疇：
 * 1. 導覽與標題/元件渲染：
 *    - 渲染 App.vue 時，底部導覽列包含「設定」分頁按鈕，點擊後能切換至設定頁面。
 *    - 保留原有的備份功能：介面具備 #backup-file-input、#btn-restore-backup 以及匯出備份按鈕。
 *    - 還原成功時，介面訊息應包含「支付方式」、「收入來源」、「回饋來源」之筆數回饋。
 * 2. 分類 CRUD 測試：
 *    - 顯示分類列表（支出分類與收入分類切換）。
 *    - 新增分類：填入名稱後點擊新增，列表成功出現新分類。
 *    - 編輯分類：點擊編輯按鈕後修改名稱儲存，列表內容更新。
 *    - 刪除分類：點擊刪除按鈕後，該分類自列表中移除。
 * 3. 支付方式 CRUD 測試：
 *    - 新增支付方式：輸入名稱並新增，列表顯示新支付方式。
 *    - 編輯支付方式：點擊編輯修改名稱，儲存後更新。
 *    - 刪除支付方式：點擊刪除後移除。
 * 4. 收入來源 CRUD 測試：
 *    - 新增收入來源：輸入名稱並新增，列表顯示新收入來源。
 *    - 編輯收入來源：修改名稱儲存後更新。
 *    - 刪除收入來源：點擊刪除後移除。
 * 5. 回饋來源 CRUD 測試：
 *    - 新增回饋來源：輸入名稱並新增，列表顯示新回饋來源。
 *    - 編輯回饋來源：修改名稱儲存後更新。
 *    - 刪除回饋來源：點擊刪除後移除。
 * 6. 清除所有資料（二次同意防呆機制）測試：
 *    - 點擊「清除所有資料」按鈕 (#btn-clear-all-data)，展開/出現第一次確認提示。
 *    - 若在第一次確認點擊取消，資料不被清除。
 *    - 點擊第一次確認按鈕 (#btn-confirm-clear-1)，出現第二次警示確認。
 *    - 若在第二次確認點擊取消，資料不被清除。
 *    - 點擊第二次確認按鈕 (#btn-confirm-clear-2)，資料庫完全被清空（呼叫 clearAllDatabaseData），並顯示清除成功訊息 (#clear-success-message)。
 * 7. 表單與設定連動測試：
 *    - IncomeForm.vue:
 *      - 收入來源下拉選單選項來自 incomeSources 設定表。
 *      - 當選取「+ 新增收入來源...」並送出儲存時，自動呼叫 addIncomeSource 將新來源持久化至設定表。
 *    - RewardForm.vue:
 *      - 回饋來源下拉選單選項來自 rewardSources 設定表。
 *      - 當選取「+ 新增回饋來源...」並送出儲存時，自動呼叫 addRewardSource 將新來源持久化至設定表。
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import App from '@/App.vue';
import SettingsView from '@/components/SettingsView.vue';
import IncomeForm from '@/components/IncomeForm.vue';
import RewardForm from '@/components/RewardForm.vue';
import { db } from '@/db';
import * as dbModule from '@/db';

// 宣告掛載測試結果介面
interface MountResult {
  app: any;
  vm: any;
  container: HTMLElement;
  cleanup: () => void;
}

/**
 * 掛載 Vue 元件至真實 DOM 容器中
 */
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

/**
 * 輔助函式：等待 Vue 響應式週期與 microtask 佇列刷新
 */
async function flushAsync(ms = 60) {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, ms));
  await nextTick();
}

/**
 * 輔助函式：取得 SettingsView 元件
 */
async function loadSettingsViewComponent(): Promise<any> {
  return SettingsView;
}

describe('Sand Dollar 設定頁面與導覽整合單元測試 (settings_view.spec.ts)', () => {
  let activeCleanups: Array<() => void> = [];

  beforeEach(async () => {
    // 重設 IndexedDB 各資料表
    if (db) {
      if (db.expenses) await db.expenses.clear();
      if (db.incomes) await db.incomes.clear();
      if (db.rewards) await db.rewards.clear();
      if (db.categories) await db.categories.clear();
      if (db.paymentMethods) await db.paymentMethods.clear();
      if (db.incomeSources) await db.incomeSources.clear();
      if (db.rewardSources) await db.rewardSources.clear();
    }
  });

  afterEach(() => {
    activeCleanups.forEach((cleanup) => cleanup());
    activeCleanups = [];
    vi.restoreAllMocks();
  });

  // ==========================================
  // 1. App.vue 導覽與設定頁面整合渲染
  // ==========================================
  describe('1. 導覽與標題/元件渲染 (App.vue 整合)', () => {
    it('渲染 App.vue 時，底部導覽列包含「設定」分頁按鈕，點擊後能切換至設定頁面', async () => {
      const { container, cleanup } = mountComponent(App);
      activeCleanups.push(cleanup);
      await flushAsync();

      // 尋找底部導覽列中的所有 tab 按鈕
      const tabs = Array.from(container.querySelectorAll('button[role="tab"]')) as HTMLButtonElement[];
      
      // 依規格書要求，底部導覽列應具備「設定」分頁
      const settingsTab = tabs.find((btn) => btn.textContent?.includes('設定'));
      expect(settingsTab, '底部導覽列必須包含「設定」分頁按鈕').toBeDefined();

      // 點擊設定分頁按鈕
      settingsTab?.click();
      await flushAsync();

      // 驗證進入設定頁面：畫面主區域應呈現設定頁面標題或標識
      const hasSettingsContent =
        container.textContent?.includes('設定') ||
        container.querySelector('#settings-view') !== null ||
        container.querySelector('.settings-container') !== null;
      expect(hasSettingsContent, '點擊設定按鈕後應切換至設定頁面').toBe(true);
    });

    it('驗證 App.vue 底部導覽列設定 Tab 僅包含「設定」，不依賴「備份」輔助文字', async () => {
      const { container, cleanup } = mountComponent(App);
      activeCleanups.push(cleanup);
      await flushAsync();

      // 尋找底部導覽列中的所有 tab 按鈕
      const tabs = Array.from(container.querySelectorAll('button[role="tab"]')) as HTMLButtonElement[];
      const settingsTab = tabs.find((btn) => btn.textContent?.includes('設定'));
      expect(settingsTab, '底部導覽列必須包含「設定」分頁按鈕').toBeDefined();

      // 驗證設定 Tab 按鈕純文字內容只包含「設定」，不應依賴或包含「備份」輔助文字（如 sr-only 相容文字）
      const tabText = settingsTab?.textContent || '';
      expect(tabText).toContain('設定');
      expect(tabText, '設定 Tab 不得再包含「備份」文字').not.toContain('備份');
    });

    it('設定頁面完整保留既有的備份與還原功能 (#backup-file-input, #btn-restore-backup, 匯出備份按鈕)', async () => {
      const { container, cleanup } = mountComponent(App);
      activeCleanups.push(cleanup);
      await flushAsync();

      // 點擊「設定」分頁按鈕
      const tabs = Array.from(container.querySelectorAll('button[role="tab"]')) as HTMLButtonElement[];
      const settingsTab = tabs.find((btn) => btn.textContent?.includes('設定'));
      expect(settingsTab, '底部導覽列必須具備「設定」分頁按鈕').toBeDefined();
      settingsTab?.click();
      await flushAsync();

      // 驗證必備備份還原 DOM 元素
      const backupFileInput = container.querySelector('#backup-file-input');
      expect(backupFileInput, '介面必須具備備份檔案選擇器 (#backup-file-input)').not.toBeNull();

      const restoreBackupBtn = container.querySelector('#btn-restore-backup');
      expect(restoreBackupBtn, '介面必須具備一鍵還原按鈕 (#btn-restore-backup)').not.toBeNull();

      // 驗證匯出備份按鈕存在
      const allButtons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[];
      const exportBtn = allButtons.find((btn) =>
        btn.id === 'btn-export-backup' || btn.textContent?.includes('匯出備份') || btn.textContent?.includes('匯出')
      );
      expect(exportBtn, '介面必須具備匯出備份按鈕').toBeDefined();
    });

    it('測試還原訊息：還原成功時，介面訊息應包含「支付方式」、「收入來源」、「回饋來源」之筆數回饋', async () => {
      const SettingsViewComp = await loadSettingsViewComponent();
      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      const backupFileInput = container.querySelector('#backup-file-input') as HTMLInputElement;
      expect(backupFileInput, '介面必須具備備份檔案選擇器 (#backup-file-input)').not.toBeNull();

      // 構造備份 JSON 檔案內容，包含支付方式、收入來源、回饋來源
      const mockBackup = {
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
          expenses: [],
          incomes: [],
          rewards: [],
          categories: [],
          paymentMethods: [{ name: 'LINE Pay', isDefault: false }],
          incomeSources: [{ name: '兼職外包', isDefault: false }],
          rewardSources: [{ name: 'LINE POINTS', isDefault: false }],
        },
      };

      const jsonStr = JSON.stringify(mockBackup);
      const file = new File([jsonStr], 'backup.json', { type: 'application/json' });

      Object.defineProperty(backupFileInput, 'files', {
        value: [file],
        writable: true,
        configurable: true,
      });

      backupFileInput.dispatchEvent(new Event('change'));
      await flushAsync(100);

      const statusEl = container.querySelector('.border-teal-200, .bg-teal-50, #backup-status-message') || container;
      const statusText = statusEl.textContent || '';

      expect(statusText, '還原成功訊息應包含「支付方式」筆數回饋').toContain('支付方式');
      expect(statusText, '還原成功訊息應包含「收入來源」筆數回饋').toContain('收入來源');
      expect(statusText, '還原成功訊息應包含「回饋來源」筆數回饋').toContain('回饋來源');
    });
  });

  // ==========================================
  // 2. 分類 CRUD 測試 (Category Management)
  // ==========================================
  describe('2. 分類 CRUD 測試', () => {
    it('顯示分類列表，並支援支出分類與收入分類切換', async () => {
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在並成功匯入').toBeTruthy();

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      // 預設應有分類切換按鈕/分頁 (支出分類 / 收入分類)
      const expenseTab = container.querySelector('#tab-category-expense') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('支出'));
      const incomeTab = container.querySelector('#tab-category-income') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('收入'));

      expect(expenseTab, '必須具備切換支出分類的按鈕或標籤').toBeDefined();
      expect(incomeTab, '必須具備切換收入分類的按鈕或標籤').toBeDefined();

      // 點擊切換至支出分類
      (expenseTab as HTMLElement)?.click();
      await flushAsync();
      expect(container.querySelector('#category-list, .category-list'), '應能呈現分類列表').not.toBeNull();
    });

    it('新增分類：填入名稱後點擊新增，列表成功出現新分類', async () => {
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在').toBeTruthy();

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      // 切換至支出分類
      const expenseTab = container.querySelector('#tab-category-expense') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('支出'));
      (expenseTab as HTMLElement)?.click();
      await flushAsync();

      // 填入新增分類名稱
      const input = (container.querySelector('#input-category-name') ||
        container.querySelector('input[placeholder*="分類"]')) as HTMLInputElement;
      expect(input, '必須具備分類名稱輸入框').not.toBeNull();
      input.value = '寵物日常';
      input.dispatchEvent(new Event('input'));
      await flushAsync();

      // 點擊新增按鈕
      const addBtn = (container.querySelector('#btn-add-category') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('新增分類') || b.textContent?.includes('新增'))) as HTMLButtonElement;
      expect(addBtn, '必須具備新增分類按鈕').not.toBeNull();
      addBtn.click();
      await flushAsync();

      // 驗證列表成功呈現「寵物日常」
      expect(container.textContent).toContain('寵物日常');
    });

    it('編輯分類：點擊編輯按鈕後修改名稱儲存，列表內容更新', async () => {
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在').toBeTruthy();

      // 預先在資料庫或介面中寫入一筆自訂分類
      if (db?.categories) {
        await db.categories.add({ name: '舊分類名', type: 'expense', isDefault: false });
      }

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      // 找到編輯按鈕
      const editBtn = (container.querySelector('.btn-edit-category') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('編輯') || b.getAttribute('aria-label') === '編輯')) as HTMLButtonElement;
      expect(editBtn, '分類列表項目應具備編輯按鈕').toBeDefined();
      editBtn?.click();
      await flushAsync();

      // 輸入修改後名稱
      const editInput = (container.querySelector('.input-edit-category') ||
        container.querySelector('#input-category-name') ||
        container.querySelector('input[type="text"]')) as HTMLInputElement;
      expect(editInput, '編輯模式下應出現編輯輸入框').not.toBeNull();
      editInput.value = '更新分類名';
      editInput.dispatchEvent(new Event('input'));
      await flushAsync();

      // 點擊儲存按鈕
      const saveBtn = (container.querySelector('.btn-save-category') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('儲存') || b.textContent?.includes('確認'))) as HTMLButtonElement;
      saveBtn?.click();
      await flushAsync();

      // 驗證更新後名稱出現
      expect(container.textContent).toContain('更新分類名');
      expect(container.textContent).not.toContain('舊分類名');
    });

    it('刪除分類：點擊刪除按鈕後，該分類自列表中移除', async () => {
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在').toBeTruthy();

      if (db?.categories) {
        await db.categories.add({ name: '欲刪除分類', type: 'expense', isDefault: false });
      }

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      expect(container.textContent).toContain('欲刪除分類');

      // 找到刪除按鈕
      const deleteBtn = (container.querySelector('.btn-delete-category') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('刪除') || b.getAttribute('aria-label') === '刪除')) as HTMLButtonElement;
      expect(deleteBtn, '分類項目應具備刪除按鈕').toBeDefined();
      deleteBtn?.click();
      await flushAsync();

      // 驗證已被移除
      expect(container.textContent).not.toContain('欲刪除分類');
    });
  });

  // ==========================================
  // 3. 支付方式 CRUD 測試 (Payment Method Management)
  // ==========================================
  describe('3. 支付方式 CRUD 測試', () => {
    it('新增支付方式：輸入名稱並新增，列表顯示新支付方式', async () => {
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在').toBeTruthy();

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      const input = (container.querySelector('#input-payment-method-name') ||
        container.querySelector('input[placeholder*="支付方式"]')) as HTMLInputElement;
      expect(input, '必須具備支付方式輸入框').not.toBeNull();
      input.value = '台灣Pay錢包';
      input.dispatchEvent(new Event('input'));
      await flushAsync();

      const addBtn = (container.querySelector('#btn-add-payment-method') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('新增支付') || b.id === 'btn-add-payment-method')) as HTMLButtonElement;
      expect(addBtn, '必須具備新增支付方式按鈕').not.toBeNull();
      addBtn.click();
      await flushAsync();

      expect(container.textContent).toContain('台灣Pay錢包');
    });

    it('編輯支付方式：點擊編輯修改名稱，儲存後更新', async () => {
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在').toBeTruthy();

      if (db?.paymentMethods) {
        await db.paymentMethods.add({ name: '舊悠遊聯名卡', isDefault: false });
      }

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      const editBtn = (container.querySelector('.btn-edit-payment-method') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('編輯'))) as HTMLButtonElement;
      expect(editBtn, '支付方式項目應有編輯按鈕').toBeDefined();
      editBtn?.click();
      await flushAsync();

      const editInput = (container.querySelector('.input-edit-payment-method') ||
        container.querySelector('#input-payment-method-name') ||
        container.querySelector('input[type="text"]')) as HTMLInputElement;
      editInput.value = '新悠遊一卡通';
      editInput.dispatchEvent(new Event('input'));
      await flushAsync();

      const saveBtn = (container.querySelector('.btn-save-payment-method') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('儲存') || b.textContent?.includes('確認'))) as HTMLButtonElement;
      saveBtn?.click();
      await flushAsync();

      expect(container.textContent).toContain('新悠遊一卡通');
    });

    it('刪除支付方式：點擊刪除後自列表中移除', async () => {
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在').toBeTruthy();

      if (db?.paymentMethods) {
        await db.paymentMethods.add({ name: '欲刪除支付方式', isDefault: false });
      }

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      const deleteBtn = (container.querySelector('.btn-delete-payment-method') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('刪除'))) as HTMLButtonElement;
      deleteBtn?.click();
      await flushAsync();

      expect(container.textContent).not.toContain('欲刪除支付方式');
    });
  });

  // ==========================================
  // 4. 收入來源 CRUD 測試 (Income Source Management)
  // ==========================================
  describe('4. 收入來源 CRUD 測試', () => {
    it('新增收入來源：輸入名稱並新增，列表顯示新收入來源', async () => {
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在').toBeTruthy();

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      const input = (container.querySelector('#input-income-source-name') ||
        container.querySelector('input[placeholder*="收入來源"]')) as HTMLInputElement;
      expect(input, '必須具備收入來源輸入框').not.toBeNull();
      input.value = '自由業接案收入';
      input.dispatchEvent(new Event('input'));
      await flushAsync();

      const addBtn = (container.querySelector('#btn-add-income-source') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('新增收入來源') || b.id === 'btn-add-income-source')) as HTMLButtonElement;
      expect(addBtn, '必須具備新增收入來源按鈕').not.toBeNull();
      addBtn.click();
      await flushAsync();

      expect(container.textContent).toContain('自由業接案收入');
    });

    it('編輯收入來源：修改名稱儲存後更新', async () => {
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在').toBeTruthy();

      if (db?.incomeSources) {
        await db.incomeSources.add({ name: '舊薪資來源', isDefault: false });
      }

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      const editBtn = (container.querySelector('.btn-edit-income-source') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('編輯'))) as HTMLButtonElement;
      expect(editBtn, '收入來源項目應有編輯按鈕').toBeDefined();
      editBtn?.click();
      await flushAsync();

      const editInput = (container.querySelector('.input-edit-income-source') ||
        container.querySelector('#input-income-source-name') ||
        container.querySelector('input[type="text"]')) as HTMLInputElement;
      editInput.value = '新專案外包薪資';
      editInput.dispatchEvent(new Event('input'));
      await flushAsync();

      const saveBtn = (container.querySelector('.btn-save-income-source') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('儲存') || b.textContent?.includes('確認'))) as HTMLButtonElement;
      saveBtn?.click();
      await flushAsync();

      expect(container.textContent).toContain('新專案外包薪資');
    });

    it('刪除收入來源：點擊刪除後移除', async () => {
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在').toBeTruthy();

      if (db?.incomeSources) {
        await db.incomeSources.add({ name: '欲刪除收入來源', isDefault: false });
      }

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      const deleteBtn = (container.querySelector('.btn-delete-income-source') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('刪除'))) as HTMLButtonElement;
      deleteBtn?.click();
      await flushAsync();

      expect(container.textContent).not.toContain('欲刪除收入來源');
    });
  });

  // ==========================================
  // 5. 回饋來源 CRUD 測試 (Reward Source Management)
  // ==========================================
  describe('5. 回饋來源 CRUD 測試', () => {
    it('新增回饋來源：輸入名稱並新增，列表顯示新回饋來源', async () => {
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在').toBeTruthy();

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      const input = (container.querySelector('#input-reward-source-name') ||
        container.querySelector('input[placeholder*="回饋來源"]')) as HTMLInputElement;
      expect(input, '必須具備回饋來源輸入框').not.toBeNull();
      input.value = '街口幣回饋活動';
      input.dispatchEvent(new Event('input'));
      await flushAsync();

      const addBtn = (container.querySelector('#btn-add-reward-source') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('新增回饋來源') || b.id === 'btn-add-reward-source')) as HTMLButtonElement;
      expect(addBtn, '必須具備新增回饋來源按鈕').not.toBeNull();
      addBtn.click();
      await flushAsync();

      expect(container.textContent).toContain('街口幣回饋活動');
    });

    it('編輯回饋來源：修改名稱儲存後更新', async () => {
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在').toBeTruthy();

      if (db?.rewardSources) {
        await db.rewardSources.add({ name: '舊點數活動', isDefault: false });
      }

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      const editBtn = (container.querySelector('.btn-edit-reward-source') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('編輯'))) as HTMLButtonElement;
      expect(editBtn, '回饋來源項目應有編輯按鈕').toBeDefined();
      editBtn?.click();
      await flushAsync();

      const editInput = (container.querySelector('.input-edit-reward-source') ||
        container.querySelector('#input-reward-source-name') ||
        container.querySelector('input[type="text"]')) as HTMLInputElement;
      editInput.value = '新 LINE POINTS 點數折抵';
      editInput.dispatchEvent(new Event('input'));
      await flushAsync();

      const saveBtn = (container.querySelector('.btn-save-reward-source') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('儲存') || b.textContent?.includes('確認'))) as HTMLButtonElement;
      saveBtn?.click();
      await flushAsync();

      expect(container.textContent).toContain('新 LINE POINTS 點數折抵');
    });

    it('刪除回饋來源：點擊刪除後移除', async () => {
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在').toBeTruthy();

      if (db?.rewardSources) {
        await db.rewardSources.add({ name: '欲刪除回饋來源', isDefault: false });
      }

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      const deleteBtn = (container.querySelector('.btn-delete-reward-source') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('刪除'))) as HTMLButtonElement;
      deleteBtn?.click();
      await flushAsync();

      expect(container.textContent).not.toContain('欲刪除回饋來源');
    });
  });

  // ==========================================
  // 6. 清除所有資料（二次同意防呆機制）測試
  // ==========================================
  describe('6. 清除所有資料（二次同意防呆機制）測試', () => {
    async function seedTestData() {
      // 寫入支出、收入、回饋與分類記錄
      if (db.expenses) {
        await db.expenses.add({
          date: '2026-11-10',
          merchant: '測試超市',
          paymentMethod: '現金',
          totalAmount: 300,
          isForeign: false,
          items: [{ id: '1', type: 'item', name: '蘋果', quantity: 1, unitPrice: 300, subtotal: 300, category: '餐飲' }],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      if (db.incomes) {
        await db.incomes.add({
          date: '2026-11-05',
          source: '薪資帳戶',
          category: '薪資',
          amount: 50000,
          isForeign: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      if (db.rewards) {
        await db.rewards.add({
          yearMonth: '2026-11',
          sourceName: '信用卡回饋',
          amount: 500,
          createdAt: Date.now(),
        });
      }
    }

    it('點擊「清除所有資料」按鈕 (#btn-clear-all-data)，展開第一次確認提示；若點擊取消，資料不被清除', async () => {
      await seedTestData();
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在').toBeTruthy();

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      // 點擊觸發清除所有資料按鈕
      const clearBtn = container.querySelector('#btn-clear-all-data') as HTMLButtonElement;
      expect(clearBtn, '必須具備「清除所有資料」觸發按鈕 (#btn-clear-all-data)').not.toBeNull();
      clearBtn.click();
      await flushAsync();

      // 出現第一次確認提示與確認按鈕
      const confirmBtn1 = container.querySelector('#btn-confirm-clear-1');
      expect(confirmBtn1, '點擊後應出現第一次確認按鈕 (#btn-confirm-clear-1)').not.toBeNull();

      // 點擊取消按鈕
      const cancelBtn1 = (container.querySelector('#btn-cancel-clear-1') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('取消'))) as HTMLButtonElement;
      expect(cancelBtn1, '應具備第一次取消按鈕').not.toBeNull();
      cancelBtn1.click();
      await flushAsync();

      // 驗證第一次確認提示關閉，且資料庫資料保持原樣未被清除
      const expensesCount = await db.expenses.count();
      const incomesCount = await db.incomes.count();
      expect(expensesCount).toBeGreaterThan(0);
      expect(incomesCount).toBeGreaterThan(0);
    });

    it('點擊第一次確認按鈕 (#btn-confirm-clear-1)，出現第二次警示確認；若點擊取消，資料不被清除', async () => {
      await seedTestData();
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在').toBeTruthy();

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      // 點擊觸發清除所有資料
      const clearBtn = container.querySelector('#btn-clear-all-data') as HTMLButtonElement;
      clearBtn?.click();
      await flushAsync();

      // 點擊第一次確認
      const confirmBtn1 = container.querySelector('#btn-confirm-clear-1') as HTMLButtonElement;
      confirmBtn1?.click();
      await flushAsync();

      // 出現第二次確認按鈕
      const confirmBtn2 = container.querySelector('#btn-confirm-clear-2');
      expect(confirmBtn2, '點擊第一次確認後應出現第二次防呆警示確認按鈕 (#btn-confirm-clear-2)').not.toBeNull();

      // 點擊第二次取消按鈕
      const cancelBtn2 = (container.querySelector('#btn-cancel-clear-2') ||
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('取消'))) as HTMLButtonElement;
      expect(cancelBtn2, '應具備第二次取消按鈕').not.toBeNull();
      cancelBtn2.click();
      await flushAsync();

      // 驗證資料仍未被清除
      const expensesCount = await db.expenses.count();
      expect(expensesCount).toBeGreaterThan(0);
    });

    it('點擊第二次確認按鈕 (#btn-confirm-clear-2)，資料庫完全被清空（呼叫 clearAllDatabaseData），並顯示清除成功訊息', async () => {
      await seedTestData();
      const SettingsViewComp = await loadSettingsViewComponent();
      expect(SettingsViewComp, 'SettingsView.vue 元件必須存在').toBeTruthy();

      // 建立 clearAllDatabaseData 監聽 spy
      const clearSpy = vi.spyOn(dbModule, 'clearAllDatabaseData');

      const { container, cleanup } = mountComponent(SettingsViewComp);
      activeCleanups.push(cleanup);
      await flushAsync();

      // 1. 觸發清除所有資料
      const clearBtn = container.querySelector('#btn-clear-all-data') as HTMLButtonElement;
      clearBtn?.click();
      await flushAsync();

      // 2. 點擊第一次確認
      const confirmBtn1 = container.querySelector('#btn-confirm-clear-1') as HTMLButtonElement;
      confirmBtn1?.click();
      await flushAsync();

      // 3. 點擊第二次確認
      const confirmBtn2 = container.querySelector('#btn-confirm-clear-2') as HTMLButtonElement;
      confirmBtn2?.click();
      await flushAsync(100);

      // 驗證 clearAllDatabaseData 明確被呼叫
      expect(clearSpy).toHaveBeenCalled();

      // 驗證資料庫所有主要表格皆已被清空
      const expensesCount = await db.expenses.count();
      const incomesCount = await db.incomes.count();
      const rewardsCount = await db.rewards.count();
      expect(expensesCount, '支出資料表應清空').toBe(0);
      expect(incomesCount, '收入資料表應清空').toBe(0);
      expect(rewardsCount, '回饋資料表應清空').toBe(0);

      // 驗證介面顯示清除成功訊息 (#clear-success-message 存在且包含「成功」文字)
      const successMsg = container.querySelector('#clear-success-message');
      expect(successMsg, '介面必須具備清除成功訊息元素 (#clear-success-message)').not.toBeNull();
      expect(successMsg?.textContent).toContain('成功');
    });
  });

  // ==========================================
  // 7. 表單與設定連動測試 (IncomeForm & RewardForm)
  // ==========================================
  describe('7. 表單與設定連動測試', () => {
    describe('IncomeForm.vue 收入來源連動', () => {
      it('驗證收入來源下拉選單選項來自 incomeSources 設定表', async () => {
        await db.incomeSources.bulkAdd([
          { name: '薪資收入', isDefault: true },
          { name: '專案接案', isDefault: false },
        ]);

        const { container, cleanup } = mountComponent(IncomeForm);
        activeCleanups.push(cleanup);
        await flushAsync(60);

        const select = container.querySelector('#income-source-select') as HTMLSelectElement;
        expect(select, 'IncomeForm 必須包含 #income-source-select 下拉選單').not.toBeNull();

        const options = Array.from(select.options).map((opt) => opt.value);
        expect(options).toContain('薪資收入');
        expect(options).toContain('專案接案');
      });

      it('資料庫歷史記錄 incomes 中若有「舊外包」，但 incomeSources 設定表中沒有，選單中不應包含「舊外包」', async () => {
        // 設定表僅包含「薪資」
        await db.incomeSources.bulkAdd([
          { name: '薪資', isDefault: true },
        ]);

        // 歷史表記錄包含「舊外包」
        await db.incomes.add({
          date: '2026-10-01',
          source: '舊外包',
          category: '薪資',
          amount: 20000,
          isForeign: false,
        });

        const { container, cleanup } = mountComponent(IncomeForm);
        activeCleanups.push(cleanup);
        await flushAsync(60);

        const select = container.querySelector('#income-source-select') as HTMLSelectElement;
        expect(select, 'IncomeForm 必須包含 #income-source-select 下拉選單').not.toBeNull();

        const options = Array.from(select.options).map((opt) => opt.value);
        expect(options).toContain('薪資');
        expect(options).not.toContain('舊外包');
      });

      it('驗證當選取「+ 新增收入來源...」並送出儲存時，會自動呼叫 addIncomeSource 將新來源持久化至設定表', async () => {
        const addIncomeSourceSpy = vi.spyOn(dbModule, 'addIncomeSource');

        const { container, cleanup } = mountComponent(IncomeForm);
        activeCleanups.push(cleanup);
        await flushAsync(60);

        const select = container.querySelector('#income-source-select') as HTMLSelectElement;
        expect(select, 'IncomeForm 必須包含 #income-source-select 下拉選單').not.toBeNull();

        // 選取「+ 新增收入來源...」
        select.value = '__add_new__';
        select.dispatchEvent(new Event('change'));
        await flushAsync();

        // 填入自訂收入來源名稱
        const customInput = container.querySelector('#custom-income-source-input') as HTMLInputElement;
        expect(customInput, '選取新增來源時應出現自訂輸入框 (#custom-income-source-input)').not.toBeNull();
        customInput.value = '獎金紅包';
        customInput.dispatchEvent(new Event('input'));
        await flushAsync();

        // 填入金額
        const amountInput = container.querySelector('#income-amount') as HTMLInputElement;
        if (amountInput) {
          amountInput.value = '8800';
          amountInput.dispatchEvent(new Event('input'));
        }
        await flushAsync();

        // 點擊送出按鈕
        const submitBtn = (container.querySelector('#btn-submit-income') ||
          container.querySelector('button[type="submit"]')) as HTMLButtonElement;
        expect(submitBtn, '必須具備儲存收入按鈕 (#btn-submit-income)').not.toBeNull();
        submitBtn.click();
        await flushAsync(100);

        // 驗證自動呼叫 addIncomeSource 將新來源持久化至設定表
        expect(addIncomeSourceSpy).toHaveBeenCalledWith('獎金紅包');
      });

      it('當使用者在 IncomeForm.vue 選取「+ 新增收入來源...」但未填寫自訂名稱直接送出儲存時，送出之收入記錄 source 安全 fallback 為「未分類收入」，且嚴格禁止呼叫 addIncomeSource 將「未分類收入」寫入 incomeSources 設定表', async () => {
        const addIncomeSourceSpy = vi.spyOn(dbModule, 'addIncomeSource');
        const addIncomeSpy = vi.spyOn(dbModule, 'addIncome');

        const { container, cleanup } = mountComponent(IncomeForm);
        activeCleanups.push(cleanup);
        await flushAsync(60);

        const select = container.querySelector('#income-source-select') as HTMLSelectElement;
        expect(select, 'IncomeForm 必須包含 #income-source-select 下拉選單').not.toBeNull();

        // 選取「+ 新增收入來源...」
        select.value = '__add_new__';
        select.dispatchEvent(new Event('change'));
        await flushAsync();

        // 確認展開自訂輸入框，但不填寫自訂名稱
        const customInput = container.querySelector('#custom-income-source-input') as HTMLInputElement;
        expect(customInput, '選取新增來源時應出現自訂輸入框 (#custom-income-source-input)').not.toBeNull();
        customInput.value = '';
        customInput.dispatchEvent(new Event('input'));
        await flushAsync();

        // 填入金額以通過必填校驗
        const amountInput = container.querySelector('#income-amount') as HTMLInputElement;
        if (amountInput) {
          amountInput.value = '6600';
          amountInput.dispatchEvent(new Event('input'));
        }
        await flushAsync();

        // 點擊送出按鈕
        const submitBtn = (container.querySelector('#btn-submit-income') ||
          container.querySelector('button[type="submit"]')) as HTMLButtonElement;
        expect(submitBtn, '必須具備儲存收入按鈕 (#btn-submit-income)').not.toBeNull();
        submitBtn.click();
        await flushAsync(100);

        // 驗證送出之收入記錄 source 安全 fallback 為「未分類收入」
        expect(addIncomeSpy).toHaveBeenCalled();
        const savedIncome = addIncomeSpy.mock.calls[0][0];
        expect(savedIncome.source, '未填自訂收入名稱時，source 必須 fallback 為「未分類收入」').toBe('未分類收入');

        // 驗證嚴格禁止呼叫 addIncomeSource 將「未分類收入」寫入 incomeSources 設定表
        expect(
          addIncomeSourceSpy,
          '嚴格禁止呼叫 addIncomeSource 將「未分類收入」寫入 incomeSources 設定表'
        ).not.toHaveBeenCalledWith('未分類收入');
      });
    });

    describe('RewardForm.vue 回饋來源連動', () => {
      it('驗證回饋來源下拉選單選項來自 rewardSources 設定表', async () => {
        await db.rewardSources.bulkAdd([
          { name: '街口幣', isDefault: false },
          { name: '悠遊付回饋金', isDefault: false },
        ]);

        const { container, cleanup } = mountComponent(RewardForm);
        activeCleanups.push(cleanup);
        await flushAsync(60);

        const select = container.querySelector('#reward-source-select') as HTMLSelectElement;
        expect(select, 'RewardForm 必須包含 #reward-source-select 下拉選單').not.toBeNull();

        const options = Array.from(select.options).map((opt) => opt.value);
        expect(options).toContain('街口幣');
        expect(options).toContain('悠遊付回饋金');
      });

      it('資料庫歷史記錄 rewards 中若有「舊點數」，但 rewardSources 設定表中沒有，選單中不應包含「舊點數」', async () => {
        // 設定表僅包含「現金回饋」
        await db.rewardSources.bulkAdd([
          { name: '現金回饋', isDefault: false },
        ]);

        // 歷史表記錄包含「舊點數」
        await db.rewards.add({
          yearMonth: '2026-10',
          sourceName: '舊點數',
          amount: 100,
        });

        const { container, cleanup } = mountComponent(RewardForm);
        activeCleanups.push(cleanup);
        await flushAsync(60);

        const select = container.querySelector('#reward-source-select') as HTMLSelectElement;
        expect(select, 'RewardForm 必須包含 #reward-source-select 下拉選單').not.toBeNull();

        const options = Array.from(select.options).map((opt) => opt.value);
        expect(options).toContain('現金回饋');
        expect(options).not.toContain('舊點數');
      });

      it('驗證當選取「+ 新增回饋來源...」並送出儲存時，會自動呼叫 addRewardSource 將新來源持久化至設定表', async () => {
        const addRewardSourceSpy = vi.spyOn(dbModule, 'addRewardSource');

        const { container, cleanup } = mountComponent(RewardForm);
        activeCleanups.push(cleanup);
        await flushAsync(60);

        const select = container.querySelector('#reward-source-select') as HTMLSelectElement;
        expect(select, 'RewardForm 必須包含 #reward-source-select 下拉選單').not.toBeNull();

        // 選取「+ 新增回饋來源...」
        select.value = '__add_new__';
        select.dispatchEvent(new Event('change'));
        await flushAsync();

        // 填入自訂回饋來源名稱
        const customInput = container.querySelector('#custom-reward-source-input') as HTMLInputElement;
        expect(customInput, '選取新增來源時應出現自訂輸入框 (#custom-reward-source-input)').not.toBeNull();
        customInput.value = 'P幣回饋';
        customInput.dispatchEvent(new Event('input'));
        await flushAsync();

        // 填入金額
        const amountInput = container.querySelector('#reward-amount') as HTMLInputElement;
        if (amountInput) {
          amountInput.value = '120';
          amountInput.dispatchEvent(new Event('input'));
        }
        await flushAsync();

        // 點擊送出按鈕
        const submitBtn = (container.querySelector('#btn-submit-reward') ||
          container.querySelector('button[type="submit"]')) as HTMLButtonElement;
        expect(submitBtn, '必須具備儲存回饋按鈕 (#btn-submit-reward)').not.toBeNull();
        submitBtn.click();
        await flushAsync(100);

        // 驗證自動呼叫 addRewardSource 將新來源持久化至設定表
        expect(addRewardSourceSpy).toHaveBeenCalledWith('P幣回饋');
      });
    });
  });
});
