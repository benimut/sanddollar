<script setup lang="ts">
/**
 * @file ReportView.vue
 * @description 財務報表與視覺化圖表檢視元件
 *
 * 核心業務職責：
 * 1. 財務核心摘要卡片：呈現總進帳 (totalIncome)、總支出 (totalExpense) 與當期結餘 (balance)。
 * 2. 分類比例圓餅圖：整合 Chart.js PieController，動態呼叫 generateCategoryPieData，支援支出/收入分類佔比即時切換。
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
  generateCategoryPieData,
  generateStackedBarData,
  extractAvailableMonths,
  filterMonthsByCustomRange,
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

// 當前月份（格式 YYYY-MM）
const currentMonth = getCurrentMonthString();

// 財務摘要選取之月份（預設為當前月份）
const selectedMonth = ref<string>(currentMonth);

// 長條圖自訂區間篩選月份狀態
const rangeStartMonth = ref<string>('');
const rangeEndMonth = ref<string>('');
const activeQuickRange = ref<'3' | '6' | '12' | 'all' | 'custom'>('all');

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

// 圓餅圖模式：'expense' | 'income'
const pieMode = ref<'expense' | 'income'>('expense');

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
 * 渲染或更新分類圓餅圖
 */
function renderPieChart() {
  if (!pieCanvasRef.value) return;

  if (pieChartInstance) {
    pieChartInstance.destroy();
    pieChartInstance = null;
  }

  const pieData = generateCategoryPieData(
    expenses.value,
    incomes.value,
    pieMode.value
  );

  const ctx = pieCanvasRef.value.getContext('2d');
  if (!ctx) return;

  // 若無資料時提供佔位數據
  const hasData = pieData.datasets[0] && pieData.datasets[0].data.length > 0;
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
              return ` NT$ ${item.raw}`;
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
  if (type === 'all') {
    rangeStartMonth.value = '';
    rangeEndMonth.value = '';
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

  if (barChartInstance) {
    barChartInstance.destroy();
    barChartInstance = null;
  }

  // 取得升冪排序之全月份
  const allAscMonths = extractAvailableMonths(expenses.value, incomes.value, rewards.value, {
    order: 'asc',
  });

  // 透過自訂區間篩選月份清單
  const filteredMonths = filterMonthsByCustomRange(
    allAscMonths,
    rangeStartMonth.value,
    rangeEndMonth.value
  );

  const barData = generateStackedBarData(
    expenses.value,
    incomes.value,
    rewards.value,
    filteredMonths.length > 0 ? filteredMonths : undefined
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

// 監聽 selectedMonth 變更即時重算財務摘要
watch(selectedMonth, () => {
  updateSummary();
});

// 監聽圓餅圖模式即時重繪圓餅圖
watch(pieMode, () => {
  renderPieChart();
});

// 監聽自訂起訖月份變更即時重繪長條圖
watch([rangeStartMonth, rangeEndMonth], () => {
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
      <div class="flex items-center justify-between">
        <h2 class="text-base font-bold text-slate-800">財務核心摘要</h2>

        <!-- 月份下拉選單 (依月份降冪排序) -->
        <select
          id="summary-month-select"
          v-model="selectedMonth"
          class="text-xs border border-slate-200 rounded-lg px-2.5 py-1 bg-slate-50 text-slate-700 font-medium focus:ring-2 focus:ring-teal-500 focus:outline-none"
        >
          <option v-for="m in availableMonths" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>

      <!-- 核心三欄數據網格 -->
      <div class="grid grid-cols-3 gap-3">
        <!-- 總支出 -->
        <div class="bg-rose-50/60 rounded-xl p-3 text-center border border-rose-100">
          <span class="block text-xs text-rose-600 font-medium mb-1">總支出</span>
          <span class="text-base font-extrabold text-rose-700">NT$ {{ summary.totalExpense }}</span>
        </div>

        <!-- 總進帳 -->
        <div class="bg-emerald-50/60 rounded-xl p-3 text-center border border-emerald-100">
          <span class="block text-xs text-emerald-600 font-medium mb-1">總進帳</span>
          <span class="text-base font-extrabold text-emerald-700">NT$ {{ summary.totalIncome }}</span>
        </div>

        <!-- 當期結餘 -->
        <div
          class="rounded-xl p-3 text-center border"
          :class="
            summary.balance >= 0
              ? 'bg-teal-50/60 border-teal-100 text-teal-800'
              : 'bg-amber-50/60 border-amber-100 text-amber-800'
          "
        >
          <span class="block text-xs font-medium mb-1">當期結餘</span>
          <span class="text-base font-extrabold">NT$ {{ summary.balance }}</span>
        </div>
      </div>
    </div>

    <!-- ==================== 收支分類圓餅圖 ==================== -->
    <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-base font-bold text-slate-800">收支分類佔比</h3>
        <!-- 切換按鈕：支出分類 / 收入分類 -->
        <div class="flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
          <button
            type="button"
            class="px-2.5 py-1 rounded-md transition-all"
            :class="pieMode === 'expense' ? 'bg-white text-teal-700 font-bold shadow-sm' : 'text-slate-500 hover:text-slate-800'"
            @click="pieMode = 'expense'"
          >
            支出分類
          </button>
          <button
            type="button"
            class="px-2.5 py-1 rounded-md transition-all"
            :class="pieMode === 'income' ? 'bg-white text-teal-700 font-bold shadow-sm' : 'text-slate-500 hover:text-slate-800'"
            @click="pieMode = 'income'"
          >
            收入分類
          </button>
        </div>
      </div>

      <!-- 圓餅圖畫布容器 -->
      <div class="h-64 relative flex items-center justify-center">
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

        <!-- 自訂起訖月份輸入項 -->
        <div class="flex items-center gap-2 p-2.5 bg-slate-50 rounded-xl border border-slate-100 text-xs">
          <span class="text-slate-500 font-medium">區間：</span>
          <input
            id="report-start-month"
            v-model="rangeStartMonth"
            type="month"
            class="border border-slate-200 rounded-lg p-1 text-xs bg-white text-slate-700"
            @change="activeQuickRange = 'custom'"
          />
          <span class="text-slate-400">至</span>
          <input
            id="report-end-month"
            v-model="rangeEndMonth"
            type="month"
            class="border border-slate-200 rounded-lg p-1 text-xs bg-white text-slate-700"
            @change="activeQuickRange = 'custom'"
          />
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
