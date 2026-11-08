/**
 * @file date.ts
 * @description Sanddollar 日期與月份計算處理工具模組
 * 提供月份格式化與跨年度月份位移運算，封裝日期計算細節，消除 Primitive Obsession。
 */

/**
 * 將 Date 物件格式化為 'YYYY-MM' 月份字串
 *
 * @param date - 選填之 Date 物件，預設為當前時間
 * @returns 'YYYY-MM' 格式字串，例如 '2026-11'
 */
export function formatYearMonth(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * 取得指定 Date 或當前本地時區之 'YYYY-MM-DD' 日期字串
 * 避免使用 toISOString() 導致在台灣 (UTC+8) 清晨時產生日期跨日偏差
 *
 * @param date - 選填之 Date 物件，預設為當前時間
 * @returns 'YYYY-MM-DD' 格式之日期字串，例如 '2026-11-08'
 */
export function getTodayDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 取得指定 Date 或當前本地時區之 'YYYY-MM' 月份字串
 *
 * @param date - 選填之 Date 物件，預設為當前時間
 * @returns 'YYYY-MM' 格式之月份字串，例如 '2026-11'
 */
export function getCurrentMonthString(date: Date = new Date()): string {
  return formatYearMonth(date);
}

/**
 * 依位移量計算目標月份字串
 * 支援跨年度位移與多年份偏移，若輸入格式不合則安全回退為當前月份
 *
 * @param yearMonth - 基準月份字串，格式為 'YYYY-MM'
 * @param offset - 月份位移量 (例如 -1 為上一月，1 為下一月，-12 為前一年同月)
 * @returns 計算後之 'YYYY-MM' 字串
 */
export function shiftMonth(yearMonth: string, offset: number): string {
  if (!yearMonth || typeof yearMonth !== 'string') {
    return formatYearMonth();
  }

  const parts = yearMonth.trim().split('-');
  if (parts.length !== 2) {
    return formatYearMonth();
  }

  const year = Number(parts[0]);
  const month = Number(parts[1]);

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return formatYearMonth();
  }

  // 利用 Date 物件的月份溢位特性處理跨年與多年份位移
  // 注意：Date 的月份為 0-based，因此傳入 month - 1 + offset
  const targetDate = new Date(year, month - 1 + offset, 1);
  return formatYearMonth(targetDate);
}
