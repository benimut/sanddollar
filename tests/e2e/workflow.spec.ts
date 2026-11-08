import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { test, expect, type Page } from '@playwright/test';

/**
 * Sand Dollar 端對端核心業務流程測試
 * 涵蓋切片 5（記帳介面與店家推薦）、切片 6（收入模組）、切片 8（報表與備份）
 *
 * 採用連貫 Session (test.describe.serial 搭配共用 Page/Context)，
 * 確保由支出、收入記帳產生的 IndexedDB 本地儲存資料在後續報表檢視與備份匯出中無縫延續。
 */
test.describe.configure({ mode: 'serial' });

test.describe('Sand Dollar 端對端核心業務流程 (E2E Workflow)', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // 建立共用 BrowserContext 與單一 Page，維持連貫 IndexedDB 會話
    const context = await browser.newContext();
    page = await context.newPage();
    await page.goto('/');
  });

  test.afterAll(async () => {
    if (page) {
      await page.close();
    }
  });

  test('1. 支出記帳流程：包含店家、商品、折扣項目、總額計算與歷史推薦連動', async () => {
    // 確保在記帳頁面與支出分頁
    const navTransaction = page.getByRole('navigation').getByRole('tab', { name: /記帳/i });
    if (await navTransaction.isVisible()) {
      await navTransaction.click();
    }

    const expenseTab = page.locator('#tab-expense');
    if (await expenseTab.isVisible()) {
      await expenseTab.click();
    }

    // 填寫店家：全家便利商店
    const merchantInput = page.locator('#merchant-input');
    await merchantInput.fill('全家便利商店');

    // 填寫商品品項：美式咖啡，數量 2，單價 35，分類 餐飲
    const itemNameInput = page.locator('#expense-name');
    await itemNameInput.fill('美式咖啡');

    const itemQtyInput = page.locator('#item-qty-0');
    await itemQtyInput.fill('2');

    const itemPriceInput = page.locator('#expense-amount');
    await itemPriceInput.fill('35');

    const itemCategorySelect = page.locator('#expense-category');
    if (await itemCategorySelect.isVisible()) {
      const options = await itemCategorySelect.locator('option').allTextContents();
      if (!options.includes('餐飲')) {
        await itemCategorySelect.selectOption('__add_new__');
        const customCatInput = page.locator('#custom-expense-category-input');
        await expect(customCatInput).toBeVisible();
        await customCatInput.fill('餐飲');
        await page.locator('#btn-confirm-expense-category').click();
      } else {
        await itemCategorySelect.selectOption('餐飲');
      }
    }

    // 點擊「新增折扣」按鈕
    const addDiscountButton = page.getByRole('button', { name: /新增折扣|折抵/i });
    await addDiscountButton.click();

    // 填入折扣品名：自備飲料杯折抵，折抵金額 5
    const discountNameInput = page.locator('#disc-name-0');
    await discountNameInput.fill('自備飲料杯折抵');

    const discountAmountInput = page.locator('#disc-amount-0');
    await discountAmountInput.fill('5');

    // 驗證總額應為 2 * 35 - 5 = 65 元
    const totalAmountDisplay = page.getByText(/總額|總計|合計/i);
    await expect(totalAmountDisplay).toBeVisible();
    await expect(page.getByText('65')).toBeVisible();

    // 儲存支出
    const saveExpenseButton = page.locator('#btn-submit-expense');
    await saveExpenseButton.click();

    // 儲存後自動跳轉至明細分頁，驗證明細列表中出現該筆消費
    await expect(page.getByText('全家便利商店').first()).toBeVisible();
    await expect(page.getByText('美式咖啡').first()).toBeVisible();

    // 切換回「記帳」分頁進行第二次記帳驗證
    await page.getByRole('navigation').getByRole('tab', { name: /記帳/i }).click();

    // 進行第二次記帳驗證：輸入店家名稱後，透過商品明細旁的 [選擇] 按鈕開啟全螢幕選擇彈窗
    await merchantInput.fill('全家便利商店');

    // 點擊商品明細旁的 [選擇] 按鈕
    const selectItemButton = page.locator('.btn-select-item').first();
    await selectItemButton.click();

    // 在全螢幕選擇彈窗 (SelectModal) 中點選「美式咖啡」
    const itemOption = page.getByRole('dialog').getByRole('button', { name: /美式咖啡/ });
    await expect(itemOption).toBeVisible();
    await itemOption.click();

    // 自動帶入品名「美式咖啡」、單價 35、分類「餐飲」
    await expect(itemNameInput).toHaveValue('美式咖啡');
    await expect(itemPriceInput).toHaveValue('35');
  });

  test('2. 海外支出與換算：支援手續費預設 1.5% 與實質匯率反推', async () => {
    // 確保在記帳頁面與支出分頁
    const navTransaction = page.getByRole('navigation').getByRole('tab', { name: /記帳/i });
    if (await navTransaction.isVisible()) {
      await navTransaction.click();
    }

    const expenseTab = page.locator('#tab-expense');
    if (await expenseTab.isVisible()) {
      await expenseTab.click();
    }

    // 開啟海外消費切換開關（頂部海外按鈕）
    const foreignSwitch = page.getByRole('button', { name: '海外' });
    await foreignSwitch.click();

    // 店家
    const merchantInput = page.locator('#merchant-input');
    await merchantInput.fill('Amazon JP');

    // 輸入外幣金額 USD 100
    const foreignAmountInput = page.locator('#foreign-expense-amount');
    await foreignAmountInput.fill('100');

    // 輸入台幣扣款 3200
    const twdAmountInput = page.locator('#net-twd-amount');
    await twdAmountInput.fill('3200');

    // 輸入手續費金額 48
    const feeAmountInput = page.locator('#expense-fee-amount');
    await feeAmountInput.fill('48');

    // 驗證換算手續費率 1.50%（48 / 3200 = 1.5%）
    await expect(page.getByText('1.50%')).toBeVisible();

    // 驗證總金額為 3248 元 (3200 + 48)
    await expect(page.getByText('3248')).toBeVisible();

    // 驗證實質匯率為 32.48 (3248 / 100)
    await expect(page.getByText(/32\.48/)).toBeVisible();

    // 儲存記錄
    const saveExpenseButton = page.locator('#btn-submit-expense');
    await saveExpenseButton.click();

    // 儲存後自動跳轉至明細分頁，驗證明細列表中出現 Amazon JP
    await expect(page.getByText('Amazon JP').first()).toBeVisible();
  });

  test('3. 收入記帳流程：記錄本幣薪資與外幣接案收入（手續費 0、實質匯率反推）', async () => {
    // 確保切換至記帳頁籤
    const navTransaction = page.getByRole('navigation').getByRole('tab', { name: /記帳/i });
    if (await navTransaction.isVisible()) {
      await navTransaction.click();
    }

    // 切換至「收入 (Income)」分頁
    const incomeTab = page.locator('#tab-income');
    await incomeTab.click();

    // 依據規格 v2.0：收入來源使用純選單 #income-source-select 與動態自訂輸入框
    async function selectOrAddIncomeSource(sourceName: string) {
      const sourceSelect = page.locator('#income-source-select');
      await expect(sourceSelect).toBeVisible();
      const options = await sourceSelect.locator('option').allTextContents();
      if (options.some((opt) => opt.includes(sourceName))) {
        await sourceSelect.selectOption({ label: sourceName });
      } else {
        await sourceSelect.selectOption('__add_new__');
        const customInput = page.locator('#custom-income-source-input');
        await expect(customInput).toBeVisible();
        await customInput.fill(sourceName);
        const confirmBtn = page.locator('#btn-confirm-income-source');
        if (await confirmBtn.isVisible()) {
          await confirmBtn.click();
        }
      }
    }

    // 第一筆：台幣正職薪資
    // 填寫來源：11月薪水
    await selectOrAddIncomeSource('11月薪水');

    // 選擇分類：薪資
    const categorySelect = page.locator('#income-category');
    if (await categorySelect.isVisible()) {
      const options = await categorySelect.locator('option').allTextContents();
      if (!options.includes('薪資')) {
        await categorySelect.selectOption('__add_new__');
        const customCatInput = page.locator('#custom-income-category-input');
        await expect(customCatInput).toBeVisible();
        await customCatInput.fill('薪資');
        await page.locator('#btn-confirm-income-category').click();
      } else {
        await categorySelect.selectOption('薪資');
      }
    }

    // 填寫金額：50000
    const amountInput = page.locator('#income-amount');
    await amountInput.fill('50000');

    // 點擊儲存收入
    const saveIncomeButton = page.locator('#btn-submit-income');
    await saveIncomeButton.click();

    // 儲存後自動跳轉至明細分頁，驗證明細列表中出現 11月薪水
    await expect(page.getByText('11月薪水').first()).toBeVisible();

    // 切換回「記帳」分頁並選取「收入」子分頁進行第二筆記帳
    await page.getByRole('navigation').getByRole('tab', { name: /記帳/i }).click();
    await page.locator('#tab-income').click();

    // 第二筆：外幣海外接案收入
    await selectOrAddIncomeSource('海外接案');

    if (await categorySelect.isVisible()) {
      const options = await categorySelect.locator('option').allTextContents();
      if (!options.includes('兼職')) {
        await categorySelect.selectOption('__add_new__');
        const customCatInput = page.locator('#custom-income-category-input');
        await expect(customCatInput).toBeVisible();
        await customCatInput.fill('兼職');
        await page.locator('#btn-confirm-income-category').click();
      } else {
        await categorySelect.selectOption('兼職');
      }
    }

    // 開啟外幣收入開關（頂部海外按鈕）
    const foreignIncomeSwitch = page.getByRole('button', { name: '海外' });
    await foreignIncomeSwitch.click();

    // 輸入外幣金額 USD 1000
    const foreignAmountInput = page.locator('#foreign-income-amount');
    await foreignAmountInput.fill('1000');

    // 輸入台幣到帳金額 32000
    await amountInput.fill('32000');

    // 驗證預設手續費為 0 元
    await expect(page.getByText(/折合台幣手續費：|手續費：/)).toBeVisible();
    await expect(page.getByText(/NT\$\s*0/)).toBeVisible();

    // 驗證實質匯率為 32.00 (32000 / 1000)
    await expect(page.getByText(/32(\.00)?/)).toBeVisible();

    // 儲存收入
    await saveIncomeButton.click();
    // 儲存後自動跳轉至明細分頁，驗證明細列表中出現 海外接案
    await expect(page.getByText('海外接案').first()).toBeVisible();
  });

  test('4. 報表檢視：驗證財務核心摘要（總進帳 82000、總支出、結餘）、圓餅圖切換與 0 軸堆疊長條圖', async () => {
    // 切換至底部導航「報表 (Report)」頁籤
    const reportTab = page.getByRole('navigation').getByRole('tab', { name: /報表/i });
    await reportTab.click();

    // 驗證財務摘要面板：
    // 總進帳 = 50000 + 32000 = 82000
    await expect(page.getByText(/總進帳/i)).toBeVisible();
    await expect(page.getByText(/82,?000/)).toBeVisible();

    // 總支出 > 0 (65 + 3248 = 3313)
    await expect(page.getByText(/總支出/i)).toBeVisible();
    await expect(page.getByText(/3,?313/)).toBeVisible();

    // 當月結餘為正數 (82000 - 3313 = 78687)
    await expect(page.getByText(/當[期月]結餘|結餘/i)).toBeVisible();
    await expect(page.getByText(/78,?687/)).toBeVisible();

    // 驗證圓餅圖可切換「支出分類」與「收入分類」
    const expensePieBtn = page.getByRole('button', { name: '支出分類' });
    const incomePieBtn = page.getByRole('button', { name: '收入分類' });

    await expect(expensePieBtn).toBeVisible();
    await expect(incomePieBtn).toBeVisible();

    // 點擊收入分類
    await incomePieBtn.click();
    // 圓餅圖容器可見
    const pieCanvas = page.locator('canvas').first();
    await expect(pieCanvas).toBeVisible();

    // 切回支出分類
    await expensePieBtn.click();
    await expect(pieCanvas).toBeVisible();

    // 驗證 0 軸堆疊長條圖正常渲染
    const barCanvas = page.locator('canvas').nth(1);
    await expect(barCanvas).toBeVisible();
  });

  test('5. 備份與還原：驗證 JSON 備份完整匯出包含收入資料並成功一鍵還原', async () => {
    // 1. 切換至底部導航「備份 (Backup)」分頁
    const backupTab = page.getByRole('navigation').getByRole('tab', { name: /備份/i });
    await backupTab.click();

    // 2. 監聽下載事件並點擊「匯出備份 (JSON)」
    const exportButton = page.getByRole('button', { name: /匯出備份\s*\(JSON\)/i });
    await expect(exportButton).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      exportButton.click(),
    ]);

    // 驗證下載檔案名稱結尾為 .json
    expect(download.suggestedFilename()).toMatch(/\.json$/i);

    // 3. 儲存備份至本機暫存路徑以供還原測試
    const tempBackupPath = path.join(os.tmpdir(), `test-backup-${Date.now()}.json`);
    await download.saveAs(tempBackupPath);

    try {
      // 4. 讀取並檢視備份資料結構完整性
      const fileContent = fs.readFileSync(tempBackupPath, 'utf-8');
      const backupData = JSON.parse(fileContent);

      expect(backupData).toHaveProperty('version');
      expect(backupData).toHaveProperty('exportedAt');
      expect(backupData).toHaveProperty('data');
      expect(backupData).not.toHaveProperty('expenses');
      expect(backupData).not.toHaveProperty('incomes');
      expect(backupData).not.toHaveProperty('rewards');
      expect(backupData).not.toHaveProperty('categories');

      expect(backupData.data).toHaveProperty('expenses');
      expect(backupData.data).toHaveProperty('incomes');
      expect(backupData.data).toHaveProperty('rewards');
      expect(backupData.data).toHaveProperty('categories');
      expect(Array.isArray(backupData.data.expenses)).toBe(true);
      expect(Array.isArray(backupData.data.incomes)).toBe(true);
      expect(Array.isArray(backupData.data.rewards)).toBe(true);
      expect(Array.isArray(backupData.data.categories)).toBe(true);
      expect(backupData.data.expenses.length).toBeGreaterThanOrEqual(2);
      expect(backupData.data.incomes.length).toBeGreaterThanOrEqual(2);

      // 5. 執行一鍵還原：將檔案上傳至檔案選擇器
      const fileInput = page.locator('#backup-file-input');
      await fileInput.setInputFiles(tempBackupPath);

      // 6. 驗證還原成功提示橫幅
      const successBanner = page.getByText(/還原成功！已匯入/i);
      await expect(successBanner).toBeVisible({ timeout: 5000 });
      await expect(page.getByText(/支出\s*2\s*筆/i)).toBeVisible();
      await expect(page.getByText(/收入\s*2\s*筆/i)).toBeVisible();

      // 7. 重新載入頁面，驗證 IndexedDB 資料持久性與完整性
      await page.reload();

      // 8. 切換至「報表」頁籤，驗證還原後數據依然完整
      const reportTab = page.getByRole('navigation').getByRole('tab', { name: /報表/i });
      await reportTab.click();

      await expect(page.getByText(/總進帳/i)).toBeVisible();
      await expect(page.getByText(/82,?000/)).toBeVisible();
      await expect(page.getByText(/總支出/i)).toBeVisible();
      await expect(page.getByText(/3,?313/)).toBeVisible();
      await expect(page.getByText(/當[期月]結餘|結餘/i)).toBeVisible();
      await expect(page.getByText(/78,?687/)).toBeVisible();

      // 9. 切換至「記帳」頁籤，驗證店家歷史商品資料完整存在，可透過挑選彈窗選取
      const navTransaction = page.getByRole('navigation').getByRole('tab', { name: /記帳/i });
      if (await navTransaction.isVisible()) {
        await navTransaction.click();
      }
      const merchantInput = page.locator('#merchant-input');
      await merchantInput.fill('全家便利商店');
      const selectItemButton = page.locator('.btn-select-item').first();
      await selectItemButton.click();
      const itemOption = page.getByRole('dialog').getByRole('button', { name: /美式咖啡/ });
      await expect(itemOption).toBeVisible();
    } finally {
      // 10. 清理暫存檔案
      if (fs.existsSync(tempBackupPath)) {
        fs.unlinkSync(tempBackupPath);
      }
    }
  });
});
