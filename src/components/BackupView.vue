<script setup lang="ts">
/**
 * @file BackupView.vue
 * @description 本機資料備份與還原管理介面元件
 *
 * 核心業務職責：
 * 1. 本地資料匯出：調用 exportBackupData 將 IndexedDB 所有記錄序列化為標準 JSON 檔案並透過瀏覽器觸發下載。
 * 2. 備份檔案一鍵還原：依規格書要求以一鍵還原（覆寫全庫模式），呼叫 importBackupData 執行結構驗證與批次資料庫寫入。
 * 3. 即時反饋統計：清晰展示還原成功之各資料表（支出、收入、回饋、分類）匯入筆數與錯誤原因防禦。
 */

import { ref } from 'vue';
import { exportBackupData, importBackupData } from '@/utils/backup';
import { getTodayDateString } from '@/utils/date';

const fileInputRef = ref<HTMLInputElement | null>(null);
const statusMessage = ref('');
const isError = ref(false);

/**
 * 匯出本地備份並觸發瀏覽器下載
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

    statusMessage.value = '備份檔案匯出成功！';
    isError.value = false;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err) || '未知錯誤';
    statusMessage.value = `匯出失敗：${errorMessage}`;
    isError.value = true;
  }
}

/**
 * 處理檔案選擇與一鍵覆寫還原
 */
async function handleFileChange(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const content = e.target?.result as string;
      // 依規格書 L57 要求以一鍵還原（預設以 overwrite 還原全庫資料）
      const result = await importBackupData(content, 'overwrite');

      if (result.success) {
        statusMessage.value = `還原成功！已匯入：支出 ${result.importedCount.expenses} 筆、收入 ${result.importedCount.incomes} 筆、回饋 ${result.importedCount.rewards} 筆、分類 ${result.importedCount.categories} 筆`;
        isError.value = false;
      } else {
        statusMessage.value = `還原失敗：${result.error || '資料格式錯誤'}`;
        isError.value = true;
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err) || '檔案解析異常';
      statusMessage.value = `還原失敗：${errorMessage}`;
      isError.value = true;
    } finally {
      if (fileInputRef.value) {
        fileInputRef.value.value = '';
      }
    }
  };

  reader.readAsText(file);
}

/**
 * 觸發檔案選擇對話框
 */
function triggerFileInput() {
  fileInputRef.value?.click();
}
</script>

<template>
  <div class="space-y-4">
    <!-- 匯出備份卡片 -->
    <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 space-y-3">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center text-teal-600 text-lg">
          💾
        </div>
        <div>
          <h3 class="text-base font-bold text-slate-800">匯出本地資料備份</h3>
          <p class="text-xs text-slate-500 mt-0.5">將所有支出、收入與回饋記錄打包為 JSON 檔案</p>
        </div>
      </div>

      <div class="pt-2">
        <button
          type="button"
          class="w-full py-3 bg-teal-600 hover:bg-teal-700 text-white font-bold text-sm rounded-xl shadow-md transition-all active:scale-[0.99] flex items-center justify-center gap-2"
          @click="handleExport"
        >
          <span>📥</span>
          <span>匯出備份 (JSON)</span>
        </button>
      </div>
    </div>

    <!-- 一鍵還原卡片 -->
    <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 space-y-4">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center text-amber-600 text-lg">
          🔄
        </div>
        <div>
          <h3 class="text-base font-bold text-slate-800">一鍵還原備份</h3>
          <p class="text-xs text-slate-500 mt-0.5">選取 JSON 備份檔，一鍵還原全庫資料（覆寫現有記錄）</p>
        </div>
      </div>

      <!-- 隱藏的檔案選擇器 (加上穩定 id 方便測試選取) -->
      <input
        id="backup-file-input"
        ref="fileInputRef"
        type="file"
        accept=".json,application/json"
        class="hidden"
        @change="handleFileChange"
      />

      <!-- 一鍵還原觸發按鈕 -->
      <div class="pt-2">
        <button
          id="btn-restore-backup"
          type="button"
          class="w-full py-3 bg-slate-800 hover:bg-slate-900 text-white font-bold text-sm rounded-xl shadow-md transition-all active:scale-[0.99] flex items-center justify-center gap-2"
          @click="triggerFileInput"
        >
          <span>📂</span>
          <span>一鍵還原 (JSON)</span>
        </button>
      </div>
    </div>

    <!-- 狀態提示訊息 -->
    <div
      v-if="statusMessage"
      class="p-3.5 rounded-xl text-xs font-medium border"
      :class="isError ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-teal-50 text-teal-800 border-teal-200'"
    >
      {{ statusMessage }}
    </div>
  </div>
</template>
