/**
 * @file date_utils.spec.ts
 * @description 共用日期處理工具模組規格測試 (Date Utils Suite)
 *
 * 核心規格：
 * 1. shiftMonth(yearMonth: string, offset: number): string
 *    - 基本位移：shiftMonth('2026-11', -1) => '2026-10'；shiftMonth('2026-11', 1) => '2026-12'。
 *    - 跨年邊界：shiftMonth('2026-01', -1) => '2025-12'；shiftMonth('2026-12', 1) => '2027-01'。
 *    - 跨多年位移：shiftMonth('2026-05', -18) => '2024-11'；shiftMonth('2024-11', 25) => '2026-12'。
 *    - 異常格式與容錯：非合法 YYYY-MM 格式（如空字串、非數字、null/undefined 或格式不合）時安全回退為當前月份 YYYY-MM。
 * 2. formatYearMonth(date?: Date): string
 *    - 未傳入參數時預設格式化當前日期為 'YYYY-MM'。
 *    - 傳入指定 Date 實例（例如 new Date(2026, 10, 5)）格式化為 '2026-11'。
 *    - 單數位月份補零（如 1 月為 '01'，9 月為 '09'）。
 */

import { describe, it, expect } from 'vitest';
import {
  shiftMonth,
  formatYearMonth,
  getTodayDateString,
  getCurrentMonthString,
} from '@/utils/date';

describe('共用日期工具函式規格測試 (Date Utils Suite)', () => {
  describe('1. formatYearMonth: 日期格式化為 YYYY-MM 字串', () => {
    it('傳入指定 Date 實例時，應正確格式化為 YYYY-MM，且月份不足兩位數自動補零', () => {
      // 月份為 0-indexed，0 為 1 月，10 為 11 月
      const dateJan = new Date(2026, 0, 15);
      expect(formatYearMonth(dateJan)).toBe('2026-01');

      const dateNov = new Date(2026, 10, 8);
      expect(formatYearMonth(dateNov)).toBe('2026-11');

      const dateSep = new Date(2025, 8, 30);
      expect(formatYearMonth(dateSep)).toBe('2025-09');
    });

    it('未傳入 date 參數時，預設回傳當前系統時間對應之 YYYY-MM 字串', () => {
      const now = new Date();
      const expectedYear = now.getFullYear();
      const expectedMonth = String(now.getMonth() + 1).padStart(2, '0');
      const expected = `${expectedYear}-${expectedMonth}`;

      expect(formatYearMonth()).toBe(expected);
    });
  });

  describe('2. shiftMonth: 年月份加減位移運算', () => {
    it('基本同年度內月份加減', () => {
      expect(shiftMonth('2026-11', -1)).toBe('2026-10');
      expect(shiftMonth('2026-11', 1)).toBe('2026-12');
      expect(shiftMonth('2026-06', 0)).toBe('2026-06');
    });

    it('跨年度邊界位移：1 月往前回推 1 個月變前一年 12 月；12 月往後推 1 個月變次年 1 月', () => {
      expect(shiftMonth('2026-01', -1)).toBe('2025-12');
      expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    });

    it('跨多年大幅度位移運算', () => {
      // 2026-05 往前推 18 個月 (1 年又 6 個月) => 2024-11
      expect(shiftMonth('2026-05', -18)).toBe('2024-11');
      // 2024-11 往後推 25 個月 (2 年又 1 個月) => 2026-12
      expect(shiftMonth('2024-11', 25)).toBe('2026-12');
    });

    it('非合法 YYYY-MM 格式或極端無效輸入時，容錯回退為當前月份', () => {
      const currentYearMonth = formatYearMonth();

      expect(shiftMonth('', 1)).toBe(currentYearMonth);
      expect(shiftMonth('invalid-date', -1)).toBe(currentYearMonth);
      expect(shiftMonth('2026', 1)).toBe(currentYearMonth);
      expect(shiftMonth('2026-13', 1)).toBe(currentYearMonth);
      expect(shiftMonth('2026-00', -1)).toBe(currentYearMonth);
    });
  });

  describe('3. getTodayDateString: 取得當地時區 YYYY-MM-DD 字串', () => {
    it('傳入特定 Date 實例時，應正確回傳本地時區 YYYY-MM-DD 格式，月份與日期自動補零', () => {
      const d1 = new Date(2026, 0, 5); // 2026-01-05
      expect(getTodayDateString(d1)).toBe('2026-01-05');

      const d2 = new Date(2026, 10, 8); // 2026-11-08
      expect(getTodayDateString(d2)).toBe('2026-11-08');

      const d3 = new Date(2025, 8, 30); // 2025-09-30
      expect(getTodayDateString(d3)).toBe('2025-09-30');
    });

    it('未傳入參數時，預設回傳當前系統時間對應之 YYYY-MM-DD 字串', () => {
      const now = new Date();
      const expectedYear = now.getFullYear();
      const expectedMonth = String(now.getMonth() + 1).padStart(2, '0');
      const expectedDay = String(now.getDate()).padStart(2, '0');
      const expected = `${expectedYear}-${expectedMonth}-${expectedDay}`;

      expect(getTodayDateString()).toBe(expected);
    });
  });

  describe('4. getCurrentMonthString: 取得當地時區 YYYY-MM 字串', () => {
    it('傳入特定 Date 實例時，應正確回傳本地時區 YYYY-MM 格式，月份自動補零', () => {
      const d1 = new Date(2026, 2, 14); // 2026-03
      expect(getCurrentMonthString(d1)).toBe('2026-03');

      const d2 = new Date(2026, 11, 25); // 2026-12
      expect(getCurrentMonthString(d2)).toBe('2026-12');
    });

    it('未傳入參數時，預設回傳當前系統時間對應之 YYYY-MM 字串', () => {
      const now = new Date();
      const expectedYear = now.getFullYear();
      const expectedMonth = String(now.getMonth() + 1).padStart(2, '0');
      const expected = `${expectedYear}-${expectedMonth}`;

      expect(getCurrentMonthString()).toBe(expected);
    });
  });
});
