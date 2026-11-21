<script setup lang="ts">
/// <reference types="vite/client" />
/**
 * @file BugReportModal.vue
 * @description 設定頁錯誤回報彈出表單元件（基於原生 <dialog> 實作）
 *
 * 核心業務職責：
 * 1. 採用瀏覽器原生 <dialog>（showModal）提供頂層顯示、背景 inert、焦點管理與 Esc 關閉。
 * 2. 提供純文字問題回報表單（問題類型、問題標題、詳細說明與重現步驟）。
 * 3. 採用互動後驗證策略（blur 與 submit 檢核、input 即時清錯）並同步維護 ARIA 無障礙狀態。
 * 4. 預設勾選（可取消）收集非隱私環境診斷資訊（含版本、UA、螢幕尺寸、PWA 模式與 AI 設定，不含記帳資料）。
 * 5. 若送出當下遭遇 Cloudflare Access 過期，將草稿暫存至 sessionStorage 並提供一鍵認證導回與還原。
 * 6. 回報成功後僅顯示成功訊息與追蹤編號（如 #12），不顯示外部 GitHub 連結。
 */

import { ref, computed, watch, onMounted, nextTick } from 'vue';
import { loadAiInvoiceSettings } from '@/utils/aiInvoiceSettings';
import {
  classifyCloudflareJsonResponse,
  isBrowserOffline,
  CLOUDFLARE_NETWORK_ERROR_MESSAGE,
} from '@/utils/cloudflareApi';

/** 支援之錯誤回報問題類型 */
export type BugReportCategory = 'bug' | 'ui' | 'ai-invoice' | 'enhancement' | 'other';

/** 診斷資訊資料結構（嚴格限制不含任何記帳資料） */
interface BugDiagnosticsPayload {
  appVersion: string;
  reportedAt: string;
  browserSummary: string;
  userAgent: string;
  viewport: string;
  displayMode: string;
  language: string;
  aiSettings: string;
}

/** 暫存於 sessionStorage 的表單草稿結構 */
interface BugReportDraft {
  category: BugReportCategory;
  title: string;
  description: string;
  includeDiagnostics: boolean;
}

const BUG_REPORT_DRAFT_STORAGE_KEY = 'sanddollar_bug_report_draft';
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 4000;

/** 問題類型選項定義 */
const CATEGORY_OPTIONS: ReadonlyArray<{
  value: BugReportCategory;
  label: string;
  hint: string;
  fullWidth?: boolean;
}> = [
  { value: 'bug', label: '功能異常', hint: '操作失敗、計算錯誤或無法儲存' },
  { value: 'ui', label: '畫面顯示', hint: '版面跑版、文字裁切或捲動異常' },
  { value: 'ai-invoice', label: 'AI 發票辨識', hint: '拍照裁切、QR 掃描或辨識誤差' },
  { value: 'enhancement', label: '功能建議', hint: '體驗改善或新功能許願' },
  { value: 'other', label: '其他', hint: '使用疑問或其他想回饋的事項', fullWidth: true },
];

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const dialogRef = ref<HTMLDialogElement | null>(null);
const titleInputRef = ref<HTMLInputElement | null>(null);
const descriptionInputRef = ref<HTMLTextAreaElement | null>(null);

// 表單欄位狀態
const category = ref<BugReportCategory>('bug');
const title = ref('');
const description = ref('');
const includeDiagnostics = ref(true);

// 互動後驗證狀態（避免開啟或輸入中途過早顯示錯誤）
const titleEdited = ref(false);
const titleShowError = ref(false);
const descriptionEdited = ref(false);
const descriptionShowError = ref(false);

// 送出與結果狀態
const isSubmitting = ref(false);
const submitErrorMessage = ref('');
const isAuthExpired = ref(false);
const submittedIssueNumber = ref<number | null>(null);

/** 標題欄位錯誤訊息 */
const titleErrorMessage = computed(() => {
  if (!titleShowError.value) return '';
  if (!title.value.trim()) {
    return '請輸入問題標題（例如：切換報表月份時畫面空白）。';
  }
  return '';
});

/** 詳細說明欄位錯誤訊息 */
const descriptionErrorMessage = computed(() => {
  if (!descriptionShowError.value) return '';
  if (!description.value.trim()) {
    return '請輸入詳細說明或重現步驟，協助定位問題原因。';
  }
  return '';
});

/** 動態計算標題之 aria-describedby（僅在顯示錯誤時才串接錯誤訊息 ID） */
const titleDescribedBy = computed(() =>
  titleErrorMessage.value
    ? 'bug-report-title-hint bug-report-title-error'
    : 'bug-report-title-hint'
);

/** 動態計算詳細說明之 aria-describedby */
const descriptionDescribedBy = computed(() =>
  descriptionErrorMessage.value
    ? 'bug-report-description-hint bug-report-description-error'
    : 'bug-report-description-hint'
);

/**
 * 格式化本地日期時間與時區偏移（例如：2026-11-21 15:05:48 (UTC+8)）
 */
function formatLocalTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());

  // getTimezoneOffset() 回傳 UTC 與本地分鐘差（台灣 UTC+8 為 -480）
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absMinutes / 60);
  const offsetRemMinutes = absMinutes % 60;
  const tzLabel =
    offsetRemMinutes === 0
      ? `UTC${sign}${offsetHours}`
      : `UTC${sign}${offsetHours}:${pad(offsetRemMinutes)}`;

  return `${y}-${m}-${d} ${hh}:${mm}:${ss} (${tzLabel})`;
}

/**
 * 將瀏覽器原始 User-Agent 與 userAgentData 解析為精簡可讀摘要（例如：Android (Mobile) · Chrome 157）
 */
function buildBrowserSummary(ua: string): string {
  if (!ua || ua === 'unknown') return '未知裝置與瀏覽器';

  const uaData =
    typeof navigator !== 'undefined'
      ? (
          navigator as unknown as {
            userAgentData?: {
              platform?: string;
              mobile?: boolean;
            };
          }
        ).userAgentData
      : undefined;

  // 1. 辨識作業系統與裝置形態
  const platformRaw = typeof uaData?.platform === 'string' ? uaData.platform.trim() : '';
  let os = '';
  if (/android/i.test(platformRaw) || /Android/i.test(ua)) {
    os = 'Android';
  } else if (/iPhone|iPad|iPod/i.test(ua) || /iOS/i.test(platformRaw)) {
    os = /iPad/i.test(ua) ? 'iPadOS' : 'iOS';
  } else if (/Windows/i.test(platformRaw) || /Windows NT/i.test(ua)) {
    os = 'Windows';
  } else if (/macOS|Mac/i.test(platformRaw) || /Macintosh|Mac OS X/i.test(ua)) {
    os = 'macOS';
  } else if (/CrOS/i.test(ua)) {
    os = 'ChromeOS';
  } else if (/Linux/i.test(platformRaw) || /Linux/i.test(ua)) {
    os = 'Linux';
  } else {
    os = platformRaw || '未知系統';
  }

  const isTablet = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua));
  const isMobile =
    typeof uaData?.mobile === 'boolean'
      ? uaData.mobile
      : /Mobile|iPhone|iPod|Android.*Mobile/i.test(ua);
  const formFactor = isTablet ? 'Tablet' : isMobile ? 'Mobile' : 'Desktop';

  // 2. 依優先順序擷取實際瀏覽器名稱與主版本，避開通用 Safari/AppleWebKit 尾綴
  const browserMatchers: Array<{ name: string; regex: RegExp }> = [
    { name: 'Edge', regex: /\bEdg(?:A|iOS)?\/(\d+)/ },
    { name: 'Opera', regex: /\bOPR\/(\d+)/ },
    { name: 'Samsung Internet', regex: /\bSamsungBrowser\/(\d+)/ },
    { name: 'LINE', regex: /\bLine\/(\d+)/i },
    { name: 'Firefox', regex: /\b(?:Firefox|FxiOS)\/(\d+)/ },
    { name: 'Chrome', regex: /\b(?:Chrome|CriOS)\/(\d+)/ },
    { name: 'Safari', regex: /\bVersion\/(\d+)(?:\.\d+)*.*Safari\// },
  ];

  let browserLabel = '未知瀏覽器';
  for (const matcher of browserMatchers) {
    const match = matcher.regex.exec(ua);
    if (match?.[1]) {
      browserLabel = `${matcher.name} ${match[1]}`;
      break;
    }
  }

  return `${os} (${formFactor}) · ${browserLabel}`;
}

/**
 * 產生當下最新之環境診斷資訊（送出時呼叫以確保時間與設定皆為最新狀態，絕不存取記帳資料）
 */
function buildDiagnosticsPayload(): BugDiagnosticsPayload {
  const ai = loadAiInvoiceSettings();
  const appVersion =
    typeof import.meta.env.VITE_APP_VERSION === 'string' && import.meta.env.VITE_APP_VERSION.trim()
      ? import.meta.env.VITE_APP_VERSION.trim()
      : '1.0.0';

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || 'unknown' : 'unknown';
  const lang = typeof navigator !== 'undefined' ? navigator.language || 'unknown' : 'unknown';

  let viewport = 'unknown';
  if (typeof window !== 'undefined') {
    const inner = `${window.innerWidth}×${window.innerHeight}`;
    const screenSize =
      typeof window.screen !== 'undefined'
        ? `${window.screen.width}×${window.screen.height}`
        : 'unknown';
    viewport = `視窗 ${inner} / 螢幕 ${screenSize}`;
  }

  let displayMode = 'browser';
  if (typeof window !== 'undefined') {
    const navStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
    const mediaStandalone =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches;
    if (navStandalone || mediaStandalone) {
      displayMode = 'pwa-standalone';
    }
  }

  return {
    appVersion,
    reportedAt: formatLocalTimestamp(new Date()),
    browserSummary: buildBrowserSummary(ua),
    userAgent: ua,
    viewport,
    displayMode,
    language: lang,
    aiSettings: `${ai.model} / ${ai.thinkingLevel} / ${ai.mediaResolution}`,
  };
}

/** 供表單預覽區顯示的診斷資訊快照（隨彈窗開啟時刷新） */
const diagnosticsPreviewTick = ref(0);
const diagnosticsSnapshot = computed<BugDiagnosticsPayload>(() => {
  void diagnosticsPreviewTick.value;
  return buildDiagnosticsPayload();
});

/**
 * 讀取並套用暫存於 sessionStorage 的回報草稿（若存在）
 */
function restoreDraftFromStorage() {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    const raw = window.sessionStorage.getItem(BUG_REPORT_DRAFT_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<BugReportDraft>;
    const validCategories = new Set<BugReportCategory>([
      'bug',
      'ui',
      'ai-invoice',
      'enhancement',
      'other',
    ]);
    if (parsed.category && validCategories.has(parsed.category)) {
      category.value = parsed.category;
    }
    if (typeof parsed.title === 'string') {
      title.value = parsed.title.slice(0, MAX_TITLE_LENGTH);
    }
    if (typeof parsed.description === 'string') {
      description.value = parsed.description.slice(0, MAX_DESCRIPTION_LENGTH);
    }
    if (typeof parsed.includeDiagnostics === 'boolean') {
      includeDiagnostics.value = parsed.includeDiagnostics;
    }
  } catch {
    // 忽略毀損之暫存資料
  }
}

/**
 * 將目前未送出的表單草稿暫存至 sessionStorage（用於認證過期跳轉返回後還原）
 */
function saveDraftToStorage() {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  const draft: BugReportDraft = {
    category: category.value,
    title: title.value,
    description: description.value,
    includeDiagnostics: includeDiagnostics.value,
  };
  try {
    window.sessionStorage.setItem(BUG_REPORT_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // 無痕模式或儲存受限時安全略過
  }
}

/**
 * 清除暫存草稿
 */
function clearDraftStorage() {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    window.sessionStorage.removeItem(BUG_REPORT_DRAFT_STORAGE_KEY);
  } catch {
    // 安全略過
  }
}

/**
 * 重設表單與錯誤狀態，並嘗試還原認證跳轉前暫存的草稿
 */
function resetModalStateForOpen() {
  category.value = 'bug';
  title.value = '';
  description.value = '';
  includeDiagnostics.value = true;
  titleEdited.value = false;
  titleShowError.value = false;
  descriptionEdited.value = false;
  descriptionShowError.value = false;
  isSubmitting.value = false;
  submitErrorMessage.value = '';
  isAuthExpired.value = false;
  submittedIssueNumber.value = null;
  diagnosticsPreviewTick.value += 1;

  restoreDraftFromStorage();
}

/**
 * 開啟原生 <dialog> 視窗（兼容測試環境無 showModal 的情況）
 */
function openNativeDialog() {
  const el = dialogRef.value;
  if (!el) return;

  resetModalStateForOpen();

  if (typeof el.showModal === 'function') {
    if (!el.open) {
      el.showModal();
    }
  } else {
    el.setAttribute('open', '');
  }

  nextTick(() => {
    titleInputRef.value?.focus();
  });
}

/**
 * 關閉原生 <dialog> 視窗
 */
function closeNativeDialog() {
  const el = dialogRef.value;
  if (!el) {
    emit('close');
    return;
  }

  if (typeof el.close === 'function') {
    if (el.open) {
      el.close();
      return;
    }
  } else {
    el.removeAttribute('open');
  }
  emit('close');
}

/**
 * 監聽原生 dialog close 事件，清除 returnValue 並同步通知父層關閉狀態
 */
function handleDialogClose() {
  const el = dialogRef.value;
  if (el) {
    el.returnValue = '';
  }
  emit('close');
}

/**
 * 攔截 Esc 關閉請求：送出進行中不允許關閉以免遺失狀態
 */
function handleDialogCancel(event: Event) {
  if (isSubmitting.value) {
    event.preventDefault();
  }
}

/**
 * 處理點擊關閉或取消按鈕
 */
function handleRequestClose() {
  if (isSubmitting.value) return;
  closeNativeDialog();
}

/** 標題輸入事件：標記已編輯，若已有合法值即即時清除錯誤 */
function handleTitleInput() {
  titleEdited.value = true;
  titleInputRef.value?.setCustomValidity('');
  if (titleShowError.value && title.value.trim().length > 0) {
    titleShowError.value = false;
  }
}

/** 標題離開焦點事件：僅在使用者實際編輯後才檢核 */
function handleTitleBlur() {
  if (!titleEdited.value) return;
  const isValid = title.value.trim().length > 0;
  titleShowError.value = !isValid;
  titleInputRef.value?.setCustomValidity(isValid ? '' : '請輸入問題標題');
}

/** 詳細說明輸入事件：標記已編輯，若已有合法值即即時清除錯誤 */
function handleDescriptionInput() {
  descriptionEdited.value = true;
  descriptionInputRef.value?.setCustomValidity('');
  if (descriptionShowError.value && description.value.trim().length > 0) {
    descriptionShowError.value = false;
  }
}

/** 詳細說明離開焦點事件：僅在使用者實際編輯後才檢核 */
function handleDescriptionBlur() {
  if (!descriptionEdited.value) return;
  const isValid = description.value.trim().length > 0;
  descriptionShowError.value = !isValid;
  descriptionInputRef.value?.setCustomValidity(isValid ? '' : '請輸入詳細說明');
}

/**
 * 前往 Cloudflare Access 認證並於完成後導回設定頁自動重新開啟表單
 */
function handleReauthenticate() {
  saveDraftToStorage();
  const params = new URLSearchParams(window.location.search);
  params.set('tab', 'settings');
  params.set('reportBug', '1');
  const returnTo = `${window.location.pathname}?${params.toString()}`;
  window.location.assign(`/api/auth?returnTo=${encodeURIComponent(returnTo)}`);
}

/**
 * 驗證表單並送出至後端 POST /api/report-bug
 */
async function handleSubmit() {
  if (isSubmitting.value) return;

  submitErrorMessage.value = '';
  isAuthExpired.value = false;

  const isTitleValid = title.value.trim().length > 0;
  const isDescriptionValid = description.value.trim().length > 0;

  titleEdited.value = true;
  descriptionEdited.value = true;
  titleShowError.value = !isTitleValid;
  descriptionShowError.value = !isDescriptionValid;

  titleInputRef.value?.setCustomValidity(isTitleValid ? '' : '請輸入問題標題');
  descriptionInputRef.value?.setCustomValidity(isDescriptionValid ? '' : '請輸入詳細說明');

  if (!isTitleValid) {
    titleInputRef.value?.focus();
    return;
  }
  if (!isDescriptionValid) {
    descriptionInputRef.value?.focus();
    return;
  }

  if (isBrowserOffline()) {
    submitErrorMessage.value = '目前處於離線狀態，無法送出錯誤回報。';
    return;
  }

  isSubmitting.value = true;
  try {
    const payload = {
      category: category.value,
      title: title.value.trim(),
      description: description.value.trim(),
      // 於送出當下即時組裝診斷資訊，確保回報時間精準對應點擊送出的本地時刻
      diagnostics: includeDiagnostics.value ? buildDiagnosticsPayload() : null,
    };

    const response = await fetch('/api/report-bug', {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const classified = await classifyCloudflareJsonResponse<{
      issueNumber?: unknown;
      error?: string;
    }>(response);

    // 若遭遇 Cloudflare Access 未登入或驗證過期，暫存草稿並引導重新認證
    if (classified.kind === 'auth_required') {
      saveDraftToStorage();
      isAuthExpired.value = true;
      submitErrorMessage.value =
        'Cloudflare Access 授權已過期，表單內容已為您暫存，請完成認證後再送出。';
      return;
    }

    if (classified.kind !== 'ok') {
      submitErrorMessage.value = classified.message;
      return;
    }

    if (typeof classified.data.issueNumber !== 'number') {
      submitErrorMessage.value = '伺服器回應格式異常，請稍後再試。';
      return;
    }

    clearDraftStorage();
    submittedIssueNumber.value = classified.data.issueNumber;
  } catch {
    submitErrorMessage.value = CLOUDFLARE_NETWORK_ERROR_MESSAGE;
  } finally {
    isSubmitting.value = false;
  }
}

watch(
  () => props.isOpen,
  async (open) => {
    await nextTick();
    if (open) {
      openNativeDialog();
    } else {
      const el = dialogRef.value;
      if (el?.open && typeof el.close === 'function') {
        el.close();
      } else {
        el?.removeAttribute('open');
      }
    }
  },
  { flush: 'post' }
);

onMounted(() => {
  if (props.isOpen) {
    openNativeDialog();
  }
});
</script>

<template>
  <dialog
    ref="dialogRef"
    data-testid="bug-report-dialog"
    aria-labelledby="bug-report-dialog-title"
    class="bug-report-dialog m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-slate-200 bg-white p-0 text-slate-800 shadow-xl"
    @close="handleDialogClose"
    @cancel="handleDialogCancel"
  >
    <div class="flex max-h-[85dvh] flex-col">
      <!-- 頂部標題列 -->
      <header class="flex items-center justify-between bg-teal-700 px-4 py-3.5 text-white shrink-0">
        <div class="flex items-center gap-2">
          <span aria-hidden="true">🐛</span>
          <h2 id="bug-report-dialog-title" class="text-base font-bold">問題與錯誤回報</h2>
        </div>
        <button
          type="button"
          data-testid="bug-report-close-btn"
          :disabled="isSubmitting"
          class="rounded-lg bg-teal-800/80 px-3 py-1 text-sm text-teal-100 hover:bg-teal-800 disabled:opacity-50"
          @click="handleRequestClose"
        >
          關閉
        </button>
      </header>

      <!-- 成功送出狀態畫面（僅顯示成功訊息與追蹤編號，不顯示外部連結） -->
      <div
        v-if="submittedIssueNumber !== null"
        data-testid="bug-report-success"
        role="status"
        aria-live="polite"
        class="space-y-4 p-5 text-center"
      >
        <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-teal-50 text-2xl">
          ✅
        </div>
        <div class="space-y-1.5">
          <h3 class="text-base font-bold text-slate-800">錯誤回報已送出！</h3>
          <p class="text-xs text-slate-600 leading-relaxed">
            感謝您的回饋，我們已自動建立追蹤單並將儘快處理。
          </p>
          <p
            data-testid="bug-report-issue-number"
            class="inline-block rounded-lg bg-teal-50 px-3 py-1.5 text-sm font-bold text-teal-800 border border-teal-200"
          >
            追蹤編號：#{{ submittedIssueNumber }}
          </p>
        </div>
        <button
          type="button"
          data-testid="bug-report-done-btn"
          class="w-full min-h-[48px] rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-bold text-white shadow-xs transition-colors hover:bg-teal-700"
          @click="handleRequestClose"
        >
          完成並關閉
        </button>
      </div>

      <!-- 回報填寫表單 -->
      <form
        v-else
        action="/api/report-bug"
        method="POST"
        novalidate
        class="flex-1 overflow-y-auto p-4 space-y-5"
        @submit.prevent="handleSubmit"
      >
        <!-- 1. 問題類型（5 個選項採語意化 radio 卡片群組） -->
        <fieldset class="space-y-2">
          <legend class="text-xs font-bold text-slate-700">
            問題類型 <span aria-hidden="true" class="text-rose-600">*</span>
          </legend>
          <div class="grid grid-cols-2 gap-2">
            <label
              v-for="opt in CATEGORY_OPTIONS"
              :key="opt.value"
              class="relative block cursor-pointer"
              :class="{ 'col-span-2': opt.fullWidth }"
            >
              <input
                v-model="category"
                type="radio"
                name="bug-category"
                :value="opt.value"
                class="bug-radio-input bug-visually-hidden"
              />
              <span
                class="bug-radio-card flex h-full flex-col justify-center rounded-xl border p-2.5 transition-colors"
                :class="
                  category === opt.value
                    ? 'border-teal-600 bg-teal-50/80 text-teal-900'
                    : 'border-slate-200 bg-slate-50/60 text-slate-700 hover:bg-slate-100/70'
                "
              >
                <span class="text-xs font-bold">{{ opt.label }}</span>
                <span class="mt-0.5 text-[11px] leading-snug text-slate-500">{{ opt.hint }}</span>
              </span>
            </label>
          </div>
        </fieldset>

        <!-- 2. 問題標題 -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <label for="bug-report-title-input" class="block text-xs font-bold text-slate-700">
              問題標題 <span aria-hidden="true" class="text-rose-600">*</span>
            </label>
            <span class="text-[11px] text-slate-400">{{ title.length }}/{{ MAX_TITLE_LENGTH }}</span>
          </div>
          <span id="bug-report-title-hint" class="block text-[11px] text-slate-500">
            請用一句話簡述遇到的狀況（最多 {{ MAX_TITLE_LENGTH }} 字）。
          </span>
          <input
            id="bug-report-title-input"
            ref="titleInputRef"
            v-model="title"
            name="title"
            type="text"
            required
            autofocus
            :maxlength="MAX_TITLE_LENGTH"
            enterkeyhint="next"
            placeholder="例如：掃描紙本發票後無法自動帶入金額"
            :aria-invalid="titleErrorMessage ? 'true' : 'false'"
            :aria-describedby="titleDescribedBy"
            class="bug-form-control w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-800 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
            :class="{ 'bug-field-invalid': Boolean(titleErrorMessage) }"
            @input="handleTitleInput"
            @blur="handleTitleBlur"
          />
          <div
            v-if="titleErrorMessage"
            id="bug-report-title-error"
            data-testid="bug-report-title-error"
            class="flex items-start gap-1 text-xs font-medium text-rose-600"
          >
            <span role="img" aria-label="錯誤">⚠️</span>
            <span>{{ titleErrorMessage }}</span>
          </div>
        </div>

        <!-- 3. 詳細說明與重現步驟 -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <label for="bug-report-description-input" class="block text-xs font-bold text-slate-700">
              詳細說明與重現步驟 <span aria-hidden="true" class="text-rose-600">*</span>
            </label>
            <span class="text-[11px] text-slate-400">
              {{ description.length }}/{{ MAX_DESCRIPTION_LENGTH }}
            </span>
          </div>
          <span id="bug-report-description-hint" class="block text-[11px] text-slate-500">
            請描述操作步驟、預期結果與實際發生的狀況。
          </span>
          <textarea
            id="bug-report-description-input"
            ref="descriptionInputRef"
            v-model="description"
            name="description"
            rows="4"
            required
            :maxlength="MAX_DESCRIPTION_LENGTH"
            placeholder="1. 開啟某頁面...&#10;2. 點擊某按鈕...&#10;3. 發生異常現象..."
            :aria-invalid="descriptionErrorMessage ? 'true' : 'false'"
            :aria-describedby="descriptionDescribedBy"
            class="bug-form-control w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-base leading-relaxed text-slate-800 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
            :class="{ 'bug-field-invalid': Boolean(descriptionErrorMessage) }"
            @input="handleDescriptionInput"
            @blur="handleDescriptionBlur"
          ></textarea>
          <div
            v-if="descriptionErrorMessage"
            id="bug-report-description-error"
            data-testid="bug-report-description-error"
            class="flex items-start gap-1 text-xs font-medium text-rose-600"
          >
            <span role="img" aria-label="錯誤">⚠️</span>
            <span>{{ descriptionErrorMessage }}</span>
          </div>
        </div>

        <!-- 4. 環境診斷資訊（預設勾選、可取消，並可展開查閱） -->
        <div class="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
          <div class="flex items-start gap-2.5">
            <input
              id="bug-report-include-diagnostics"
              v-model="includeDiagnostics"
              name="includeDiagnostics"
              type="checkbox"
              class="mt-0.5 h-5 w-5 shrink-0 rounded accent-teal-600 cursor-pointer"
            />
            <label
              for="bug-report-include-diagnostics"
              class="text-xs font-semibold text-slate-700 leading-snug cursor-pointer"
            >
              附加裝置與版本診斷資訊（不含任何記帳資料）
            </label>
          </div>

          <details class="text-[11px] text-slate-500">
            <summary class="cursor-pointer select-none font-medium text-teal-700 hover:underline">
              檢視將附帶的診斷資訊
            </summary>
            <dl class="mt-2 space-y-1 rounded-lg bg-white p-2.5 border border-slate-200 text-[11px]">
              <div class="flex justify-between gap-2">
                <dt class="text-slate-400 shrink-0">App 版本</dt>
                <dd class="font-mono text-slate-700 text-right">{{ diagnosticsSnapshot.appVersion }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt class="text-slate-400 shrink-0">回報時間</dt>
                <dd class="font-mono text-slate-700 text-right">
                  {{ diagnosticsSnapshot.reportedAt }}（送出時更新）
                </dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt class="text-slate-400 shrink-0">裝置與瀏覽器</dt>
                <dd class="font-mono text-slate-700 text-right">
                  {{ diagnosticsSnapshot.browserSummary }}
                </dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt class="text-slate-400 shrink-0">顯示模式</dt>
                <dd class="font-mono text-slate-700 text-right">{{ diagnosticsSnapshot.displayMode }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt class="text-slate-400 shrink-0">螢幕／視窗</dt>
                <dd class="font-mono text-slate-700 text-right">{{ diagnosticsSnapshot.viewport }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt class="text-slate-400 shrink-0">系統語系</dt>
                <dd class="font-mono text-slate-700 text-right">{{ diagnosticsSnapshot.language }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt class="text-slate-400 shrink-0">AI 設定</dt>
                <dd class="font-mono text-slate-700 text-right break-all">
                  {{ diagnosticsSnapshot.aiSettings }}
                </dd>
              </div>
              <div class="pt-1 border-t border-slate-100">
                <dt class="text-slate-400">完整 User-Agent（備註）</dt>
                <dd class="mt-0.5 font-mono text-[10px] text-slate-600 break-all">
                  {{ diagnosticsSnapshot.userAgent }}
                </dd>
              </div>
            </dl>
          </details>
        </div>

        <!-- 送出錯誤或授權過期提示（使用 aria-live 播報） -->
        <div
          v-if="submitErrorMessage"
          data-testid="bug-report-error-banner"
          role="status"
          aria-live="polite"
          class="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 space-y-2"
        >
          <p class="font-medium leading-relaxed">{{ submitErrorMessage }}</p>
          <button
            v-if="isAuthExpired"
            type="button"
            data-testid="bug-report-reauth-btn"
            class="w-full min-h-[44px] rounded-lg bg-rose-600 px-3 py-2 text-xs font-bold text-white hover:bg-rose-700 transition-colors"
            @click="handleReauthenticate"
          >
            前往 Cloudflare 認證
          </button>
        </div>

        <!-- 底部操作按鈕列 -->
        <div class="flex gap-2.5 pt-1">
          <button
            type="button"
            :disabled="isSubmitting"
            class="flex-1 min-h-[48px] rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50"
            @click="handleRequestClose"
          >
            取消
          </button>
          <button
            type="submit"
            data-testid="bug-report-submit-btn"
            :disabled="isSubmitting"
            class="flex-1 min-h-[48px] rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-bold text-white shadow-xs transition-colors hover:bg-teal-700 disabled:opacity-60"
          >
            {{ isSubmitting ? '送出中...' : '送出回報' }}
          </button>
        </div>
      </form>
    </div>
  </dialog>
</template>

<style>
/* 原生 <dialog> 背景捲動隔離：於 modal 與 ::backdrop 同時設定 overscroll-behavior: contain，不鎖定 html/body */
.bug-report-dialog:modal {
  overscroll-behavior: contain;
}

.bug-report-dialog::backdrop {
  background: rgba(15, 23, 42, 0.55);
  overflow: hidden;
  overscroll-behavior: contain;
}

/* 保留於無障礙樹中的視覺隱藏樣式（取代 display: none，並透過相鄰卡片 :focus-visible 呈現焦點指示） */
.bug-visually-hidden {
  position: absolute;
  clip-path: inset(50%);
  overflow: hidden;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  white-space: nowrap;
}

/* Radio 卡片鍵盤焦點外框指示 */
.bug-radio-input:focus-visible + .bug-radio-card {
  outline: 3px solid #0d9488;
  outline-offset: 2px;
}

/* 僅在使用者互動無效後套用錯誤邊框（不單獨使用 :invalid 以免初始空白紅框） */
.bug-form-control:is(:user-invalid, .bug-field-invalid) {
  border-color: #e11d48;
  background-color: #fff1f2;
}
</style>
