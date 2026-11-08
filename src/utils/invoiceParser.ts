/**
 * @file invoiceParser.ts
 * @description Sanddollar 電子發票雙 QR Code 解析工具模組
 * 遵循財政部電子發票 QR Code 規格標準，負責解析左碼基本資訊（發票字軌號碼、民國開立日期、隨機碼、16進位總金額）
 * 與左右雙碼接續品項明細（品名:數量:單價），並執行嚴格之曆法驗證與防禦容錯。
 */

/**
 * 解析後之發票品項明細介面
 */
export interface ParsedInvoiceItem {
  /** 品名 */
  name: string;
  /** 數量 */
  quantity: number;
  /** 單價 */
  unitPrice: number;
  /** 小計金額 (quantity * unitPrice) */
  subtotal: number;
  /** 分類（預設為「未分類」） */
  category: string;
}

/**
 * 解析後之完整發票資料結果介面
 */
export interface ParsedInvoiceResult {
  /** 發票號碼（前 2 碼大寫英文 + 後 8 碼數字） */
  invoiceNumber: string;
  /** 開立日期（格式：YYYY-MM-DD） */
  date: string;
  /** 4 碼隨機碼 */
  randomCode: string;
  /** 總計金額（十進位整數） */
  totalAmount: number;
  /** 商品品項清單 */
  items: ParsedInvoiceItem[];
}

/**
 * 解析商品品項字串明細
 *
 * @param raw - 原始品項字串片段（可能帶有前導符號如 :**: 或 **: 或 **）
 * @returns 解析成功之品項明細陣列，若遇到損毀片段會自動安全略過
 */
function parseItemDetails(raw: string): ParsedInvoiceItem[] {
  const items: ParsedInvoiceItem[] = [];

  // 移除前導的冒號與星號分隔符
  const cleaned = raw.replace(/^[:*]+/, '');
  if (!cleaned) {
    return items;
  }

  // 以冒號分割各欄位 (品名:數量:單價 依序排列)
  const tokens = cleaned.split(':');

  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const name = tokens[i]?.trim();
    const qtyStr = tokens[i + 1]?.trim();
    const priceStr = tokens[i + 2]?.trim();

    // 品名不得為空
    if (!name) {
      continue;
    }

    const quantity = Number(qtyStr);
    const unitPrice = Number(priceStr);

    // 容錯檢查：數量與單價必須為合法有限數值
    if (Number.isNaN(quantity) || !Number.isFinite(quantity) || Number.isNaN(unitPrice) || !Number.isFinite(unitPrice)) {
      continue;
    }

    const subtotal = Math.round(quantity * unitPrice);

    items.push({
      name,
      quantity,
      unitPrice,
      subtotal,
      category: '未分類'
    });
  }

  return items;
}

/**
 * 解析台灣統一發票 QR Code（支援單左碼或左加右雙碼）
 *
 * @param leftCode - 發票左側 QR Code 字串（長度需至少 77 碼）
 * @param rightCode - 發票右側 QR Code 字串（可選，通常以 ** 開頭接續商品明細）
 * @returns 解析完成之發票基本資訊與明細
 * @throws {Error} 當左碼為空、長度不足、發票號碼不合規、日期不合法或金額十六進位格式錯誤時拋出異常
 */
export function parseTaiwanInvoice(leftCode: string, rightCode?: string): ParsedInvoiceResult {
  // 1. 基本型別與存在性檢查
  if (!leftCode || typeof leftCode !== 'string') {
    throw new Error('發票左碼格式錯誤或無效');
  }

  // 2. 長度防禦：基本欄位至少需 77 碼
  if (leftCode.length < 77) {
    throw new Error('發票左碼長度不足，至少需 77 碼');
  }

  // 3. 發票號碼解析（前 10 碼：2 碼大寫英文字母 + 8 碼數字）
  const invoiceNumber = leftCode.slice(0, 10);
  if (!/^[A-Z]{2}\d{8}$/.test(invoiceNumber)) {
    throw new Error('發票號碼格式錯誤，需為 2 碼大寫英文加上 8 碼數字');
  }

  // 4. 開立日期解析（第 10~17 碼，7 碼民國年月日）
  const dateRaw = leftCode.slice(10, 17);
  if (!/^\d{7}$/.test(dateRaw)) {
    throw new Error('發票開立日期格式錯誤');
  }

  const rocYear = parseInt(dateRaw.slice(0, 3), 10);
  const month = parseInt(dateRaw.slice(3, 5), 10);
  const day = parseInt(dateRaw.slice(5, 7), 10);

  // 轉換西元年
  const ceYear = rocYear + 1911;

  // 驗證月份與日期的曆法有效性
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error('發票開立日期格式錯誤');
  }

  const testDate = new Date(ceYear, month - 1, day);
  if (
    testDate.getFullYear() !== ceYear ||
    testDate.getMonth() !== month - 1 ||
    testDate.getDate() !== day
  ) {
    throw new Error('發票開立日期格式錯誤');
  }

  const formattedDate = `${ceYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  // 5. 隨機碼（第 17~21 碼，共 4 碼）
  const randomCode = leftCode.slice(17, 21);

  // 6. 總計金額解析（第 29~37 碼，8 碼 16 進位字串）
  const totalAmountHex = leftCode.slice(29, 37);
  if (!/^[0-9a-fA-F]{8}$/.test(totalAmountHex)) {
    throw new Error('發票總金額非有效16進位格式錯誤');
  }

  const totalAmount = parseInt(totalAmountHex, 16);
  if (Number.isNaN(totalAmount)) {
    throw new Error('發票總金額非有效16進位格式錯誤');
  }

  // 7. 商品品項明細解析
  let items: ParsedInvoiceItem[] = [];

  // 解析左碼 77 碼以後的接續品項
  if (leftCode.length > 77) {
    const leftItemRaw = leftCode.slice(77);
    items = items.concat(parseItemDetails(leftItemRaw));
  }

  // 解析右碼接續品項
  if (rightCode && typeof rightCode === 'string' && rightCode.trim().length > 0) {
    items = items.concat(parseItemDetails(rightCode.trim()));
  }

  return {
    invoiceNumber,
    date: formattedDate,
    randomCode,
    totalAmount,
    items
  };
}

/** 別名導出以增強命名相容性 */
export const parseInvoiceQRCode = parseTaiwanInvoice;
