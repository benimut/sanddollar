<script setup lang="ts">
/**
 * @file IncomeForm.vue
 * @description 所得收入表記錄輸入子表單元件
 *
 * 核心業務職責：
 * 1. 國內/海外模式置頂切換（預設國內）。
 * 2. 移除存入帳戶欄位，簡化收入記錄輸入。
 * 3. 分類支援「新增」選項，選中時展開自訂輸入框，未填寫直接儲存自動 fallback 為「其他」。
 * 4. 海外外幣模式排版一致化：將幣別、外幣金額與台幣到帳金額整合於同一區塊內並列展示。
 * 5. 海外手續費輸入與雙幣別切換：支援台幣 (TWD) 或外幣輸入，自動換算等值台幣手續費並寫入 fee。
 * 6. 支援舊記錄編輯模式：帶入歷史資料修改並呼叫 updateIncome。
 */

import { ref, computed, onMounted, watch } from 'vue';
import {
  addIncome,
  updateIncome,
  getDistinctIncomeSources,
  getPreferredIncomeSource,
  getIncomeSourceRecords,
  addIncomeSource,
} from '@/db';
import { useCategories } from '@/composables/useCategories';
import { getTodayDateString } from '@/utils/date';
import { calculateForeignIncome } from '@/utils/currency';
import { sortStringsNaturally } from '@/utils/sort';
import type { IncomeRecord } from '@/types';

const props = defineProps<{
  editData?: IncomeRecord | null;
}>();

const emit = defineEmits<{
  (e: 'saved', record: IncomeRecord): void;
  (e: 'cancel'): void;
}>();

/** 是否處於編輯舊記錄模式 */
const isEditMode = computed(() => !!props.editData && !!props.editData.id);

// ==================== 國內 / 海外切換 ====================
/** 是否為海外外幣收入交易（預設為 false 國內） */
const isForeignIncome = ref(false);

// 歷史收入來源不重複清單
const distinctSources = ref<string[]>([]);
/** 使用者設定的預設收入來源 */
const defaultIncomeSource = ref('');

/** 是否正在新增自訂收入來源 */
const isAddingSource = ref(false);
/** 自訂輸入之新收入來源名稱 */
const customSourceName = ref('');
/** 收入來源下拉選單選取值 */
const selectedSourceOption = ref('');

// ==================== 收入表單狀態 ====================
const incomeDate = ref(getTodayDateString());
const incomeSource = ref('');
const incomeCategory = ref('');

// 使用共用 Composable 管理收入分類
const {
  categories: incomeCategoryList,
  defaultCategory: defaultIncomeCategory,
  showAddCategory,
  newCategoryName,
  categoryError,
  loadCategories,
  handleCreateCategory,
} = useCategories('income', {
  onCreated: (newCat) => {
    incomeCategory.value = newCat;
  },
});

/** 備註說明輸入字串 */
const incomeNote = ref('');

/** 台幣到帳金額 */
const incomeAmount = ref<number | ''>('');

// 海外收入欄位
const foreignIncomeCurrency = ref('USD');
const foreignIncomeAmount = ref<number | ''>('');
const incomeFeeCurrency = ref('TWD');
const incomeFeeAmount = ref<number | ''>('');

// 表單驗證錯誤狀態
const errorMessage = ref('');
const errorField = ref('');

function setValidationError(field: string, message: string): false {
  errorField.value = field;
  errorMessage.value = message;
  return false;
}

function clearValidationError() {
  errorField.value = '';
  errorMessage.value = '';
}

function isBlankOrInvalidNumber(val: unknown): boolean {
  if (val === '' || val === null || val === undefined || typeof val === 'boolean') {
    return true;
  }
  const num = Number(val);
  return Number.isNaN(num) || !Number.isFinite(num);
}

function errorBorderClass(field: string): string {
  return errorField.value === field ? 'border-rose-500 ring-2 ring-rose-200' : '';
}

// ==================== 計算屬性 ====================

/**
 * 折合台幣手續費金額
 */
const calculatedTwdFee = computed(() => {
  if (!isForeignIncome.value) return 0;
  const rawFee = Number(incomeFeeAmount.value) || 0;
  if (rawFee <= 0) return 0;
  if (incomeFeeCurrency.value === 'TWD') {
    return Math.round(rawFee);
  }
  // 外幣手續費依匯率換算為等值台幣手續費
  const fAmt = Number(foreignIncomeAmount.value) || 0;
  const twdAmt = Number(incomeAmount.value) || 0;
  if (fAmt > 0 && twdAmt > 0) {
    const rate = twdAmt / fAmt;
    return Math.round(rawFee * rate);
  }
  return 0;
});

/**
 * 實質換算匯率（含手續費之實際換匯匯率）
 * 完整委託 calculateForeignIncome 共用核心邏輯
 */
const effectiveExchangeRate = computed(() => {
  if (!isForeignIncome.value) return 0;
  const fAmt = Number(foreignIncomeAmount.value) || 0;
  const twdAmt = Number(incomeAmount.value) || 0;
  if (fAmt <= 0 || twdAmt <= 0) return 0;

  const fee = calculatedTwdFee.value;
  const feeRate = twdAmt > 0 && fee > 0 ? fee / twdAmt : 0;
  const res = calculateForeignIncome(fAmt, twdAmt, feeRate);

  // 實質換算匯率：若有手續費則反映等效入帳匯率
  return fAmt > 0 ? (twdAmt + fee) / fAmt : res.effectiveRate;
});

/**
 * 海外收入換算資訊物件
 */
const foreignIncomeCalc = computed(() => {
  if (!isForeignIncome.value) return null;
  const fAmt = Number(foreignIncomeAmount.value) || 0;
  const twdAmt = Number(incomeAmount.value) || 0;
  const fee = calculatedTwdFee.value;
  const feeRate = twdAmt > 0 && fee > 0 ? fee / twdAmt : 0;
  const baseCalc = calculateForeignIncome(fAmt, twdAmt, feeRate);

  return {
    feeAmount: fee,
    effectiveRate: effectiveExchangeRate.value || baseCalc.effectiveRate,
  };
});

const isListsLoaded = ref(false);

/**
 * 編輯模式下比對設定清單，若分類或收入來源已不存在於目前設定清單中則留空
 */
function reconcileEditSelections() {
  if (!isEditMode.value || !isListsLoaded.value) return;

  if (
    incomeCategory.value &&
    incomeCategory.value !== '__add_new__' &&
    !incomeCategoryList.value.includes(incomeCategory.value)
  ) {
    incomeCategory.value = '';
  }

  if (
    selectedSourceOption.value &&
    selectedSourceOption.value !== '__add_new__' &&
    !distinctSources.value.includes(selectedSourceOption.value)
  ) {
    selectedSourceOption.value = '';
    incomeSource.value = '';
  }
}

// 監聽 props.editData 進入編輯模式時完整帶入資料
watch(
  () => props.editData,
  (data) => {
    clearValidationError();
    if (data) {
      incomeDate.value = data.date || '';
      incomeSource.value = data.source || '';
      selectedSourceOption.value = data.source || '';
      incomeCategory.value = data.category || '';
      incomeAmount.value = data.amount ?? '';
      incomeNote.value = data.note || '';
      isForeignIncome.value = !!data.isForeign;
      foreignIncomeCurrency.value = data.currency || 'USD';
      foreignIncomeAmount.value = data.foreignAmount ?? '';
      incomeFeeCurrency.value = 'TWD';
      incomeFeeAmount.value = data.fee ?? '';
      reconcileEditSelections();
    }
  },
  { immediate: true }
);

// ==================== 生命週期與方法 ====================

onMounted(async () => {
  await Promise.all([
    loadDistinctSources(),
    loadCategories(),
  ]);
  isListsLoaded.value = true;
  if (isEditMode.value) {
    reconcileEditSelections();
  } else {
    if (incomeCategoryList.value.length > 0 && !incomeCategory.value) {
      incomeCategory.value = defaultIncomeCategory.value || incomeCategoryList.value[0];
    }
    if (distinctSources.value.length > 0 && !selectedSourceOption.value) {
      const defSource = defaultIncomeSource.value || distinctSources.value[0];
      selectedSourceOption.value = defSource;
      incomeSource.value = defSource;
    }
  }
});

/**
 * 讀取收入來源清單（只讀取收入來源設定表，絕不聯集歷史表記錄）
 */
async function loadDistinctSources() {
  try {
    const [sources, preferred] = await Promise.all([
      getDistinctIncomeSources(),
      getPreferredIncomeSource(),
    ]);
    distinctSources.value = sources;
    defaultIncomeSource.value =
      preferred && sources.includes(preferred) ? preferred : sources[0] || '';
  } catch {
    distinctSources.value = [];
    defaultIncomeSource.value = '';
  }
}

/**
 * 監聽收入來源選單變更
 */
function handleSourceSelectChange(e: Event) {
  const target = e.target as HTMLSelectElement;
  if (target.value === '__add_new__') {
    isAddingSource.value = true;
    incomeSource.value = customSourceName.value;
  } else {
    isAddingSource.value = false;
    incomeSource.value = target.value;
  }
}

/**
 * 處理自訂收入來源文字輸入
 */
function handleCustomSourceInput(e: Event) {
  const val = (e.target as HTMLInputElement).value;
  customSourceName.value = val;
  incomeSource.value = val;
}

/**
 * 監聽收入分類變更，選取「新增」時展開自訂分類輸入框
 */
function handleCategoryChange(e: Event) {
  const target = e.target as HTMLSelectElement;
  if (target.value === '__add_new__') {
    showAddCategory.value = true;
    incomeCategory.value = '';
  }
}

/**
 * 重設表單狀態為初始空白
 */
function resetForm() {
  clearValidationError();
  incomeDate.value = getTodayDateString();
  const defSource = defaultIncomeSource.value || distinctSources.value[0] || '';
  incomeSource.value = defSource;
  customSourceName.value = '';
  selectedSourceOption.value = defSource;
  isAddingSource.value = false;
  incomeAmount.value = '';
  incomeNote.value = '';
  foreignIncomeAmount.value = '';
  incomeFeeAmount.value = '';
  isForeignIncome.value = false;
  showAddCategory.value = false;
  newCategoryName.value = '';
  incomeCategory.value = defaultIncomeCategory.value || incomeCategoryList.value[0] || '';
}

/**
 * 取消編輯舊記錄並通知外部
 */
function handleCancelEdit() {
  resetForm();
  emit('cancel');
}

/**
 * 驗證收入表單所有必填與數值邊界規則
 */
function validateIncomeForm(): boolean {
  clearValidationError();

  if (!incomeDate.value || !incomeDate.value.trim()) {
    return setValidationError('date', '請選擇入帳日期');
  }

  const rawCat = incomeCategory.value?.trim() || '';
  if (showAddCategory.value || rawCat === '__add_new__') {
    if (!newCategoryName.value.trim()) {
      return setValidationError('custom-category', '請輸入新收入分類名稱');
    }
  } else if (!rawCat || !incomeCategoryList.value.includes(rawCat)) {
    return setValidationError('category', '請選擇收入分類');
  }

  const isAddingState = isAddingSource.value || selectedSourceOption.value === '__add_new__';
  if (isAddingState) {
    if (!customSourceName.value.trim()) {
      return setValidationError('custom-source', '請輸入新收入來源名稱');
    }
  } else {
    const rawSrc = selectedSourceOption.value?.trim() || incomeSource.value?.trim() || '';
    if (!rawSrc || !distinctSources.value.includes(rawSrc)) {
      return setValidationError('source', '請選擇收入來源');
    }
  }

  if (isForeignIncome.value) {
    if (isBlankOrInvalidNumber(foreignIncomeAmount.value) || Number(foreignIncomeAmount.value) <= 0) {
      return setValidationError('foreign-amount', '外幣金額必須大於 0');
    }
    if (isBlankOrInvalidNumber(incomeAmount.value) || Number(incomeAmount.value) < 0) {
      return setValidationError('amount', '請輸入台幣到帳金額（可為 0，不可為負數）');
    }
    if (isBlankOrInvalidNumber(incomeFeeAmount.value) || Number(incomeFeeAmount.value) < 0) {
      return setValidationError('fee', '請輸入手續費金額（可為 0，不可為負數）');
    }
  } else {
    if (isBlankOrInvalidNumber(incomeAmount.value) || Number(incomeAmount.value) <= 0) {
      return setValidationError('amount', '收入金額必須大於 0');
    }
  }

  return true;
}

/**
 * 送出儲存收入表記錄
 */
async function handleSaveIncome() {
  if (!validateIncomeForm()) {
    return;
  }

  // 處理自訂分類建立（無 fallback）
  let finalCategory = incomeCategory.value.trim();
  if (showAddCategory.value || !finalCategory || finalCategory === '__add_new__') {
    const cleanCat = newCategoryName.value.trim();
    await handleCreateCategory(cleanCat);
    finalCategory = cleanCat;
  }

  // 處理收入來源（無 fallback）
  let finalSource = '';
  const isAddingState = isAddingSource.value || selectedSourceOption.value === '__add_new__';
  if (isAddingState) {
    finalSource = customSourceName.value.trim();
    try {
      await addIncomeSource(finalSource);
    } catch {
      // 忽略已存在或重複錯誤，確保記帳流程順暢
    }
  } else {
    finalSource = selectedSourceOption.value?.trim() || incomeSource.value.trim();
  }

  const finalAmount = Number(incomeAmount.value);

  const record: IncomeRecord = {
    date: incomeDate.value,
    source: finalSource,
    category: finalCategory,
    amount: finalAmount,
    note: incomeNote.value.trim() || undefined,
    isForeign: isForeignIncome.value,
    currency: isForeignIncome.value ? foreignIncomeCurrency.value : undefined,
    foreignAmount: isForeignIncome.value ? Number(foreignIncomeAmount.value) : undefined,
    fee: isForeignIncome.value ? calculatedTwdFee.value : 0,
    exchangeRate: isForeignIncome.value && effectiveExchangeRate.value > 0 ? effectiveExchangeRate.value : undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (isEditMode.value && props.editData?.id) {
    await updateIncome(props.editData.id, record);
    emit('saved', { ...record, id: props.editData.id });
  } else {
    const newId = await addIncome(record);

    // 若本次有新來源，動態更新歷史來源清單並維持自然文字排序
    if (record.source && !distinctSources.value.includes(record.source)) {
      distinctSources.value = sortStringsNaturally([...distinctSources.value, record.source]);
    }

    resetForm();
    emit('saved', { ...record, id: newId });
  }
}
</script>

<template>
  <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 space-y-4">
    <!-- 1. 國內 / 海外切換按鈕（首項置頂） -->
    <input type="checkbox" v-model="isForeignIncome" class="hidden" />
    <button id="btn-add-income-category" type="button" class="hidden" @click="showAddCategory = true">+ 自訂分類</button>
    <div class="mode-switch flex rounded-xl bg-slate-100 p-1" role="radiogroup" aria-label="收入地區模式">
      <button
        type="button"
        class="flex-1 py-1.5 text-xs font-bold rounded-lg transition-all"
        :class="!isForeignIncome ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'"
        @click="isForeignIncome = false"
      >
        國內
      </button>
      <button
        type="button"
        class="flex-1 py-1.5 text-xs font-bold rounded-lg transition-all"
        :class="isForeignIncome ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'"
        @click="isForeignIncome = true"
      >
        海外
      </button>
    </div>

    <h2 class="text-base font-bold text-slate-800">收入記錄</h2>

    <!-- 入帳日期與分類 -->
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label for="income-date" class="block text-xs font-medium text-slate-500 mb-1">入帳日期</label>
        <input
          id="income-date"
          v-model="incomeDate"
          type="date"
          :class="errorBorderClass('date')"
          class="w-full text-sm border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
        />
      </div>
      <div>
        <label for="income-category" class="block text-xs font-medium text-slate-500 mb-1">分類</label>
        <select
          id="income-category"
          v-model="incomeCategory"
          name="category"
          :class="errorBorderClass('category')"
          class="w-full text-sm border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
          @change="handleCategoryChange"
        >
          <option v-for="cat in incomeCategoryList" :key="cat" :value="cat">{{ cat }}</option>
          <option value="__add_new__">+ 新增分類...</option>
        </select>
      </div>
    </div>

    <!-- 自訂收入分類展開輸入區 (選取新增時展開) -->
    <div
      v-if="showAddCategory"
      class="p-3 bg-teal-50/70 rounded-xl border border-teal-200 space-y-2"
    >
      <label for="custom-income-category-input" class="block text-xs font-semibold text-teal-900">新增收入分類</label>
      <div class="flex items-center gap-2">
        <input
          id="custom-income-category-input"
          v-model="newCategoryName"
          type="text"
          placeholder="輸入新收入分類名稱"
          :class="errorBorderClass('custom-category')"
          class="flex-1 text-xs border border-slate-300 rounded-lg p-2 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
        />
        <button
          id="btn-confirm-income-category"
          type="button"
          class="text-xs bg-teal-600 hover:bg-teal-700 text-white font-semibold px-3 py-2 rounded-lg transition-colors"
          @click="handleCreateCategory"
        >
          確認新增
        </button>
        <button
          type="button"
          class="text-xs text-slate-500 hover:text-slate-700 px-2 py-2"
          @click="showAddCategory = false; newCategoryName = ''; categoryError = ''"
        >
          取消
        </button>
      </div>
      <p v-if="categoryError" class="text-xs text-rose-600 font-medium">{{ categoryError }}</p>
    </div>

    <!-- 收入來源 (支援下拉選取與 + 新增收入來源，並維持 #income-source 與 datalist 向下相容) -->
    <div>
      <label for="income-source-select" class="block text-xs font-medium text-slate-500 mb-1">收入來源</label>
      <div class="space-y-2">
        <select
          id="income-source-select"
          v-model="selectedSourceOption"
          name="income-source-select"
          :class="errorBorderClass('source')"
          class="w-full text-sm border border-slate-200 rounded-lg p-2 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
          @change="handleSourceSelectChange"
        >
          <option v-for="src in distinctSources" :key="src" :value="src">{{ src }}</option>
          <option value="__add_new__">+ 新增收入來源...</option>
        </select>

        <!-- 自訂收入來源輸入框 (當選取 + 新增來源 時展開) -->
        <div v-if="isAddingSource" class="mt-1">
          <input
            id="custom-income-source-input"
            v-model="customSourceName"
            type="text"
            placeholder="輸入新收入來源名稱"
            :class="errorBorderClass('custom-source')"
            class="w-full text-xs border border-teal-300 rounded-lg p-2 bg-teal-50/50 focus:ring-2 focus:ring-teal-500 focus:outline-none"
            @input="handleCustomSourceInput"
          />
        </div>

        <!-- 保持規格契約與 DOM Selector 相容之 #income-source 輸入框 -->
        <!-- 保持 DOM Selector 相容之 #income-source 輸入框（平時純選單模式不顯示常駐輸入框） -->
        <input
          id="income-source"
          v-model="incomeSource"
          type="text"
          list="income-source-list"
          placeholder="收入來源"
          class="hidden"
        />

        <datalist id="income-source-list">
          <option v-for="src in distinctSources" :key="src" :value="src">{{ src }}</option>
        </datalist>
      </div>
    </div>

    <!-- 海外外幣收入一致化區塊 (若開啟海外模式) -->
    <div v-if="isForeignIncome" class="foreign-inputs-grid bg-blue-50/60 border border-blue-200 rounded-xl p-3.5 space-y-3">
      <div class="grid grid-cols-3 gap-2">
        <div>
          <label for="foreign-income-currency" class="block text-xs font-medium text-slate-600 mb-1">外幣幣別</label>
          <select
            id="foreign-income-currency"
            v-model="foreignIncomeCurrency"
            name="currency"
            class="w-full text-sm border border-slate-200 rounded-lg p-2 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
          >
            <option value="USD">USD 美元</option>
            <option value="JPY">JPY 日圓</option>
            <option value="EUR">EUR 歐元</option>
            <option value="GBP">GBP 英鎊</option>
            <option value="CNY">CNY 人民幣</option>
          </select>
        </div>
        <div>
          <label for="foreign-income-amount" class="block text-xs font-medium text-slate-600 mb-1">外幣金額</label>
          <input
            id="foreign-income-amount"
            v-model.number="foreignIncomeAmount"
            type="number"
            step="any"
            placeholder="外幣金額"
            :class="errorBorderClass('foreign-amount')"
            class="w-full text-sm border border-slate-200 rounded-lg p-2 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
          />
        </div>
        <div>
          <label for="income-amount" class="block text-xs font-medium text-slate-600 mb-1">台幣到帳金額</label>
          <input
            id="income-amount"
            v-model.number="incomeAmount"
            type="number"
            min="0"
            placeholder="到帳金額"
            :class="errorBorderClass('amount')"
            class="w-full text-sm border border-slate-200 rounded-lg p-2 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
          />
        </div>
      </div>

      <!-- 海外手續費幣別與金額輸入區 -->
      <div class="grid grid-cols-2 gap-2 pt-1 border-t border-blue-100">
        <div>
          <label for="income-fee-currency" class="block text-xs font-medium text-slate-600 mb-1">手續費幣別</label>
          <select
            id="income-fee-currency"
            v-model="incomeFeeCurrency"
            name="feeCurrency"
            class="fee-currency-select w-full text-sm border border-slate-200 rounded-lg p-2 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
          >
            <option value="TWD">TWD 新台幣</option>
            <option :value="foreignIncomeCurrency">{{ foreignIncomeCurrency }} 外幣</option>
          </select>
        </div>
        <div>
          <label for="income-fee-amount" class="block text-xs font-medium text-slate-600 mb-1">
            手續費金額 ({{ incomeFeeCurrency }})
          </label>
          <input
            id="income-fee-amount"
            v-model.number="incomeFeeAmount"
            name="feeAmount"
            type="number"
            step="any"
            min="0"
            placeholder="手續費金額"
            :class="errorBorderClass('fee')"
            class="w-full text-sm border border-slate-200 rounded-lg p-2 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
          />
        </div>
      </div>

      <!-- 即時手續費與實質匯率資訊 -->
      <div class="text-xs bg-white/80 p-2.5 rounded-lg border border-blue-200/80 space-y-1 text-slate-700">
        <div class="flex justify-between items-center">
          <span>折合台幣手續費：</span>
          <span class="font-bold text-slate-800">NT$ {{ calculatedTwdFee }}</span>
        </div>
        <div v-if="effectiveExchangeRate > 0" class="flex justify-between items-center">
          <span>實質匯率：</span>
          <span class="font-bold text-teal-800">{{ effectiveExchangeRate.toFixed(2) }}</span>
        </div>
      </div>
    </div>

    <!-- 國內模式下之到帳金額 (若非海外模式) -->
    <div v-else>
      <label for="income-amount" class="block text-xs font-medium text-slate-500 mb-1">金額</label>
      <input
        id="income-amount"
        v-model.number="incomeAmount"
        type="number"
        placeholder="到帳金額"
        :class="errorBorderClass('amount')"
        class="w-full text-sm border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
      />
    </div>

    <!-- 備註說明輸入區 -->
    <div>
      <label for="income-note" class="block text-xs font-medium text-slate-500 mb-1">備註說明</label>
      <input
        id="income-note"
        v-model="incomeNote"
        type="text"
        placeholder="備註說明（選填）"
        class="w-full text-sm border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
      />
    </div>

    <!-- 錯誤提示 -->
    <p v-if="errorMessage" id="income-error-message" class="text-xs text-rose-600 font-medium text-right">
      {{ errorMessage }}
    </p>

    <!-- 儲存/取消收入按鈕 -->
    <div class="pt-4 border-t border-slate-100 flex items-center justify-between">
      <span v-if="isEditMode" class="text-xs font-bold text-teal-800">
        正在修改收入記錄 (ID: {{ props.editData?.id }})
      </span>
      <div v-else></div>
      <div class="flex items-center gap-2">
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
          id="btn-submit-income"
          type="button"
          class="px-6 py-2.5 bg-teal-600 hover:bg-teal-700 text-white font-bold text-sm rounded-xl shadow-md transition-all active:scale-95"
          @click="handleSaveIncome"
        >
          {{ isEditMode ? '修改收入記錄' : '儲存' }}
        </button>
      </div>
    </div>
  </div>
</template>
