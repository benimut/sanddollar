import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from 'vue';
import ReportView from '@/components/ReportView.vue';
import {
  calculateFinancialSummary,
  generateCategoryPieData,
  generateStackedBarData,
  // @ts-ignore - extractAvailableMonths 尚未自 @/utils/report 匯出或實作 (TDD 紅燈階段)
  extractAvailableMonths,
} from '@/utils/report';
import type { ExpenseRecord, IncomeRecord, MonthlyReward } from '@/types';
import * as dateUtils from '@/utils/date';

// Mock Chart.js 實例追蹤陣列
const mockChartInstances: any[] = [];

vi.mock('chart.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  class MockChart {
    static register = vi.fn();
    ctx: any;
    config: any;
    destroy = vi.fn();
    update = vi.fn();
    constructor(ctx: any, config: any) {
      this.ctx = ctx;
      this.config = config;
      mockChartInstances.push(this);
    }
  }
  return {
    ...actual,
    Chart: MockChart,
    default: MockChart,
  };
});

// Mock 資料庫收支與回饋記錄
const mockExpensesData: ExpenseRecord[] = [
  {
    id: 1,
    date: '2024-11-02',
    merchant: '全聯福利中心',
    paymentMethod: '現金',
    totalAmount: 1200,
    isForeign: false,
    items: [
      {
        id: '1',
        type: 'item',
        name: '生活用品',
        quantity: 1,
        unitPrice: 1200,
        subtotal: 1200,
        category: '日常用品',
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  },
];

const mockIncomesData: IncomeRecord[] = [
  {
    id: 1,
    date: '2024-11-05',
    source: '11月薪水',
    account: '玉山銀行',
    category: '薪資',
    amount: 50000,
    isForeign: false,
    createdAt: 2,
    updatedAt: 2,
  },
];

const mockRewardsData: MonthlyReward[] = [
  {
    id: 1,
    yearMonth: '2024-11',
    sourceName: '信用卡回饋',
    amount: 500,
    createdAt: 3,
  },
];

vi.mock('@/db', () => ({
  getExpenses: vi.fn().mockImplementation(() => Promise.resolve(mockExpensesData)),
  getIncomes: vi.fn().mockImplementation(() => Promise.resolve(mockIncomesData)),
  getRewards: vi.fn().mockImplementation(() => Promise.resolve(mockRewardsData)),
  addReward: vi.fn().mockImplementation(() => Promise.resolve(1)),
}));

describe('統計報表數據轉換核心模組 (report utility)', () => {
  // ==========================================
  // 1. 財務摘要計算函式 calculateFinancialSummary
  // ==========================================
  describe('calculateFinancialSummary - 財務核心摘要計算', () => {
    it('當無任何收支與回饋記錄時，應安全回傳各項總和為 0 的財務摘要', () => {
      const summary = calculateFinancialSummary([], [], []);

      expect(summary).toEqual({
        totalIncome: 0,
        totalExpense: 0,
        balance: 0,
      });
    });

    it('僅有收入與回饋時，總進帳應包含收入金額與回饋金額，且結餘等於總進帳', () => {
      const mockIncomes: IncomeRecord[] = [
        {
          date: '2024-11-05',
          source: '11月正職薪資',
          account: '玉山銀行',
          category: '薪資',
          amount: 52000,
          isForeign: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          date: '2024-11-15',
          source: '技術顧問兼職',
          account: 'LINE Bank',
          category: '兼職',
          amount: 15000,
          isForeign: false,
          createdAt: 2,
          updatedAt: 2,
        },
      ];

      const mockRewards: MonthlyReward[] = [
        {
          yearMonth: '2024-11',
          sourceName: '玉山 Pi 點數',
          amount: 650,
          createdAt: 3,
        },
        {
          yearMonth: '2024-11',
          sourceName: 'LINE POINTS',
          amount: 320,
          createdAt: 4,
        },
      ];

      const summary = calculateFinancialSummary([], mockIncomes, mockRewards);

      // 總進帳 = 52000 + 15000 + 650 + 320 = 67970
      expect(summary.totalIncome).toBe(67970);
      expect(summary.totalExpense).toBe(0);
      expect(summary.balance).toBe(67970);
    });

    it('僅有支出記錄時，總進帳為 0，結餘應為負數赤字', () => {
      const mockExpenses: ExpenseRecord[] = [
        {
          date: '2024-11-02',
          merchant: '全聯福利中心',
          paymentMethod: '現金',
          totalAmount: 1250,
          isForeign: false,
          items: [
            {
              id: 'item-1',
              type: 'item',
              name: '鮮奶',
              quantity: 2,
              unitPrice: 90,
              subtotal: 180,
              category: '飲食',
            },
            {
              id: 'item-2',
              type: 'item',
              name: '其他日用品',
              quantity: 1,
              unitPrice: 1070,
              subtotal: 1070,
              category: '日用品',
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
        {
          date: '2024-11-10',
          merchant: '台灣高鐵',
          paymentMethod: '信用卡',
          totalAmount: 2980,
          isForeign: false,
          items: [
            {
              id: 'item-3',
              type: 'item',
              name: '高鐵來回票',
              quantity: 2,
              unitPrice: 1490,
              subtotal: 2980,
              category: '交通',
            },
          ],
          createdAt: 2,
          updatedAt: 2,
        },
      ];

      const summary = calculateFinancialSummary(mockExpenses, [], []);

      // 總支出 = 1250 + 2980 = 4230
      expect(summary.totalIncome).toBe(0);
      expect(summary.totalExpense).toBe(4230);
      expect(summary.balance).toBe(-4230);
    });

    it('綜合收支與回饋計算，應正確計算盈餘 (正數結餘) 與赤字 (負數結餘)', () => {
      const mockIncomes: IncomeRecord[] = [
        {
          date: '2024-11-05',
          source: '薪資',
          account: '玉山銀行',
          category: '薪資',
          amount: 50000,
          isForeign: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ];
      const mockRewards: MonthlyReward[] = [
        {
          yearMonth: '2024-11',
          sourceName: '信用卡回饋',
          amount: 500,
          createdAt: 2,
        },
      ];

      // 情境 A: 收入 > 支出 -> 正結餘 (盈餘)
      const mockExpensesA: ExpenseRecord[] = [
        {
          date: '2024-11-06',
          merchant: '商場',
          paymentMethod: '信用卡',
          totalAmount: 30000,
          isForeign: false,
          items: [],
          createdAt: 3,
          updatedAt: 3,
        },
      ];
      const summaryA = calculateFinancialSummary(mockExpensesA, mockIncomes, mockRewards);
      expect(summaryA.totalIncome).toBe(50500);
      expect(summaryA.totalExpense).toBe(30000);
      expect(summaryA.balance).toBe(20500);

      // 情境 B: 收入 < 支出 -> 負結餘 (赤字)
      const mockExpensesB: ExpenseRecord[] = [
        {
          date: '2024-11-06',
          merchant: '電器行',
          paymentMethod: '信用卡',
          totalAmount: 65000,
          isForeign: false,
          items: [],
          createdAt: 4,
          updatedAt: 4,
        },
      ];
      const summaryB = calculateFinancialSummary(mockExpensesB, mockIncomes, mockRewards);
      expect(summaryB.totalIncome).toBe(50500);
      expect(summaryB.totalExpense).toBe(65000);
      expect(summaryB.balance).toBe(-14500);
    });
  });

  // ==========================================
  // 2. 分類圓餅圖數據轉換函式 generateCategoryPieData
  // ==========================================
  describe('generateCategoryPieData - 收支分類圓餅圖資料轉換', () => {
    it('當無資料時，應回傳安全空資料結構，不應拋出錯誤', () => {
      const expensePie = generateCategoryPieData([], [], 'expense');
      expect(expensePie.labels).toEqual([]);
      expect(expensePie.datasets).toHaveLength(1);
      expect(expensePie.datasets[0].data).toEqual([]);
      expect(expensePie.datasets[0].backgroundColor).toEqual([]);

      const incomePie = generateCategoryPieData([], [], 'income');
      expect(incomePie.labels).toEqual([]);
      expect(incomePie.datasets).toHaveLength(1);
      expect(incomePie.datasets[0].data).toEqual([]);
      expect(incomePie.datasets[0].backgroundColor).toEqual([]);
    });

    it('支出模式 (mode === "expense")：應依品項 (items) 的分類加總金額，並能正確處理折扣項', () => {
      const mockExpenses: ExpenseRecord[] = [
        {
          date: '2024-11-01',
          merchant: '餐廳與咖啡廳',
          paymentMethod: '現金',
          totalAmount: 550,
          isForeign: false,
          items: [
            {
              id: '1',
              type: 'item',
              name: '午餐定食',
              quantity: 1,
              unitPrice: 350,
              subtotal: 350,
              category: '餐飲',
            },
            {
              id: '2',
              type: 'item',
              name: '美式咖啡',
              quantity: 1,
              unitPrice: 200,
              subtotal: 200,
              category: '餐飲',
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
        {
          date: '2024-11-02',
          merchant: '日系服飾店',
          paymentMethod: '信用卡',
          totalAmount: 1800,
          isForeign: false,
          items: [
            {
              id: '3',
              type: 'item',
              name: '羽絨外套',
              quantity: 1,
              unitPrice: 2000,
              subtotal: 2000,
              category: '服飾',
            },
            {
              id: '4',
              type: 'discount',
              name: '週年慶現折',
              quantity: 1,
              unitPrice: -200,
              subtotal: -200,
              category: '服飾',
            },
          ],
          createdAt: 2,
          updatedAt: 2,
        },
        {
          date: '2024-11-03',
          merchant: '捷運站',
          paymentMethod: '悠遊卡',
          totalAmount: 150,
          isForeign: false,
          items: [
            {
              id: '5',
              type: 'item',
              name: '悠遊卡加值',
              quantity: 1,
              unitPrice: 150,
              subtotal: 150,
              category: '交通',
            },
          ],
          createdAt: 3,
          updatedAt: 3,
        },
      ];

      const pieData = generateCategoryPieData(mockExpenses, [], 'expense');

      // 預期分類：餐飲: 350 + 200 = 550；服飾: 2000 - 200 = 1800；交通: 150
      expect(pieData.labels).toContain('餐飲');
      expect(pieData.labels).toContain('服飾');
      expect(pieData.labels).toContain('交通');

      const foodIndex = pieData.labels.indexOf('餐飲');
      const clothingIndex = pieData.labels.indexOf('服飾');
      const trafficIndex = pieData.labels.indexOf('交通');

      expect(pieData.datasets[0].data[foodIndex]).toBe(550);
      expect(pieData.datasets[0].data[clothingIndex]).toBe(1800);
      expect(pieData.datasets[0].data[trafficIndex]).toBe(150);

      // 檢查顏色設定是否與 labels 數量相符
      expect(pieData.datasets[0].backgroundColor).toHaveLength(pieData.labels.length);
      pieData.datasets[0].backgroundColor.forEach((color) => {
        expect(typeof color).toBe('string');
        expect(color.length).toBeGreaterThan(0);
      });
    });

    it('支出模式 (mode === "expense")：當某分類經折扣扣減後淨額小於或等於 0 時，不應出現負值或 0 切片', () => {
      const mockExpenses: ExpenseRecord[] = [
        {
          id: 1,
          date: '2024-11-12',
          merchant: '咖啡廳',
          paymentMethod: '現金',
          totalAmount: 100,
          isForeign: false,
          items: [
            {
              id: 'i1',
              type: 'item',
              name: '拿鐵',
              quantity: 1,
              unitPrice: 150,
              subtotal: 150,
              category: '餐飲',
            },
            {
              id: 'd1',
              type: 'discount',
              name: '折價券',
              quantity: 1,
              unitPrice: -50,
              subtotal: -50,
              category: '其他',
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
      ];

      const pieData = generateCategoryPieData(mockExpenses, [], 'expense');

      expect(pieData.labels).toEqual(['餐飲']);
      expect(pieData.datasets[0].data).toEqual([150]);
      expect(pieData.labels).not.toContain('其他');
    });

    it('收入模式 (mode === "income")：應依收入記錄的 category 加總金額', () => {
      const mockIncomes: IncomeRecord[] = [
        {
          date: '2024-11-05',
          source: '11月薪水',
          account: '玉山銀行',
          category: '薪資',
          amount: 50000,
          isForeign: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          date: '2024-11-10',
          source: '股票股利',
          account: '國泰世華',
          category: '投資',
          amount: 8000,
          isForeign: false,
          createdAt: 2,
          updatedAt: 2,
        },
        {
          date: '2024-11-20',
          source: '季獎金',
          account: '玉山銀行',
          category: '獎金',
          amount: 20000,
          isForeign: false,
          createdAt: 3,
          updatedAt: 3,
        },
        {
          date: '2024-11-25',
          source: '兼職講師費',
          account: '玉山銀行',
          category: '兼職',
          amount: 6000,
          isForeign: false,
          createdAt: 4,
          updatedAt: 4,
        },
        {
          date: '2024-11-28',
          source: '朋友還款',
          account: 'LINE Bank',
          category: '轉帳',
          amount: 3500,
          isForeign: false,
          createdAt: 5,
          updatedAt: 5,
        },
        {
          date: '2024-11-30',
          source: '全勤獎金',
          account: '玉山銀行',
          category: '獎金',
          amount: 3000,
          isForeign: false,
          createdAt: 6,
          updatedAt: 6,
        },
      ];

      const pieData = generateCategoryPieData([], mockIncomes, 'income');

      // 預期分類：
      // 薪資: 50000
      // 投資: 8000
      // 獎金: 20000 + 3000 = 23000
      // 兼職: 6000
      // 轉帳: 3500
      expect(pieData.labels).toContain('薪資');
      expect(pieData.labels).toContain('投資');
      expect(pieData.labels).toContain('獎金');
      expect(pieData.labels).toContain('兼職');
      expect(pieData.labels).toContain('轉帳');

      const salaryIdx = pieData.labels.indexOf('薪資');
      const investIdx = pieData.labels.indexOf('投資');
      const bonusIdx = pieData.labels.indexOf('獎金');
      const partTimeIdx = pieData.labels.indexOf('兼職');
      const transferIdx = pieData.labels.indexOf('轉帳');

      expect(pieData.datasets[0].data[salaryIdx]).toBe(50000);
      expect(pieData.datasets[0].data[investIdx]).toBe(8000);
      expect(pieData.datasets[0].data[bonusIdx]).toBe(23000);
      expect(pieData.datasets[0].data[partTimeIdx]).toBe(6000);
      expect(pieData.datasets[0].data[transferIdx]).toBe(3500);

      // 檢查顏色設定
      expect(pieData.datasets[0].backgroundColor).toHaveLength(5);
    });
  });

  // ==========================================
  // 3. 0 軸正負堆疊長條圖數據轉換函式 generateStackedBarData
  // ==========================================
  describe('generateStackedBarData - 0 軸正負堆疊長條圖資料轉換', () => {
    it('當無任何資料且未指定月份時，應回傳空 labels 與空 datasets', () => {
      const result = generateStackedBarData([], [], []);
      expect(result.labels).toEqual([]);
      expect(result.datasets).toEqual([]);
    });

    it('未指定 months 參數時，應自動從消費、收入與回饋中提取所有月份並依時間升冪排序', () => {
      const mockExpenses: ExpenseRecord[] = [
        {
          date: '2024-11-15',
          merchant: '超市',
          paymentMethod: '現金',
          totalAmount: 500,
          isForeign: false,
          items: [
            {
              id: '1',
              type: 'item',
              name: '用品',
              quantity: 1,
              unitPrice: 500,
              subtotal: 500,
              category: '日用品',
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
      ];

      const mockIncomes: IncomeRecord[] = [
        {
          date: '2024-09-10',
          source: '薪資',
          account: '銀行',
          category: '薪資',
          amount: 40000,
          isForeign: false,
          createdAt: 2,
          updatedAt: 2,
        },
      ];

      const mockRewards: MonthlyReward[] = [
        {
          yearMonth: '2024-10',
          sourceName: '回饋點數',
          amount: 300,
          createdAt: 3,
        },
      ];

      const result = generateStackedBarData(mockExpenses, mockIncomes, mockRewards);

      // 自動推導並排序月份：2024-09, 2024-10, 2024-11
      expect(result.labels).toEqual(['2024-09', '2024-10', '2024-11']);
    });

    it('若有指定 months 參數，應嚴格依照指定月份清單生成 labels，無資料月份數值填 0', () => {
      const mockIncomes: IncomeRecord[] = [
        {
          date: '2024-08-01', // 不在指定月份範圍
          source: '8月獎金',
          account: '銀行',
          category: '獎金',
          amount: 5000,
          isForeign: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          date: '2024-10-05',
          source: '10月薪水',
          account: '銀行',
          category: '薪資',
          amount: 50000,
          isForeign: false,
          createdAt: 2,
          updatedAt: 2,
        },
      ];

      const specifiedMonths = ['2024-10', '2024-11', '2024-12'];
      const result = generateStackedBarData([], mockIncomes, [], specifiedMonths);

      expect(result.labels).toEqual(['2024-10', '2024-11', '2024-12']);

      // 檢查薪資 dataset，應在 2024-10 為 -50000，其餘月份為 0
      const salaryDataset = result.datasets.find((d) => d.label === '薪資');
      expect(salaryDataset).toBeDefined();
      expect(salaryDataset?.data).toEqual([-50000, 0, 0]);
    });

    it('0 軸正負堆疊驗證：支出分類為正數，收入分類與回饋均為負數，且 stack 群組均為 balance', () => {
      const mockExpenses: ExpenseRecord[] = [
        {
          date: '2024-10-02',
          merchant: '餐廳',
          paymentMethod: '現金',
          totalAmount: 1200,
          isForeign: false,
          items: [
            {
              id: '1',
              type: 'item',
              name: '餐點',
              quantity: 1,
              unitPrice: 1200,
              subtotal: 1200,
              category: '餐飲',
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
        {
          date: '2024-10-15',
          merchant: '捷運',
          paymentMethod: '信用卡',
          totalAmount: 800,
          isForeign: false,
          items: [
            {
              id: '2',
              type: 'item',
              name: '定期票',
              quantity: 1,
              unitPrice: 800,
              subtotal: 800,
              category: '交通',
            },
          ],
          createdAt: 2,
          updatedAt: 2,
        },
        {
          date: '2024-11-05',
          merchant: '早午餐',
          paymentMethod: '現金',
          totalAmount: 600,
          isForeign: false,
          items: [
            {
              id: '3',
              type: 'item',
              name: '早餐',
              quantity: 1,
              unitPrice: 600,
              subtotal: 600,
              category: '餐飲',
            },
          ],
          createdAt: 3,
          updatedAt: 3,
        },
      ];

      const mockIncomes: IncomeRecord[] = [
        {
          date: '2024-10-05',
          source: '10月薪資',
          account: '玉山銀行',
          category: '薪資',
          amount: 50000,
          isForeign: false,
          createdAt: 4,
          updatedAt: 4,
        },
        {
          date: '2024-11-05',
          source: '11月薪資',
          account: '玉山銀行',
          category: '薪資',
          amount: 52000,
          isForeign: false,
          createdAt: 5,
          updatedAt: 5,
        },
        {
          date: '2024-11-20',
          source: '業外兼職',
          account: 'LINE Bank',
          category: '兼職',
          amount: 8000,
          isForeign: false,
          createdAt: 6,
          updatedAt: 6,
        },
      ];

      const mockRewards: MonthlyReward[] = [
        {
          yearMonth: '2024-10',
          sourceName: '信用卡回饋',
          amount: 500,
          createdAt: 7,
        },
        {
          yearMonth: '2024-11',
          sourceName: '點數回饋',
          amount: 750,
          createdAt: 8,
        },
      ];

      const months = ['2024-10', '2024-11'];
      const result = generateStackedBarData(mockExpenses, mockIncomes, mockRewards, months);

      expect(result.labels).toEqual(['2024-10', '2024-11']);

      // 所有 dataset 必須帶有 stack: 'balance'
      result.datasets.forEach((ds) => {
        expect(ds.stack).toBe('balance');
      });

      // 檢查支出分類 (餐飲、交通) 數據在 0 軸上方 (正數)
      const foodDs = result.datasets.find((ds) => ds.label === '餐飲');
      expect(foodDs).toBeDefined();
      expect(foodDs?.data).toEqual([1200, 600]);
      foodDs?.data.forEach((val) => {
        expect(val).toBeGreaterThanOrEqual(0);
      });

      const trafficDs = result.datasets.find((ds) => ds.label === '交通');
      expect(trafficDs).toBeDefined();
      expect(trafficDs?.data).toEqual([800, 0]);

      // 檢查收入分類 (薪資、兼職) 數據在 0 軸下方 (負數)
      const salaryDs = result.datasets.find((ds) => ds.label === '薪資');
      expect(salaryDs).toBeDefined();
      expect(salaryDs?.data).toEqual([-50000, -52000]);
      salaryDs?.data.forEach((val) => {
        expect(val).toBeLessThanOrEqual(0);
      });

      const partTimeDs = result.datasets.find((ds) => ds.label === '兼職');
      expect(partTimeDs).toBeDefined();
      expect(partTimeDs?.data).toEqual([0, -8000]);

      // 檢查回饋 dataset 數據在 0 軸下方 (負數)
      // 回饋 label 通常為「回饋」或「每月回饋」
      const rewardDs = result.datasets.find(
        (ds) => ds.label === '每月回饋' || ds.label === '回饋',
      );
      expect(rewardDs).toBeDefined();
      expect(rewardDs?.data).toEqual([-500, -750]);
      rewardDs?.data.forEach((val) => {
        expect(val).toBeLessThanOrEqual(0);
      });
    });
  });

  // ==========================================
  // 4. 月份擷取排序共用輔助函式 extractAvailableMonths
  // ==========================================
  describe('extractAvailableMonths (月份擷取排序輔助函式)', () => {
    /**
     * 測試案例 1：基本去重與來源整合
     * 驗證多來源（支出、收入、回饋）之 YYYY-MM 月份萃取、去重與預設降冪排序 (desc)。
     */
    it('案例 1：基本去重與來源整合 - 能從支出、收入與回饋多來源中正確擷取 YYYY-MM 並去重，且預設依月份降冪排序 (desc)', () => {
      const expenses = [
        { date: '2025-10-15' },
        { date: '2025-10-28' }, // 重複月份 2025-10
        { date: '2025-11-02' },
      ] as ExpenseRecord[];
      const incomes = [
        { date: '2025-09-05' },
        { date: '2025-10-10' }, // 與支出重複月份 2025-10
      ] as IncomeRecord[];
      const rewards = [
        { yearMonth: '2025-11' }, // 與支出重複月份 2025-11
        { yearMonth: '2025-12' },
      ] as MonthlyReward[];

      // @ts-ignore - 執行紅燈調用
      const result = extractAvailableMonths(expenses, incomes, rewards);

      // 預設降冪排序：2025-12, 2025-11, 2025-10, 2025-09
      expect(result).toEqual(['2025-12', '2025-11', '2025-10', '2025-09']);
    });

    /**
     * 測試案例 2：排序方向支援
     * 驗證 order 選項為 'asc'（升冪）與 'desc'（降冪）時的時序排序，跨年度亦維持正確字典序。
     */
    it('案例 2：排序方向支援 - 支援 order="asc" (升冪) 與 order="desc" (降冪)，跨年度時能正確維持時間軸時序', () => {
      const expenses = [
        { date: '2026-02-15' },
        { date: '2025-11-20' },
      ] as ExpenseRecord[];
      const incomes = [
        { date: '2025-12-05' },
        { date: '2026-01-10' },
      ] as IncomeRecord[];

      // 1. 指定 order: 'asc'（由舊至新，時間軸圖表常用）
      // @ts-ignore
      const ascResult = extractAvailableMonths(expenses, incomes, [], { order: 'asc' });
      expect(ascResult).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);

      // 2. 指定 order: 'desc'（由新至舊，下拉選單常用）
      // @ts-ignore
      const descResult = extractAvailableMonths(expenses, incomes, [], { order: 'desc' });
      expect(descResult).toEqual(['2026-02', '2026-01', '2025-12', '2025-11']);
    });

    /**
     * 測試案例 3：額外月份納入支援 (extraMonths)
     * 驗證透過 extraMonths 強制指定當前月份或已選取月份時，能安全整合並進行去重與排序。
     */
    it('案例 3：額外月份納入支援 - 傳入 extraMonths 時能強制納入指定月份，並與既有記錄自動去重與排序', () => {
      const expenses = [
        { date: '2025-08-15' },
        { date: '2025-09-10' },
      ] as ExpenseRecord[];
      const currentMonth = '2025-10';
      const selectedMonth = '2025-09'; // 與 expenses 重複
      const customMonth = '2025-11';

      // @ts-ignore
      const result = extractAvailableMonths(expenses, [], [], {
        order: 'desc',
        extraMonths: [currentMonth, selectedMonth, customMonth, '2025-08'], // 包含重複項
      });

      // 驗證額外月份與記錄月份均正確去重並依降冪排序
      expect(result).toEqual(['2025-11', '2025-10', '2025-09', '2025-08']);
    });

    /**
     * 測試案例 4：邊界空值安全處理
     * 驗證在無參數、空陣列、null、undefined 或陣列內含無效空物件時，系統穩健不拋錯。
     */
    it('案例 4：邊界空值安全處理 - 面對無參數、空陣列、null、undefined 或陣列內含空物件時安全回傳不拋錯', () => {
      // 1. 完全不帶參數
      // @ts-ignore
      expect(extractAvailableMonths()).toEqual([]);

      // 2. 傳入空陣列
      // @ts-ignore
      expect(extractAvailableMonths([], [], [])).toEqual([]);

      // 3. 傳入 null 與 undefined
      // @ts-ignore
      expect(extractAvailableMonths(null, undefined, null)).toEqual([]);

      // 4. 陣列內部包含 null、undefined 或無 date/yearMonth 之空物件
      const dirtyExpenses = [null, undefined, {}, { date: undefined }, { date: '' }] as any;
      const dirtyIncomes = [undefined, { date: null }] as any;
      const dirtyRewards = [{}, { yearMonth: undefined }] as any;
      // @ts-ignore
      expect(extractAvailableMonths(dirtyExpenses, dirtyIncomes, dirtyRewards)).toEqual([]);

      // 5. 無資料記錄但有提供有效 extraMonths 時，應回傳處理後之 extraMonths
      // @ts-ignore
      const withExtraOnly = extractAvailableMonths(null, null, null, {
        extraMonths: ['2025-06', null, undefined, ''],
      });
      expect(withExtraOnly).toEqual(['2025-06']);
    });

    /**
     * 測試案例 5：異常與髒資料格式防禦
     * 驗證嚴格的正則驗證機制，安全過濾非 YYYY-MM 格式、月份超出範圍 (01-12) 及髒資料。
     */
    it('案例 5：異常與髒資料格式防禦 - 能嚴格過濾非 YYYY-MM 格式、畸形月份 (如 2025-13) 與非法字串，保留有效月份', () => {
      const malformedExpenses = [
        { date: 'not-a-date' },
        { date: '2025' },
        { date: '2025/11/01' }, // 非標準連字號格式
        { date: '2025-00-10' }, // 非法月份 00
        { date: '2025-13-10' }, // 非法月份 13
        { date: '2025-14-99' }, // 非法月份 14
        { date: '2025-05-20' }, // 合法有效
        { date: '2025-05-25' }, // 合法有效（同月份重複）
      ] as any;

      const malformedRewards = [
        { yearMonth: 'abc-xyz' },
        { yearMonth: '2025-99' },
        { yearMonth: '2025-06' }, // 合法有效
      ] as any;

      const dirtyExtraMonths = [
        'invalid-month',
        '2025-999',
        null,
        undefined,
        '',
        '   ',
        '2025-07', // 合法有效
      ];

      // @ts-ignore
      const result = extractAvailableMonths(malformedExpenses, [], malformedRewards, {
        extraMonths: dirtyExtraMonths,
        order: 'asc',
      });

      // 預期僅保留有效月份並去重升冪：2025-05, 2025-06, 2025-07
      expect(result).toEqual(['2025-05', '2025-06', '2025-07']);
    });
  });
});

// ==========================================
// 4. ReportView.vue 元件真實圖表與假 SVG 排斥測試
// ==========================================
describe('ReportView.vue - 報表元件圖表動態渲染與假 SVG 排除驗證', () => {
  beforeEach(() => {
    mockChartInstances.length = 0;
    if (typeof HTMLCanvasElement !== 'undefined') {
      HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
        fillRect: vi.fn(),
        clearRect: vi.fn(),
        getImageData: vi.fn(() => ({ data: new Array(4) })),
        putImageData: vi.fn(),
        createImageData: vi.fn(() => []),
        setTransform: vi.fn(),
        drawImage: vi.fn(),
        save: vi.fn(),
        fillText: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        closePath: vi.fn(),
        stroke: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        rotate: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        measureText: vi.fn(() => ({ width: 0 })),
        transform: vi.fn(),
        rect: vi.fn(),
        clip: vi.fn(),
      });
    }
  });

  /**
   * 輔助函式：掛載 ReportView 元件並提供清理機制
   */
  function mountReportView() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = createApp(ReportView);
    const vm = app.mount(container);
    return {
      app,
      vm,
      container,
      cleanup: () => {
        app.unmount();
        container.remove();
      },
    };
  }

  /**
   * 等待所有非同步微任務與定時器完成
   */
  async function flushAsyncWork() {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it('長條圖區塊內應包含真實的 <canvas> 元素，且 DOM 中至少存在 2 個 canvas (圓餅圖與長條圖)', async () => {
    const { container, cleanup } = mountReportView();
    await flushAsyncWork();

    try {
      // 尋找包含「每月收支」標題的卡片區塊
      const allCards = Array.from(container.querySelectorAll('div'));
      const barCard = allCards.find((card) =>
        card.textContent?.includes('每月收支')
      );
      expect(barCard).toBeDefined();

      // 該長條圖卡片區塊內必須存在真實的 <canvas> 元素（非靜態向量 SVG）
      const barCanvas = barCard?.querySelector('canvas');
      expect(barCanvas).not.toBeNull();

      // 整體元件應同時擁有圓餅圖與長條圖兩個 canvas 元素
      const canvases = container.querySelectorAll('canvas');
      expect(canvases.length).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup();
    }
  });

  it('載入收支資料後，renderBarChart 應正確呼叫 Chart.js 初始化 bar 類型與 0 軸堆疊長條圖實例', async () => {
    const { container, cleanup } = mountReportView();
    await flushAsyncWork();

    try {
      // 驗證 Chart.js 實例中是否存在 type: 'bar' 的長條圖實例
      const barChartInstance = mockChartInstances.find(
        (inst) => inst.config?.type === 'bar'
      );
      expect(barChartInstance).toBeDefined();

      // 驗證傳入之長條圖資料與設定符合 0 軸堆疊規格
      expect(barChartInstance.config.data).toBeDefined();
      expect(barChartInstance.config.data.labels).toContain('2024-11');

      // datasets 必須有資料且 stack 為 'balance'
      const datasets = barChartInstance.config.data.datasets;
      expect(datasets.length).toBeGreaterThan(0);
      datasets.forEach((ds: any) => {
        expect(ds.stack).toBe('balance');
      });

      // 驗證 x 與 y 軸尺度皆設定為 stacked: true
      expect(barChartInstance.config.options?.scales?.x?.stacked).toBe(true);
      expect(barChartInstance.config.options?.scales?.y?.stacked).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('當組件多次更新載入資料時，既有長條圖實例應被安全銷毀 (destroy) 以防止重複堆疊與記憶體洩漏', async () => {
    const { container, cleanup } = mountReportView();
    await flushAsyncWork();

    try {
      // 第一次載入應產生長條圖實例
      const initialBarChart = mockChartInstances.find(
        (inst) => inst.config?.type === 'bar'
      );
      expect(initialBarChart).toBeDefined();

      // 透過黑盒操作：點擊「近3月」區間篩選按鈕觸發長條圖重新載入與重繪
      const rangeBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.textContent?.includes('近3月')
      );
      if (rangeBtn) {
        rangeBtn.click();
        await flushAsyncWork();
        expect(initialBarChart.destroy).toHaveBeenCalled();
      }
    } finally {
      cleanup();
    }
  });

  describe('規格 v1.4: ReportView 本地時區防護 (Timezone Safeguard)', () => {
    it('在跨月邊界的清晨時區下，ReportView 財務摘要預設選中月份應為本地時區年月而非 UTC 年月', async () => {
      // 模擬跨月邊界：本地時間 (台灣 GMT+8) 為 2026-11-01 02:30:00，此時 UTC 為 2026-10-31 18:30:00 (10月份)
      // 若誤用 new Date().toISOString().slice(0, 7) 會誤取得 2026-10
      // 規格要求必須依本地時區採用 2026-11 (getCurrentMonthString())
      const fakeDate = new Date('2026-11-01T02:30:00+08:00');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(fakeDate);

      const expectedLocalMonth = `${fakeDate.getFullYear()}-${String(fakeDate.getMonth() + 1).padStart(2, '0')}`; // '2026-11'

      try {
        const { container, cleanup } = mountReportView();
        await flushAsyncWork();

        try {
          const monthSelect = container.querySelector<HTMLSelectElement>('#summary-month-select');
          expect(monthSelect, '應存在 #summary-month-select 財務摘要月份選單').not.toBeNull();
          expect(
            monthSelect?.value,
            'ReportView 財務摘要月份選單預設值應為本地時區年月 (2026-11)，不得因 UTC 跨月偏差誤為 2026-10'
          ).toBe(expectedLocalMonth);
        } finally {
          cleanup();
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('規格 v1.5: 報表快速月份區間調用時區模組 (ReportView Quick Range ShiftMonth)', () => {
    it('點擊「近3月」快選按鈕時，起訖月份區間正確設置為當前月份及其前 2 個月，且透過 shiftMonth 運算以避免時區月差', async () => {
      // 模擬特定時間：2026-03-15
      const fakeDate = new Date('2026-03-15T12:00:00+08:00');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(fakeDate);

      const shiftMonthSpy = vi.spyOn(dateUtils, 'shiftMonth');

      try {
        const { container, cleanup } = mountReportView();
        await flushAsyncWork();

        try {
          // 取得「近3月」快選按鈕
          const quickRangeBtns = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
          const btn3Months = quickRangeBtns.find(
            (b) => b.textContent?.trim() === '近3月' || b.textContent?.trim() === '近3個月'
          );
          expect(btn3Months, '應存在「近3月」快選按鈕').toBeDefined();

          // 點擊「近3月」按鈕
          btn3Months!.click();
          await flushAsyncWork();

          // 1. 驗證調用了 shiftMonth 來計算月份區間 (當前月份 2026-03，往前推 2 個月)
          expect(
            shiftMonthSpy,
            '點擊「近3月」快選按鈕時，應調用 shiftMonth 進行時區安全之月份位移運算'
          ).toHaveBeenCalledWith('2026-03', -2);

          // 2. 驗證起訖月份輸入框 DOM 數值
          const startMonthInput = container.querySelector<HTMLInputElement>('#report-start-month');
          const endMonthInput = container.querySelector<HTMLInputElement>('#report-end-month');

          expect(endMonthInput?.value, '結束月份應正確設置為當前月份 2026-03').toBe('2026-03');
          expect(startMonthInput?.value, '起始月份應正確設置為當前月份前 2 個月 2026-01').toBe('2026-01');
        } finally {
          cleanup();
        }
      } finally {
        shiftMonthSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });
});

