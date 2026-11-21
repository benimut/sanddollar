/**
 * @file cloudflareApi.ts
 * @description Cloudflare Workers 與 Cloudflare Access 同源 API 回應分級分類工具
 *
 * 核心職責：
 * 1. 精準區分「Cloudflare 免費額度上限（HTTP 429）」、「後端／伺服器異常（5xx）」、「Cloudflare Access 未認證／過期」與「一般用戶端錯誤（4xx）」。
 * 2. 避免將 HTTP 429（Error 1027）或 5xx HTML 錯誤頁誤判為「需要重新登入認證」。
 * 3. 提供統一且友善的繁體中文錯誤訊息與離線檢查輔助函式。
 */

/** Cloudflare Workers 免費方案超過每日 10 萬次上限（HTTP 429 / Error 1027）之統一提示訊息 */
export const CLOUDFLARE_RATE_LIMIT_MESSAGE =
  '服務已達今日免費請求上限（HTTP 429），請於明日台灣時間 08:00（UTC 00:00）額度重置後再試。';

/** 網路連線異常或請求遭中斷時之統一提示訊息 */
export const CLOUDFLARE_NETWORK_ERROR_MESSAGE = '網路連線異常，請確認網路狀態後重試。';

/** Cloudflare API 回應分類結果聯集型別 */
export type CloudflareApiClassification<T = Record<string, unknown>> =
  | { kind: 'ok'; status: number; data: T }
  | { kind: 'auth_required' }
  | { kind: 'rate_limited'; status: 429; message: string }
  | { kind: 'server_error'; status: number; data?: T; message: string }
  | { kind: 'client_error'; status: number; data?: T; message: string };

/**
 * 檢查目前瀏覽器是否明確處於離線狀態
 */
export function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * 安全抽取錯誤回應 JSON 物件內的 error 訊息字串
 */
function extractJsonErrorMessage(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  const maybeError = (data as { error?: unknown }).error;
  return typeof maybeError === 'string' && maybeError.trim() ? maybeError.trim() : '';
}

/**
 * 依 HTTP 狀態碼、重新導向特徵與 Content-Type 對 Cloudflare `/api/*` 回應進行分級判斷
 *
 * 判斷優先順序（不可調換）：
 * 1. HTTP 429：優先辨識為免費方案限流，避免因 Cloudflare 回傳 HTML 阻擋頁而誤判為認證過期。
 * 2. HTTP 5xx：優先辨識為後端或閘道錯誤（若有 JSON error 則透傳）。
 * 3. opaqueredirect / redirected / 3xx / 401 / 403：明確歸類為需要 Cloudflare Access 認證。
 * 4. 非 JSON 回應：4xx 歸為 client_error；2xx HTML（如 Access 登入頁）歸為 auth_required。
 * 5. JSON 解析：驗證 JSON 合法性與 response.ok 狀態。
 */
export async function classifyCloudflareJsonResponse<T = Record<string, unknown>>(
  response: Response
): Promise<CloudflareApiClassification<T>> {
  const contentType = (response.headers?.get('content-type') || '').toLowerCase();
  const isJsonContent = contentType.includes('application/json');

  // 1. Cloudflare 免費額度上限 / 速率限制（HTTP 429）
  if (response.status === 429) {
    return {
      kind: 'rate_limited',
      status: 429,
      message: CLOUDFLARE_RATE_LIMIT_MESSAGE,
    };
  }

  // 2. 伺服器與上游閘道異常（HTTP 5xx）
  if (response.status >= 500) {
    if (isJsonContent) {
      try {
        const data = (await response.json()) as T;
        const serverErr = extractJsonErrorMessage(data);
        return {
          kind: 'server_error',
          status: response.status,
          data,
          message: serverErr || `伺服器暫時無法回應（HTTP ${response.status}），請稍後再試。`,
        };
      } catch {
        // JSON 解析失敗時落回通用 5xx 訊息
      }
    }
    return {
      kind: 'server_error',
      status: response.status,
      message: `伺服器暫時無法回應（HTTP ${response.status}），請稍後再試。`,
    };
  }

  // 3. Cloudflare Access 未登入、被重導向登入頁或授權過期
  if (
    response.type === 'opaqueredirect' ||
    response.redirected ||
    response.status === 401 ||
    response.status === 403 ||
    (response.status >= 300 && response.status < 400)
  ) {
    return { kind: 'auth_required' };
  }

  // 4. 非 JSON 回應（例如 200 HTML 登入頁視為需認證；其餘 4xx 視為用戶端請求異常）
  if (!isJsonContent) {
    if (response.status >= 400) {
      return {
        kind: 'client_error',
        status: response.status,
        message: `請求失敗（HTTP ${response.status}），請稍後再試。`,
      };
    }
    return { kind: 'auth_required' };
  }

  // 5. 解析 JSON 並區分正常與 4xx 失敗回應
  let data: T;
  try {
    data = (await response.json()) as T;
  } catch {
    return {
      kind: 'server_error',
      status: response.status,
      message: `伺服器回應格式異常（HTTP ${response.status}），請稍後再試。`,
    };
  }

  if (!response.ok) {
    const clientErr = extractJsonErrorMessage(data);
    return {
      kind: 'client_error',
      status: response.status,
      data,
      message: clientErr || `請求失敗（HTTP ${response.status}），請稍後再試。`,
    };
  }

  return {
    kind: 'ok',
    status: response.status,
    data,
  };
}
