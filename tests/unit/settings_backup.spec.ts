/**
 * @file settings_backup.spec.ts
 * @description 備份與還原工具層（切片 2：支援 incomeSources 與 rewardSources 匯出、還原與向下相容）單元測試
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TrackerDatabase } from '@/db';
import { exportBackupData, importBackupData } from '@/utils/backup';
import type { IncomeSourceRecord, RewardSourceRecord } from '@/types';

describe('備份與還原工具層 - 收入來源與回饋來源擴充 (settings_backup.spec.ts)', () => {
  let testDb: TrackerDatabase;

  beforeEach(async () => {
    // 每個測試獨立建立專屬資料庫實例，並清空資料表確保隔離性
    testDb = new TrackerDatabase(`test_settings_backup_${Date.now()}_${Math.random()}`);
    await testDb.open();
    if (testDb.expenses) await testDb.expenses.clear();
    if (testDb.incomes) await testDb.incomes.clear();
    if (testDb.rewards) await testDb.rewards.clear();
    if (testDb.categories) await testDb.categories.clear();
    if (testDb.paymentMethods) await testDb.paymentMethods.clear();
    if (testDb.incomeSources) await testDb.incomeSources.clear();
    if (testDb.rewardSources) await testDb.rewardSources.clear();
  });

  afterEach(async () => {
    if (testDb) {
      await testDb.delete();
    }
  });

  describe('匯出測試 (exportBackupData)', () => {
    it('匯出的 JSON 物件 data 必須包含 incomeSources 與 rewardSources 陣列', async () => {
      const json = await exportBackupData(testDb);
      const parsed = JSON.parse(json);

      expect(parsed).toHaveProperty('data');
      expect(parsed.data).toHaveProperty('incomeSources');
      expect(Array.isArray(parsed.data.incomeSources)).toBe(true);
      expect(parsed.data).toHaveProperty('rewardSources');
      expect(Array.isArray(parsed.data.rewardSources)).toBe(true);
    });

    it('匯出內容應正確包含已新增之自訂收入來源與回饋來源記錄', async () => {
      const customIncomeSource: IncomeSourceRecord = {
        name: '自由接案外包',
        isDefault: false,
      };
      const customRewardSource: RewardSourceRecord = {
        name: '信用卡現金回饋折抵',
        isDefault: false,
      };

      await testDb.incomeSources.add(customIncomeSource);
      await testDb.rewardSources.add(customRewardSource);

      const json = await exportBackupData(testDb);
      const parsed = JSON.parse(json);

      expect(parsed.data.incomeSources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: '自由接案外包', isDefault: false }),
        ])
      );
      expect(parsed.data.rewardSources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: '信用卡現金回饋折抵', isDefault: false }),
        ])
      );
    });
  });

  describe('還原測試 (importBackupData)', () => {
    describe('覆寫模式 (overwrite)', () => {
      it('應清空既有 incomeSources 與 rewardSources，並匯入備份中的新項目', async () => {
        // 預先寫入既有舊資料
        await testDb.incomeSources.add({ name: '舊薪資帳戶', isDefault: false });
        await testDb.rewardSources.add({ name: '舊點數平台', isDefault: false });

        const backupData = {
          version: 1,
          exportedAt: new Date().toISOString(),
          data: {
            expenses: [],
            incomes: [],
            rewards: [],
            categories: [],
            paymentMethods: [],
            incomeSources: [
              { name: '新公司薪資', isDefault: true },
              { name: '股利發放', isDefault: false },
            ],
            rewardSources: [
              { name: '玉山 Pi 點數', isDefault: true },
              { name: 'LINE POINTS', isDefault: false },
            ],
          },
        };

        const result = await importBackupData(JSON.stringify(backupData), 'overwrite', testDb);

        expect(result.success).toBe(true);

        const currentIncomeSources = await testDb.incomeSources.toArray();
        expect(currentIncomeSources).toHaveLength(2);
        expect(currentIncomeSources.map((s) => s.name)).toEqual(
          expect.arrayContaining(['新公司薪資', '股利發放'])
        );
        expect(currentIncomeSources.some((s) => s.name === '舊薪資帳戶')).toBe(false);

        const currentRewardSources = await testDb.rewardSources.toArray();
        expect(currentRewardSources).toHaveLength(2);
        expect(currentRewardSources.map((s) => s.name)).toEqual(
          expect.arrayContaining(['玉山 Pi 點數', 'LINE POINTS'])
        );
        expect(currentRewardSources.some((s) => s.name === '舊點數平台')).toBe(false);
      });
    });

    describe('追加模式 (merge)', () => {
      it('應保留既有記錄，並將新項目去重追加至 incomeSources 與 rewardSources（同名項目不重複新增）', async () => {
        // 預先寫入既有資料
        await testDb.incomeSources.add({ name: '基本工資', isDefault: true });
        await testDb.rewardSources.add({ name: '信用卡紅利', isDefault: true });

        const backupData = {
          version: 1,
          exportedAt: new Date().toISOString(),
          data: {
            expenses: [],
            incomes: [],
            rewards: [],
            categories: [],
            paymentMethods: [],
            incomeSources: [
              { name: '基本工資', isDefault: true }, // 重複項目，不應新增
              { name: '年終獎金', isDefault: false }, // 新項目，應追加
            ],
            rewardSources: [
              { name: '信用卡紅利', isDefault: true }, // 重複項目，不應新增
              { name: '街口幣', isDefault: false }, // 新項目，應追加
            ],
          },
        };

        const result = await importBackupData(JSON.stringify(backupData), 'merge', testDb);

        expect(result.success).toBe(true);

        const currentIncomeSources = await testDb.incomeSources.toArray();
        expect(currentIncomeSources).toHaveLength(2);
        expect(currentIncomeSources.map((s) => s.name)).toEqual(
          expect.arrayContaining(['基本工資', '年終獎金'])
        );

        const currentRewardSources = await testDb.rewardSources.toArray();
        expect(currentRewardSources).toHaveLength(2);
        expect(currentRewardSources.map((s) => s.name)).toEqual(
          expect.arrayContaining(['信用卡紅利', '街口幣'])
        );
      });
    });

    describe('向下相容舊版備份測試', () => {
      it('若備份 JSON 的 data 缺少 incomeSources 或 rewardSources，應正常還原成功（不報錯），缺少的表格維持安全相容處理', async () => {
        // 舊版備份格式完全不包含 incomeSources 與 rewardSources 欄位
        const legacyBackupData = {
          version: 1,
          exportedAt: new Date().toISOString(),
          data: {
            expenses: [],
            incomes: [],
            rewards: [],
            categories: [],
            paymentMethods: [],
          },
        };

        const result = await importBackupData(JSON.stringify(legacyBackupData), 'overwrite', testDb);
        expect(result.success).toBe(true);

        // 僅缺少 incomeSources 但有 rewardSources
        const partialBackupWithoutIncomeSources = {
          version: 1,
          exportedAt: new Date().toISOString(),
          data: {
            expenses: [],
            incomes: [],
            rewards: [],
            categories: [],
            paymentMethods: [],
            rewardSources: [{ name: 'LINE POINTS', isDefault: true }],
          },
        };

        const resultPartial1 = await importBackupData(
          JSON.stringify(partialBackupWithoutIncomeSources),
          'overwrite',
          testDb
        );
        expect(resultPartial1.success).toBe(true);
        const rewardSourcesAfterPartial1 = await testDb.rewardSources.toArray();
        expect(rewardSourcesAfterPartial1.map((s) => s.name)).toContain('LINE POINTS');

        // 僅缺少 rewardSources 但有 incomeSources
        const partialBackupWithoutRewardSources = {
          version: 1,
          exportedAt: new Date().toISOString(),
          data: {
            expenses: [],
            incomes: [],
            rewards: [],
            categories: [],
            paymentMethods: [],
            incomeSources: [{ name: '兼職打工', isDefault: false }],
          },
        };

        const resultPartial2 = await importBackupData(
          JSON.stringify(partialBackupWithoutRewardSources),
          'overwrite',
          testDb
        );
        expect(resultPartial2.success).toBe(true);
        const incomeSourcesAfterPartial2 = await testDb.incomeSources.toArray();
        expect(incomeSourcesAfterPartial2.map((s) => s.name)).toContain('兼職打工');
      });
    });

    describe('格式錯誤測試', () => {
      it('若 data.incomeSources 存在但型態不是陣列，應回傳 success: false 與格式錯誤訊息', async () => {
        const invalidData = {
          version: 1,
          exportedAt: new Date().toISOString(),
          data: {
            expenses: [],
            incomes: [],
            rewards: [],
            categories: [],
            paymentMethods: [],
            incomeSources: 'this-is-not-an-array',
          },
        };

        const result = await importBackupData(JSON.stringify(invalidData), 'overwrite', testDb);

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.error).toMatch(/incomeSources.*陣列/i);
      });

      it('若 data.rewardSources 存在但型態不是陣列，應回傳 success: false 與格式錯誤訊息', async () => {
        const invalidData = {
          version: 1,
          exportedAt: new Date().toISOString(),
          data: {
            expenses: [],
            incomes: [],
            rewards: [],
            categories: [],
            paymentMethods: [],
            rewardSources: { key: 'not-an-array' },
          },
        };

        const result = await importBackupData(JSON.stringify(invalidData), 'overwrite', testDb);

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.error).toMatch(/rewardSources.*陣列/i);
      });
    });
  });
});
