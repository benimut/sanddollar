/**
 * @file sort.spec.ts
 * @description Sanddollar 排序工具模組單元測試
 */

import { describe, it, expect } from 'vitest';
import {
  naturalCompare,
  sortStringsNaturally,
  sortByNameNaturally,
  compareByDateAndCreatedDesc,
} from '@/utils/sort';

describe('sort.ts 排序工具單元測試', () => {
  describe('naturalCompare 與 sortStringsNaturally 自然文字排序', () => {
    it('應依自然數字順序排列含數字之字串（項目2 應在 項目10 之前）', () => {
      const input = ['項目10', '項目2', '項目1', '項目20'];
      const sorted = sortStringsNaturally(input);
      expect(sorted).toEqual(['項目1', '項目2', '項目10', '項目20']);
      // 確認未修改原陣列
      expect(input).toEqual(['項目10', '項目2', '項目1', '項目20']);
    });

    it('應支援英文大小寫不敏感與數字混合排序', () => {
      const input = ['Card10', 'card2', 'Apple', 'banana'];
      const sorted = sortStringsNaturally(input);
      expect(sorted).toEqual(['Apple', 'banana', 'card2', 'Card10']);
    });

    it('應能穩定比較繁體中文名詞', () => {
      const a = '餐飲';
      const b = '交通';
      expect(naturalCompare(a, a)).toBe(0);
      expect(naturalCompare(a, b)).toBe(-naturalCompare(b, a));
    });
  });

  describe('sortByNameNaturally 物件名稱自然排序', () => {
    it('應依 name 欄位進行自然文字排序並保留其他欄位', () => {
      const items = [
        { id: 1, name: '卡片10' },
        { id: 2, name: '卡片2' },
        { id: 3, name: '現金' },
      ];
      const sorted = sortByNameNaturally(items);
      expect(sorted.map((x) => x.name)).toEqual(['卡片2', '卡片10', '現金']);
    });
  });

  describe('compareByDateAndCreatedDesc 明細日期與寫入順序降冪排序', () => {
    it('應依日期由新到舊排序，日期相同時依寫入時間由後到前排序', () => {
      const records = [
        { id: 1, date: '2026-11-01', createdAt: 1000 },
        { id: 2, date: '2026-11-05', createdAt: 2000 },
        { id: 3, date: '2026-11-05', createdAt: 3000 },
        { id: 4, date: '2026-11-03', createdAt: 4000 },
      ];
      const sorted = [...records].sort(compareByDateAndCreatedDesc);
      expect(sorted.map((r) => r.id)).toEqual([3, 2, 4, 1]);
    });

    it('當日期與 createdAt 皆相同時，應依 id 由大到小排序（後寫入在前）', () => {
      const records = [
        { id: 10, date: '2026-11-05', createdAt: 5000 },
        { id: 12, date: '2026-11-05', createdAt: 5000 },
        { id: 11, date: '2026-11-05', createdAt: 5000 },
      ];
      const sorted = [...records].sort(compareByDateAndCreatedDesc);
      expect(sorted.map((r) => r.id)).toEqual([12, 11, 10]);
    });

    it('支援回饋記錄以 yearMonth 欄位與寫入順序降冪排序', () => {
      const rewards = [
        { id: 1, yearMonth: '2026-11', createdAt: 1000 },
        { id: 2, yearMonth: '2026-11', createdAt: 3000 },
        { id: 3, yearMonth: '2026-11', createdAt: 2000 },
      ];
      const sorted = [...rewards].sort(compareByDateAndCreatedDesc);
      expect(sorted.map((r) => r.id)).toEqual([2, 3, 1]);
    });
  });
});
