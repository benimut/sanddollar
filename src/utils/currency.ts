/**
 * @file currency.ts
 * @description Sanddollar 貨幣與海外交易匯率計算工具模組
 * 提供外幣換算與手續費計算之共用運算核心 (calculateForeignTransaction)，
 * 統一支援海外支出（手續費外加，預設 1.5%）與海外收入（手續費內扣，預設 0%）之實質扣款/入帳與實質匯率推導。
 */

/**
 * 外幣交易換算結果介面
 */
export interface ForeignCalculationResult {
  /** 手續費金額 (新台幣) */
  feeAmount: number;
  /** 手續費金額別名 (相容 PROJECT.md 介面契約) */
  fee: number;
  /** 台幣扣款/入帳淨額 (新台幣) */
  twdAmount: number;
  /** 實質總金額 (支出時為扣款總額，收入時為實收總額) (新台幣) */
  totalTwdAmount: number;
  /** 實質總金額別名 (相容 PROJECT.md 介面契約) */
  totalTwd: number;
  /** 實質匯率 (每 1 外幣對應之新台幣實質金額) */
  effectiveRate: number;
}

/** 預設海外刷卡消費手續費率 (1.5%) */
export const DEFAULT_FEE_RATE = 0.015;

/** 預設海外支出手續費率別名 (1.5%) */
export const DEFAULT_EXPENSE_FEE_RATE = DEFAULT_FEE_RATE;

/** 預設海外收入手續費率 (0%) */
const DEFAULT_INCOME_FEE_RATE = 0;

/**
 * 計算外幣交易換算資訊 (共用計算核心)
 *
 * 根據交易類型 ('expense' 支出或 'income' 收入)、外幣金額與台幣扣款/入帳淨額，
 * 計算手續費、最終實質總金額以及實質匯率。
 *
 * @param type 交易類型：'expense' (支出，手續費外加) 或 'income' (收入，手續費內扣)
 * @param foreignAmount 外幣交易金額
 * @param netTwdAmount 台幣扣款或入帳淨額 (未含手續費)
 * @param feeRate 海外交易手續費率 (支出預設 0.015 即 1.5%，收入預設 0 即無額外手續費；若未提供或小於 0 則依交易類型 fallback 回退至預設值)
 * @returns 換算結果物件，包含手續費、扣款或實收總額與實質匯率
 */
export function calculateForeignTransaction(
  type: 'expense' | 'income',
  foreignAmount: number,
  netTwdAmount: number,
  feeRate?: number
): ForeignCalculationResult {
  // 邊界保護：若外幣金額或台幣淨額小於等於 0，回傳安全保護值全 0，且 effectiveRate 為 0 (非 NaN/Infinity)
  if (foreignAmount <= 0 || netTwdAmount <= 0) {
    return {
      feeAmount: 0,
      fee: 0,
      twdAmount: 0,
      totalTwdAmount: 0,
      totalTwd: 0,
      effectiveRate: 0,
    };
  }

  // 決定安全手續費率：若未傳入或小於 0 則 fallback 回退至各類型預設費率
  let safeFeeRate: number;
  if (feeRate === undefined || feeRate < 0) {
    safeFeeRate = type === 'expense' ? DEFAULT_EXPENSE_FEE_RATE : DEFAULT_INCOME_FEE_RATE;
  } else {
    safeFeeRate = feeRate;
  }

  // 手續費計算 (四捨五入至整數)
  const fee = Math.round(netTwdAmount * safeFeeRate);
  // 實質總金額：支出為台幣淨額 + 手續費，收入為台幣淨額 - 手續費
  const totalTwd = type === 'expense' ? netTwdAmount + fee : netTwdAmount - fee;
  // 實質匯率 = 實質總額 / 外幣金額
  const effectiveRate = foreignAmount > 0 ? totalTwd / foreignAmount : 0;

  return {
    feeAmount: fee,
    fee,
    twdAmount: netTwdAmount,
    totalTwdAmount: totalTwd,
    totalTwd,
    effectiveRate,
  };
}

/**
 * 計算海外支出換算資訊
 *
 * 根據外幣金額與台幣扣款淨額，計算手續費、最終扣款總額以及實質匯率。
 * 委託呼叫共用核心 calculateForeignTransaction('expense', ...)。
 *
 * @param foreignAmount 外幣消費金額
 * @param netTwdAmount 台幣扣款金額 (未含手續費)
 * @param feeRate 海外交易手續費率 (預設為 DEFAULT_FEE_RATE，即 0.015 / 1.5%)
 * @returns 換算結果物件，包含手續費、扣款總額與實質匯率
 */
export function calculateForeignExpense(
  foreignAmount: number,
  netTwdAmount: number,
  feeRate: number = DEFAULT_FEE_RATE
): ForeignCalculationResult {
  return calculateForeignTransaction('expense', foreignAmount, netTwdAmount, feeRate);
}

/**
 * 計算海外收入換算資訊
 *
 * 根據外幣收入金額與台幣入帳淨額，計算扣除手續費、實質入帳總額以及實質匯率。
 * 委託呼叫共用核心 calculateForeignTransaction('income', ...)。
 *
 * @param foreignAmount 外幣收入金額
 * @param netTwdAmount 台幣入帳金額 (未扣手續費之到帳額)
 * @param feeRate 海外交易手續費率 (預設為 DEFAULT_INCOME_FEE_RATE，即 0)
 * @returns 換算結果物件，包含手續費、實質入帳總額與實質匯率
 */
export function calculateForeignIncome(
  foreignAmount: number,
  netTwdAmount: number,
  feeRate: number = DEFAULT_INCOME_FEE_RATE
): ForeignCalculationResult {
  return calculateForeignTransaction('income', foreignAmount, netTwdAmount, feeRate);
}

/**
 * 外幣支出自訂手續費換算結果介面
 */
export interface CustomFeeForeignResult {
  /** 手續費金額 (新台幣) */
  feeAmount: number;
  /** 手續費率百分比 (例如 1.5 表示 1.5%) */
  feeRatePercent: number;
  /** 台幣扣款淨額 */
  netTwdAmount: number;
  /** 扣款總額 (淨額 + 手續費) */
  totalTwdAmount: number;
  /** 實質匯率 (扣款總額 / 外幣金額) */
  effectiveRate: number;
}

/**
 * 依手填手續費金額計算外幣支出換算與百分比推導
 *
 * @param foreignAmount 外幣消費金額
 * @param netTwdAmount 台幣扣款淨額 (未含手續費)
 * @param feeAmount 手填手續費金額 (新台幣)
 * @returns 換算結果物件
 */
export function calculateForeignExpenseWithCustomFee(
  foreignAmount: number,
  netTwdAmount: number,
  feeAmount: number
): CustomFeeForeignResult {
  const safeForeign = Number(foreignAmount) || 0;
  const safeNetTwd = Number(netTwdAmount) || 0;
  const safeFee = Number(feeAmount) || 0;

  if (safeNetTwd <= 0) {
    return {
      feeAmount: safeFee > 0 ? safeFee : 0,
      feeRatePercent: 0,
      netTwdAmount: 0,
      totalTwdAmount: 0,
      effectiveRate: 0,
    };
  }

  const effectiveFee = safeFee >= 0 ? safeFee : 0;
  const totalTwd = safeNetTwd + effectiveFee;
  const feeRatePercent = (effectiveFee / safeNetTwd) * 100;
  const effectiveRate = safeForeign > 0 ? totalTwd / safeForeign : 0;

  return {
    feeAmount: effectiveFee,
    feeRatePercent,
    netTwdAmount: safeNetTwd,
    totalTwdAmount: totalTwd,
    effectiveRate,
  };
}
