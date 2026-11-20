import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick, type ComponentPublicInstance } from 'vue';
import jsQR from 'jsqr';
import InvoiceScannerModal from '@/components/InvoiceScannerModal.vue';
import type { ParsedInvoiceResult } from '@/utils/invoiceParser';

/**
 * 電子發票掃描彈窗 (InvoiceScannerModal) 單元測試套件
 *
 * 測試範疇：
 * 1. 掃描彈窗介面精簡契約：無分類選單、無手動輸入框、無「解析發票」按鈕、完整顯示預覽畫面（object-contain）。
 * 2. 原生 BarcodeDetector 雙碼同步辨識、雙碼完成自動暫停、成功掃碼才記憶偏好鏡頭與一鍵無阻擋帶入表單（品項 category 清空）。
 * 3. 智慧自動選鏡：預設鏡頭無自動對焦能力時自動靜默切換其他後置鏡頭。
 * 4. 多後置鏡頭角落圖示切換按鈕與重新掃描功能驗證。
 * 5. 無原生 BarcodeDetector 時自動降級 jsQR（含 Big5 二進位備援解碼）與非發票 QR Code 即時提醒驗證。
 */

// Mock jsqr
vi.mock('jsqr', () => ({
  default: vi.fn().mockReturnValue(null),
}));

interface MockStreamOptions {
  deviceId?: string;
  label?: string;
  focusModes?: string[];
}

/** 建立模擬相機 MediaStream 與軌道控制工具 */
function createMockCameraStream(options: MockStreamOptions = {}) {
  const {
    deviceId = 'cam-back-0',
    label = 'camera2 0, facing back',
    focusModes = ['continuous', 'single-shot'],
  } = options;

  const stopTrack = vi.fn();
  const applyConstraints = vi.fn().mockResolvedValue(undefined);

  const mockTrack = {
    label,
    stop: stopTrack,
    getCapabilities: vi.fn().mockReturnValue({
      focusMode: focusModes,
    }),
    getSettings: vi.fn().mockReturnValue({
      deviceId,
    }),
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

describe('InvoiceScannerModal 電子發票相機掃描驗證套件', () => {
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

  it('掃描彈窗應採純相機介面（無手動輸入框、無「解析發票」按鈕、無分類下拉選單且完整顯示相機畫面）', async () => {
    const { container, cleanup } = mountModal();
    await flushAsyncWork();

    try {
      expect(container.querySelector('#left-qr'), '應已移除左側手動輸入框').toBeNull();
      expect(container.querySelector('#right-qr'), '應已移除右側手動輸入框').toBeNull();
      expect(container.querySelector('select'), '掃描階段不應出現分類下拉選單').toBeNull();
      expect(container.textContent, '底部操作列不應包含「解析發票」按鈕').not.toContain('解析發票');

      const videoEl = container.querySelector('video');
      expect(videoEl, '應存在相機預覽 video 元素').not.toBeNull();
      expect(videoEl?.className, '相機預覽應採 object-contain 完整顯示不裁切').toContain('object-contain');
    } finally {
      cleanup();
    }
  });

  it('支援原生 BarcodeDetector 時，同步解析左右雙碼、成功掃碼記憶偏好鏡頭並可直接無阻擋帶入表單', async () => {
    const { stream, stopTrack, applyConstraints } = createMockCameraStream({
      deviceId: 'cam-back-0',
      label: 'camera2 0, facing back',
    });
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
    const { container, emittedEvents, cleanup } = mountModal();

    try {
      // 等待開流穩定延遲 (250ms) + 首次掃描
      await flushAsyncWork(360);

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

      // 應套用連續自動對焦且不再強制套用變焦
      expect(applyConstraints).toHaveBeenCalledWith({
        advanced: [{ focusMode: 'continuous' }],
      });
      expect(applyConstraints).not.toHaveBeenCalledWith(
        expect.objectContaining({
          advanced: expect.arrayContaining([expect.objectContaining({ zoom: expect.anything() })]),
        })
      );

      // 原生 BarcodeDetector 應直接讀取完整原始 video
      expect(detectMock).toHaveBeenCalled();
      expect(detectMock.mock.calls[0][0]).toBeInstanceOf(HTMLVideoElement);

      // 成功掃出有效發票後才記憶偏好鏡頭
      expect(window.localStorage.getItem('sanddollar_invoice_scanner_verified_camera_id')).toBe('cam-back-0');

      // 驗證預覽結果與無分類下拉選單
      expect(container.textContent).toContain('AB12345678');
      expect(container.textContent).toContain('無糖綠茶');
      expect(container.textContent).toContain('茶葉蛋');
      expect(container.querySelector('select')).toBeNull();

      // 直接點擊「帶入表單」不因無分類而阻塞
      const importBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('帶入表單')
      );
      expect(importBtn, '應顯示「帶入表單」按鈕').not.toBeNull();
      (importBtn as HTMLButtonElement).click();
      await flushAsyncWork();

      expect(emittedEvents.parsed.length, '應直接觸發 parsed 事件帶入表單').toBe(1);
      expect(emittedEvents.parsed[0].items).toHaveLength(2);
      expect(emittedEvents.parsed[0].items[0].category, '掃描端應清空分類交由表單處理').toBe('');
      expect(emittedEvents.close.length, '帶入後應關閉彈窗').toBe(1);
    } finally {
      cleanup();
      mediaMocks.restore();
    }

    expect(stopTrack).toHaveBeenCalled();
  });

  it('預設開啟的後置鏡頭無自動對焦能力時，應自動靜默切換至支援自動對焦的其他後置鏡頭', async () => {
    const fixedFocusCam = createMockCameraStream({
      deviceId: 'cam-back-fixed',
      label: 'camera2 2, facing back',
      focusModes: [],
    });
    const autoFocusCam = createMockCameraStream({
      deviceId: 'cam-back-af',
      label: 'camera2 0, facing back',
      focusModes: ['continuous', 'single-shot'],
    });

    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(fixedFocusCam.stream)
      .mockResolvedValueOnce(autoFocusCam.stream);

    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia,
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'videoinput', deviceId: 'cam-back-fixed', label: 'camera2 2, facing back' },
          { kind: 'videoinput', deviceId: 'cam-front-1', label: 'camera2 1, facing front' },
          { kind: 'videoinput', deviceId: 'cam-back-af', label: 'camera2 0, facing back' },
        ]),
      },
      configurable: true,
    });

    const mediaMocks = setupVideoAndCanvasMocks(1920, 1080);
    const { cleanup } = mountModal();

    try {
      await flushAsyncWork(100);

      expect(fixedFocusCam.stopTrack, '應釋放無自動對焦的鏡頭軌道').toHaveBeenCalled();
      expect(getUserMedia).toHaveBeenLastCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({
            deviceId: { exact: 'cam-back-af' },
          }),
        })
      );
      expect(autoFocusCam.applyConstraints).toHaveBeenCalledWith({
        advanced: [{ focusMode: 'continuous' }],
      });
    } finally {
      cleanup();
      mediaMocks.restore();
    }
  });

  it('偵測到多顆後置鏡頭時，角落顯示圖示切換按鈕且未掃出發票前不污染偏好鏡頭記憶', async () => {
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
        ]),
      },
      configurable: true,
    });

    const mediaMocks = setupVideoAndCanvasMocks(1920, 1080);
    const { container, cleanup } = mountModal();

    try {
      await flushAsyncWork(80);

      // 應顯示極簡圖示按鈕（不含長文字）且無診斷灰框或變焦按鈕
      const switchBtn = container.querySelector('[data-testid="switch-camera-btn"]') as HTMLButtonElement;
      expect(switchBtn, '多後置鏡頭時應顯示角落圖示切換按鈕').not.toBeNull();
      expect(switchBtn.getAttribute('aria-label')).toBe('切換鏡頭');
      expect(switchBtn.textContent?.trim(), '切換按鈕應為純圖示以減少空間占用').toBe('');
      expect(container.querySelector('[data-testid="camera-diagnostics"]')).toBeNull();
      expect(container.querySelector('[data-testid="zoom-btn"]')).toBeNull();

      switchBtn.click();
      await flushAsyncWork(80);

      expect(firstCam.stopTrack).toHaveBeenCalled();
      expect(getUserMedia).toHaveBeenLastCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({
            deviceId: { exact: 'cam-back-2' },
          }),
        })
      );
      expect(
        window.localStorage.getItem('sanddollar_invoice_scanner_verified_camera_id'),
        '尚未成功掃出有效發票前不應寫入偏好鏡頭'
      ).toBeNull();
    } finally {
      cleanup();
      mediaMocks.restore();
    }
  });

  it('不支援原生 BarcodeDetector 時，應降級使用 jsQR（含 Big5 二進位備援）解析發票並支援重新掃描', async () => {
    const { stream } = createMockCameraStream();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      configurable: true,
    });

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
      await flushAsyncWork(360);

      expect(jsQR).toHaveBeenCalled();
      expect(container.textContent).toContain('AB12345678');
      expect(container.textContent).toContain('Tea');

      // 驗證「重新掃描」會清除現有已讀取發票結果
      vi.mocked(jsQR).mockReturnValue(null);
      const rescanBtn = container.querySelector('[data-testid="rescan-btn"]') as HTMLButtonElement;
      expect(rescanBtn).not.toBeNull();
      rescanBtn.click();
      await flushAsyncWork(30);
      expect(container.textContent).not.toContain('AB12345678');
    } finally {
      cleanup();
      mediaMocks.restore();
    }
  });

  it('掃描到非電子發票 QR Code 時應顯示即時提醒且不出現帶入表單按鈕', async () => {
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
      await flushAsyncWork(360);

      expect(container.textContent).toContain('偵測到非電子發票 QR Code');
      const importBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('帶入表單')
      );
      expect(importBtn).toBeUndefined();
    } finally {
      cleanup();
      mediaMocks.restore();
    }
  });
});
