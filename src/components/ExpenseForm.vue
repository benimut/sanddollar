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
  getPreferredPaymentMethod,
  addPaymentMethod,
  getDistinctMerchants,
  getPreferredMerchants,
  addMerchant,
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
/** 設定頁標記為常用 (★) 之店家名稱清單 */
const preferredMerchants = ref<string[]>([]);

/** 觸發新增分類之商品索引（若由全域觸發則為 null） */
const categoryTargetItemIndex = ref<number | null>(null);

// 使用共用 Composable 管理支出分類
const {
  categories: expenseCategoryList,
  defaultCategory: defaultExpenseCategory,
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
/** 使用者設定的預設支付方式 */
const defaultPaymentMethod = ref<string>(DEFAULT_PAYMENT_METHODS[0] || '');

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
  /** 折抵金額 (大於等於 0 之正數) */
  amount: number;
  /** 歸屬分類 */
  category: string;
}

// 折扣明細清單
const discounts = ref<FormDiscount[]>([]);

// 表單驗證錯誤狀態
const errorMessage = ref('');
const errorField = ref('');

/**
 * 設定表單驗證錯誤訊息與第一個錯誤欄位鍵值
 */
function setValidationError(field: string, message: string): false {
  errorField.value = field;
  errorMessage.value = message;
  return false;
}

/**
 * 清除表單驗證錯誤狀態
 */
function clearValidationError() {
  errorField.value = '';
  errorMessage.value = '';
}

/**
 * 判斷數值輸入是否為空白或無效數字 (包含 v-model.number 清空後產生的空字串)
 */
function isBlankOrInvalidNumber(val: unknown): boolean {
  if (val === '' || val === null || val === undefined || typeof val === 'boolean') {
    return true;
  }
  const num = Number(val);
  return Number.isNaN(num) || !Number.isFinite(num);
}

/**
 * 取得欄位錯誤紅框樣式類別
 */
function errorBorderClass(field: string): string {
  return errorField.value === field ? 'border-rose-500 ring-2 ring-rose-200' : '';
}

// 海外支出相關欄位
const foreignExpenseCurrency = ref('USD');
const foreignExpenseAmount = ref<number | ''>('');
const netTwdAmount = ref<number | ''>('');
const feeAmountInput = ref<number | ''>('');

// 電子發票／紙本發票掃描資訊
const invoiceNumber = ref('');
const invoiceRandomCode = ref('');
const isScannerOpen = ref(false);
/** 發票匯入後之非阻擋核對提醒訊息（例如紙本未辨識日期、折扣上限調整或未歸類提醒） */
const invoiceImportNotices = ref<string[]>([]);

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

/**
 * 判斷商品列是否為有效商品（須同時滿足：品名非空、已選擇有效分類、數量大於 0）
 */
function isValidFormItem(item: FormItem): boolean {
  const cat = item.category?.trim();
  return (
    item.name.trim() !== '' &&
    Boolean(cat && cat !== '__add_new__') &&
    (Number(item.quantity) || 0) > 0
  );
}

/**
 * 同筆支出中有效商品所擁有的不重複分類清單
 */
const availableDiscountCategories = computed<string[]>(() => {
  const cats: string[] = [];
  for (const it of items.value) {
    if (!isValidFormItem(it)) continue;
    const cat = it.category.trim();
    if (!cats.includes(cat)) {
      cats.push(cat);
    }
  }
  return cats;
});

/**
 * 依分類計算同筆支出中有效商品的小計總和
 */
const categorySubtotals = computed<Record<string, number>>(() => {
  const map: Record<string, number> = {};
  for (const it of items.value) {
    if (!isValidFormItem(it)) continue;
    const cat = it.category.trim();
    const sub = (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0);
    map[cat] = (map[cat] || 0) + sub;
  }
  return map;
});

/**
 * 是否允許新增折扣（須至少有一筆有效商品且有至少一個商品分類）
 */
const canAddDiscount = computed(() => availableDiscountCategories.value.length > 0);

/**
 * 取得指定折扣項目的分類下拉選項
 */
function getDiscountCategoryOptions(_disc: FormDiscount): string[] {
  return [...availableDiscountCategories.value];
}

/**
 * 計算指定索引的折扣項目目前剩餘可折抵上限
 */
function getMaxDiscountAmount(dIdx: number): number | undefined {
  const target = discounts.value[dIdx];
  if (!target) return undefined;
  const cat = target.category?.trim();
  if (!cat || !(cat in categorySubtotals.value)) {
    return 0;
  }
  const usedByOthers = discounts.value.reduce((sum, d, idx) => {
    if (idx === dIdx || d.category !== cat) return sum;
    return sum + Math.max(0, Number(d.amount) || 0);
  }, 0);
  return Math.max(0, categorySubtotals.value[cat] - usedByOthers);
}

/**
 * 依各分類有效商品小計截斷超額折扣，並清除負數或無效值
 */
function clampDiscountsToCategoryLimits() {
  const usedByCat: Record<string, number> = {};
  for (const d of discounts.value) {
    let amt = Number(d.amount);
    if (!Number.isFinite(amt) || amt < 0) {
      amt = 0;
    }
    const cat = d.category?.trim();
    if (cat && cat in categorySubtotals.value) {
      const remaining = Math.max(0, categorySubtotals.value[cat] - (usedByCat[cat] || 0));
      if (amt > remaining) {
        amt = remaining;
      }
      usedByCat[cat] = (usedByCat[cat] || 0) + amt;
    }
    d.amount = amt;
  }
}

/**
 * 處理折扣金額輸入，即時截斷超過該分類剩餘可折抵上限之數值並同步輸入框顯示
 */
function handleDiscountAmountInput(dIdx: number, e: Event) {
  const target = e.target as HTMLInputElement | null;
  const disc = discounts.value[dIdx];
  if (!disc) return;

  clampDiscountsToCategoryLimits();
  if (target && Number(target.value) !== disc.amount) {
    target.value = String(disc.amount);
  }
}

/**
 * 處理折扣分類切換：重新檢核上限
 */
function handleDiscountCategorySelectChange(_dIdx: number) {
  clampDiscountsToCategoryLimits();
}

// 商品分類變動時，保留留空待選項目與仍存在於同筆支出商品分類中的折扣項目
watch(availableDiscountCategories, (cats) => {
  if (isEditMode.value && !isListsLoaded.value) return;
  if (cats.length === 0) {
    discounts.value = [];
    return;
  }
  discounts.value = discounts.value.filter((d) => d.category === '' || cats.includes(d.category));
  clampDiscountsToCategoryLimits();
});

// 商品數量或單價變動導致分類小計下降時，自動截斷超額折扣
watch(categorySubtotals, () => {
  clampDiscountsToCategoryLimits();
});

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

// 海外支出模式下外幣金額唯讀，無條件自動同步為商品明細扣除折扣後的金額
watch([isForeignExpense, itemsSubtotal, discountsTotal], () => {
  if (isForeignExpense.value) {
    const calc = itemsSubtotal.value - discountsTotal.value;
    foreignExpenseAmount.value = calc >= 0 ? calc : 0;
  }
});

const isListsLoaded = ref(false);

/**
 * 編輯模式下比對設定清單，若舊記錄之分類、支付方式或折扣分類已不存在於目前設定清單中，
 * 則清空該欄位（留空以強制使用者重新選擇有效項目）
 */
function reconcileEditSelections() {
  if (!isEditMode.value || !isListsLoaded.value) return;

  if (
    paymentMethod.value &&
    paymentMethod.value !== '__add_new__' &&
    !paymentMethodList.value.includes(paymentMethod.value)
  ) {
    paymentMethod.value = '';
  }

  for (const it of items.value) {
    if (
      it.category &&
      it.category !== '__add_new__' &&
      !expenseCategoryList.value.includes(it.category)
    ) {
      it.category = '';
    }
  }

  for (const d of discounts.value) {
    if (d.category && !availableDiscountCategories.value.includes(d.category)) {
      d.category = '';
    }
  }
}

// 監聽 props.editData 進入編輯模式時完整帶入資料
watch(
  () => props.editData,
  (data) => {
    clearValidationError();
    if (data) {
      expenseDate.value = data.date || '';
      merchant.value = data.merchant || '';
      paymentMethod.value = data.paymentMethod || '';
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
            category: it.category || '',
          }));
        }

        if (discountItems.length > 0) {
          discounts.value = discountItems.map((d, idx) => ({
            id: d.id || `disc-${idx}-${Date.now()}`,
            name: d.name,
            amount: Math.abs(d.unitPrice),
            category: d.category || '',
          }));
        }
      }
      reconcileEditSelections();
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
    const [list, preferred] = await Promise.all([
      getPaymentMethods(),
      getPreferredPaymentMethod(),
    ]);
    const merged = new Set<string>([...DEFAULT_PAYMENT_METHODS, ...(Array.isArray(list) ? list : [])]);
    paymentMethodList.value = sortStringsNaturally(Array.from(merged));
    defaultPaymentMethod.value =
      preferred && paymentMethodList.value.includes(preferred)
        ? preferred
        : paymentMethodList.value[0] || '';
    if (paymentMethodList.value.length === 0) {
      if (!isEditMode.value) {
        paymentMethod.value = '__add_new__';
        isAddingPayment.value = true;
      } else {
        paymentMethod.value = '';
      }
    } else if (!isEditMode.value) {
      if (!paymentMethod.value || !paymentMethodList.value.includes(paymentMethod.value)) {
        paymentMethod.value = defaultPaymentMethod.value || paymentMethodList.value[0];
        isAddingPayment.value = false;
      }
    }
  } catch {
    paymentMethodList.value = [...DEFAULT_PAYMENT_METHODS];
    defaultPaymentMethod.value = paymentMethodList.value[0] || '';
    if (paymentMethodList.value.length === 0) {
      if (!isEditMode.value) {
        paymentMethod.value = '__add_new__';
        isAddingPayment.value = true;
      } else {
        paymentMethod.value = '';
      }
    } else if (!isEditMode.value) {
      if (!paymentMethod.value || !paymentMethodList.value.includes(paymentMethod.value)) {
        paymentMethod.value = defaultPaymentMethod.value || paymentMethodList.value[0];
        isAddingPayment.value = false;
      }
    }
  }
}

/**
 * 載入店家清單與常用店家清單供 datalist、快速挑選與常用標籤使用
 */
async function loadDistinctMerchants() {
  try {
    const [list, preferred] = await Promise.all([
      getDistinctMerchants(),
      getPreferredMerchants(),
    ]);
    distinctMerchants.value = Array.isArray(list) ? list : [];
    preferredMerchants.value = Array.isArray(preferred) ? preferred : [];
    merchantOptions.value = distinctMerchants.value.map((m) => ({
      name: m,
      raw: m,
    }));
  } catch {
    distinctMerchants.value = [];
    preferredMerchants.value = [];
    merchantOptions.value = [];
  }
}

/**
 * 點選常用店家快速標籤按鈕，填入店家名稱
 *
 * @param name - 常用店家名稱
 */
function applyPreferredMerchant(name: string) {
  merchant.value = name;
}

onMounted(async () => {
  await Promise.all([loadCategories(), loadPaymentMethodsList(), loadDistinctMerchants()]);
  isListsLoaded.value = true;
  if (isEditMode.value) {
    reconcileEditSelections();
  } else if (expenseCategoryList.value.length > 0 && items.value.length > 0 && !items.value[0].category) {
    items.value[0].category = defaultExpenseCategory.value || expenseCategoryList.value[0];
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
 * 新增一列空白購買商品（沿用上一筆商品明細已選分類，若無則帶入預設分類）
 */
function addItem() {
  const prevCat = items.value[items.value.length - 1]?.category?.trim();
  const inheritedCategory =
    prevCat && prevCat !== '__add_new__'
      ? prevCat
      : defaultExpenseCategory.value || expenseCategoryList.value[0] || '';
  items.value.push({
    id: `item-${Date.now()}`,
    name: '',
    quantity: 1,
    unitPrice: 0,
    category: inheritedCategory,
  });
}

/**
 * 移除指定索引的購買商品（僅剩一筆時重設為空白預設值，確保至少保留一列）
 */
function removeItem(index: number) {
  if (items.value.length > 1) {
    items.value.splice(index, 1);
  } else if (items.value.length === 1 && items.value[0]) {
    // 僅剩最後一筆時重設為空白商品列，避免破壞表單至少一列的預設結構
    items.value[0] = {
      id: `item-${Date.now()}`,
      name: '',
      quantity: 1,
      unitPrice: 0,
      category: defaultExpenseCategory.value || expenseCategoryList.value[0] || '',
    };
  }
}

/**
 * 數量輸入框取得焦點時自動全選內容，方便直接輸入新數量
 * 使用 requestAnimationFrame 避免滑鼠點擊時的 mouseup 事件取消選取範圍
 */
function handleQuantityFocus(e: FocusEvent) {
  const target = e.target as HTMLInputElement | null;
  if (!target) return;
  target.select();
  requestAnimationFrame(() => {
    target.select();
  });
}

/**
 * 新增一筆獨立折抵項目（僅在有有效商品且有可用分類時允許）
 */
function addDiscount() {
  if (!canAddDiscount.value) return;
  discounts.value.push({
    id: `disc-${Date.now()}`,
    name: '',
    amount: 0,
    category: availableDiscountCategories.value[0],
  });
}

/**
 * 移除指定索引的折抵項目
 */
function removeDiscount(index: number) {
  discounts.value.splice(index, 1);
}

/**
 * 接收電子發票 QR Code 或紙本發票 AI 辨識結果並帶入欄位
 * - 店家名稱：僅帶入照片實際辨識文字（不自動對應常用店家）。
 * - 商品分類：優先套用存在於現有支出分類清單之對應分類，否則比照手動新增品項規則 fallback。
 * - 折扣匯入：嚴格遵循現有折扣約束（無有效商品分類不匯入、空白名稱保留給使用者填寫、
 *   無明確分類比照 addDiscount 預設帶入首個有效商品分類、並以 clampDiscountsToCategoryLimits 檢核上限）。
 */
function handleInvoiceParsed(result: ParsedInvoiceResult) {
  clearValidationError();
  invoiceImportNotices.value = [];

  if (result.date && result.date.trim()) {
    expenseDate.value = result.date.trim();
  } else if (result.source === 'paper') {
    invoiceImportNotices.value.push('紙本發票未辨識出確切開立日期，已保留目前表單日期，請手動確認。');
  }

  if (result.merchant && result.merchant.trim()) {
    merchant.value = result.merchant.trim();
  }

  invoiceNumber.value = result.invoiceNumber || '';
  invoiceRandomCode.value = result.randomCode || '';

  const fallbackCategory =
    defaultExpenseCategory.value || expenseCategoryList.value[0] || '';

  if (result.items && result.items.length > 0) {
    items.value = result.items.map((it, idx) => {
      const candidateCategory =
        it.category && it.category !== '未分類' ? it.category.trim() : '';
      const validCategory =
        candidateCategory && expenseCategoryList.value.includes(candidateCategory)
          ? candidateCategory
          : '';
      return {
        id: `invoice-item-${idx}-${Date.now()}`,
        name: it.name,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        category: validCategory || fallbackCategory,
      };
    });
  } else if (result.source === 'paper' && result.totalAmount > 0) {
    items.value = [
      {
        id: `invoice-item-0-${Date.now()}`,
        name: '',
        quantity: 1,
        unitPrice: result.totalAmount,
        category: fallbackCategory,
      },
    ];
    invoiceImportNotices.value.push('發票未辨識出細項品名，已先帶入總計金額，請補填商品品名。');
  }

  // 先重置既有折扣，再依最新商品分類與小計上限套用發票辨識折扣
  discounts.value = [];
  const rawDiscounts = Array.isArray(result.discounts) ? result.discounts : [];
  const normalizedIncomingDiscounts = rawDiscounts
    .map((d) => {
      const rawAmt = Number(d.amount);
      const absAmt = Number.isFinite(rawAmt) ? Math.abs(Math.round(rawAmt)) : 0;
      return {
        // 若照片未印出名稱，刻意保留空白交由使用者自行輸入
        name: typeof d.name === 'string' ? d.name.trim() : '',
        amount: absAmt,
        category: typeof d.category === 'string' ? d.category.trim() : '',
      };
    })
    .filter((d) => d.amount > 0);

  if (normalizedIncomingDiscounts.length === 0) {
    return;
  }

  const availableCats = availableDiscountCategories.value;
  if (availableCats.length === 0) {
    const summary = normalizedIncomingDiscounts
      .map((d) => `${d.name || '未命名折扣'} NT$${d.amount}`)
      .join('、');
    invoiceImportNotices.value.push(
      `發票辨識出折抵項目（${summary}），因目前尚無含有效分類之商品，依規則未自動匯入；請先選擇商品分類後再手動新增。`
    );
    return;
  }

  const defaultDiscCategory = availableCats[0];
  let hasFallbackAssignedOnMultiCategory = false;

  const stagedDiscounts: Array<{ form: FormDiscount; originalAmount: number }> =
    normalizedIncomingDiscounts.map((d, dIdx) => {
      const matchedCategory = availableCats.includes(d.category) ? d.category : '';
      if (!matchedCategory && availableCats.length > 1) {
        hasFallbackAssignedOnMultiCategory = true;
      }
      return {
        form: {
          id: `invoice-disc-${dIdx}-${Date.now()}`,
          name: d.name,
          amount: d.amount,
          category: matchedCategory || defaultDiscCategory,
        },
        originalAmount: d.amount,
      };
    });

  discounts.value = stagedDiscounts.map((entry) => entry.form);
  clampDiscountsToCategoryLimits();

  const keptDiscounts: FormDiscount[] = [];
  for (const entry of stagedDiscounts) {
    const adjustedAmount = entry.form.amount;
    const label = entry.form.name || '未命名折扣';
    if (adjustedAmount <= 0) {
      invoiceImportNotices.value.push(
        `折抵「${label}」(原 NT$${entry.originalAmount}) 超過分類「${entry.form.category}」剩餘可折額度而未匯入，請手動核對或拆至其他分類。`
      );
      continue;
    }
    if (adjustedAmount < entry.originalAmount) {
      invoiceImportNotices.value.push(
        `折抵「${label}」超過分類「${entry.form.category}」上限，已自 NT$${entry.originalAmount} 調整為 NT$${adjustedAmount}，請核對或手動拆至其他分類。`
      );
    }
    keptDiscounts.push(entry.form);
  }
  discounts.value = keptDiscounts;

  if (hasFallbackAssignedOnMultiCategory && keptDiscounts.length > 0) {
    invoiceImportNotices.value.push(
      `此發票含多項商品分類，未明確指定歸屬之折抵已預設套用「${defaultDiscCategory}」，儲存前請確認折扣分類。`
    );
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
  clearValidationError();
  expenseDate.value = getTodayDateString();
  merchant.value = '';
  expenseNote.value = '';
  items.value = [
    {
      id: `item-${Date.now()}`,
      name: '',
      quantity: 1,
      unitPrice: 0,
      category: defaultExpenseCategory.value || expenseCategoryList.value[0] || '',
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
  invoiceImportNotices.value = [];
  showAddCategory.value = false;
  newCategoryName.value = '';
  categoryTargetItemIndex.value = null;
  customPaymentName.value = '';
  if (paymentMethodList.value.length === 0) {
    paymentMethod.value = '__add_new__';
    isAddingPayment.value = true;
  } else {
    paymentMethod.value = defaultPaymentMethod.value || paymentMethodList.value[0];
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
 * 驗證支出表單所有必填與數值邊界規則
 */
function validateExpenseForm(): boolean {
  clearValidationError();

  if (!expenseDate.value || !expenseDate.value.trim()) {
    return setValidationError('date', '請選擇消費日期');
  }

  if (!merchant.value.trim()) {
    return setValidationError('merchant', '請輸入店家名稱');
  }

  if (items.value.length === 0) {
    return setValidationError('item-name-0', '請至少填寫一筆購買商品明細');
  }

  for (let idx = 0; idx < items.value.length; idx++) {
    const it = items.value[idx];
    if (!it.name.trim()) {
      return setValidationError(`item-name-${idx}`, '請輸入商品品名');
    }

    const cat = it.category?.trim();
    const isPendingNewCat =
      showAddCategory.value &&
      categoryTargetItemIndex.value === idx &&
      newCategoryName.value.trim() !== '';

    if (!isPendingNewCat && (!cat || cat === '__add_new__' || !expenseCategoryList.value.includes(cat))) {
      if (showAddCategory.value && categoryTargetItemIndex.value === idx) {
        return setValidationError('custom-category', '請輸入新支出分類名稱');
      }
      return setValidationError(`item-cat-${idx}`, '請選擇商品分類');
    }

    if (isBlankOrInvalidNumber(it.quantity) || Number(it.quantity) <= 0) {
      return setValidationError(`item-qty-${idx}`, '商品數量必須大於 0');
    }

    if (isBlankOrInvalidNumber(it.unitPrice) || Number(it.unitPrice) < 0) {
      return setValidationError(`item-price-${idx}`, '商品單價不可為空白或負數');
    }
  }

  for (let dIdx = 0; dIdx < discounts.value.length; dIdx++) {
    const d = discounts.value[dIdx];
    if (!d.name.trim()) {
      return setValidationError(`disc-name-${dIdx}`, '請輸入折扣名稱');
    }
    const discCat = d.category?.trim();
    if (!discCat || !availableDiscountCategories.value.includes(discCat)) {
      return setValidationError(`disc-cat-${dIdx}`, '請選擇有效的折扣分類');
    }
    if (isBlankOrInvalidNumber(d.amount) || Number(d.amount) <= 0) {
      return setValidationError(`disc-amount-${dIdx}`, '折抵金額必須大於 0');
    }
  }

  const rawPayment = paymentMethod.value?.trim() || '';
  const isAddingState = isAddingPayment.value || rawPayment === '__add_new__';
  if (isAddingState) {
    if (!customPaymentName.value.trim()) {
      return setValidationError('custom-payment', '請輸入新支付方式名稱');
    }
  } else if (!rawPayment || !paymentMethodList.value.includes(rawPayment)) {
    return setValidationError('payment', '請選擇支付方式');
  }

  if (isForeignExpense.value) {
    if (isBlankOrInvalidNumber(foreignExpenseAmount.value) || Number(foreignExpenseAmount.value) <= 0) {
      return setValidationError('foreign-amount', '外幣金額必須大於 0');
    }
    if (isBlankOrInvalidNumber(netTwdAmount.value) || Number(netTwdAmount.value) < 0) {
      return setValidationError('net-twd', '請輸入台幣扣款金額（可為 0，不可為負數）');
    }
    if (isBlankOrInvalidNumber(feeAmountInput.value) || Number(feeAmountInput.value) < 0) {
      return setValidationError('fee', '請輸入手續費金額（可為 0，不可為負數）');
    }
  }

  return true;
}

/**
 * 送出儲存消費支出記錄
 */
async function handleSaveExpense() {
  if (!validateExpenseForm()) {
    return;
  }

  // 若使用者正在新增分類且已填寫名稱，先建立並套用至對應品項
  if (showAddCategory.value) {
    const cleanCat = newCategoryName.value.trim();
    if (cleanCat) {
      await handleCreateCategory(cleanCat);
      if (categoryTargetItemIndex.value !== null && items.value[categoryTargetItemIndex.value]) {
        items.value[categoryTargetItemIndex.value].category = cleanCat;
      }
    }
  }

  // 處理支付方式（不允許靜默 fallback）
  let finalPaymentMethod = paymentMethod.value.trim();
  const isAddingState = isAddingPayment.value || finalPaymentMethod === '__add_new__';
  if (isAddingState) {
    finalPaymentMethod = customPaymentName.value.trim();
    try {
      await addPaymentMethod(finalPaymentMethod);
    } catch {
      // 忽略已存在或重複錯誤
    }
  }

  const expenseItems: ExpenseItem[] = items.value.map((it) => {
    const qty = Number(it.quantity);
    const price = Number(it.unitPrice);
    return {
      id: it.id,
      type: 'item',
      name: it.name.trim(),
      quantity: qty,
      unitPrice: price,
      subtotal: qty * price,
      category: it.category.trim(),
    };
  });

  if (discounts.value.length > 0 && availableDiscountCategories.value.length > 0) {
    clampDiscountsToCategoryLimits();
    for (const d of discounts.value) {
      const amt = Number(d.amount);
      expenseItems.push({
        id: d.id,
        type: 'discount',
        name: d.name.trim(),
        quantity: 1,
        unitPrice: -amt,
        subtotal: -amt,
        category: d.category.trim(),
      });
    }
  }

  const feeAmount = isForeignExpense.value && foreignExpenseCalc.value ? foreignExpenseCalc.value.feeAmount : 0;
  const effectiveRate = isForeignExpense.value && foreignExpenseCalc.value ? foreignExpenseCalc.value.effectiveRate : undefined;

  const record: ExpenseRecord = {
    date: expenseDate.value,
    merchant: merchant.value.trim(),
    paymentMethod: finalPaymentMethod,
    totalAmount: totalExpenseAmount.value,
    isForeign: isForeignExpense.value,
    currency: isForeignExpense.value ? foreignExpenseCurrency.value : undefined,
    foreignAmount: isForeignExpense.value ? Number(foreignExpenseAmount.value) : undefined,
    netTwdAmount: isForeignExpense.value ? Number(netTwdAmount.value) : undefined,
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

  // 若為新店家，自動寫入店家設定表（不自動設為常用），並重新整理清單
  if (record.merchant && !distinctMerchants.value.includes(record.merchant)) {
    try {
      await addMerchant(record.merchant);
    } catch {
      // 已存在則忽略
    }
    await loadDistinctMerchants();
  }

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
      <span>
        發票號碼：{{ invoiceNumber }}<template v-if="invoiceRandomCode"> (隨機碼：{{ invoiceRandomCode }})</template>
      </span>
      <button
        type="button"
        class="text-slate-400 hover:text-slate-600 ml-2"
        @click="invoiceNumber = ''; invoiceRandomCode = ''"
      >
        ✕
      </button>
    </div>

    <!-- 發票匯入核對提醒區（例如紙本未辨識日期、折扣上限調整或歸屬核對） -->
    <div
      v-if="invoiceImportNotices.length > 0"
      data-testid="invoice-import-notices"
      class="text-xs text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg space-y-1"
    >
      <div class="flex items-start justify-between gap-2">
        <span class="font-semibold">發票匯入提醒（請核對後再儲存）：</span>
        <button
          type="button"
          class="text-amber-500 hover:text-amber-700 shrink-0"
          aria-label="關閉提醒"
          @click="invoiceImportNotices = []"
        >
          ✕
        </button>
      </div>
      <ul class="list-disc pl-4 space-y-0.5 text-[11px] leading-relaxed">
        <li v-for="(notice, nIdx) in invoiceImportNotices" :key="nIdx">{{ notice }}</li>
      </ul>
    </div>

    <!-- 消費日期與店家輸入 (含 [選擇] 按鈕) -->
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label for="expense-date" class="block text-xs font-medium text-slate-500 mb-1">消費日期</label>
        <input
          id="expense-date"
          v-model="expenseDate"
          type="date"
          :class="errorBorderClass('date')"
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
          :class="errorBorderClass('merchant')"
          class="w-full text-sm border border-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-teal-500 focus:outline-none"
        />
        <datalist id="merchant-options-list">
          <option v-for="m in distinctMerchants" :key="m" :value="m" />
        </datalist>
      </div>

      <!-- 常用店家快速標籤列（僅於設定頁有標記 ★ 店家時顯示） -->
      <div
        v-if="preferredMerchants.length > 0"
        id="preferred-merchants-list"
        class="col-span-2 flex flex-wrap gap-1 items-center"
      >
        <span class="text-[11px] text-slate-400">常用店家：</span>
        <button
          v-for="m in preferredMerchants"
          :key="m"
          type="button"
          :class="
            merchant.trim() === m
              ? 'bg-teal-600 text-white border-teal-600'
              : 'bg-teal-50 text-teal-700 hover:bg-teal-100 border-teal-200'
          "
          class="text-[11px] border px-2 py-0.5 rounded-md transition-colors"
          @click="applyPreferredMerchant(m)"
        >
          {{ m }}
        </button>
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
              :class="errorBorderClass(`item-name-${idx}`)"
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
              :class="errorBorderClass(`item-cat-${idx}`)"
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
              :class="errorBorderClass(`item-qty-${idx}`)"
              class="w-full text-sm border border-slate-200 rounded-lg p-1.5 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
              @focus="handleQuantityFocus"
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
                :class="errorBorderClass(`item-price-${idx}`)"
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
            placeholder="輸入新分類名稱"
            :class="errorBorderClass('custom-category')"
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
          :disabled="!canAddDiscount"
          :title="!canAddDiscount ? '請先填寫商品並選擇商品分類' : ''"
          class="text-xs text-rose-600 hover:text-rose-700 font-medium py-1 px-2 border border-rose-200 rounded-lg hover:bg-rose-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
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
              class="text-xs text-rose-500 hover:text-rose-700 font-medium px-2 py-1 rounded hover:bg-rose-50"
              @click="removeDiscount(dIdx)"
              aria-label="刪除此折扣"
            >
              刪除
            </button>
          </div>

          <div class="grid grid-cols-12 gap-2">
            <div class="col-span-12 sm:col-span-5">
              <label :for="`disc-name-${dIdx}`" class="block text-[11px] text-slate-500 mb-0.5">折扣名稱</label>
              <input
                :id="`disc-name-${dIdx}`"
                v-model="disc.name"
                type="text"
                placeholder="折扣說明"
                :class="errorBorderClass(`disc-name-${dIdx}`)"
                class="w-full text-sm border border-slate-200 rounded-lg p-1.5 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
              />
            </div>
            <div class="col-span-7 sm:col-span-4">
              <label :for="`disc-cat-${dIdx}`" class="block text-[11px] text-slate-500 mb-0.5">折扣分類</label>
              <select
                :id="`disc-cat-${dIdx}`"
                v-model="disc.category"
                :class="errorBorderClass(`disc-cat-${dIdx}`)"
                class="w-full text-sm border border-slate-200 rounded-lg p-1.5 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
                @change="handleDiscountCategorySelectChange(dIdx)"
              >
                <option v-for="cat in getDiscountCategoryOptions(disc)" :key="cat" :value="cat">
                  {{ cat }}
                </option>
              </select>
            </div>
            <div class="col-span-5 sm:col-span-3">
              <label :for="`disc-amount-${dIdx}`" class="block text-[11px] text-slate-500 mb-0.5">折抵金額</label>
              <input
                :id="`disc-amount-${dIdx}`"
                v-model.number="disc.amount"
                type="number"
                min="0"
                :max="getMaxDiscountAmount(dIdx)"
                placeholder="折抵金額"
                :class="errorBorderClass(`disc-amount-${dIdx}`)"
                class="w-full text-sm border border-slate-200 rounded-lg p-1.5 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
                @input="handleDiscountAmountInput(dIdx, $event)"
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
          :class="errorBorderClass('payment')"
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
            placeholder="輸入新支付方式名稱"
            :class="errorBorderClass('custom-payment')"
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
            readonly
            aria-readonly="true"
            placeholder="由商品明細扣除折扣自動帶入"
            :class="errorBorderClass('foreign-amount')"
            class="w-full text-sm border border-slate-200 rounded-lg p-2 bg-slate-100 text-slate-500 cursor-not-allowed focus:outline-none"
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
            min="0"
            placeholder="台幣扣款"
            :class="errorBorderClass('net-twd')"
            class="w-full text-sm border border-slate-200 rounded-lg p-2 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
          />
        </div>
        <div>
          <label for="expense-fee-amount" class="block text-xs font-medium text-slate-600 mb-1">手續費金額 (NT$)</label>
          <input
            id="expense-fee-amount"
            v-model.number="feeAmountInput"
            type="number"
            min="0"
            placeholder="輸入手續費金額"
            :class="errorBorderClass('fee')"
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

    <!-- 錯誤提示 -->
    <p v-if="errorMessage" id="expense-error-message" class="text-xs text-rose-600 font-medium text-right">
      {{ errorMessage }}
    </p>

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
      :categories="expenseCategoryList"
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
