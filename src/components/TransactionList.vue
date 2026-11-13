<script setup lang="ts">
/**
 * @file TransactionList.vue
 * @description 收支明細列表主畫面元件
 *
 * 核心業務職責：
 * 1. 依月份分頁切換呈現當月所有收支（支出、收入、回饋）記錄。
 * 2. 顯示當月財務小計（總支出、總收入、當月結餘）。
 * 3. 每筆明細提供「編輯」與「刪除」功能，即時連動 IndexedDB。
 * 4. 內建就地快速編輯對話框，支援即時修改更新。
 */

import { ref, computed, onMounted, watch } from 'vue';
import { Pencil, Trash2 } from 'lucide-vue-next';
import {
  getExpenses,
  getIncomes,
  getRewards,
  getCategories,
  getPaymentMethods,
  deleteExpense,
  deleteIncome,
  deleteReward,
} from '@/db';
import { shiftMonth, getCurrentMonthString } from '@/utils/date';
import { sortStringsNaturally, compareByDateAndCreatedDesc } from '@/utils/sort';
import type { ExpenseRecord, IncomeRecord, MonthlyReward, TransactionEditTarget } from '@/types';

const props = withDefaults(
  defineProps<{
    initialMonth?: string;
  }>(),
  {
    initialMonth: () => getCurrentMonthString(),
  }
);

const emit = defineEmits<{
  (e: 'edit', target: TransactionEditTarget): void;
}>();

// 當前選取之月份
const selectedMonth = ref<string>(props.initialMonth);

watch(
  () => props.initialMonth,
  (newVal) => {
    if (newVal) selectedMonth.value = newVal;
  }
);

// 篩選與搜尋狀態
const selectedCategory = ref<string>('');
const selectedPaymentMethod = ref<string>('');
const searchKeyword = ref<string>('');
const dbCategories = ref<string[]>([]);
const dbPaymentMethods = ref<string[]>([]);

// 資料狀態
const expenses = ref<ExpenseRecord[]>([]);
const incomes = ref<IncomeRecord[]>([]);
const rewards = ref<MonthlyReward[]>([]);
const isLoading = ref(false);

/**
 * 載入所有資料庫記錄與分類、支付方式清單
 */
async function loadData() {
  isLoading.value = true;
  try {
    const [expList, incList, rewList, catList, pmList] = await Promise.all([
      getExpenses(),
      getIncomes(),
      getRewards(),
      getCategories(),
      getPaymentMethods(),
    ]);
    expenses.value = expList;
    incomes.value = incList;
    rewards.value = rewList;
    dbCategories.value = catList.map((c) => c.name);
    dbPaymentMethods.value = pmList;
  } finally {
    isLoading.value = false;
  }
}

onMounted(async () => {
  await loadData();
});

/**
 * 彙整歷史記錄與資料庫中所有可用之分類名稱（去重清單）
 */
const filterCategories = computed(() => {
  const set = new Set<string>();
  for (const c of dbCategories.value) {
    if (c) set.add(c);
  }
  for (const exp of expenses.value) {
    if (exp.items) {
      for (const it of exp.items) {
        if (it.category) set.add(it.category);
      }
    }
  }
  for (const inc of incomes.value) {
    if (inc.category) set.add(inc.category);
  }
  return sortStringsNaturally(Array.from(set));
});

/**
 * 彙整歷史記錄與資料庫中所有可用之支付方式名稱（去重清單）
 */
const filterPaymentMethods = computed(() => {
  const set = new Set<string>();
  for (const pm of dbPaymentMethods.value) {
    if (pm) set.add(pm);
  }
  for (const exp of expenses.value) {
    if (exp.paymentMethod) set.add(exp.paymentMethod);
  }
  return sortStringsNaturally(Array.from(set));
});

/**
 * 當月過濾後之支出清單（結合月份、分類、支付方式與關鍵字搜尋，並依日期及寫入順序降冪排序）
 */
const currentMonthExpenses = computed(() => {
  return expenses.value
    .filter((e) => {
      // 1. 月份過濾
      if (!e.date?.startsWith(selectedMonth.value)) return false;

      // 2. 分類過濾
      if (selectedCategory.value) {
        const matchCat = e.items?.some((it) => it.category === selectedCategory.value);
        if (!matchCat) return false;
      }

      // 3. 支付方式過濾
      if (selectedPaymentMethod.value && e.paymentMethod !== selectedPaymentMethod.value) {
        return false;
      }

      // 4. 關鍵字搜尋 (店家、品項、備註)
      if (searchKeyword.value.trim()) {
        const kw = searchKeyword.value.trim().toLowerCase();
        const matchMerchant = e.merchant?.toLowerCase().includes(kw);
        const matchNote = e.note?.toLowerCase().includes(kw);
        const matchItems = e.items?.some((it) => it.name?.toLowerCase().includes(kw));
        if (!matchMerchant && !matchNote && !matchItems) return false;
      }

      return true;
    })
    .sort(compareByDateAndCreatedDesc);
});

/**
 * 當月過濾後之收入清單（結合月份、分類、支付方式與關鍵字搜尋，並依日期及寫入順序降冪排序）
 */
const currentMonthIncomes = computed(() => {
  return incomes.value
    .filter((i) => {
      // 1. 月份過濾
      if (!i.date?.startsWith(selectedMonth.value)) return false;

      // 2. 分類過濾
      if (selectedCategory.value && i.category !== selectedCategory.value) {
        return false;
      }

      // 3. 支付方式過濾 (收入無特定支付方式，若有選擇特定支付方式則排除)
      if (selectedPaymentMethod.value) return false;

      // 4. 關鍵字搜尋 (來源、分類、備註)
      if (searchKeyword.value.trim()) {
        const kw = searchKeyword.value.trim().toLowerCase();
        const matchSource = i.source?.toLowerCase().includes(kw);
        const matchCategory = i.category?.toLowerCase().includes(kw);
        const matchNote = i.note?.toLowerCase().includes(kw);
        if (!matchSource && !matchCategory && !matchNote) return false;
      }

      return true;
    })
    .sort(compareByDateAndCreatedDesc);
});

/**
 * 當月過濾後之回饋清單（結合月份、分類、支付方式與關鍵字搜尋，並依年月及寫入順序降冪排序）
 */
const currentMonthRewards = computed(() => {
  return rewards.value
    .filter((r) => {
      // 1. 月份過濾
      if (!r.yearMonth?.startsWith(selectedMonth.value)) return false;

      // 2. 分類過濾 (回饋無特定分類，若有選擇特定分類則排除)
      if (selectedCategory.value) return false;

      // 3. 支付方式過濾 (回饋無特定支付方式，若有選擇特定支付方式則排除)
      if (selectedPaymentMethod.value) return false;

      // 4. 關鍵字搜尋 (來源、備註)
      if (searchKeyword.value.trim()) {
        const kw = searchKeyword.value.trim().toLowerCase();
        const matchSource = r.sourceName?.toLowerCase().includes(kw);
        const matchNote = r.note?.toLowerCase().includes(kw);
        if (!matchSource && !matchNote) return false;
      }

      return true;
    })
    .sort(compareByDateAndCreatedDesc);
});

/**
 * 當月總支出
 * 若有篩選特定分類，僅累加命中該分類之品項小計金額；未篩選特定分類時依每筆總額累加
 */
const totalExpense = computed(() => {
  if (selectedCategory.value) {
    return currentMonthExpenses.value.reduce((sum, e) => {
      const catSum = (e.items || [])
        .filter((it) => it.category === selectedCategory.value)
        .reduce(
          (itemSum, it) =>
            itemSum +
            (Number(it.subtotal) ||
              (Number(it.quantity) || 1) * (Number(it.unitPrice) || 0)),
          0
        );
      return sum + catSum;
    }, 0);
  }
  return currentMonthExpenses.value.reduce((sum, e) => sum + (e.totalAmount || 0), 0);
});

/**
 * 當月總收入 (含回饋)
 */
const totalIncome = computed(() => {
  const incSum = currentMonthIncomes.value.reduce((sum, i) => sum + (i.amount || 0), 0);
  const rewSum = currentMonthRewards.value.reduce((sum, r) => sum + (r.amount || 0), 0);
  return incSum + rewSum;
});

/**
 * 當月結餘
 */
const monthBalance = computed(() => {
  return totalIncome.value - totalExpense.value;
});

/**
 * 切換至上一個月
 */
function prevMonth() {
  selectedMonth.value = shiftMonth(selectedMonth.value, -1);
}

/**
 * 切換至下一個月
 */
function nextMonth() {
  selectedMonth.value = shiftMonth(selectedMonth.value, 1);
}

/**
 * 刪除項目
 */
async function handleDelete(type: 'expense' | 'income' | 'reward', id?: number) {
  if (!id) return;
  const confirmed = window.confirm('確定要刪除此筆記錄嗎？');
  if (!confirmed) return;

  if (type === 'expense') {
    await deleteExpense(id);
  } else if (type === 'income') {
    await deleteIncome(id);
  } else if (type === 'reward') {
    await deleteReward(id);
  }

  await loadData();
}

/**
 * 開啟編輯：發送事件至根層，切換為「記帳」頁籤完整編輯
 */
function handleEdit(
  type: 'expense' | 'income' | 'reward',
  item: ExpenseRecord | IncomeRecord | MonthlyReward
): void {
  if (type === 'expense') {
    emit('edit', { type: 'expense', data: item as ExpenseRecord });
  } else if (type === 'income') {
    emit('edit', { type: 'income', data: item as IncomeRecord });
  } else {
    emit('edit', { type: 'reward', data: item as MonthlyReward });
  }
}

/**
 * 統一明細列表渲染項目介面
 */
interface DisplayTransactionItem {
  key: string;
  type: 'expense' | 'income' | 'reward';
  id?: number;
  raw: ExpenseRecord | IncomeRecord | MonthlyReward;
  title: string;
  dateLabel: string;
  categoryBadge?: string;
  itemsSummary?: ExpenseRecord['items'];
  note?: string;
  amountText: string;
  amountClass: string;
  accentBorderClass: string;
  editAriaLabel: string;
  deleteAriaLabel: string;
}

/**
 * 彙整當月支出、收入與回饋為統一排版清單，確保欄位對齊與視覺樣式一致
 */
const displayTransactions = computed<DisplayTransactionItem[]>(() => {
  const expItems: DisplayTransactionItem[] = currentMonthExpenses.value.map((exp) => ({
    key: `exp-${exp.id}`,
    type: 'expense',
    id: exp.id,
    raw: exp,
    title: exp.merchant,
    dateLabel: exp.date,
    itemsSummary: exp.items,
    note: exp.note,
    amountText: `-NT$ ${formatAmount(getDisplayExpenseAmount(exp))}`,
    amountClass: 'text-rose-600',
    accentBorderClass: 'border-l-rose-500',
    editAriaLabel: '編輯此筆支出',
    deleteAriaLabel: '刪除此筆支出',
  }));

  const incItems: DisplayTransactionItem[] = currentMonthIncomes.value.map((inc) => ({
    key: `inc-${inc.id}`,
    type: 'income',
    id: inc.id,
    raw: inc,
    title: inc.source,
    dateLabel: inc.date,
    categoryBadge: inc.category,
    note: inc.note,
    amountText: `+NT$ ${formatAmount(inc.amount)}`,
    amountClass: 'text-emerald-600',
    accentBorderClass: 'border-l-emerald-500',
    editAriaLabel: '編輯此筆收入',
    deleteAriaLabel: '刪除此筆收入',
  }));

  const rewItems: DisplayTransactionItem[] = currentMonthRewards.value.map((rew) => ({
    key: `rew-${rew.id}`,
    type: 'reward',
    id: rew.id,
    raw: rew,
    title: rew.sourceName,
    dateLabel: rew.yearMonth,
    note: rew.note,
    amountText: `+NT$ ${formatAmount(rew.amount)}`,
    amountClass: 'text-blue-600',
    accentBorderClass: 'border-l-blue-500',
    editAriaLabel: '編輯此筆回饋',
    deleteAriaLabel: '刪除此筆回饋',
  }));

  return [...expItems, ...incItems, ...rewItems];
});

/**
 * 取得指定支出記錄在當前分類篩選下的顯示金額
 * 若有篩選特定分類，回傳命中該分類之品項小計；否則回傳整筆記錄之 totalAmount
 *
 * @param exp - 支出記錄物件
 * @returns 該筆記錄對應之支出金額
 */
function getDisplayExpenseAmount(exp: ExpenseRecord): number {
  if (selectedCategory.value) {
    return (exp.items || [])
      .filter((it) => it.category === selectedCategory.value)
      .reduce(
        (sum, it) =>
          sum +
          (Number(it.subtotal) ||
            (Number(it.quantity) || 1) * (Number(it.unitPrice) || 0)),
        0
      );
  }
  return exp.totalAmount || 0;
}

/**
 * 格式化金額為千分位字串
 */
function formatAmount(num: number): string {
  return (Number(num) || 0).toLocaleString();
}
</script>

<template>
  <div class="space-y-4">
    <!-- 頂部月份導覽與小計摘要 -->
    <div class="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 space-y-3">
      <div class="flex items-center justify-between">
        <button
          type="button"
          class="btn-prev-month px-3 py-1.5 text-xs font-semibold text-teal-700 bg-teal-50 hover:bg-teal-100 rounded-lg transition-colors flex items-center gap-1"
          aria-label="上一個月"
          @click="prevMonth"
        >
          ◀ 上月
        </button>

        <div class="flex items-center gap-1.5">
          <input
            id="list-month-selector"
            v-model="selectedMonth"
            type="month"
            class="month-select text-sm font-bold text-slate-800 border border-slate-200 rounded-lg px-2.5 py-1 focus:ring-2 focus:ring-teal-500 focus:outline-none"
          />
        </div>

        <button
          type="button"
          class="btn-next-month px-3 py-1.5 text-xs font-semibold text-teal-700 bg-teal-50 hover:bg-teal-100 rounded-lg transition-colors flex items-center gap-1"
          aria-label="下一個月"
          @click="nextMonth"
        >
          下月 ▶
        </button>
      </div>

      <!-- 當月統計卡片 -->
      <div class="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100 text-center">
        <div class="p-2 bg-slate-50 rounded-xl">
          <span class="block text-[11px] text-slate-400">當月支出</span>
          <span class="text-sm font-extrabold text-rose-600">NT$ {{ formatAmount(totalExpense) }}</span>
        </div>
        <div class="p-2 bg-slate-50 rounded-xl">
          <span class="block text-[11px] text-slate-400">當月收入</span>
          <span class="text-sm font-extrabold text-emerald-600">NT$ {{ formatAmount(totalIncome) }}</span>
        </div>
        <div class="p-2 bg-slate-50 rounded-xl">
          <span class="block text-[11px] text-slate-400">當月結餘</span>
          <span
            class="text-sm font-extrabold"
            :class="monthBalance >= 0 ? 'text-teal-700' : 'text-rose-500'"
          >
            NT$ {{ formatAmount(monthBalance) }}
          </span>
        </div>
      </div>

      <!-- 分類、支付方式篩選與關鍵字搜尋列 -->
      <div class="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100">
        <div>
          <select
            id="filter-category"
            v-model="selectedCategory"
            aria-label="篩選分類"
            class="w-full text-xs border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
          >
            <option value="">全部分類</option>
            <option v-for="cat in filterCategories" :key="cat" :value="cat">
              {{ cat }}
            </option>
          </select>
        </div>
        <div>
          <select
            id="filter-payment-method"
            v-model="selectedPaymentMethod"
            aria-label="篩選支付方式"
            class="w-full text-xs border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
          >
            <option value="">全部支付方式</option>
            <option v-for="pm in filterPaymentMethods" :key="pm" :value="pm">
              {{ pm }}
            </option>
          </select>
        </div>
        <div class="col-span-2">
          <input
            id="filter-keyword"
            v-model="searchKeyword"
            type="text"
            placeholder="搜尋店家、品項或備註..."
            class="w-full text-xs border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
          />
        </div>
      </div>
    </div>

    <!-- 當月明細列表清單 -->
    <div class="space-y-2">
      <!-- 若該月份無任何記錄 -->
      <div
        v-if="displayTransactions.length === 0"
        class="bg-white rounded-2xl p-8 text-center text-slate-400 text-xs border border-slate-100"
      >
        <span>{{ selectedMonth }} 尚無任何收支記錄</span>
      </div>

      <!-- 統一收支回饋明細列表（以左側色條與金額顏色區分型態，固定欄位寬度對齊） -->
      <div
        v-for="tx in displayTransactions"
        :key="tx.key"
        class="bg-white rounded-xl p-3.5 border border-slate-100 border-l-4 shadow-sm flex items-center gap-3"
        :class="tx.accentBorderClass"
      >
        <!-- 左側：商店/來源名稱（收入分類置於上方）、商品明細與備註 -->
        <div class="flex-1 min-w-0 space-y-1">
          <div class="flex flex-col items-start gap-0.5 min-w-0">
            <span
              v-if="tx.categoryBadge"
              class="text-[11px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded"
            >
              {{ tx.categoryBadge }}
            </span>
            <span class="text-xs font-bold text-slate-800 truncate w-full" :title="tx.title">{{ tx.title }}</span>
          </div>

          <!-- 商品明細展示（一筆一行，最多顯示前三筆，超過顯示 ...） -->
          <div v-if="tx.itemsSummary && tx.itemsSummary.length > 0" class="text-[11px] text-slate-500 space-y-0.5">
            <div v-for="(it, iIdx) in tx.itemsSummary.slice(0, 3)" :key="it.id || iIdx" class="truncate">
              {{ it.name }} ({{ it.quantity }}x${{ it.unitPrice }})
            </div>
            <div v-if="tx.itemsSummary.length > 3" class="text-slate-400 leading-none">...</div>
          </div>

          <p v-if="tx.note" class="text-[11px] text-slate-400 italic truncate">備註：{{ tx.note }}</p>
        </div>

        <!-- 中右：日期與總金額垂直排列（靠右對齊） -->
        <div class="flex flex-col items-end justify-center gap-0.5 shrink-0 text-right min-w-[88px] tabular-nums">
          <span class="text-[11px] text-slate-400">{{ tx.dateLabel }}</span>
          <span class="text-sm font-extrabold whitespace-nowrap" :class="tx.amountClass">
            {{ tx.amountText }}<span v-if="tx.type === 'expense' && selectedCategory" class="block text-[11px] font-normal text-rose-500">({{ selectedCategory }})</span>
          </span>
        </div>

        <!-- 最右側：編輯與刪除按鈕垂直排列，以符號取代文字 -->
        <div class="flex flex-col items-center justify-center gap-1 shrink-0">
          <button
            type="button"
            class="btn-edit p-1.5 rounded-lg text-teal-600 hover:text-teal-800 hover:bg-teal-50 transition-colors"
            :aria-label="tx.editAriaLabel"
            title="編輯"
            @click="handleEdit(tx.type, tx.raw)"
          >
            <Pencil class="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="btn-delete p-1.5 rounded-lg text-rose-500 hover:text-rose-700 hover:bg-rose-50 transition-colors"
            :aria-label="tx.deleteAriaLabel"
            title="刪除"
            @click="handleDelete(tx.type, tx.id)"
          >
            <Trash2 class="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
