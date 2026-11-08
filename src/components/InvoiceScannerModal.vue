<script setup lang="ts">
/**
 * @file InvoiceScannerModal.vue
 * @description 電子發票雙 QR Code 相機掃描與逐項分類彈窗元件
 *
 * 核心業務職責：
 * 1. 相機即時掃描生命週期管理：使用 Html5Qrcode 初始化後置鏡頭，掛載時自動開啟並於卸載時安全 stop/clear。
 * 2. 雙 QR Code 連續辨識：支援左側主體碼（含金額、發票號碼）與右側明細碼（** 開頭品項）連續偵測與自動合併。
 * 3. 逐項支出分類選擇引導：針對解析出之商品明細，提供使用者逐一指定對應支出分類（預設餐飲）。
 * 4. 故障降級手動輸入機制：相機無權限或硬體損毀時，無縫切換為手動文字雙碼輸入作為備用方案。
 */

import { ref, onMounted, onUnmounted } from 'vue';
import { Html5Qrcode } from 'html5-qrcode';
import { parseInvoiceQRCode, type ParsedInvoiceResult } from '@/utils/invoiceParser';
import { useCategories } from '@/composables/useCategories';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'parsed', result: ParsedInvoiceResult): void;
}>();

// 使用共用 Composable 管理支出分類選項
const {
  categories: categoryOptions,
  loadCategories,
} = useCategories('expense');

/** 左側 QR Code 字串（含金額、發票號碼等 77 碼以上資訊） */
const leftCode = ref('');

/** 右側 QR Code 字串（延伸品項明細） */
const rightCode = ref('');

/** 錯誤提示訊息 */
const errorMessage = ref('');

/** 相機啟動與存取錯誤提示訊息 */
const cameraError = ref('');

/** 相機掃描狀態導引提示 */
const cameraStatus = ref('');

/** 解析後之發票結構資料 */
const parsedResult = ref<ParsedInvoiceResult | null>(null);

/** Html5Qrcode 掃描器實例參考 */
let html5QrScanner: Html5Qrcode | null = null;

/**
 * 啟動相機掃描器
 */
async function startScanner() {
  cameraError.value = '';
  try {
    html5QrScanner = new Html5Qrcode('qr-reader');
    await html5QrScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      onScanSuccess,
      onScanFailure
    );
    cameraStatus.value = '相機啟動成功，請對準發票 QR Code';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    cameraError.value = `相機啟動失敗或權限遭拒 (${msg})，請改用下方手動輸入。`;
  }
}

/**
 * 安全停止並清理相機資源
 */
async function stopScanner() {
  if (html5QrScanner) {
    const scanner = html5QrScanner;
    try {
      await scanner.stop();
    } catch {
      // 忽略未啟動或已停止時的例外
    }
    try {
      await scanner.clear();
    } catch {
      // 忽略清理例外
    }
  }
}

/**
 * 相機掃描成功回呼函式
 * 支援雙碼連續掃描：若為左碼則帶入 leftCode 並自動解析；若為右碼 (** 開頭) 則帶入 rightCode 並重新解析
 *
 * @param decodedText - 掃描解碼出之字串內容
 */
function onScanSuccess(decodedText: string) {
  const text = decodedText ? decodedText.trim() : '';
  if (!text) return;

  if (text.startsWith('**')) {
    // 右碼延伸品項明細
    rightCode.value = text;
    cameraStatus.value = '已讀取右側 QR Code 明細';
    if (leftCode.value.trim()) {
      handleParse();
    }
  } else {
    // 左側發票主體碼 (或一般 QR 碼)
    leftCode.value = text;
    cameraStatus.value = '已讀取左側 QR Code，若有右側 QR Code 請接續掃描';
    handleParse();
  }
}

/**
 * 相機每幀掃描未辨識時的回呼（忽略常態非錯誤訊號）
 *
 * @param _error - 掃描過程之錯誤訊號
 */
function onScanFailure(_error: unknown) {
  // 保持靜默以避免干擾使用者操作
}

/**
 * 執行發票 QR Code 解析
 */
function handleParse() {
  errorMessage.value = '';
  if (!leftCode.value.trim()) {
    errorMessage.value = '請輸入發票左側 QR Code 內容';
    return;
  }

  try {
    const result = parseInvoiceQRCode(leftCode.value.trim(), rightCode.value.trim() || undefined);

    // 確保每筆品項皆具備合理的預設分類（預設為「餐飲」）
    if (result.items && result.items.length > 0) {
      for (const item of result.items) {
        if (!item.category || item.category === '未分類') {
          item.category = '餐飲';
        }
      }
    }

    parsedResult.value = result;
  } catch (err: unknown) {
    errorMessage.value =
      err instanceof Error ? err.message : (String(err) || '發票解析失敗，請確認 QR Code 格式');
  }
}

/**
 * 關閉彈窗並安全釋放相機資源
 */
async function handleClose() {
  await stopScanner();
  emit('close');
}

/**
 * 確認並套用解析結果至表記帳表單
 */
async function handleApply() {
  if (parsedResult.value) {
    emit('parsed', parsedResult.value);
    await stopScanner();
    emit('close');
  }
}

onMounted(async () => {
  await Promise.all([
    startScanner(),
    loadCategories(),
  ]);
});

onUnmounted(async () => {
  await stopScanner();
});
</script>

<template>
  <div class="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl max-h-[90vh] flex flex-col overflow-hidden">
      <!-- 標題欄 -->
      <div class="flex items-center justify-between pb-3 border-b border-slate-100">
        <h3 id="modal-title" class="text-lg font-bold text-slate-800">電子發票雙 QR Code 掃描</h3>
        <button
          type="button"
          class="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
          @click="handleClose"
          aria-label="關閉"
        >
          ✕
        </button>
      </div>

      <!-- 內容區 -->
      <div class="py-4 space-y-4 overflow-y-auto flex-1">
        <!-- 相機預覽容器 -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between text-xs text-slate-600">
            <span class="font-semibold">相機鏡頭即時掃描</span>
            <span v-if="cameraStatus" class="text-teal-600 font-medium">{{ cameraStatus }}</span>
          </div>
          <div
            id="qr-reader"
            class="w-full min-h-[160px] bg-slate-900 rounded-lg overflow-hidden flex items-center justify-center border border-slate-200 text-slate-400 text-xs"
          ></div>
          <div v-if="cameraError" class="text-xs text-rose-600 bg-rose-50 p-2.5 rounded-lg border border-rose-200">
            {{ cameraError }}
          </div>
        </div>

        <p class="text-xs text-slate-500">
          支援相機掃描，或在下方依序輸入電子發票證明聯上的左側與右側 QR Code 內容文字。
        </p>

        <!-- 左側 QR Code -->
        <div>
          <label for="left-qr" class="block text-sm font-medium text-slate-700 mb-1">
            左側 QR Code (含金額、日期與前兩項商品)
          </label>
          <textarea
            id="left-qr"
            v-model="leftCode"
            rows="3"
            placeholder="請輸入或貼上左側 QR Code 字串"
            class="w-full text-xs font-mono border border-slate-300 rounded-lg p-2.5 focus:ring-2 focus:ring-teal-500 focus:outline-none"
          ></textarea>
        </div>

        <!-- 右側 QR Code -->
        <div>
          <label for="right-qr" class="block text-sm font-medium text-slate-700 mb-1">
            右側 QR Code (延伸商品明細，選填)
          </label>
          <textarea
            id="right-qr"
            v-model="rightCode"
            rows="3"
            placeholder="請輸入或貼上右側 QR Code 字串 (若有)"
            class="w-full text-xs font-mono border border-slate-300 rounded-lg p-2.5 focus:ring-2 focus:ring-teal-500 focus:outline-none"
          ></textarea>
        </div>

        <!-- 格式錯誤提示 -->
        <div v-if="errorMessage" class="text-sm text-rose-600 bg-rose-50 p-2.5 rounded-lg border border-rose-200">
          {{ errorMessage }}
        </div>

        <!-- 解析預覽與逐項分類引導結果 -->
        <div v-if="parsedResult" class="bg-teal-50 border border-teal-200 rounded-lg p-3 space-y-3">
          <div class="flex justify-between text-xs text-teal-800 font-semibold">
            <span>發票號碼：{{ parsedResult.invoiceNumber }}</span>
            <span>開立日期：{{ parsedResult.date }}</span>
          </div>
          <div class="text-xs text-teal-900 font-bold">
            總計金額：NT$ {{ parsedResult.totalAmount }}
          </div>

          <!-- 逐項分類引導介面 -->
          <div v-if="parsedResult.items && parsedResult.items.length > 0" class="mt-2 space-y-2">
            <span class="block text-xs font-semibold text-teal-950">
              商品明細與分類指派 ({{ parsedResult.items.length }} 項)：
            </span>
            <div class="space-y-2 max-h-48 overflow-y-auto pr-1">
              <div
                v-for="(item, idx) in parsedResult.items"
                :key="idx"
                class="flex items-center justify-between p-2.5 bg-white rounded-lg border border-teal-100 shadow-xs text-xs space-x-2"
              >
                <div class="flex-1 min-w-0">
                  <span class="font-medium text-slate-800 block truncate" :title="item.name">
                    {{ item.name }}
                  </span>
                  <span class="text-slate-500 text-[11px]">
                    {{ item.quantity }} 件 × NT$ {{ item.unitPrice }} = NT$ {{ item.subtotal }}
                  </span>
                </div>
                <div class="shrink-0 flex items-center space-x-1">
                  <label :for="`item-category-${idx}`" class="text-[11px] text-slate-500">分類</label>
                  <select
                    :id="`item-category-${idx}`"
                    v-model="item.category"
                    class="border border-slate-300 rounded px-2 py-1 text-xs bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
                  >
                    <option v-for="cat in categoryOptions" :key="cat" :value="cat">
                      {{ cat }}
                    </option>
                  </select>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="text-xs text-slate-500 italic">
            無商品品項明細（純金額發票）
          </div>
        </div>
      </div>

      <!-- 操作按鈕 -->
      <div class="pt-3 border-t border-slate-100 flex items-center justify-end space-x-2">
        <button
          type="button"
          class="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
          @click="handleClose"
        >
          取消
        </button>
        <button
          type="button"
          class="px-4 py-2 text-sm bg-slate-800 text-white hover:bg-slate-900 rounded-lg shadow-sm"
          @click="handleParse"
        >
          解析發票
        </button>
        <button
          v-if="parsedResult"
          type="button"
          class="px-4 py-2 text-sm bg-teal-600 text-white hover:bg-teal-700 rounded-lg shadow-sm"
          @click="handleApply"
        >
          帶入表單
        </button>
      </div>
    </div>
  </div>
</template>
