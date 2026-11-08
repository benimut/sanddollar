<script setup lang="ts">
/**
 * @file RewardForm.vue
 * @description 每月點數與現金回饋登記子表單元件
 *
 * 核心業務職責：
 * 1. 登記每月信用卡回饋、點數折抵等進帳：所屬月份、回饋來源與金額。
 * 2. 嚴格邊界防呆：回饋來源不可為空白，金額必須大於 0。
 * 3. 本地 IndexedDB 持久化：呼叫 addReward / updateReward 並觸發 saved 事件。
 */

import { ref, computed, watch, onMounted } from 'vue';
import {
  addReward,
  updateReward,
  getRewards,
  getRewardSourceRecords,
  addRewardSource,
  getDistinctRewardSources,
} from '@/db';
import { getCurrentMonthString } from '@/utils/date';
import type { MonthlyReward } from '@/types';

const props = defineProps<{
  editData?: MonthlyReward | null;
}>();

const emit = defineEmits<{
  (e: 'saved', record: MonthlyReward): void;
  (e: 'cancel'): void;
}>();

/** 是否處於編輯舊記錄模式 */
const isEditMode = computed(() => !!props.editData && !!props.editData.id);

// 歷史回饋來源清單
const distinctRewardSources = ref<string[]>([]);
const isAddingSource = ref(false);
const customSourceName = ref('');
const selectedSourceOption = ref('');

// 表單狀態
const rewardMonth = ref(getCurrentMonthString());
const sourceName = ref('');
const amount = ref<number | ''>('');
const note = ref('');
const errorMessage = ref('');

onMounted(async () => {
  await loadDistinctRewardSources();
});

/**
 * 載入資料庫中既有之回饋來源清單（只讀取回饋來源設定表，絕不聯集歷史表記錄）
 */
async function loadDistinctRewardSources() {
  try {
    distinctRewardSources.value = await getDistinctRewardSources();
  } catch {
    distinctRewardSources.value = [];
  }
}

// 監聽 props.editData 進入編輯模式時帶入資料
watch(
  () => props.editData,
  (data) => {
    if (data) {
      rewardMonth.value = data.yearMonth || getCurrentMonthString();
      sourceName.value = data.sourceName || '';
      selectedSourceOption.value = data.sourceName || '';
      isAddingSource.value = false;
      customSourceName.value = '';
      amount.value = data.amount ?? '';
      note.value = data.note || '';
    }
  },
  { immediate: true }
);

/**
 * 監聽回饋來源選單變更
 */
function handleSourceSelectChange(e: Event) {
  const target = e.target as HTMLSelectElement;
  if (target.value === '__add_new__') {
    isAddingSource.value = true;
    sourceName.value = customSourceName.value;
  } else {
    isAddingSource.value = false;
    sourceName.value = target.value;
  }
}

/**
 * 處理自訂回饋來源輸入
 */
function handleCustomSourceInput(e: Event) {
  const val = (e.target as HTMLInputElement).value;
  customSourceName.value = val;
  sourceName.value = val;
}

/**
 * 清空表單狀態
 */
function resetForm() {
  rewardMonth.value = getCurrentMonthString();
  sourceName.value = '';
  selectedSourceOption.value = '';
  isAddingSource.value = false;
  customSourceName.value = '';
  amount.value = '';
  note.value = '';
  errorMessage.value = '';
}

/**
 * 取消編輯並清空表單至初始狀態
 */
function handleCancelEdit() {
  resetForm();
  emit('cancel');
}

/**
 * 處理儲存回饋登記
 */
async function handleSaveReward() {
  let cleanSource = sourceName.value.trim();
  if (isAddingSource.value && customSourceName.value.trim()) {
    cleanSource = customSourceName.value.trim();
  }
  const numAmount = Number(amount.value) || 0;

  if (!cleanSource || cleanSource === '__add_new__') {
    errorMessage.value = '請輸入回饋來源';
    return;
  }

  if (numAmount <= 0) {
    errorMessage.value = '回饋金額必須大於 0';
    return;
  }

  errorMessage.value = '';

  // 若使用者選取新增來源或自訂輸入名稱非空，自動持久化至回饋來源設定表
  if (isAddingSource.value || (customSourceName.value.trim() && customSourceName.value.trim() === cleanSource)) {
    try {
      await addRewardSource(cleanSource);
    } catch {
      // 忽略已存在或重複錯誤，確保登記流程順暢
    }
  }

  const record: MonthlyReward = {
    yearMonth: rewardMonth.value,
    sourceName: cleanSource,
    amount: numAmount,
    note: note.value.trim() || undefined,
    createdAt: Date.now(),
  };

  if (isEditMode.value && props.editData?.id) {
    await updateReward(props.editData.id, record);
    emit('saved', { ...record, id: props.editData.id });
  } else {
    const newId = await addReward(record);
    resetForm();
    emit('saved', { ...record, id: newId });
  }
}
</script>

<template>
  <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 space-y-4">
    <h2 class="text-base font-bold text-slate-800">
      {{ isEditMode ? '修改回饋記錄' : '每月回饋登記' }}
    </h2>

    <!-- 月份與金額 -->
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label for="reward-month" class="block text-xs font-medium text-slate-500 mb-1">月份</label>
        <input
          id="reward-month"
          v-model="rewardMonth"
          type="month"
          class="w-full text-sm border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
        />
      </div>
      <div>
        <label for="reward-amount" class="block text-xs font-medium text-slate-500 mb-1">金額</label>
        <input
          id="reward-amount"
          v-model.number="amount"
          type="number"
          min="1"
          placeholder="回饋金額"
          class="w-full text-sm border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
        />
      </div>
    </div>

    <!-- 回饋來源 (純選單模式) -->
    <div>
      <label for="reward-source-select" class="block text-xs font-medium text-slate-500 mb-1">回饋來源</label>
      <div class="space-y-2">
        <select
          id="reward-source-select"
          v-model="selectedSourceOption"
          class="w-full text-sm border border-slate-200 rounded-lg p-2 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
          @change="handleSourceSelectChange"
        >
          <option value="">請選擇回饋來源...</option>
          <option v-for="src in distinctRewardSources" :key="src" :value="src">{{ src }}</option>
          <option value="__add_new__">+ 新增回饋來源...</option>
        </select>

        <!-- 自訂回饋來源輸入框 (選取 + 新增回饋來源... 時展開) -->
        <div v-if="isAddingSource" class="mt-1">
          <input
            id="custom-reward-source-input"
            v-model="customSourceName"
            type="text"
            placeholder="輸入新回饋來源名稱"
            class="w-full text-xs border border-teal-300 rounded-lg p-2 bg-teal-50/50 focus:ring-2 focus:ring-teal-500 focus:outline-none"
            @input="handleCustomSourceInput"
          />
        </div>

        <!-- 隱藏原生輸入框保持相容 -->
        <input
          id="reward-source"
          v-model="sourceName"
          type="text"
          class="hidden"
        />
      </div>
    </div>

    <!-- 備註說明 -->
    <div>
      <label for="reward-note" class="block text-xs font-medium text-slate-500 mb-1">備註說明</label>
      <input
        id="reward-note"
        v-model="note"
        type="text"
        placeholder="備註說明（選填）"
        class="w-full text-sm border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
      />
    </div>

    <!-- 錯誤提示 -->
    <p v-if="errorMessage" class="text-xs text-rose-600 font-medium">{{ errorMessage }}</p>

    <!-- 儲存/取消按鈕 -->
    <div class="pt-4 border-t border-slate-100 flex items-center justify-end gap-2">
      <button
        v-if="isEditMode"
        id="btn-cancel-edit"
        type="button"
        class="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-sm rounded-xl transition-all active:scale-95"
        @click="handleCancelEdit"
      >
        取消編輯
      </button>
      <button
        id="btn-submit-reward"
        type="button"
        class="px-6 py-2.5 bg-teal-600 hover:bg-teal-700 text-white font-bold text-sm rounded-xl shadow-md transition-all active:scale-95"
        @click="handleSaveReward"
      >
        {{ isEditMode ? '修改回饋記錄' : '儲存' }}
      </button>
    </div>
  </div>
</template>
