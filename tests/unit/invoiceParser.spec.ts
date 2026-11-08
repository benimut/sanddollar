import { describe, it, expect } from 'vitest';
import { parseTaiwanInvoice, type ParsedInvoiceResult } from '@/utils/invoiceParser';

describe('電子發票雙 QR Code 解析模組 (invoiceParser)', () => {
  // 標準測試資料產生輔助常數
  // 左碼 77 碼固定長度欄位：
  // 發票字軌號碼 (10碼): AB12345678
  // 開立日期 (7碼民國年): 1130520 (2024-05-20)
  // 隨機碼 (4碼): 8888
  // 銷售額 16進位 (8碼): 000000C8 (200)
  // 總計金額 16進位 (8碼): 000000C8 (200)
  // 買方統編 (8碼): 00000000
  // 賣方統編 (8碼): 12345678
  // 加密驗證碼 (24碼): 012345678901234567890123
  const BASE_LEFT_77 = 'AB1234567811305208888000000C8000000C80000000012345678012345678901234567890123';

  describe('完整雙 QR Code 解析', () => {
    it('應正確解析左碼基本資訊並合併右碼接續的商品明細', () => {
      // 左碼帶 2 個品項
      const leftCode = `${BASE_LEFT_77}:**:無糖綠茶:1:35:茶葉蛋:2:14`;
      // 右碼接續 2 個品項（以 ** 開頭）
      const rightCode = '**鮮奶吐司:1:65:美式咖啡:2:36';

      const result: ParsedInvoiceResult = parseTaiwanInvoice(leftCode, rightCode);

      // 驗證基本發票資訊
      expect(result.invoiceNumber).toBe('AB12345678');
      expect(result.date).toBe('2024-05-20');
      expect(result.randomCode).toBe('8888');
      expect(result.totalAmount).toBe(200);

      // 驗證商品品項數量與合併結果
      expect(result.items).toHaveLength(4);

      // 驗證個別品項資訊與小計計算 (quantity * unitPrice)
      expect(result.items[0]).toEqual({
        name: '無糖綠茶',
        quantity: 1,
        unitPrice: 35,
        subtotal: 35,
        category: expect.any(String)
      });

      expect(result.items[1]).toEqual({
        name: '茶葉蛋',
        quantity: 2,
        unitPrice: 14,
        subtotal: 28,
        category: expect.any(String)
      });

      expect(result.items[2]).toEqual({
        name: '鮮奶吐司',
        quantity: 1,
        unitPrice: 65,
        subtotal: 65,
        category: expect.any(String)
      });

      expect(result.items[3]).toEqual({
        name: '美式咖啡',
        quantity: 2,
        unitPrice: 36,
        subtotal: 72,
        category: expect.any(String)
      });
    });

    it('應支援右碼以 **: 開頭的接續格式', () => {
      const leftCode = `${BASE_LEFT_77}:**:飯糰:1:30`;
      const rightCode = '**:優酪乳:1:40';

      const result = parseTaiwanInvoice(leftCode, rightCode);

      expect(result.items).toHaveLength(2);
      expect(result.items[0].name).toBe('飯糰');
      expect(result.items[0].subtotal).toBe(30);
      expect(result.items[1].name).toBe('優酪乳');
      expect(result.items[1].subtotal).toBe(40);
    });
  });

  describe('單一左 QR Code 解析', () => {
    it('當品項較少且已全數包含在左碼時，未傳入右碼應正確解析所有明細', () => {
      const leftCode = `${BASE_LEFT_77}:**:特濃拿鐵:2:55:熱狗麵包:1:35`;

      const result = parseTaiwanInvoice(leftCode);

      expect(result.invoiceNumber).toBe('AB12345678');
      expect(result.date).toBe('2024-05-20');
      expect(result.totalAmount).toBe(200);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toEqual({
        name: '特濃拿鐵',
        quantity: 2,
        unitPrice: 55,
        subtotal: 110,
        category: expect.any(String)
      });
      expect(result.items[1]).toEqual({
        name: '熱狗麵包',
        quantity: 1,
        unitPrice: 35,
        subtotal: 35,
        category: expect.any(String)
      });
    });

    it('當左碼僅有基本 77 碼無商品明細時，items 應為空陣列', () => {
      const leftCode = BASE_LEFT_77;

      const result = parseTaiwanInvoice(leftCode);

      expect(result.invoiceNumber).toBe('AB12345678');
      expect(result.date).toBe('2024-05-20');
      expect(result.randomCode).toBe('8888');
      expect(result.totalAmount).toBe(200);
      expect(result.items).toEqual([]);
    });

    it('右碼為空字串或空白時，不應影響左碼正常解析', () => {
      const leftCode = `${BASE_LEFT_77}:**:礦泉水:1:20`;

      const resultWithEmptyRight = parseTaiwanInvoice(leftCode, '');
      const resultWithWhitespaceRight = parseTaiwanInvoice(leftCode, '   ');

      expect(resultWithEmptyRight.items).toHaveLength(1);
      expect(resultWithEmptyRight.items[0].name).toBe('礦泉水');
      expect(resultWithWhitespaceRight.items).toHaveLength(1);
      expect(resultWithWhitespaceRight.items[0].name).toBe('礦泉水');
    });
  });

  describe('民國日期轉西元日期轉換 (ROC Year to Common Era)', () => {
    it('應正確將 113 年轉換為西元 2024 年', () => {
      // 1130520 -> 2024-05-20
      const leftCode = 'CD987654321130520123400000064000000640000000012345678012345678901234567890123';
      const result = parseTaiwanInvoice(leftCode);

      expect(result.date).toBe('2024-05-20');
    });

    it('應正確處理跨年邊界（如 114 年元旦 1140101 -> 2025-01-01）', () => {
      const leftCode = 'EF112233441140101999900000064000000640000000012345678012345678901234567890123';
      const result = parseTaiwanInvoice(leftCode);

      expect(result.date).toBe('2025-01-01');
    });

    it('應正確處理歷史年份（如 109 年年底 1091231 -> 2020-12-31）', () => {
      const leftCode = 'GH556677881091231777700000064000000640000000012345678012345678901234567890123';
      const result = parseTaiwanInvoice(leftCode);

      expect(result.date).toBe('2020-12-31');
    });
  });

  describe('十六進位金額解析 (Hexadecimal Amount Parsing)', () => {
    it('應正確將 16 進位金額 00000064 轉換為十進位 100', () => {
      // 00000064 hex = 100 dec
      const leftCode = 'AA111111111130520123400000064000000640000000012345678012345678901234567890123';
      const result = parseTaiwanInvoice(leftCode);

      expect(result.totalAmount).toBe(100);
    });

    it('應正確將較大 16 進位金額 000186A0 轉換為十進位 100000', () => {
      // 000186A0 hex = 100,000 dec
      const leftCode = 'BB2222222211305201234000186A0000186A00000000012345678012345678901234567890123';
      const result = parseTaiwanInvoice(leftCode);

      expect(result.totalAmount).toBe(100000);
    });

    it('應正確處理小額金額 00000001 為十進位 1', () => {
      const leftCode = 'CC333333331130520123400000001000000010000000012345678012345678901234567890123';
      const result = parseTaiwanInvoice(leftCode);

      expect(result.totalAmount).toBe(1);
    });
  });

  describe('異常與無效條碼防禦 (Error Handling & Edge Cases)', () => {
    it('當左碼為空字串或 null/undefined 時應拋出特定錯誤', () => {
      // @ts-expect-error 故意傳入無效型別驗證防禦機制
      expect(() => parseTaiwanInvoice('')).toThrow(/無效|長度不足|格式錯誤/i);
      // @ts-expect-error 故意傳入無效型別驗證防禦機制
      expect(() => parseTaiwanInvoice(null)).toThrow();
      // @ts-expect-error 故意傳入無效型別驗證防禦機制
      expect(() => parseTaiwanInvoice(undefined)).toThrow();
    });

    it('當左碼字串長度不足 77 碼時應拋出長度不足之錯誤', () => {
      const tooShort = 'AB123456781130520888800000064';
      expect(() => parseTaiwanInvoice(tooShort)).toThrow(/長度不足|無效/i);
    });

    it('當發票號碼格式不符合台灣發票規格（非 2 碼英文 + 8 碼數字）時應拋出錯誤', () => {
      // 英文僅 1 碼或為特殊符號
      const invalidInvoiceNo = '12345678901130520888800000064000000640000000012345678012345678901234567890123';
      expect(() => parseTaiwanInvoice(invalidInvoiceNo)).toThrow(/發票號碼|格式錯誤/i);
    });

    it('當民國日期格式不合法（如月份為 99）時應拋出錯誤', () => {
      const invalidMonth = 'AB123456781139920888800000064000000640000000012345678012345678901234567890123';
      expect(() => parseTaiwanInvoice(invalidMonth)).toThrow(/日期|格式錯誤/i);
    });

    it('當總金額非有效十六進位字串時應拋出錯誤', () => {
      const invalidHex = 'AB123456781130520888800000064ZZZZZZZZ0000000012345678012345678901234567890123';
      expect(() => parseTaiwanInvoice(invalidHex)).toThrow(/金額|16進位|格式錯誤/i);
    });

    it('右碼若包含無效或不完整品項字串時應安全容錯並過濾無效品項', () => {
      const leftCode = `${BASE_LEFT_77}:**:合規商品:1:50`;
      // 右碼格式殘缺（例如缺少單價欄位）
      const brokenRightCode = '**不完整商品:2';

      const result = parseTaiwanInvoice(leftCode, brokenRightCode);

      // 合規商品應正常解析保留，殘缺品項不應導致 crash
      expect(result.items.some((item) => item.name === '合規商品')).toBe(true);
    });
  });
});
