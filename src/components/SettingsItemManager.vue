<script setup lang="ts">
/**
 * @file SettingsItemManager.vue
 * @description 通用設定項目管理元件，提供支付方式、收入來源、回饋來源等清單之新增、編輯、刪除與狀態呈現
 *
 * 核心業務職責：
 * 1. 統一管理單一字串名稱項目之 CRUD 操作介面。
 * 2. 依照傳入之 idPrefix 自動產生符合測試契約規範之選擇器（如 #input-payment-method-name, .btn-edit-payment-method 等）。
 * 3. 封裝行內即時編輯與取消狀態，向父元件發送 add, update, delete 事件。
 */

import { ref, computed } from 'vue';
import { sortByNameNaturally } from '@/utils/sort';

interface ItemRecord {
  id?: number;
  name: string;
  isPreferred?: boolean;
}

interface Props {
  /** 項目群組標題 (例如: '支付方式管理') */
  title: string;
  /** 標題左側圖示 (例如: '💳') */
  icon?: string;
  /** 輸入框提示文字 */
  placeholder?: string;
  /** 元素選擇器 ID / Class 前綴 (如 'payment-method', 'income-source', 'reward-source') */
  idPrefix: string;
  /** 當前項目列表資料 */
  items: ItemRecord[];
  /** 列表無資料時之提示訊息 */
  emptyText?: string;
  /** 是否允許預設星號多選切換（例如店家常用列表，預設 false 為單選） */
  multiDefault?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  icon: '',
  placeholder: '',
  emptyText: '尚無任何記錄',
  multiDefault: false,
});

const emit = defineEmits<{
  (e: 'add', name: string): void;
  (e: 'update', payload: { id: number; name: string }): void;
  (e: 'delete', id: number): void;
  (e: 'set-default', id: number): void;
}>();

/** 依名稱自然文字排序後之項目清單 */
const sortedItems = computed(() => sortByNameNaturally(props.items));

/** 目前生效的預設項目 ID（若無明確標記則以排序第一項為準） */
const effectiveDefaultId = computed<number | undefined>(() => {
  const preferred = sortedItems.value.find((item) => item.isPreferred === true);
  if (preferred?.id !== undefined) return preferred.id;
  return sortedItems.value[0]?.id;
});

/** 新增項目輸入框內容 */
const newItemName = ref('');
/** 當前正在行內編輯中的項目 ID (若無則為 null) */
const editingId = ref<number | null>(null);
/** 行內編輯中之新名稱內容 */
const editingName = ref('');

/**
 * 處理新增項目
 */
function handleAdd() {
  const name = newItemName.value.trim();
  if (!name) return;
  emit('add', name);
  newItemName.value = '';
}

/**
 * 開始編輯指定項目
 *
 * @param item - 欲編輯之項目物件
 */
function startEdit(item: ItemRecord) {
  if (item.id !== undefined) {
    editingId.value = item.id;
    editingName.value = item.name;
  }
}

/**
 * 取消當前行內編輯
 */
function cancelEdit() {
  editingId.value = null;
}

/**
 * 儲存行內編輯內容
 *
 * @param id - 項目 ID
 */
function handleSave(id: number) {
  const name = editingName.value.trim();
  if (!name) return;
  emit('update', { id, name });
  editingId.value = null;
}

/**
 * 處理刪除項目
 *
 * @param id - 項目 ID
 */
function handleDelete(id: number) {
  emit('delete', id);
  if (editingId.value === id) {
    editingId.value = null;
  }
}

/**
 * 判斷指定項目是否處於預設／常用狀態
 *
 * @param item - 項目物件
 * @returns 是否顯示為實心星號
 */
function isItemDefault(item: ItemRecord): boolean {
  if (props.multiDefault) {
    return item.isPreferred === true;
  }
  return effectiveDefaultId.value === item.id;
}

/**
 * 處理設為預設／切換常用項目
 *
 * @param id - 項目 ID
 */
function handleSetDefault(id: number) {
  if (!props.multiDefault && effectiveDefaultId.value === id) return;
  emit('set-default', id);
}
</script>

<template>
  <section class="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 space-y-4">
    <!-- 區塊標題 -->
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-bold text-slate-700 flex items-center gap-1.5">
        <span v-if="icon">{{ icon }}</span>
        <span>{{ title }}</span>
      </h3>
    </div>

    <!-- 新增輸入區 -->
    <div class="flex gap-2">
      <input
        :id="`input-${idPrefix}-name`"
        v-model="newItemName"
        type="text"
        :placeholder="placeholder || `輸入新${title}...`"
        class="flex-1 px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-600 bg-slate-50/50"
        @keyup.enter="handleAdd"
      />
      <button
        :id="`btn-add-${idPrefix}`"
        type="button"
        class="px-3.5 py-2 bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs rounded-xl shadow-xs transition-colors shrink-0"
        @click="handleAdd"
      >
        新增
      </button>
    </div>

    <!-- 項目清單列表 -->
    <div class="space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
      <div
        v-for="item in sortedItems"
        :key="item.id"
        class="flex items-center justify-between p-2 rounded-xl bg-slate-50 border border-slate-100 hover:bg-slate-100/70 transition-colors text-xs"
      >
        <!-- 行內編輯狀態 -->
        <template v-if="editingId === item.id">
          <input
            v-model="editingName"
            type="text"
            :class="`input-edit-${idPrefix}`"
            class="flex-1 px-2 py-1 text-xs border border-teal-500 rounded-lg mr-2 bg-white"
            @keyup.enter="handleSave(item.id!)"
          />
          <div class="flex gap-1">
            <button
              type="button"
              :class="`btn-save-${idPrefix}`"
              class="px-2 py-1 bg-teal-600 text-white rounded-lg font-medium text-xs hover:bg-teal-700"
              @click="handleSave(item.id!)"
            >
              儲存
            </button>
            <button
              type="button"
              class="px-2 py-1 bg-slate-200 text-slate-600 rounded-lg text-xs hover:bg-slate-300"
              @click="cancelEdit"
            >
              取消
            </button>
          </div>
        </template>

        <!-- 正常瀏覽狀態 -->
        <template v-else>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              :class="[
                `btn-default-${idPrefix}`,
                isItemDefault(item)
                  ? 'text-amber-500 bg-amber-50/70'
                  : 'text-slate-300 hover:text-amber-500 hover:bg-amber-50',
              ]"
              class="px-1.5 py-1 rounded-lg transition-colors text-sm leading-none"
              :title="isItemDefault(item) ? '目前預設' : '設為預設'"
              :aria-label="isItemDefault(item) ? '目前預設' : '設為預設'"
              :data-is-default="isItemDefault(item) ? 'true' : 'false'"
              @click="handleSetDefault(item.id!)"
            >
              {{ isItemDefault(item) ? '★' : '☆' }}
            </button>
            <span class="font-medium text-slate-700">{{ item.name }}</span>
          </div>
          <div class="flex items-center gap-1">
            <button
              type="button"
              :class="`btn-edit-${idPrefix}`"
              class="px-2 py-1 text-slate-500 hover:text-teal-700 hover:bg-teal-50 rounded-lg transition-colors"
              @click="startEdit(item)"
            >
              編輯
            </button>
            <button
              type="button"
              :class="`btn-delete-${idPrefix}`"
              class="px-2 py-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
              @click="handleDelete(item.id!)"
            >
              刪除
            </button>
          </div>
        </template>
      </div>

      <!-- 無資料空提示 -->
      <div v-if="items.length === 0" class="text-center py-4 text-xs text-slate-400">
        {{ emptyText }}
      </div>
    </div>
  </section>
</template>
