<script setup lang="ts">
/**
 * @file App.vue
 * @description Sand Dollar 應用程式根版面配置與導覽管理元件
 *
 * 核心業務職責：
 * 1. 頂層版面配置 (Layout)：固定頂部 AppBar 標題區 (Sand Dollar) 與底部 NavigationBar 導覽列。
 * 2. 全域視圖導航切換：管理 currentTab 狀態（'list' 明細、'transaction' 記帳、'report' 報表、'backup' 備份），動態切換各主視圖元件。
 * 3. 響應式與無障礙支援：具備 role="navigation" 與 aria-selected 標記，提供流暢之行動端 PWA 使用體驗。
 */

import { ref } from 'vue';
import TransactionList from './components/TransactionList.vue';
import TransactionForm from './components/TransactionForm.vue';
import ReportView from './components/ReportView.vue';
import BackupView from './components/BackupView.vue';
import type { TransactionEditTarget } from './types';

/** 目前選取的分頁視圖：'list' 為明細、'transaction' 為記帳、'report' 為報表、'backup' 為備份 */
const currentTab = ref<'list' | 'transaction' | 'report' | 'backup'>('transaction');

/** 當前正在編輯的記錄（若無則為 null 處於新增模式） */
const editingTransaction = ref<TransactionEditTarget | null>(null);

/**
 * 處理來自明細列表之編輯請求
 */
function handleEditTransaction(payload: TransactionEditTarget) {
  editingTransaction.value = payload;
  currentTab.value = 'transaction';
}

/**
 * 處理記帳儲存完成，自動切換回明細分頁
 */
function handleTransactionSaved() {
  editingTransaction.value = null;
  currentTab.value = 'list';
}

/**
 * 處理取消編輯，重設編輯狀態回到新增模式
 */
function handleTransactionCancel() {
  editingTransaction.value = null;
}
</script>

<template>
  <div class="min-h-screen bg-slate-100 flex flex-col font-sans text-slate-800 pb-20">
    <!-- 頂部應用程式列 -->
    <header class="bg-teal-700 text-white shadow-sm sticky top-0 z-30">
      <div class="max-w-md mx-auto px-4 py-3.5 flex items-center justify-between">
        <h1 class="text-lg font-bold tracking-tight">Sand Dollar</h1>
      </div>
    </header>

    <!-- 主要內容區 -->
    <main class="flex-1 max-w-md mx-auto w-full p-4">
      <TransactionList
        v-if="currentTab === 'list'"
        @edit="handleEditTransaction"
      />
      <TransactionForm
        v-else-if="currentTab === 'transaction'"
        :edit-target="editingTransaction"
        @saved="handleTransactionSaved"
        @cancel="handleTransactionCancel"
      />
      <ReportView v-else-if="currentTab === 'report'" />
      <BackupView v-else-if="currentTab === 'backup'" />
    </main>

    <!-- 底部導覽列 -->
    <nav
      class="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-md border-t border-slate-200 z-40 max-w-md mx-auto"
      role="navigation"
      aria-label="主要導覽"
    >
      <div class="flex justify-around items-center h-16 px-2">
        <!-- 明細列表分頁按鈕 -->
        <button
          type="button"
          role="tab"
          :aria-selected="currentTab === 'list'"
          class="flex flex-col items-center justify-center flex-1 py-1 rounded-xl transition-all"
          :class="currentTab === 'list' ? 'text-teal-700 font-bold' : 'text-slate-400 hover:text-slate-600 font-medium'"
          @click="currentTab = 'list'"
        >
          <span class="text-lg">📋</span>
          <span class="text-xs mt-0.5">明細</span>
        </button>

        <!-- 記帳分頁按鈕 -->
        <button
          type="button"
          role="tab"
          :aria-selected="currentTab === 'transaction'"
          class="flex flex-col items-center justify-center flex-1 py-1 rounded-xl transition-all"
          :class="currentTab === 'transaction' ? 'text-teal-700 font-bold' : 'text-slate-400 hover:text-slate-600 font-medium'"
          @click="currentTab = 'transaction'"
        >
          <span class="text-lg">✍️</span>
          <span class="text-xs mt-0.5">記帳</span>
        </button>

        <!-- 報表分頁按鈕 -->
        <button
          type="button"
          role="tab"
          :aria-selected="currentTab === 'report'"
          class="flex flex-col items-center justify-center flex-1 py-1 rounded-xl transition-all"
          :class="currentTab === 'report' ? 'text-teal-700 font-bold' : 'text-slate-400 hover:text-slate-600 font-medium'"
          @click="currentTab = 'report'"
        >
          <span class="text-lg">📊</span>
          <span class="text-xs mt-0.5">報表</span>
        </button>

        <!-- 備份分頁按鈕 -->
        <button
          type="button"
          role="tab"
          :aria-selected="currentTab === 'backup'"
          class="flex flex-col items-center justify-center flex-1 py-1 rounded-xl transition-all"
          :class="currentTab === 'backup' ? 'text-teal-700 font-bold' : 'text-slate-400 hover:text-slate-600 font-medium'"
          @click="currentTab = 'backup'"
        >
          <span class="text-lg">⚙️</span>
          <span class="text-xs mt-0.5">備份</span>
        </button>
      </div>
    </nav>
  </div>
</template>
