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
 * 2. 相機階梯式高解析度串流啟動、原生 BarcodeDetector 直接讀取原始 video 雙碼同步辨識。
 * 3. 無原生 BarcodeDetector 時自動降級使用 1:1 可視中央 ROI 搭配 jsQR（含 Big5 二進位備援解碼）。
 * 4. 多鏡頭切換與偏好記憶、硬體變焦獨立套用、點擊重新對焦（Tap-to-Focus）與診斷列顯示驗證。
 * 5. 掃描到非電子發票 QR Code 即時提醒與關閉時相機資源釋放驗證。
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

interface MockStreamOptions {
  deviceId?: string;
  label?: string;
  focusModes?: string[];
  zoom?: { min: number; max: number; step: number } | null;
}

/** 建立模擬相機 MediaStream 與軌道控制工具 */
function createMockCameraStream(options: MockStreamOptions = {}) {
  const {
    deviceId = 'cam-back-0',
    label = 'camera2 0, facing back',
    focusModes = ['continuous', 'single-shot'],
    zoom = { min: 1, max: 5, step: 0.1 },
  } = options;

  let appliedZoom: number | undefined = zoom ? zoom.min : undefined;
  let appliedFocusMode: string | undefined = focusModes[0];

  const stopTrack = vi.fn();
  const applyConstraints = vi.fn().mockImplementation(async (constraints: { advanced?: Array<{ focusMode?: string; zoom?: number }> }) => {
    const adv = constraints?.advanced?.[0];
    if (adv?.focusMode) {
      appliedFocusMode = adv.focusMode;
    }
    if (typeof adv?.zoom === 'number') {
      appliedZoom = adv.zoom;
    }
  });

  const mockTrack = {
    label,
    stop: stopTrack,
    getCapabilities: vi.fn().mockReturnValue({
      focusMode: focusModes,
      ...(zoom ? { zoom } : {}),
    }),
    getSettings: vi.fn().mockImplementation(() => ({
      deviceId,
      focusMode: appliedFocusMode,
      ...(typeof appliedZoom === 'number' ? { zoom: appliedZoom } : {}),
    })),
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

  return { stream, stopTrack, applyConstraints, mockTrack };
}

/** 模擬影片元素具備可解碼之高解析度影格，以及離屏 canvas 2D context */
function setupVideoAndCanvasMocks(
  videoWidth = 1920,
  videoHeight = 1080,
  clientWidth = 320,
  clientHeight = 240
) {
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
      Object.defineProperty(this, 'clientWidth', { value: clientWidth, configurable: true });
      Object.defineProperty(this, 'clientHeight', { value: clientHeight, configurable: true });
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

describe('Milestone 2 (M2): InvoiceScannerModal 分類動態載入與相機掃描驗證套件', () => {
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

  let storageMap: Map<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    storageMap = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (key: string) => storageMap.get(key) ?? null,
        setItem: (key: string, val: string) => {
          storageMap.set(key, String(val));
        },
        removeItem: (key: string) => {
          storageMap.delete(key);
        },
        clear: () => {
          storageMap.clear();
        },
      },
      configurable: true,
    });
    vi.mocked(jsQR).mockReturnValue(null);
    delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;

    // 預設模擬無相機環境以讓手動輸入測試快速降級
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new Error('No camera in unit test')),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      configurable: true,
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    storageMap.clear();
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

  it('支援原生 BarcodeDetector 時，直接掃描原始 video 同步解析左右雙碼、獨立套用對焦與變焦並顯示診斷列', async () => {
    const { stream, stopTrack, applyConstraints } = createMockCameraStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia,
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'videoinput', deviceId: 'cam-back-0', label: 'camera2 0, facing back' },
        ]),
      },
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

      // 應以高解析度後置鏡頭請求相機
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

      // 對焦與變焦應分開獨立呼叫 applyConstraints，避免單項不支援連帶失效
      expect(applyConstraints).toHaveBeenCalledWith({
        advanced: [{ focusMode: 'continuous' }],
      });
      expect(applyConstraints).toHaveBeenCalledWith({
        advanced: [{ zoom: 1.8 }],
      });

      // 原生 BarcodeDetector 應直接收到 HTMLVideoElement 而非縮圖 canvas
      expect(detectMock).toHaveBeenCalled();
      expect(detectMock.mock.calls[0][0]).toBeInstanceOf(HTMLVideoElement);

      // 驗證診斷列顯示實際解析度、鏡頭名稱、倍率、對焦與引擎
      const diagBar = container.querySelector('[data-testid="camera-diagnostics"]');
      expect(diagBar?.textContent).toContain('1920×1080');
      expect(diagBar?.textContent).toContain('camera2 0, facing back');
      expect(diagBar?.textContent).toContain('1.8x');
      expect(diagBar?.textContent).toContain('Native+ROI');

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

  it('不支援原生 BarcodeDetector 時，應對 object-cover 可視中央區進行 1:1 ROI 裁切並透過 jsQR（含 Big5 二進位備援）解析發票', async () => {
    const { stream } = createMockCameraStream({ zoom: null });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
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

    // 模擬手機直向 1080×1920 視訊透過 object-cover 呈現於 320×240 (4:3) 容器
    const mediaMocks = setupVideoAndCanvasMocks(1080, 1920, 320, 240);
    const { container, cleanup } = mountModal();

    try {
      await flushAsyncWork(220);

      expect(jsQR).toHaveBeenCalled();
      expect(mediaMocks.drawImage).toHaveBeenCalled();

      // 驗證 drawImage 裁切的是中央可視區且為 1:1 原始像素（來源寬高與目標寬高一致，且排除上下被 object-cover 截掉的區域）
      const [, sx, sy, sw, sh, , , dw, dh] = mediaMocks.drawImage.mock.calls[0];
      expect(sy, '應避開被 object-cover 裁切的頂部區域').toBeGreaterThan(500);
      expect(sh, 'ROI 高度應小於影片總高，聚焦可視對準區').toBeLessThan(810);
      expect(sw, '來源寬度應與目標畫布寬度維持 1:1 無縮放').toBe(dw);
      expect(sh, '來源高度應與目標畫布高度維持 1:1 無縮放').toBe(dh);

      expect(container.textContent).toContain('AB12345678');
      expect(container.textContent).toContain('Tea');
    } finally {
      cleanup();
      mediaMocks.restore();
    }
  });

  it('偵測到多顆後置鏡頭時，支援切換鏡頭並記憶偏好 deviceId，且支援變焦切換與點擊重新對焦', async () => {
    const firstCam = createMockCameraStream({
      deviceId: 'cam-back-0',
      label: 'camera2 0, facing back',
    });
    const secondCam = createMockCameraStream({
      deviceId: 'cam-back-2',
      label: 'camera2 2, facing back',
    });

    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(firstCam.stream)
      .mockResolvedValueOnce(secondCam.stream);

    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia,
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'videoinput', deviceId: 'cam-back-0', label: 'camera2 0, facing back' },
          { kind: 'videoinput', deviceId: 'cam-front-1', label: 'camera2 1, facing front' },
          { kind: 'videoinput', deviceId: 'cam-back-2', label: 'camera2 2, facing back' },
          { kind: 'videoinput', deviceId: 'cam-back-4', label: 'camera2 4, facing back' },
        ]),
      },
      configurable: true,
    });

    const mediaMocks = setupVideoAndCanvasMocks(1920, 1080);
    const { container, cleanup } = mountModal();

    try {
      await flushAsyncWork(80);

      // 應僅列舉 3 顆後置鏡頭（排除前鏡頭）並顯示切換按鈕
      const switchBtn = container.querySelector('[data-testid="switch-camera-btn"]') as HTMLButtonElement;
      expect(switchBtn, '多後置鏡頭時應顯示切換鏡頭按鈕').not.toBeNull();
      expect(switchBtn.textContent).toContain('1/3');

      // 測試切換 2x 變焦倍率
      const zoomButtons = Array.from(container.querySelectorAll('[data-testid="zoom-btn"]')) as HTMLButtonElement[];
      const zoom2xBtn = zoomButtons.find((btn) => btn.textContent?.trim() === '2x');
      expect(zoom2xBtn, '應顯示 2x 快速倍率按鈕').not.toBeNull();
      zoom2xBtn!.click();
      await flushAsyncWork(30);
      expect(firstCam.applyConstraints).toHaveBeenCalledWith({
        advanced: [{ zoom: 2 }],
      });

      // 測試點擊預覽區觸發重新對焦（single-shot -> continuous）
      const readerEl = container.querySelector('#qr-reader') as HTMLDivElement;
      readerEl.click();
      await flushAsyncWork(30);
      expect(firstCam.applyConstraints).toHaveBeenCalledWith({
        advanced: [{ focusMode: 'single-shot' }],
      });

      // 測試切換至下一顆後置鏡頭
      switchBtn.click();
      await flushAsyncWork(80);

      expect(firstCam.stopTrack, '切換鏡頭前應先停止舊鏡頭軌道').toHaveBeenCalled();
      expect(getUserMedia).toHaveBeenLastCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({
            deviceId: { exact: 'cam-back-2' },
          }),
        })
      );
      expect(window.localStorage.getItem('sanddollar_invoice_scanner_camera_id')).toBe('cam-back-2');
      expect(container.querySelector('[data-testid="camera-diagnostics"]')?.textContent).toContain(
        'camera2 2, facing back'
      );
    } finally {
      cleanup();
      mediaMocks.restore();
    }
  });

  it('掃描到非電子發票 QR Code 時應於相機區顯示即時提醒且不覆蓋已解析資料', async () => {
    const { stream } = createMockCameraStream();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
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
