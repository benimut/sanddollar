/**
 * @file report.ts
 * @description Sanddollar 財務報表與視覺化圖表資料轉換核心模組
 * 提供財務摘要統計 (calculateFinancialSummary)、分類圓餅圖資料轉換 (generateCategoryPieData)
 * 以及並排雙柱堆疊長條圖資料集產生 (generateStackedBarData)，嚴格保證型別安全與防禦性邊界處理。
 */

import type { ExpenseRecord, IncomeRecord, MonthlyReward, FinancialSummary } from '@/types';

/**
 * 財務摘要百分比統計結果（以當期總進帳為 100% 基準）
 */
export interface FinancialSummaryPercentages {
  /** 總支出佔總進帳百分比（無進帳時為 null） */
  expenseRate: number | null;
  /** 總進帳基準百分比（有進帳時為 100，無進帳時為 null） */
  incomeRate: number | null;
  /** 當期結餘佔總進帳百分比（無進帳時為 null；超支時為負值） */
  balanceRate: number | null;
}

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
 * 細項圓餅圖產生選項
 */
export interface DetailPieOptions {
  /** 目標篩選月份（選填，格式 YYYY-MM） */
  targetMonth?: string;
  /** 保留前幾大項目（預設為 5），其餘加總為「其他」 */
  topN?: number;
}

/**
 * 堆疊長條圖資料集結構
 */
export interface StackedBarDataset {
  label: string;
  data: number[];
  backgroundColor: string;
  stack: string;
  /** 資料類型標記，供前端圖例分組渲染使用 */
  categoryType?: 'income' | 'reward' | 'expense';
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
 * 「其他」彙總切片專用中性灰色，與前 N 大重點項目形成視覺區隔
 */
const OTHER_SLICE_COLOR = '#94A3B8';

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
 * 收入與回饋冷色系調色盤（藍、綠、青、靛青）
 */
const INCOME_PALETTE: string[] = [
  '#0F766E', '#0284C7', '#16A34A', '#0D9488',
  '#2563EB', '#059669', '#0891B2', '#4F46E5',
];

/**
 * 支出高對比暖陽大地系調色盤（正紅、金琥珀、亮紫、珊瑚粉、焦糖棕、活力橘、深酒紅、檸檬黃）
 * 與左柱收入冷色系保持視覺區隔，並拉開相鄰支出分類的色相與明度差距
 */
const EXPENSE_PALETTE: string[] = [
  '#DC2626', '#F59E0B', '#9333EA', '#FB7185',
  '#B45309', '#F97316', '#881337', '#FACC15',
];

/**
 * 取得指定索引的顏色（支援超過調色盤長度時輪替）
 * @param index 索引值
 * @param palette 指定調色盤（預設為 DEFAULT_PALETTE）
 * @returns 顏色 Hex 字串
 */
function getColor(index: number, palette: string[] = DEFAULT_PALETTE): string {
  return palette[index % palette.length];
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
 * 依財務摘要計算各項百分比（以總進帳 totalIncome 為 100% 基準）
 *
 * 當總進帳小於等於 0 或無效時，三項比率皆回傳 null（由顯示層呈現「—」），避免除以 0。
 *
 * @param summary 財務摘要物件 (totalIncome, totalExpense, balance)
 * @returns 各項百分比數值物件（單位：%）
 */
export function calculateSummaryPercentages(
  summary: FinancialSummary
): FinancialSummaryPercentages {
  if (!summary || !Number.isFinite(summary.totalIncome) || summary.totalIncome <= 0) {
    return {
      expenseRate: null,
      incomeRate: null,
      balanceRate: null,
    };
  }

  const totalIncome = summary.totalIncome;
  const totalExpense = Number.isFinite(summary.totalExpense) ? summary.totalExpense : 0;
  const balance = Number.isFinite(summary.balance) ? summary.balance : totalIncome - totalExpense;

  return {
    expenseRate: (totalExpense / totalIncome) * 100,
    incomeRate: 100,
    balanceRate: (balance / totalIncome) * 100,
  };
}

/**
 * 將百分比數值格式化為小數點後 1 位之百分比字串
 *
 * - 當傳入 null 或非有限數值時，回傳破折號「—」
 * - 避免極小負數在四捨五入後顯示為「-0.0%」
 *
 * @param rate 百分比數值或 null
 * @returns 格式化字串（例如 "58.3%"、"-12.5%" 或 "—"）
 */
export function formatSummaryPercentage(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) {
    return '—';
  }
  const normalized = Math.abs(rate) < 0.05 ? 0 : rate;
  return `${normalized.toFixed(1)}%`;
}

/**
 * 自 YYYY-MM-DD 日期字串解析出 MM/DD 短日期格式
 *
 * @param dateStr 日期字串（例如 "2026-11-02"）
 * @returns 短日期字串（例如 "11/02"），格式不符則回傳空字串
 */
function formatShortMonthDay(dateStr?: string): string {
  if (typeof dateStr !== 'string') {
    return '';
  }
  const match = dateStr.trim().match(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:$|T|\s)/);
  return match ? `${match[1]}/${match[2]}` : '';
}

/**
 * 組裝支出細項切片標籤：格式為「名稱 (商家 日期)」，缺漏欄位自動省略
 *
 * @param itemName 商品品項名稱
 * @param merchant 消費商家名稱
 * @param dateStr 消費日期字串 (YYYY-MM-DD)
 * @returns 格式化後之切片標籤
 */
function formatExpenseDetailLabel(itemName?: string, merchant?: string, dateStr?: string): string {
  const name = itemName?.trim() || '未命名品項';
  const merchantText = merchant?.trim() || '';
  const shortDate = formatShortMonthDay(dateStr);
  const meta = [merchantText, shortDate].filter(Boolean).join(' ');
  return meta ? `${name} (${meta})` : name;
}

/**
 * 組裝收入細項切片標籤：格式為「來源 (日期)」，無有效日期時僅顯示來源名稱
 *
 * @param sourceName 收入來源名稱
 * @param dateStr 收入日期字串 (YYYY-MM-DD)
 * @returns 格式化後之切片標籤
 */
function formatIncomeDetailLabel(sourceName?: string, dateStr?: string): string {
  const source = sourceName?.trim() || '未命名收入';
  const shortDate = formatShortMonthDay(dateStr);
  return shortDate ? `${source} (${shortDate})` : source;
}

/**
 * 產生收支分類圓餅圖資料
 *
 * 支援選填 targetMonth 依指定月份篩選；未傳入時維持全量統計以向下相容。
 *
 * @param expenses 消費支出記錄列表
 * @param incomes 收入記錄列表
 * @param mode 圖表模式：'expense' (支出) 或 'income' (收入)
 * @param targetMonth 目標篩選月份（選填，格式 YYYY-MM）
 * @returns 圓餅圖所需 labels 與 datasets 結構
 */
export function generateCategoryPieData(
  expenses: ExpenseRecord[],
  incomes: IncomeRecord[],
  mode: 'expense' | 'income',
  targetMonth?: string
): CategoryPieChartData {
  const monthFilter = targetMonth?.trim();
  const hasMonthFilter = Boolean(monthFilter && monthFilter.length > 0);
  const categoryMap = new Map<string, number>();

  if (mode === 'expense') {
    const targetExpenses = hasMonthFilter
      ? (expenses || []).filter((exp) => typeof exp?.date === 'string' && exp.date.startsWith(monthFilter!))
      : (expenses || []);

    // 統計支出品項分類加總
    for (const exp of targetExpenses) {
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
    const targetIncomes = hasMonthFilter
      ? (incomes || []).filter((inc) => typeof inc?.date === 'string' && inc.date.startsWith(monthFilter!))
      : (incomes || []);

    // 統計收入分類加總
    for (const inc of targetIncomes) {
      const cat = inc.category?.trim() || '其他';
      const currentAmount = categoryMap.get(cat) || 0;
      categoryMap.set(cat, currentAmount + (inc.amount || 0));
    }
  }

  // 過濾淨額小於等於 0 的分類，避免折扣折抵後出現負值或零值切片
  const labels = Array.from(categoryMap.entries())
    .filter(([, amount]) => amount > 0)
    .map(([label]) => label);
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
 * 產生收支細項圓餅圖資料（僅保留前 N 大，其餘加總為「其他」）
 *
 * - 支出模式：拆解每筆消費記錄中的正向商品明細品項（subtotal > 0），標籤為「名稱 (商家 日期)」。
 * - 收入模式：以每筆正向收入記錄（amount > 0）作圖，標籤為「來源 (日期)」。
 * - 排序與彙總：依金額由大到小排序，保留前 topN（預設 5）大項目；若總數超過 topN，
 *   將第 topN + 1 筆以後全部加總為單一「其他」切片（中性灰色）。
 *
 * @param expenses 消費支出記錄列表
 * @param incomes 收入記錄列表
 * @param mode 圖表模式：'expense' (支出) 或 'income' (收入)
 * @param options 選項設定（targetMonth 月份篩選、topN 前幾大上限）
 * @returns 圓餅圖所需 labels 與 datasets 結構
 */
export function generateDetailPieData(
  expenses: ExpenseRecord[],
  incomes: IncomeRecord[],
  mode: 'expense' | 'income',
  options?: DetailPieOptions
): CategoryPieChartData {
  const monthFilter = options?.targetMonth?.trim();
  const hasMonthFilter = Boolean(monthFilter && monthFilter.length > 0);
  const rawTopN = options?.topN;
  const topN =
    typeof rawTopN === 'number' && Number.isFinite(rawTopN) && rawTopN >= 1
      ? Math.floor(rawTopN)
      : 5;

  const entries: Array<{ label: string; amount: number }> = [];

  if (mode === 'expense') {
    const targetExpenses = hasMonthFilter
      ? (expenses || []).filter((exp) => typeof exp?.date === 'string' && exp.date.startsWith(monthFilter!))
      : (expenses || []);

    for (const exp of targetExpenses) {
      if (!exp?.items || exp.items.length === 0) {
        continue;
      }
      for (const item of exp.items) {
        const amount = Number(item?.subtotal);
        if (!Number.isFinite(amount) || amount <= 0) {
          continue;
        }
        entries.push({
          label: formatExpenseDetailLabel(item?.name, exp.merchant, exp.date),
          amount,
        });
      }
    }
  } else {
    const targetIncomes = hasMonthFilter
      ? (incomes || []).filter((inc) => typeof inc?.date === 'string' && inc.date.startsWith(monthFilter!))
      : (incomes || []);

    for (const inc of targetIncomes) {
      const amount = Number(inc?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        continue;
      }
      entries.push({
        label: formatIncomeDetailLabel(inc?.source, inc?.date),
        amount,
      });
    }
  }

  // 依金額降冪排序（金額相同維持原始順序）
  entries.sort((a, b) => b.amount - a.amount);

  const labels: string[] = [];
  const data: number[] = [];
  const backgroundColor: string[] = [];

  if (entries.length <= topN) {
    entries.forEach((entry, index) => {
      labels.push(entry.label);
      data.push(entry.amount);
      backgroundColor.push(getColor(index));
    });
  } else {
    const topEntries = entries.slice(0, topN);
    const otherAmount = entries.slice(topN).reduce((sum, entry) => sum + entry.amount, 0);

    topEntries.forEach((entry, index) => {
      labels.push(entry.label);
      data.push(entry.amount);
      backgroundColor.push(getColor(index));
    });

    if (otherAmount > 0) {
      labels.push('其他');
      data.push(otherAmount);
      backgroundColor.push(OTHER_SLICE_COLOR);
    }
  }

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
 * 產生並排雙柱堆疊長條圖資料 (每月收支堆疊長條圖)
 * - 左柱 (stack: 'income')：收入分類 (label: '收入 - <分類>') 與每月回饋 (label: '每月回饋')，皆為正數 (>= 0)，採用冷色系
 * - 右柱 (stack: 'expense')：支出分類 (label: '支出 - <分類>')，皆為正數 (>= 0)，採用暖色系
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
  // 若有外部指定月份陣列（含空陣列），依指定清單生成；未傳入 (undefined) 時自動擷取不重複月份並升冪排序
  const targetMonths: string[] = Array.isArray(months)
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
  let incomeColorIndex = 0;
  let expenseColorIndex = 0;

  // 1. 收集並統計所有收入分類 (左柱 stack: 'income'，數值 >= 0，冷色系)
  const incomeCategories = new Set<string>();
  for (const inc of incomes) {
    const cat = inc.category?.trim() || '其他';
    incomeCategories.add(cat);
  }

  for (const cat of incomeCategories) {
    const monthData = targetMonths.map((m) => {
      const matchingIncomes = incomes.filter(
        (inc) => inc.date?.startsWith(m) && (inc.category?.trim() || '其他') === cat
      );
      const sum = matchingIncomes.reduce((acc, inc) => acc + (inc.amount || 0), 0);
      return sum > 0 ? sum : 0;
    });

    datasets.push({
      label: `收入 - ${cat}`,
      data: monthData,
      backgroundColor: getColor(incomeColorIndex++, INCOME_PALETTE),
      stack: 'income',
      categoryType: 'income',
    });
  }

  // 2. 處理每月回饋 (若有回饋記錄，獨立加到左柱 stack: 'income'，數值 >= 0，冷色系)
  if (rewards && rewards.length > 0) {
    const rewardMonthData = targetMonths.map((m) => {
      const matchingRewards = rewards.filter((r) => r.yearMonth?.startsWith(m));
      const sum = matchingRewards.reduce((acc, rew) => acc + (rew.amount || 0), 0);
      return sum > 0 ? sum : 0;
    });

    datasets.push({
      label: '每月回饋',
      data: rewardMonthData,
      backgroundColor: getColor(incomeColorIndex++, INCOME_PALETTE),
      stack: 'income',
      categoryType: 'reward',
    });
  }

  // 3. 收集並統計所有支出分類 (右柱 stack: 'expense'，數值 >= 0，暖色系)
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
      return sum > 0 ? sum : 0;
    });

    datasets.push({
      label: `支出 - ${cat}`,
      data: monthData,
      backgroundColor: getColor(expenseColorIndex++, EXPENSE_PALETTE),
      stack: 'expense',
      categoryType: 'expense',
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

/**
 * 依起訖月份展開連續月份陣列 (格式 YYYY-MM)
 * 若起訖顛倒會自動對調；若格式無效則回傳空陣列
 *
 * @param startMonth 起始月份 (YYYY-MM)
 * @param endMonth 結束月份 (YYYY-MM)
 * @returns 升冪排列之連續月份字串陣列
 */
export function expandMonthRange(startMonth: string, endMonth: string): string[] {
  let start = parseValidYearMonth(startMonth);
  let end = parseValidYearMonth(endMonth);
  if (!start || !end) {
    return [];
  }

  if (start > end) {
    const temp = start;
    start = end;
    end = temp;
  }

  const [startYear, startMon] = start.split('-').map(Number);
  const [endYear, endMon] = end.split('-').map(Number);

  const result: string[] = [];
  let y = startYear;
  let m = startMon;
  const maxMonths = 1200; // 安全上限：100 年

  while ((y < endYear || (y === endYear && m <= endMon)) && result.length < maxMonths) {
    result.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }

  return result;
}
