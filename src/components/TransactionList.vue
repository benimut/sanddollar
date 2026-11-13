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
import {
  getExpenses,
  getIncomes,
  getRewards,
  getCategories,
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
const searchKeyword = ref<string>('');
const dbCategories = ref<string[]>([]);

// 資料狀態
const expenses = ref<ExpenseRecord[]>([]);
const incomes = ref<IncomeRecord[]>([]);
const rewards = ref<MonthlyReward[]>([]);
const isLoading = ref(false);

/**
 * 載入所有資料庫記錄與分類清單
 */
async function loadData() {
  isLoading.value = true;
  try {
    const [expList, incList, rewList, catList] = await Promise.all([
      getExpenses(),
      getIncomes(),
      getRewards(),
      getCategories(),
    ]);
    expenses.value = expList;
    incomes.value = incList;
    rewards.value = rewList;
    dbCategories.value = catList.map((c) => c.name);
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
 * 當月過濾後之支出清單（結合月份、分類與關鍵字搜尋，並依日期及寫入順序降冪排序）
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

      // 3. 關鍵字搜尋 (店家、品項、備註)
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
 * 當月過濾後之收入清單（結合月份、分類與關鍵字搜尋，並依日期及寫入順序降冪排序）
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

      // 3. 關鍵字搜尋 (來源、分類、備註)
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
 * 當月過濾後之回饋清單（結合月份、分類與關鍵字搜尋，並依年月及寫入順序降冪排序）
 */
const currentMonthRewards = computed(() => {
  return rewards.value
    .filter((r) => {
      // 1. 月份過濾
      if (!r.yearMonth?.startsWith(selectedMonth.value)) return false;

      // 2. 分類過濾 (回饋無特定分類，若有選擇特定分類則排除)
      if (selectedCategory.value) return false;

      // 3. 關鍵字搜尋 (來源、備註)
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
function handleEdit(type: 'expense', item: ExpenseRecord): void;
function handleEdit(type: 'income', item: IncomeRecord): void;
function handleEdit(type: 'reward', item: MonthlyReward): void;
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

      <!-- 分類篩選與關鍵字搜尋列 -->
      <div class="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100">
        <div>
          <select
            id="filter-category"
            v-model="selectedCategory"
            class="w-full text-xs border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
          >
            <option value="">全部分類</option>
            <option v-for="cat in filterCategories" :key="cat" :value="cat">
              {{ cat }}
            </option>
          </select>
        </div>
        <div>
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
        v-if="
          currentMonthExpenses.length === 0 &&
          currentMonthIncomes.length === 0 &&
          currentMonthRewards.length === 0
        "
        class="bg-white rounded-2xl p-8 text-center text-slate-400 text-xs border border-slate-100"
      >
        <span>{{ selectedMonth }} 尚無任何收支記錄</span>
      </div>

      <!-- 支出記錄列表 -->
      <div
        v-for="exp in currentMonthExpenses"
        :key="`exp-${exp.id}`"
        class="bg-white rounded-xl p-3.5 border border-slate-100 shadow-sm flex items-center justify-between"
      >
        <div class="space-y-0.5">
          <div class="flex items-center gap-1.5">
            <span class="text-[11px] bg-rose-50 text-rose-600 px-1.5 py-0.5 rounded font-semibold">支出</span>
            <span class="text-xs font-bold text-slate-800">{{ exp.merchant }}</span>
            <span class="text-[11px] text-slate-400">{{ exp.date }}</span>
          </div>
          <!-- 商品明細展示 -->
          <div v-if="exp.items && exp.items.length > 0" class="text-[11px] text-slate-500">
            <span v-for="(it, iIdx) in exp.items" :key="it.id || iIdx" class="mr-2">
              {{ it.name }} ({{ it.quantity }}x${{ it.unitPrice }})
            </span>
          </div>
          <p v-if="exp.note" class="text-[11px] text-slate-400 italic">備註：{{ exp.note }}</p>
        </div>

        <div class="flex items-center gap-3">
          <span class="text-sm font-extrabold text-rose-600">
            -NT$ {{ formatAmount(getDisplayExpenseAmount(exp)) }}<span v-if="selectedCategory" class="text-xs font-normal text-rose-500 ml-1">({{ selectedCategory }})</span>
          </span>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="btn-edit text-xs text-teal-600 hover:text-teal-800 font-medium px-2 py-1 rounded hover:bg-teal-50"
              @click="handleEdit('expense', exp)"
            >
              編輯
            </button>
            <button
              type="button"
              class="btn-delete text-xs text-rose-500 hover:text-rose-700 font-medium px-2 py-1 rounded hover:bg-rose-50"
              aria-label="刪除此筆支出"
              @click="handleDelete('expense', exp.id)"
            >
              刪除
            </button>
          </div>
        </div>
      </div>

      <!-- 收入記錄列表 -->
      <div
        v-for="inc in currentMonthIncomes"
        :key="`inc-${inc.id}`"
        class="bg-white rounded-xl p-3.5 border border-slate-100 shadow-sm flex items-center justify-between"
      >
        <div class="space-y-0.5">
          <div class="flex items-center gap-1.5">
            <span class="text-[11px] bg-emerald-50 text-emerald-600 px-1.5 py-0.5 rounded font-semibold">收入</span>
            <span class="text-xs font-bold text-slate-800">{{ inc.source }}</span>
            <span class="text-[11px] bg-slate-100 text-slate-600 px-1.5 py-0.2 rounded">{{ inc.category }}</span>
            <span class="text-[11px] text-slate-400">{{ inc.date }}</span>
          </div>
          <p v-if="inc.note" class="text-[11px] text-slate-400 italic">備註：{{ inc.note }}</p>
        </div>

        <div class="flex items-center gap-3">
          <span class="text-sm font-extrabold text-emerald-600">+NT$ {{ formatAmount(inc.amount) }}</span>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="btn-edit text-xs text-teal-600 hover:text-teal-800 font-medium px-2 py-1 rounded hover:bg-teal-50"
              @click="handleEdit('income', inc)"
            >
              編輯
            </button>
            <button
              type="button"
              class="btn-delete text-xs text-rose-500 hover:text-rose-700 font-medium px-2 py-1 rounded hover:bg-rose-50"
              aria-label="刪除此筆收入"
              @click="handleDelete('income', inc.id)"
            >
              刪除
            </button>
          </div>
        </div>
      </div>

      <!-- 回饋記錄列表 -->
      <div
        v-for="rew in currentMonthRewards"
        :key="`rew-${rew.id}`"
        class="bg-white rounded-xl p-3.5 border border-slate-100 shadow-sm flex items-center justify-between"
      >
        <div class="space-y-0.5">
          <div class="flex items-center gap-1.5">
            <span class="text-[11px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded font-semibold">回饋</span>
            <span class="text-xs font-bold text-slate-800">{{ rew.sourceName }}</span>
            <span class="text-[11px] text-slate-400">{{ rew.yearMonth }}</span>
          </div>
          <p v-if="rew.note" class="text-[11px] text-slate-400 italic">備註：{{ rew.note }}</p>
        </div>

        <div class="flex items-center gap-3">
          <span class="text-sm font-extrabold text-blue-600">+NT$ {{ formatAmount(rew.amount) }}</span>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="btn-edit text-xs text-teal-600 hover:text-teal-800 font-medium px-2 py-1 rounded hover:bg-teal-50"
              @click="handleEdit('reward', rew)"
            >
              編輯
            </button>
            <button
              type="button"
              class="btn-delete text-xs text-rose-500 hover:text-rose-700 font-medium px-2 py-1 rounded hover:bg-rose-50"
              aria-label="刪除此筆回饋"
              @click="handleDelete('reward', rew.id)"
            >
              刪除
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
