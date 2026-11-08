import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick, type ComponentPublicInstance } from 'vue';
import InvoiceScannerModal from '@/components/InvoiceScannerModal.vue';
import * as dbModule from '@/db';
import type { ParsedInvoiceResult } from '@/utils/invoiceParser';

/**
 * Milestone 2 (M2): 電子發票掃描彈窗 (InvoiceScannerModal) 動態分類單元測試套件
 * 
 * 測試範疇：
 * 1. 驗證分類選項動態載入自 DEFAULT_CATEGORIES / getCategories('expense')，不再硬編碼。
 * 2. 驗證掛載時調用 getCategories('expense')，並動態合併自訂分類。
 * 3. 驗證掃描解析後，自訂支出分類出現在品項分類下拉選單中。
 * 4. 驗證使用者選取自訂支出分類後，emit 之 parsed 結果中品項 category 包含使用者選取之自訂分類。
 */

// Mock html5-qrcode
vi.mock('html5-qrcode', () => {
  class MockHtml5Qrcode {
    elementId: string;
    isScanning = false;
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    clear = vi.fn().mockResolvedValue(undefined);

    constructor(elementId: string) {
      this.elementId = elementId;
    }
  }

  return {
    Html5Qrcode: MockHtml5Qrcode,
    Html5QrcodeSupportedFormats: {
      QR_CODE: 0,
    },
  };
});

// Mock @/db
vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>();
  return {
    ...actual,
    getCategories: vi.fn().mockImplementation((type?: 'expense' | 'income') => {
      const defaultCats = [
        { id: 1, name: '餐飲', type: 'expense', isDefault: true },
        { id: 2, name: '交通', type: 'expense', isDefault: true },
        { id: 3, name: '生活', type: 'expense', isDefault: true },
        { id: 4, name: '娛樂', type: 'expense', isDefault: true },
        { id: 5, name: '醫療', type: 'expense', isDefault: true },
        { id: 6, name: '其他', type: 'expense', isDefault: true },
        { id: 99, name: '毛孩醫療', type: 'expense', isDefault: false },
        { id: 100, name: '攝影器材', type: 'expense', isDefault: false },
      ];
      if (!type) return Promise.resolve(defaultCats);
      return Promise.resolve(defaultCats.filter((c) => c.type === type));
    }),
  };
});

describe('Milestone 2 (M2): InvoiceScannerModal 分類動態載入驗證套件', () => {
  const BASE_LEFT_77 =
    'AB1234567811305208888000000C8000000C80000000012345678012345678901234567890123';

  interface MountHelperResult {
    app: ReturnType<typeof createApp>;
    vm: ComponentPublicInstance;
    container: HTMLElement;
    emittedEvents: {
      close: any[];
      parsed: ParsedInvoiceResult[];
    };
    cleanup: () => void;
  }

  function mountModal(): MountHelperResult {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const emittedEvents = {
      close: [] as any[],
      parsed: [] as ParsedInvoiceResult[],
    };

    const app = createApp(InvoiceScannerModal, {
      onClose: () => {
        emittedEvents.close.push(true);
      },
      onParsed: (payload: ParsedInvoiceResult) => {
        emittedEvents.parsed.push(payload);
      },
    });

    const vm = app.mount(container);

    return {
      app,
      vm,
      container,
      emittedEvents,
      cleanup: () => {
        app.unmount();
        container.remove();
      },
    };
  }

  async function flushAsyncWork(ms = 30) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, ms));
    await nextTick();
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('InvoiceScannerModal 掛載時應調用 getCategories("expense") 載入動態支出分類', async () => {
    const { cleanup } = mountModal();
    await flushAsyncWork();

    try {
      expect(dbModule.getCategories, '掛載時應調用 getCategories("expense") 讀取支出分類').toHaveBeenCalledWith('expense');
    } finally {
      cleanup();
    }
  });

  it('發票品項分類選單應動態載入資料庫自訂支出分類（如毛孩醫療、攝影器材），不再為靜態硬編碼', async () => {
    vi.mocked(dbModule.getCategories).mockResolvedValueOnce([
      { id: 1, name: '餐飲', type: 'expense', isDefault: true },
      { id: 2, name: '交通', type: 'expense', isDefault: true },
      { id: 3, name: '生活', type: 'expense', isDefault: true },
      { id: 4, name: '娛樂', type: 'expense', isDefault: true },
      { id: 5, name: '醫療', type: 'expense', isDefault: true },
      { id: 6, name: '其他', type: 'expense', isDefault: true },
      { id: 99, name: '毛孩醫療', type: 'expense', isDefault: false },
      { id: 100, name: '攝影器材', type: 'expense', isDefault: false },
    ]);

    const { container, cleanup } = mountModal();
    await flushAsyncWork();

    try {
      // 模擬在手動雙碼區輸入左碼發票資料並解析
      const leftQrInput = container.querySelector('#left-qr') as HTMLTextAreaElement;
      expect(leftQrInput, '應存在 #left-qr 輸入框').not.toBeNull();
      leftQrInput.value = `${BASE_LEFT_77}:**:寵物罐頭:2:200`;
      leftQrInput.dispatchEvent(new Event('input'));
      await flushAsyncWork();

      const parseBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('解析發票')
      );
      expect(parseBtn, '應存在「解析發票」按鈕').not.toBeNull();
      (parseBtn as HTMLButtonElement).click();
      await flushAsyncWork();

      // 檢查品項分類下拉選單
      const categorySelect = container.querySelector('select');
      expect(categorySelect, '解析成功後應出現品項分類下拉選單').not.toBeNull();

      const options = Array.from(categorySelect?.querySelectorAll('option') || []).map(
        (opt) => opt.value || opt.textContent?.trim()
      );

      // 驗證選項中包含動態載入的自訂分類
      expect(options, '分類選項應包含動態載入的自訂分類「毛孩醫療」').toContain('毛孩醫療');
      expect(options, '分類選項應包含動態載入的自訂分類「攝影器材」').toContain('攝影器材');
      expect(options, '分類選項仍應包含預設分類「餐飲」').toContain('餐飲');
      expect(options, '分類選項仍應包含預設分類「其他」').toContain('其他');
    } finally {
      cleanup();
    }
  });

  it('使用者選取動態自訂分類後點擊帶入表單，emitted parsed 結果中品項 category 應為自訂分類', async () => {
    vi.mocked(dbModule.getCategories).mockResolvedValueOnce([
      { id: 1, name: '餐飲', type: 'expense', isDefault: true },
      { id: 2, name: '交通', type: 'expense', isDefault: true },
      { id: 99, name: '毛孩醫療', type: 'expense', isDefault: false },
    ]);

    const { container, emittedEvents, cleanup } = mountModal();
    await flushAsyncWork();

    try {
      const leftQrInput = container.querySelector('#left-qr') as HTMLTextAreaElement;
      leftQrInput.value = `${BASE_LEFT_77}:**:寵物疫苗針劑:1:800`;
      leftQrInput.dispatchEvent(new Event('input'));
      await flushAsyncWork();

      const parseBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('解析發票')
      );
      (parseBtn as HTMLButtonElement).click();
      await flushAsyncWork();

      const categorySelect = container.querySelector('select') as HTMLSelectElement;
      expect(categorySelect).not.toBeNull();

      // 選取自訂分類「毛孩醫療」
      categorySelect.value = '毛孩醫療';
      categorySelect.dispatchEvent(new Event('change'));
      await flushAsyncWork();

      // 點擊「帶入表單」
      const importBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('帶入表單')
      );
      expect(importBtn, '應存在「帶入表單」按鈕').not.toBeNull();
      (importBtn as HTMLButtonElement).click();
      await flushAsyncWork();

      // 驗證 emit 結果
      expect(emittedEvents.parsed.length, '應觸發 parsed 事件').toBe(1);
      const firstItem = emittedEvents.parsed[0].items[0];
      expect(firstItem.category, '帶入表單之品項 category 應為使用者選取之動態自訂分類').toBe('毛孩醫療');
    } finally {
      cleanup();
    }
  });
});
