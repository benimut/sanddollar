import { describe, it, expect } from 'vitest';
import {
  calculateForeignExpense,
  calculateForeignIncome,
  calculateForeignTransaction,
  DEFAULT_FEE_RATE,
} from '@/utils/currency';

describe('匯率與手續費計算核心模組 (currency utility)', () => {
  describe('calculateForeignExpense - 海外支出換算', () => {
    it('應正確使用預設 1.5% 手續費率計算手續費、最終扣款總額與實質匯率', () => {
      // 假設消費 100 美元，台幣扣款（不含手續費）為 3,200 元
      // 手續費 1.5% = 3200 * 0.015 = 48 元
      // 最終扣款總額 = 3200 + 48 = 3,248 元
      // 實質匯率 = 3248 / 100 = 32.48
      const result = calculateForeignExpense(100, 3200);

      expect(result.feeAmount).toBe(48);
      expect(result.totalTwdAmount).toBe(3248);
      expect(result.effectiveRate).toBeCloseTo(32.48, 4);
    });

    it('應支援自訂手續費率計算', () => {
      // 消費 1000 日圓，台幣扣款 210 元，手續費自訂為 2% (0.02)
      // 手續費 = 210 * 0.02 = 4.2 -> 四捨五入為 4 元
      // 總金額 = 210 + 4 = 214 元
      // 實質匯率 = 214 / 1000 = 0.214
      const result = calculateForeignExpense(1000, 210, 0.02);

      expect(result.feeAmount).toBe(4);
      expect(result.totalTwdAmount).toBe(214);
      expect(result.effectiveRate).toBeCloseTo(0.214, 4);
    });

    it('手續費率為 0 時應正確計算', () => {
      // 無手續費的情況 (0%)
      const result = calculateForeignExpense(50, 1600, 0);

      expect(result.feeAmount).toBe(0);
      expect(result.totalTwdAmount).toBe(1600);
      expect(result.effectiveRate).toBeCloseTo(32, 4);
    });

    it('手續費計算應正確進行四捨五入', () => {
      // 扣款金額 105 元，手續費率 1.5% = 1.575 -> 應四捨五入為 2 元
      const result = calculateForeignExpense(10, 105, 0.015);

      expect(result.feeAmount).toBe(2);
      expect(result.totalTwdAmount).toBe(107);
      expect(result.effectiveRate).toBeCloseTo(10.7, 4);
    });

    it('當外幣金額或台幣金額為 0 或負數時，應安全回傳保護值 (0) 且不產生 NaN 或 Infinity', () => {
      // 外幣金額為 0
      const zeroForeign = calculateForeignExpense(0, 3200);
      expect(zeroForeign.feeAmount).toBe(0);
      expect(zeroForeign.totalTwdAmount).toBe(0);
      expect(zeroForeign.effectiveRate).toBe(0);
      expect(Number.isNaN(zeroForeign.effectiveRate)).toBe(false);

      // 外幣金額為負數
      const negativeForeign = calculateForeignExpense(-50, 1600);
      expect(negativeForeign.feeAmount).toBe(0);
      expect(negativeForeign.totalTwdAmount).toBe(0);
      expect(negativeForeign.effectiveRate).toBe(0);

      // 台幣金額為負數
      const negativeTwd = calculateForeignExpense(100, -500);
      expect(negativeTwd.feeAmount).toBe(0);
      expect(negativeTwd.totalTwdAmount).toBe(0);
      expect(negativeTwd.effectiveRate).toBe(0);
    });
  });

  describe('calculateForeignIncome - 海外收入換算', () => {
    it('應正確使用預設 0% 手續費率計算海外收入與實質匯率', () => {
      // 收到 500 美元，到帳台幣金額 16,000 元，預設無手續費 (0%)
      // 手續費 = 0 元
      // 實質入帳總額 = 16000 - 0 = 16,000 元
      // 實質匯率 = 16000 / 500 = 32
      const result = calculateForeignIncome(500, 16000);

      expect(result.feeAmount).toBe(0);
      expect(result.totalTwdAmount).toBe(16000);
      expect(result.effectiveRate).toBeCloseTo(32, 4);
    });

    it('應支援自訂扣除手續費率計算', () => {
      // 收到 1000 歐元，到帳 35,000 台幣，中間行手續費 1% (0.01)
      // 手續費 = 35000 * 0.01 = 350 元
      // 實質入帳總額 = 35000 - 350 = 34,650 元
      // 實質匯率 = 34650 / 1000 = 34.65
      const result = calculateForeignIncome(1000, 35000, 0.01);

      expect(result.feeAmount).toBe(350);
      expect(result.totalTwdAmount).toBe(34650);
      expect(result.effectiveRate).toBeCloseTo(34.65, 4);
    });

    it('手續費計算應正確四捨五入並扣除', () => {
      // 到帳 333 元，自訂手續費 1.5% = 4.995 -> 四捨五入為 5 元
      // 實質入帳 = 333 - 5 = 328 元
      const result = calculateForeignIncome(10, 333, 0.015);

      expect(result.feeAmount).toBe(5);
      expect(result.totalTwdAmount).toBe(328);
      expect(result.effectiveRate).toBeCloseTo(32.8, 4);
    });

    it('當外幣金額或台幣金額為 0 或負數時，應安全回傳保護值 (0) 且不產生 NaN 或 Infinity', () => {
      // 外幣金額為 0
      const zeroForeign = calculateForeignIncome(0, 16000);
      expect(zeroForeign.feeAmount).toBe(0);
      expect(zeroForeign.totalTwdAmount).toBe(0);
      expect(zeroForeign.effectiveRate).toBe(0);
      expect(Number.isNaN(zeroForeign.effectiveRate)).toBe(false);

      // 外幣金額為負數
      const negativeForeign = calculateForeignIncome(-100, 3200);
      expect(negativeForeign.feeAmount).toBe(0);
      expect(negativeForeign.totalTwdAmount).toBe(0);
      expect(negativeForeign.effectiveRate).toBe(0);

      // 台幣金額為負數
      const negativeTwd = calculateForeignIncome(100, -100);
      expect(negativeTwd.feeAmount).toBe(0);
      expect(negativeTwd.totalTwdAmount).toBe(0);
      expect(negativeTwd.effectiveRate).toBe(0);
    });
  });

  describe('DEFAULT_FEE_RATE - 預設海外手續費率常數', () => {
    it('DEFAULT_FEE_RATE 應被定義為 0.015 (1.5%)', () => {
      expect(DEFAULT_FEE_RATE).toBe(0.015);
    });
  });

  describe('calculateForeignTransaction - 共用外幣交易換算核心', () => {
    it('支出與收入換算結果應完整包含相容別名欄位 (fee 與 totalTwd)', () => {
      const exp = calculateForeignTransaction('expense', 100, 3200);
      expect(exp.fee).toBe(exp.feeAmount);
      expect(exp.totalTwd).toBe(exp.totalTwdAmount);

      const inc = calculateForeignTransaction('income', 500, 16000);
      expect(inc.fee).toBe(inc.feeAmount);
      expect(inc.totalTwd).toBe(inc.totalTwdAmount);
    });

    it('面對邊界零值與負數金額時，應安全回傳保護值且 effectiveRate 為 0 不產生 NaN', () => {
      const zero = calculateForeignTransaction('expense', 0, 3200);
      expect(zero.effectiveRate).toBe(0);
      expect(Number.isNaN(zero.effectiveRate)).toBe(false);

      const neg = calculateForeignTransaction('income', -100, 3200);
      expect(neg.effectiveRate).toBe(0);
      expect(Number.isNaN(neg.effectiveRate)).toBe(false);
    });
  });
});
