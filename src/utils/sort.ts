/**
 * @file sort.ts
 * @description Sanddollar 全域排序工具模組
 * 提供繁體中文與英數字自然文字排序（Natural Sort）及收支明細依日期與寫入順序降冪排序函式。
 */

/**
 * 繁體中文自然文字排序比較器（支援數字自然順序，例如 "項目2" 排於 "項目10" 之前）
 */
const naturalCollator = new Intl.Collator('zh-Hant', {
  numeric: true,
  sensitivity: 'base',
});

/**
 * 自然文字比較函式（升冪）
 *
 * @param a - 第一個比較字串
 * @param b - 第二個比較字串
 * @returns 負數表示 a 在前，正數表示 b 在前，0 表示相等
 */
export function naturalCompare(a: string, b: string): number {
  return naturalCollator.compare(a ?? '', b ?? '');
}

/**
 * 將字串陣列依自然文字順序升冪排序（回傳新陣列，不變動原陣列）
 *
 * @param list - 原始字串陣列
 * @returns 排序後的新字串陣列
 */
export function sortStringsNaturally(list: readonly string[]): string[] {
  return [...list].sort(naturalCompare);
}

/**
 * 將包含 name 屬性的物件陣列依 name 進行自然文字升冪排序（回傳新陣列，不變動原陣列）
 *
 * @param list - 原始物件陣列
 * @returns 排序後的新物件陣列
 */
export function sortByNameNaturally<T extends { name: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => naturalCompare(a.name, b.name));
}

/**
 * 具備日期或年月與寫入順序欄位之記錄介面
 */
export interface DateSortableRecord {
  date?: string;
  yearMonth?: string;
  createdAt?: number;
  id?: number;
}

/**
 * 收支明細排序比較函式：
 * 1. 優先依日期（date 或 yearMonth）由新到舊（降冪）排序
 * 2. 日期相同時，依寫入時間（createdAt）由後到前（降冪）排序
 * 3. 若寫入時間亦相同或缺失，依主鍵 id 由大到小（降冪）排序
 *
 * @param a - 第一筆明細記錄
 * @param b - 第二筆明細記錄
 * @returns 負數表示 a 在前，正數表示 b 在前，0 表示相等
 */
export function compareByDateAndCreatedDesc<T extends DateSortableRecord>(a: T, b: T): number {
  const dateA = a.date ?? a.yearMonth ?? '';
  const dateB = b.date ?? b.yearMonth ?? '';

  if (dateA !== dateB) {
    return dateB.localeCompare(dateA);
  }

  const createdDiff = (b.createdAt ?? 0) - (a.createdAt ?? 0);
  if (createdDiff !== 0) {
    return createdDiff;
  }

  return (b.id ?? 0) - (a.id ?? 0);
}
