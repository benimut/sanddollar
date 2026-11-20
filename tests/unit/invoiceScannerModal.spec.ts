import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick, type ComponentPublicInstance } from 'vue';
import jsQR from 'jsqr';
import InvoiceScannerModal from '@/components/InvoiceScannerModal.vue';
import * as dbModule from '@/db';
import type { ParsedInvoiceResult } from '@/utils/invoiceParser';

/**
 * 電子發票掃描彈窗 (InvoiceScannerModal) 單元測試套件
 *
 * 測試範疇：
 * 1. M2 動態支出分類載入與自訂分類選取帶入表單驗證。
 * 2. 相機高解析度串流啟動、原生 BarcodeDetector 雙碼同步辨識驗證。
 * 3. 無原生 BarcodeDetector 時自動降級使用 jsQR（含 Big5 二進位資料備援解碼）驗證。
 * 4. 掃描到非電子發票 QR Code 即時提醒與關閉時相機資源釋放驗證。
 */

// Mock jsqr
vi.mock('jsqr', () => ({
  default: vi.fn().mockReturnValue(null),
}));

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

/** 建立模擬相機 MediaStream 與軌道控制工具 */
function createMockCameraStream() {
  const stopTrack = vi.fn();
  const applyConstraints = vi.fn().mockResolvedValue(undefined);
  const mockTrack = {
    stop: stopTrack,
    getCapabilities: vi.fn().mockReturnValue({ focusMode: ['continuous'] }),
    applyConstraints,
  };
  const stream = typeof MediaStream !== 'undefined' ? new MediaStream() : ({} as MediaStream);
  Object.defineProperty(stream, 'getTracks', {
    value: vi.fn().mockReturnValue([mockTrack]),
    configurable: true,
  });
  Object.defineProperty(stream, 'getVideoTracks', {
    value: vi.fn().mockReturnValue([mockTrack]),
    configurable: true,
  });

  return { stream, stopTrack, applyConstraints };
}

/** 模擬影片元素具備可解碼之高解析度影格，以及離屏 canvas 2D context */
function setupVideoAndCanvasMocks(videoWidth = 1920, videoHeight = 1080) {
  const originalCreateElement = document.createElement.bind(document);
  const drawImage = vi.fn();
  const getImageData = vi.fn((_x: number, _y: number, w: number, h: number) => ({
    data: new Uint8ClampedArray(w * h * 4),
    width: w,
    height: h,
  }));

  const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
    const el = originalCreateElement(tagName, options);
    if (tagName.toLowerCase() === 'canvas') {
      Object.defineProperty(el, 'getContext', {
        value: vi.fn().mockReturnValue({
          drawImage,
          getImageData,
        }),
      });
    }
    return el;
  }) as typeof document.createElement);

  const playSpy = vi
    .spyOn(HTMLMediaElement.prototype, 'play')
    .mockImplementation(function (this: HTMLVideoElement) {
      Object.defineProperty(this, 'readyState', { value: 4, configurable: true });
      Object.defineProperty(this, 'videoWidth', { value: videoWidth, configurable: true });
      Object.defineProperty(this, 'videoHeight', { value: videoHeight, configurable: true });
      return Promise.resolve();
    });

  return {
    drawImage,
    getImageData,
    restore: () => {
      createElementSpy.mockRestore();
      playSpy.mockRestore();
    },
  };
}

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
    vi.mocked(jsQR).mockReturnValue(null);
    delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;

    // 預設模擬無相機環境以讓手動輸入測試快速降級
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new Error('No camera in unit test')),
      },
      configurable: true,
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
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

  it('支援原生 BarcodeDetector 時，單幀同時偵測到左右雙碼應自動解析並合併全部商品明細，且關閉時釋放相機', async () => {
    const { stream, stopTrack, applyConstraints } = createMockCameraStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });

    const detectMock = vi.fn().mockResolvedValue([
      { rawValue: `${BASE_LEFT_77}:**:無糖綠茶:1:35` },
      { rawValue: '**茶葉蛋:2:14' },
    ]);

    class MockBarcodeDetector {
      static getSupportedFormats = vi.fn().mockResolvedValue(['qr_code']);
      detect = detectMock;
    }
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = MockBarcodeDetector;

    const mediaMocks = setupVideoAndCanvasMocks(1920, 1080);
    const { container, cleanup } = mountModal();

    try {
      await flushAsyncWork(220);

      // 應以高解析度後置鏡頭請求相機並套用連續自動對焦
      expect(getUserMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          audio: false,
          video: expect.objectContaining({
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          }),
        })
      );
      expect(applyConstraints).toHaveBeenCalled();

      // 驗證左右雙碼已自動填入並完成解析合併
      expect(container.textContent).toContain('AB12345678');
      expect(container.textContent).toContain('無糖綠茶');
      expect(container.textContent).toContain('茶葉蛋');
      expect(container.textContent).toContain('已讀取左、右雙 QR Code 並完成解析');
    } finally {
      cleanup();
      mediaMocks.restore();
    }

    // 卸載時應停止相機軌道避免鏡頭持續開啟
    expect(stopTrack).toHaveBeenCalled();
  });

  it('不支援原生 BarcodeDetector 時，應降級使用 jsQR 並在 Big5 二進位資料下成功解析發票', async () => {
    const { stream } = createMockCameraStream();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
      configurable: true,
    });

    // 模擬 jsQR 掃到 Big5 編碼發票導致 data 為空字串、僅保留 binaryData 的情境
    const rawInvoiceAscii = `${BASE_LEFT_77}:**:Tea:1:35`;
    const binaryBytes = Array.from(rawInvoiceAscii, (ch) => ch.charCodeAt(0));
    vi.mocked(jsQR).mockReturnValue({
      data: '',
      binaryData: binaryBytes,
      chunks: [],
      version: 9,
      location: {} as any,
    });

    const mediaMocks = setupVideoAndCanvasMocks(1280, 720);
    const { container, cleanup } = mountModal();

    try {
      await flushAsyncWork(220);

      expect(jsQR).toHaveBeenCalled();
      expect(container.textContent).toContain('AB12345678');
      expect(container.textContent).toContain('Tea');
    } finally {
      cleanup();
      mediaMocks.restore();
    }
  });

  it('掃描到非電子發票 QR Code 時應於相機區顯示即時提醒且不覆蓋已解析資料', async () => {
    const { stream } = createMockCameraStream();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
      configurable: true,
    });

    vi.mocked(jsQR).mockReturnValue({
      data: 'https://example.com/promo',
      binaryData: [],
      chunks: [],
      version: 4,
      location: {} as any,
    });

    const mediaMocks = setupVideoAndCanvasMocks(1280, 720);
    const { container, cleanup } = mountModal();

    try {
      await flushAsyncWork(220);

      expect(container.textContent).toContain('偵測到非電子發票 QR Code');
      const leftQrInput = container.querySelector('#left-qr') as HTMLTextAreaElement;
      expect(leftQrInput.value).toBe('');
    } finally {
      cleanup();
      mediaMocks.restore();
    }
  });
});
