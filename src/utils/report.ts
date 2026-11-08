/**
 * @file report.ts
 * @description Sanddollar 財務報表與視覺化圖表資料轉換核心模組
 * 提供財務摘要統計 (calculateFinancialSummary)、分類圓餅圖資料轉換 (generateCategoryPieData)
 * 以及 0 軸上下堆疊長條圖資料集產生 (generateStackedBarData)，嚴格保證型別安全與防禦性邊界處理。
 */

import type { ExpenseRecord, IncomeRecord, MonthlyReward, FinancialSummary } from '@/types';

/**
 * 分類圓餅圖回傳資料結構
 */
export interface CategoryPieChartData {
  labels: string[];
  datasets: Array<{
    data: number[];
    backgroundColor: string[];
  }>;
}

/**
 * 堆疊長條圖資料集結構
 */
export interface StackedBarDataset {
  label: string;
  data: number[];
  backgroundColor: string;
  stack: string;
}

/**
 * 堆疊長條圖回傳資料結構
 */
export interface StackedBarChartData {
  labels: string[];
  datasets: StackedBarDataset[];
}

/**
 * 擷取月份設定選項
 */
export interface ExtractMonthsOptions {
  /** 排序方向：'asc' 升冪（舊至新）或 'desc' 降冪（新至舊），預設為 'desc' */
  order?: 'asc' | 'desc';
  /** 強制納入之額外月份清單（如當前月份或已選取月份） */
  extraMonths?: (string | null | undefined)[];
}

/**
 * 合法月份正規表達式：符合 YYYY-MM (01-12) 格式，允許後面銜接日期 (-DD) 或時間戳記
 */
const VALID_MONTH_REGEX = /^(\d{4}-(?:0[1-9]|1[0-2]))(?:$|[-T\s])/;

/**
 * 解析並正規化月份字串，若符合 YYYY-MM 格式則回傳，否則回傳 null
 * 
 * @param value 欲檢查的日期或月份值
 * @returns 正規化之 YYYY-MM 字串或 null
 */
function parseValidYearMonth(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  const match = trimmed.match(VALID_MONTH_REGEX);
  return match ? match[1] : null;
}

/**
 * 擷取並排序可用月份集合 (YYYY-MM)
 * 
 * 從消費支出記錄、收入記錄、每月回饋記錄與額外指定月份清單中，
 * 萃取有效符合 YYYY-MM 格式之不重複月份集合，並依指定方向進行排序。
 * 
 * @param expenses 消費支出記錄列表（選填）
 * @param incomes 收入記錄列表（選填）
 * @param rewards 每月回饋記錄列表（選填）
 * @param options 選項設定（包含 order 與 extraMonths）
 * @returns 排序後之不重複有效月份字串陣列 (YYYY-MM)
 */
export function extractAvailableMonths(
  expenses?: Array<{ date?: string } | null | undefined> | null,
  incomes?: Array<{ date?: string } | null | undefined> | null,
  rewards?: Array<{ yearMonth?: string } | null | undefined> | null,
  options?: ExtractMonthsOptions
): string[] {
  const monthSet = new Set<string>();

  // 1. 萃取消費記錄之月份
  if (Array.isArray(expenses)) {
    for (const exp of expenses) {
      if (exp && exp.date) {
        const ym = parseValidYearMonth(exp.date);
        if (ym) {
          monthSet.add(ym);
        }
      }
    }
  }

  // 2. 萃取收入記錄之月份
  if (Array.isArray(incomes)) {
    for (const inc of incomes) {
      if (inc && inc.date) {
        const ym = parseValidYearMonth(inc.date);
        if (ym) {
          monthSet.add(ym);
        }
      }
    }
  }

  // 3. 萃取每月回饋記錄之月份
  if (Array.isArray(rewards)) {
    for (const rew of rewards) {
      if (rew && rew.yearMonth) {
        const ym = parseValidYearMonth(rew.yearMonth);
        if (ym) {
          monthSet.add(ym);
        }
      }
    }
  }

  // 4. 處理額外指定之月份清單 (extraMonths)
  if (Array.isArray(options?.extraMonths)) {
    for (const m of options.extraMonths) {
      const ym = parseValidYearMonth(m);
      if (ym) {
        monthSet.add(ym);
      }
    }
  }

  // 5. 排序處理：預設為降冪 (desc)，若指定 'asc' 則為升冪
  const order = options?.order ?? 'desc';
  const result = Array.from(monthSet);
  result.sort((a, b) => (order === 'asc' ? a.localeCompare(b) : b.localeCompare(a)));

  return result;
}


/**
 * 預設調色盤（提供充足色彩以供圖表輪替使用）
 */
const DEFAULT_PALETTE: string[] = [
  '#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F',
  '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC',
  '#2E7D32', '#0288D1', '#7B1FA2', '#F57C00', '#C2185B',
  '#00796B', '#512DA8', '#689F38', '#E64A19', '#455A64'
];

/**
 * 取得指定索引的顏色（支援超過調色盤長度時輪替）
 * @param index 索引值
 * @returns 顏色 Hex 字串
 */
function getColor(index: number): string {
  return DEFAULT_PALETTE[index % DEFAULT_PALETTE.length];
}

/**
 * 計算財務核心摘要（總收入、總支出、結餘）
 * 
 * 支援依指定月份 (targetMonth) 精準篩選當月數據：
 * - 當傳入 targetMonth 時，僅統計該月份之支出、收入與回饋記錄
 * - 當未傳入 targetMonth 或傳入空字串時，維持全量加總以 100% 向下相容
 * 
 * @param expenses 消費支出記錄列表
 * @param incomes 收入記錄列表
 * @param rewards 每月回饋記錄列表
 * @param targetMonth 目標篩選月份 (選填，格式 YYYY-MM，如 '2024-11')
 * @returns 財務摘要物件 (totalIncome, totalExpense, balance)
 */
export function calculateFinancialSummary(
  expenses: ExpenseRecord[],
  incomes: IncomeRecord[],
  rewards: MonthlyReward[],
  targetMonth?: string
): FinancialSummary {
  // 正規化 targetMonth 參數（去除前後空白）
  const monthFilter = targetMonth?.trim();
  const hasMonthFilter = Boolean(monthFilter && monthFilter.length > 0);

  // 1. 篩選消費支出記錄 (ExpenseRecord.date 為 YYYY-MM-DD 格式)
  const targetExpenses = hasMonthFilter
    ? (expenses || []).filter((exp) => typeof exp?.date === 'string' && exp.date.startsWith(monthFilter!))
    : (expenses || []);

  // 2. 篩選收入記錄 (IncomeRecord.date 為 YYYY-MM-DD 格式)
  const targetIncomes = hasMonthFilter
    ? (incomes || []).filter((inc) => typeof inc?.date === 'string' && inc.date.startsWith(monthFilter!))
    : (incomes || []);

  // 3. 篩選每月回饋記錄 (注意：MonthlyReward 欄位為 yearMonth，格式為 YYYY-MM)
  const targetRewards = hasMonthFilter
    ? (rewards || []).filter((rew) => typeof rew?.yearMonth === 'string' && rew.yearMonth.startsWith(monthFilter!))
    : (rewards || []);

  // 計算總支出：加總目標消費記錄的 totalAmount (防禦性處理 null/undefined/NaN)
  const totalExpense = targetExpenses.reduce((sum, exp) => sum + (Number(exp?.totalAmount) || 0), 0);

  // 計算總進帳：加總目標收入記錄的 amount 與回饋記錄的 amount
  const incomeSum = targetIncomes.reduce((sum, inc) => sum + (Number(inc?.amount) || 0), 0);
  const rewardSum = targetRewards.reduce((sum, rew) => sum + (Number(rew?.amount) || 0), 0);
  const totalIncome = incomeSum + rewardSum;

  // 計算結餘：總進帳 - 總支出
  const balance = totalIncome - totalExpense;

  return {
    totalIncome: Number.isNaN(totalIncome) ? 0 : totalIncome,
    totalExpense: Number.isNaN(totalExpense) ? 0 : totalExpense,
    balance: Number.isNaN(balance) ? 0 : balance,
  };
}

/**
 * 產生收支分類圓餅圖資料
 * 
 * @param expenses 消費支出記錄列表
 * @param incomes 收入記錄列表
 * @param mode 圖表模式：'expense' (支出) 或 'income' (收入)
 * @returns 圓餅圖所需 labels 與 datasets 結構
 */
export function generateCategoryPieData(
  expenses: ExpenseRecord[],
  incomes: IncomeRecord[],
  mode: 'expense' | 'income'
): CategoryPieChartData {
  const categoryMap = new Map<string, number>();

  if (mode === 'expense') {
    // 統計支出品項分類加總
    for (const exp of expenses) {
      if (!exp.items || exp.items.length === 0) {
        continue;
      }
      for (const item of exp.items) {
        const cat = item.category?.trim() || '未分類';
        const currentAmount = categoryMap.get(cat) || 0;
        categoryMap.set(cat, currentAmount + (item.subtotal || 0));
      }
    }
  } else {
    // 統計收入分類加總
    for (const inc of incomes) {
      const cat = inc.category?.trim() || '其他';
      const currentAmount = categoryMap.get(cat) || 0;
      categoryMap.set(cat, currentAmount + (inc.amount || 0));
    }
  }

  // 取得不重複的分類名稱清單
  const labels = Array.from(categoryMap.keys());
  const data: number[] = [];
  const backgroundColor: string[] = [];

  labels.forEach((label, index) => {
    data.push(categoryMap.get(label) || 0);
    backgroundColor.push(getColor(index));
  });

  return {
    labels,
    datasets: [
      {
        data,
        backgroundColor,
      },
    ],
  };
}

/**
 * 產生 0 軸正負堆疊長條圖資料
 * - 支出分類呈現為正數 (0 軸上方)
 * - 收入分類與回饋呈現為負數 (0 軸下方)
 * - 所有 dataset 的 stack 均為 'balance'
 * 
 * @param expenses 消費支出記錄列表
 * @param incomes 收入記錄列表
 * @param rewards 每月回饋記錄列表
 * @param months 指定月份清單 (選填，格式 YYYY-MM)
 * @returns 堆疊長條圖所需 labels 與 datasets 結構
 */
export function generateStackedBarData(
  expenses: ExpenseRecord[],
  incomes: IncomeRecord[],
  rewards: MonthlyReward[],
  months?: string[]
): StackedBarChartData {
  // 若有外部指定月份，依指定清單生成；未指定時自動擷取不重複月份並升冪排序
  const targetMonths: string[] = (months && months.length > 0)
    ? [...months]
    : extractAvailableMonths(expenses, incomes, rewards, { order: 'asc' });

  // 若無任何月份，回傳安全空結構
  if (targetMonths.length === 0) {
    return {
      labels: [],
      datasets: [],
    };
  }

  const datasets: StackedBarDataset[] = [];
  let colorIndex = 0;

  // 1. 收集並統計所有支出分類 (依月份加總 item.subtotal 為正數)
  const expenseCategories = new Set<string>();
  for (const exp of expenses) {
    if (exp.items) {
      for (const item of exp.items) {
        const cat = item.category?.trim() || '未分類';
        expenseCategories.add(cat);
      }
    }
  }

  for (const cat of expenseCategories) {
    const monthData = targetMonths.map((m) => {
      // 篩選屬於該月份的消費記錄
      const matchingExpenses = expenses.filter((e) => e.date?.startsWith(m));
      let sum = 0;
      for (const exp of matchingExpenses) {
        if (exp.items) {
          for (const item of exp.items) {
            if ((item.category?.trim() || '未分類') === cat) {
              sum += item.subtotal || 0;
            }
          }
        }
      }
      return sum;
    });

    datasets.push({
      label: cat,
      data: monthData,
      backgroundColor: getColor(colorIndex++),
      stack: 'balance',
    });
  }

  // 2. 收集並統計所有收入分類 (依月份加總 income.amount 為負數 <= 0)
  const incomeCategories = new Set<string>();
  for (const inc of incomes) {
    const cat = inc.category?.trim() || '其他';
    incomeCategories.add(cat);
  }

  for (const cat of incomeCategories) {
    const monthData = targetMonths.map((m) => {
      // 篩選屬於該月份的收入記錄
      const matchingIncomes = incomes.filter(
        (inc) => inc.date?.startsWith(m) && (inc.category?.trim() || '其他') === cat
      );
      const sum = matchingIncomes.reduce((acc, inc) => acc + (inc.amount || 0), 0);
      return sum > 0 ? -sum : 0;
    });

    datasets.push({
      label: cat,
      data: monthData,
      backgroundColor: getColor(colorIndex++),
      stack: 'balance',
    });
  }

  // 3. 處理每月回饋 (若有回饋記錄，獨立加到 datasets，數值為負數 <= 0)
  if (rewards && rewards.length > 0) {
    const rewardMonthData = targetMonths.map((m) => {
      const matchingRewards = rewards.filter((r) => r.yearMonth?.startsWith(m));
      const sum = matchingRewards.reduce((acc, rew) => acc + (rew.amount || 0), 0);
      return sum > 0 ? -sum : 0;
    });

    datasets.push({
      label: '回饋',
      data: rewardMonthData,
      backgroundColor: getColor(colorIndex++),
      stack: 'balance',
    });
  }

  return {
    labels: targetMonths,
    datasets,
  };
}

/**
 * 依自訂起訖月份區間篩選月份陣列
 *
 * @param months 月份字串陣列 (格式 YYYY-MM)
 * @param startMonth 起始月份 (可選，格式 YYYY-MM)
 * @param endMonth 結束月份 (可選，格式 YYYY-MM)
 * @returns 篩選後之月份陣列
 */
export function filterMonthsByCustomRange(
  months: string[],
  startMonth?: string,
  endMonth?: string
): string[] {
  if (!months || months.length === 0) {
    return [];
  }

  let start = (startMonth ?? '').trim();
  let end = (endMonth ?? '').trim();

  // 若兩者皆未指定或為空字串，回傳原陣列
  if (!start && !end) {
    return [...months];
  }

  // 起訖顛倒自動安全調換
  if (start && end && start > end) {
    const temp = start;
    start = end;
    end = temp;
  }

  return months.filter((m) => {
    if (start && m < start) return false;
    if (end && m > end) return false;
    return true;
  });
}
