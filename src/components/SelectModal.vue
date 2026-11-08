<script setup lang="ts" generic="T = unknown">
/**
 * @file SelectModal.vue
 * @description 手機友善之全螢幕挑選視窗元件
 *
 * 核心業務職責：
 * 1. 滿版全螢幕彈窗 (Full-screen Modal)，方便行動裝置單手觸控操作。
 * 2. 清單資料依名稱（繁體中文 localeCompare）自然排序。
 * 3. 支援即時關鍵字檢索過濾。
 * 4. 點選後即時回傳選中項目並關閉視窗。
 */

import { ref, computed } from 'vue';

export interface SelectItem<T = unknown> {
  name: string;
  detail?: string;
  raw?: T;
}

const props = withDefaults(
  defineProps<{
    isOpen: boolean;
    title: string;
    items: SelectItem<T>[];
    placeholder?: string;
  }>(),
  {
    placeholder: '搜尋名稱...',
  }
);

const emit = defineEmits<{
  (e: 'select', item: SelectItem<T>): void;
  (e: 'close'): void;
}>();

const searchQuery = ref('');

// 依名稱排序並依搜尋條件過濾
const sortedFilteredItems = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  const list = [...props.items];

  // 繁體中文自然名稱排序
  list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-Hant'));

  if (!query) return list;
  return list.filter(
    (it) =>
      it.name.toLowerCase().includes(query) ||
      (it.detail && it.detail.toLowerCase().includes(query))
  );
});

function handleSelectItem(item: SelectItem<T>) {
  emit('select', item);
  emit('close');
}
</script>

<template>
  <div
    v-if="isOpen"
    class="fixed inset-0 z-50 bg-white flex flex-col font-sans"
    role="dialog"
    aria-modal="true"
  >
    <!-- 頂部標題與返回關閉列 -->
    <header class="bg-teal-700 text-white px-4 py-3.5 flex items-center justify-between shadow-sm">
      <h2 class="text-base font-bold">{{ title }}</h2>
      <button
        type="button"
        class="text-sm bg-teal-800/80 hover:bg-teal-800 px-3 py-1 rounded-lg text-teal-100"
        @click="$emit('close')"
      >
        關閉
      </button>
    </header>

    <!-- 快速搜尋輸入列 -->
    <div class="p-4 border-b border-slate-100 bg-slate-50">
      <input
        v-model="searchQuery"
        type="text"
        :placeholder="placeholder"
        class="w-full text-sm border border-slate-200 rounded-xl p-3 bg-white focus:ring-2 focus:ring-teal-500 focus:outline-none shadow-sm"
      />
    </div>

    <!-- 項目點選列表區塊 -->
    <div class="flex-1 overflow-y-auto p-4 space-y-2">
      <div v-if="sortedFilteredItems.length === 0" class="text-center py-12 text-slate-400 text-sm">
        尚無符合之項目
      </div>

      <button
        v-for="(item, idx) in sortedFilteredItems"
        :key="`${item.name}-${idx}`"
        type="button"
        class="w-full text-left p-3.5 bg-slate-50 hover:bg-teal-50 border border-slate-100 rounded-xl transition-all active:scale-[0.99] flex items-center justify-between"
        @click="handleSelectItem(item)"
      >
        <span class="text-sm font-semibold text-slate-800">{{ item.name }}</span>
        <span v-if="item.detail" class="text-xs text-slate-400 font-medium">{{ item.detail }}</span>
      </button>
    </div>
  </div>
</template>
