<script setup lang="ts">
/**
 * @file ReportView.vue
 * @description 財務報表與視覺化圖表檢視元件
 *
 * 核心業務職責：
 * 1. 財務核心摘要卡片：呈現總進帳 (totalIncome)、總支出 (totalExpense) 與當期結餘 (balance)，支援百分比（預設，以總進帳為 100% 基準）與金額即時切換。
 * 2. 收支佔比圓餅圖：整合 Chart.js PieController，連動當月篩選，支援「分類 / 細項」與「支出 / 收入」切換；細項模式僅保留前 5 大並將其餘加總為「其他」。
 * 3. 每月收支堆疊長條圖：整合 Chart.js BarController 與 generateStackedBarData，呈現並排雙柱堆疊分析（收入/回饋 vs 支出）。
 * 4. 自訂起訖月份區間篩選：支援快選（近3個月、近6個月、近12個月、全部）與精確手動輸入起訖月份 (#report-start-month, #report-end-month)。
 */

import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import {
  Chart,
  ArcElement,
  Tooltip,
  Legend,
  PieController,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
} from 'chart.js';
import { getExpenses, getIncomes, getRewards } from '@/db';
import { getCurrentMonthString, shiftMonth } from '@/utils/date';
import {
  calculateFinancialSummary,
  calculateSummaryPercentages,
  formatSummaryPercentage,
  generateCategoryPieData,
  generateDetailPieData,
  generateStackedBarData,
  extractAvailableMonths,
  expandMonthRange,
  type StackedBarDataset,
} from '@/utils/report';
import type { ExpenseRecord, IncomeRecord, MonthlyReward, FinancialSummary } from '@/types';

// 註冊 Chart.js 核心繪圖與控制器元件
Chart.register(
  ArcElement,
  Tooltip,
  Legend,
  PieController,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale
);

// 資料狀態
const expenses = ref<ExpenseRecord[]>([]);
const incomes = ref<IncomeRecord[]>([]);
const rewards = ref<MonthlyReward[]>([]);

const summary = ref<FinancialSummary>({
  totalIncome: 0,
  totalExpense: 0,
  balance: 0,
});

// 當前月份（格式 YYYY-MM）與今年預設區間
const currentMonth = getCurrentMonthString();
const currentYear = currentMonth.slice(0, 4);
const defaultStartMonth = `${currentYear}-01`;
const defaultEndMonth = `${currentYear}-12`;

// 財務摘要選取之月份（必填，預設為當前月份）
const selectedMonth = ref<string>(currentMonth);

// 財務摘要顯示單位：'percent' (百分比，預設) | 'amount' (金額)
const summaryDisplayMode = ref<'percent' | 'amount'>('percent');

// 依當期財務摘要計算百分比（以總進帳為 100% 基準）
const summaryPercentages = computed(() => calculateSummaryPercentages(summary.value));
const hasSummaryIncome = computed(() => summaryPercentages.value.incomeRate !== null);
const summaryPercentDisplay = computed(() => ({
  expense: formatSummaryPercentage(summaryPercentages.value.expenseRate),
  income: formatSummaryPercentage(summaryPercentages.value.incomeRate),
  balance: formatSummaryPercentage(summaryPercentages.value.balanceRate),
}));

// 長條圖自訂區間篩選月份狀態（必填，預設為今年 01~12 月）
const rangeStartMonth = ref<string>(defaultStartMonth);
const rangeEndMonth = ref<string>(defaultEndMonth);
const activeQuickRange = ref<'3' | '6' | '12' | 'all' | 'custom'>('custom');
const rangeErrorMessage = ref('');

/**
 * 可選月份清單：由消費、收入與回饋記錄中提取不重複的 YYYY-MM，
 * 且必定包含當前月份 (currentMonth) 與目前選取之 selectedMonth，
 * 依月份降冪排序（最新在前）。
 */
const availableMonths = computed<string[]>(() => {
  return extractAvailableMonths(expenses.value, incomes.value, rewards.value, {
    order: 'desc',
    extraMonths: [currentMonth, selectedMonth.value],
  });
});

// 圓餅圖收支模式：'expense' | 'income'
const pieMode = ref<'expense' | 'income'>('expense');
// 圓餅圖統計維度：'category' (分類) | 'detail' (細項，前 5 大 + 其他)
const pieScope = ref<'category' | 'detail'>('category');
const pieTitle = computed(() => (pieScope.value === 'category' ? '收支分類佔比' : '收支細項佔比'));

// Canvas 參考
const pieCanvasRef = ref<HTMLCanvasElement | null>(null);
const barCanvasRef = ref<HTMLCanvasElement | null>(null);

let pieChartInstance: Chart | null = null;
let barChartInstance: Chart | null = null;

/**
 * 長條圖自訂分組圖例項目
 */
interface BarLegendItem {
  index: number;
  label: string;
  color: string;
  categoryType: 'income' | 'reward' | 'expense';
  hidden: boolean;
}

const barLegendItems = ref<BarLegendItem[]>([]);

const incomeLegendItems = computed(() =>
  barLegendItems.value.filter((item) => item.categoryType === 'income')
);
const expenseLegendItems = computed(() =>
  barLegendItems.value.filter((item) => item.categoryType === 'expense')
);
const rewardLegendItems = computed(() =>
  barLegendItems.value.filter((item) => item.categoryType === 'reward')
);

/**
 * 切換長條圖指定資料集的顯示/隱藏狀態
 */
function toggleBarDataset(index: number) {
  const item = barLegendItems.value[index];
  if (!item) return;
  const nextHidden = !item.hidden;
  item.hidden = nextHidden;
  if (barChartInstance && typeof barChartInstance.setDatasetVisibility === 'function') {
    barChartInstance.setDatasetVisibility(index, !nextHidden);
    barChartInstance.update();
  }
}

/**
 * 依當前選取之 selectedMonth 計算財務核心摘要
 */
function updateSummary() {
  summary.value = calculateFinancialSummary(
    expenses.value,
    incomes.value,
    rewards.value,
    selectedMonth.value
  );
}

/**
 * 載入所有資料庫資料並計算統計
 */
async function loadData() {
  expenses.value = await getExpenses();
  incomes.value = await getIncomes();
  rewards.value = await getRewards();

  updateSummary();

  await nextTick();
  renderPieChart();
  renderBarChart();
}

/**
 * 渲染或更新收支圓餅圖（連動 selectedMonth，支援分類與細項模式切換）
 */
function renderPieChart() {
  if (!pieCanvasRef.value) return;

  if (pieChartInstance) {
    pieChartInstance.destroy();
    pieChartInstance = null;
  }

  const pieData =
    pieScope.value === 'detail'
      ? generateDetailPieData(expenses.value, incomes.value, pieMode.value, {
          targetMonth: selectedMonth.value,
          topN: 5,
        })
      : generateCategoryPieData(
          expenses.value,
          incomes.value,
          pieMode.value,
          selectedMonth.value
        );

  const ctx = pieCanvasRef.value.getContext('2d');
  if (!ctx) return;

  // 若無資料時提供佔位數據
  const hasData = pieData.datasets[0] && pieData.datasets[0].data.length > 0;
  const pieTotal = hasData
    ? pieData.datasets[0].data.reduce((sum, value) => sum + (Number(value) || 0), 0)
    : 0;
  const chartData = hasData
    ? pieData
    : {
        labels: ['尚無資料'],
        datasets: [
          {
            data: [1],
            backgroundColor: ['#E2E8F0'],
          },
        ],
      };

  pieChartInstance = new Chart(ctx, {
    type: 'pie',
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            boxWidth: 12,
            font: {
              size: 11,
            },
          },
        },
        tooltip: {
          callbacks: {
            label: (item) => {
              if (!hasData) return ' 尚無資料';
              const val = Number(item.raw) || 0;
              const pctText =
                pieTotal > 0 ? ` (${((val / pieTotal) * 100).toFixed(1)}%)` : '';
              return ` ${item.label}: NT$ ${val}${pctText}`;
            },
          },
        },
      },
    },
  });
}

/**
 * 快選切換月份區間
 */
function setQuickRange(type: '3' | '6' | '12' | 'all') {
  activeQuickRange.value = type;
  rangeErrorMessage.value = '';
  if (type === 'all') {
    const allAscMonths = extractAvailableMonths(expenses.value, incomes.value, rewards.value, {
      order: 'asc',
    });
    if (allAscMonths.length > 0) {
      rangeStartMonth.value = allAscMonths[0];
      rangeEndMonth.value = allAscMonths[allAscMonths.length - 1];
    } else {
      rangeStartMonth.value = defaultStartMonth;
      rangeEndMonth.value = defaultEndMonth;
    }
    renderBarChart();
    return;
  }

  const numMonths = Number(type);
  rangeEndMonth.value = currentMonth;
  rangeStartMonth.value = shiftMonth(currentMonth, -(numMonths - 1));

  renderBarChart();
}

/**
 * 渲染或更新並排雙柱堆疊長條圖
 */
function renderBarChart() {
  if (!barCanvasRef.value) return;

  if (!rangeStartMonth.value || !rangeEndMonth.value) {
    rangeErrorMessage.value = '請選擇起訖月份區間';
    return;
  }
  rangeErrorMessage.value = '';

  if (barChartInstance) {
    barChartInstance.destroy();
    barChartInstance = null;
  }

  // 依所選起訖區間展開連續月份（無資料的月份數值為 0，不退回全部歷史資料）
  const targetMonths = expandMonthRange(rangeStartMonth.value, rangeEndMonth.value);

  const barData = generateStackedBarData(
    expenses.value,
    incomes.value,
    rewards.value,
    targetMonths
  );

  // 同步建立分組圖例項目（依 stack/categoryType 分類）
  barLegendItems.value = barData.datasets.map((ds: StackedBarDataset, index: number) => ({
    index,
    label: ds.label,
    color: ds.backgroundColor,
    categoryType: ds.categoryType ?? (ds.stack === 'expense' ? 'expense' : 'income'),
    hidden: false,
  }));

  const ctx = barCanvasRef.value.getContext('2d');
  if (!ctx) return;

  barChartInstance = new Chart(ctx, {
    type: 'bar',
    data: barData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          stacked: true,
          grid: {
            display: false,
          },
          ticks: {
            font: {
              size: 11,
            },
          },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: {
            font: {
              size: 10,
            },
            callback: (val) => `$${Number(val)}`,
          },
        },
      },
      plugins: {
        legend: {
          // 關閉預設圖例，改以下方收入、支出、回饋各一列之自訂圖例呈現
          display: false,
        },
        tooltip: {
          callbacks: {
            label: (item) => {
              const val = Number(item.raw) || 0;
              return ` ${item.dataset.label}: NT$ ${val}`;
            },
          },
        },
      },
    },
  });
}

// 監聽 selectedMonth 變更即時重算財務摘要並同步重繪圓餅圖（不可為空，若被清空則自動重設為當月）
watch(selectedMonth, (val) => {
  if (!val) {
    selectedMonth.value = currentMonth;
    return;
  }
  updateSummary();
  renderPieChart();
});

// 監聽圓餅圖模式或統計維度變更即時重繪圓餅圖
watch([pieMode, pieScope], () => {
  renderPieChart();
});

// 監聽自訂起訖月份變更即時重繪長條圖（不允許清空，若清空則自動補回今年預設值並提示）
watch([rangeStartMonth, rangeEndMonth], ([start, end]) => {
  if (!start) {
    rangeStartMonth.value = defaultStartMonth;
    rangeErrorMessage.value = '起始月份不可留空，已重設為今年 1 月';
    return;
  }
  if (!end) {
    rangeEndMonth.value = defaultEndMonth;
    rangeErrorMessage.value = '結束月份不可留空，已重設為今年 12 月';
    return;
  }
  renderBarChart();
});

onMounted(async () => {
  await loadData();
});

onUnmounted(() => {
  if (pieChartInstance) {
    pieChartInstance.destroy();
    pieChartInstance = null;
  }
  if (barChartInstance) {
    barChartInstance.destroy();
    barChartInstance = null;
  }
});
</script>

<template>
  <div class="space-y-4">
    <!-- ==================== 財務核心摘要卡片 ==================== -->
    <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-base font-bold text-slate-800">財務核心摘要</h2>

        <div class="flex items-center gap-2">
          <!-- 顯示單位切換：百分比 / 金額（預設百分比） -->
          <div
            role="group"
            aria-label="摘要顯示單位"
            class="flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium"
          >
            <button
              type="button"
              :aria-pressed="summaryDisplayMode === 'percent'"
              class="min-h-[28px] px-2.5 py-1 rounded-md transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              :class="
                summaryDisplayMode === 'percent'
                  ? 'bg-white text-teal-700 font-bold shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              "
              @click="summaryDisplayMode = 'percent'"
            >
              百分比
            </button>
            <button
              type="button"
              :aria-pressed="summaryDisplayMode === 'amount'"
              class="min-h-[28px] px-2.5 py-1 rounded-md transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              :class="
                summaryDisplayMode === 'amount'
                  ? 'bg-white text-teal-700 font-bold shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              "
              @click="summaryDisplayMode = 'amount'"
            >
              金額
            </button>
          </div>

          <!-- 月份下拉選單 (依月份降冪排序，必填) -->
          <select
            id="summary-month-select"
            v-model="selectedMonth"
            aria-label="選擇財務摘要月份"
            required
            class="min-h-[28px] text-xs border border-slate-200 rounded-lg px-2.5 py-1 bg-slate-50 text-slate-700 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            <option v-for="m in availableMonths" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
      </div>

      <!-- 核心三欄數據網格 -->
      <div class="grid grid-cols-3 gap-3">
        <!-- 總支出 -->
        <div
          class="bg-rose-50/60 rounded-xl p-3 text-center border border-rose-100"
          data-testid="summary-expense-card"
        >
          <span class="block text-xs text-rose-600 font-medium mb-1">總支出</span>
          <span class="text-base font-extrabold text-rose-700">
            {{ summaryDisplayMode === 'amount' ? `NT$ ${summary.totalExpense}` : summaryPercentDisplay.expense }}
          </span>
        </div>

        <!-- 總進帳 -->
        <div
          class="bg-emerald-50/60 rounded-xl p-3 text-center border border-emerald-100"
          data-testid="summary-income-card"
        >
          <span class="block text-xs text-emerald-600 font-medium mb-1">總進帳</span>
          <span class="text-base font-extrabold text-emerald-700">
            {{ summaryDisplayMode === 'amount' ? `NT$ ${summary.totalIncome}` : summaryPercentDisplay.income }}
          </span>
        </div>

        <!-- 當期結餘 -->
        <div
          class="rounded-xl p-3 text-center border"
          data-testid="summary-balance-card"
          :class="
            summary.balance >= 0
              ? 'bg-teal-50/60 border-teal-100 text-teal-800'
              : 'bg-amber-50/60 border-amber-100 text-amber-800'
          "
        >
          <span class="block text-xs font-medium mb-1">當期結餘</span>
          <span class="text-base font-extrabold">
            {{ summaryDisplayMode === 'amount' ? `NT$ ${summary.balance}` : summaryPercentDisplay.balance }}
          </span>
        </div>
      </div>

      <p
        v-if="summaryDisplayMode === 'percent'"
        class="text-[11px] text-slate-500 text-right"
        data-testid="summary-percent-note"
      >
        {{ hasSummaryIncome ? '以當月總進帳為 100% 基準' : '當月無進帳紀錄，無法計算百分比' }}
      </p>
    </div>

    <!-- ==================== 收支圓餅圖（分類 / 細項） ==================== -->
    <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <h3 class="text-base font-bold text-slate-800">{{ pieTitle }}</h3>
          <span
            class="text-[11px] font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-600"
            data-testid="pie-month-badge"
          >
            {{ selectedMonth }}
          </span>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <!-- 統計維度切換：分類 / 細項 -->
          <div
            role="group"
            aria-label="圓餅圖統計維度"
            class="flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium"
          >
            <button
              type="button"
              :aria-pressed="pieScope === 'category'"
              class="min-h-[28px] px-2.5 py-1 rounded-md transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              :class="
                pieScope === 'category'
                  ? 'bg-white text-teal-700 font-bold shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              "
              @click="pieScope = 'category'"
            >
              分類
            </button>
            <button
              type="button"
              :aria-pressed="pieScope === 'detail'"
              class="min-h-[28px] px-2.5 py-1 rounded-md transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              :class="
                pieScope === 'detail'
                  ? 'bg-white text-teal-700 font-bold shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              "
              @click="pieScope = 'detail'"
            >
              細項
            </button>
          </div>

          <!-- 收支類型切換：支出 / 收入 -->
          <div
            role="group"
            aria-label="圓餅圖收支類型"
            class="flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium"
          >
            <button
              type="button"
              :aria-pressed="pieMode === 'expense'"
              class="min-h-[28px] px-2.5 py-1 rounded-md transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              :class="
                pieMode === 'expense'
                  ? 'bg-white text-teal-700 font-bold shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              "
              @click="pieMode = 'expense'"
            >
              {{ pieScope === 'category' ? '支出分類' : '支出細項' }}
            </button>
            <button
              type="button"
              :aria-pressed="pieMode === 'income'"
              class="min-h-[28px] px-2.5 py-1 rounded-md transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              :class="
                pieMode === 'income'
                  ? 'bg-white text-teal-700 font-bold shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              "
              @click="pieMode = 'income'"
            >
              {{ pieScope === 'category' ? '收入分類' : '收入細項' }}
            </button>
          </div>
        </div>
      </div>

      <p
        v-if="pieScope === 'detail'"
        class="text-[11px] text-slate-500"
        data-testid="pie-detail-note"
      >
        {{
          pieMode === 'expense'
            ? '依當月每筆消費商品明細作圖，僅保留前 5 大項目，其餘加總為「其他」'
            : '依當月每筆收入記錄作圖，僅保留前 5 大項目，其餘加總為「其他」'
        }}
      </p>

      <!-- 圓餅圖畫布容器 -->
      <div
        class="relative flex items-center justify-center"
        :class="pieScope === 'detail' ? 'h-72' : 'h-64'"
      >
        <canvas ref="pieCanvasRef" class="w-full h-full"></canvas>
      </div>
    </div>

    <!-- ==================== 每月收支長條圖 ==================== -->
    <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 space-y-4">
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="text-base font-bold text-slate-800">每月收支</h3>

          <!-- 區間快選標籤 -->
          <div class="flex items-center gap-1 text-[11px]">
            <button
              type="button"
              class="px-2 py-0.5 rounded-md border transition-colors"
              :class="activeQuickRange === '3' ? 'bg-teal-700 text-white border-teal-700' : 'bg-slate-50 text-slate-600 border-slate-200'"
              @click="setQuickRange('3')"
            >
              近3月
            </button>
            <button
              type="button"
              class="px-2 py-0.5 rounded-md border transition-colors"
              :class="activeQuickRange === '6' ? 'bg-teal-700 text-white border-teal-700' : 'bg-slate-50 text-slate-600 border-slate-200'"
              @click="setQuickRange('6')"
            >
              近6月
            </button>
            <button
              type="button"
              class="px-2 py-0.5 rounded-md border transition-colors"
              :class="activeQuickRange === '12' ? 'bg-teal-700 text-white border-teal-700' : 'bg-slate-50 text-slate-600 border-slate-200'"
              @click="setQuickRange('12')"
            >
              近12月
            </button>
            <button
              type="button"
              class="px-2 py-0.5 rounded-md border transition-colors"
              :class="activeQuickRange === 'all' ? 'bg-teal-700 text-white border-teal-700' : 'bg-slate-50 text-slate-600 border-slate-200'"
              @click="setQuickRange('all')"
            >
              全部
            </button>
          </div>
        </div>

        <!-- 自訂起訖月份輸入項 (必填，預設今年) -->
        <div class="space-y-1">
          <div class="flex items-center gap-2 p-2.5 bg-slate-50 rounded-xl border border-slate-100 text-xs">
            <span class="text-slate-500 font-medium">區間：</span>
            <input
              id="report-start-month"
              v-model="rangeStartMonth"
              type="month"
              required
              :class="!rangeStartMonth ? 'border-rose-500 ring-2 ring-rose-200' : 'border-slate-200'"
              class="border rounded-lg p-1 text-xs bg-white text-slate-700"
              @change="activeQuickRange = 'custom'"
            />
            <span class="text-slate-400">至</span>
            <input
              id="report-end-month"
              v-model="rangeEndMonth"
              type="month"
              required
              :class="!rangeEndMonth ? 'border-rose-500 ring-2 ring-rose-200' : 'border-slate-200'"
              class="border rounded-lg p-1 text-xs bg-white text-slate-700"
              @change="activeQuickRange = 'custom'"
            />
          </div>
          <p v-if="rangeErrorMessage" id="report-range-error" class="text-xs text-rose-600 font-medium">
            {{ rangeErrorMessage }}
          </p>
        </div>
      </div>

      <!-- 堆疊長條圖畫布容器 -->
      <div class="h-64 relative flex items-center justify-center">
        <canvas ref="barCanvasRef" class="w-full h-full"></canvas>
      </div>

      <!-- 分組圖例：收入、支出、回饋各一列 -->
      <div
        v-if="barLegendItems.length > 0"
        class="mt-3 pt-2.5 border-t border-slate-100 space-y-1.5 text-[11px]"
        data-testid="bar-legend-groups"
      >
        <div v-if="incomeLegendItems.length > 0" class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="font-semibold text-slate-500 shrink-0">收入：</span>
          <button
            v-for="item in incomeLegendItems"
            :key="item.index"
            type="button"
            class="inline-flex items-center gap-1.5 transition-opacity"
            :class="item.hidden ? 'opacity-40 line-through' : 'opacity-100'"
            @click="toggleBarDataset(item.index)"
          >
            <span class="w-2.5 h-2.5 rounded-sm shrink-0" :style="{ backgroundColor: item.color }"></span>
            <span class="text-slate-700">{{ item.label }}</span>
          </button>
        </div>

        <div v-if="expenseLegendItems.length > 0" class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="font-semibold text-slate-500 shrink-0">支出：</span>
          <button
            v-for="item in expenseLegendItems"
            :key="item.index"
            type="button"
            class="inline-flex items-center gap-1.5 transition-opacity"
            :class="item.hidden ? 'opacity-40 line-through' : 'opacity-100'"
            @click="toggleBarDataset(item.index)"
          >
            <span class="w-2.5 h-2.5 rounded-sm shrink-0" :style="{ backgroundColor: item.color }"></span>
            <span class="text-slate-700">{{ item.label }}</span>
          </button>
        </div>

        <div v-if="rewardLegendItems.length > 0" class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="font-semibold text-slate-500 shrink-0">回饋：</span>
          <button
            v-for="item in rewardLegendItems"
            :key="item.index"
            type="button"
            class="inline-flex items-center gap-1.5 transition-opacity"
            :class="item.hidden ? 'opacity-40 line-through' : 'opacity-100'"
            @click="toggleBarDataset(item.index)"
          >
            <span class="w-2.5 h-2.5 rounded-sm shrink-0" :style="{ backgroundColor: item.color }"></span>
            <span class="text-slate-700">{{ item.label }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
