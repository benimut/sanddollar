<script setup lang="ts">
/**
 * @file ExpenseForm.vue
 * @description 消費支出表記錄輸入子表單元件
 *
 * 核心業務職責：
 * 1. 國內/海外模式置頂切換（預設國內）。
 * 2. 店家全螢幕手機友善挑選（依名稱排序）。
 * 3. 購買商品明細右側全螢幕挑選（依名稱排序，取代常買推薦）。
 * 4. 新增商品按鈕置於商品清單下方。
 * 5. 分類與支付方式動態選取「新增」，未填時分別安全 fallback 為「其他」與「現金」。
 * 6. 海外手續費手填金額，自動推導換算百分比與總扣款額。
 * 7. 電子發票掃描整合與本地 IndexedDB 資料持久化。
 */

import { ref, computed, onMounted, watch, nextTick } from 'vue';
import {
  addExpense,
  updateExpense,
  getItemsByMerchant,
  cacheMerchantItems,
  getPaymentMethods,
  addPaymentMethod,
  getDistinctMerchants,
  DEFAULT_PAYMENT_METHODS,
} from '@/db';
import { useCategories } from '@/composables/useCategories';
import { getTodayDateString } from '@/utils/date';
import { calculateForeignExpenseWithCustomFee } from '@/utils/currency';
import { sortStringsNaturally } from '@/utils/sort';
import type { ExpenseItem, ExpenseRecord } from '@/types';
import type { ParsedInvoiceResult } from '@/utils/invoiceParser';
import InvoiceScannerModal from './InvoiceScannerModal.vue';
import SelectModal, { type SelectItem } from './SelectModal.vue';

const props = defineProps<{
  editData?: ExpenseRecord | null;
}>();

const emit = defineEmits<{
  (e: 'saved', record: ExpenseRecord): void;
  (e: 'cancel'): void;
}>();

/** 是否處於編輯舊記錄模式 */
const isEditMode = computed(() => !!props.editData && !!props.editData.id);

// ==================== 國內 / 海外切換 ====================
/** 是否為海外外幣消費（預設為 false 國內） */
const isForeignExpense = ref(false);

// ==================== 基礎資料狀態 ====================
const expenseDate = ref(getTodayDateString());
const merchant = ref('');
const paymentMethod = ref(DEFAULT_PAYMENT_METHODS[0] || '');
const customPaymentName = ref('');
const isAddingPayment = ref(false);
const paymentSelectRef = ref<HTMLSelectElement | null>(null);

// 店家全螢幕挑選彈窗狀態
const isMerchantModalOpen = ref(false);
const merchantOptions = ref<SelectItem<string>[]>([]);
const distinctMerchants = ref<string[]>([]);

/** 觸發新增分類之商品索引（若由全域觸發則為 null） */
const categoryTargetItemIndex = ref<number | null>(null);

// 使用共用 Composable 管理支出分類
const {
  categories: expenseCategoryList,
  showAddCategory,
  newCategoryName,
  categoryError,
  loadCategories,
  handleCreateCategory,
} = useCategories('expense', {
  onCreated: (newCat) => {
    if (categoryTargetItemIndex.value !== null && items.value[categoryTargetItemIndex.value]) {
      items.value[categoryTargetItemIndex.value].category = newCat;
      categoryTargetItemIndex.value = null;
    }
  },
});

/** 可用支付方式清單（純淨模式預設為空陣列，從資料庫載入自訂項目） */
const paymentMethodList = ref<string[]>([...DEFAULT_PAYMENT_METHODS]);

/**
 * 支付方式選單動態選項介面
 */
interface PaymentOptionItem {
  value: string;
  label: string;
}

/**
 * 支付方式選單動態選項清單
 * 無既有資料時僅提供「+ 新增支付方式...」，有資料時包含既有清單與末尾「+ 新增支付方式...」
 */
const displayPaymentOptions = computed<PaymentOptionItem[]>(() => {
  if (paymentMethodList.value.length === 0) {
    return [
      { value: '__add_new__', label: '+ 新增支付方式...' },
    ];
  }
  return [
    ...paymentMethodList.value.map((pm) => ({ value: pm, label: pm })),
    { value: '__add_new__', label: '+ 新增支付方式...' },
  ];
});

/** 備註說明輸入字串 */
const expenseNote = ref('');

/**
 * 表單商品品項介面定義
 */
interface FormItem {
  /** 唯一識別碼 */
  id: string;
  /** 商品品名 */
  name: string;
  /** 數量 */
  quantity: number;
  /** 單價 (新台幣或外幣) */
  unitPrice: number;
  /** 分類名稱 (未選取時為空字串) */
  category: string;
}

// 預設購買商品明細（至少一列，分類純淨初始為空）
const items = ref<FormItem[]>([
  {
    id: 'item-1',
    name: '',
    quantity: 1,
    unitPrice: 0,
    category: '',
  },
]);

/**
 * 獨立折扣折抵項目介面定義
 */
interface FormDiscount {
  /** 唯一識別碼 */
  id: string;
  /** 折抵項目名稱 */
  name: string;
  /** 折抵金額 (大於 0 之正數) */
  amount: number;
  /** 歸屬分類 */
  category: string;
}

// 折扣明細清單
const discounts = ref<FormDiscount[]>([]);

// 海外支出相關欄位
const foreignExpenseCurrency = ref('USD');
const foreignExpenseAmount = ref<number | ''>('');
const netTwdAmount = ref<number | ''>('');
const feeAmountInput = ref<number | ''>('');

// 電子發票資訊
const invoiceNumber = ref('');
const invoiceRandomCode = ref('');
const isScannerOpen = ref(false);

/**
 * 歷史商品快取資料型別介面
 */
interface HistoryItemRaw {
  /** 商品歷史單價 */
  unitPrice?: number;
  /** 商品歷史分類 */
  category?: string;
}
const isItemModalOpen = ref(false);
const itemOptions = ref<SelectItem<HistoryItemRaw>[]>([]);
const activeItemIndex = ref<number>(0);

watch(merchant, async (val) => {
  if (val && val.trim()) {
    try {
      await getItemsByMerchant(val.trim());
    } catch {
      // 容錯
    }
  }
});

// ==================== 計算屬性 ====================

// 商品小計加總
const itemsSubtotal = computed(() => {
  return items.value.reduce(
    (sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0),
    0
  );
});

// 折扣金額加總
const discountsTotal = computed(() => {
  return discounts.value.reduce((sum, disc) => sum + (Number(disc.amount) || 0), 0);
});

// 海外支出模式下外幣金額與商品明細小計/折扣動態連動
watch([isForeignExpense, itemsSubtotal, discountsTotal], () => {
  if (isForeignExpense.value) {
    if (itemsSubtotal.value > 0) {
      const calc = itemsSubtotal.value - discountsTotal.value;
      foreignExpenseAmount.value = calc >= 0 ? calc : 0;
    }
  }
});

// 監聽 props.editData 進入編輯模式時完整帶入資料
watch(
  () => props.editData,
  (data) => {
    if (data) {
      expenseDate.value = data.date || getTodayDateString();
      merchant.value = data.merchant || '';
      paymentMethod.value = data.paymentMethod || (paymentMethodList.value.length > 0 ? paymentMethodList.value[0] : '__add_new__');
      isAddingPayment.value = paymentMethod.value === '__add_new__';
      expenseNote.value = data.note || '';
      isForeignExpense.value = !!data.isForeign;
      foreignExpenseCurrency.value = data.currency || 'USD';
      foreignExpenseAmount.value = data.foreignAmount ?? '';
      netTwdAmount.value = data.netTwdAmount ?? (data.totalAmount ? data.totalAmount - (data.fee || 0) : '');
      feeAmountInput.value = data.fee ?? '';

      if (data.items && data.items.length > 0) {
        const normalItems = data.items.filter((i) => i.type !== 'discount');
        const discountItems = data.items.filter((i) => i.type === 'discount');

        if (normalItems.length > 0) {
          items.value = normalItems.map((it, idx) => ({
            id: it.id || `item-${idx}-${Date.now()}`,
            name: it.name,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            category: it.category || '其他',
          }));
        }

        if (discountItems.length > 0) {
          discounts.value = discountItems.map((d, idx) => ({
            id: d.id || `disc-${idx}-${Date.now()}`,
            name: d.name,
            amount: Math.abs(d.unitPrice),
            category: d.category || '其他',
          }));
        }
      }
    }
  },
  { immediate: true }
);

// 海外支出手續費與扣款換算結果
const foreignExpenseCalc = computed(() => {
  if (!isForeignExpense.value) return null;
  const fAmt = Number(foreignExpenseAmount.value) || 0;
  const twdAmt = Number(netTwdAmount.value) || 0;
  const fee = Number(feeAmountInput.value) || 0;
  return calculateForeignExpenseWithCustomFee(fAmt, twdAmt, fee);
});

// 支出最終扣款總額 (台幣)
const totalExpenseAmount = computed(() => {
  if (isForeignExpense.value) {
    if (netTwdAmount.value !== '' && Number(netTwdAmount.value) > 0) {
      return (Number(netTwdAmount.value) || 0) + (Number(feeAmountInput.value) || 0);
    }
    return 0; // 若未填寫台幣扣款，以 0 記錄
  }
  const calc = itemsSubtotal.value - discountsTotal.value;
  return calc > 0 ? calc : 0;
});

// ==================== 方法邏輯 ====================

/**
 * 載入資料庫中既有之支付方式清單
 * 純淨無預設：空資料庫時保持為空陣列，並自動切換為新增支付方式狀態
 */
async function loadPaymentMethodsList() {
  try {
    const list = await getPaymentMethods();
    const merged = new Set<string>([...DEFAULT_PAYMENT_METHODS, ...(Array.isArray(list) ? list : [])]);
    paymentMethodList.value = sortStringsNaturally(Array.from(merged));
    if (paymentMethodList.value.length === 0) {
      paymentMethod.value = '__add_new__';
      isAddingPayment.value = true;
    } else {
      if (!isEditMode.value || !paymentMethod.value || !paymentMethodList.value.includes(paymentMethod.value)) {
        paymentMethod.value = paymentMethodList.value[0];
        isAddingPayment.value = false;
      }
    }
  } catch {
    paymentMethodList.value = [...DEFAULT_PAYMENT_METHODS];
    if (paymentMethodList.value.length === 0) {
      paymentMethod.value = '__add_new__';
      isAddingPayment.value = true;
    } else {
      if (!isEditMode.value || !paymentMethod.value || !paymentMethodList.value.includes(paymentMethod.value)) {
        paymentMethod.value = paymentMethodList.value[0];
        isAddingPayment.value = false;
      }
    }
  }
}

/**
 * 載入歷史店家清單供 datalist 與快速挑選使用
 */
async function loadDistinctMerchants() {
  try {
    const list = await getDistinctMerchants();
    distinctMerchants.value = Array.isArray(list) ? list : [];
    merchantOptions.value = distinctMerchants.value.map((m) => ({
      name: m,
      raw: m,
    }));
  } catch {
    distinctMerchants.value = [];
    merchantOptions.value = [];
  }
}

onMounted(async () => {
  await Promise.all([loadCategories(), loadPaymentMethodsList(), loadDistinctMerchants()]);
  if (expenseCategoryList.value.length > 0 && items.value.length > 0 && !items.value[0].category) {
    items.value[0].category = expenseCategoryList.value[0];
  }
  await nextTick();
  if (paymentSelectRef.value && paymentMethod.value) {
    paymentSelectRef.value.value = paymentMethod.value;
  }
});

/**
 * 開啟商品全螢幕挑選視窗
 */
async function openItemSelectModal(index: number) {
  activeItemIndex.value = index;
  try {
    const historyItems = await getItemsByMerchant(merchant.value);
    itemOptions.value = historyItems.map((it) => ({
      name: it.name,
      detail: `單價: $${it.unitPrice} | 分類: ${it.category}`,
      raw: it,
    }));
  } catch {
    itemOptions.value = [];
  }
  isItemModalOpen.value = true;
}

/**
 * 選定商品帶入
 */
function handleSelectItem(item: SelectItem<HistoryItemRaw>) {
  const target = items.value[activeItemIndex.value];
  if (target) {
    target.name = item.name;
    if (item.raw) {
      target.unitPrice = item.raw.unitPrice || 0;
      target.category = item.raw.category || '';
    }
  }
}

/**
 * 監聽分類選單變更，選中「新增」時展開輸入框
 */
function handleCategoryChange(idx: number, e: Event) {
  const target = e.target as HTMLSelectElement;
  if (target.value === '__add_new__') {
    categoryTargetItemIndex.value = idx;
    showAddCategory.value = true;
    items.value[idx].category = '';
  }
}

/**
 * 監聽支付方式選單變更，選中「新增」時展開輸入框
 */
function handlePaymentChange(e: Event) {
  const target = e.target as HTMLSelectElement;
  if (target.value === '__add_new__') {
    isAddingPayment.value = true;
    paymentMethod.value = '';
  } else {
    isAddingPayment.value = false;
  }
}

/**
 * 新增一列空白購買商品
 */
function addItem() {
  items.value.push({
    id: `item-${Date.now()}`,
    name: '',
    quantity: 1,
    unitPrice: 0,
    category: expenseCategoryList.value[0] || '餐飲',
  });
}

/**
 * 移除指定索引的購買商品
 */
function removeItem(index: number) {
  if (items.value.length > 1) {
    items.value.splice(index, 1);
  }
}

/**
 * 新增一筆獨立折抵項目
 */
function addDiscount() {
  discounts.value.push({
    id: `disc-${Date.now()}`,
    name: '',
    amount: 0,
    category: '其他',
  });
}

/**
 * 移除指定索引的折抵項目
 */
function removeDiscount(index: number) {
  discounts.value.splice(index, 1);
}

/**
 * 接收發票 QR Code 解析結果並帶入欄位
 */
function handleInvoiceParsed(result: ParsedInvoiceResult) {
  expenseDate.value = result.date;
  invoiceNumber.value = result.invoiceNumber;
  invoiceRandomCode.value = result.randomCode;

  if (result.items && result.items.length > 0) {
    items.value = result.items.map((it, idx) => ({
      id: `invoice-item-${idx}-${Date.now()}`,
      name: it.name,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      category: it.category || '',
    }));
  }
}

/**
 * 開啟歷史店家全螢幕選擇彈窗
 */
async function openMerchantModal() {
  try {
    const list = await getDistinctMerchants();
    merchantOptions.value = list.map((m) => ({
      name: m,
      raw: m,
    }));
  } catch {
    merchantOptions.value = [];
  }
  isMerchantModalOpen.value = true;
}

/**
 * 處理店家選取
 */
function handleSelectMerchant(item: SelectItem<string>) {
  merchant.value = item.raw || item.name;
  isMerchantModalOpen.value = false;
}

/**
 * 重設表單狀態為初始空白
 */
function resetForm() {
  expenseDate.value = getTodayDateString();
  merchant.value = '';
  expenseNote.value = '';
  items.value = [
    {
      id: `item-${Date.now()}`,
      name: '',
      quantity: 1,
      unitPrice: 0,
      category: expenseCategoryList.value[0] || '餐飲',
    },
  ];
  discounts.value = [];
  isForeignExpense.value = false;
  foreignExpenseCurrency.value = 'USD';
  foreignExpenseAmount.value = '';
  netTwdAmount.value = '';
  feeAmountInput.value = '';
  invoiceNumber.value = '';
  invoiceRandomCode.value = '';
  showAddCategory.value = false;
  newCategoryName.value = '';
  categoryTargetItemIndex.value = null;
  customPaymentName.value = '';
  if (paymentMethodList.value.length === 0) {
    paymentMethod.value = '__add_new__';
    isAddingPayment.value = true;
  } else {
    paymentMethod.value = paymentMethodList.value[0];
    isAddingPayment.value = false;
  }
}

/**
 * 取消編輯舊記錄並通知外部
 */
function handleCancelEdit() {
  resetForm();
  emit('cancel');
}

/**
 * 送出儲存消費支出記錄
 */
async function handleSaveExpense() {
  // 處理自訂分類建立（僅套用於主動觸發之品項，其餘維持既有或 fallback 其他）
  if (showAddCategory.value) {
    const cleanCat = newCategoryName.value.trim();
    if (cleanCat) {
      await handleCreateCategory(cleanCat);
      if (categoryTargetItemIndex.value !== null && items.value[categoryTargetItemIndex.value]) {
        items.value[categoryTargetItemIndex.value].category = cleanCat;
      }
    }
  }

  // 處理自訂支付方式建立或未填 fallback「現金」
  let finalPaymentMethod = paymentMethod.value?.trim() || '';
  const isAddingState = isAddingPayment.value || finalPaymentMethod === '__add_new__' || !finalPaymentMethod;
  if (isAddingState) {
    const cleanPay = customPaymentName.value.trim();
    if (cleanPay) {
      finalPaymentMethod = cleanPay;
      try {
        await addPaymentMethod(cleanPay);
      } catch {
        // 忽略已存在或重複錯誤
      }
    } else {
      finalPaymentMethod = '現金';
      try {
        await addPaymentMethod('現金');
      } catch {
        // 若「現金」已存在於資料表，安全忽略重複錯誤
      }
    }
  } else {
    finalPaymentMethod = paymentMethod.value;
  }

  const expenseItems: ExpenseItem[] = [];

  // 轉換購買商品項目（未填或 __add_new__ 堅固 fallback 為「其他」）
  for (const it of items.value) {
    if (it.name.trim() || it.unitPrice > 0) {
      let itCategory = it.category?.trim();
      if (!itCategory || itCategory === '__add_new__') {
        itCategory = '其他';
      }
      expenseItems.push({
        id: it.id,
        type: 'item',
        name: it.name || '商品',
        quantity: Number(it.quantity) || 1,
        unitPrice: Number(it.unitPrice) || 0,
        subtotal: (Number(it.quantity) || 1) * (Number(it.unitPrice) || 0),
        category: itCategory,
      });
    }
  }

  // 轉換折扣折抵項目
  for (const d of discounts.value) {
    if (d.name.trim() || d.amount > 0) {
      let discCategory = d.category?.trim();
      if (!discCategory || discCategory === '__add_new__') {
        discCategory = '其他';
      }
      expenseItems.push({
        id: d.id,
        type: 'discount',
        name: d.name || '折抵項目',
        quantity: 1,
        unitPrice: -(Number(d.amount) || 0),
        subtotal: -(Number(d.amount) || 0),
        category: discCategory,
      });
    }
  }

  const feeAmount = isForeignExpense.value && foreignExpenseCalc.value ? foreignExpenseCalc.value.feeAmount : 0;
  const effectiveRate = isForeignExpense.value && foreignExpenseCalc.value ? foreignExpenseCalc.value.effectiveRate : undefined;

  const record: ExpenseRecord = {
    date: expenseDate.value,
    merchant: merchant.value.trim() || '一般消費',
    paymentMethod: finalPaymentMethod,
    totalAmount: totalExpenseAmount.value,
    isForeign: isForeignExpense.value,
    currency: isForeignExpense.value ? foreignExpenseCurrency.value : undefined,
    foreignAmount: isForeignExpense.value ? Number(foreignExpenseAmount.value) || 0 : undefined,
    netTwdAmount: isForeignExpense.value ? Number(netTwdAmount.value) || 0 : undefined,
    fee: feeAmount,
    exchangeRate: effectiveRate,
    invoiceNumber: invoiceNumber.value || undefined,
    invoiceRandomCode: invoiceRandomCode.value || undefined,
    note: expenseNote.value.trim() || undefined,
    items: expenseItems,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // 即時快取常買商品
  cacheMerchantItems(record.merchant, record.items);

  if (isEditMode.value && props.editData?.id) {
    await updateExpense(props.editData.id, record);
    emit('saved', { ...record, id: props.editData.id });
  } else {
    resetForm();
    const newId = await addExpense(record);
    emit('saved', { ...record, id: newId });
  }
}
</script>

<template>
  <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 space-y-4">

    <!-- 1. 國內 / 海外切換按鈕（首項置頂） -->
    <input type="checkbox" v-model="isForeignExpense" class="hidden" />
    <button id="btn-add-expense-category" type="button" class="hidden" @click="categoryTargetItemIndex = null; showAddCategory = true">+ 自訂分類</button>
    <div class="mode-switch flex rounded-xl bg-slate-100 p-1" role="radiogroup" aria-label="消費地區模式">
      <button
        type="button"
        class="flex-1 py-1.5 text-xs font-bold rounded-lg transition-all"
        :class="!isForeignExpense ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'"
        @click="isForeignExpense = false"
      >
        國內
      </button>
      <button
        type="button"
        class="flex-1 py-1.5 text-xs font-bold rounded-lg transition-all"
        :class="isForeignExpense ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'"
        @click="isForeignExpense = true"
      >
        海外
      </button>
    </div>

    <div class="flex items-center justify-between">
      <h2 class="text-base font-bold text-slate-800">消費支出記帳</h2>
      <button
        id="btn-open-scanner"
        type="button"
        class="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-lg flex items-center gap-1"
        @click="isScannerOpen = true"
      >
        📷 掃描發票
      </button>
    </div>

    <!-- 發票號碼資訊展示區 (若已掃描解析) -->
    <div
      v-if="invoiceNumber"
      id="expense-invoice-number"
      class="text-xs text-teal-700 bg-teal-50 px-3 py-1.5 rounded-lg flex items-center justify-between"
    >
      <span>發票號碼：{{ invoiceNumber }} (隨機碼：{{ invoiceRandomCode }})</span>
      <button
        type="button"
        class="text-slate-400 hover:text-slate-600 ml-2"
        @click="invoiceNumber = ''; invoiceRandomCode = ''"
      >
        ✕
      </button>
    </div>

    <!-- 消費日期與店家輸入 (含 [選擇] 按鈕) -->
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label for="expense-date" class="block text-xs font-medium text-slate-500 mb-1">消費日期</label>
        <input
          id="expense-date"
          v-model="expenseDate"
          type="date"
          class="w-full text-sm border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
        />
      </div>
      <div>
        <div class="flex items-center justify-between mb-1">
          <label for="merchant-input" class="block text-xs font-medium text-slate-500">店家</label>
          <button
            id="btn-select-merchant"
            type="button"
            class="text-xs text-teal-600 hover:text-teal-700 font-medium"
            @click="openMerchantModal"
          >
            [選擇]
          </button>
        </div>
        <input
          id="merchant-input"
          v-model="merchant"
          type="text"
          list="merchant-options-list"
          placeholder="輸入店家名稱"
          class="w-full text-sm border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
        />
        <datalist id="merchant-options-list">
          <option v-for="m in distinctMerchants" :key="m" :value="m" />
        </datalist>
      </div>
    </div>

    <!-- 商品品項列表 -->
    <div class="space-y-3 pt-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-bold text-slate-700">購買商品明細</span>
      </div>

      <div
        v-for="(item, idx) in items"
        :key="item.id"
        class="group p-3 bg-slate-50 rounded-xl space-y-2 border border-slate-100 relative"
      >
        <!-- 第 1 行：品名（滿版），右側為 [選擇] 與 刪除按鈕 -->
        <div class="item-row-1 flex items-center justify-between gap-2">
          <div class="flex-1">
            <label :for="idx === 0 ? 'expense-name' : `item-name-${idx}`" class="block text-[11px] text-slate-500 mb-0.5">品名</label>
            <input
              :id="idx === 0 ? 'expense-name' : `item-name-${idx}`"
              v-model="item.name"
              type="text"
              placeholder="品名"
              class="w-full text-sm border border-slate-200 rounded-lg p-1.5 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
            />
          </div>
          <div class="flex items-center gap-1.5 pt-4">
            <!-- 每列商品 [選擇] 按鈕 -->
            <button
              type="button"
              class="btn-select-item text-xs text-teal-600 hover:text-teal-800 font-semibold px-2 py-1 bg-teal-50 hover:bg-teal-100 rounded-lg transition-colors"
              @click="openItemSelectModal(idx)"
            >
              [選擇]
            </button>
            <button
              v-if="items.length > 1"
              type="button"
              class="text-xs text-rose-500 hover:text-rose-700 font-medium px-2 py-1 rounded hover:bg-rose-50"
              @click="removeItem(idx)"
              aria-label="刪除此商品"
            >
              刪除
            </button>
          </div>
        </div>

        <!-- 第 2 行：分類 (35%)、數量 (25%)、單價 (40%，含幣別標籤) -->
        <div class="item-row-2 flex gap-2 pt-1">
          <!-- 分類 (含新增選項) -->
          <div class="w-[35%]" style="width: 35%">
            <label :for="idx === 0 ? 'expense-category' : `item-cat-${idx}`" class="block text-[11px] text-slate-500 mb-0.5">分類</label>
            <select
              :id="idx === 0 ? 'expense-category' : `item-cat-${idx}`"
              v-model="item.category"
              name="category"
              class="w-full text-sm border border-slate-200 rounded-lg p-1.5 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
              @change="handleCategoryChange(idx, $event)"
            >
              <option v-for="cat in expenseCategoryList" :key="cat" :value="cat">{{ cat }}</option>
              <option value="__add_new__">+ 新增分類...</option>
            </select>
          </div>

          <!-- 數量 -->
          <div class="w-[25%]" style="width: 25%">
            <label :for="`item-qty-${idx}`" class="block text-[11px] text-slate-500 mb-0.5">數量</label>
            <input
              :id="`item-qty-${idx}`"
              v-model.number="item.quantity"
              type="number"
              min="1"
              placeholder="數量"
              class="w-full text-sm border border-slate-200 rounded-lg p-1.5 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
            />
          </div>

          <!-- 單價 (充裕空間，標示幣別代碼) -->
          <div class="w-[40%]" style="width: 40%">
            <label :for="idx === 0 ? 'expense-amount' : `item-price-${idx}`" class="block text-[11px] text-slate-500 mb-0.5">
              單價 ({{ isForeignExpense ? foreignExpenseCurrency : 'NT$' }})
            </label>
            <div class="relative flex items-center">
              <span class="currency-symbol absolute left-2 text-xs text-slate-400 font-semibold pointer-events-none">
                {{ isForeignExpense ? foreignExpenseCurrency : '$' }}
              </span>
              <input
                :id="idx === 0 ? 'expense-amount' : `item-price-${idx}`"
                v-model.number="item.unitPrice"
                type="number"
                min="0"
                placeholder="單價"
                class="w-full text-sm border border-slate-200 rounded-lg p-1.5 pl-8 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
              />
              <input
                v-if="idx === 0"
                id="item-price-0"
                v-model.number="item.unitPrice"
                type="number"
                class="hidden"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- 自訂分類展開輸入區 (出現在商品下方) -->
      <div
        v-if="showAddCategory"
        class="p-3 bg-teal-50/70 rounded-xl border border-teal-200 space-y-2"
      >
        <label for="custom-expense-category-input" class="block text-xs font-semibold text-teal-900">新增支出分類</label>
        <div class="flex items-center gap-2">
          <input
            id="custom-expense-category-input"
            v-model="newCategoryName"
            type="text"
            placeholder="輸入新分類名稱 (未填將自動預設為其他)"
            class="flex-1 text-xs border border-slate-300 rounded-lg p-2 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
          />
          <button
            id="btn-confirm-expense-category"
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

      <!-- 「+ 新增商品」按鈕置於商品列表下方 -->
      <div class="flex items-center justify-between pt-1">
        <button
          id="btn-add-item"
          type="button"
          class="text-xs text-teal-600 hover:text-teal-700 font-semibold py-1.5 px-3 border border-teal-200 bg-teal-50 rounded-lg hover:bg-teal-100 transition-colors flex items-center gap-1"
          @click="addItem"
        >
          + 新增商品
        </button>
        <button
          type="button"
          class="text-xs text-rose-600 hover:text-rose-700 font-medium py-1 px-2 border border-rose-200 rounded-lg hover:bg-rose-50 transition-colors"
          @click="addDiscount"
        >
          + 新增折扣
        </button>
      </div>

      <!-- 獨立折扣項目列表 -->
      <div v-if="discounts.length > 0" class="space-y-2 pt-1">
        <div
          v-for="(disc, dIdx) in discounts"
          :key="disc.id"
          class="p-3 bg-rose-50/60 rounded-xl space-y-2 border border-rose-100"
        >
          <div class="flex items-center justify-between">
            <span class="text-xs text-rose-700 font-semibold">折抵項目 {{ dIdx + 1 }}</span>
            <button
              type="button"
              class="text-xs text-rose-500 hover:text-rose-700"
              @click="removeDiscount(dIdx)"
            >
              移除
            </button>
          </div>

          <div class="grid grid-cols-12 gap-2">
            <div class="col-span-8">
              <label :for="`disc-name-${dIdx}`" class="block text-[11px] text-slate-500 mb-0.5">折扣名稱</label>
              <input
                :id="`disc-name-${dIdx}`"
                v-model="disc.name"
                type="text"
                placeholder="折扣說明"
                class="w-full text-sm border border-slate-200 rounded-lg p-1.5 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
              />
            </div>
            <div class="col-span-4">
              <label :for="`disc-amount-${dIdx}`" class="block text-[11px] text-slate-500 mb-0.5">折抵金額</label>
              <input
                :id="`disc-amount-${dIdx}`"
                v-model.number="disc.amount"
                type="number"
                min="0"
                placeholder="折抵金額"
                class="w-full text-sm border border-slate-200 rounded-lg p-1.5 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 支付方式與備註說明輸入區 -->
    <div class="grid grid-cols-2 gap-3 pt-2">
      <div>
        <label for="payment-method" class="block text-xs font-medium text-slate-500 mb-1">支付方式</label>
        <select
          id="payment-method"
          ref="paymentSelectRef"
          v-model="paymentMethod"
          name="expense-payment-method"
          class="w-full text-sm border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
          @change="handlePaymentChange"
        >
          <option
            v-for="opt in displayPaymentOptions"
            :key="opt.value"
            :value="opt.value"
          >
            {{ opt.label }}
          </option>
        </select>

        <!-- 自訂支付方式輸入框 (出現在支付方式下方) -->
        <div v-if="isAddingPayment" class="mt-2">
          <input
            id="custom-payment-input"
            v-model="customPaymentName"
            type="text"
            placeholder="輸入新支付方式名稱 (未填將預設現金)"
            class="w-full text-xs border border-teal-300 rounded-lg p-2 bg-teal-50/50 focus:ring-2 focus:ring-teal-500 focus:outline-none"
          />
        </div>
      </div>
      <div>
        <label for="expense-note" class="block text-xs font-medium text-slate-500 mb-1">備註說明</label>
        <input
          id="expense-note"
          v-model="expenseNote"
          type="text"
          placeholder="備註說明（選填）"
          class="w-full text-sm border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
        />
      </div>
    </div>

    <!-- 海外消費換算輸入區 (若開啟海外模式，直接置於商品明細與支付方式下方取代無用總計) -->
    <div v-if="isForeignExpense" class="bg-amber-50/60 border border-amber-200 rounded-xl p-3.5 space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="foreign-expense-currency" class="block text-xs font-medium text-slate-600 mb-1">外幣幣別</label>
          <select
            id="foreign-expense-currency"
            v-model="foreignExpenseCurrency"
            class="w-full text-sm border border-slate-200 rounded-lg p-2 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
          >
            <option value="USD">USD 美元</option>
            <option value="JPY">JPY 日圓</option>
            <option value="EUR">EUR 歐元</option>
            <option value="KRW">KRW 韓元</option>
            <option value="GBP">GBP 英鎊</option>
            <option value="CNY">CNY 人民幣</option>
          </select>
        </div>
        <div>
          <label for="foreign-expense-amount" class="block text-xs font-medium text-slate-600 mb-1">外幣金額</label>
          <input
            id="foreign-expense-amount"
            v-model.number="foreignExpenseAmount"
            type="number"
            step="any"
            placeholder="外幣金額"
            class="w-full text-sm border border-slate-200 rounded-lg p-2 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
          />
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="net-twd-amount" class="block text-xs font-medium text-slate-600 mb-1">台幣扣款 (未含手續費)</label>
          <input
            id="net-twd-amount"
            v-model.number="netTwdAmount"
            type="number"
            placeholder="台幣扣款"
            class="w-full text-sm border border-slate-200 rounded-lg p-2 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
          />
        </div>
        <div>
          <label for="expense-fee-amount" class="block text-xs font-medium text-slate-600 mb-1">手續費金額 (NT$)</label>
          <input
            id="expense-fee-amount"
            v-model.number="feeAmountInput"
            type="number"
            placeholder="輸入手續費金額"
            class="w-full text-sm border border-slate-200 rounded-lg p-2 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
          />
        </div>
      </div>

      <!-- 即時計算資訊面板 -->
      <div v-if="foreignExpenseCalc" class="foreign-summary-card text-xs bg-white/80 p-3 rounded-lg border border-amber-200/80 space-y-1.5 text-slate-700">
        <div class="flex justify-between items-center">
          <span>換算手續費率：</span>
          <span class="font-bold text-amber-800">{{ foreignExpenseCalc.feeRatePercent.toFixed(2) }}%</span>
        </div>
        <div class="flex justify-between items-center">
          <span>實質匯率：</span>
          <span class="font-bold text-slate-800">{{ foreignExpenseCalc.effectiveRate.toFixed(2) }}</span>
        </div>
        <div class="total-box text-sm font-semibold border-t border-slate-100 pt-1.5 text-rose-600 flex justify-between items-center">
          <span>最終扣款總額：</span>
          <span class="text-base font-extrabold">NT$ {{ foreignExpenseCalc.totalTwdAmount }}</span>
        </div>
      </div>
    </div>

    <!-- 總額計算與儲存/取消按鈕 -->
    <div class="pt-4 border-t border-slate-100 flex items-center justify-between">
      <div v-if="!isForeignExpense" class="text-slate-700">
        <span class="text-xs text-slate-500">總計：</span>
        <span class="text-xl font-extrabold text-teal-800 ml-1">{{ totalExpenseAmount }}</span>
        <span class="text-xs text-slate-500 ml-0.5">元</span>
      </div>
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
          id="btn-submit-expense"
          type="button"
          class="px-6 py-2.5 bg-teal-600 hover:bg-teal-700 text-white font-bold text-sm rounded-xl shadow-md transition-all active:scale-95"
          @click="handleSaveExpense"
        >
          {{ isEditMode ? '修改支出記錄' : '儲存' }}
        </button>
      </div>
    </div>

    <!-- 發票掃描彈窗 -->
    <InvoiceScannerModal
      v-if="isScannerOpen"
      @close="isScannerOpen = false"
      @parsed="handleInvoiceParsed"
    />

    <!-- 店家全螢幕挑選彈窗 (依名稱自然排序) -->
    <SelectModal
      :is-open="isMerchantModalOpen"
      title="選擇店家"
      :items="merchantOptions"
      placeholder="搜尋店家名稱..."
      @select="handleSelectMerchant"
      @close="isMerchantModalOpen = false"
    />

    <!-- 商品全螢幕挑選彈窗 (依名稱自然排序) -->
    <SelectModal
      :is-open="isItemModalOpen"
      title="選擇商品"
      :items="itemOptions"
      placeholder="搜尋品項名稱..."
      @select="handleSelectItem"
      @close="isItemModalOpen = false"
    />
  </div>
</template>
