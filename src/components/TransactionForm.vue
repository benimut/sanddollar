<script setup lang="ts">
/**
 * @file TransactionForm.vue
 * @description 記帳主表單外層 Shell 容器元件
 *
 * 核心架構職責：
 * 1. 模式切換管理：提供「支出 (Expense)」、「收入 (Income)」與「回饋 (Reward)」頂層頁籤切換 (#tab-expense, #tab-income, #tab-reward)。
 * 2. 模組化容器解耦：依據當前選取模式，動態切換渲染 ExpenseForm.vue、IncomeForm.vue 或 RewardForm.vue 子表單。
 * 3. 跨表單通知中心：監聽子表單觸發之 saved 事件，管理成功提示訊息 (globalSuccessMessage) 與自動計時淡出。
 */

import { ref, onUnmounted, watch } from 'vue';
import ExpenseForm from './ExpenseForm.vue';
import IncomeForm from './IncomeForm.vue';
import RewardForm from './RewardForm.vue';
import type { ExpenseRecord, IncomeRecord, MonthlyReward, TransactionEditTarget } from '@/types';

const props = defineProps<{
  editTarget?: TransactionEditTarget | null;
}>();

const emit = defineEmits<{
  (e: 'saved', payload: TransactionEditTarget): void;
  (e: 'cancel'): void;
}>();

/** 當前表單模式：'expense' 支出、'income' 收入、'reward' 回饋 */
const mode = ref<'expense' | 'income' | 'reward'>('expense');

watch(
  () => props.editTarget,
  (target) => {
    if (target) {
      mode.value = target.type;
    }
  },
  { immediate: true }
);

/** 頂層全域成功通知提示字串（留空表示無通知） */
const globalSuccessMessage = ref('');

/** 定時器句柄，用於防抖重置與生命週期清理 */
let successTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 統籌顯示成功通知訊息，3 秒後自動隱藏；若連續觸發則重置計時
 *
 * @param msg - 欲呈現之成功提示字串
 */
function showSuccessNotice(msg: string): void {
  globalSuccessMessage.value = msg;
  if (successTimer) {
    clearTimeout(successTimer);
  }
  successTimer = setTimeout(() => {
    globalSuccessMessage.value = '';
    successTimer = null;
  }, 3000);
}

/**
 * 統一處理各類型交易儲存完成事件 (handleSaved)
 */
function handleSaved(type: 'expense', record: ExpenseRecord): void;
function handleSaved(type: 'income', record: IncomeRecord): void;
function handleSaved(type: 'reward', record: MonthlyReward): void;
function handleSaved(
  type: 'expense' | 'income' | 'reward',
  record: ExpenseRecord | IncomeRecord | MonthlyReward
): void {
  const labelMap = { expense: '支出', income: '收入', reward: '回饋' } as const;
  showSuccessNotice(`${labelMap[type]}已成功儲存！`);
  emit('saved', { type, data: record } as TransactionEditTarget);
}

// 元件卸載時清除未完成之定時器，杜絕記憶體洩漏
onUnmounted(() => {
  if (successTimer) {
    clearTimeout(successTimer);
    successTimer = null;
  }
});
</script>

<template>
  <div class="space-y-4">
    <!-- 頂部模式切換 Tabs：支出 / 收入 / 回饋 -->
    <div class="flex rounded-xl bg-slate-200 p-1" role="tablist">
      <button
        id="tab-expense"
        type="button"
        role="tab"
        :aria-selected="mode === 'expense'"
        class="flex-1 py-2 text-sm font-semibold rounded-lg transition-all"
        :class="mode === 'expense' ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'"
        @click="mode = 'expense'"
      >
        支出
      </button>
      <button
        id="tab-income"
        type="button"
        role="tab"
        :aria-selected="mode === 'income'"
        class="flex-1 py-2 text-sm font-semibold rounded-lg transition-all"
        :class="mode === 'income' ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'"
        @click="mode = 'income'"
      >
        收入
      </button>
      <button
        id="tab-reward"
        type="button"
        role="tab"
        :aria-selected="mode === 'reward'"
        class="flex-1 py-2 text-sm font-semibold rounded-lg transition-all"
        :class="mode === 'reward' ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'"
        @click="mode = 'reward'"
      >
        回饋
      </button>
    </div>

    <!-- 容器層成功儲存提示訊息 (當觸發全域事件時顯示) -->
    <div
      v-if="globalSuccessMessage"
      class="bg-emerald-50 text-emerald-700 text-sm p-3 rounded-xl border border-emerald-200 text-center font-medium transition-all"
    >
      {{ globalSuccessMessage }}
    </div>

    <!-- 依據選定模式動態渲染子表單 -->
    <ExpenseForm
      v-if="mode === 'expense'"
      :edit-data="props.editTarget?.type === 'expense' ? props.editTarget.data : null"
      @saved="(rec) => handleSaved('expense', rec)"
      @cancel="emit('cancel')"
    />
    <IncomeForm
      v-else-if="mode === 'income'"
      :edit-data="props.editTarget?.type === 'income' ? props.editTarget.data : null"
      @saved="(rec) => handleSaved('income', rec)"
      @cancel="emit('cancel')"
    />
    <RewardForm
      v-else-if="mode === 'reward'"
      :edit-data="props.editTarget?.type === 'reward' ? props.editTarget.data : null"
      @saved="(rec) => handleSaved('reward', rec)"
      @cancel="emit('cancel')"
    />
  </div>
</template>
