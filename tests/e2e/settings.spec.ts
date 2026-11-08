import { test, expect, type Page } from '@playwright/test';

/**
 * Sand Dollar 設定頁面端對端 (E2E) 測試
 *
 * 核心測試情境涵蓋：
 * 1. 底部導航切換：開啟首頁，點選底部導航「設定」進入設定頁。
 * 2. 備份與還原功能元素：驗證保留備份按鈕 (#btn-export-backup) 與一鍵還原按鈕 (#btn-restore-backup) 存在。
 * 3. 自訂項目管理 (CRUD)：
 *    - 支出/收入分類：新增自訂分類、修改自訂分類、刪除自訂分類。
 *    - 自訂支付方式：新增自訂支付方式。
 *    - 常用收入來源：新增常用收入來源。
 *    - 回饋來源：新增回饋來源。
 * 4. 危險操作區域：「清除所有資料」二次同意防呆流程：
 *    - 點擊「清除所有資料」按鈕 (#btn-clear-all-data)。
 *    - 出現第一次確認，點擊確認 (#btn-confirm-clear-1)。
 *    - 出現第二次極度危險確認，點擊確認 (#btn-confirm-clear-2)。
 *    - 驗證清除成功提示，且原本新增的自訂項目均已被清空。
 */
test.describe.configure({ mode: 'serial' });

test.describe('Sand Dollar 設定頁面功能 (Settings E2E)', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // 建立共用 BrowserContext 與單一 Page，維持同一 IndexedDB 會話
    const context = await browser.newContext();
    page = await context.newPage();
    await page.goto('/');
  });

  test.afterAll(async () => {
    if (page) {
      await page.close();
    }
  });

  test('1. 開啟首頁並透過底部導航進入設定頁面', async () => {
    // 點選底部導覽列「設定」分頁
    const navSettings = page.getByRole('navigation').getByRole('tab', { name: /設定/i });
    await expect(navSettings).toBeVisible();
    await navSettings.click();

    // 驗證進入設定主容器與頁面標題
    const settingsView = page.locator('#settings-view');
    await expect(settingsView).toBeVisible();
    await expect(page.getByRole('heading', { name: '設定與資料維護' })).toBeVisible();
  });

  test('2. 驗證資料備份與還原按鈕存在', async () => {
    // 驗證保留備份按鈕存在且顯示正確文字
    const exportBtn = page.locator('#btn-export-backup');
    await expect(exportBtn).toBeVisible();
    await expect(exportBtn).toContainText('匯出備份 (JSON)');

    // 驗證一鍵還原按鈕存在且顯示正確文字
    const restoreBtn = page.locator('#btn-restore-backup');
    await expect(restoreBtn).toBeVisible();
    await expect(restoreBtn).toContainText('一鍵還原 (JSON)');
  });

  test('3. 驗證自訂項目管理 (分類、支付方式、收入來源、回饋來源)', async () => {
    // --- 3.1 分類管理：新增、修改、刪除自訂分類 ---
    const categoryInput = page.locator('#input-category-name');
    const addCategoryBtn = page.locator('#btn-add-category');
    const categoryList = page.locator('#category-list');

    // 新增自訂分類
    await categoryInput.fill('測試運動器材');
    await addCategoryBtn.click();
    await expect(categoryList).toContainText('測試運動器材');

    // 編輯剛新增的自訂分類
    const categoryItem = categoryList.locator('div', { hasText: '測試運動器材' }).first();
    const editCategoryBtn = categoryItem.locator('.btn-edit-category');
    await editCategoryBtn.click();

    const editCategoryInput = categoryList.locator('.input-edit-category');
    await expect(editCategoryInput).toBeVisible();
    await editCategoryInput.fill('測試健身用品');

    const saveCategoryBtn = categoryList.locator('.btn-save-category');
    await saveCategoryBtn.click();

    // 驗證名稱修改成功
    await expect(categoryList).toContainText('測試健身用品');
    await expect(categoryList).not.toContainText('測試運動器材');

    // 刪除該自訂分類
    const updatedCategoryItem = categoryList.locator('div', { hasText: '測試健身用品' }).first();
    const deleteCategoryBtn = updatedCategoryItem.locator('.btn-delete-category');
    await deleteCategoryBtn.click();

    // 驗證刪除成功
    await expect(categoryList).not.toContainText('測試健身用品');

    // 再新增一個自訂分類，供後續清空流程驗證
    await categoryInput.fill('即將被清空的自訂分類');
    await addCategoryBtn.click();
    await expect(categoryList).toContainText('即將被清空的自訂分類');

    // --- 3.2 支付方式管理：新增支付方式 ---
    const paymentInput = page.locator('#input-payment-method-name');
    const addPaymentBtn = page.locator('#btn-add-payment-method');

    await paymentInput.fill('測試行動支付');
    await addPaymentBtn.click();
    await expect(page.getByText('測試行動支付')).toBeVisible();

    // --- 3.3 常用收入來源管理：新增收入來源 ---
    const incomeSourceInput = page.locator('#input-income-source-name');
    const addIncomeSourceBtn = page.locator('#btn-add-income-source');

    await incomeSourceInput.fill('測試副業專案');
    await addIncomeSourceBtn.click();
    await expect(page.getByText('測試副業專案')).toBeVisible();

    // --- 3.4 回饋來源管理：新增回饋來源 ---
    const rewardSourceInput = page.locator('#input-reward-source-name');
    const addRewardSourceBtn = page.locator('#btn-add-reward-source');

    await rewardSourceInput.fill('測試點數回饋');
    await addRewardSourceBtn.click();
    await expect(page.getByText('測試點數回饋')).toBeVisible();
  });

  test('4. 驗證清除所有資料之二次同意防呆流程與清空效果', async () => {
    // 點擊「清除所有資料」啟動按鈕
    const startClearBtn = page.locator('#btn-clear-all-data');
    await expect(startClearBtn).toBeVisible();
    await startClearBtn.click();

    // 第一次防呆確認：驗證出現第一次警示對話框與按鈕
    const confirmClearBtn1 = page.locator('#btn-confirm-clear-1');
    const cancelClearBtn1 = page.locator('#btn-cancel-clear-1');
    await expect(confirmClearBtn1).toBeVisible();
    await expect(cancelClearBtn1).toBeVisible();
    await expect(page.getByText('第一次確認：您確定要清除所有資料嗎？')).toBeVisible();

    // 點擊第一次確認按鈕，進入第二次確認階段
    await confirmClearBtn1.click();

    // 第二次防呆確認：驗證出現極度危險警告與第二次確認按鈕
    const confirmClearBtn2 = page.locator('#btn-confirm-clear-2');
    const cancelClearBtn2 = page.locator('#btn-cancel-clear-2');
    await expect(confirmClearBtn2).toBeVisible();
    await expect(cancelClearBtn2).toBeVisible();
    await expect(page.getByText('極度危險警告：此操作完全無法復原！')).toBeVisible();

    // 點擊第二次確認按鈕，真正執行資料清空
    await confirmClearBtn2.click();

    // 驗證出現清除成功提示訊息
    const successMsg = page.locator('#clear-success-message');
    await expect(successMsg).toBeVisible();
    await expect(successMsg).toContainText('資料清除成功！');

    // 驗證原本新增的各項自訂資料已被完全清除
    const categoryList = page.locator('#category-list');
    await expect(categoryList).not.toContainText('即將被清空的自訂分類');
    await expect(page.getByText('測試行動支付')).not.toBeVisible();
    await expect(page.getByText('測試副業專案')).not.toBeVisible();
    await expect(page.getByText('測試點數回饋')).not.toBeVisible();
  });
});
