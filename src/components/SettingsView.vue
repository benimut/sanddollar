<script setup lang="ts">
/**
 * @file SettingsView.vue
 * @description Sand Dollar 設定與維護管理主視圖元件
 *
 * 核心業務職責：
 * 1. 分類管理 (Category CRUD)：支援支出分類與收入分類切換、新增、編輯名稱與刪除。
 * 2. 支付方式管理 (Payment Method CRUD)：支援自訂支付方式新增、編輯與刪除。
 * 3. 收入來源管理 (Income Source CRUD)：支援常用收入來源新增、編輯與刪除。
 * 4. 回饋來源管理 (Reward Source CRUD)：支援回饋來源名稱新增、編輯與刪除。
 * 5. 資料備份與還原：整合 exportBackupData 與 importBackupData，支援本機 JSON 檔案備份與一鍵覆寫還原。
 * 6. 危險操作區域：支援清空全庫資料 (clearAllDatabaseData)，具備嚴謹二次防呆警示機制。
 */

import { ref, onMounted } from 'vue';
import SettingsItemManager from './SettingsItemManager.vue';
import {
  getCategories,
  addCategory,
  updateCategory,
  deleteCategory,
  getPaymentMethodRecords,
  addPaymentMethod,
  updatePaymentMethod,
  deletePaymentMethod,
  getIncomeSourceRecords,
  addIncomeSource,
  updateIncomeSource,
  deleteIncomeSource,
  getRewardSourceRecords,
  addRewardSource,
  updateRewardSource,
  deleteRewardSource,
  clearAllDatabaseData,
} from '@/db';
import { exportBackupData, importBackupData } from '@/utils/backup';
import { getTodayDateString } from '@/utils/date';
import { sortByNameNaturally } from '@/utils/sort';
import type {
  CategoryRecord,
  PaymentMethodRecord,
  IncomeSourceRecord,
  RewardSourceRecord,
} from '@/types';

// ==================== 1. 分類管理狀態 ====================
/** 當前選取的分類類別：'expense' 支出 或 'income' 收入 */
const selectedCategoryType = ref<'expense' | 'income'>('expense');
/** 當前分類列表 */
const categoryList = ref<CategoryRecord[]>([]);
/** 新增分類名稱輸入值 */
const newCategoryName = ref('');
/** 正在編輯中的分類 ID */
const editingCategoryId = ref<number | null>(null);
/** 正在編輯中的分類名稱 */
const editingCategoryName = ref('');

/**
 * 載入指定類型分類清單
 */
async function loadCategories() {
  categoryList.value = sortByNameNaturally(await getCategories(selectedCategoryType.value));
}

/**
 * 切換分類類型
 */
async function switchCategoryType(type: 'expense' | 'income') {
  selectedCategoryType.value = type;
  editingCategoryId.value = null;
  await loadCategories();
}

/**
 * 新增分類
 */
async function handleAddCategory() {
  const name = newCategoryName.value.trim();
  if (!name) return;
  try {
    await addCategory({
      name,
      type: selectedCategoryType.value,
      isDefault: false,
    });
    newCategoryName.value = '';
    await loadCategories();
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : '新增分類失敗');
  }
}

/**
 * 開始編輯分類
 */
function startEditCategory(cat: CategoryRecord) {
  if (cat.id !== undefined) {
    editingCategoryId.value = cat.id;
    editingCategoryName.value = cat.name;
  }
}

/**
 * 儲存編輯分類
 */
async function handleSaveCategory(id: number) {
  const name = editingCategoryName.value.trim();
  if (!name) return;
  try {
    await updateCategory(id, name);
    editingCategoryId.value = null;
    await loadCategories();
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : '更新分類失敗');
  }
}

/**
 * 刪除分類
 */
async function handleDeleteCategory(id: number) {
  await deleteCategory(id);
  if (editingCategoryId.value === id) {
    editingCategoryId.value = null;
  }
  await loadCategories();
}

// ==================== 2. 支付方式管理狀態 ====================
/** 當前支付方式清單列表 */
const paymentMethodList = ref<PaymentMethodRecord[]>([]);

/**
 * 載入支付方式清單
 */
async function loadPaymentMethods() {
  paymentMethodList.value = await getPaymentMethodRecords();
}

/**
 * 新增支付方式
 */
async function handleAddPaymentMethod(name: string) {
  try {
    await addPaymentMethod(name);
    await loadPaymentMethods();
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : '新增支付方式失敗');
  }
}

/**
 * 儲存編輯支付方式
 */
async function handleUpdatePaymentMethod(payload: { id: number; name: string }) {
  try {
    await updatePaymentMethod(payload.id, payload.name);
    await loadPaymentMethods();
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : '更新支付方式失敗');
  }
}

/**
 * 刪除支付方式
 */
async function handleDeletePaymentMethod(id: number) {
  await deletePaymentMethod(id);
  await loadPaymentMethods();
}

// ==================== 3. 收入來源管理狀態 ====================
/** 當前收入來源清單列表 */
const incomeSourceList = ref<IncomeSourceRecord[]>([]);

/**
 * 載入收入來源清單
 */
async function loadIncomeSources() {
  incomeSourceList.value = await getIncomeSourceRecords();
}

/**
 * 新增收入來源
 */
async function handleAddIncomeSource(name: string) {
  try {
    await addIncomeSource(name);
    await loadIncomeSources();
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : '新增收入來源失敗');
  }
}

/**
 * 儲存編輯收入來源
 */
async function handleUpdateIncomeSource(payload: { id: number; name: string }) {
  try {
    await updateIncomeSource(payload.id, payload.name);
    await loadIncomeSources();
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : '更新收入來源失敗');
  }
}

/**
 * 刪除收入來源
 */
async function handleDeleteIncomeSource(id: number) {
  await deleteIncomeSource(id);
  await loadIncomeSources();
}

// ==================== 4. 回饋來源管理狀態 ====================
/** 當前回饋來源清單列表 */
const rewardSourceList = ref<RewardSourceRecord[]>([]);

/**
 * 載入回饋來源清單
 */
async function loadRewardSources() {
  rewardSourceList.value = await getRewardSourceRecords();
}

/**
 * 新增回饋來源
 */
async function handleAddRewardSource(name: string) {
  try {
    await addRewardSource(name);
    await loadRewardSources();
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : '新增回饋來源失敗');
  }
}

/**
 * 儲存編輯回饋來源
 */
async function handleUpdateRewardSource(payload: { id: number; name: string }) {
  try {
    await updateRewardSource(payload.id, payload.name);
    await loadRewardSources();
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : '更新回饋來源失敗');
  }
}

/**
 * 刪除回饋來源
 */
async function handleDeleteRewardSource(id: number) {
  await deleteRewardSource(id);
  await loadRewardSources();
}

// ==================== 5. 備份與還原管理 ====================
/** 備份檔案輸入元素參照 (隱藏之 HTML 檔案選擇器) */
const fileInputRef = ref<HTMLInputElement | null>(null);
/** 備份或還原操作之狀態提示訊息 */
const backupStatusMessage = ref('');
/** 標記備份或還原是否發生錯誤之狀態布林值 */
const isBackupError = ref(false);

/**
 * 匯出本地備份檔案
 */
async function handleExport() {
  try {
    const jsonString = await exportBackupData();
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const dateStr = getTodayDateString().replace(/-/g, '');
    const filename = `sanddollar-backup-${dateStr}.json`;

    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    backupStatusMessage.value = '備份檔案匯出成功！';
    isBackupError.value = false;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err) || '未知錯誤';
    backupStatusMessage.value = `匯出失敗：${errorMessage}`;
    isBackupError.value = true;
  }
}

/**
 * 觸發檔案選擇器
 */
function triggerFileInput() {
  fileInputRef.value?.click();
}

/**
 * 處理還原檔案選擇
 */
async function handleFileChange(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const content = e.target?.result as string;
      const result = await importBackupData(content, 'overwrite');

      if (result.success) {
        backupStatusMessage.value = `還原成功！已匯入：支出 ${result.importedCount.expenses} 筆、收入 ${result.importedCount.incomes} 筆、回饋 ${result.importedCount.rewards} 筆、分類 ${result.importedCount.categories} 筆、支付方式 ${result.importedCount.paymentMethods ?? 0} 筆、收入來源 ${result.importedCount.incomeSources ?? 0} 筆、回饋來源 ${result.importedCount.rewardSources ?? 0} 筆`;
        isBackupError.value = false;
        await loadAllData();
      } else {
        backupStatusMessage.value = `還原失敗：${result.error || '資料格式錯誤'}`;
        isBackupError.value = true;
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err) || '檔案解析異常';
      backupStatusMessage.value = `還原失敗：${errorMessage}`;
      isBackupError.value = true;
    } finally {
      if (fileInputRef.value) {
        fileInputRef.value.value = '';
      }
    }
  };

  reader.readAsText(file);
}

// ==================== 6. 危險區域：清除所有資料 (二次同意) ====================
/** 清除流程狀態：0 為未觸發，1 為第一次確認中，2 為第二次防呆確認中 */
const clearConfirmStep = ref<0 | 1 | 2>(0);
/** 清除成功訊息 */
const clearSuccessMessage = ref('');

/**
 * 觸發清除所有資料對話框
 */
function handleStartClear() {
  clearConfirmStep.value = 1;
  clearSuccessMessage.value = '';
}

/**
 * 取消清除操作
 */
function handleCancelClear() {
  clearConfirmStep.value = 0;
}

/**
 * 執行第一次確認，進入第二次警示確認
 */
function handleConfirmClearStep1() {
  clearConfirmStep.value = 2;
}

/**
 * 執行第二次確認，真正執行資料庫清空
 */
async function handleConfirmClearStep2() {
  try {
    await clearAllDatabaseData();
    clearConfirmStep.value = 0;
    clearSuccessMessage.value = '資料清除成功！所有記帳記錄與設定已全數清空。';
    await loadAllData();
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : '清除資料失敗');
  }
}

// ==================== 資料初始化 ====================
async function loadAllData() {
  await Promise.all([
    loadCategories(),
    loadPaymentMethods(),
    loadIncomeSources(),
    loadRewardSources(),
  ]);
}

onMounted(() => {
  loadAllData();
});
</script>

<template>
  <div id="settings-view" class="settings-container space-y-6 max-w-md mx-auto pb-10">
    <!-- 頂部標題列 -->
    <div class="flex items-center justify-between pb-2 border-b border-slate-200">
      <div>
        <h2 class="text-xl font-bold text-slate-800">設定與資料維護</h2>
        <p class="text-xs text-slate-500 mt-0.5">管理分類、支付方式、來源與備份</p>
      </div>
      <div class="text-2xl">⚙️</div>
    </div>

    <!-- 1. 分類管理區塊 -->
    <section class="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-bold text-slate-700 flex items-center gap-1.5">
          <span>🏷️</span>
          <span>分類管理</span>
        </h3>
        <!-- 支出 / 收入 分類切換標籤 -->
        <div class="flex bg-slate-100 p-0.5 rounded-lg text-xs">
          <button
            id="tab-category-expense"
            type="button"
            class="px-2.5 py-1 rounded-md font-medium transition-colors"
            :class="selectedCategoryType === 'expense' ? 'bg-white text-teal-700 shadow-xs font-bold' : 'text-slate-500 hover:text-slate-700'"
            @click="switchCategoryType('expense')"
          >
            支出分類
          </button>
          <button
            id="tab-category-income"
            type="button"
            class="px-2.5 py-1 rounded-md font-medium transition-colors"
            :class="selectedCategoryType === 'income' ? 'bg-white text-teal-700 shadow-xs font-bold' : 'text-slate-500 hover:text-slate-700'"
            @click="switchCategoryType('income')"
          >
            收入分類
          </button>
        </div>
      </div>

      <!-- 新增分類輸入區 -->
      <div class="flex gap-2">
        <input
          id="input-category-name"
          v-model="newCategoryName"
          type="text"
          :placeholder="selectedCategoryType === 'expense' ? '輸入新支出分類名稱...' : '輸入新收入分類名稱...'"
          class="flex-1 px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-600 bg-slate-50/50"
          @keyup.enter="handleAddCategory"
        />
        <button
          id="btn-add-category"
          type="button"
          class="px-3.5 py-2 bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs rounded-xl shadow-xs transition-colors shrink-0"
          @click="handleAddCategory"
        >
          新增
        </button>
      </div>

      <!-- 分類列表 -->
      <div id="category-list" class="category-list space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
        <div
          v-for="cat in categoryList"
          :key="cat.id"
          class="flex items-center justify-between p-2 rounded-xl bg-slate-50 border border-slate-100 hover:bg-slate-100/70 transition-colors text-xs"
        >
          <!-- 編輯中狀態 -->
          <template v-if="editingCategoryId === cat.id">
            <input
              v-model="editingCategoryName"
              type="text"
              class="input-edit-category flex-1 px-2 py-1 text-xs border border-teal-500 rounded-lg mr-2 bg-white"
              @keyup.enter="handleSaveCategory(cat.id!)"
            />
            <div class="flex gap-1">
              <button
                type="button"
                class="btn-save-category px-2 py-1 bg-teal-600 text-white rounded-lg font-medium text-xs hover:bg-teal-700"
                @click="handleSaveCategory(cat.id!)"
              >
                儲存
              </button>
              <button
                type="button"
                class="px-2 py-1 bg-slate-200 text-slate-600 rounded-lg text-xs hover:bg-slate-300"
                @click="editingCategoryId = null"
              >
                取消
              </button>
            </div>
          </template>

          <!-- 正常瀏覽狀態 -->
          <template v-else>
            <span class="font-medium text-slate-700">{{ cat.name }}</span>
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="btn-edit-category px-2 py-1 text-slate-500 hover:text-teal-700 hover:bg-teal-50 rounded-lg transition-colors"
                @click="startEditCategory(cat)"
              >
                編輯
              </button>
              <button
                type="button"
                class="btn-delete-category px-2 py-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                @click="handleDeleteCategory(cat.id!)"
              >
                刪除
              </button>
            </div>
          </template>
        </div>

        <div v-if="categoryList.length === 0" class="text-center py-4 text-xs text-slate-400">
          尚無任何分類記錄
        </div>
      </div>
    </section>

    <!-- 2. 支付方式管理區塊 -->
    <SettingsItemManager
      title="支付方式管理"
      icon="💳"
      placeholder="輸入新支付方式名稱 (如: 街口支付、悠遊卡)..."
      id-prefix="payment-method"
      :items="paymentMethodList"
      empty-text="尚無任何自訂支付方式記錄"
      @add="handleAddPaymentMethod"
      @update="handleUpdatePaymentMethod"
      @delete="handleDeletePaymentMethod"
    />

    <!-- 3. 常用收入來源管理區塊 -->
    <SettingsItemManager
      title="常用收入來源管理"
      icon="💼"
      placeholder="輸入新收入來源名稱 (如: 自由接案、股息)..."
      id-prefix="income-source"
      :items="incomeSourceList"
      empty-text="尚無任何收入來源記錄"
      @add="handleAddIncomeSource"
      @update="handleUpdateIncomeSource"
      @delete="handleDeleteIncomeSource"
    />

    <!-- 4. 回饋來源管理區塊 -->
    <SettingsItemManager
      title="回饋來源管理"
      icon="🎁"
      placeholder="輸入新回饋來源名稱 (如: LINE POINTS、玉山 Pi 拍錢包)..."
      id-prefix="reward-source"
      :items="rewardSourceList"
      empty-text="尚無任何回饋來源記錄"
      @add="handleAddRewardSource"
      @update="handleUpdateRewardSource"
      @delete="handleDeleteRewardSource"
    />

    <!-- 5. 本地資料備份與還原 -->
    <section class="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 space-y-4">
      <div class="flex items-center gap-2">
        <span class="text-base">💾</span>
        <div>
          <h3 class="text-sm font-bold text-slate-700">資料備份與還原</h3>
          <p class="text-xs text-slate-500">將記帳與各項設定匯出為 JSON，或由本機檔案還原</p>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 pt-1">
        <!-- 匯出按鈕 -->
        <button
          id="btn-export-backup"
          type="button"
          class="py-2.5 px-3 bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs rounded-xl shadow-xs transition-colors flex items-center justify-center gap-1.5"
          @click="handleExport"
        >
          <span>📥</span>
          <span>匯出備份 (JSON)</span>
        </button>

        <!-- 一鍵還原按鈕 -->
        <button
          id="btn-restore-backup"
          type="button"
          class="py-2.5 px-3 bg-slate-800 hover:bg-slate-900 text-white font-bold text-xs rounded-xl shadow-xs transition-colors flex items-center justify-center gap-1.5"
          @click="triggerFileInput"
        >
          <span>📂</span>
          <span>一鍵還原 (JSON)</span>
        </button>

        <!-- 隱藏檔案選取器 -->
        <input
          id="backup-file-input"
          ref="fileInputRef"
          type="file"
          accept=".json,application/json"
          class="hidden"
          @change="handleFileChange"
        />
      </div>

      <!-- 備份狀態提示 -->
      <div
        v-if="backupStatusMessage"
        class="p-3 rounded-xl text-xs font-medium border"
        :class="isBackupError ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-teal-50 text-teal-800 border-teal-200'"
      >
        {{ backupStatusMessage }}
      </div>
    </section>

    <!-- 6. 危險區域：清除所有資料 (二次同意) -->
    <section class="bg-rose-50/40 rounded-2xl p-4 border border-rose-100 space-y-3">
      <div class="flex items-center gap-2 text-rose-700">
        <span class="text-base">⚠️</span>
        <h3 class="text-sm font-bold">危險區域</h3>
      </div>
      <p class="text-xs text-rose-600/80 leading-relaxed">
        清空目前瀏覽器中本機 IndexedDB 的所有支出、收入、回饋記錄與所有自訂分類設定。
      </p>

      <!-- 觸發按鈕（未進入確認階段時顯示） -->
      <div v-if="clearConfirmStep === 0">
        <button
          id="btn-clear-all-data"
          type="button"
          class="w-full py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs rounded-xl shadow-xs transition-colors flex items-center justify-center gap-1.5"
          @click="handleStartClear"
        >
          <span>🗑️</span>
          <span>清除所有資料</span>
        </button>
      </div>

      <!-- 第一次確認區塊 -->
      <div v-else-if="clearConfirmStep === 1" class="bg-white p-3.5 rounded-xl border border-rose-200 space-y-3 shadow-xs">
        <div class="text-xs font-bold text-rose-800 flex items-center gap-1">
          <span>⚠️ 第一次確認：</span>
          <span>您確定要清除所有資料嗎？</span>
        </div>
        <p class="text-xs text-slate-500">
          此動作將清空所有記帳記錄與設定，若未備份資料將無法找回。
        </p>
        <div class="flex gap-2">
          <button
            id="btn-confirm-clear-1"
            type="button"
            class="flex-1 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs rounded-lg transition-colors"
            @click="handleConfirmClearStep1"
          >
            確定繼續
          </button>
          <button
            id="btn-cancel-clear-1"
            type="button"
            class="flex-1 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-lg transition-colors"
            @click="handleCancelClear"
          >
            取消
          </button>
        </div>
      </div>

      <!-- 第二次防呆警示確認區塊 -->
      <div v-else-if="clearConfirmStep === 2" class="bg-rose-100/70 p-3.5 rounded-xl border border-rose-300 space-y-3 shadow-xs">
        <div class="text-xs font-bold text-rose-900 flex items-center gap-1">
          <span>🚨 極度危險警告：</span>
          <span>此操作完全無法復原！</span>
        </div>
        <p class="text-xs text-rose-800 font-medium leading-relaxed">
          請再次確認：所有本機資料（支出、收入、回饋、自訂分類與支付方式）將立刻被永久刪除！
        </p>
        <div class="flex gap-2">
          <button
            id="btn-confirm-clear-2"
            type="button"
            class="flex-1 py-2 bg-rose-700 hover:bg-rose-800 text-white font-bold text-xs rounded-lg shadow-xs transition-colors"
            @click="handleConfirmClearStep2"
          >
            我完全了解風險，確認清除
          </button>
          <button
            id="btn-cancel-clear-2"
            type="button"
            class="flex-1 py-2 bg-white hover:bg-slate-100 text-slate-700 font-bold text-xs rounded-lg border border-slate-200 transition-colors"
            @click="handleCancelClear"
          >
            取消
          </button>
        </div>
      </div>

      <!-- 清除成功訊息提示 -->
      <div
        v-if="clearSuccessMessage"
        id="clear-success-message"
        class="text-teal-700 bg-teal-50 border border-teal-200 font-bold text-xs p-3 rounded-xl flex items-center gap-1.5"
      >
        <span>✅</span>
        <span>{{ clearSuccessMessage }}</span>
      </div>
    </section>
  </div>
</template>
