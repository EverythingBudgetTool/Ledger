import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Plus, Trash2, Pencil, X, Check, Calendar, Wallet, TrendingUp, TrendingDown,
  Upload, PiggyBank, CreditCard, Home, ListChecks, PieChart as PieIcon,
  ChevronLeft, ChevronRight, ChevronDown, ArrowRightLeft, AlertCircle, Repeat, Landmark, Receipt, Gift, Star
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line, ReferenceLine
} from "recharts";
import Papa from "papaparse";

/* ============================== CONSTANTS ============================== */

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const CATEGORY_PALETTE = ["#2f6f6b","#b5793a","#7a5c94","#3f7cac","#c15b4a","#5b8c3a","#a04e78","#4a6fa5","#8a7a3f","#6a5a8c","#3a8c7a","#c17a3a"];

// Auto-backup is built but held until the standalone (out-of-Claude) version
// ships — inside Claude's artifact sandbox, an automatic download/share-sheet
// popping up without a tap is unreliable and intrusive. Flip this to true in
// the standalone build to activate the toggle below.
const AUTO_BACKUP_READY = false;

// Shown in the header so you and testers can tell at a glance who's running
// what. Bump on each meaningful release.
const APP_VERSION = "v1.0 — July 2026";

const emptyData = () => ({
  accounts: [
    { id: uid(), name: "Checking", type: "checking" },
    { id: uid(), name: "Savings", type: "savings" },
  ],
  bills: [],
  income: [],
  transfers: [],
  transactions: [],
  dismissedDuplicateGroups: [],
  skippedOccurrences: [],
  occurrenceOverrides: [],
  autoBackupSettings: { enabled: false, frequency: "weekly", lastRun: null },
  emergencyFund: { accountName: "", months: 3, customTarget: null, monthlyContribution: 0, contributionDay: 1 },
  savedReportSelections: [],
  debts: [],
  debtSettings: { balanceDate: new Date().toISOString().slice(0, 10), monthlyPayment: 0, strategy: "snowball" },
  snowballPayments: [],
  budgetStartDate: "",
  savingsPlanSettings: {
    checkingAccount: "Checking",
    savingsAccount: "Savings",
    payPeriods: [
      { id: uid(), label: "1-9", startDay: 1, endDay: 9 },
      { id: uid(), label: "10-19", startDay: 10, endDay: 19 },
      { id: uid(), label: "20-end", startDay: 20, endDay: 31 },
    ],
  },
});

function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }


function fmtMoney(n) {
  const v = Number(n) || 0;
  return v < 0
    ? "-$" + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseMoney(s) {
  if (typeof s === "number") return s;
  if (!s) return 0;
  const cleaned = String(s).replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function daysInMonth(year, monthIdx) { return new Date(year, monthIdx + 1, 0).getDate(); }

function categoryColor(cat) {
  if (!cat) return "#9a958a";
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
  return CATEGORY_PALETTE[h % CATEGORY_PALETTE.length];
}

// Imported transaction categories can be hierarchical ("Business Expense >
// Taxes"). Keep just the most specific (last) part so chips stay one line.
function shortCategoryLabel(cat) {
  if (!cat) return cat;
  const lastSegment = s => { const parts = s.split(/[►>]/).map(p => p.trim()).filter(Boolean); return parts.length ? parts[parts.length - 1] : s; };
  // Combined categories (from merging split transactions) look like
  // "interest + Housing ► Mortgage + Taxes" — just show the first one plus
  // a count, rather than the full unbounded string.
  const combined = cat.split("+").map(s => s.trim()).filter(Boolean);
  const label = combined.length > 1 ? `${lastSegment(combined[0])} +${combined.length - 1}` : lastSegment(cat);
  return label.length > 22 ? label.slice(0, 21) + "…" : label;
}

function parseAnyDate(str) {
  if (!str) return null;
  const cleaned = String(str).split(" ")[0].trim();
  const iso = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const [, yy, mm, dd] = iso;
    return { month: parseInt(mm, 10) - 1, day: parseInt(dd, 10), year: parseInt(yy, 10) };
  }
  const full = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (full) {
    let [, mm, dd, yy] = full;
    if (yy.length === 2) yy = "20" + yy;
    return { month: parseInt(mm, 10) - 1, day: parseInt(dd, 10), year: parseInt(yy, 10) };
  }
  // Bare "MM/DD" with no year — used by recurring quarterly/custom schedule
  // entries, where the year is supplied separately for whichever year we're
  // expanding into.
  const bare = cleaned.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (bare) {
    const [, mm, dd] = bare;
    return { month: parseInt(mm, 10) - 1, day: parseInt(dd, 10), year: null };
  }
  return null;
}

// Converts any date string we can parse into the "YYYY-MM-DD" shape a native
// <input type="date"> requires for its value. Falls back to a given year
// when the source has no year (e.g. a bare "MM/DD" custom-schedule entry).
function toISOInput(str, fallbackYear) {
  const pd = parseAnyDate(str);
  if (!pd) return "";
  const y = pd.year || fallbackYear || new Date().getFullYear();
  return `${y}-${String(pd.month + 1).padStart(2, "0")}-${String(pd.day).padStart(2, "0")}`;
}

// Custom-dates entries are stored as "MM/DD" or "MM/DD:amount" strings (no
// year, since they recur annually). These convert that to/from editable rows.
function customRows(dates) {
  return (dates || []).map(entry => {
    const [dateStr, amtStr] = String(entry).split(":");
    return { date: dateStr, amount: amtStr !== undefined ? amtStr : "" };
  });
}
function rowToDateString(row) {
  const pd = parseAnyDate(row.date);
  if (!pd) return "";
  const mdy = `${pd.month + 1}/${pd.day}`;
  return row.amount !== "" && row.amount !== undefined ? `${mdy}:${row.amount}` : mdy;
}

/* ============================== OCCURRENCE ENGINE ============================== */
/* Single source of truth: every recurring bill/income/transfer expands into dated
   occurrences for a given year. Change a rule once, every view below reflects it. */

function expandItemForYear(item, year, kind) {
  const out = [];
  if (item.active === false) return out;
  const amount = Number(item.amount) || 0;

  if (item.frequency === "monthly") {
    const day = Math.max(1, Math.min(31, parseInt(item.dayOfMonth, 10) || 1));
    for (let m = 0; m < 12; m++) {
      const d = Math.min(day, daysInMonth(year, m));
      out.push({ kind, ...item, amount, date: new Date(year, m, d) });
    }
  } else if (item.frequency === "biweekly") {
    const anchor = parseAnyDate(item.anchorDate);
    if (anchor) {
      const msPerDay = 86400000;
      const anchorDate = new Date(anchor.year, anchor.month, anchor.day);
      const yearStart = new Date(year, 0, 1);
      const yearEnd = new Date(year, 11, 31);
      const diffDays = Math.round((yearStart - anchorDate) / msPerDay);
      const steps = Math.ceil(diffDays / 14);
      let d = new Date(anchorDate.getTime() + steps * 14 * msPerDay);
      while (d < yearStart) d = new Date(d.getTime() + 14 * msPerDay);
      while (d <= yearEnd) {
        out.push({ kind, ...item, amount, date: new Date(d) });
        d = new Date(d.getTime() + 14 * msPerDay);
      }
    }
  } else if (item.frequency === "quarterly" || item.frequency === "custom") {
    (item.dates || []).forEach(entry => {
      const [dateStr, amtStr] = String(entry).split(":");
      const pd = parseAnyDate(dateStr);
      if (!pd) return;
      const amt = amtStr !== undefined && amtStr !== "" ? (parseFloat(amtStr) || 0) : amount;
      out.push({ kind, ...item, amount: amt, date: new Date(year, pd.month, pd.day) });
    });
  } else if (item.frequency === "yearly" || item.frequency === "once") {
    const pd = parseAnyDate(item.date);
    if (pd) {
      if (item.frequency === "once") {
        if (pd.year === year) out.push({ kind, ...item, amount, date: new Date(pd.year, pd.month, pd.day) });
      } else {
        out.push({ kind, ...item, amount, date: new Date(year, pd.month, pd.day) });
      }
    }
  } else if (item.frequency === "multiyear") {
    const pd = parseAnyDate(item.date);
    const interval = Math.max(2, parseInt(item.yearInterval, 10) || 2);
    if (pd && year >= pd.year && (year - pd.year) % interval === 0) {
      out.push({ kind, ...item, amount, date: new Date(year, pd.month, pd.day) });
    }
  }
  return out;
}

function useYearOccurrences(data, year) {
  return useMemo(() => {
    const bills = data.bills.flatMap(b => expandItemForYear(b, year, "bill"));
    const income = data.income.flatMap(i => expandItemForYear(i, year, "income"));
    const transfers = data.transfers.flatMap(t => expandItemForYear(t, year, "transfer"));
    const autopay = getAutopayOccurrencesForYear(data, year);
    const all = [...bills, ...income, ...transfers, ...autopay].sort((a, b) => a.date - b.date);
    return { bills, income, transfers, autopay, all };
  }, [data, year]);
}

/* ---- Credit card statement-balance autopay ----
   For a card with a statement close day, the "statement" is every bill charged
   to that card between the day after the previous close and this close. That
   total becomes the payment due on the card's payment day the following month. */

function sumBillsForAccountInRange(bills, accountName, start, end) {
  const years = new Set([start.getFullYear(), end.getFullYear()]);
  let total = 0;
  years.forEach(y => {
    bills.filter(b => b.account === accountName).forEach(b => {
      expandItemForYear(b, y, "bill").forEach(occ => {
        if (occ.date >= start && occ.date <= end) total += occ.amount;
      });
    });
  });
  return total;
}

// A statement window is partly the past (real charges may already be known,
// including incidental ones no recurring bill predicts) and partly the
// future (nothing to go on yet but scheduled bills). This blends the two:
// actual imported transactions for whatever portion of the window has been
// imported, scheduled bills projected for whatever portion hasn't been.
// The amount a statement-balance card autopays is its ACTUAL BALANCE at the
// statement close date — not a sum of new charges in the window. A real
// statement balance is: prior balance + every charge, payment, credit, and
// refund that posted through the close date. Computing it as a running
// balance (startingBalance + all posted transactions up to the close)
// naturally incorporates mid-cycle payments and credits, which the old
// "sum charges in the window, ignore payments" approach dropped — that's what
// inflated projections (e.g. Alaska Visa showing ~$6,935 of raw charges when
// the real statement, after payments, was $3,214.48).
//
// `end` is the statement close date; `start` is only still used to bound the
// scheduled-bills projection for the not-yet-posted remainder of an OPEN
// statement.
function actualOrScheduledSum(data, bills, accountName, start, end, floorDate) {
  const acct = (data.accounts || []).find(a => a.name === accountName);
  const startingBalance = acct ? (acct.startingBalance || 0) : 0;
  const txns = (data.transactions || []).filter(t => t.account === accountName);

  // No real data at all: fall back to projecting scheduled bills in the window.
  if (txns.length === 0) {
    return { amount: sumBillsForAccountInRange(bills, accountName, start, end), source: "scheduled" };
  }

  const latestImported = txns.reduce((max, t) => t.date > max ? t.date : max, txns[0].date);
  const latestImportedDate = new Date(latestImported + "T23:59:59");

  // If this ENTIRE statement window is beyond the real data (its start is
  // already past the last imported transaction), the running balance is
  // frozen at a stale value and can't tell us anything about this cycle. Fall
  // back to summing only the scheduled bills that fall WITHIN this one window
  // — the same behavior the pre-running-balance code used. This is what keeps
  // a recurring annual fee (e.g. a card's yearly fee) from being counted in
  // every subsequent statement: it lands in exactly the window it's dated in.
  // The running-balance blend below is reserved for the genuine "open
  // statement" case, where real data covers the early part of the window and
  // only the tail is projected.
  if (latestImportedDate < start) {
    return { amount: sumBillsForAccountInRange(bills, accountName, start, end), source: "scheduled" };
  }

  // Running balance from posted transactions on or before the close date.
  // Balance is stored negative (money owed); the payment is its magnitude.
  // If a budget-start floor is set, it acts as a reconciliation point: count
  // startingBalance plus only transactions on/after the floor, so a mid-year
  // reset behaves as "the balance starts fresh here." With no floor (the
  // normal case) every posted transaction counts.
  // `end` is midnight at the start of the close day; a transaction dated ON
  // the close day must still count (the statement includes its own close
  // date), so compare against the end of that day, not its start.
  const endInclusive = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59);
  const balanceAtClose = startingBalance + txns
    .filter(t => {
      const d = new Date(t.date + "T12:00:00");
      if (d > endInclusive) return false;
      if (floorDate && d < floorDate) return false;
      return true;
    })
    .reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const postedPayment = Math.abs(balanceAtClose);

  // PAST / CLOSED statement: every day of the window has posted data, so the
  // running balance IS the real statement balance. This is the exact number
  // the bank would bill.
  if (latestImportedDate >= end) {
    return { amount: postedPayment, source: "actual" };
  }

  // OPEN statement (close date is still in the future relative to imported
  // data): take the real balance accrued so far, then add scheduled bills for
  // the remaining, not-yet-posted portion of the window as a projection.
  const scheduledStart = new Date(latestImportedDate.getTime() + 86400000);
  let scheduledAmount = sumBillsForAccountInRange(bills, accountName, scheduledStart, end);

  // Envelope adjustment: a budget-line placeholder whose occurrence sits in
  // the future portion is partially "used up" by real transactions already
  // assigned to it within this same window — count only its remainder, so
  // the blend is actuals + what's genuinely left, not actuals + the full
  // placeholder on top of the very spending it represents.
  bills.filter(b => b.active !== false && b.isBudgetLine && b.account === accountName).forEach(b => {
    const occs = expandItemForYear(b, scheduledStart.getFullYear(), "bill")
      .concat(scheduledStart.getFullYear() !== end.getFullYear() ? expandItemForYear(b, end.getFullYear(), "bill") : []);
    occs.filter(o => o.date >= scheduledStart && o.date <= end).forEach(o => {
      const spent = envelopeSpent(data, b, start, end);
      scheduledAmount -= Math.min(spent, o.amount);
      if (scheduledAmount < 0) scheduledAmount = 0;
    });
  });

  return { amount: postedPayment + scheduledAmount, source: "blended" };
}

function getAutopayOccurrencesForYear(data, year, ignoreFloor, useActualData = true) {
  const out = [];
  const floor = ignoreFloor ? null : parseAnyDate(data.budgetStartDate);
  const floorDate = floor ? new Date(floor.year, floor.month, floor.day) : null;

  data.accounts.filter(a => a.isCreditCard && a.autopay && a.statementCloseDay && a.paymentDueDay).forEach(card => {
    for (let m = 0; m < 12; m++) {
      // Payment lands in month m; it covers the statement that closed the previous month.
      let closeMonth = m - 1, closeYear = year;
      if (closeMonth < 0) { closeMonth = 11; closeYear = year - 1; }
      const closeDay = Math.min(card.statementCloseDay, daysInMonth(closeYear, closeMonth));
      const statementEnd = new Date(closeYear, closeMonth, closeDay);

      // The previous cycle's close date, computed the same way (respecting
      // that month's actual length) — the new cycle starts exactly one day
      // after that, so there's never a gap or overlap regardless of month
      // length or a close day of 31/"end of month".
      let prevCloseMonth = closeMonth - 1, prevCloseYear = closeYear;
      if (prevCloseMonth < 0) { prevCloseMonth = 11; prevCloseYear = closeYear - 1; }
      const prevCloseDay = Math.min(card.statementCloseDay, daysInMonth(prevCloseYear, prevCloseMonth));
      const previousStatementEnd = new Date(prevCloseYear, prevCloseMonth, prevCloseDay);
      let statementStart = new Date(previousStatementEnd.getTime() + 86400000);

      // Nothing before the budget start date counts — handy after a manual
      // extra payment resets a balance, or when starting the app mid-year.
      if (floorDate && floorDate > statementStart) statementStart = floorDate;

      let amount = 0, amountSource = "scheduled";
      if (statementStart <= statementEnd) {
        const result = useActualData
          ? actualOrScheduledSum(data, data.bills, card.name, statementStart, statementEnd, floorDate)
          : { amount: sumBillsForAccountInRange(data.bills, card.name, statementStart, statementEnd), source: "scheduled" };
        amount = result.amount;
        amountSource = result.source;
      }
      const dueDay = Math.min(card.paymentDueDay, daysInMonth(year, m));
      out.push({
        kind: "autopay", id: card.id + "-" + year + "-" + m,
        date: new Date(year, m, dueDay),
        payee: card.name + " autopay",
        label: card.name + " autopay",
        from: card.paymentAccount || "Checking", to: card.name,
        account: card.paymentAccount || "Checking",
        amount, amountSource, category: "CREDIT CARD AUTOPAY",
        statementStart, statementEnd,
      });
    }
  });
  return out;
}

/* ============================== DEBT PAYOFF ENGINE ============================== */
/* Standard debt-snowball simulation: every dollar of a paid-off debt's minimum
   payment rolls into the next target debt, chosen by the selected strategy. */

function orderDebts(debts, strategy) {
  const active = debts.filter(d => d.active !== false && d.balance > 0);
  if (strategy === "avalanche") return [...active].sort((a, b) => b.rate - a.rate);
  if (strategy === "custom") return [...active].sort((a, b) => (a.order || 999) - (b.order || 999));
  if (strategy === "none") return [...active];
  return [...active].sort((a, b) => a.balance - b.balance); // snowball: lowest balance first
}

// Scheduled snowball payments can change over time — e.g. a payment that was
// going to one debt moves to another starting a given month. Sum whatever's
// active for a given debt on a given date.
function scheduledSnowballFor(debtId, monthDate, snowballPayments) {
  return (snowballPayments || [])
    .filter(sp => sp.targetDebtId === debtId)
    .filter(sp => {
      const startOk = !sp.startDate || monthDate >= new Date(sp.startDate + "T00:00:00");
      const endOk = !sp.endDate || monthDate <= new Date(sp.endDate + "T23:59:59");
      return startOk && endOk;
    })
    .reduce((s, sp) => s + (Number(sp.amount) || 0), 0);
}

// For the "how much is truly still uncommitted" summary: a scheduled payment
// that starts next month is already spoken for, even if it hasn't kicked in
// yet as of the balance date — so count it regardless of its start/end date.
function allScheduledSnowballFor(debtId, snowballPayments) {
  return (snowballPayments || [])
    .filter(sp => sp.targetDebtId === debtId)
    .reduce((s, sp) => s + (Number(sp.amount) || 0), 0);
}

function floorPayment(d, monthDate, snowballPayments) {
  return (d.minPayment || 0) + (d.extraPayment || 0) + (monthDate ? scheduledSnowballFor(d.id, monthDate, snowballPayments) : 0);
}

// Some cards carry a promotional rate (often 0%) for a limited time, then
// switch to the real APR. If a promo end date is set and we're still before
// it, use the promo rate; otherwise use the regular rate.
function effectiveRate(d, date) {
  if (d.promoEndDate) {
    const promoEnd = new Date(d.promoEndDate + "T23:59:59");
    if (date <= promoEnd) return d.promoRate || 0;
  }
  return d.rate || 0;
}

function addMonthsToDateString(dateStr, months) {
  const [y, m, d] = (dateStr || "2026-01-01").split("-").map(Number);
  const dt = new Date(y, (m - 1) + months, d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// For debts with escrow tracking (e.g. a mortgage), split the flat monthly
// escrow contribution into a tax portion and an insurance portion.
function escrowSplit(d) {
  const escrow = d.escrowMonthly || 0;
  const tax = (d.annualPropertyTax || 0) / 12;
  const insurance = (d.annualHomeownersInsurance || 0) / 12;
  const known = tax + insurance;
  // Can be positive (a built-in cushion) or negative (a projected shortfall) —
  // both are worth showing, not silently zeroing out.
  const other = Math.round((escrow - known) * 100) / 100;
  return { escrow, tax: Math.round(tax * 100) / 100, insurance: Math.round(insurance * 100) / 100, other };
}

/* ============================== SAVINGS TRANSFER PLAN ============================== */
/* Recreates Heather's original "Adjusted To Savings" spreadsheet logic:
   average Income / Checking-funded bills / Savings-funded bills per pay
   period across the year, then solve for a transfer-to-savings amount per
   period that evens out leftover checking cash, rounded up to the nearest $10. */

function dayInPeriod(day, period, daysThisMonth) {
  const end = Math.min(period.endDay, daysThisMonth);
  return day >= period.startDay && day <= end;
}

function computeSavingsPlan(data, year) {
  const settings = data.savingsPlanSettings || emptyData().savingsPlanSettings;
  const periods = settings.payPeriods && settings.payPeriods.length ? settings.payPeriods : emptyData().savingsPlanSettings.payPeriods;
  const savingsAccount = settings.savingsAccount || "Savings";
  const checkingAccount = settings.checkingAccount || "Checking";

  const incomeItems = (data.income || []).filter(i => i.active !== false && !i.irregular);
  // Bills charged directly to a card that autopays its statement balance don't
  // hit Checking/Savings on their own charge date — the card's autopay
  // occurrence (below) already aggregates them onto the real payment date.
  const autopayCardNames = new Set((data.accounts || []).filter(a => a.isCreditCard && a.autopay).map(a => a.name));
  const billItems = (data.bills || []).filter(b => b.active !== false && !autopayCardNames.has(b.account));

  // Per period, per month totals — then averaged across the 12 months.
  const sums = periods.map(() => ({ income: Array(12).fill(0), checking: Array(12).fill(0), savings: Array(12).fill(0) }));

  const addToBuckets = (amount, date, acct) => {
    const bucket = acct === savingsAccount ? "savings" : acct === checkingAccount ? "checking" : null;
    if (!bucket) return; // funded by some other account entirely — doesn't touch Checking or Savings cash flow
    const m = date.getMonth(), day = date.getDate(), dim = daysInMonth(year, m);
    periods.forEach((p, idx) => { if (dayInPeriod(day, p, dim)) sums[idx][bucket][m] += amount; });
  };

  incomeItems.forEach(i => {
    expandItemForYear(i, year, "income").forEach(occ => {
      const m = occ.date.getMonth(), day = occ.date.getDate(), dim = daysInMonth(year, m);
      periods.forEach((p, idx) => { if (dayInPeriod(day, p, dim)) sums[idx].income[m] += occ.amount; });
    });
  });

  billItems.forEach(b => {
    const fundedBy = b.fundedBy || b.account;
    expandItemForYear(b, year, "bill").forEach(occ => addToBuckets(occ.amount, occ.date, fundedBy));
  });

  // Fold in each autopay card's real payment — correct amount (the whole
  // statement), correct date (the actual due day), correct account. Uses
  // scheduled bills only (not imported actuals) — this plan is meant to
  // reflect your current recurring setup going forward, not what happened
  // historically under a funding arrangement that may have since changed.
  getAutopayOccurrencesForYear(data, year, true, false).forEach(occ => addToBuckets(occ.amount, occ.date, occ.account));

  const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const rows = periods.map((p, idx) => {
    const incomeAvg = avg(sums[idx].income);
    const checkingAvg = avg(sums[idx].checking);
    const savingsAvg = avg(sums[idx].savings);
    const net = incomeAvg - savingsAvg - checkingAvg;
    return { id: p.id, label: p.label, startDay: p.startDay, endDay: p.endDay, incomeAvg, checkingAvg, savingsAvg, net };
  });

  const avgNet = avg(rows.map(r => r.net));
  rows.forEach(r => {
    r.delta = r.net - avgNet;
    r.adjustedToSavings = Math.ceil((r.savingsAvg + r.delta) / 10) * 10;
    r.adjustedNet = r.incomeAvg - r.adjustedToSavings - r.checkingAvg;
  });

  return { rows, avgNet, totalAdjusted: rows.reduce((s, r) => s + r.adjustedToSavings, 0) };
}

// Emergency fund: the target is computed from the person's OWN bill list —
// the average monthly cost of bills marked "essential" (survival-mode
// expenses: housing, utilities, food, insurance — not gifts or extras) —
// times the number of months of cushion they want. Progress is simply the
// designated account's real balance.
// Category-level budgeted vs. actual for a given month — shared by the
// Budget tab and the Dashboard's budget health card, so both always agree.
function computeBudgetVsActual(data, accounts, year, month) {
  const STANDARD_ORDER = ["HOUSEHOLD", "GROCERIES", "FOOD & GROCERIES", "TRANSPORTATION", "MEDICAL", "INSURANCE", "KIDS", "PETS", "PROTECTION PLAN", "SUBSCRIPTION", "ENTERTAINMENT", "PERSONAL", "BUSINESS EXPENSE", "CREDIT CARD", "CHARITABLE DONATION"];
  const planBills = data.bills.filter(b => b.active !== false && !b.isGift && !b.isWishlistItem);
  const monthlyOf = b => {
    if (b.frequency === "multiyear") {
      const interval = Math.max(2, parseInt(b.yearInterval, 10) || 2);
      return (Number(b.amount) || 0) / (interval * 12);
    }
    return expandItemForYear(b, year, "bill").reduce((s, o) => s + o.amount, 0) / 12;
  };
  const byCat = {};
  planBills.forEach(b => {
    const cKey = (b.category || "Uncategorized").toUpperCase();
    (byCat[cKey] = byCat[cKey] || []).push(b);
  });
  const cats = [...STANDARD_ORDER.filter(cc => byCat[cc]), ...Object.keys(byCat).filter(cc => !STANDARD_ORDER.includes(cc)).sort()];
  const monthlyIncome = (data.income || []).filter(i => i.active !== false && !i.irregular)
    .reduce((s, i) => s + expandItemForYear(i, year, "income").reduce((a, o) => a + o.amount, 0), 0) / 12;
  const grandTotal = planBills.reduce((s, b) => s + monthlyOf(b), 0);
  const left = monthlyIncome - grandTotal;

  // Actual spending by category for the SELECTED month, from real
  // register transactions — reimbursement categories (anything
  // ending "REIMBURSEMENT") net back against their base category,
  // so a category shows the true out-of-pocket cost.
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month, daysInMonth(year, month));
  const spendByCat = {}, reimbByCat = {};
  (data.transactions || []).forEach(t => {
    const d = new Date(t.date + "T12:00:00");
    if (d < monthStart || d > monthEnd) return;
    const acct = accounts.find(a => a.name === t.account);
    if (acct?.isLoan) return; // principal/interest — already tracked precisely via Debt Payoff, not budget-category spending
    if (/^loan payment/i.test((t.description || "").replace(/\u00a0/g, " ").trim())) return; // same, even when recorded on the paying account (e.g. Checking)
    // Raw imported categories are often hierarchical ("Food ► Groceries")
    // or combined from split transactions ("X + Y") — normalize the
    // same way the Register does, so they line up with plain bill categories.
    const cat = shortCategoryLabel(t.category || "Uncategorized").toUpperCase();
    if (cat === "TRANSFER" || cat === "FRAUD" || cat === "SECURITY HOLD") return; // resolved disputes and reversed holds net to zero — not real spending
    if (t.amount < 0) spendByCat[cat] = (spendByCat[cat] || 0) + (-t.amount);
    else if (cat.endsWith(" REIMBURSEMENT")) {
      const baseCat = cat.replace(" REIMBURSEMENT", "").trim();
      reimbByCat[baseCat] = (reimbByCat[baseCat] || 0) + t.amount;
    }
  });
  const actualForCat = cat => Math.max(0, (spendByCat[cat] || 0) - (reimbByCat[cat] || 0));
  const isCurrentOrPastMonth = year < new Date().getFullYear() || (year === new Date().getFullYear() && month <= new Date().getMonth());
  const actualTotal = Object.keys(spendByCat).reduce((s, c) => s + actualForCat(c), 0);

  return { STANDARD_ORDER, planBills, monthlyOf, byCat, cats, monthlyIncome, grandTotal, left, spendByCat, reimbByCat, actualForCat, isCurrentOrPastMonth, actualTotal };
}

// Real historical monthly totals for any set of accounts, from actual
// register transactions — per-account rows plus a combined total, each
// month's number backed by the specific transactions that produced it
// (for drill-down, matching how MoneyWiz's historical reports work).
// Normalizes a raw transaction description into a stable payee grouping key —
// strips order/reference codes (the alphanumeric noise appended per-purchase,
// e.g. "AMAZON MKTPL*077GR1013") and trailing long digit runs, so repeat
// purchases from the same merchant cluster into one row instead of each
// getting its own. Falls back to the trimmed description when nothing to strip.
function normalizePayee(desc) {
  let s = (desc || "").replace(/\u00a0/g, " ").trim();
  if (!s) return "(no description)";
  s = s.replace(/^(TST|SQ|IC|DD|SP|PHR)\*\s*/i, "");     // POS-processor prefixes ("TST*Restaurant Name") — merchant follows the star here, so strip just the prefix
  s = s.replace(/\*[A-Z0-9]{4,}.*$/i, "").trim();          // "AMAZON MKTPL*077GR1013 Amzn.com/billWA" -> "AMAZON MKTPL"
  s = s.replace(/\s+\d[\d-]{5,}.*$/, "").trim();             // trailing phone-number-like or long reference strings
  s = s.replace(/\s{2,}/g, " ");
  return s || (desc || "").trim() || "(no description)";
}

// The label shown for a transaction in the register: the Payee is the primary
// identity; when it's blank we fall back to the Description so nothing shows as
// empty. (Full raw description is always still visible/editable in the
// transaction detail view.) Non-breaking spaces are normalized for display so
// imported bank text reads cleanly.
function txnLabel(t) {
  const payee = (t.payee || "").replace(/\u00a0/g, " ").trim();
  if (payee) return payee;
  const desc = (t.description || "").replace(/\u00a0/g, " ").trim();
  return desc || "—";
}

// Historical monthly totals for any set of accounts, from actual register
// transactions, grouped by account, category, or normalized payee — each
// row's monthly number backed by the specific transactions behind it (for
// drill-down, matching how MoneyWiz's historical reports work).
function computeHistoricalReport(data, accountNames, year, groupBy = "account") {
  const txns = (data.transactions || []).filter(t => accountNames.includes(t.account));
  const keyOf = t => {
    if (groupBy === "category") return shortCategoryLabel(t.category || "Uncategorized").toUpperCase() || "UNCATEGORIZED";
    if (groupBy === "payee") return t.payee || normalizePayee(t.description);
    return t.account; // account mode: one row per selected account, even if empty
  };
  const rowKeys = groupBy === "account" ? [...accountNames] : [];
  const byKey = {};
  const ensureRow = key => {
    if (!byKey[key]) {
      byKey[key] = { label: key, months: Array.from({ length: 12 }, () => ({ total: 0, transactions: [] })) };
      if (groupBy !== "account") rowKeys.push(key);
    }
    return byKey[key];
  };
  accountNames.forEach(name => { if (groupBy === "account") ensureRow(name); });
  txns.forEach(t => {
    const d = new Date(t.date + "T12:00:00");
    if (d.getFullYear() !== year) return;
    const m = d.getMonth();
    const row = ensureRow(keyOf(t));
    row.months[m].total += -t.amount; // spend-positive convention, matching "what each account owes"
    row.months[m].transactions.push(t);
  });
  rowKeys.sort((a, b) => {
    if (groupBy === "account") return 0; // keep selection order
    const totalA = byKey[a].months.reduce((s, m) => s + Math.abs(m.total), 0);
    const totalB = byKey[b].months.reduce((s, m) => s + Math.abs(m.total), 0);
    return totalB - totalA; // biggest first for category/payee
  });
  const rows = rowKeys.map(k => byKey[k]);
  const totalMonths = Array.from({ length: 12 }, (_, m) => rows.reduce((s, r) => s + r.months[m].total, 0));
  // perAccount kept as an alias so existing account-mode callers/JSX using
  // `.account` instead of `.label` keep working without changes.
  const perAccount = rows.map(r => ({ account: r.label, months: r.months }));
  return { rows, perAccount, totalMonths, groupBy };
}

function computeEmergencyFund(data, year) {
  const ef = data.emergencyFund || emptyData().emergencyFund;
  const essentialBills = (data.bills || []).filter(b =>
    b.active !== false && b.essential === true && !b.isGift && !b.isWishlistItem);
  const essentialYearTotal = essentialBills.reduce((sum, b) =>
    sum + expandItemForYear(b, year, "bill").reduce((s, occ) => s + occ.amount, 0), 0);
  const essentialMonthly = essentialYearTotal / 12;

  const target = ef.customTarget != null && ef.customTarget > 0
    ? ef.customTarget
    : Math.round(essentialMonthly * (ef.months || 3));

  const acct = (data.accounts || []).find(a => a.name === ef.accountName);
  const saved = acct ? currentAccountBalance(data, acct.name, acct.startingBalance) : 0;

  const milestones = [
    { label: "$1,000 starter", value: 1000 },
    { label: "1 month", value: Math.round(essentialMonthly) },
    { label: `${ef.months || 3} months (goal)`, value: target },
  ].filter((m, i, arr) => m.value > 0 && arr.findIndex(x => x.value === m.value) === i)
   .sort((a, b) => a.value - b.value);

  const remaining = Math.max(0, target - saved);
  const monthsToGoal = ef.monthlyContribution > 0 ? Math.ceil(remaining / ef.monthlyContribution) : null;
  const fundedBy = monthsToGoal != null && remaining > 0
    ? new Date(new Date().getFullYear(), new Date().getMonth() + monthsToGoal, 1)
    : null;

  return { settings: ef, essentialMonthly, essentialCount: essentialBills.length, target, saved, remaining, milestones, monthsToGoal, fundedBy };
}

function simulateDebtPayoff(debts, monthlyPayment, strategy, balanceDateStr, snowballPayments) {
  const active = debts.filter(d => d.active !== false && d.balance > 0);
  const totalMin = active.reduce((s, d) => s + (d.minPayment || 0), 0);
  const [by, bm, bd] = (balanceDateStr || "2026-01-01").split("-").map(Number);
  const start = new Date(by, (bm || 1) - 1, bd || 1);
  // Committed floor for the summary card: minimums + a debt's own standing
  // extra + every scheduled snowball payment, whether or not it's started
  // yet — a payment starting next month is already spoken for today.
  const totalFloor = active.reduce((s, d) => s + (d.minPayment || 0) + (d.extraPayment || 0) + allScheduledSnowballFor(d.id, snowballPayments), 0);
  const order = orderDebts(debts, strategy).map(d => d.id);
  const state = {};
  const ledgers = {};
  active.forEach(d => { state[d.id] = { ...d, remaining: d.balance, interestPaid: 0, payoffMonth: null }; ledgers[d.id] = []; });

  const rollExtra = strategy !== "none";
  const schedule = [];
  const maxMonths = 600;
  let month = 0;
  let unpaid = order.filter(id => state[id].remaining > 0);
  // Extra payments freed up by a paid-off debt roll forward permanently —
  // tracked separately from each month's scheduled/base floor payments.
  let rolledOverExtra = 0;

  while (unpaid.length > 0 && month < maxMonths) {
    let totalBalance = 0, totalInterestThisMonth = 0, totalPaidThisMonth = 0;
    const date = new Date(start.getFullYear(), start.getMonth() + month + 1, 1);

    unpaid = order.filter(id => state[id] && state[id].remaining > 0.005);
    // Budget on top of what's already committed this month (minimums + any
    // standing or scheduled snowball payments), recomputed monthly since a
    // scheduled payment can start or end partway through the projection.
    const monthFloorTotal = unpaid.reduce((s, id) => s + floorPayment(state[id], date, snowballPayments), 0);
    const availableExtra = strategy === "none" ? 0 : Math.max(0, monthlyPayment - monthFloorTotal + rolledOverExtra);

    unpaid.forEach((id, idx) => {
      const d = state[id];
      const startingBalance = d.remaining;
      const interest = Math.round(d.remaining * effectiveRate(d, date) / 12 * 100) / 100;
      d.remaining += interest;
      d.interestPaid += interest;
      totalInterestThisMonth += interest;

      const isTarget = idx === 0;
      const floor = floorPayment(d, date, snowballPayments);
      let payment = Math.min(d.remaining, floor + (isTarget ? availableExtra : 0));
      const principal = Math.round((payment - interest) * 100) / 100;
      d.remaining = Math.max(0, Math.round((d.remaining - payment) * 100) / 100);
      totalPaidThisMonth += payment;

      ledgers[id].push({ month, date, startingBalance, interest, principal, payment, remaining: d.remaining, escrow: d.escrowMonthly ? escrowSplit(d) : null });

      if (d.remaining <= 0.005 && d.payoffMonth === null) {
        d.payoffMonth = month;
        if (rollExtra) rolledOverExtra += floor;
      }
    });

    Object.values(state).forEach(d => { totalBalance += d.remaining; });
    schedule.push({ month, date, totalBalance, totalInterestThisMonth, totalPaidThisMonth });

    unpaid = order.filter(id => state[id].remaining > 0.005);
    month++;
  }

  const perDebt = active.map(d => {
    const s = state[d.id];
    const payoffMonth = s.payoffMonth === null ? month : s.payoffMonth;
    const payoffDate = new Date(start.getFullYear(), start.getMonth() + payoffMonth + 1, 1);
    return { id: d.id, creditor: d.creditor, startBalance: d.balance, rate: d.rate, minPayment: d.minPayment, monthsToPayOff: payoffMonth + 1, payoffDate, interestPaid: Math.round(s.interestPaid * 100) / 100, ledger: ledgers[d.id] };
  }).sort((a, b) => a.monthsToPayOff - b.monthsToPayOff);

  const totalInterest = Math.round(perDebt.reduce((s, d) => s + d.interestPaid, 0) * 100) / 100;
  const debtFreeDate = perDebt.length ? perDebt[perDebt.length - 1].payoffDate : start;
  const hitMonthLimit = month >= maxMonths;

  return { schedule, perDebt, totalInterest, debtFreeDate, totalMin, totalFloor, extraPool: strategy === "none" ? 0 : Math.max(0, monthlyPayment - totalFloor), hitMonthLimit };
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

/* ============================== ACCOUNT REGISTER (CSV IMPORT) ============================== */
/* Generic bank/MoneyWiz-style CSV importer. Auto-detects likely column
   mapping by header name, falls back to manual mapping. Dedup is done by
   Date + Amount + Description, since these exports don't carry a stable
   transaction ID across repeated exports. */

function normalizeToISODate(str) {
  const pd = parseAnyDate(str);
  if (!pd) return null;
  const y = pd.year || new Date().getFullYear();
  return `${y}-${String(pd.month + 1).padStart(2, "0")}-${String(pd.day).padStart(2, "0")}`;
}

// Normalized text values that identify a transaction, from BOTH description
// and payee (nbsp-cleaned, lowercased). Two transactions with the same
// account/date/amount are considered the same real transaction if any of
// these text values overlap — so a re-import matches whether the merchant
// text lands in the description column, the payee column, or both.
function txnTextSet(t) {
  const clean = s => (s || "").replace(/\u00a0/g, " ").replace(/\s{2,}/g, " ").trim().toLowerCase();
  const set = new Set();
  const d = clean(t.description); if (d) set.add(d);
  const p = clean(t.payee); if (p) set.add(p);
  return set;
}

// The account/date/amount "bucket" a transaction falls into — the coarse
// match before comparing text.
function txnBucketKey(t) {
  return [t.account, t.date, Number(t.amount).toFixed(2)].join("|");
}

// Back-compat single-string key (still used by the duplicate-review panel).
function txnDedupKey(t) {
  return [t.account, t.date, Number(t.amount).toFixed(2), (t.description || "").replace(/\u00a0/g, " ").trim().toLowerCase()].join("|");
}

// Tries to guess which CSV column is which, so most exports "just work"
// without asking the user to map columns by hand.
function guessColumnMapping(headers) {
  const norm = h => String(h || "").trim().toLowerCase();
  const find = (...candidates) => {
    for (const cand of candidates) {
      const idx = headers.findIndex(h => norm(h) === cand);
      if (idx !== -1) return idx;
    }
    for (const cand of candidates) {
      const idx = headers.findIndex(h => norm(h).includes(cand));
      if (idx !== -1) return idx;
    }
    return -1;
  };
  return {
    date: find("date", "transaction date", "posted date"),
    amount: find("amount", "value"),
    debit: find("debit", "withdrawal"),
    credit: find("credit", "deposit"),
    // Description and Payee are captured SEPARATELY. Many exports (MoneyWiz)
    // carry both — a raw bank description plus a cleaned-up payee — and we want
    // to keep each. Only if there's no dedicated description column do we let
    // name/memo/merchant stand in for it.
    description: find("description", "name", "memo", "merchant"),
    payee: find("payee"),
    category: find("category"),
    splitGroup: find("transfers", "split", "group", "loan"),
  };
}

function buildTransactionsFromRows(rows, mapping, accountName) {
  const out = [];
  rows.forEach(r => {
    const dateRaw = mapping.date >= 0 ? r[mapping.date] : "";
    const iso = normalizeToISODate(dateRaw);
    if (!iso) return;
    let amount = null;
    if (mapping.amount >= 0 && r[mapping.amount] !== undefined && r[mapping.amount] !== "") {
      amount = parseMoney(r[mapping.amount]);
    } else if (mapping.debit >= 0 || mapping.credit >= 0) {
      const debit = mapping.debit >= 0 ? parseMoney(r[mapping.debit]) : 0;
      const credit = mapping.credit >= 0 ? parseMoney(r[mapping.credit]) : 0;
      amount = credit - Math.abs(debit);
    }
    if (amount === null || isNaN(amount)) return;
    const clean = s => String(s || "").replace(/\u00a0/g, " ").replace(/\s{2,}/g, " ").trim();
    const description = mapping.description >= 0 ? clean(r[mapping.description]) : "";
    const payee = mapping.payee >= 0 ? clean(r[mapping.payee]) : "";
    const category = mapping.category >= 0 ? clean(r[mapping.category]) : "";
    const splitGroup = mapping.splitGroup >= 0 ? clean(r[mapping.splitGroup]) : "";
    out.push({ account: accountName, date: iso, amount, description, payee, category, splitGroup });
  });

  if (mapping.splitGroup < 0) return out.map(({ splitGroup, ...t }) => t);

  // Some exports (MoneyWiz "split" transactions) record one real payment as
  // several rows — one per category — that together make up the total. Group
  // rows that share a date, description, and the chosen identifier column,
  // and combine them into a single transaction with a merged category.
  const groups = {};
  out.forEach(t => {
    const key = [t.date, t.description.toLowerCase(), t.splitGroup.toLowerCase()].join("|");
    (groups[key] = groups[key] || []).push(t);
  });
  return Object.values(groups).map(group => {
    if (group.length === 1) { const { splitGroup, ...t } = group[0]; return t; }
    const categories = [...new Set(group.map(t => t.category).filter(Boolean))];
    return {
      account: accountName, date: group[0].date, description: group[0].description,
      payee: group[0].payee || "",
      amount: Math.round(group.reduce((s, t) => s + t.amount, 0) * 100) / 100,
      category: categories.join(" + "),
    };
  });
}

// Adds a batch of parsed rows to the transaction list, skipping anything
// that already exists for this account (by Date + Amount + Description).
function mergeTransactions(existing, newRows, importBatchId) {
  // Group existing transactions by their account/date/amount bucket, keeping
  // the set of text values (description + payee) seen in each bucket.
  const buckets = new Map();
  existing.forEach(t => {
    const k = txnBucketKey(t);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(txnTextSet(t));
  });
  let added = 0, skipped = 0;
  const merged = [...existing];
  newRows.forEach(row => {
    const k = txnBucketKey(row);
    const rowText = txnTextSet(row);
    const bucket = buckets.get(k);
    let isDup = false;
    if (bucket) {
      for (const existingText of bucket) {
        // Overlap on any text value → same transaction. Also treat as a dup
        // when either side carries no distinguishing text at all (same
        // account/date/amount with nothing to tell them apart).
        const overlap = [...rowText].some(v => existingText.has(v));
        if (overlap || rowText.size === 0 || existingText.size === 0) { isDup = true; break; }
      }
    }
    if (isDup) { skipped++; return; }
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(rowText);
    merged.push({ id: uid(), source: "import", status: "posted", matchedBillId: null, importBatchId, ...row });
    added++;
  });
  return { merged, added, skipped };
}

function computeRegister(transactions, accountName, startingBalance) {
  const rows = transactions
    .filter(t => t.account === accountName)
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  let balance = startingBalance || 0;
  const withBalance = rows.map(t => {
    balance += Number(t.amount) || 0;
    return { ...t, runningBalance: balance };
  });
  return withBalance.reverse(); // most recent first for display
}

// Groups History rows the way a real statement would: everything not yet
// cleared sits together regardless of date, and everything cleared groups
// by which statement cycle it actually landed in — a real close day for
// credit cards, or calendar month for cash accounts that don't have one.
function groupHistoryByStatement(rows, acct) {
  const pending = rows.filter(t => t.status === "pending");
  const cleared = rows.filter(t => t.status !== "pending");
  const groups = {};

  cleared.forEach(t => {
    const d = new Date(t.date + "T00:00:00");
    let label, sortKey;
    if (acct?.isCreditCard && acct.statementCloseDay) {
      const closeDayThisMonth = Math.min(acct.statementCloseDay, daysInMonth(d.getFullYear(), d.getMonth()));
      let cycleEndMonth = d.getMonth(), cycleEndYear = d.getFullYear();
      if (d.getDate() > closeDayThisMonth) { cycleEndMonth += 1; if (cycleEndMonth > 11) { cycleEndMonth = 0; cycleEndYear += 1; } }
      const cycleEndDate = new Date(cycleEndYear, cycleEndMonth, Math.min(acct.statementCloseDay, daysInMonth(cycleEndYear, cycleEndMonth)));
      label = "Statement closing " + cycleEndDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      sortKey = cycleEndDate.getTime();
    } else {
      label = d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
      sortKey = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    }
    (groups[label] = groups[label] || { label, sortKey, items: [] }).items.push(t);
  });

  const sortedGroups = Object.values(groups).sort((a, b) => b.sortKey - a.sortKey);
  return { pending, groups: sortedGroups };
}

function currentAccountBalance(data, accountName, startingBalance) {
  const reg = computeRegister(data.transactions || [], accountName, startingBalance);
  return reg.length ? reg[0].runningBalance : (startingBalance || 0);
}

// For "adjust balance" entries: what the register currently computes as of a
// given date, so the adjustment amount needed to reconcile can be derived.
function balanceAsOfDate(data, accountName, startingBalance, asOfDateStr) {
  const txns = (data.transactions || []).filter(t => t.account === accountName && t.date <= asOfDateStr);
  return (startingBalance || 0) + txns.reduce((s, t) => s + (Number(t.amount) || 0), 0);
}

// Checks each account's low/high thresholds (if set) against its current
// balance and, for cash accounts, its projected balance over the next
// `lookAheadDays` — so a dip or spike can be flagged before it happens, not
// just after. Credit cards check their tracked debt balance instead, since
// that's what "trending higher than usual" means for a revolving card.
function checkBalanceAlerts(data, lookAheadDays) {
  const alerts = [];
  const today = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  const endDate = new Date(today.getTime() + (lookAheadDays || 30) * 86400000);

  (data.accounts || []).forEach(a => {
    if (a.lowBalanceThreshold == null && a.highBalanceThreshold == null) return;

    if (a.isCreditCard || a.isLoan) {
      const debt = (data.debts || []).find(d => d.creditor === a.name);
      const balance = debt ? debt.balance : 0;
      if (a.lowBalanceThreshold != null && balance < a.lowBalanceThreshold) {
        alerts.push({ account: a.name, type: "low", threshold: a.lowBalanceThreshold, value: balance, date: today, projected: false });
      }
      if (a.highBalanceThreshold != null && balance > a.highBalanceThreshold) {
        alerts.push({ account: a.name, type: "high", threshold: a.highBalanceThreshold, value: balance, date: today, projected: false });
      }
      return;
    }

    const current = currentAccountBalance(data, a.name, a.startingBalance);
    let running = current;
    let minBalance = current, minDate = today, maxBalance = current, maxDate = today;
    getScheduledOccurrencesWithInterest(data, a.name, today, endDate).forEach(o => {
      running += o.amount;
      if (running < minBalance) { minBalance = running; minDate = o.date; }
      if (running > maxBalance) { maxBalance = running; maxDate = o.date; }
    });
    if (a.lowBalanceThreshold != null && minBalance < a.lowBalanceThreshold) {
      alerts.push({ account: a.name, type: "low", threshold: a.lowBalanceThreshold, value: minBalance, date: minDate, projected: minDate.getTime() !== today.getTime() });
    }
    if (a.highBalanceThreshold != null && maxBalance > a.highBalanceThreshold) {
      alerts.push({ account: a.name, type: "high", threshold: a.highBalanceThreshold, value: maxBalance, date: maxDate, projected: maxDate.getTime() !== today.getTime() });
    }
  });

  return alerts;
}

// Net worth now, plus a 12-month forward projection combining each cash
// account's scheduled activity with the debt payoff schedule's balance
// trajectory — no historical snapshots needed since both sides are already
// computed from the same recurring data going forward.
function computeNetWorth(data, debtSchedule, monthsAhead) {
  const cashAccounts = (data.accounts || []).filter(a => !a.isCreditCard && !a.isLoan);
  const today = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

  let assetsNow = 0;
  cashAccounts.forEach(a => { assetsNow += currentAccountBalance(data, a.name, a.startingBalance); });
  const debtsNow = (data.debts || []).filter(d => d.active !== false).reduce((s, d) => s + (d.balance || 0), 0);

  const trend = [];
  for (let m = 1; m <= monthsAhead; m++) {
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + m, 0);
    let assets = 0;
    cashAccounts.forEach(a => {
      const base = currentAccountBalance(data, a.name, a.startingBalance);
      const scheduled = getScheduledOccurrencesWithInterest(data, a.name, today, monthEnd).reduce((s, o) => s + o.amount, 0);
      assets += base + scheduled;
    });
    const debtEntry = debtSchedule[m - 1];
    const debts = debtEntry ? debtEntry.totalBalance : debtsNow;
    trend.push({ month: monthEnd, assets, debts, netWorth: assets - debts });
  }

  return { assetsNow, debtsNow, netWorthNow: assetsNow - debtsNow, trend };
}

// Exact Date+Amount+Description dedup only catches re-imports from the same
// source. Switching sources (e.g. bank CSV vs. MoneyWiz) for an overlapping
// date range won't match on description, so the same real transaction can
// slip in twice under two different names. Flag same date+amount groups with
// differing descriptions so they can be reviewed and one side deleted.
// A stable identifier for one specific scheduled occurrence (this bill, on
// this exact date, for this exact amount) — used so a single instance can be
// permanently skipped without affecting future recurrences of the same bill.
function skipKey(accountName, o) {
  const iso = `${o.date.getFullYear()}-${String(o.date.getMonth() + 1).padStart(2, "0")}-${String(o.date.getDate()).padStart(2, "0")}`;
  return `${accountName}|${iso}|${o.description}|${o.amount.toFixed(2)}`;
}

// ---- Envelope budgeting ----
// A budget-line bill (isBudgetLine) is an "envelope": it starts each cycle
// at its full amount, and real transactions assigned to it (matchedBillId)
// spend it down. The cycle follows the account's statement window when the
// account is a card with a closing day, and the calendar month otherwise.
function envelopeWindow(data, bill, refDate) {
  const acct = (data.accounts || []).find(a => a.name === bill.account);
  if (acct?.isCreditCard && acct.statementCloseDay) {
    const closeThis = Math.min(acct.statementCloseDay, daysInMonth(refDate.getFullYear(), refDate.getMonth()));
    let endMonth = refDate.getMonth(), endYear = refDate.getFullYear();
    if (refDate.getDate() > closeThis) { endMonth += 1; if (endMonth > 11) { endMonth = 0; endYear += 1; } }
    const end = new Date(endYear, endMonth, Math.min(acct.statementCloseDay, daysInMonth(endYear, endMonth)));
    let prevMonth = endMonth - 1, prevYear = endYear;
    if (prevMonth < 0) { prevMonth = 11; prevYear -= 1; }
    const prevClose = new Date(prevYear, prevMonth, Math.min(acct.statementCloseDay, daysInMonth(prevYear, prevMonth)));
    return { start: new Date(prevClose.getTime() + 86400000), end };
  }
  return {
    start: new Date(refDate.getFullYear(), refDate.getMonth(), 1),
    end: new Date(refDate.getFullYear(), refDate.getMonth(), daysInMonth(refDate.getFullYear(), refDate.getMonth())),
  };
}

function envelopeSpent(data, bill, windowStart, windowEnd) {
  const inWindow = t => { const d = new Date(t.date + "T12:00:00"); return d >= windowStart && d <= windowEnd; };
  if (bill.envelopeAutoAll) {
    // Auto mode: every charge on the envelope's account counts, no manual
    // assigning — right for whole-card placeholders like a spouse's mixed
    // personal/business card. Only charges (negative) count; the card's
    // incoming payments would otherwise wrongly shrink "spent."
    return (data.transactions || [])
      .filter(t => t.account === bill.account && t.amount < 0)
      .filter(inWindow)
      .reduce((s, t) => s - t.amount, 0);
  }
  return (data.transactions || [])
    .filter(t => t.matchedBillId === bill.id)
    .filter(inWindow)
    .reduce((s, t) => s - t.amount, 0); // spending is negative; refunds assigned back reduce spent
}

function envelopeStatus(data, bill, refDate) {
  const win = envelopeWindow(data, bill, refDate);
  const spent = envelopeSpent(data, bill, win.start, win.end);
  const remaining = (bill.amount || 0) - spent;
  return { ...win, spent, remaining };
}

function findPossibleDuplicates(transactions, accountName, dismissedKeys) {
  const groups = {};
  transactions.filter(t => t.account === accountName).forEach(t => {
    const key = accountName + "|" + t.date + "|" + Number(t.amount).toFixed(2);
    (groups[key] = groups[key] || []).push(t);
  });
  const dismissed = new Set(dismissedKeys || []);
  return Object.entries(groups)
    .filter(([key, g]) => g.length > 1 && new Set(g.map(t => (t.description || "").trim().toLowerCase())).size > 1 && !dismissed.has(key))
    .map(([key, g]) => ({ key, transactions: g }))
    .sort((a, b) => a.transactions[0].date < b.transactions[0].date ? 1 : -1);
}

// Projects upcoming bills/income/transfers/autopay for one account within a
// date window, signed the way they'd actually hit that account's balance.
function getScheduledOccurrences(data, accountName, fromDate, toDate) {
  const years = new Set([fromDate.getFullYear(), toDate.getFullYear()]);
  const out = [];
  years.forEach(year => {
    (data.bills || []).filter(b => b.active !== false && b.account === accountName).forEach(b => {
      expandItemForYear(b, year, "bill").forEach(occ => {
        let amt = occ.amount, desc = occ.payee;
        // Envelope behavior: the occurrence for the CURRENT cycle reflects
        // what's left after assigned real transactions, not the full amount.
        if (b.isBudgetLine) {
          const st = envelopeStatus(data, b, new Date());
          if (occ.date >= st.start && occ.date <= st.end && st.spent > 0) {
            amt = Math.max(0, st.remaining);
            desc = `${occ.payee} (${fmtMoney(Math.max(0, st.remaining))} left of ${fmtMoney(b.amount)})`;
          }
        }
        out.push({ date: occ.date, description: desc, amount: -amt, kind: "bill", sourceId: b.id, sourceType: "bill" });
      });
    });
    // Bills that pay down a card or loan (e.g. "Toyota" paid from Checking,
    // paying down the Toyota loan) also appear on the TARGET account's
    // register as an incoming credit, so both sides of the payment are
    // visible where they belong.
    (data.bills || []).filter(b => b.active !== false && b.paysDownAccount === accountName).forEach(b => {
      expandItemForYear(b, year, "bill").forEach(occ => out.push({ date: occ.date, description: occ.payee + " (payment)", amount: occ.amount, kind: "payment", sourceId: b.id, sourceType: "bill" }));
    });
    (data.income || []).filter(i => i.active !== false && i.account === accountName).forEach(i => {
      expandItemForYear(i, year, "income").forEach(occ => out.push({ date: occ.date, description: occ.payee, amount: occ.amount, kind: "income", sourceId: i.id, sourceType: "income" }));
    });
    (data.transfers || []).filter(t => t.active !== false && (t.from === accountName || t.to === accountName)).forEach(t => {
      expandItemForYear(t, year, "transfer").forEach(occ => {
        if (occ.isBalance) return; // amount unknown until the statement closes
        const sign = t.from === accountName ? -1 : 1;
        out.push({ date: occ.date, description: occ.label + (t.from === accountName ? ` → ${t.to}` : ` ← ${t.from}`), amount: sign * occ.amount, kind: "transfer", sourceId: t.id, sourceType: "transfer" });
      });
    });
    // The Savings Plan's own computed period deposits show up as real
    // scheduled occurrences — an inflow on the savings account and the
    // matching outflow on checking — so the plan drives the register
    // directly instead of relying on manually maintained transfers.
    const sp = data.savingsPlanSettings;
    if (sp && sp.payPeriods && sp.payPeriods.length && (accountName === sp.savingsAccount || accountName === sp.checkingAccount)) {
      const plan = computeSavingsPlan(data, year);
      plan.rows.forEach(row => {
        const period = (sp.payPeriods || []).find(p => p.label === row.label) || {};
        const startDay = period.startDay || 1;
        for (let m = 0; m < 12; m++) {
          const day = Math.min(startDay, daysInMonth(year, m));
          const amt = row.adjustedToSavings;
          if (!amt) continue;
          out.push({
            date: new Date(year, m, day),
            description: `Savings Plan — ${row.label}`,
            amount: accountName === sp.savingsAccount ? amt : -amt,
            kind: "plan", sourceId: null, sourceType: "plan",
          });
        }
      });
    }

    // Emergency fund contributions work the same way: a computed monthly
    // occurrence — inflow on the fund account, outflow on checking — driven
    // by the emergency fund settings rather than a manually kept transfer.
    const ef = data.emergencyFund;
    const efSource = data.savingsPlanSettings?.checkingAccount || "Checking";
    if (ef && ef.accountName && ef.accountName !== efSource && ef.monthlyContribution > 0 && (accountName === ef.accountName || accountName === efSource)) {
      for (let m = 0; m < 12; m++) {
        const day = Math.min(ef.contributionDay || 1, daysInMonth(year, m));
        out.push({
          date: new Date(year, m, day),
          description: "Emergency Fund contribution",
          amount: accountName === ef.accountName ? ef.monthlyContribution : -ef.monthlyContribution,
          kind: "plan", sourceId: null, sourceType: "plan",
        });
      }
    }

    getAutopayOccurrencesForYear(data, year, true).filter(occ => occ.account === accountName).forEach(occ => {
      out.push({ date: occ.date, description: occ.payee, amount: -occ.amount, kind: "autopay", sourceId: null, sourceType: "autopay" });
    });
    // The card's own register sees the same autopay as an incoming credit.
    getAutopayOccurrencesForYear(data, year, true).filter(occ => occ.to === accountName).forEach(occ => {
      out.push({ date: occ.date, description: "Autopay from " + occ.account, amount: occ.amount, kind: "payment", sourceId: null, sourceType: "autopay" });
    });
  });

  // Apply one-time overrides (edited via "just this occurrence") — matched
  // against the ORIGINAL date/amount/description so the override is found
  // regardless of what it's being changed to.
  const overrides = data.occurrenceOverrides || [];
  if (overrides.length) {
    const overrideMap = new Map(overrides.map(ov => [ov.key, ov]));
    for (let i = 0; i < out.length; i++) {
      const key = skipKey(accountName, out[i]);
      const ov = overrideMap.get(key);
      if (ov) {
        out[i] = {
          ...out[i],
          date: ov.newDate ? new Date(ov.newDate + "T00:00:00") : out[i].date,
          amount: ov.newAmount != null ? (out[i].amount < 0 ? -Math.abs(ov.newAmount) : Math.abs(ov.newAmount)) : out[i].amount,
          description: ov.newDescription || out[i].description,
          overrideKey: key,
        };
      }
    }
  }
  return out.filter(o => o.date >= fromDate && o.date <= toDate).sort((a, b) => a.date - b.date);
}

// For interest-earning accounts: walks month by month applying interest on
// the running balance, correctly compounding on top of whatever the
// account's own scheduled contributions/fees do to that balance along the
// way (matters for accounts like Ryker CalAble with real monthly activity).
function getScheduledOccurrencesWithInterest(data, accountName, fromDate, toDate) {
  const base = getScheduledOccurrences(data, accountName, fromDate, toDate);
  const acct = (data.accounts || []).find(a => a.name === accountName);
  if (!acct || !acct.interestRate) return base;

  const monthlyRate = acct.interestRate / 12;
  let balance = currentAccountBalance(data, accountName, acct.startingBalance);
  const interestOccs = [];
  let cursor = new Date(fromDate);
  let idx = 0;

  while (cursor <= toDate) {
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const applyDate = monthEnd < toDate ? monthEnd : toDate;
    while (idx < base.length && base[idx].date <= applyDate) { balance += base[idx].amount; idx++; }
    const interest = Math.round(balance * monthlyRate * 100) / 100;
    if (interest !== 0) {
      interestOccs.push({ date: applyDate, description: accountName + " interest", amount: interest, kind: "interest" });
      balance += interest;
    }
    cursor = new Date(monthEnd.getTime() + 86400000);
  }

  return [...base, ...interestOccs].sort((a, b) => a.date - b.date);
}

/* ============================== SHARED UI BITS ============================== */

function Chip({ children, color }) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap shrink-0"
      style={{ background: (color || "#6b6459") + "1c", color: color || "#6b6459" }}
    >
      {children}
    </span>
  );
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="label-sm font-medium text-stone-600">{label}</span>
      {children}
    </label>
  );
}

function AccountSelect({ accounts, value, onChange }) {
  const knownNames = accounts.map(a => a.name);
  const hasUnknownValue = value && !knownNames.includes(value);
  return (
    <select className={inputCls} value={value || ""} onChange={e => onChange(e.target.value)}>
      <option value="" disabled>Select an account…</option>
      {hasUnknownValue && <option value={value}>{value} (not in Accounts)</option>}
      {accounts.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
    </select>
  );
}

const inputCls = "border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white input-focus";

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 bg-stone-900/40 flex items-center justify-center z-50 p-4" onMouseDown={onClose}>
      <div
        className={"bg-modal rounded-2xl shadow-xl w-full modal-maxh overflow-y-auto " + (wide ? "max-w-2xl" : "max-w-md")}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-200 sticky top-0 bg-modal">
          <h3 className="font-serif text-lg text-stone-800">{title}</h3>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/* ============================== BILL / INCOME / TRANSFER FORM ============================== */

function RecurrenceFields({ form, setForm }) {
  const refYear = new Date().getFullYear();

  function setQuarterly(day, startMonth) {
    const d = Math.max(1, Math.min(31, parseInt(day, 10) || 1));
    const sm = parseInt(startMonth, 10) || 0;
    const dates = [0, 1, 2, 3].map(i => `${((sm + i * 3) % 12) + 1}/${d}`);
    setForm({ ...form, quarterlyDay: d, quarterlyStartMonth: sm, dates });
  }

  function updateCustomRow(idx, patch) {
    const rows = customRows(form.dates);
    rows[idx] = { ...rows[idx], ...patch };
    setForm({ ...form, dates: rows.map(rowToDateString) });
  }
  function addCustomRow() {
    const rows = customRows(form.dates);
    rows.push({ date: "", amount: "" });
    setForm({ ...form, dates: rows.map(rowToDateString) });
  }
  function removeCustomRow(idx) {
    const rows = customRows(form.dates).filter((_, i) => i !== idx);
    setForm({ ...form, dates: rows.map(rowToDateString) });
  }

  return (
    <>
      <Field label="How often does this happen?">
        <select className={inputCls} value={form.frequency} onChange={e => setForm({ ...form, frequency: e.target.value })}>
          <option value="monthly">Every month</option>
          <option value="biweekly">Every 2 weeks</option>
          <option value="quarterly">Quarterly (every 3 months, same day)</option>
          <option value="custom">A few times a year (custom dates)</option>
          <option value="yearly">Once a year</option>
          <option value="multiyear">Every few years (e.g. a 2-year membership)</option>
          <option value="once">One time only</option>
        </select>
      </Field>
      {form.frequency === "monthly" && (
        <Field label="Day of month it's due">
          <input type="number" min={1} max={31} className={inputCls}
            value={form.dayOfMonth || ""} onChange={e => setForm({ ...form, dayOfMonth: e.target.value })} />
        </Field>
      )}
      {form.frequency === "biweekly" && (
        <Field label="Any one actual payment date — the rest follow every 14 days from there">
          <input type="date" className={inputCls}
            value={toISOInput(form.anchorDate, refYear)}
            onChange={e => setForm({ ...form, anchorDate: e.target.value })} />
        </Field>
      )}
      {form.frequency === "quarterly" && (
        <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Day of month it's due">
            <input type="number" min={1} max={31} className={inputCls}
              value={form.quarterlyDay || ""} onChange={e => setQuarterly(e.target.value, form.quarterlyStartMonth || 0)} />
          </Field>
          <Field label="First payment month">
            <select className={inputCls} value={form.quarterlyStartMonth || 0}
              onChange={e => setQuarterly(form.quarterlyDay || 1, e.target.value)}>
              {MONTH_NAMES.map((m, i) => <option key={m} value={i}>{m}</option>)}
            </select>
          </Field>
          <p className="sm:col-span-2 text-xs text-stone-400 -mt-2">
            Repeats every 3 months from there: {(form.dates || []).join(", ") || "—"}
          </p>
        </div>
      )}
      {form.frequency === "custom" && (
        <div className="sm:col-span-2 space-y-2">
          <span className="label-sm font-medium text-stone-600">Due dates</span>
          {customRows(form.dates).map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <input type="date" className={inputCls + " flex-1"}
                value={toISOInput(row.date, refYear)}
                onChange={e => updateCustomRow(i, { date: e.target.value })} />
              <input className={inputCls + " w-28"} placeholder="amount (optional)"
                value={row.amount} onChange={e => updateCustomRow(i, { amount: e.target.value })} />
              <button type="button" onClick={() => removeCustomRow(i)} className="text-stone-300 hover-text-danger shrink-0"><X size={16} /></button>
            </div>
          ))}
          <button type="button" onClick={addCustomRow} className="text-sm text-brand underline flex items-center gap-1">
            <Plus size={14} /> Add a date
          </button>
          <p className="text-xs text-stone-400">Leave amount blank to use the bill's amount above for that date.</p>
        </div>
      )}
      {(form.frequency === "yearly" || form.frequency === "once") && (
        <Field label={form.frequency === "once" ? "Date" : "Date it recurs each year"}>
          <input type="date" className={inputCls}
            value={toISOInput(form.date, refYear)}
            onChange={e => setForm({ ...form, date: e.target.value })} />
        </Field>
      )}
      {form.frequency === "multiyear" && (
        <>
          <Field label="Next (or most recent) date it's due">
            <input type="date" className={inputCls}
              value={toISOInput(form.date, refYear)}
              onChange={e => setForm({ ...form, date: e.target.value })} />
          </Field>
          <Field label="Every how many years?">
            <input type="number" min={2} max={20} className={inputCls}
              value={form.yearInterval || 2} onChange={e => setForm({ ...form, yearInterval: e.target.value })} />
          </Field>
          <p className="sm:col-span-2 text-xs text-stone-400 -mt-2">
            Shows up in Upcoming/Scheduled and the Savings Plan only on the real due year, same as a yearly bill would. The Budget tab always shows the smoothed monthly average ({fmtMoney((parseMoney(form.amount) || 0) / (Math.max(2, parseInt(form.yearInterval, 10) || 2) * 12))}/mo) for a clearer sense of true ongoing cost, even though the actual charge only lands every {form.yearInterval || 2} years.
          </p>
        </>
      )}
    </>
  );
}

function BillForm({ initial, accounts, categories, onSave, onCancel }) {
  const [form, setForm] = useState(initial || {
    payee: "", account: accounts[0]?.name || "", amount: "", category: "",
    frequency: "monthly", dayOfMonth: 1, dates: [], date: "", active: true, notes: "",
  });
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label="Payee / bill name">
        <input className={inputCls} value={form.payee} onChange={e => setForm({ ...form, payee: e.target.value })} autoFocus />
      </Field>
      <Field label="Amount">
        <input className={inputCls} placeholder="0.00" value={form.amount}
          onChange={e => setForm({ ...form, amount: e.target.value })} />
      </Field>
      <Field label="Paid from account">
        <AccountSelect accounts={accounts} value={form.account} onChange={v => setForm({ ...form, account: v })} />
      </Field>
      <Field label="Pays down (optional — if this payment reduces a card or loan balance)">
        <select className={inputCls} value={form.paysDownAccount || ""} onChange={e => setForm({ ...form, paysDownAccount: e.target.value })}>
          <option value="">Not a card/loan payment</option>
          {accounts.filter(a => a.isCreditCard || a.isLoan).map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
        </select>
      </Field>
      <label className="sm:col-span-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!form.essential} onChange={e => setForm({ ...form, essential: e.target.checked })} />
        Essential living expense (counts toward your Emergency Fund target)
      </label>
      <label className="sm:col-span-2 flex items-center gap-2 text-sm -mt-2">
        <input type="checkbox" checked={!!form.isBudgetLine} onChange={e => setForm({ ...form, isBudgetLine: e.target.checked })} />
        Budget line / placeholder — an envelope that real transactions spend down each cycle
      </label>
      {form.isBudgetLine && (
        <label className="sm:col-span-2 flex items-center gap-2 text-sm -mt-2 pl-6">
          <input type="checkbox" checked={!!form.envelopeAutoAll} onChange={e => setForm({ ...form, envelopeAutoAll: e.target.checked })} />
          Automatically count every charge on this account (no manual assigning — for whole-card placeholders)
        </label>
      )}
      <Field label="Funded by (optional — if this is really Savings' expense, not Checking's)">
        <select className={inputCls} value={form.fundedBy || ""} onChange={e => setForm({ ...form, fundedBy: e.target.value })}>
          <option value="">Same as paid-from account</option>
          {accounts.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
        </select>
      </Field>
      <Field label="Category">
        <input className={inputCls} list="category-list" value={form.category}
          onChange={e => setForm({ ...form, category: e.target.value })} />
        <datalist id="category-list">{categories.map(c => <option key={c} value={c} />)}</datalist>
      </Field>
      <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <RecurrenceFields form={form} setForm={setForm} />
      </div>
      <Field label="Notes (optional)">
        <input className={inputCls} value={form.notes || ""} onChange={e => setForm({ ...form, notes: e.target.value })} />
      </Field>
      <label className="flex items-center gap-2 text-sm mt-6">
        <input type="checkbox" checked={form.active !== false} onChange={e => setForm({ ...form, active: e.target.checked })} />
        Active (uncheck to pause without deleting)
      </label>
      <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
        <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
        <button
          onClick={() => onSave({ ...form, amount: parseMoney(form.amount), dates: (form.dates || []).filter(Boolean), id: form.id || uid() })}
          className="px-4 py-2 rounded-lg text-sm btn-brand flex items-center gap-1.5"
        ><Check size={15} /> Save bill</button>
      </div>
    </div>
  );
}

function IncomeForm({ initial, accounts, onSave, onCancel }) {
  const [form, setForm] = useState(initial || {
    payee: "", account: accounts[0]?.name || "", amount: "", frequency: "monthly",
    dayOfMonth: 1, dates: [], date: "", active: true,
  });
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label="Source name">
        <input className={inputCls} value={form.payee} onChange={e => setForm({ ...form, payee: e.target.value })} autoFocus />
      </Field>
      <Field label="Amount">
        <input className={inputCls} value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
      </Field>
      <Field label="Deposited to account">
        <AccountSelect accounts={accounts} value={form.account} onChange={v => setForm({ ...form, account: v })} />
      </Field>
      <div />
      <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <RecurrenceFields form={form} setForm={setForm} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.active !== false} onChange={e => setForm({ ...form, active: e.target.checked })} />
        Active
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!form.irregular} onChange={e => setForm({ ...form, irregular: e.target.checked })} />
        Irregular / bonus (timing &amp; amount vary — exclude from Savings Plan)
      </label>

      <Field label="Pay type">
        <select className={inputCls} value={form.payType || "salary"} onChange={e => setForm({ ...form, payType: e.target.value })}>
          <option value="salary">Salary / fixed</option>
          <option value="hourly">Hourly</option>
        </select>
      </Field>
      {form.payType === "hourly" && (
        <>
          <Field label="Hourly rate">
            <input className={inputCls} inputMode="decimal" placeholder="e.g. 18.75" value={form.hourlyRate ?? ""} onChange={e => setForm({ ...form, hourlyRate: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!form.otAvailable} onChange={e => setForm({ ...form, otAvailable: e.target.checked })} />
            Overtime is available for this job
          </label>
          {form.otAvailable && (
            <>
              <Field label="Overtime multiplier (1.5 = time-and-a-half)">
                <input className={inputCls} value={form.otMultiplier ?? 1.5} onChange={e => setForm({ ...form, otMultiplier: parseFloat(e.target.value) || 1.5 })} />
              </Field>
              <Field label="Take-home % of overtime pay (100 if nothing is withheld)">
                <input className={inputCls} value={form.takeHomePct ?? 100} onChange={e => setForm({ ...form, takeHomePct: parseFloat(e.target.value) || 100 })} />
              </Field>
            </>
          )}
        </>
      )}
      <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
        <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
        <button
          onClick={() => onSave({ ...form, amount: parseMoney(form.amount), hourlyRate: form.hourlyRate === "" || form.hourlyRate == null ? null : parseFloat(form.hourlyRate), dates: (form.dates || []).filter(Boolean), id: form.id || uid() })}
          className="px-4 py-2 rounded-lg text-sm btn-brand flex items-center gap-1.5"
        ><Check size={15} /> Save income</button>
      </div>
    </div>
  );
}

function TransferForm({ initial, accounts, onSave, onCancel }) {
  const [form, setForm] = useState(initial || {
    label: "", from: accounts[0]?.name || "", to: accounts[1]?.name || "", amount: "",
    isBalance: false, frequency: "monthly", dayOfMonth: 1, dates: [], date: "", active: true,
  });
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label="Label">
        <input className={inputCls} value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} autoFocus />
      </Field>
      <Field label="Amount">
        <input className={inputCls} disabled={form.isBalance} placeholder={form.isBalance ? "Pays full balance" : "0.00"}
          value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
      </Field>
      <Field label="From account">
        <AccountSelect accounts={accounts} value={form.from} onChange={v => setForm({ ...form, from: v })} />
      </Field>
      <Field label="To account">
        <AccountSelect accounts={accounts} value={form.to} onChange={v => setForm({ ...form, to: v })} />
      </Field>
      <Field label="Category">
        <select className={inputCls} value={form.category || "Other"} onChange={e => setForm({ ...form, category: e.target.value })}>
          <option value="Backfill">Backfill</option>
          <option value="Autopay">Autopay</option>
          <option value="Other">Other</option>
        </select>
      </Field>
      <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <RecurrenceFields form={form} setForm={setForm} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!form.isBalance} onChange={e => setForm({ ...form, isBalance: e.target.checked })} />
        Pays the full card balance (amount varies)
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.active !== false} onChange={e => setForm({ ...form, active: e.target.checked })} />
        Active
      </label>
      <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
        <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
        <button
          onClick={() => onSave({ ...form, amount: form.isBalance ? 0 : parseMoney(form.amount), dates: (form.dates || []).filter(Boolean), id: form.id || uid() })}
          className="px-4 py-2 rounded-lg text-sm btn-brand flex items-center gap-1.5"
        ><Check size={15} /> Save transfer</button>
      </div>
    </div>
  );
}

function AccountForm({ initial, accounts, onSave, onCancel }) {
  const [form, setForm] = useState(initial);
  const knownGroups = [...new Set(accounts.map(a => a.group).filter(Boolean))].sort();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label="Account name">
        <input className={inputCls} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} autoFocus />
      </Field>
      <Field label="Group (optional — organize the accounts list however you like)">
        <input className={inputCls} list="account-group-list" placeholder="e.g. Credit Cards, Kids' Accounts"
          value={form.group || ""} onChange={e => setForm({ ...form, group: e.target.value })} />
        <datalist id="account-group-list">{knownGroups.map(g => <option key={g} value={g} />)}</datalist>
      </Field>
      <label className="sm:col-span-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!form.isCreditCard} onChange={e => setForm({ ...form, isCreditCard: e.target.checked, isLoan: e.target.checked ? false : form.isLoan })} />
        This is a credit card
      </label>
      <label className="sm:col-span-2 flex items-center gap-2 text-sm -mt-2">
        <input type="checkbox" checked={!!form.isLoan} onChange={e => setForm({ ...form, isLoan: e.target.checked, isCreditCard: e.target.checked ? false : form.isCreditCard })} />
        This is a loan (mortgage, auto, etc. — not revolving credit)
      </label>

      {form.isCreditCard && (
        <>
          <label className="sm:col-span-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!form.autopay} onChange={e => setForm({ ...form, autopay: e.target.checked })} />
            Autopay the statement balance in full each month
          </label>
          <Field label="Statement closes on day">
            <input type="number" min={1} max={31} className={inputCls} value={form.statementCloseDay || ""}
              onChange={e => setForm({ ...form, statementCloseDay: parseInt(e.target.value, 10) || "" })} />
          </Field>
          <Field label="Payment due day (following month)">
            <input type="number" min={1} max={31} className={inputCls} value={form.paymentDueDay || ""}
              onChange={e => setForm({ ...form, paymentDueDay: parseInt(e.target.value, 10) || "" })} />
          </Field>
          <Field label="Autopay pulls from">
            <AccountSelect accounts={accounts} value={form.paymentAccount || ""} onChange={v => setForm({ ...form, paymentAccount: v })} />
          </Field>
          <p className="sm:col-span-2 text-xs text-stone-400">
            Everything charged to this card between the day after one close and the next close becomes the payment due on the due day of the following month.
          </p>
        </>
      )}

      {!form.isCreditCard && (
        <Field label="Annual Percentage Yield (APY %) — leave blank if this account doesn't earn interest">
          <input className={inputCls} placeholder="e.g. 2.5" value={form.interestRate ? (form.interestRate * 100) : ""}
            onChange={e => setForm({ ...form, interestRate: e.target.value === "" ? null : parseFloat(e.target.value) / 100 })} />
        </Field>
      )}

      <div className="sm:col-span-2 border-t border-stone-200 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label={form.isCreditCard ? "Alert if balance owed drops below" : "Alert if balance drops below"}>
          <input className={inputCls} placeholder="e.g. 500" value={form.lowBalanceThreshold ?? ""}
            onChange={e => setForm({ ...form, lowBalanceThreshold: e.target.value === "" ? null : parseMoney(e.target.value) })} />
        </Field>
        <Field label={form.isCreditCard ? "Alert if balance owed rises above" : "Alert if balance rises above"}>
          <input className={inputCls} placeholder="e.g. 5000" value={form.highBalanceThreshold ?? ""}
            onChange={e => setForm({ ...form, highBalanceThreshold: e.target.value === "" ? null : parseMoney(e.target.value) })} />
        </Field>
        <p className="sm:col-span-2 text-xs text-stone-400 -mt-2">
          {form.isCreditCard
            ? "Checks the balance currently tracked in Debt Payoff for this card."
            : "Checks both the current balance and what's projected over the next 30 days of scheduled activity."}
        </p>
      </div>

      <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
        <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
        <button
          onClick={() => onSave(form)}
          className="px-4 py-2 rounded-lg text-sm btn-brand flex items-center gap-1.5"
        ><Check size={15} /> Save account</button>
      </div>
    </div>
  );
}

function DebtForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState(initial || {
    creditor: "", balance: "", startDebt: "", rate: "", minPayment: "", extraPayment: "", order: 99, active: true,
    escrowMonthly: "", annualPropertyTax: "", annualHomeownersInsurance: "", promoRate: "", promoEndDate: "",
  });
  const [showEscrow, setShowEscrow] = useState(!!(initial && (initial.escrowMonthly || initial.annualPropertyTax || initial.annualHomeownersInsurance)));
  const [showPromo, setShowPromo] = useState(!!(initial && (initial.promoEndDate || initial.promoRate)));
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label="Creditor">
        <input className={inputCls} value={form.creditor} onChange={e => setForm({ ...form, creditor: e.target.value })} autoFocus />
      </Field>
      <Field label="Current balance">
        <input className={inputCls} value={form.balance} onChange={e => setForm({ ...form, balance: e.target.value })} />
      </Field>
      <Field label={showPromo ? "Rate after promo ends (APR %)" : "Interest rate (APR %)"}>
        <input className={inputCls} placeholder="e.g. 22.99" value={form.rate === "" ? "" : (Number(form.rate) * 100)}
          onChange={e => setForm({ ...form, rate: e.target.value === "" ? "" : parseFloat(e.target.value) / 100 })} />
      </Field>
      <Field label="Minimum payment (principal & interest only)">
        <input className={inputCls} value={form.minPayment} onChange={e => setForm({ ...form, minPayment: e.target.value })} />
      </Field>
      <Field label="Extra you're already paying each month">
        <input className={inputCls} placeholder="0.00" value={form.extraPayment}
          onChange={e => setForm({ ...form, extraPayment: e.target.value })} />
      </Field>
      <Field label="Custom order (used only for the 'Custom order' strategy)">
        <input type="number" className={inputCls} value={form.order} onChange={e => setForm({ ...form, order: parseInt(e.target.value, 10) || 99 })} />
      </Field>
      <p className="sm:col-span-2 text-xs text-stone-400 -mt-2">
        If you're currently sending more than the minimum to this account, put that amount here — it keeps flowing to this debt every month, separate from whatever the strategy above rolls in as extra.
      </p>

      <div className="sm:col-span-2">
        {!showPromo ? (
          <button type="button" onClick={() => setShowPromo(true)} className="text-sm text-brand underline">
            + This card has a temporary promotional rate (like 0% for a limited time)
          </button>
        ) : (
          <div className="border border-stone-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Promotional APR (%) — usually 0">
              <input className={inputCls} placeholder="0" value={form.promoRate === "" || form.promoRate == null ? "" : (Number(form.promoRate) * 100)}
                onChange={e => setForm({ ...form, promoRate: e.target.value === "" ? "" : parseFloat(e.target.value) / 100 })} />
            </Field>
            <Field label="Promo rate ends on">
              <input type="date" className={inputCls} value={form.promoEndDate || ""} onChange={e => setForm({ ...form, promoEndDate: e.target.value })} />
            </Field>
            <p className="sm:col-span-2 text-xs text-stone-400 -mt-2">
              Interest is calculated at the promotional rate through this date, then automatically switches to the regular APR above — no need to remember to update it yourself.
            </p>
          </div>
        )}
      </div>

      <div className="sm:col-span-2">
        {!showEscrow ? (
          <button type="button" onClick={() => setShowEscrow(true)} className="text-sm text-brand underline">
            + This is a mortgage — track escrow (taxes &amp; insurance) separately
          </button>
        ) : (
          <div className="border border-stone-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field label="Monthly escrow payment">
              <input className={inputCls} placeholder="0.00" value={form.escrowMonthly}
                onChange={e => setForm({ ...form, escrowMonthly: e.target.value })} />
            </Field>
            <Field label="Annual property tax">
              <input className={inputCls} placeholder="0.00" value={form.annualPropertyTax}
                onChange={e => setForm({ ...form, annualPropertyTax: e.target.value })} />
            </Field>
            <Field label="Annual homeowners insurance">
              <input className={inputCls} placeholder="0.00" value={form.annualHomeownersInsurance}
                onChange={e => setForm({ ...form, annualHomeownersInsurance: e.target.value })} />
            </Field>
            <p className="sm:col-span-3 text-xs text-stone-400 -mt-2">
              The minimum payment above should be principal &amp; interest only — escrow is tracked and shown separately so it doesn't affect how fast the loan balance goes down.
            </p>
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.active !== false} onChange={e => setForm({ ...form, active: e.target.checked })} />
        Active (uncheck once paid off to keep the history without it affecting the plan)
      </label>
      <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
        <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
        <button
          onClick={() => onSave({
            ...form, id: form.id || uid(),
            balance: parseMoney(form.balance), startDebt: parseMoney(form.startDebt || form.balance),
            rate: Number(form.rate) || 0, minPayment: parseMoney(form.minPayment), extraPayment: parseMoney(form.extraPayment),
            escrowMonthly: showEscrow ? parseMoney(form.escrowMonthly) : 0,
            annualPropertyTax: showEscrow ? parseMoney(form.annualPropertyTax) : 0,
            annualHomeownersInsurance: showEscrow ? parseMoney(form.annualHomeownersInsurance) : 0,
            promoRate: showPromo ? (Number(form.promoRate) || 0) : 0,
            promoEndDate: showPromo ? (form.promoEndDate || "") : "",
          })}
          className="px-4 py-2 rounded-lg text-sm btn-brand flex items-center gap-1.5"
        ><Check size={15} /> Save debt</button>
      </div>
    </div>
  );
}

function SnowballPaymentForm({ initial, debts, onSave, onCancel }) {
  const [form, setForm] = useState(initial || {
    amount: "", targetDebtId: debts[0]?.id || "", startDate: "", endDate: "",
  });
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label="Amount">
        <input className={inputCls} placeholder="0.00" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} autoFocus />
      </Field>
      <Field label="Goes to">
        <select className={inputCls} value={form.targetDebtId} onChange={e => setForm({ ...form, targetDebtId: e.target.value })}>
          {debts.map(d => <option key={d.id} value={d.id}>{d.creditor}</option>)}
        </select>
      </Field>
      <Field label="Starts (blank = always has)">
        <input type="date" className={inputCls} value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} />
      </Field>
      <Field label="Ends (blank = ongoing)">
        <input type="date" className={inputCls} value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} />
      </Field>
      <p className="sm:col-span-2 text-xs text-stone-400 -mt-2">
        Example: a $1,450 payment that goes to one card through July, then switches to another starting August — add two entries with matching start/end dates.
      </p>
      <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
        <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
        <button
          onClick={() => onSave({ ...form, id: form.id || uid(), amount: parseMoney(form.amount) })}
          className="px-4 py-2 rounded-lg text-sm btn-brand flex items-center gap-1.5"
        ><Check size={15} /> Save</button>
      </div>
    </div>
  );
}

function TransactionEditForm({ initial, accounts, data, onSave, onSaveTransfer, onSaveAdjustment, onConvertToTransfer, onCancel, onDelete }) {
  const isNew = !initial?.id;
  const inferredType = initial?.txnType || (initial ? (initial.amount < 0 ? "debit" : "credit") : "debit");
  const [txnType, setTxnType] = useState(inferredType);
  const [form, setForm] = useState({
    account: accounts[0]?.name || "", toAccount: accounts[1]?.name || accounts[0]?.name || "",
    date: new Date().toISOString().slice(0, 10), description: "", category: "", newBalance: "",
    ...initial,
    amount: initial ? Math.abs(initial.amount) : "",
  });

  const TYPE_TABS = isNew
    ? [["debit", "Debit"], ["credit", "Credit"], ["transfer", "Transfer"], ["adjustment", "Adjust balance"]]
    : [["debit", "Debit"], ["credit", "Credit"]];

  const currentBalance = form.account ? currentAccountBalance(data, form.account, accounts.find(a => a.name === form.account)?.startingBalance) : 0;
  const asOfBalance = form.account && form.date
    ? balanceAsOfDate(data, form.account, accounts.find(a => a.name === form.account)?.startingBalance, form.date)
    : 0;
  const adjustmentAmount = form.newBalance !== "" ? parseMoney(form.newBalance) - asOfBalance : null;

  return (
    <div className="space-y-4">
      {isNew && (
        <div className="flex gap-1.5 flex-wrap">
          {TYPE_TABS.map(([key, label]) => (
            <button key={key} onClick={() => setTxnType(key)}
              className={"px-3 py-1.5 rounded-full text-sm font-medium " + (txnType === key ? "btn-brand" : "border border-stone-300 text-stone-600 hover:bg-stone-50")}>
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {txnType === "transfer" ? (
          <>
            <Field label="From account">
              <AccountSelect accounts={accounts} value={form.account} onChange={v => setForm({ ...form, account: v })} />
            </Field>
            <Field label="To account">
              <AccountSelect accounts={accounts} value={form.toAccount} onChange={v => setForm({ ...form, toAccount: v })} />
            </Field>
            <Field label="Date">
              <input type="date" className={inputCls} value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
            </Field>
            <Field label="Amount">
              <input className={inputCls} placeholder="0.00" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} autoFocus />
            </Field>
            <Field label="Description (optional)">
              <input className={inputCls} value={form.description || ""} onChange={e => setForm({ ...form, description: e.target.value })} placeholder={`Transfer to ${form.toAccount}`} />
            </Field>
          </>
        ) : txnType === "adjustment" ? (
          <>
            <Field label="Account">
              <AccountSelect accounts={accounts} value={form.account} onChange={v => setForm({ ...form, account: v })} />
            </Field>
            <Field label="Date">
              <input type="date" className={inputCls} value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
            </Field>
            <Field label={`Register currently shows this account at ${fmtMoney(asOfBalance)} as of this date. What's the real balance?`}>
              <input className={inputCls} placeholder="0.00" value={form.newBalance} onChange={e => setForm({ ...form, newBalance: e.target.value })} autoFocus />
            </Field>
            {adjustmentAmount !== null && (
              <div className="flex items-end">
                <p className="text-sm text-stone-500">
                  This will add an adjustment of <strong className={adjustmentAmount < 0 ? "text-stone-700" : "text-brand"}>{fmtMoney(adjustmentAmount)}</strong> to reconcile.
                </p>
              </div>
            )}
          </>
        ) : (
          <>
            <Field label="Account">
              <AccountSelect accounts={accounts} value={form.account} onChange={v => setForm({ ...form, account: v })} />
            </Field>
            <Field label="Date">
              <input type="date" className={inputCls} value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} autoFocus={isNew} />
            </Field>
            <Field label={`Amount (${txnType === "debit" ? "money out" : "money in"})`}>
              <input className={inputCls} placeholder="0.00" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
            </Field>
            <Field label="Payee">
              <input className={inputCls} value={form.payee || ""} onChange={e => setForm({ ...form, payee: e.target.value })} placeholder="e.g. Ohio National" />
            </Field>
            <Field label="Description">
              <input className={inputCls} value={form.description || ""} onChange={e => setForm({ ...form, description: e.target.value })} />
            </Field>
            <Field label="Category (optional)">
              <input className={inputCls} list="txn-category-list" value={form.category || ""} onChange={e => setForm({ ...form, category: e.target.value })} />
              <datalist id="txn-category-list">
                {[...new Set([...(data.bills || []).map(b => b.category), ...(data.transactions || []).map(t => t.category)].filter(Boolean))].sort().map(c => <option key={c} value={c} />)}
              </datalist>
            </Field>
          </>
        )}
      </div>

      <div className="flex justify-between gap-2 pt-2">
        {!isNew ? (
          <button onClick={onDelete} className="px-4 py-2 rounded-lg text-sm text-danger hover:bg-stone-100 flex items-center gap-1.5"><Trash2 size={15} /> Delete</button>
        ) : <span />}
        <div className="flex gap-2">
          <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
          <button
            onClick={() => {
              if (txnType === "transfer") {
                // Editing an existing transaction and switching it to a transfer
                // converts it in place (reusing it as one leg + creating the
                // other) rather than spawning a brand-new pair and orphaning
                // the original. A genuinely new entry still creates a fresh pair.
                if (form.id && onConvertToTransfer) {
                  onConvertToTransfer(form.id, { from: form.account, to: form.toAccount, date: form.date, amount: parseMoney(form.amount), description: form.description, payee: form.payee });
                } else {
                  onSaveTransfer({ from: form.account, to: form.toAccount, date: form.date, amount: parseMoney(form.amount), description: form.description });
                }
              } else if (txnType === "adjustment") {
                onSaveAdjustment({ account: form.account, date: form.date, targetBalance: parseMoney(form.newBalance) });
              } else {
                const signedAmount = Math.abs(parseMoney(form.amount)) * (txnType === "debit" ? -1 : 1);
                onSave({
                  ...form, id: form.id || uid(), amount: signedAmount, txnType,
                  source: form.source || "manual", status: form.status || "pending", matchedBillId: form.matchedBillId ?? null,
                });
              }
            }}
            className="px-4 py-2 rounded-lg text-sm btn-brand flex items-center gap-1.5"
          ><Check size={15} /> Save</button>
        </div>
      </div>
    </div>
  );
}

const GIFT_OCCASIONS = ["Christmas", "Birthday", "Mother's Day", "Father's Day", "Anniversary", "Other"];

function GiftForm({ initial, accounts, knownOccasions, knownRecipients, onSave, onCancel }) {
  const occasionOptions = [...new Set([...GIFT_OCCASIONS.filter(o => o !== "Other"), ...(knownOccasions || [])])].concat("Other");
  const [form, setForm] = useState(() => {
    if (!initial) return { occasion: "Christmas", customOccasion: "", recipient: "", amount: "", date: "", account: "Checking", fundedBy: "Citi Savings", notes: "", active: true };
    const isKnown = occasionOptions.includes(initial.occasion);
    return { ...initial, occasion: isKnown ? initial.occasion : "Other", customOccasion: isKnown ? "" : (initial.occasion || "") };
  });
  const isOther = form.occasion === "Other";
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label="Occasion">
        <select className={inputCls} value={form.occasion} onChange={e => setForm({ ...form, occasion: e.target.value })}>
          {occasionOptions.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </Field>
      {isOther && (
        <Field label="Occasion name">
          <input className={inputCls} value={form.customOccasion} onChange={e => setForm({ ...form, customOccasion: e.target.value })} placeholder="e.g. Graduation" />
        </Field>
      )}
      <Field label="Recipient">
        <input className={inputCls} list="gift-recipient-list" value={form.recipient} onChange={e => setForm({ ...form, recipient: e.target.value })} autoFocus />
        <datalist id="gift-recipient-list">{(knownRecipients || []).map(r => <option key={r} value={r} />)}</datalist>
      </Field>
      <Field label="Gift amount">
        <input className={inputCls} placeholder="0.00" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
      </Field>
      <Field label="Date this year">
        <input type="date" className={inputCls} value={toISOInput(form.date, new Date().getFullYear())} onChange={e => setForm({ ...form, date: e.target.value })} />
      </Field>
      <Field label="Paid from account">
        <AccountSelect accounts={accounts} value={form.account} onChange={v => setForm({ ...form, account: v })} />
      </Field>
      <Field label="Funded by">
        <AccountSelect accounts={accounts} value={form.fundedBy} onChange={v => setForm({ ...form, fundedBy: v })} />
      </Field>
      <Field label="Notes (optional)">
        <input className={inputCls} value={form.notes || ""} onChange={e => setForm({ ...form, notes: e.target.value })} />
      </Field>
      <label className="flex items-center gap-2 text-sm mt-6">
        <input type="checkbox" checked={form.active !== false} onChange={e => setForm({ ...form, active: e.target.checked })} />
        Active (uncheck to pause without deleting — e.g. skipping a gift this year)
      </label>
      {form.occasion === "Birthday" && !form.id && (
        <label className="sm:col-span-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!form.alsoChristmas} onChange={e => setForm({ ...form, alsoChristmas: e.target.checked })} />
          Also plan a matching Christmas gift for {form.recipient || "this person"} (same amount, Dec 25)
        </label>
      )}
      <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
        <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
        <button
          onClick={() => {
            const occasionName = isOther ? (form.customOccasion || "Other") : form.occasion;
            const mkGift = (occ, date) => ({
              id: uid(),
              payee: `${form.recipient} — ${occ}`,
              account: form.account, fundedBy: form.fundedBy,
              amount: parseMoney(form.amount), category: occ,
              frequency: "yearly", date,
              isGift: true, occasion: occ, recipient: form.recipient,
              active: form.active !== false, notes: form.notes || "",
            });
            const main = { ...mkGift(occasionName, form.date), id: form.id || uid() };
            const out = form.alsoChristmas && occasionName === "Birthday"
              ? [main, mkGift("Christmas", `12/25/${new Date().getFullYear()}`)]
              : main;
            onSave(out);
          }}
          className="px-4 py-2 rounded-lg text-sm btn-brand flex items-center gap-1.5"
        ><Check size={15} /> Save gift</button>
      </div>
    </div>
  );
}

function WishlistItemForm({ initial, accounts, onSave, onCancel }) {
  const [form, setForm] = useState(initial || {
    name: "", amount: "", priority: 5, account: "Checking", fundedBy: "Citi Savings", targetDate: "", notes: "", active: false,
  });
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label="What is it?">
        <input className={inputCls} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. New roof" autoFocus />
      </Field>
      <Field label="Estimated cost">
        <input className={inputCls} placeholder="0.00" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
      </Field>
      <Field label="Priority">
        <select className={inputCls} value={Math.min(10, Math.max(1, form.priority || 5))} onChange={e => setForm({ ...form, priority: parseInt(e.target.value, 10) })}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
            <option key={n} value={n}>{n}{n === 1 ? " (highest)" : n === 10 ? " (lowest)" : ""}</option>
          ))}
        </select>
      </Field>
      <Field label="Notes (optional)">
        <input className={inputCls} value={form.notes || ""} onChange={e => setForm({ ...form, notes: e.target.value })} />
      </Field>

      <div className="sm:col-span-2 border-t border-stone-200 pt-4">
        <label className="flex items-center gap-2 text-sm mb-3">
          <input type="checkbox" checked={form.active === true} onChange={e => setForm({ ...form, active: e.target.checked })} />
          Add this to the Savings Plan now (it's a real, committed expense going forward)
        </label>
        {form.active && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Target date">
              <input type="date" className={inputCls} value={form.targetDate} onChange={e => setForm({ ...form, targetDate: e.target.value })} />
            </Field>
            <Field label="Paid from account">
              <AccountSelect accounts={accounts} value={form.account} onChange={v => setForm({ ...form, account: v })} />
            </Field>
            <Field label="Funded by">
              <AccountSelect accounts={accounts} value={form.fundedBy} onChange={v => setForm({ ...form, fundedBy: v })} />
            </Field>
            <p className="sm:col-span-2 text-xs text-stone-400">
              Once committed, this counts as a one-time expense on the target date above, the same as any other bill.
            </p>
          </div>
        )}
      </div>

      <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
        <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
        <button
          onClick={() => onSave({
            id: form.id || uid(),
            payee: form.name, account: form.account, fundedBy: form.fundedBy,
            amount: parseMoney(form.amount), category: "Wishlist",
            frequency: "once", date: form.targetDate || "",
            isWishlistItem: true, priority: form.priority, notes: form.notes || "",
            active: form.active === true,
          })}
          className="px-4 py-2 rounded-lg text-sm btn-brand flex items-center gap-1.5"
        ><Check size={15} /> Save</button>
      </div>
    </div>
  );
}

function EditOccurrenceForm({ occurrence, onSaveOneTime, onSaveFuture, onCancel }) {
  const o = occurrence;
  const [amount, setAmount] = useState(Math.abs(o.amount).toString());
  const [date, setDate] = useState(`${o.date.getFullYear()}-${String(o.date.getMonth() + 1).padStart(2, "0")}-${String(o.date.getDate()).padStart(2, "0")}`);
  const [description, setDescription] = useState(o.description);
  const [updateFuture, setUpdateFuture] = useState(false);
  const isAutopay = o.sourceType === "autopay";

  return (
    <div className="space-y-4">
      <Field label="Description">
        <input className={inputCls} value={description} onChange={e => setDescription(e.target.value)} autoFocus />
      </Field>
      <Field label="Amount">
        <input className={inputCls} value={amount} onChange={e => setAmount(e.target.value)} />
      </Field>
      <Field label="Date">
        <input type="date" className={inputCls} value={date} onChange={e => setDate(e.target.value)} disabled={updateFuture && isAutopay} />
      </Field>

      {isAutopay ? (
        <p className="text-xs text-stone-400">This is a computed card statement total, not a fixed recurring amount — changes here only apply to this one occurrence.</p>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={updateFuture} onChange={e => setUpdateFuture(e.target.checked)} />
            Also update all future occurrences
          </label>
          {updateFuture && (
            <p className="text-xs text-stone-400">
              The amount and description will update going forward. Date changes only take effect for simple monthly, yearly, or one-time bills — other schedules (biweekly, quarterly, custom dates) keep their existing dates.
            </p>
          )}
        </>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
        <button
          onClick={() => {
            const changes = { amount: parseMoney(amount), date, description };
            if (updateFuture && !isAutopay) onSaveFuture(changes);
            else onSaveOneTime(changes);
          }}
          className="px-4 py-2 rounded-lg text-sm btn-brand flex items-center gap-1.5"
        ><Check size={15} /> Save</button>
      </div>
    </div>
  );
}

/* ============================== FREQUENCY LABEL ============================== */

function freqLabel(item) {
  if (item.frequency === "monthly") return `Monthly (day ${item.dayOfMonth || 1})`;
  if (item.frequency === "biweekly") return `Every 2 weeks (from ${item.anchorDate || "—"})`;
  if (item.frequency === "quarterly") return `Quarterly (${(item.dates || []).join(", ") || "—"})`;
  if (item.frequency === "custom") {
    const n = (item.dates || []).length;
    return n > 4 ? `Custom dates (${n} payments/year)` : `Custom dates (${(item.dates || []).join(", ") || "—"})`;
  }
  if (item.frequency === "yearly") return `Yearly (${item.date || "—"})`;
  if (item.frequency === "multiyear") return `Every ${item.yearInterval || 2} years (${item.date || "—"})`;
  if (item.frequency === "once") return `One-time (${item.date || "—"})`;
  return item.frequency;
}

/* Groups bills into Monthly / Quarterly / Yearly / One-time sections, each
   sorted chronologically by due date (day-of-month, or month+day for the rest). */
function groupBillsByDueDate(bills) {
  const dueSortKey = (b) => {
    if (b.frequency === "monthly") return b.dayOfMonth || 1;
    if (b.frequency === "biweekly") {
      const pd = parseAnyDate(b.anchorDate);
      return pd ? pd.month * 31 + pd.day : 999;
    }
    if (b.frequency === "quarterly" || b.frequency === "custom") {
      const pd = parseAnyDate((b.dates || [])[0]);
      return pd ? pd.month * 31 + pd.day : 999;
    }
    const pd = parseAnyDate(b.date);
    return pd ? pd.month * 31 + pd.day : 999;
  };
  const sections = [
    { key: "monthly", label: "Monthly" },
    { key: "biweekly", label: "Every 2 weeks" },
    { key: "quarterly", label: "Quarterly" },
    { key: "custom", label: "Custom dates" },
    { key: "yearly", label: "Yearly" },
    { key: "once", label: "One-time" },
  ];
  return sections
    .map(s => ({ ...s, items: bills.filter(b => (b.frequency || "monthly") === s.key).sort((a, b) => dueSortKey(a) - dueSortKey(b)) }))
    .filter(s => s.items.length > 0);
}

/* ============================== MAIN APP ============================== */

function FamilyBudgetAppInner() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState("");
  const [tab, setTab] = useState("dashboard");
  const [openNavGroup, setOpenNavGroup] = useState(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth());
  const [modal, setModal] = useState(null); // {kind:'bill'|'income'|'transfer', item?}
  const [expandedDebtId, setExpandedDebtId] = useState(null);
  const [hideZeroBills, setHideZeroBills] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState(null); // {message, onConfirm}
  const [registerAccount, setRegisterAccount] = useState(null);
  const [registerMsg, setRegisterMsg] = useState("");
  const [registerLookaheadDays, setRegisterLookaheadDays] = useState(30);
  const [upcomingCollapsed, setUpcomingCollapsed] = useState(false);
  const [otGoalAmount, setOtGoalAmount] = useState("");
  const [otJobPayee, setOtJobPayee] = useState("");
  const [estJobPayee, setEstJobPayee] = useState("");
  const [estRegHours, setEstRegHours] = useState("");
  const [estOtHours, setEstOtHours] = useState("");
  const [reportSelected, setReportSelected] = useState([]);
  const [reportGroupBy, setReportGroupBy] = useState("account");
  const [reportMode, setReportMode] = useState("historical");
  const [reportExpandedMonth, setReportExpandedMonth] = useState(null);
  const [reportSaveName, setReportSaveName] = useState("");
  const [whatIfExtra, setWhatIfExtra] = useState(100);
  const [btDebtId, setBtDebtId] = useState("");
  const [btPromoRate, setBtPromoRate] = useState(0);
  const [btPromoMonths, setBtPromoMonths] = useState(12);
  const [btRegularRate, setBtRegularRate] = useState(20);
  const [btFeePercent, setBtFeePercent] = useState(3);
  const fileInputs = useRef({});

  useEffect(() => {
    (async () => {
      try {
        const [mainRes, txnRes] = await Promise.all([
          window.storage.get("budget-data"),
          window.storage.get("budget-transactions").catch(() => null),
        ]);
        const main = mainRes ? JSON.parse(mainRes.value) : emptyData();
        const transactions = txnRes ? JSON.parse(txnRes.value) : (main.transactions || []);
        setData({ ...main, transactions });
      } catch {
        setData(emptyData());
      }
      setLoading(false);
    })();
  }, []);

  // Transactions are saved under their own storage key, separate from
  // everything else — the Register can grow into thousands of entries after
  // a real CSV import, and giving it its own key means it gets its own
  // storage budget instead of competing with (and overflowing) the rest of
  // the app's much smaller data in a single combined save.
  const persist = useCallback(async (next) => {
    setData(next);
    // Split the save into two keys so the (large) transactions list doesn't
    // overflow a single storage entry. The load path (useEffect above) already
    // reads "budget-data" and "budget-transactions" separately and reassembles
    // them, so writing them split here is what actually completes that design.
    // Previously persist wrote EVERYTHING to "budget-data" in one blob; on
    // mobile that single ~674KB write exceeded the per-key limit and silently
    // failed all retries, which is why phone changes weren't persisting.
    const { transactions = [], ...rest } = next;
    const mainJson = JSON.stringify(rest);
    const txnJson = JSON.stringify(transactions);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Transactions first (the big one) — if it can't save, we surface the
        // error before claiming success, rather than saving the small half and
        // leaving the register silently stale.
        await window.storage.set("budget-transactions", txnJson, false);
        await window.storage.set("budget-data", mainJson, false);
        setSaveError("");
        return;
      } catch (e) {
        if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 400));
      }
    }
    setSaveError("Couldn't save your last change after a few tries — there may be a connection issue. Try again in a moment, or export a backup now to avoid losing anything.");
  }, []);

  // Hooks must run unconditionally on every render, so compute occurrences
  // against a safe fallback before we ever bail out for the loading state.
  const safeData = data || emptyData();
  const { bills: yearBills, income: yearIncome, transfers: yearTransfers, autopay: yearAutopay, all: yearAll } = useYearOccurrences(safeData, year);

  // Auto-backup: when enabled (standalone build only), export a backup file
  // automatically once the chosen interval has elapsed since the last one.
  // Runs after data settles rather than on a timer, so it never fires while
  // the person is mid-edit.
  useEffect(() => {
    if (!AUTO_BACKUP_READY || !data) return;
    const s = data.autoBackupSettings;
    if (!s || !s.enabled) return;
    const intervalMs = s.frequency === "daily" ? 86400000 : s.frequency === "monthly" ? 30 * 86400000 : 7 * 86400000;
    if (s.lastRun && Date.now() - s.lastRun < intervalMs) return;
    exportBackup();
    persist({ ...data, autoBackupSettings: { ...s, lastRun: Date.now() } });
  }, [data]);

  if (loading || !data) {
    return <div className="min-h-screen flex items-center justify-center bg-app text-stone-500 font-sans">Loading budget…</div>;
  }

  const accounts = data.accounts;
  const categories = [...new Set(data.bills.map(b => b.category).filter(Boolean))].sort();
  const giftOccasionsKnown = [...new Set(data.bills.filter(b => b.isGift).map(b => b.occasion).filter(Boolean))];
  const giftRecipientsKnown = [...new Set(data.bills.filter(b => b.isGift).map(b => b.recipient).filter(Boolean))].sort();
  const debts = data.debts || [];
  const debtSettings = data.debtSettings || { balanceDate: new Date().toISOString().slice(0, 10), monthlyPayment: 0, strategy: "snowball" };
  const snowballPayments = data.snowballPayments || [];
  const debtSim = simulateDebtPayoff(debts, debtSettings.monthlyPayment || 0, debtSettings.strategy || "snowball", debtSettings.balanceDate, snowballPayments);
  const netWorth = computeNetWorth(data, debtSim.schedule, 12);
  const balanceAlerts = checkBalanceAlerts(data, 30);
  const strategyComparison = ["snowball", "avalanche", "custom", "none"].map(s => ({
    strategy: s,
    result: simulateDebtPayoff(debts, debtSettings.monthlyPayment || 0, s, debtSettings.balanceDate, snowballPayments),
  }));
  const whatIfSim = simulateDebtPayoff(debts, (debtSettings.monthlyPayment || 0) + (whatIfExtra || 0), debtSettings.strategy || "snowball", debtSettings.balanceDate, snowballPayments);

  const btDebt = debts.find(d => d.id === btDebtId);
  const btFeeAmount = btDebt ? Math.round(btDebt.balance * (btFeePercent || 0) / 100 * 100) / 100 : 0;
  const btTransferredDebts = btDebt ? debts.map(d => d.id === btDebtId ? {
    ...d,
    balance: Math.round((d.balance + btFeeAmount) * 100) / 100,
    startDebt: Math.round((d.balance + btFeeAmount) * 100) / 100,
    rate: (btRegularRate || 0) / 100,
    promoRate: (btPromoRate || 0) / 100,
    promoEndDate: addMonthsToDateString(debtSettings.balanceDate, btPromoMonths || 0),
  } : d) : debts;
  const btKeepSim = debtSim;
  const btTransferSim = btDebt
    ? simulateDebtPayoff(btTransferredDebts, debtSettings.monthlyPayment || 0, debtSettings.strategy || "snowball", debtSettings.balanceDate, snowballPayments)
    : null;
  const savingsPlanSettings = data.savingsPlanSettings || emptyData().savingsPlanSettings;
  const savingsPlan = computeSavingsPlan(data, year);

  /* ---- CRUD helpers ---- */
  function upsert(listKey, itemOrItems) {
    const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
    let next = data[listKey] || [];
    items.forEach(item => {
      const exists = next.some(x => x.id === item.id);
      next = exists ? next.map(x => x.id === item.id ? item : x) : [...next, item];
    });
    persist({ ...data, [listKey]: next });
    setModal(null);
  }
  function remove(listKey, id) {
    persist({ ...data, [listKey]: (data[listKey] || []).filter(x => x.id !== id) });
  }
  // Opens a styled confirmation before actually removing an item, so a stray
  // tap on the trash icon (easy on mobile) can't silently delete a scheduled
  // bill/transfer/etc. The confirm modal calls remove() only on approval.
  function requestDelete(listKey, id, label) {
    setModal({ kind: "confirmDelete", item: { listKey, id, label } });
  }
  // Same confirmation, for register transactions (which delete via a different
  // path than the list-based remove()).
  function requestDeleteTransaction(id, label) {
    setModal({ kind: "confirmDelete", item: { transactionId: id, label } });
  }
  function updateDebtSettings(patch) {
    persist({ ...data, debtSettings: { ...debtSettings, ...patch } });
  }

  /* ---- Account register (CSV-imported transactions) ---- */
  function importTransactionsForAccount(accountName, rows) {
    const batchId = uid();
    const { merged, added, skipped } = mergeTransactions(data.transactions || [], rows, batchId);
    persist({ ...data, transactions: merged });
    setModal(null);
    setRegisterMsg(`Imported ${added} transaction${added === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} already-imported duplicate${skipped === 1 ? "" : "s"}` : ""}.`);
    setTimeout(() => setRegisterMsg(""), 5000);
  }
  function importTransactionsForMultipleAccounts(perAccountRows) {
    let merged = data.transactions || [];
    let totalAdded = 0, totalSkipped = 0;
    const perAccountSummary = [];
    Object.entries(perAccountRows).forEach(([accountName, rows]) => {
      const batchId = uid();
      const result = mergeTransactions(merged, rows, batchId);
      merged = result.merged;
      totalAdded += result.added;
      totalSkipped += result.skipped;
      perAccountSummary.push(`${accountName}: ${result.added}`);
    });
    persist({ ...data, transactions: merged });
    setModal(null);
    setRegisterMsg(`Imported ${totalAdded} transaction${totalAdded === 1 ? "" : "s"} across ${Object.keys(perAccountRows).length} account${Object.keys(perAccountRows).length === 1 ? "" : "s"} (${perAccountSummary.join(", ")})${totalSkipped ? `, skipped ${totalSkipped} duplicate${totalSkipped === 1 ? "" : "s"}` : ""}.`);
    setTimeout(() => setRegisterMsg(""), 7000);
  }
  function deleteTransaction(id) {
    persist({ ...data, transactions: (data.transactions || []).filter(t => t.id !== id) });
  }
  function addTransferTransaction({ from, to, date, amount, description }) {
    const pairId = uid();
    const label = description || `Transfer`;
    const outLeg = { id: uid(), account: from, date, amount: -Math.abs(amount), description: description || `Transfer to ${to}`, category: "Transfer", source: "manual", status: "pending", matchedBillId: null, txnType: "transfer", transferPairId: pairId };
    const inLeg = { id: uid(), account: to, date, amount: Math.abs(amount), description: description || `Transfer from ${from}`, category: "Transfer", source: "manual", status: "pending", matchedBillId: null, txnType: "transfer", transferPairId: pairId };
    persist({ ...data, transactions: [...(data.transactions || []), outLeg, inLeg] });
    setModal(null);
    setRegisterMsg(`Transferred ${fmtMoney(amount)} from ${from} to ${to}.`);
    setTimeout(() => setRegisterMsg(""), 5000);
  }
  // Convert an EXISTING transaction (e.g. an imported one-sided debit) into a
  // proper two-legged transfer, without losing the original. The existing
  // transaction becomes the "from" leg; a matching "to" leg is created and the
  // two are linked by transferPairId. If the original was already part of a
  // transfer pair, the previous partner leg is removed first so we don't leave
  // an orphan. `payee`/`description` edits made in the form are preserved.
  function convertToTransfer(existingId, { from, to, date, amount, description, payee }) {
    const existing = (data.transactions || []).find(t => t.id === existingId);
    if (!existing) { addTransferTransaction({ from, to, date, amount, description }); return; }
    const pairId = existing.transferPairId || uid();
    // Drop any stale partner from a prior pairing (but not the transaction itself).
    let txns = (data.transactions || []).filter(t =>
      !(t.transferPairId === existing.transferPairId && t.id !== existingId && existing.transferPairId)
    );
    const fromLeg = {
      ...existing, account: from, date, amount: -Math.abs(amount),
      description: description ?? existing.description, payee: payee ?? existing.payee,
      category: "Transfer", txnType: "transfer", transferPairId: pairId,
    };
    const toLeg = {
      id: uid(), account: to, date, amount: Math.abs(amount),
      description: description || `Transfer from ${from}`, payee: payee || existing.payee || "",
      category: "Transfer", source: existing.source || "manual", status: existing.status || "pending",
      matchedBillId: null, txnType: "transfer", transferPairId: pairId,
    };
    txns = txns.map(t => t.id === existingId ? fromLeg : t);
    if (!txns.some(t => t.id === existingId)) txns.push(fromLeg);
    txns.push(toLeg);
    persist({ ...data, transactions: txns });
    setModal(null);
    setRegisterMsg(`Converted to a transfer: ${fmtMoney(amount)} from ${from} to ${to}.`);
    setTimeout(() => setRegisterMsg(""), 5000);
  }
  function addBalanceAdjustment({ account, date, targetBalance }) {
    const acct = accounts.find(a => a.name === account);
    const before = balanceAsOfDate(data, account, acct?.startingBalance, date);
    const adjustment = Math.round((targetBalance - before) * 100) / 100;
    const txn = { id: uid(), account, date, amount: adjustment, description: "Balance adjustment", category: "Adjustment", source: "manual", status: "pending", matchedBillId: null, txnType: "adjustment" };
    persist({ ...data, transactions: [...(data.transactions || []), txn] });
    setModal(null);
    setRegisterMsg(`Added a ${fmtMoney(adjustment)} adjustment to reconcile ${account} to ${fmtMoney(targetBalance)}.`);
    setTimeout(() => setRegisterMsg(""), 5000);
  }
  function updateAccountStartingBalance(accountId, value) {
    persist({ ...data, accounts: accounts.map(a => a.id === accountId ? { ...a, startingBalance: parseMoney(value) } : a) });
  }
  function dismissDuplicateGroup(key) {
    persist({ ...data, dismissedDuplicateGroups: [...(data.dismissedDuplicateGroups || []), key] });
  }
  function skipOccurrence(key) {
    persist({ ...data, skippedOccurrences: [...(data.skippedOccurrences || []), key] });
  }
  function unskipOccurrence(key) {
    persist({ ...data, skippedOccurrences: (data.skippedOccurrences || []).filter(k => k !== key) });
  }
  function overrideOccurrence(key, changes) {
    const rest = (data.occurrenceOverrides || []).filter(ov => ov.key !== key);
    persist({ ...data, occurrenceOverrides: [...rest, { key, ...changes }] });
  }
  // For "also update future occurrences" — edits the underlying recurring
  // bill/income/transfer directly. Date edits only apply cleanly for simple
  // monthly/yearly/once frequencies; other frequencies (biweekly, quarterly,
  // custom) keep their existing schedule and only take the amount/description change.
  function updateSourceRecord(sourceType, sourceId, changes) {
    const listKey = sourceType === "bill" ? "bills" : sourceType === "income" ? "income" : "transfers";
    const list = data[listKey] || [];
    const next = list.map(item => {
      if (item.id !== sourceId) return item;
      const updated = { ...item };
      if (changes.amount != null) updated.amount = changes.amount;
      if (changes.description != null) {
        if (sourceType === "transfer") updated.label = changes.description;
        else updated.payee = changes.description;
      }
      if (changes.date) {
        if (item.frequency === "monthly") updated.dayOfMonth = parseInt(changes.date.split("-")[2], 10);
        else if (item.frequency === "yearly" || item.frequency === "once") updated.date = changes.date;
        // biweekly/quarterly/custom: date left alone, only amount/description apply
      }
      return updated;
    });
    persist({ ...data, [listKey]: next });
  }
  function setTransactionStatus(id, status) {
    persist({ ...data, transactions: (data.transactions || []).map(t => t.id === id ? { ...t, status } : t) });
  }
  function assignTransactionToBudget(id, billId) {
    persist({ ...data, transactions: (data.transactions || []).map(t => t.id === id ? { ...t, matchedBillId: billId } : t) });
  }
  function updateTransactionFlags(id, patch) {
    persist({ ...data, transactions: (data.transactions || []).map(t => t.id === id ? { ...t, ...patch } : t) });
  }
  function duplicateTransaction(t) {
    const copy = { ...t, id: uid(), description: t.description };
    persist({ ...data, transactions: [...(data.transactions || []), copy] });
    return copy;
  }

  function updateSavingsPlanSettings(patch) {
    persist({ ...data, savingsPlanSettings: { ...savingsPlanSettings, ...patch } });
  }
  function updateEmergencyFund(patch) {
    persist({ ...data, emergencyFund: { ...(data.emergencyFund || emptyData().emergencyFund), ...patch } });
  }
  function updatePayPeriod(id, patch) {
    const periods = savingsPlanSettings.payPeriods.map(p => p.id === id ? { ...p, ...patch } : p);
    updateSavingsPlanSettings({ payPeriods: periods });
  }
  function addPayPeriod() {
    const periods = [...savingsPlanSettings.payPeriods, { id: uid(), label: "New period", startDay: 1, endDay: 9 }];
    updateSavingsPlanSettings({ payPeriods: periods });
  }
  function removePayPeriod(id) {
    updateSavingsPlanSettings({ payPeriods: savingsPlanSettings.payPeriods.filter(p => p.id !== id) });
  }
  function addAccount(name, type) {
    if (!name.trim()) return;
    if (accounts.some(a => a.name.toLowerCase() === name.trim().toLowerCase())) return;
    persist({ ...data, accounts: [...accounts, { id: uid(), name: name.trim(), type: type || "other" }] });
  }
  function removeAccount(id) {
    persist({ ...data, accounts: accounts.filter(a => a.id !== id) });
  }
  function updateAccount(updated) {
    if (!updated.name || !updated.name.trim()) return;
    const exists = accounts.some(a => a.id === updated.id);
    persist({ ...data, accounts: exists ? accounts.map(a => a.id === updated.id ? updated : a) : [...accounts, updated] });
    setModal(null);
  }
  function resetAllData() {
    setConfirmDialog({
      message: "This clears every bill, income source, and transfer. There's no undo. Continue?",
      onConfirm: () => { persist(emptyData()); setConfirmDialog(null); },
    });
  }

  /* ---- Full backup export/import (moving everything, not just a CSV category) ---- */
  async function exportBackup() {
    const json = JSON.stringify(data, null, 2);
    const filename = "budget-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    const blob = new Blob([json], { type: "application/json" });

    // On iOS/mobile web views, a programmatic anchor-click download is
    // often silently ignored inside a sandboxed iframe. The native share
    // sheet (Save to Files, AirDrop, etc.) is much more reliable there.
    try {
      const file = new File([blob], filename, { type: "application/json" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (e) {
      // fall through to the download-link approach below
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function importBackup(file) {
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.bills)) {
        setImportMsg("That file doesn't look like a budget backup.");
        return;
      }
      setConfirmDialog({
        message: "This replaces everything currently in the app with the backup file. Continue?",
        onConfirm: async () => {
          try {
            await persist({ ...emptyData(), ...parsed });
            setImportMsg("Backup restored.");
          } catch (e) {
            setImportMsg("Something went wrong restoring that backup. Your previous data should be unaffected — try again, or reload the app.");
          } finally {
            setConfirmDialog(null);
            setTimeout(() => setImportMsg(""), 4000);
          }
        },
      });
    } catch {
      setImportMsg("Couldn't read that file — make sure it's a budget backup JSON.");
    }
  }

  /* ---- Import ---- */
  /* ---- Derived summaries ---- */
  const monthBills = yearBills.filter(b => b.date.getMonth() === month);
  const monthIncome = yearIncome.filter(i => i.date.getMonth() === month);
  const monthTransfers = yearTransfers.filter(t => t.date.getMonth() === month);
  const monthExpenseTotal = monthBills.reduce((s, b) => s + b.amount, 0);
  const monthIncomeTotal = monthIncome.reduce((s, i) => s + i.amount, 0);

  const today = new Date();
  const upcoming = yearAll
    .filter(x => x.kind !== "transfer" || true)
    .filter(x => {
      const diff = (x.date - stripTime(today)) / 86400000;
      return diff >= 0 && diff <= 14;
    })
    .sort((a, b) => a.date - b.date)
    .slice(0, 12);

  const monthlyChartData = MONTH_NAMES.map((name, i) => ({
    month: name.slice(0, 3),
    Income: yearIncome.filter(x => x.date.getMonth() === i).reduce((s, x) => s + x.amount, 0),
    Bills: yearBills.filter(x => x.date.getMonth() === i).reduce((s, x) => s + x.amount, 0),
  }));

  const categoryTotals = {};
  monthBills.forEach(b => { categoryTotals[b.category || "Uncategorized"] = (categoryTotals[b.category || "Uncategorized"] || 0) + b.amount; });
  const categoryPieData = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));

  const accountTotals = {};
  monthBills.forEach(b => { accountTotals[b.account] = (accountTotals[b.account] || 0) + b.amount; });

  // Per-account, whole-year breakdown — replaces the old separate "Charges" tabs
  const cardYearBreakdown = accounts.map(a => {
    const months = MONTH_NAMES.map((_, i) => yearBills.filter(b => b.account === a.name && b.date.getMonth() === i).reduce((s, b) => s + b.amount, 0));
    const total = months.reduce((s, m) => s + m, 0);
    return { name: a.name, months, total };
  }).filter(c => c.total > 0).sort((a, b) => b.total - a.total);

  const autopayCards = accounts.filter(a => a.isCreditCard && a.autopay && a.statementCloseDay && a.paymentDueDay);

  /* ---- Tabs config ---- */
  const TAB_META = {
    dashboard: { label: "Dashboard", icon: Home },
    register: { label: "Register", icon: Receipt },
    calendar: { label: "Scheduled", icon: Calendar },
    reports: { label: "Reports", icon: PieIcon },
    income: { label: "Income", icon: Wallet },
    savingsplan: { label: "Savings Plan", icon: PiggyBank },
    budget: { label: "Budget", icon: PieIcon },
    debts: { label: "Debt Payoff", icon: CreditCard },
    wishlist: { label: "Wishlist", icon: Star },
    accounts: { label: "Accounts", icon: Landmark },
    bills: { label: "Bills", icon: ListChecks },
    transfers: { label: "Transfers", icon: ArrowRightLeft },
    gifts: { label: "Gifts", icon: Gift },
    backup: { label: "Backup", icon: Upload },
  };
  const NAV_GROUPS = [
    { id: "track", label: "Track", tabs: ["register", "calendar", "reports"] },
    { id: "plan", label: "Plan", tabs: ["income", "savingsplan", "budget"] },
    { id: "goals", label: "Goals", tabs: ["debts", "wishlist"] },
    { id: "setup", label: "Setup", tabs: ["accounts", "bills", "transfers", "gifts", "backup"] },
  ];
  const activeGroup = NAV_GROUPS.find(g => g.tabs.includes(tab));

  return (
    <div className="min-h-screen bg-app font-sans text-stone-800">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap');
        .font-serif { font-family: 'Fraunces', serif; }
        .font-sans { font-family: 'Inter', sans-serif; }
        .bg-app { background: #f6f3ec; }
        .bg-header { background: #233b39; }
        .bg-modal { background: #fbf9f5; }
        .bg-callout { background: #fbf2df; }
        .bg-brand-tint { background: rgba(47,111,107,0.1); }
        .border-callout { border-color: #e8d9b5; }
        .text-header { color: #f6f3ec; }
        .text-header-sub { color: #9fc2bd; }
        .text-brand { color: #2f6f6b; }
        .text-callout { color: #b5793a; }
        .text-danger { color: #c15b4a; }
        .hover-text-danger:hover { color: #c15b4a; }
        .hover-text-brand:hover { color: #2f6f6b; }
        .border-brand { border-color: #2f6f6b; }
        .ring-brand { box-shadow: 0 0 0 2px #2f6f6b inset; }
        .btn-brand { background: #2f6f6b; color: #fff; }
        .btn-brand:hover { background: #255954; }
        .input-focus:focus { outline: none; box-shadow: 0 0 0 2px #2f6f6b; border-color: transparent; }
        .modal-maxh { max-height: 90vh; }
        .table-minw { min-width: 900px; }
        .label-sm { font-size: 13px; }
        .tabs-sticky { top: 60px; }
        @media (min-width: 640px) { .tabs-sticky { top: 68px; } }
      `}</style>

      {/* Header */}
      <header className="bg-header text-header px-5 py-4 sm:px-8 flex items-center justify-between sticky top-0 z-30 shadow-sm">
        <div>
          <h1 className="font-serif text-xl sm:text-2xl font-semibold tracking-tight">The Ledger</h1>
          <p className="text-header-sub text-xs -mt-0.5">One list of bills, everything else follows · <span className="opacity-70">{APP_VERSION}</span></p>
        </div>
        <div className="flex items-center gap-2 bg-white/10 rounded-full px-1">
          <button onClick={() => setYear(y => y - 1)} className="p-1.5 hover:bg-white/10 rounded-full"><ChevronLeft size={16} /></button>
          <span className="text-sm font-semibold tabular-nums w-12 text-center">{year}</span>
          <button onClick={() => setYear(y => y + 1)} className="p-1.5 hover:bg-white/10 rounded-full"><ChevronRight size={16} /></button>
        </div>
      </header>

      {saveError && (
        <div className="bg-callout border-b border-callout px-5 py-3 flex items-start gap-2">
          <AlertCircle size={16} className="text-callout shrink-0 mt-0.5" />
          <p className="text-sm text-stone-700 flex-1">{saveError}</p>
          <button onClick={() => setSaveError("")} className="text-stone-400 hover:text-stone-600 shrink-0"><X size={16} /></button>
        </div>
      )}

      {/* Tabs */}
      <nav className="flex gap-0.5 px-4 sm:px-8 pt-3 bg-app border-b border-stone-200 sticky tabs-sticky z-20">
        <button onClick={() => setTab("dashboard")}
          className={"flex items-center gap-1 px-3.5 py-3 text-sm font-medium rounded-t-lg whitespace-nowrap border-b-2 -mb-px transition-colors " +
            (tab === "dashboard" ? "border-brand text-brand" : "border-transparent text-stone-500 hover:text-stone-700")}>
          <Home size={17} /> <span className="hidden sm:inline">Dashboard</span>
        </button>
        {NAV_GROUPS.map((g, gi) => {
          const isOpen = openNavGroup === g.id;
          const isActive = activeGroup?.id === g.id;
          const alignRight = gi >= NAV_GROUPS.length - 2;
          return (
            <div key={g.id} className="relative">
              <button onClick={() => setOpenNavGroup(isOpen ? null : g.id)}
                className={"flex items-center gap-1 px-2 sm:px-3.5 py-2.5 text-sm font-medium rounded-t-lg whitespace-nowrap border-b-2 -mb-px transition-colors " +
                  (isActive ? "border-brand text-brand" : "border-transparent text-stone-500 hover:text-stone-700")}>
                {g.label}
                {isActive && <span className="text-xs text-stone-400 font-normal hidden sm:inline">· {TAB_META[tab].label}</span>}
                <ChevronDown size={14} className={"transition-transform " + (isOpen ? "rotate-180" : "")} />
              </button>
              {isOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setOpenNavGroup(null)} />
                  <div className={"absolute top-full mt-1 bg-white rounded-xl shadow-lg border border-stone-200 py-1.5 w-52 z-40 " + (alignRight ? "right-0" : "left-0")}>
                    {g.tabs.map(tid => {
                      const meta = TAB_META[tid];
                      const Icon = meta.icon;
                      return (
                        <button key={tid} onClick={() => { setTab(tid); setOpenNavGroup(null); }}
                          className={"w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-left whitespace-nowrap " +
                            (tab === tid ? "text-brand font-medium bg-brand-tint" : "text-stone-600 hover:bg-stone-50")}>
                          <Icon size={15} /> {meta.label}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </nav>

      <main className="px-4 sm:px-8 py-6 max-w-6xl mx-auto">

        {/* ============ DASHBOARD ============ */}
        {tab === "dashboard" && (
          <div className="space-y-6">
            {balanceAlerts.length > 0 && (
              <div className="bg-callout border border-callout rounded-2xl p-4 space-y-2">
                <p className="text-sm font-medium flex items-center gap-2"><AlertCircle size={16} className="text-callout" /> Balance alerts</p>
                {balanceAlerts.map((al, i) => (
                  <p key={i} className="text-sm text-stone-700">
                    <strong>{al.account}</strong> {al.type === "low" ? "drops below" : "rises above"} {fmtMoney(al.threshold)}
                    {al.projected ? ` around ${al.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : " right now"} — projected {fmtMoney(al.value)}.
                  </p>
                ))}
              </div>
            )}

            <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-serif text-lg">Net worth</h3>
                <span className={"font-serif text-2xl " + (netWorth.netWorthNow >= 0 ? "text-brand" : "text-danger")}>{fmtMoney(netWorth.netWorthNow)}</span>
              </div>
              <div className="flex items-center gap-4 text-xs text-stone-500 mb-3">
                <span>Assets: {fmtMoney(netWorth.assetsNow)}</span>
                <span>Debts: {fmtMoney(netWorth.debtsNow)}</span>
              </div>
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={netWorth.trend.map(t => ({ label: t.month.toLocaleDateString(undefined, { month: "short" }), netWorth: t.netWorth }))}>
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={1} axisLine={false} tickLine={false} />
                  <YAxis hide domain={["auto", "auto"]} />
                  <Tooltip formatter={v => fmtMoney(v)} />
                  <Line type="monotone" dataKey="netWorth" stroke="#2f6f6b" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
              <p className="text-xs text-stone-400 mt-1">Projected over the next 12 months, using scheduled account activity and your debt payoff plan.</p>
            </div>

            <div className="flex items-center gap-2">
              <button onClick={() => setMonth(m => (m + 11) % 12)} className="p-1.5 rounded-full hover:bg-stone-200"><ChevronLeft size={18} /></button>
              <h2 className="font-serif text-2xl">{MONTH_NAMES[month]} {year}</h2>
              <button onClick={() => setMonth(m => (m + 1) % 12)} className="p-1.5 rounded-full hover:bg-stone-200"><ChevronRight size={18} /></button>
              {(month !== new Date().getMonth() || year !== new Date().getFullYear()) && (
                <button onClick={() => { setMonth(new Date().getMonth()); setYear(new Date().getFullYear()); }}
                  className="text-xs text-brand underline ml-1">Today</button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
              <SummaryCard icon={TrendingUp} label="Income this month" value={fmtMoney(monthIncomeTotal)} tone="#2f6f6b" />
              <SummaryCard icon={TrendingDown} label="Bills this month" value={fmtMoney(monthExpenseTotal)} tone="#b5793a" />
              <SummaryCard icon={PiggyBank} label="Net" value={fmtMoney(monthIncomeTotal - monthExpenseTotal)} tone={monthIncomeTotal - monthExpenseTotal >= 0 ? "#2f6f6b" : "#c15b4a"} />
              {debtSim.perDebt.length > 0 && (
                <div className="grid grid-cols-2 gap-4 sm:col-span-2">
                  <SummaryCard icon={CreditCard} label={`Next payoff: ${debtSim.perDebt[0].creditor}`}
                    value={debtSim.perDebt[0].payoffDate.toLocaleDateString(undefined, { month: "short", year: "numeric" })} tone="#7a5c94" />
                  <SummaryCard icon={Check} label="Debt-free"
                    value={debtSim.debtFreeDate.toLocaleDateString(undefined, { month: "short", year: "numeric" })} tone="#2f6f6b" />
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
                <h3 className="font-serif text-lg mb-3">Due in the next 14 days</h3>
                {upcoming.length === 0 && <p className="text-sm text-stone-400">Nothing due soon.</p>}
                <ul className="divide-y divide-stone-100">
                  {upcoming.map((x, idx) => (
                    <li key={idx} className="py-2 flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className="text-stone-400 tabular-nums w-11">{x.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                        <span className="font-medium">{x.payee || x.label}</span>
                        {x.kind === "bill" && <Chip color={categoryColor(x.category)}>{x.category || "—"}</Chip>}
                        {x.kind === "transfer" && <Chip color="#4a6fa5">transfer</Chip>}
                        {x.kind === "autopay" && <Chip color="#7a5c94">autopay</Chip>}
                      </div>
                      <span className={"font-semibold tabular-nums " + (x.kind === "income" ? "text-brand" : "text-stone-700")}>
                        {x.kind === "income" ? "+" : ""}{fmtMoney(x.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {(() => {
                const today = stripTime(new Date());
                const end = new Date(today.getTime() + 365 * 86400000);
                const giftOccs = [];
                data.bills.filter(b => b.isGift && b.active !== false).forEach(b => {
                  [today.getFullYear(), end.getFullYear()].filter((y, i, a) => a.indexOf(y) === i).forEach(y => {
                    expandItemForYear(b, y, "bill").forEach(occ => {
                      if (occ.date >= today && occ.date <= end) giftOccs.push({ ...occ, occasion: b.occasion, recipient: b.recipient });
                    });
                  });
                });
                giftOccs.sort((a, b) => a.date - b.date);
                const nextGifts = giftOccs.slice(0, 3);
                if (nextGifts.length === 0) return null;
                return (
                  <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
                    <h3 className="font-serif text-lg mb-3">Upcoming gifts</h3>
                    <ul className="divide-y divide-stone-100">
                      {nextGifts.map((g, idx) => (
                        <li key={idx} className="py-2 flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-stone-400 tabular-nums w-11 shrink-0">{g.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                            <span className="font-medium truncate">{g.payee}</span>
                            {g.occasion && <Chip color="#a34d64">{g.occasion}</Chip>}
                          </div>
                          <span className="font-semibold tabular-nums text-stone-700 shrink-0">{fmtMoney(g.amount)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })()}

              {(() => {
                const bv = computeBudgetVsActual(data, accounts, year, month);
                if (!bv.isCurrentOrPastMonth || bv.actualTotal === 0) return null;
                const overBudget = bv.cats
                  .map(cc => {
                    const budgeted = bv.byCat[cc].reduce((s, b) => s + bv.monthlyOf(b), 0);
                    const actual = bv.actualForCat(cc);
                    return { cc, budgeted, actual, over: actual - budgeted };
                  })
                  .filter(x => x.over > 0)
                  .sort((a, b) => b.over - a.over)
                  .slice(0, 3);
                const pct = bv.grandTotal > 0 ? Math.min(100, (bv.actualTotal / bv.grandTotal) * 100) : 0;
                const overall = bv.grandTotal - bv.actualTotal;
                return (
                  <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
                    <div className="flex items-baseline justify-between mb-1">
                      <h3 className="font-serif text-lg">Budget health — {MONTH_NAMES[month]}</h3>
                      <button onClick={() => setTab("budget")} className="text-xs text-brand underline shrink-0">See full budget</button>
                    </div>
                    <div className="flex items-baseline justify-between mb-1 mt-2">
                      <span className="text-sm text-stone-600">{fmtMoney(bv.actualTotal)} spent of {fmtMoney(bv.grandTotal)}</span>
                      <span className={"text-sm font-medium " + (overall >= 0 ? "text-brand" : "text-danger")}>
                        {overall >= 0 ? fmtMoney(overall) + " left" : fmtMoney(-overall) + " over"}
                      </span>
                    </div>
                    <div className="h-2.5 rounded-full bg-stone-100 overflow-hidden mb-3">
                      <div className="h-full rounded-full" style={{ width: pct + "%", background: overall >= 0 ? "#2f6f6b" : "#c15b4a" }} />
                    </div>
                    {overBudget.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-stone-400 uppercase tracking-wide">Running over</p>
                        {overBudget.map(x => (
                          <div key={x.cc} className="flex items-center justify-between text-sm">
                            <span className="text-stone-600">{x.cc}</span>
                            <span className="text-danger tabular-nums">+{fmtMoney(x.over)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {overBudget.length === 0 && <p className="text-xs text-stone-400">Every category is within budget so far.</p>}
                  </div>
                );
              })()}

              {(() => {
                const pendingReimb = (data.transactions || []).filter(t => t.reimbursable && !t.reimbursed);
                if (pendingReimb.length === 0) return null;
                const total = pendingReimb.reduce((s, t) => s - t.amount, 0);
                const byAcct = {};
                pendingReimb.forEach(t => { byAcct[t.account] = (byAcct[t.account] || 0) - t.amount; });
                return (
                  <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
                    <div className="flex items-baseline justify-between mb-1">
                      <h3 className="font-serif text-lg">Awaiting business reimbursement</h3>
                      <span className="font-semibold tabular-nums">{fmtMoney(total)}</span>
                    </div>
                    <p className="text-sm text-stone-500">{pendingReimb.length} charge{pendingReimb.length > 1 ? "s" : ""} · {Object.entries(byAcct).map(([a, v]) => `${a}: ${fmtMoney(v)}`).join(" · ")}</p>
                  </div>
                );
              })()}

              {(() => {
                const efc = computeEmergencyFund(data, year);
                if (!efc.settings.accountName || efc.target <= 0) return null;
                const pct = Math.min(100, (efc.saved / efc.target) * 100);
                return (
                  <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
                    <div className="flex items-baseline justify-between mb-1">
                      <h3 className="font-serif text-lg">Emergency fund</h3>
                      <span className="text-sm text-stone-500">{Math.round(pct)}%</span>
                    </div>
                    <div className="h-3 rounded-full bg-stone-100 overflow-hidden mb-2">
                      <div className="h-full rounded-full" style={{ width: pct + "%", background: "#2f6f6b" }} />
                    </div>
                    <p className="text-sm text-stone-600">
                      {fmtMoney(efc.saved)} of {fmtMoney(efc.target)}
                      {efc.remaining > 0 && efc.fundedBy && <> · fully funded by {efc.fundedBy.toLocaleDateString(undefined, { month: "short", year: "numeric" })}</>}
                      {efc.remaining === 0 && <> · fully funded 🎉</>}
                    </p>
                  </div>
                );
              })()}

              <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
                <h3 className="font-serif text-lg mb-3">Spending by category — {MONTH_NAMES[month]}</h3>
                {categoryPieData.length === 0 ? <p className="text-sm text-stone-400">No bills categorized yet.</p> : (
                  <ResponsiveContainer width="100%" height={360}>
                    <PieChart>
                      <Pie data={categoryPieData} dataKey="value" nameKey="name" cy="32%" innerRadius={45} outerRadius={78} paddingAngle={1}>
                        {categoryPieData.map((c, i) => <Cell key={i} fill={categoryColor(c.name)} />)}
                      </Pie>
                      <Tooltip formatter={v => fmtMoney(v)} />
                      <Legend verticalAlign="bottom" wrapperStyle={{ fontSize: 11, lineHeight: "18px" }} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
              <h3 className="font-serif text-lg mb-3">Income vs. bills — {year}</h3>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={monthlyChartData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7e2d6" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} tickFormatter={v => "$" + (v / 1000).toFixed(0) + "k"} />
                  <Tooltip formatter={v => fmtMoney(v)} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Income" fill="#2f6f6b" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Bills" fill="#c9a45c" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
              <h3 className="font-serif text-lg mb-3">Charged to each account — {MONTH_NAMES[month]}</h3>
              {Object.keys(accountTotals).length === 0 ? <p className="text-sm text-stone-400">No bills this month.</p> : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {Object.entries(accountTotals).sort((a, b) => b[1] - a[1]).map(([acct, amt]) => (
                    <div key={acct} className="border border-stone-200 rounded-xl px-3 py-2.5">
                      <p className="text-xs text-stone-500 truncate">{acct}</p>
                      <p className="font-semibold tabular-nums">{fmtMoney(amt)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
              <h3 className="font-serif text-lg mb-1">Heaviest months — {year}</h3>
              <p className="text-xs text-stone-500 mb-3">Total bills per month, so nothing sneaks up on you.</p>
              {(() => {
                const values = monthlyChartData.map(m => m.Bills);
                const max = Math.max(...values, 1);
                const min = Math.min(...values);
                return (
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                    {monthlyChartData.map((m, i) => {
                      const intensity = max > min ? (m.Bills - min) / (max - min) : 0;
                      const bg = `rgba(193,91,74,${0.08 + intensity * 0.55})`;
                      return (
                        <button key={m.month} onClick={() => setMonth(i)}
                          className={"rounded-xl p-2.5 text-center transition-all min-w-0 " + (i === month ? "ring-brand" : "")}
                          style={{ background: bg }}>
                          <p className="text-xs font-medium text-stone-600">{m.month}</p>
                          <p className="text-sm font-semibold text-stone-800 tabular-nums">${Math.round(m.Bills).toLocaleString()}</p>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        )}


        {/* ============ REGISTER ============ */}
        {tab === "register" && (() => {
          const acct = accounts.find(a => a.name === registerAccount) || accounts[0];
          const rows = acct ? computeRegister(data.transactions || [], acct.name, acct.startingBalance) : [];
          const currentBalance = rows.length ? rows[0].runningBalance : (acct?.startingBalance || 0);

          const today = stripTime(new Date());
          // If real transaction history already covers today (or beyond),
          // start "Upcoming" the day after that instead of today itself —
          // otherwise a bill whose real payment was already imported shows
          // up a second time as a still-pending projection.
          const latestImportedDate = rows.length ? new Date(rows[0].date + "T00:00:00") : null;
          const upcomingStart = latestImportedDate && latestImportedDate >= today
            ? new Date(latestImportedDate.getTime() + 86400000)
            : today;
          const lookaheadEnd = new Date(upcomingStart.getTime() + registerLookaheadDays * 86400000);
          let runningScheduled = currentBalance;
          // A scheduled occurrence might already have a matching real
          // transaction (e.g. logged one-off via "Log as paid") even if it's
          // ahead of the bulk-import cutoff above. Real payment dates often
          // land a few days off from the "typical" scheduled day, so match
          // on amount + a small date window rather than an exact date.
          const loggedTxns = acct ? rows.map(t => ({ date: new Date(t.date + "T00:00:00"), amount: Math.abs(t.amount) })) : [];
          const hasMatchingRealTxn = o => loggedTxns.some(t =>
            Math.abs(t.amount - Math.abs(o.amount)) < 0.01 && Math.abs(t.date - o.date) <= 5 * 86400000
          );
          const skippedSet = new Set(data.skippedOccurrences || []);
          const allUpcomingRaw = acct ? getScheduledOccurrencesWithInterest(data, acct.name, upcomingStart, lookaheadEnd).filter(o => !hasMatchingRealTxn(o)) : [];
          const skippedInWindow = allUpcomingRaw.filter(o => skippedSet.has(skipKey(acct?.name, o)));
          // Compute running balance in true chronological order, then reverse
          // for display so "Upcoming" reads furthest-out → soonest, flowing
          // naturally into "History" (most recent → oldest) right below it.
          const scheduled = allUpcomingRaw
            .filter(o => !skippedSet.has(skipKey(acct?.name, o)))
            .map(o => {
              runningScheduled += o.amount;
              return { ...o, runningBalance: runningScheduled };
            }).reverse();
          const possibleDupes = acct ? findPossibleDuplicates(data.transactions || [], acct.name, data.dismissedDuplicateGroups) : [];

          return (
            <div className="space-y-4">
              <div>
                <h2 className="font-serif text-2xl">Account register</h2>
                <p className="text-sm text-stone-500">Imported from CSV exports — running balance per account. Plaid sync can slot in here later.</p>
              </div>

              <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200 grid grid-cols-1 sm:grid-cols-4 gap-4">
                <Field label="Account">
                  <select className={inputCls} value={acct?.name || ""} onChange={e => setRegisterAccount(e.target.value)}>
                    {accounts.map(a => {
                      const dupeCount = findPossibleDuplicates(data.transactions || [], a.name, data.dismissedDuplicateGroups).length;
                      return <option key={a.id} value={a.name}>{a.name}{dupeCount > 0 ? ` — ⚠ ${dupeCount} possible duplicate${dupeCount > 1 ? "s" : ""}` : ""}</option>;
                    })}
                  </select>
                </Field>
                <Field label="Starting balance (before earliest imported transaction)">
                  <input className={inputCls} value={acct?.startingBalance ?? ""} placeholder="0.00"
                    onChange={e => acct && updateAccountStartingBalance(acct.id, e.target.value)} />
                </Field>
                <div className="flex items-end">
                  <button onClick={() => setModal({ kind: "transaction", item: { account: acct?.name } })}
                    className="flex items-center gap-1.5 border border-stone-300 rounded-full px-4 py-2 text-sm font-medium w-full justify-center hover:bg-stone-50">
                    <Plus size={14} /> Add transaction
                  </button>
                </div>
                <div className="flex items-end">
                  <button onClick={() => setModal({ kind: "registerImport", item: { accountName: acct?.name } })}
                    className="flex items-center gap-1.5 btn-brand rounded-full px-4 py-2 text-sm font-medium w-full justify-center">
                    <Upload size={14} /> Import CSV
                  </button>
                </div>
              </div>

              <button onClick={() => setModal({ kind: "registerImportMulti" })} className="text-sm text-brand underline">
                Or import one combined CSV covering all your accounts at once
              </button>

              {registerMsg && (
                <div className="bg-brand-tint text-brand text-sm rounded-lg px-3 py-2 flex items-center gap-2"><Check size={14} /> {registerMsg}</div>
              )}

              {possibleDupes.length > 0 && (
                <details className="bg-callout border border-callout rounded-2xl p-4">
                  <summary className="cursor-pointer text-sm font-medium flex items-center gap-2">
                    <AlertCircle size={16} className="text-callout" />
                    {possibleDupes.length} possible duplicate {possibleDupes.length === 1 ? "pair" : "pairs"} — same date &amp; amount, different description
                  </summary>
                  <p className="text-xs text-stone-500 mt-2 mb-3">Usually means the same transaction got imported from two different sources. Delete whichever copy is wrong.</p>
                  <div className="space-y-3">
                    {possibleDupes.map((group) => (
                      <div key={group.key} className="bg-white rounded-xl border border-stone-200">
                        <div className="divide-y divide-stone-100">
                          {group.transactions.map(t => (
                            <div key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                              <span className="text-stone-400 w-20 shrink-0">{t.date}</span>
                              <span className="flex-1 min-w-0 truncate">{t.description || "—"}</span>
                              <span className="font-medium tabular-nums w-20 text-right shrink-0">{fmtMoney(t.amount)}</span>
                              <button onClick={() => requestDeleteTransaction(t.id, t.payee || t.description)} className="text-stone-300 hover-text-danger shrink-0"><Trash2 size={14} /></button>
                            </div>
                          ))}
                        </div>
                        <div className="px-3 py-2 border-t border-stone-100 flex justify-end">
                          <button onClick={() => dismissDuplicateGroup(group.key)} className="text-xs text-stone-400 hover-text-brand underline">
                            Not a duplicate — keep both
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              <SummaryCard icon={Landmark} label={`${acct?.name || "Account"} balance`} value={fmtMoney(currentBalance)} tone="#2f6f6b" />

              {(() => {
                const pendingReimb = (data.transactions || []).filter(t => t.account === acct?.name && t.reimbursable && !t.reimbursed);
                if (pendingReimb.length === 0) return null;
                const total = pendingReimb.reduce((s, t) => s - t.amount, 0);
                return (
                  <div className="bg-callout border border-callout rounded-2xl px-5 py-4">
                    <p className="text-sm font-medium text-stone-700">Awaiting business reimbursement: <b className="tabular-nums">{fmtMoney(total)}</b> across {pendingReimb.length} charge{pendingReimb.length > 1 ? "s" : ""}</p>
                    <p className="text-xs text-stone-500 mt-0.5">Marked reimbursable but not yet reimbursed — tap a charge and "Mark as reimbursed" when the money lands.</p>
                  </div>
                );
              })()}

              {scheduled.length > 0 && (() => {
                const chron = [...scheduled].reverse(); // scheduled is displayed newest-first; chart wants chronological
                const chartData = [
                  { day: "Today", balance: Math.round(currentBalance * 100) / 100 },
                  ...chron.map(o => ({
                    day: o.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
                    balance: Math.round(o.runningBalance * 100) / 100,
                  })),
                ];
                const low = acct?.lowBalanceThreshold;
                const minProjected = Math.min(...chartData.map(d => d.balance));
                return (
                  <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
                    <div className="flex items-baseline justify-between mb-1">
                      <h3 className="font-serif text-lg">Projected balance — next {registerLookaheadDays} days</h3>
                      <span className={"text-xs font-medium " + (low != null && minProjected < low ? "text-danger" : "text-stone-400")}>
                        low point: {fmtMoney(minProjected)}
                      </span>
                    </div>
                    {low != null && minProjected < low && (
                      <p className="text-xs text-danger mb-2">Dips below your {fmtMoney(low)} minimum in this window.</p>
                    )}
                    <div style={{ width: "100%", height: 190 }}>
                      <ResponsiveContainer>
                        <LineChart data={chartData} margin={{ top: 5, right: 8, left: 8, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#eee8dc" />
                          <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#9a958a" }} interval="preserveStartEnd" />
                          <YAxis tick={{ fontSize: 10, fill: "#9a958a" }} width={58} tickFormatter={v => "$" + Math.round(v).toLocaleString()} />
                          <Tooltip formatter={v => fmtMoney(v)} labelStyle={{ fontSize: 12 }} contentStyle={{ fontSize: 12, borderRadius: 10, border: "1px solid #e5dfd3" }} />
                          {low != null && <ReferenceLine y={low} stroke="#c15b4a" strokeDasharray="5 4" label={{ value: "minimum " + fmtMoney(low), position: "insideBottomRight", fontSize: 10, fill: "#c15b4a" }} />}
                          <Line type="stepAfter" dataKey="balance" stroke="#2f6f6b" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    {low == null && <p className="text-xs text-stone-400 mt-1">Tip: set a "low balance" alert threshold on this account (Accounts &amp; Import) to see your minimum line here.</p>}
                  </div>
                );
              })()}

              <div className="bg-white rounded-2xl shadow-sm border border-stone-200 overflow-hidden">
                <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-stone-100 gap-3">
                  <button onClick={() => setUpcomingCollapsed(v => !v)} className="flex items-center gap-1.5 shrink-0">
                    <ChevronDown size={16} className={"text-stone-400 transition-transform " + (upcomingCollapsed ? "-rotate-90" : "")} />
                    <h3 className="font-serif text-lg">Upcoming{upcomingCollapsed && scheduled.length > 0 ? ` (${scheduled.length})` : ""}</h3>
                  </button>
                  {!upcomingCollapsed && (
                    <label className="flex items-center gap-2 text-sm text-stone-500 shrink-0">
                      Next
                      <input type="number" min={1} max={365} className={inputCls + " w-20"} value={registerLookaheadDays}
                        onChange={e => setRegisterLookaheadDays(Math.max(1, parseInt(e.target.value, 10) || 30))} />
                      days
                    </label>
                  )}
                </div>
                {upcomingCollapsed ? null : scheduled.length === 0 ? (
                  <p className="p-5 text-sm text-stone-400">Nothing scheduled for {acct?.name || "this account"} in the next {registerLookaheadDays} days.</p>
                ) : scheduled.map((o, i) => (
                  <button key={i} onClick={() => setModal({ kind: "upcomingAction", item: { occurrence: o, accountName: acct?.name } })}
                    className="w-full text-left px-4 sm:px-5 py-2.5 text-sm border-t border-stone-50 first:border-t-0 bg-stone-50/50 hover:bg-stone-100 transition-colors">
                    <div className="flex items-center gap-2">
                      <span className="text-stone-400 tabular-nums w-14 shrink-0">{o.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                      <span className="flex-1 min-w-0 truncate text-stone-600">{o.description}</span>
                    </div>
                    <div className="flex items-center gap-2 pl-16 mt-0.5">
                      <Chip color={o.kind === "bill" ? "#4a6fa5" : o.kind === "income" ? "#2f6f6b" : o.kind === "autopay" ? "#7a5c94" : o.kind === "interest" ? "#c9a45c" : o.kind === "payment" ? "#2f6f6b" : o.kind === "plan" ? "#3f7cac" : "#b5793a"}>{o.kind}</Chip>
                      <span className="flex-1" />
                      <span className={"font-medium tabular-nums text-right shrink-0 " + (o.amount < 0 ? "text-stone-500" : "text-brand")}>
                        {o.amount < 0 ? "" : "+"}{fmtMoney(o.amount)}
                      </span>
                      <span className="text-stone-400 tabular-nums w-20 text-right shrink-0">{fmtMoney(o.runningBalance)}</span>
                    </div>
                  </button>
                ))}
              </div>

              {!upcomingCollapsed && skippedInWindow.length > 0 && (
                <details className="bg-white rounded-2xl border border-stone-200 px-4 sm:px-5 py-3">
                  <summary className="cursor-pointer text-sm text-stone-500">{skippedInWindow.length} skipped this period</summary>
                  <div className="mt-2 space-y-1.5">
                    {skippedInWindow.map((o, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <span className="text-stone-400 tabular-nums w-14 shrink-0">{o.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                        <span className="flex-1 min-w-0 truncate text-stone-500">{o.description}</span>
                        <span className="text-stone-400 tabular-nums shrink-0">{fmtMoney(o.amount)}</span>
                        <button onClick={() => unskipOccurrence(skipKey(acct?.name, o))} className="text-xs text-brand underline shrink-0">Unskip</button>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {(() => {
                const { pending, groups } = groupHistoryByStatement(rows, acct);
                const renderRow = t => (
                  <button key={t.id} onClick={() => setModal({ kind: "historyAction", item: { transaction: t, accountName: acct?.name } })}
                    className="w-full text-left px-4 sm:px-5 py-2.5 text-sm hover:bg-stone-50 transition-colors">
                    <div className="flex items-center gap-2">
                      <span className="text-stone-400 tabular-nums w-14 shrink-0">{new Date(t.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                      <span className="flex-1 min-w-0 truncate">{txnLabel(t)}</span>
                      {t.status === "pending" && <Chip color="#b5793a">pending</Chip>}
                    </div>
                    <div className="flex items-center gap-2 pl-16 mt-0.5">
                      {(() => {
                        // If a payee is shown above, surface the raw description
                        // here as a secondary hint (when it adds something beyond
                        // the payee). If there's no payee, the description is
                        // already the primary label, so don't repeat it.
                        const payee = (t.payee || "").replace(/\u00a0/g, " ").trim();
                        const desc = (t.description || "").replace(/\u00a0/g, " ").trim();
                        return payee && desc && desc.toLowerCase() !== payee.toLowerCase()
                          ? <Chip color="#9a958a">{desc}</Chip> : null;
                      })()}
                      {t.category && <Chip color={categoryColor(t.category)}>{shortCategoryLabel(t.category)}</Chip>}
                      {t.matchedBillId && (() => { const eb = data.bills.find(b => b.id === t.matchedBillId); return eb ? <Chip color="#2f6f6b">→ {eb.payee}</Chip> : null; })()}
                      {t.reimbursable && !t.reimbursed && <Chip color="#b5793a">awaiting reimbursement</Chip>}
                      {t.reimbursable && t.reimbursed && <Chip color="#9a958a">reimbursed</Chip>}
                      <span className="flex-1" />
                      <span className={"font-medium tabular-nums text-right shrink-0 " + (t.amount < 0 ? "text-stone-700" : "text-brand")}>
                        {t.amount < 0 ? "" : "+"}{fmtMoney(t.amount)}
                      </span>
                      <span className="text-stone-400 tabular-nums w-20 text-right shrink-0">{fmtMoney(t.runningBalance)}</span>
                    </div>
                  </button>
                );

                if (rows.length === 0) {
                  return (
                    <div className="bg-white rounded-2xl shadow-sm border border-stone-200 overflow-hidden">
                      <p className="text-xs font-medium text-stone-500 px-4 sm:px-5 py-2.5 bg-stone-50">History</p>
                      <p className="p-6 text-sm text-stone-400 text-center">No transactions imported for {acct?.name || "this account"} yet.</p>
                    </div>
                  );
                }

                return (
                  <>
                    {pending.length > 0 && (
                      <div className="bg-white rounded-2xl shadow-sm border border-callout divide-y divide-stone-100 overflow-hidden">
                        <p className="text-xs font-medium text-callout px-4 sm:px-5 py-2.5 bg-callout">Pending ({pending.length})</p>
                        {pending.map(renderRow)}
                      </div>
                    )}
                    {groups.map(g => (
                      <div key={g.label} className="bg-white rounded-2xl shadow-sm border border-stone-200 divide-y divide-stone-100 overflow-hidden">
                        <p className="text-xs font-medium text-stone-500 px-4 sm:px-5 py-2.5 bg-stone-50">{g.label}</p>
                        {g.items.map(renderRow)}
                      </div>
                    ))}
                  </>
                );
              })()}
            </div>
          );
        })()}

        {/* ============ BILLS ============ */}
        {tab === "bills" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-serif text-2xl">Master bill list</h2>
                <p className="text-sm text-stone-500">Edit a bill here and every dashboard, month, and total updates automatically.</p>
              </div>
              <button onClick={() => setModal({ kind: "bill" })} className="flex items-center gap-1.5 btn-brand rounded-full px-4 py-2 text-sm font-medium shrink-0">
                <Plus size={16} /> Add bill
              </button>
            </div>
            {data.bills.length === 0 && (
              <p className="p-6 text-sm text-stone-400 text-center bg-white rounded-2xl border border-stone-200">Nothing here yet. Tap "Add bill" to get started.</p>
            )}

            {groupBillsByDueDate(data.bills).map(section => (
              <div key={section.key}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-400 mb-2 px-1">{section.label} · {section.items.length}</h3>
                <div className="bg-white rounded-2xl shadow-sm border border-stone-200 divide-y divide-stone-100 overflow-hidden">
                  {section.items.map(b => (
                    <div key={b.id} className="px-4 sm:px-5 py-3 text-sm hover:bg-stone-50">
                      <div className="flex items-center gap-2">
                        {b.active === false && <Chip color="#9a958a">paused</Chip>}
                        <span className="font-medium flex-1 min-w-0 break-words">{b.payee}</span>
                        <span className="text-stone-400 text-xs shrink-0">{freqLabel(b)}</span>
                        <span className={"font-semibold tabular-nums shrink-0 " + (b.active === false ? "text-stone-400" : "")}>{fmtMoney(b.amount)}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <Chip color={categoryColor(b.category)}>{b.category || "Uncategorized"}</Chip>
                        <span className="text-stone-500 text-xs">{b.account}</span>
                        {b.fundedBy && b.fundedBy !== b.account && <Chip color="#7a5c94">funded by {b.fundedBy}</Chip>}
                        {b.paysDownAccount && <Chip color="#2f6f6b">pays down {b.paysDownAccount}</Chip>}
                        <span className="flex-1" />
                        <button onClick={() => setModal({ kind: "bill", item: b })} className="p-1.5 text-stone-400 hover-text-brand shrink-0"><Pencil size={15} /></button>
                        <button onClick={() => requestDelete("bills", b.id, b.payee)} className="p-1.5 text-stone-400 hover-text-danger shrink-0"><Trash2 size={15} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ============ BUDGET ============ */}
        {tab === "budget" && (
          <div>
            {(() => {
              const { cats, byCat, monthlyOf, grandTotal, left, actualForCat, spendByCat, isCurrentOrPastMonth, actualTotal } = computeBudgetVsActual(data, accounts, year, month);

              return (
                <div className="space-y-6">
                  <div>
                    <h2 className="font-serif text-2xl mb-1">Budget</h2>
                    <p className="text-sm text-stone-500">
                      {fmtMoney(grandTotal)}/mo budgeted
                      {isCurrentOrPastMonth && Object.keys(spendByCat).length > 0 && (
                        <> · {fmtMoney(actualTotal)} actual in {MONTH_NAMES[month]}</>
                      )}
                      {" · "}{left >= 0 ? fmtMoney(left) + " left over" : <span className="text-danger">{fmtMoney(-left)} over</span>}
                    </p>
                  </div>
                  <div className="bg-white rounded-2xl shadow-sm border border-stone-200 overflow-hidden">
                    <div className="p-4 sm:p-5 space-y-4">
                      {cats.map(cc => {
                        const items = byCat[cc].sort((a, b) => monthlyOf(b) - monthlyOf(a));
                        const subtotal = items.reduce((s, b) => s + monthlyOf(b), 0);
                        const pctOfIncome = monthlyIncome > 0 ? (subtotal / monthlyIncome) * 100 : 0;
                        const actual = actualForCat(cc);
                        const variance = subtotal - actual;
                        return (
                          <div key={cc}>
                            <div className="flex items-baseline justify-between mb-1 px-1">
                              <h4 className="text-xs font-semibold uppercase tracking-wide text-stone-400">{cc}</h4>
                              <span className="text-xs font-semibold text-stone-500">{fmtMoney(subtotal)}/mo · {pctOfIncome.toFixed(0)}%</span>
                            </div>
                            {isCurrentOrPastMonth && actual > 0 && (
                              <div className="flex items-center gap-2 mb-1.5 px-1">
                                <span className="text-xs text-stone-400">Actual in {MONTH_NAMES[month]}: <b className="text-stone-600">{fmtMoney(actual)}</b></span>
                                <span className={"text-xs font-medium " + (variance >= 0 ? "text-brand" : "text-danger")}>
                                  {variance >= 0 ? `${fmtMoney(variance)} under` : `${fmtMoney(-variance)} over`}
                                </span>
                              </div>
                            )}
                            <div className="border border-stone-100 rounded-xl divide-y divide-stone-50 overflow-hidden">
                              {items.map(b => {
                                const st = b.isBudgetLine ? envelopeStatus(data, b, new Date()) : null;
                                const usedPct = st ? Math.min(100, (st.spent / (b.amount || 1)) * 100) : 0;
                                const isMonthlyish = b.frequency === "monthly" || b.frequency === "biweekly";
                                return (
                                  <button key={b.id} onClick={() => setModal({ kind: "bill", item: b })} className="w-full text-left px-3 py-2.5 text-sm hover:bg-stone-50">
                                    <div className="flex items-center gap-2">
                                      <span className="font-medium flex-1 min-w-0 break-words">{b.payee}</span>
                                      <span className="font-semibold tabular-nums shrink-0">
                                        {fmtMoney(b.amount)}<span className="text-stone-400 font-normal text-xs">{b.frequency === "monthly" ? "/mo" : b.frequency === "yearly" ? "/yr" : ""}</span>
                                      </span>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2 mt-1">
                                      {b.essential && <Chip color="#8a7a3f">essential</Chip>}
                                      {b.isBudgetLine && <Chip color="#3f7cac">envelope</Chip>}
                                      <span className="text-stone-400 text-xs">{freqLabel(b)}</span>
                                      <span className="text-stone-400 text-xs">· {b.account}</span>
                                      <span className="flex-1" />
                                      {!isMonthlyish && <span className="text-stone-400 text-xs tabular-nums">≈ {fmtMoney(monthlyOf(b))}/mo</span>}
                                    </div>
                                    {st && st.spent > 0 && (
                                      <div className="mt-1.5">
                                        <div className="h-1.5 rounded-full bg-stone-100 overflow-hidden">
                                          <div className="h-full rounded-full" style={{ width: usedPct + "%", background: st.remaining < 0 ? "#c15b4a" : "#2f6f6b" }} />
                                        </div>
                                        <p className={"text-xs mt-0.5 " + (st.remaining < 0 ? "text-danger" : "text-stone-400")}>
                                          {fmtMoney(st.spent)} spent · {st.remaining < 0 ? fmtMoney(-st.remaining) + " over" : fmtMoney(st.remaining) + " left"} this cycle
                                        </p>
                                      </div>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })()}

          </div>
        )}

        {/* ============ REPORTS ============ */}
        {tab === "reports" && (() => {
          const groupNames = [...new Set(accounts.map(a => a.group).filter(Boolean))].sort();
          const ungrouped = accounts.filter(a => !a.group);
          const sections = [...groupNames.map(g => ({ label: g, items: accounts.filter(a => a.group === g) }))];
          if (ungrouped.length) sections.push({ label: groupNames.length ? "Ungrouped" : null, items: ungrouped });

          const toggleAccount = name => setReportSelected(sel => sel.includes(name) ? sel.filter(n => n !== name) : [...sel, name]);
          const saved = data.savedReportSelections || [];

          const hist = reportSelected.length ? computeHistoricalReport(data, reportSelected, year, reportGroupBy) : null;
          const expandedTxns = hist && reportExpandedMonth != null
            ? hist.rows.flatMap(r => r.months[reportExpandedMonth].transactions).sort((a, b) => a.date < b.date ? -1 : 1)
            : [];

          // Projected: combine each selected account's scheduled occurrences
          // into one running total, reusing the same engine as the
          // single-account Register chart.
          const today = stripTime(new Date());
          const projEnd = new Date(today.getTime() + 180 * 86400000);
          let projChartData = [];
          if (reportSelected.length) {
            const allOccs = reportSelected.flatMap(name => {
              const acct = accounts.find(a => a.name === name);
              const startBal = acct ? currentAccountBalance(data, name, acct.startingBalance) : 0;
              return getScheduledOccurrencesWithInterest(data, name, today, projEnd).map(o => ({ ...o, startBal }));
            });
            const perAcctStart = reportSelected.reduce((s, name) => {
              const acct = accounts.find(a => a.name === name);
              return s + (acct ? currentAccountBalance(data, name, acct.startingBalance) : 0);
            }, 0);
            const byDate = {};
            allOccs.forEach(o => {
              const key = o.date.toDateString();
              byDate[key] = (byDate[key] || { date: o.date, amount: 0 });
              byDate[key].amount += o.amount;
            });
            const sortedDays = Object.values(byDate).sort((a, b) => a.date - b.date);
            let running = perAcctStart;
            projChartData = [{ day: "Today", balance: Math.round(perAcctStart * 100) / 100 }];
            sortedDays.forEach(d => {
              running += d.amount;
              projChartData.push({ day: d.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }), balance: Math.round(running * 100) / 100 });
            });
          }

          return (
            <div className="space-y-6">
              <div>
                <h2 className="font-serif text-2xl mb-1">Reports</h2>
                <p className="text-sm text-stone-500">Pick any combination of accounts to see their real historical totals or their combined projected balance.</p>
              </div>

              {saved.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {saved.map(s => (
                    <button key={s.id} onClick={() => setReportSelected(s.accountNames)}
                      className={"px-3 py-1.5 rounded-full text-sm border " + (JSON.stringify([...reportSelected].sort()) === JSON.stringify([...s.accountNames].sort()) ? "border-brand text-brand bg-brand-tint" : "border-stone-300 text-stone-600 hover:bg-stone-50")}>
                      {s.name}
                    </button>
                  ))}
                </div>
              )}

              <div className="bg-white rounded-2xl shadow-sm border border-stone-200 p-4 sm:p-5">
                <p className="text-xs font-medium text-stone-500 mb-3">Choose accounts</p>
                <div className="space-y-4">
                  {sections.map((section, si) => (
                    <div key={si}>
                      {section.label && <p className="text-xs font-semibold uppercase tracking-wide text-stone-400 mb-1.5">{section.label}</p>}
                      <div className="flex flex-wrap gap-2">
                        {section.items.map(a => (
                          <button key={a.id} onClick={() => toggleAccount(a.name)}
                            className={"px-3 py-1.5 rounded-full text-sm border " + (reportSelected.includes(a.name) ? "border-brand text-brand bg-brand-tint" : "border-stone-300 text-stone-600 hover:bg-stone-50")}>
                            {a.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                {reportSelected.length > 0 && (
                  <div className="flex items-center gap-2 mt-4 pt-4 border-t border-stone-100">
                    <input className={inputCls + " flex-1"} placeholder="Name this selection (e.g. Credit Cards)" value={reportSaveName} onChange={e => setReportSaveName(e.target.value)} />
                    <button
                      onClick={() => {
                        if (!reportSaveName.trim()) return;
                        persist({ ...data, savedReportSelections: [...saved, { id: uid(), name: reportSaveName.trim(), accountNames: reportSelected }] });
                        setReportSaveName("");
                      }}
                      className="px-4 py-2 rounded-lg text-sm btn-brand shrink-0"
                    >Save</button>
                  </div>
                )}
              </div>

              {reportSelected.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => setReportMode("historical")} className={"px-4 py-2 rounded-full text-sm font-medium " + (reportMode === "historical" ? "btn-brand" : "border border-stone-300 text-stone-600")}>Historical</button>
                  <button onClick={() => setReportMode("projected")} className={"px-4 py-2 rounded-full text-sm font-medium " + (reportMode === "projected" ? "btn-brand" : "border border-stone-300 text-stone-600")}>Projected</button>
                  {reportMode === "historical" && (
                    <div className="flex items-center gap-1 ml-1 sm:ml-3">
                      <span className="text-xs text-stone-400 mr-1">Group by</span>
                      {["account", "category", "payee"].map(gb => (
                        <button key={gb} onClick={() => setReportGroupBy(gb)}
                          className={"px-3 py-1.5 rounded-full text-xs font-medium capitalize " + (reportGroupBy === gb ? "bg-brand-tint text-brand" : "text-stone-500 hover:bg-stone-50")}>
                          {gb}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {reportSelected.length === 0 && (
                <p className="text-sm text-stone-400 text-center py-6">Choose at least one account above to see a report.</p>
              )}

              {reportSelected.length > 0 && reportMode === "historical" && hist && (
                <div className="bg-white rounded-2xl shadow-sm border border-stone-200 overflow-x-auto">
                  <table className="w-full text-sm" style={{ minWidth: 760 }}>
                    <thead>
                      <tr className="border-b border-stone-100">
                        <th className="text-left font-medium text-stone-400 px-3 py-2 sticky left-0 bg-white capitalize">{reportGroupBy}</th>
                        {MONTH_NAMES.map((m, i) => (
                          <th key={i} className="text-right font-medium text-stone-400 px-2 py-2">
                            <button onClick={() => setReportExpandedMonth(reportExpandedMonth === i ? null : i)}
                              className={"underline decoration-dotted " + (reportExpandedMonth === i ? "text-brand" : "")}>
                              {m.slice(0, 3)}
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-50">
                      {hist.rows.map(r => (
                        <tr key={r.label}>
                          <td className="px-3 py-2 font-medium sticky left-0 bg-white whitespace-nowrap">{r.label}</td>
                          {r.months.map((m, i) => <td key={i} className="text-right px-2 py-2 tabular-nums text-stone-600">{m.total ? fmtMoney(m.total) : "—"}</td>)}
                        </tr>
                      ))}
                      <tr className="border-t border-stone-200 font-semibold">
                        <td className="px-3 py-2 sticky left-0 bg-white">Total</td>
                        {hist.totalMonths.map((v, i) => <td key={i} className="text-right px-2 py-2 tabular-nums">{v ? fmtMoney(v) : "—"}</td>)}
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}

              {reportSelected.length > 0 && reportMode === "historical" && reportExpandedMonth != null && (
                <div className="bg-white rounded-2xl shadow-sm border border-stone-200 overflow-hidden">
                  <p className="text-xs font-medium text-stone-500 px-4 sm:px-5 py-2.5 bg-stone-50">{MONTH_NAMES[reportExpandedMonth]} — {expandedTxns.length} transaction{expandedTxns.length === 1 ? "" : "s"}</p>
                  {expandedTxns.length === 0 ? (
                    <p className="p-5 text-sm text-stone-400">Nothing this month for the selected accounts.</p>
                  ) : expandedTxns.map(t => (
                    <div key={t.id} className="px-4 sm:px-5 py-2 text-sm border-t border-stone-50 first:border-t-0 flex items-center gap-2">
                      <span className="text-stone-400 tabular-nums w-14 shrink-0">{new Date(t.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                      <span className="flex-1 min-w-0 truncate">{t.description || "—"}</span>
                      <span className="text-stone-400 text-xs shrink-0">{t.account}</span>
                      <span className={"font-medium tabular-nums shrink-0 " + (t.amount < 0 ? "text-stone-700" : "text-brand")}>{t.amount < 0 ? "" : "+"}{fmtMoney(t.amount)}</span>
                    </div>
                  ))}
                </div>
              )}

              {reportSelected.length > 0 && reportMode === "projected" && (
                <div className="bg-white rounded-2xl shadow-sm border border-stone-200 p-4 sm:p-5">
                  <p className="text-sm text-stone-500 mb-3">Combined balance across {reportSelected.length} account{reportSelected.length === 1 ? "" : "s"} — next 180 days.</p>
                  <div style={{ width: "100%", height: 260 }}>
                    <ResponsiveContainer>
                      <LineChart data={projChartData} margin={{ top: 5, right: 8, left: 8, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#eee8dc" />
                        <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#9a958a" }} interval="preserveStartEnd" />
                        <YAxis tick={{ fontSize: 10, fill: "#9a958a" }} width={64} tickFormatter={v => "$" + Math.round(v).toLocaleString()} />
                        <Tooltip formatter={v => fmtMoney(v)} labelStyle={{ fontSize: 12 }} contentStyle={{ fontSize: 12, borderRadius: 10, border: "1px solid #e5dfd3" }} />
                        <Line type="stepAfter" dataKey="balance" stroke="#2f6f6b" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* ============ INCOME ============ */}
        {tab === "income" && (
          <ListTab
            title="Income sources"
            subtitle="Every paycheck, benefit, or deposit that funds the budget."
            addLabel="Add income"
            onAdd={() => setModal({ kind: "income" })}
            items={data.income}
            renderRow={(i) => (
              <Row key={i.id} item={i} onEdit={() => setModal({ kind: "income", item: i })} onDelete={() => requestDelete("income", i.id, i.payee)}>
                <span className="font-medium">{i.payee}</span>
                <span className="text-stone-500 text-sm hidden sm:inline">→ {i.account}</span>
                <Chip color="#4a6fa5">{freqLabel(i)}</Chip>
                {i.irregular && <Chip color="#b5793a">irregular</Chip>}
                {i.payType === "hourly" && <Chip color="#3f7cac">${i.hourlyRate}/hr</Chip>}
                <span className="font-semibold tabular-nums ml-auto text-brand">+{fmtMoney(i.amount)}</span>
              </Row>
            )}
          />
        )}

        {tab === "income" && (() => {
          const hourlyJobs = (data.income || []).filter(i => i.active !== false && i.payType === "hourly" && i.hourlyRate > 0);
          const uniqueHourly = [...new Map(hourlyJobs.map(j => [j.payee, j])).values()];
          if (uniqueHourly.length === 0) return null;
          const job = uniqueHourly.find(j => j.payee === estJobPayee) || uniqueHourly[0];
          const regHours = parseFloat(estRegHours) || 0;
          const otHours = parseFloat(estOtHours) || 0;
          const takeHome = (job.takeHomePct ?? 100) / 100;
          const regPay = regHours * job.hourlyRate * takeHome;
          const otPay = otHours * job.hourlyRate * (job.otMultiplier || 1.5) * takeHome;
          const estTotal = regPay + otPay;

          // Find this job's next upcoming occurrence, so the estimate can be
          // applied directly to it instead of retyping the number by hand.
          const today = stripTime(new Date());
          const nextOcc = [
            ...expandItemForYear(job, today.getFullYear(), "income"),
            ...expandItemForYear(job, today.getFullYear() + 1, "income"),
          ].filter(o => o.date >= today).sort((a, b) => a.date - b.date)[0];

          return (
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200 mt-6">
              <h3 className="font-serif text-lg mb-1">Paycheck estimator</h3>
              <p className="text-sm text-stone-500 mb-4">Enter the hours you expect to work and see the check before it arrives.</p>
              <Field label="Job">
                <select className={inputCls} value={job.payee} onChange={e => setEstJobPayee(e.target.value)}>
                  {uniqueHourly.map(j => <option key={j.id} value={j.payee}>{j.payee} (${j.hourlyRate}/hr)</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-4 mt-3">
                <Field label="Regular hours">
                  <input className={inputCls} inputMode="decimal" placeholder="e.g. 80" value={estRegHours} onChange={e => setEstRegHours(e.target.value)} />
                </Field>
                {job.otAvailable && (
                  <Field label={`Overtime hours (${job.otMultiplier || 1.5}×)`}>
                    <input className={inputCls} inputMode="decimal" placeholder="e.g. 10" value={estOtHours} onChange={e => setEstOtHours(e.target.value)} />
                  </Field>
                )}
              </div>
              {(regHours > 0 || otHours > 0) && (
                <div className="bg-brand-tint rounded-xl p-4 mt-3 space-y-1">
                  <div className="flex justify-between text-sm"><span className="text-stone-600">Regular: {regHours} hrs × {fmtMoney(job.hourlyRate)}</span><span className="tabular-nums">{fmtMoney(regPay)}</span></div>
                  {otHours > 0 && <div className="flex justify-between text-sm"><span className="text-stone-600">Overtime: {otHours} hrs × {fmtMoney(job.hourlyRate * (job.otMultiplier || 1.5))}</span><span className="tabular-nums">{fmtMoney(otPay)}</span></div>}
                  {takeHome < 1 && <p className="text-xs text-stone-400">After {job.takeHomePct}% take-home</p>}
                  <div className="flex justify-between font-semibold pt-1 border-t border-stone-200"><span>Estimated check</span><span className="tabular-nums text-lg">{fmtMoney(estTotal)}</span></div>
                  {job.amount > 0 && (
                    <p className="text-xs text-stone-500 pt-1">
                      Your planned figure is {fmtMoney(job.amount)} — this estimate is {estTotal >= job.amount ? fmtMoney(estTotal - job.amount) + " above" : fmtMoney(job.amount - estTotal) + " below"} it.
                    </p>
                  )}
                  {nextOcc && (
                    <button
                      onClick={() => setModal({
                        kind: "editOccurrence",
                        item: { occurrence: { date: nextOcc.date, amount: estTotal, description: job.payee, category: "", sourceId: job.id, sourceType: "income" }, accountName: job.account },
                      })}
                      className="w-full mt-2 px-4 py-2 rounded-lg text-sm btn-brand flex items-center justify-center gap-1.5"
                    ><Check size={15} /> Apply to next paycheck ({nextOcc.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })})</button>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {tab === "income" && (() => {
          const otJobs = (data.income || []).filter(i => i.active !== false && i.payType === "hourly" && i.otAvailable && i.hourlyRate > 0);
          const uniqueJobs = [...new Map(otJobs.map(j => [j.payee, j])).values()];
          if (uniqueJobs.length === 0) return null;
          const job = uniqueJobs.find(j => j.payee === otJobPayee) || uniqueJobs[0];
          const netPerOtHour = (job.hourlyRate || 0) * (job.otMultiplier || 1.5) * ((job.takeHomePct ?? 100) / 100);
          const goal = parseMoney(otGoalAmount) || 0;
          const hoursNeeded = netPerOtHour > 0 && goal > 0 ? goal / netPerOtHour : 0;
          return (
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200 mt-6">
              <h3 className="font-serif text-lg mb-1">Overtime calculator</h3>
              <p className="text-sm text-stone-500 mb-4">Want to cover an expense with extra hours? See exactly how many it takes.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-3">
                <Field label="I want to cover">
                  <input className={inputCls} placeholder="e.g. 500" value={otGoalAmount} onChange={e => setOtGoalAmount(e.target.value)} />
                </Field>
                <Field label="Working overtime at">
                  <select className={inputCls} value={job.payee} onChange={e => setOtJobPayee(e.target.value)}>
                    {uniqueJobs.map(j => <option key={j.id} value={j.payee}>{j.payee} (${j.hourlyRate}/hr)</option>)}
                  </select>
                </Field>
              </div>
              <p className="text-xs text-stone-400 mb-3">
                {job.payee} overtime pays {fmtMoney(netPerOtHour)}/hour take-home ({fmtMoney(job.hourlyRate)} × {job.otMultiplier || 1.5}{(job.takeHomePct ?? 100) < 100 ? ` × ${job.takeHomePct}% take-home` : ", nothing withheld"}).
              </p>
              {goal > 0 && (
                <div className="bg-brand-tint rounded-xl p-4">
                  <p className="text-sm text-stone-700">
                    <b className="text-lg tabular-nums">{Math.ceil(hoursNeeded)} hours</b> of {job.payee} overtime covers {fmtMoney(goal)}
                    <span className="text-stone-500"> — that's {(hoursNeeded / 4).toFixed(1)} hrs/week over a month, or {(hoursNeeded / 8).toFixed(1)} full 8-hour days.</span>
                  </p>
                </div>
              )}
            </div>
          );
        })()}

        {/* ============ TRANSFERS ============ */}
        {tab === "transfers" && (() => {
          const catOrder = ["Backfill", "Autopay", "Other"];
          const byCat = {};
          (data.transfers || []).forEach(t => {
            const c = t.category || "Other";
            (byCat[c] = byCat[c] || []).push(t);
          });
          const cats = [...catOrder.filter(c => byCat[c]), ...Object.keys(byCat).filter(c => !catOrder.includes(c)).sort()];
          const renderRow = (t) => (
            <Row key={t.id} item={t} onEdit={() => setModal({ kind: "transfer", item: t })} onDelete={() => requestDelete("transfers", t.id, t.label)}>
              <span className="font-medium">{t.label}</span>
              <span className="text-stone-500 text-sm flex items-center gap-1"><span>{t.from}</span><ArrowRightLeft size={12} /><span>{t.to}</span></span>
              <Chip color="#4a6fa5">{freqLabel(t)}</Chip>
              <span className="font-semibold tabular-nums ml-auto">{t.isBalance ? "Full balance" : fmtMoney(t.amount)}</span>
            </Row>
          );
          return (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-serif text-2xl">Scheduled transfers</h2>
                  <p className="text-sm text-stone-500">Money moved between your own accounts to fund bills and savings.</p>
                </div>
                <button onClick={() => setModal({ kind: "transfer" })} className="flex items-center gap-1.5 btn-brand rounded-full px-4 py-2 text-sm font-medium shrink-0">
                  <Plus size={16} /> Add transfer
                </button>
              </div>
              {cats.map(c => (
                <div key={c}>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-400 mb-2 px-1">{c} ({byCat[c].length})</h3>
                  <div className="bg-white rounded-2xl shadow-sm border border-stone-200 divide-y divide-stone-100 overflow-hidden">
                    {byCat[c].sort((a, b) => a.label.localeCompare(b.label)).map(renderRow)}
                  </div>
                </div>
              ))}
            </div>
          );
        })()}

        {/* ============ SAVINGS PLAN ============ */}
        {tab === "savingsplan" && (
          <div className="space-y-6">
            <div>
              <h2 className="font-serif text-2xl">Savings transfer plan</h2>
              <p className="text-sm text-stone-500">How much to move from Checking to Savings each pay period, so checking cash stays level no matter what bills change.</p>
            </div>

            <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
              <h3 className="font-serif text-lg mb-3">Settings</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                <Field label="Checking account (for this calculation)">
                  <AccountSelect accounts={accounts} value={savingsPlanSettings.checkingAccount} onChange={v => updateSavingsPlanSettings({ checkingAccount: v })} />
                </Field>
                <Field label="Savings account (for this calculation)">
                  <AccountSelect accounts={accounts} value={savingsPlanSettings.savingsAccount} onChange={v => updateSavingsPlanSettings({ savingsAccount: v })} />
                </Field>
              </div>
              <p className="label-sm font-medium text-stone-600 mb-2">Pay periods</p>
              <div className="space-y-2 mb-2">
                {savingsPlanSettings.payPeriods.map(p => (
                  <div key={p.id} className="border border-stone-200 rounded-xl p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <input className={inputCls + " flex-1 min-w-0"} placeholder="Label" value={p.label} onChange={e => updatePayPeriod(p.id, { label: e.target.value })} />
                      <button onClick={() => removePayPeriod(p.id)} className="p-2 -m-1 text-stone-300 hover-text-danger shrink-0"><Trash2 size={17} /></button>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-stone-400 text-sm">day</span>
                      <input type="number" min={1} max={31} className={inputCls + " w-20"} value={p.startDay} onChange={e => updatePayPeriod(p.id, { startDay: parseInt(e.target.value, 10) || 1 })} />
                      <span className="text-stone-400 text-sm">to</span>
                      <input type="number" min={1} max={31} className={inputCls + " w-20"} value={p.endDay} onChange={e => updatePayPeriod(p.id, { endDay: parseInt(e.target.value, 10) || 31 })} />
                    </div>
                  </div>
                ))}
              </div>
              <button onClick={addPayPeriod} className="text-sm text-brand underline flex items-center gap-1"><Plus size={14} /> Add a pay period</button>
              <p className="text-xs text-stone-400 mt-3">Use 31 for a period's end day to mean "through the end of the month" — it automatically adjusts for shorter months.</p>
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-stone-200 overflow-hidden">
              <div className="grid gap-px bg-stone-100" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
                {savingsPlan.rows.map(r => (
                  <div key={r.id} className="bg-white p-4 sm:p-5 text-center">
                    <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">{r.label}</p>
                    <p className="font-serif text-2xl sm:text-3xl text-brand mb-1">{fmtMoney(r.adjustedToSavings)}</p>
                    <p className="text-xs text-stone-400">to Savings this period</p>
                  </div>
                ))}
              </div>
              <div className="px-5 py-3 border-t border-stone-100 flex items-center justify-between text-sm">
                <span className="text-stone-500">Monthly total</span>
                <span className="font-semibold tabular-nums">{fmtMoney(savingsPlan.totalAdjusted)}</span>
              </div>
            </div>

            <details className="bg-white rounded-2xl shadow-sm border border-stone-200 p-5">
              <summary className="cursor-pointer font-serif text-lg">Show the math</summary>
              <div className="overflow-x-auto mt-4">
                <table className="w-full text-sm table-minw" style={{ minWidth: 640 }}>
                  <thead>
                    <tr className="text-stone-400 text-xs">
                      <th className="text-left font-medium py-1.5">Period</th>
                      <th className="text-right font-medium py-1.5">Income avg</th>
                      <th className="text-right font-medium py-1.5">Checking-funded avg</th>
                      <th className="text-right font-medium py-1.5">Savings-funded avg</th>
                      <th className="text-right font-medium py-1.5">Net</th>
                      <th className="text-right font-medium py-1.5">Delta vs. avg</th>
                      <th className="text-right font-medium py-1.5">Adjusted to Savings</th>
                      <th className="text-right font-medium py-1.5">Adjusted net</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {savingsPlan.rows.map(r => (
                      <tr key={r.id}>
                        <td className="py-2 font-medium">{r.label}</td>
                        <td className="py-2 text-right tabular-nums">{fmtMoney(r.incomeAvg)}</td>
                        <td className="py-2 text-right tabular-nums">{fmtMoney(r.checkingAvg)}</td>
                        <td className="py-2 text-right tabular-nums">{fmtMoney(r.savingsAvg)}</td>
                        <td className="py-2 text-right tabular-nums">{fmtMoney(r.net)}</td>
                        <td className="py-2 text-right tabular-nums text-stone-500">{fmtMoney(r.delta)}</td>
                        <td className="py-2 text-right tabular-nums font-semibold text-brand">{fmtMoney(r.adjustedToSavings)}</td>
                        <td className="py-2 text-right tabular-nums">{fmtMoney(r.adjustedNet)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-stone-400 mt-3">Average net across periods: {fmtMoney(savingsPlan.avgNet)}. Adjusted to Savings = CEILING(Savings-funded avg + Delta, 10) — it's what makes Adjusted net land close to the same number every period.</p>
            </details>

            {(() => {
              const efc = computeEmergencyFund(data, year);
              const ef = efc.settings;
              const pct = efc.target > 0 ? Math.min(100, (efc.saved / efc.target) * 100) : 0;
              return (
                <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
                  <h3 className="font-serif text-lg mb-1">Emergency fund</h3>
                  <p className="text-sm text-stone-500 mb-4">A cushion for real emergencies — job loss, a major repair — computed from your own essential bills, not a guess.</p>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                    <Field label="Account holding the fund">
                      <select className={inputCls} value={ef.accountName || ""} onChange={e => updateEmergencyFund({ accountName: e.target.value })}>
                        <option value="">— choose an account —</option>
                        {accounts.filter(a => !a.isCreditCard && !a.isLoan).map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                      </select>
                    </Field>
                    <Field label="Months of cushion">
                      <select className={inputCls} value={ef.customTarget ? "custom" : ef.months}
                        onChange={e => e.target.value === "custom" ? updateEmergencyFund({ customTarget: efc.target || 1000 }) : updateEmergencyFund({ months: parseInt(e.target.value, 10), customTarget: null })}>
                        <option value={3}>3 months</option>
                        <option value={6}>6 months</option>
                        <option value="custom">Custom target</option>
                      </select>
                    </Field>
                    {ef.customTarget != null ? (
                      <Field label="Custom target amount">
                        <input className={inputCls} value={ef.customTarget} onChange={e => updateEmergencyFund({ customTarget: parseMoney(e.target.value) })} />
                      </Field>
                    ) : (
                      <Field label="Monthly contribution">
                        <input className={inputCls} placeholder="e.g. 200" value={ef.monthlyContribution || ""} onChange={e => updateEmergencyFund({ monthlyContribution: parseMoney(e.target.value) || 0 })} />
                      </Field>
                    )}
                    {ef.customTarget != null && (
                      <Field label="Monthly contribution">
                        <input className={inputCls} placeholder="e.g. 200" value={ef.monthlyContribution || ""} onChange={e => updateEmergencyFund({ monthlyContribution: parseMoney(e.target.value) || 0 })} />
                      </Field>
                    )}
                  </div>

                  <p className="text-xs text-stone-400 mb-4">
                    Your essential bills average <b>{fmtMoney(efc.essentialMonthly)}</b>/month across {efc.essentialCount} bill{efc.essentialCount === 1 ? "" : "s"} marked "essential."
                    {efc.essentialCount === 0 && " Mark your survival-mode bills (housing, utilities, food, insurance) as essential in the Bills tab to compute a personalized target."}
                  </p>

                  {ef.accountName && efc.target > 0 && (
                    <>
                      <div className="flex items-baseline justify-between mb-1">
                        <span className="text-sm font-medium">{fmtMoney(efc.saved)} of {fmtMoney(efc.target)}</span>
                        <span className="text-sm text-stone-500">{Math.round(pct)}%</span>
                      </div>
                      <div className="h-3 rounded-full bg-stone-100 overflow-hidden mb-3">
                        <div className="h-full rounded-full" style={{ width: pct + "%", background: "#2f6f6b" }} />
                      </div>
                      <div className="flex flex-wrap gap-2 mb-3">
                        {efc.milestones.map((m, i) => (
                          <Chip key={i} color={efc.saved >= m.value ? "#2f6f6b" : "#9a958a"}>
                            {efc.saved >= m.value ? "✓ " : ""}{m.label} · {fmtMoney(m.value)}
                          </Chip>
                        ))}
                      </div>
                      {efc.remaining > 0 && ef.monthlyContribution > 0 && efc.fundedBy && (
                        <p className="text-sm text-stone-600">
                          At {fmtMoney(ef.monthlyContribution)}/month, fully funded by <b>{efc.fundedBy.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</b> ({efc.monthsToGoal} months). The contribution appears automatically in your {ef.accountName} and {savingsPlanSettings.checkingAccount} registers.
                        </p>
                      )}
                      {efc.remaining === 0 && <p className="text-sm font-medium" style={{ color: "#2f6f6b" }}>Fully funded. 🎉</p>}
                    </>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {/* ============ GIFTS ============ */}
        {tab === "gifts" && (() => {
          const gifts = data.bills.filter(b => b.isGift);
          const groups = {};
          gifts.forEach(g => { (groups[g.occasion] = groups[g.occasion] || []).push(g); });
          const occasionOrder = Object.keys(groups).sort((a, b) => {
            const da = parseAnyDate(groups[a][0]?.date), db = parseAnyDate(groups[b][0]?.date);
            const ka = da ? da.month * 31 + da.day : 999, kb = db ? db.month * 31 + db.day : 999;
            return ka - kb;
          });
          const yearTotal = gifts.filter(g => g.active !== false).reduce((s, g) => s + (g.amount || 0), 0);

          return (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-serif text-2xl">Gift planning</h2>
                  <p className="text-sm text-stone-500">Birthdays, holidays, anniversaries — planned ahead so nothing's a surprise.</p>
                </div>
                <button onClick={() => setModal({ kind: "gift" })} className="flex items-center gap-1.5 btn-brand rounded-full px-4 py-2 text-sm font-medium shrink-0">
                  <Plus size={16} /> Add gift
                </button>
              </div>

              <SummaryCard icon={Gift} label={`Total planned this year, ${year}`} value={fmtMoney(yearTotal)} tone="#c15b4a" />

              {gifts.length === 0 ? (
                <p className="p-6 text-sm text-stone-400 text-center bg-white rounded-2xl border border-stone-200">No gifts planned yet. Add one for each person and occasion — Christmas, birthdays, whatever you want to plan ahead for.</p>
              ) : occasionOrder.map(occasion => {
                const items = groups[occasion].sort((a, b) => (a.recipient || "").localeCompare(b.recipient || ""));
                const subtotal = items.filter(g => g.active !== false).reduce((s, g) => s + (g.amount || 0), 0);
                return (
                  <div key={occasion}>
                    <div className="flex items-center justify-between mb-2 px-1">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-400">{occasion}</h3>
                      <span className="text-xs font-semibold text-stone-500">{fmtMoney(subtotal)}</span>
                    </div>
                    <div className="bg-white rounded-2xl shadow-sm border border-stone-200 divide-y divide-stone-100 overflow-hidden">
                      {items.map(g => (
                        <Row key={g.id} item={g} onEdit={() => setModal({ kind: "gift", item: g })} onDelete={() => requestDelete("bills", g.id, g.payee || "this gift")}>
                          <span className="font-medium">{g.recipient}</span>
                          <span className="text-stone-400 text-xs">{(() => { const pd = parseAnyDate(g.date); return pd ? new Date(pd.year || year, pd.month, pd.day).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"; })()}</span>
                          <Chip color="#7a5c94">{g.fundedBy || g.account}</Chip>
                          <span className={"font-semibold tabular-nums ml-auto " + (g.active === false ? "text-stone-400" : "")}>{fmtMoney(g.amount)}</span>
                        </Row>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* ============ WISHLIST ============ */}
        {tab === "wishlist" && (() => {
          const items = data.bills.filter(b => b.isWishlistItem).sort((a, b) => (a.priority || 50) - (b.priority || 50));
          const committed = items.filter(i => i.active === true);
          const ideas = items.filter(i => i.active !== true);
          const committedTotal = committed.reduce((s, i) => s + (i.amount || 0), 0);

          // Swap an idea with its neighbor, then renumber the whole ideas
          // list 1..N so ordering stays deterministic even if old items
          // share duplicate priority values.
          const moveIdea = (index, dir) => {
            const target = index + dir;
            if (target < 0 || target >= ideas.length) return;
            const reordered = [...ideas];
            [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
            const priorityById = {};
            reordered.forEach((it, i) => { priorityById[it.id] = i + 1; });
            persist({ ...data, bills: data.bills.map(b => priorityById[b.id] ? { ...b, priority: priorityById[b.id] } : b) });
          };

          return (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-serif text-2xl">Wishlist</h2>
                  <p className="text-sm text-stone-500">Big future expenses — keep the idea on the list, commit it to the Savings Plan when you're ready.</p>
                </div>
                <button onClick={() => setModal({ kind: "wishlist" })} className="flex items-center gap-1.5 btn-brand rounded-full px-4 py-2 text-sm font-medium shrink-0">
                  <Plus size={16} /> Add idea
                </button>
              </div>

              {committed.length > 0 && (
                <SummaryCard icon={Star} label="Committed to Savings Plan" value={fmtMoney(committedTotal)} tone="#2f6f6b" />
              )}

              {items.length === 0 ? (
                <p className="p-6 text-sm text-stone-400 text-center bg-white rounded-2xl border border-stone-200">Nothing on the wishlist yet. Add anything big you're thinking about — a new roof, a remodel, a car — and rank them by priority.</p>
              ) : (
                <>
                  {committed.length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-400 mb-2 px-1">Committed to Savings Plan</h3>
                      <div className="bg-white rounded-2xl shadow-sm border border-stone-200 divide-y divide-stone-100 overflow-hidden">
                        {committed.map(item => (
                          <Row key={item.id} item={item} onEdit={() => setModal({ kind: "wishlist", item })} onDelete={() => requestDelete("bills", item.id, item.payee || item.name || "this item")}>
                            <span className="font-medium">{item.payee}</span>
                            <span className="text-stone-400 text-xs">{item.date ? new Date(item.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "no date set"}</span>
                            <Chip color="#2f6f6b">{item.fundedBy || item.account}</Chip>
                            <span className="font-semibold tabular-nums ml-auto">{fmtMoney(item.amount)}</span>
                          </Row>
                        ))}
                      </div>
                    </div>
                  )}
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-400 mb-2 px-1">Just ideas — not yet committed</h3>
                    {ideas.length === 0 ? (
                      <p className="text-sm text-stone-400 px-1">Everything on your list is already committed.</p>
                    ) : (
                      <div className="bg-white rounded-2xl shadow-sm border border-stone-200 divide-y divide-stone-100 overflow-hidden">
                        {ideas.map((item, idx) => (
                          <Row key={item.id} item={item} onEdit={() => setModal({ kind: "wishlist", item })} onDelete={() => requestDelete("bills", item.id, item.payee || item.name || "this item")}>
                            <div className="flex flex-col shrink-0 -my-1">
                              <button onClick={e => { e.stopPropagation(); moveIdea(idx, -1); }} disabled={idx === 0}
                                className={"p-1 " + (idx === 0 ? "text-stone-200" : "text-stone-400 hover-text-brand")}><ChevronDown size={14} className="rotate-180" /></button>
                              <button onClick={e => { e.stopPropagation(); moveIdea(idx, 1); }} disabled={idx === ideas.length - 1}
                                className={"p-1 " + (idx === ideas.length - 1 ? "text-stone-200" : "text-stone-400 hover-text-brand")}><ChevronDown size={14} /></button>
                            </div>
                            <span className="text-stone-400 text-xs w-6">#{idx + 1}</span>
                            <span className="font-medium">{item.payee}</span>
                            <span className="font-semibold tabular-nums ml-auto">{fmtMoney(item.amount)}</span>
                          </Row>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })()}

        {/* ============ DEBT PAYOFF ============ */}
        {tab === "debts" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-serif text-2xl">Debt payoff plan</h2>
                <p className="text-sm text-stone-500">Pick a strategy and this simulates the whole payoff month by month.</p>
              </div>
              <button onClick={() => setModal({ kind: "debt" })} className="flex items-center gap-1.5 btn-brand rounded-full px-4 py-2 text-sm font-medium shrink-0">
                <Plus size={16} /> Add debt
              </button>
            </div>

            <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200 grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field label="Balances as of">
                <input type="date" className={inputCls} value={debtSettings.balanceDate}
                  onChange={e => updateDebtSettings({ balanceDate: e.target.value })} />
              </Field>
              <Field label="Total monthly payment toward all debt">
                <input className={inputCls} value={debtSettings.monthlyPayment}
                  onChange={e => updateDebtSettings({ monthlyPayment: parseMoney(e.target.value) })} />
              </Field>
              <Field label="Strategy">
                <select className={inputCls} value={debtSettings.strategy} onChange={e => updateDebtSettings({ strategy: e.target.value })}>
                  <option value="snowball">Snowball — lowest balance first</option>
                  <option value="avalanche">Avalanche — highest interest rate first</option>
                  <option value="custom">Custom order (set per debt)</option>
                  <option value="none">No snowball — pay minimums only</option>
                </select>
              </Field>
            </div>

            {debtSim.totalFloor > (debtSettings.monthlyPayment || 0) && (
              <div className="bg-callout border border-callout rounded-2xl p-4 flex gap-3 text-sm text-stone-700">
                <AlertCircle size={18} className="text-callout shrink-0 mt-0.5" />
                <p>Your minimums plus what you're already paying extra add up to {fmtMoney(debtSim.totalFloor)}/month, more than the {fmtMoney(debtSettings.monthlyPayment || 0)} budgeted. Raise the monthly payment to see a payoff date.</p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <SummaryCard icon={Landmark} label="Total debt" value={fmtMoney(debts.filter(d => d.active !== false).reduce((s, d) => s + d.balance, 0))} tone="#7a5c94" />
              <SummaryCard icon={Repeat} label="Extra toward snowball" value={fmtMoney(debtSim.extraPool)} tone="#2f6f6b" />
              <SummaryCard icon={TrendingDown} label="Total interest (projected)" value={fmtMoney(debtSim.totalInterest)} tone="#c15b4a" />
              <SummaryCard icon={Calendar} label="Debt-free" value={debtSim.hitMonthLimit ? "50+ yrs" : debtSim.debtFreeDate.toLocaleDateString(undefined, { month: "short", year: "numeric" })} tone="#b5793a" />
            </div>

            <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
              <h3 className="font-serif text-lg mb-1">What if I paid extra?</h3>
              <p className="text-xs text-stone-500 mb-3">See the impact of an extra monthly payment before committing to it.</p>
              <div className="flex items-center gap-3 mb-4">
                <span className="text-sm text-stone-500">Add</span>
                <input type="number" className={inputCls + " w-28"} value={whatIfExtra} onChange={e => setWhatIfExtra(parseFloat(e.target.value) || 0)} />
                <span className="text-sm text-stone-500">extra per month</span>
              </div>
              {whatIfExtra > 0 && !debtSim.hitMonthLimit && !whatIfSim.hitMonthLimit && (() => {
                const monthsSaved = debtSim.perDebt.reduce((max, d) => Math.max(max, d.monthsToPayOff), 0) - whatIfSim.perDebt.reduce((max, d) => Math.max(max, d.monthsToPayOff), 0);
                const interestSaved = debtSim.totalInterest - whatIfSim.totalInterest;
                return (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="border border-stone-200 rounded-xl px-3 py-2.5">
                      <p className="text-xs text-stone-500">New debt-free date</p>
                      <p className="font-serif text-xl">{whatIfSim.debtFreeDate.toLocaleDateString(undefined, { month: "short", year: "numeric" })}</p>
                    </div>
                    <div className="border border-stone-200 rounded-xl px-3 py-2.5">
                      <p className="text-xs text-stone-500">Months saved</p>
                      <p className="font-serif text-xl text-brand">{monthsSaved > 0 ? monthsSaved : 0}</p>
                    </div>
                    <div className="border border-stone-200 rounded-xl px-3 py-2.5">
                      <p className="text-xs text-stone-500">Interest saved</p>
                      <p className="font-serif text-xl text-brand">{fmtMoney(interestSaved > 0 ? interestSaved : 0)}</p>
                    </div>
                  </div>
                );
              })()}
            </div>

            <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200 overflow-x-auto">
              <h3 className="font-serif text-lg mb-1">Compare strategies</h3>
              <p className="text-xs text-stone-500 mb-3">Same debts, same monthly budget — just a different order of attack.</p>
              <div className="divide-y divide-stone-100">
                {strategyComparison.map(({ strategy, result }) => (
                  <div key={strategy} className={"py-2.5 px-2 rounded-lg " + (strategy === debtSettings.strategy ? "bg-brand-tint" : "")}>
                    <div className="flex items-center gap-2">
                      <span className="font-medium capitalize">{strategy === "custom" ? "Custom order" : strategy === "none" ? "Minimums only" : strategy}</span>
                      {strategy === debtSettings.strategy && <Chip color="#2f6f6b">current</Chip>}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-sm">
                      <span className="text-stone-500">Debt-free <b className="text-stone-700 tabular-nums">{result.hitMonthLimit ? "50+ yrs" : result.debtFreeDate.toLocaleDateString(undefined, { month: "short", year: "numeric" })}</b></span>
                      <span className="flex-1" />
                      <span className="text-stone-500">Interest <b className="text-stone-700 tabular-nums">{fmtMoney(result.totalInterest)}</b></span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
              <h3 className="font-serif text-lg mb-1">Balance transfer comparison</h3>
              <p className="text-xs text-stone-500 mb-4">See whether moving a balance to a promo-rate card is actually worth it, fee included.</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                <Field label="Which debt would you move?">
                  <select className={inputCls} value={btDebtId} onChange={e => setBtDebtId(e.target.value)}>
                    <option value="">Select a debt…</option>
                    {debts.filter(d => d.active !== false && d.balance > 0).map(d => <option key={d.id} value={d.id}>{d.creditor} — {fmtMoney(d.balance)}</option>)}
                  </select>
                </Field>
                <Field label="Balance transfer fee (%)">
                  <input type="number" className={inputCls} value={btFeePercent} onChange={e => setBtFeePercent(parseFloat(e.target.value) || 0)} />
                </Field>
                <Field label="New card's promo APR (%) — usually 0">
                  <input type="number" className={inputCls} value={btPromoRate} onChange={e => setBtPromoRate(parseFloat(e.target.value) || 0)} />
                </Field>
                <Field label="Promo length (months)">
                  <input type="number" className={inputCls} value={btPromoMonths} onChange={e => setBtPromoMonths(parseInt(e.target.value, 10) || 0)} />
                </Field>
                <Field label="New card's regular APR after promo (%)">
                  <input type="number" className={inputCls} value={btRegularRate} onChange={e => setBtRegularRate(parseFloat(e.target.value) || 0)} />
                </Field>
              </div>

              {!btDebt ? (
                <p className="text-sm text-stone-400">Pick a debt above to compare keeping it where it is vs. transferring it.</p>
              ) : (
                <>
                  <p className="text-xs text-stone-400 mb-3">
                    Transfer fee: {fmtMoney(btFeeAmount)} (added to the transferred balance — {fmtMoney(btDebt.balance)} becomes {fmtMoney(btDebt.balance + btFeeAmount)}). Promo runs through {new Date(addMonthsToDateString(debtSettings.balanceDate, btPromoMonths) + "T00:00:00").toLocaleDateString(undefined, { month: "short", year: "numeric" })}.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <div className="border border-stone-200 rounded-xl p-4">
                      <p className="text-xs font-medium text-stone-500 mb-2">Keep it where it is</p>
                      <p className="text-sm text-stone-600">This debt paid off: <strong>{(() => { const d = btKeepSim.perDebt.find(p => p.creditor === btDebt.creditor); return d ? d.payoffDate.toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "—"; })()}</strong></p>
                      <p className="text-sm text-stone-600">Debt-free: <strong>{btKeepSim.hitMonthLimit ? "50+ yrs" : btKeepSim.debtFreeDate.toLocaleDateString(undefined, { month: "short", year: "numeric" })}</strong></p>
                      <p className="text-sm text-stone-600">Total interest (whole plan): <strong>{fmtMoney(btKeepSim.totalInterest)}</strong></p>
                    </div>
                    <div className="border border-brand rounded-xl p-4">
                      <p className="text-xs font-medium text-brand mb-2">Transfer it</p>
                      <p className="text-sm text-stone-600">This debt paid off: <strong>{(() => { const d = btTransferSim.perDebt.find(p => p.creditor === btDebt.creditor); return d ? d.payoffDate.toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "—"; })()}</strong></p>
                      <p className="text-sm text-stone-600">Debt-free: <strong>{btTransferSim.hitMonthLimit ? "50+ yrs" : btTransferSim.debtFreeDate.toLocaleDateString(undefined, { month: "short", year: "numeric" })}</strong></p>
                      <p className="text-sm text-stone-600">Total interest (whole plan): <strong>{fmtMoney(btTransferSim.totalInterest)}</strong></p>
                    </div>
                  </div>
                  {(() => {
                    const netSavings = btKeepSim.totalInterest - btTransferSim.totalInterest;
                    const isGood = netSavings > 0;
                    return (
                      <div className={"rounded-xl p-4 text-sm font-medium " + (isGood ? "bg-brand-tint text-brand" : "bg-callout text-stone-700")}>
                        {isGood
                          ? `Transferring saves about ${fmtMoney(netSavings)} in interest overall (fee already included).`
                          : `Transferring costs about ${fmtMoney(-netSavings)} more overall once the fee is included — not worth it as entered.`}
                      </div>
                    );
                  })()}
                </>
              )}
            </div>

            <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-serif text-lg">Snowball payments</h3>
                <button onClick={() => setModal({ kind: "snowball" })} className="flex items-center gap-1.5 btn-brand rounded-full px-3.5 py-1.5 text-sm font-medium">
                  <Plus size={14} /> Add
                </button>
              </div>
              <p className="text-sm text-stone-500 mb-3">Extra payments that can move from one debt to another on a set date — separate from a debt's own "extra you're already paying."</p>
              {snowballPayments.length === 0 ? (
                <p className="text-sm text-stone-400">None scheduled. A debt's own "extra" field still works fine for a payment that never changes.</p>
              ) : (
                <div className="divide-y divide-stone-100">
                  {snowballPayments.map(sp => {
                    const target = debts.find(d => d.id === sp.targetDebtId);
                    return (
                      <div key={sp.id} className="flex items-center gap-3 py-2.5 text-sm">
                        <span className="font-semibold tabular-nums">{fmtMoney(sp.amount)}</span>
                        <ArrowRightLeft size={12} className="text-stone-400" />
                        <span className="font-medium flex-1">{target ? target.creditor : "(deleted debt)"}</span>
                        <span className="text-stone-400 text-xs">
                          {sp.startDate ? new Date(sp.startDate + "T00:00:00").toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "always"}
                          {" – "}
                          {sp.endDate ? new Date(sp.endDate + "T00:00:00").toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "ongoing"}
                        </span>
                        <button onClick={() => setModal({ kind: "snowball", item: sp })} className="text-stone-300 hover-text-brand"><Pencil size={14} /></button>
                        <button onClick={() => requestDelete("snowballPayments", sp.id, "this snowball payment")} className="text-stone-300 hover-text-danger"><Trash2 size={14} /></button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
              <h3 className="font-serif text-lg mb-3">Total balance over time</h3>
              {debtSim.schedule.length === 0 ? <p className="text-sm text-stone-400">Add a debt to see the payoff curve.</p> : (() => {
                const chartData = debtSim.schedule
                  .filter((_, i) => i % Math.max(1, Math.ceil(debtSim.schedule.length / 60)) === 0)
                  .map(d => ({ label: d.date.toLocaleDateString(undefined, { month: "short", year: "2-digit" }), totalBalance: d.totalBalance }));
                const targetLabels = 7;
                const labelInterval = Math.max(0, Math.ceil(chartData.length / targetLabels) - 1);
                return (
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7e2d6" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={labelInterval} />
                      <YAxis tick={{ fontSize: 12 }} tickFormatter={v => "$" + (v / 1000).toFixed(0) + "k"} />
                      <Tooltip formatter={v => fmtMoney(v)} />
                      <Bar dataKey="totalBalance" fill="#7a5c94" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                );
              })()}
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-stone-200 divide-y divide-stone-100 overflow-hidden">
              {debts.length === 0 && <p className="p-6 text-sm text-stone-400 text-center">No debts added yet.</p>}
              {debts.map(d => {
                const result = debtSim.perDebt.find(p => p.id === d.id);
                const isOpen = expandedDebtId === d.id;
                return (
                  <div key={d.id}>
                    <Row item={d} onEdit={() => setModal({ kind: "debt", item: d })} onDelete={() => requestDelete("debts", d.id, d.creditor)}>
                      <button onClick={() => setExpandedDebtId(isOpen ? null : d.id)} className="font-medium hover-text-brand text-left">{d.creditor}</button>
                      <span className="text-stone-500 text-sm">{fmtMoney(d.balance)} balance</span>
                      <span className="text-stone-400 text-xs">
                        {d.promoEndDate && new Date(d.promoEndDate + "T23:59:59") >= new Date()
                          ? `${((d.promoRate || 0) * 100).toFixed(2)}% promo APR until ${new Date(d.promoEndDate + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}, then ${((d.rate || 0) * 100).toFixed(2)}%`
                          : `${((d.rate || 0) * 100).toFixed(2)}% APR`}
                        {" "}· min {fmtMoney(d.minPayment)}
                        {d.extraPayment > 0 ? ` + ${fmtMoney(d.extraPayment)} extra already` : ""}
                        {d.escrowMonthly > 0 ? ` + ${fmtMoney(d.escrowMonthly)} escrow` : ""}
                      </span>
                      {result && (
                        <Chip color="#7a5c94">paid off {result.payoffDate.toLocaleDateString(undefined, { month: "short", year: "numeric" })}</Chip>
                      )}
                      {result && <span className="font-semibold tabular-nums ml-auto text-stone-600 text-sm">{fmtMoney(result.interestPaid)} interest</span>}
                      <button onClick={() => setExpandedDebtId(isOpen ? null : d.id)} className="text-stone-300 hover-text-brand shrink-0">
                        <ChevronRight size={16} style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
                      </button>
                    </Row>
                    {isOpen && result && (
                      <div className="bg-stone-50 px-4 sm:px-5 py-4 border-t border-stone-100">
                        <p className="text-xs text-stone-500 mb-3">Each payment's principal, interest{d.escrowMonthly > 0 ? ", and escrow" : ""} — first 12 months shown.</p>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm table-minw" style={{ minWidth: d.escrowMonthly > 0 ? 720 : 480 }}>
                            <thead>
                              <tr className="text-stone-400 text-xs">
                                <th className="text-left font-medium py-1.5">Date</th>
                                <th className="text-right font-medium py-1.5">Principal</th>
                                <th className="text-right font-medium py-1.5">Interest</th>
                                {d.escrowMonthly > 0 && <th className="text-right font-medium py-1.5">Tax</th>}
                                {d.escrowMonthly > 0 && <th className="text-right font-medium py-1.5">Insurance</th>}
                                {d.escrowMonthly > 0 && <th className="text-right font-medium py-1.5">Cushion/shortfall</th>}
                                <th className="text-right font-medium py-1.5">Payment</th>
                                <th className="text-right font-medium py-1.5">Balance after</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-stone-100">
                              {result.ledger.slice(0, 12).map((row, i) => (
                                <tr key={i}>
                                  <td className="py-1.5 text-stone-500">{row.date.toLocaleDateString(undefined, { month: "short", year: "numeric" })}</td>
                                  <td className="py-1.5 text-right tabular-nums">{fmtMoney(row.principal)}</td>
                                  <td className="py-1.5 text-right tabular-nums text-stone-500">{fmtMoney(row.interest)}</td>
                                  {d.escrowMonthly > 0 && <td className="py-1.5 text-right tabular-nums text-stone-500">{fmtMoney(row.escrow ? row.escrow.tax : 0)}</td>}
                                  {d.escrowMonthly > 0 && <td className="py-1.5 text-right tabular-nums text-stone-500">{fmtMoney(row.escrow ? row.escrow.insurance : 0)}</td>}
                                  {d.escrowMonthly > 0 && (
                                    <td className={"py-1.5 text-right tabular-nums " + ((row.escrow && row.escrow.other < 0) ? "text-danger" : "text-stone-400")}>
                                      {fmtMoney(row.escrow ? row.escrow.other : 0)}
                                    </td>
                                  )}
                                  <td className="py-1.5 text-right tabular-nums font-medium">{fmtMoney(row.payment + (row.escrow ? row.escrow.escrow : 0))}</td>
                                  <td className="py-1.5 text-right tabular-nums text-stone-500">{fmtMoney(row.remaining)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {result.ledger.length > 12 && <p className="text-xs text-stone-400 mt-2">+ {result.ledger.length - 12} more months until paid off.</p>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ============ FULL YEAR CALENDAR ============ */}
        {tab === "calendar" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="font-serif text-2xl">Scheduled Transactions, {year}</h2>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-sm text-stone-500">
                  <input type="checkbox" checked={hideZeroBills} onChange={e => setHideZeroBills(e.target.checked)} />
                  Hide $0 bills
                </label>
                <select className={inputCls} value={month} onChange={e => setMonth(parseInt(e.target.value, 10))}>
                  {MONTH_NAMES.map((m, i) => <option key={m} value={i}>{m}</option>)}
                </select>
              </div>
            </div>
            <div className="bg-white rounded-2xl shadow-sm border border-stone-200 divide-y divide-stone-100 overflow-hidden">
              {yearAll.filter(x => x.date.getMonth() === month && !(hideZeroBills && x.amount === 0)).length === 0 && (
                <p className="p-5 text-sm text-stone-400">Nothing scheduled this month.</p>
              )}
              {yearAll.filter(x => x.date.getMonth() === month && !(hideZeroBills && x.amount === 0)).map((x, idx) => (
                <div key={idx} className="px-5 py-2.5 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="text-stone-400 tabular-nums w-9 shrink-0">{x.date.getDate()}</span>
                    <span className="font-medium flex-1 min-w-0 break-words">{x.payee || x.label}</span>
                  </div>
                  <div className="flex items-center gap-2 pl-12 mt-0.5">
                    {x.kind === "bill" && <Chip color={categoryColor(x.category)}>{x.category || "—"}</Chip>}
                    {x.kind === "transfer" && <Chip color="#4a6fa5">{x.from} → {x.to}</Chip>}
                    {x.kind === "income" && <Chip color="#2f6f6b">income</Chip>}
                    {x.kind === "autopay" && <Chip color="#7a5c94">statement autopay</Chip>}
                    <span className="flex-1" />
                    <span className={"font-semibold tabular-nums text-right shrink-0 " + (x.kind === "income" ? "text-brand" : "")}>
                      {x.kind === "income" ? "+" : ""}{x.isBalance ? "—" : fmtMoney(x.amount)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ============ ACCOUNTS ============ */}
        {tab === "accounts" && (
          <div className="space-y-8">
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
              <h2 className="font-serif text-2xl mb-1">Budget start date</h2>
              <p className="text-sm text-stone-500 mb-3">
                Nothing before this date counts toward credit card statement balances. Useful when starting the app partway through the year, or after paying down a card outside of what's tracked here.
              </p>
              <input type="date" className={inputCls} value={data.budgetStartDate || ""}
                onChange={e => persist({ ...data, budgetStartDate: e.target.value })} />
              {data.budgetStartDate && (
                <button onClick={() => persist({ ...data, budgetStartDate: "" })} className="ml-2 text-xs text-stone-400 hover-text-danger underline">clear</button>
              )}
            </div>

            <div>
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="font-serif text-2xl mb-1">Accounts</h2>
                  <p className="text-sm text-stone-500 mb-4">Checking, savings, and every card bills get charged to.</p>
                </div>
                <button onClick={resetAllData} className="text-xs text-stone-400 hover-text-danger underline shrink-0 mt-1">Reset all data</button>
              </div>

              {(() => {
                const groupNames = [...new Set(accounts.map(a => a.group).filter(Boolean))].sort();
                const ungrouped = accounts.filter(a => !a.group);
                const sections = [...groupNames.map(g => ({ label: g, items: accounts.filter(a => a.group === g) }))];
                if (ungrouped.length) sections.push({ label: groupNames.length ? "Ungrouped" : null, items: ungrouped });

                return (
                  <div className="space-y-5 mb-4">
                    {sections.map((section, si) => (
                      <div key={si}>
                        {section.label && <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-400 mb-2 px-1">{section.label}</h3>}
                        <div className="bg-white rounded-2xl shadow-sm border border-stone-200 divide-y divide-stone-100 overflow-hidden">
                          {section.items.sort((a, b) => a.name.localeCompare(b.name)).map(a => (
                            <div key={a.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                              <span className="font-medium flex-1 min-w-0 truncate">{a.name}</span>
                              {a.isCreditCard && <Chip color="#7a5c94">{a.statementCloseDay ? `closes ${a.statementCloseDay}` : "card"}</Chip>}
                              {a.isLoan && <Chip color="#8a7a3f">loan</Chip>}
                              {a.isCreditCard && a.autopay && <Chip color="#2f6f6b">autopay</Chip>}
                              {(() => {
                                // Live running balance for every account — cash, cards, and
                                // loans alike — so the whole financial picture is visible at a
                                // glance. Cards/loans carry a negative balance (money owed);
                                // show those in the danger tone, positive balances in muted.
                                const bal = currentAccountBalance(data, a.name, a.startingBalance);
                                const owed = a.isCreditCard || a.isLoan;
                                return <span className={"tabular-nums " + (owed && bal < 0 ? "text-rose-600" : "text-stone-500")}>{fmtMoney(bal)}</span>;
                              })()}
                              {!a.isCreditCard && !a.isLoan && a.interestRate ? <Chip color="#c9a45c">{(a.interestRate * 100).toFixed(2)}% APY</Chip> : null}
                              <button onClick={() => setModal({ kind: "account", item: a })} className="text-stone-300 hover-text-brand shrink-0"><Pencil size={14} /></button>
                              <button onClick={() => removeAccount(a.id)} className="text-stone-300 hover-text-danger shrink-0"><X size={14} /></button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              <p className="text-xs text-stone-400 mb-3">Tap the pencil on any account to set its group, or (for cards) its statement closing date and autopay.</p>
              <button onClick={() => setModal({ kind: "account", item: { id: uid(), name: "", type: "other" } })}
                className="flex items-center gap-1.5 btn-brand rounded-full px-4 py-2 text-sm font-medium">
                <Plus size={16} /> Add account
              </button>
            </div>

            {autopayCards.length > 0 && (
              <div>
                <h2 className="font-serif text-2xl mb-1">Credit card autopay, {year}</h2>
                <p className="text-sm text-stone-500 mb-4">Each statement closes, totals up everything charged to that card since the last close, and becomes the payment due the following month.</p>
                <div className="space-y-5">
                  {autopayCards.map(card => (
                    <div key={card.id} className="bg-white rounded-2xl shadow-sm border border-stone-200 overflow-x-auto">
                      <div className="flex items-center justify-between px-4 py-2.5 border-b border-stone-100">
                        <p className="font-medium text-sm">{card.name}</p>
                        <p className="text-xs text-stone-400">Closes day {card.statementCloseDay} · due day {card.paymentDueDay} · paid from {card.paymentAccount || "Checking"}</p>
                      </div>
                      <table className="w-full text-sm table-minw">
                        <thead>
                          <tr className="text-stone-500">
                            {MONTH_NAMES.map(m => <th key={m} className="text-right font-medium px-2 py-2 whitespace-nowrap">{m.slice(0, 3)}</th>)}
                            <th className="text-right font-medium px-4 py-2">Year total</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            {yearAutopay.filter(x => x.to === card.name).sort((a, b) => a.date - b.date).map((x, i) => (
                              <td key={i} className="text-right px-2 py-2 tabular-nums text-stone-600">{fmtMoney(x.amount)}</td>
                            ))}
                            <td className="text-right px-4 py-2 tabular-nums font-semibold">
                              {fmtMoney(yearAutopay.filter(x => x.to === card.name).reduce((s, x) => s + x.amount, 0))}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h2 className="font-serif text-2xl mb-1">What each account owes, {year}</h2>
              <p className="text-sm text-stone-500 mb-4">Month-by-month totals per card or account — generated automatically from the bill list, so there's no separate tab to keep in sync by hand.</p>
              {cardYearBreakdown.length === 0 ? (
                <p className="text-sm text-stone-400">No bills assigned to accounts yet.</p>
              ) : (
                <div className="bg-white rounded-2xl shadow-sm border border-stone-200 overflow-x-auto">
                  <table className="w-full text-sm table-minw">
                    <thead>
                      <tr className="border-b border-stone-200 text-stone-500">
                        <th className="text-left font-medium px-4 py-2.5 sticky left-0 bg-white">Account</th>
                        {MONTH_NAMES.map(m => <th key={m} className="text-right font-medium px-2 py-2.5 whitespace-nowrap">{m.slice(0, 3)}</th>)}
                        <th className="text-right font-medium px-4 py-2.5">Year total</th>
                        <th className="text-right font-medium px-4 py-2.5">Monthly avg</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-100">
                      {cardYearBreakdown.map(c => (
                        <tr key={c.name}>
                          <td className="px-4 py-2 font-medium sticky left-0 bg-white">{c.name}</td>
                          {c.months.map((m, i) => <td key={i} className="text-right px-2 py-2 tabular-nums text-stone-600">{m ? fmtMoney(m) : "—"}</td>)}
                          <td className="text-right px-4 py-2 tabular-nums font-semibold">{fmtMoney(c.total)}</td>
                          <td className="text-right px-4 py-2 tabular-nums text-stone-500">{fmtMoney(c.total / 12)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-stone-200 font-semibold">
                        <td className="px-4 py-2.5 sticky left-0 bg-white">Total</td>
                        {MONTH_NAMES.map((m, i) => {
                          const monthSum = cardYearBreakdown.reduce((s, c) => s + (c.months[i] || 0), 0);
                          return <td key={m} className="text-right px-2 py-2.5 tabular-nums">{monthSum ? fmtMoney(monthSum) : "—"}</td>;
                        })}
                        <td className="text-right px-4 py-2.5 tabular-nums">{fmtMoney(cardYearBreakdown.reduce((s, c) => s + c.total, 0))}</td>
                        <td className="text-right px-4 py-2.5 tabular-nums">{fmtMoney(cardYearBreakdown.reduce((s, c) => s + c.total, 0) / 12)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============ BACKUP ============ */}
        {tab === "backup" && (
          <div className="space-y-8 max-w-2xl">
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-stone-200">
              <h2 className="font-serif text-2xl mb-1">Backup</h2>
              <p className="text-sm text-stone-500 mb-3">Save everything in this app to a file, or restore from a file you saved earlier.</p>
              <div className="flex flex-wrap gap-2">
                <button onClick={exportBackup} className="flex items-center gap-1.5 border border-stone-300 rounded-full px-3.5 py-1.5 text-sm hover:bg-stone-50">
                  <Upload size={14} style={{ transform: "rotate(180deg)" }} /> Export backup
                </button>
                <button onClick={() => fileInputs.current.backup.click()} className="flex items-center gap-1.5 border border-stone-300 rounded-full px-3.5 py-1.5 text-sm hover:bg-stone-50">
                  <Upload size={14} /> Import backup
                </button>
                <input ref={el => (fileInputs.current.backup = el)} type="file" accept=".json" className="hidden"
                  onChange={e => { importBackup(e.target.files[0]); e.target.value = ""; }} />
              </div>

              <div className="mt-4 pt-4 border-t border-stone-100">
                <label className={"flex items-center gap-2 text-sm " + (AUTO_BACKUP_READY ? "" : "opacity-50")}>
                  <input type="checkbox" disabled={!AUTO_BACKUP_READY}
                    checked={!!data.autoBackupSettings?.enabled}
                    onChange={e => persist({ ...data, autoBackupSettings: { ...(data.autoBackupSettings || { frequency: "weekly", lastRun: null }), enabled: e.target.checked } })} />
                  Auto backup
                  <select className={inputCls + " ml-1"} disabled={!AUTO_BACKUP_READY || !data.autoBackupSettings?.enabled}
                    value={data.autoBackupSettings?.frequency || "weekly"}
                    onChange={e => persist({ ...data, autoBackupSettings: { ...(data.autoBackupSettings || { enabled: false, lastRun: null }), frequency: e.target.value } })}>
                    <option value="daily">daily</option>
                    <option value="weekly">weekly</option>
                    <option value="monthly">monthly</option>
                  </select>
                </label>
                {!AUTO_BACKUP_READY && (
                  <p className="text-xs text-stone-400 mt-2">Coming with the standalone version of the app — automatic file downloads aren't reliable inside this environment yet.</p>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {modal && (
        <Modal title={modalTitle(modal)} onClose={() => setModal(null)} wide>
          {modal.kind === "historyAction" && (() => {
            const t = modal.item.transaction;
            const isPending = t.status === "pending";
            return (
              <div className="space-y-1">
                <div className="pb-3 mb-2 border-b border-stone-100">
                  <p className="font-medium">{t.description || "—"}</p>
                  <p className="text-sm text-stone-500">{new Date(t.date + "T00:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })} · {fmtMoney(t.amount)}</p>
                </div>
                <button
                  onClick={() => { setTransactionStatus(t.id, isPending ? "posted" : "pending"); setModal(null); }}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left"
                ><Check size={18} className="text-brand" /> {isPending ? "Set as Cleared" : "Set as Pending"}</button>
                <button
                  onClick={() => { const copy = duplicateTransaction(t); setModal({ kind: "transaction", item: copy }); }}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left"
                ><Repeat size={18} className="text-stone-400" /> Duplicate</button>
                <button
                  onClick={() => setModal({
                    kind: t.amount < 0 ? "bill" : "income",
                    item: {
                      payee: t.description || "", account: t.account, amount: Math.abs(t.amount).toString(),
                      category: t.category || "", frequency: "monthly", dayOfMonth: new Date(t.date + "T00:00:00").getDate(),
                      dates: [], date: "", active: true, notes: "",
                    },
                  })}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left"
                ><Calendar size={18} className="text-stone-400" /> Make Scheduled</button>
                <button
                  onClick={() => setModal({ kind: "assignBudget", item: modal.item })}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left"
                ><PieIcon size={18} className="text-stone-400" /> {t.matchedBillId ? "Change budget assignment" : "Assign to budget"}</button>
                {t.amount < 0 && !t.reimbursable && (
                  <button
                    onClick={() => { updateTransactionFlags(t.id, { reimbursable: true, reimbursed: false }); setModal(null); }}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left"
                  ><Receipt size={18} className="text-stone-400" /> Mark as reimbursable business expense</button>
                )}
                {t.reimbursable && !t.reimbursed && (
                  <button
                    onClick={() => { updateTransactionFlags(t.id, { reimbursed: true }); setModal(null); }}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left"
                  ><Check size={18} className="text-brand" /> Mark as reimbursed</button>
                )}
                {t.reimbursable && (
                  <button
                    onClick={() => { updateTransactionFlags(t.id, { reimbursable: false, reimbursed: false }); setModal(null); }}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left text-stone-500"
                  ><X size={18} /> {t.reimbursed ? "Clear reimbursement tracking" : "Not a reimbursable expense"}</button>
                )}
                <button
                  onClick={() => setModal({ kind: "transaction", item: t })}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left"
                ><Pencil size={18} className="text-stone-400" /> Edit</button>
                <button
                  onClick={() => requestDeleteTransaction(t.id, t.payee || t.description)}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left text-danger"
                ><Trash2 size={18} /> Delete</button>
                <button
                  onClick={() => setModal(null)}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left text-stone-500"
                ><X size={18} /> Cancel</button>
              </div>
            );
          })()}
          {modal.kind === "confirmDelete" && (
            <div className="space-y-4">
              <p className="text-sm text-stone-600">
                Delete {modal.item?.label ? <strong>{modal.item.label}</strong> : "this item"}? This can't be undone.
              </p>
              <div className="flex justify-end gap-2">
                <button onClick={() => setModal(null)} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
                <button
                  onClick={() => {
                    if (modal.item.transactionId) deleteTransaction(modal.item.transactionId);
                    else remove(modal.item.listKey, modal.item.id);
                    setModal(null);
                  }}
                  className="px-4 py-2 rounded-lg text-sm bg-danger text-white hover:opacity-90 flex items-center gap-1.5"
                ><Trash2 size={15} /> Delete</button>
              </div>
            </div>
          )}
          {modal.kind === "bill" && <BillForm initial={modal.item} accounts={accounts} categories={categories} onSave={i => upsert("bills", i)} onCancel={() => setModal(null)} />}
          {modal.kind === "income" && <IncomeForm initial={modal.item} accounts={accounts} onSave={i => upsert("income", i)} onCancel={() => setModal(null)} />}
          {modal.kind === "transfer" && <TransferForm initial={modal.item} accounts={accounts} onSave={i => upsert("transfers", i)} onCancel={() => setModal(null)} />}
          {modal.kind === "account" && <AccountForm initial={modal.item} accounts={accounts} onSave={updateAccount} onCancel={() => setModal(null)} />}
          {modal.kind === "debt" && <DebtForm initial={modal.item} onSave={i => upsert("debts", i)} onCancel={() => setModal(null)} />}
          {modal.kind === "snowball" && <SnowballPaymentForm initial={modal.item} debts={debts} onSave={i => upsert("snowballPayments", i)} onCancel={() => setModal(null)} />}
          {modal.kind === "transaction" && (
            <TransactionEditForm
              initial={modal.item}
              accounts={accounts}
              data={data}
              onSave={i => upsert("transactions", i)}
              onSaveTransfer={addTransferTransaction}
              onConvertToTransfer={convertToTransfer}
              onSaveAdjustment={addBalanceAdjustment}
              onCancel={() => setModal(null)}
              onDelete={() => { if (modal.item?.id) deleteTransaction(modal.item.id); setModal(null); }}
            />
          )}
          {modal.kind === "registerImport" && (
            <RegisterImportModal
              accountName={modal.item.accountName}
              startingBalance={accounts.find(a => a.name === modal.item.accountName)?.startingBalance}
              onStartingBalanceChange={v => {
                const acctToUpdate = accounts.find(a => a.name === modal.item.accountName);
                if (acctToUpdate) updateAccountStartingBalance(acctToUpdate.id, v);
              }}
              onConfirm={rows => importTransactionsForAccount(modal.item.accountName, rows)}
              onCancel={() => setModal(null)}
            />
          )}
          {modal.kind === "gift" && <GiftForm initial={modal.item} accounts={accounts} knownOccasions={giftOccasionsKnown} knownRecipients={giftRecipientsKnown} onSave={i => upsert("bills", i)} onCancel={() => setModal(null)} />}
          {modal.kind === "wishlist" && <WishlistItemForm initial={modal.item} accounts={accounts} onSave={i => upsert("bills", i)} onCancel={() => setModal(null)} />}
          {modal.kind === "assignBudget" && (() => {
            const t = modal.item.transaction;
            const envelopes = data.bills.filter(b => b.isBudgetLine && b.active !== false);
            return (
              <div className="space-y-1">
                <div className="pb-3 mb-2 border-b border-stone-100">
                  <p className="font-medium">{t.description || "—"}</p>
                  <p className="text-sm text-stone-500">{new Date(t.date + "T00:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric" })} · {fmtMoney(t.amount)}</p>
                </div>
                {envelopes.length === 0 && (
                  <p className="text-sm text-stone-500 px-3 py-2">No budget lines yet — mark a bill as a "budget line / placeholder" in the Bills tab first.</p>
                )}
                {envelopes.map(b => {
                  const st = envelopeStatus(data, b, new Date(t.date + "T12:00:00"));
                  const isCurrent = t.matchedBillId === b.id;
                  return (
                    <button key={b.id}
                      onClick={() => { assignTransactionToBudget(t.id, b.id); setModal(null); }}
                      className={"w-full flex items-center gap-3 px-3 py-3 rounded-lg text-left hover:bg-stone-50 " + (isCurrent ? "bg-stone-50" : "")}>
                      <PieIcon size={16} className="text-stone-400 shrink-0" />
                      <span className="flex-1 min-w-0 truncate">{b.payee}{isCurrent ? " ✓" : ""}</span>
                      <span className={"text-xs tabular-nums shrink-0 " + (st.remaining < 0 ? "text-danger" : "text-stone-400")}>
                        {fmtMoney(st.remaining)} left of {fmtMoney(b.amount)}
                      </span>
                    </button>
                  );
                })}
                {t.matchedBillId && (
                  <button onClick={() => { assignTransactionToBudget(t.id, null); setModal(null); }}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left text-danger">
                    <X size={16} /> Remove assignment
                  </button>
                )}
                <button onClick={() => setModal(null)} className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left text-stone-500"><X size={18} /> Cancel</button>
              </div>
            );
          })()}
          {modal.kind === "upcomingAction" && (() => {
            const o = modal.item.occurrence;
            const acctName = modal.item.accountName;
            return (
              <div className="space-y-1">
                <div className="pb-3 mb-2 border-b border-stone-100">
                  <p className="font-medium">{o.description}</p>
                  <p className="text-sm text-stone-500">{o.date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })} · {fmtMoney(o.amount)}</p>
                </div>
                <button
                  onClick={() => setModal({
                    kind: "transaction",
                    item: {
                      account: acctName, txnType: o.amount < 0 ? "debit" : "credit",
                      date: `${o.date.getFullYear()}-${String(o.date.getMonth() + 1).padStart(2, "0")}-${String(o.date.getDate()).padStart(2, "0")}`,
                      amount: Math.abs(o.amount), description: o.description, category: o.category || "",
                    },
                  })}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left"
                ><Check size={18} className="text-brand" /> Log as paid</button>
                <button
                  onClick={() => { skipOccurrence(skipKey(acctName, o)); setModal(null); }}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left"
                ><Calendar size={18} className="text-stone-400" /> Skip this occurrence</button>
                <button
                  onClick={() => setModal({ kind: "editOccurrence", item: { occurrence: o, accountName: acctName } })}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left"
                ><Pencil size={18} className="text-stone-400" /> Edit</button>
                <button
                  onClick={() => setModal(null)}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-stone-50 text-left text-stone-500"
                ><X size={18} /> Cancel</button>
              </div>
            );
          })()}
          {modal.kind === "editOccurrence" && (
            <EditOccurrenceForm
              occurrence={modal.item.occurrence}
              onSaveOneTime={changes => {
                overrideOccurrence(skipKey(modal.item.accountName, modal.item.occurrence), { newAmount: changes.amount, newDate: changes.date, newDescription: changes.description });
                setModal(null);
              }}
              onSaveFuture={changes => {
                updateSourceRecord(modal.item.occurrence.sourceType, modal.item.occurrence.sourceId, changes);
                setModal(null);
              }}
              onCancel={() => setModal(null)}
            />
          )}
          {modal.kind === "registerImportMulti" && (
            <MultiAccountImportModal
              accounts={accounts}
              onConfirm={perAccountRows => importTransactionsForMultipleAccounts(perAccountRows)}
              onCancel={() => setModal(null)}
            />
          )}
        </Modal>
      )}
      {confirmDialog && (
        <Modal title="Are you sure?" onClose={() => setConfirmDialog(null)}>
          <p className="text-sm text-stone-600 mb-5">{confirmDialog.message}</p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmDialog(null)} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
            <button onClick={confirmDialog.onConfirm} style={{ background: "#c15b4a" }} className="px-4 py-2 rounded-lg text-sm text-white hover:opacity-90 flex items-center gap-1.5">
              <Check size={15} /> Continue
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function modalTitle(modal) {
  if (modal.kind === "account") return modal.item.name ? modal.item.name + " settings" : "Add account";
  if (modal.kind === "debt") return modal.item ? "Edit debt" : "Add debt";
  if (modal.kind === "snowball") return modal.item ? "Edit snowball payment" : "Add snowball payment";
  if (modal.kind === "transaction") return modal.item?.id ? "Edit transaction" : "Add transaction";
  if (modal.kind === "registerImport") return "Import transactions" + (modal.item.accountName ? " — " + modal.item.accountName : "");
  if (modal.kind === "registerImportMulti") return "Import combined CSV — all accounts";
  if (modal.kind === "gift") return modal.item ? "Edit gift" : "Add gift";
  if (modal.kind === "wishlist") return modal.item ? "Edit wishlist item" : "Add wishlist item";
  if (modal.kind === "upcomingAction") return "What would you like to do?";
  if (modal.kind === "editOccurrence") return "Edit — " + modal.item.occurrence.description;
  if (modal.kind === "historyAction") return "What would you like to do?";
  if (modal.kind === "assignBudget") return "Assign to budget line";
  if (modal.kind === "confirmDelete") return "Delete?";
  const noun = modal.kind === "bill" ? "bill" : modal.kind === "income" ? "income" : "transfer";
  return (modal.item ? "Edit " : "Add ") + noun;
}

function stripTime(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

/* ============================== SMALL COMPONENTS ============================== */

function SummaryCard({ icon: Icon, label, value, tone }) {
  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm border border-stone-200 flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: tone + "18" }}>
        <Icon size={18} style={{ color: tone }} />
      </div>
      <div>
        <p className="text-xs text-stone-500">{label}</p>
        <p className="font-serif text-xl leading-tight">{value}</p>
      </div>
    </div>
  );
}

function ListTab({ title, subtitle, addLabel, onAdd, items, renderRow }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-serif text-2xl">{title}</h2>
          <p className="text-sm text-stone-500">{subtitle}</p>
        </div>
        <button onClick={onAdd} className="flex items-center gap-1.5 btn-brand rounded-full px-4 py-2 text-sm font-medium shrink-0">
          <Plus size={16} /> {addLabel}
        </button>
      </div>
      <div className="bg-white rounded-2xl shadow-sm border border-stone-200 divide-y divide-stone-100 overflow-hidden">
        {items.length === 0 && <p className="p-6 text-sm text-stone-400 text-center">Nothing here yet. Add one, or import from your master list under Accounts &amp; Import.</p>}
        {items.map(renderRow)}
      </div>
    </div>
  );
}

function Row({ item, onEdit, onDelete, children }) {
  return (
    <div className="flex items-center gap-3 px-4 sm:px-5 py-3 text-sm hover:bg-stone-50 group">
      {item.active === false && <Chip color="#9a958a">paused</Chip>}
      <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">{children}</div>
      <div className="flex items-center gap-1 shrink-0">
        <button onClick={onEdit} className="p-1.5 text-stone-400 hover-text-brand"><Pencil size={15} /></button>
        <button onClick={onDelete} className="p-1.5 text-stone-400 hover-text-danger"><Trash2 size={15} /></button>
      </div>
    </div>
  );
}

function AddAccountForm({ onAdd }) {
  const [name, setName] = useState("");
  return (
    <div className="flex gap-2">
      <input className={inputCls + " flex-1"} placeholder="Account name (e.g. Chase Marriott Visa)" value={name} onChange={e => setName(e.target.value)} />
      <button
        onClick={() => { onAdd(name, "other"); setName(""); }}
        className="flex items-center gap-1.5 bg-stone-800 text-white rounded-lg px-3.5 py-2 text-sm hover:bg-stone-700"
      ><Plus size={15} /> Add</button>
    </div>
  );
}

function RegisterImportModal({ accountName, startingBalance, onStartingBalanceChange, onConfirm, onCancel }) {
  const [headers, setHeaders] = useState(null);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState(null);
  const [fileName, setFileName] = useState("");
  const [cutoffDate, setCutoffDate] = useState("");
  const [useSplitColumns, setUseSplitColumns] = useState(false);
  const [combineSplits, setCombineSplits] = useState(false);
  const fileRef = useRef();

  async function handleFile(file) {
    if (!file) return;
    setFileName(file.name);
    let text = await readFileAsText(file);
    // Some exports (MoneyWiz, Excel) prepend a "sep=," hint line before the
    // real header row — strip it so the first parsed row is the real header.
    text = text.replace(/^\uFEFF?sep=.\r?\n/, "");
    const parsed = Papa.parse(text.trim(), { skipEmptyLines: true });
    const all = parsed.data;
    const hdrs = all[0] || [];
    const dataRows = all.slice(1);
    setHeaders(hdrs);
    setRows(dataRows);
    const guessed = guessColumnMapping(hdrs);
    setMapping(guessed);
    setUseSplitColumns(guessed.amount < 0 && (guessed.debit >= 0 || guessed.credit >= 0));
  }

  const sampleRow = rows[0] || [];
  const colOptions = (
    <>
      <option value={-1}>— not in this file —</option>
      {(headers || []).map((h, i) => {
        const sample = String(sampleRow[i] || "").trim();
        const label = h || `Column ${i + 1}`;
        return <option key={i} value={i}>{sample ? `${label} — e.g. "${sample.slice(0, 30)}${sample.length > 30 ? "…" : ""}"` : label}</option>;
      })}
    </>
  );

  const effectiveMapping = mapping ? { ...mapping, splitGroup: combineSplits ? mapping.splitGroup : -1 } : mapping;
  const allBuilt = effectiveMapping ? buildTransactionsFromRows(rows, effectiveMapping, accountName) : [];
  const filteredBuilt = cutoffDate ? allBuilt.filter(t => t.date >= cutoffDate) : allBuilt;
  const preview = filteredBuilt.slice(0, 5);
  const skippedByDate = allBuilt.length - filteredBuilt.length;
  const canImport = mapping && mapping.date >= 0 && (mapping.amount >= 0 || mapping.debit >= 0 || mapping.credit >= 0);

  return (
    <div className="space-y-4">
      <Field label={`Starting balance for ${accountName} (before earliest imported transaction)`}>
        <input className={inputCls} value={startingBalance ?? ""} placeholder="0.00"
          onChange={e => onStartingBalanceChange(e.target.value)} />
      </Field>

      {!headers && (
        <div className="border-2 border-dashed border-stone-300 rounded-2xl p-8 text-center">
          <p className="text-sm text-stone-500 mb-3">Upload a CSV export for <strong>{accountName}</strong></p>
          <button onClick={() => fileRef.current.click()} className="btn-brand rounded-full px-4 py-2 text-sm font-medium inline-flex items-center gap-1.5">
            <Upload size={14} /> Choose file
          </button>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={e => handleFile(e.target.files[0])} />
        </div>
      )}

      {headers && mapping && (
        <>
          <p className="text-sm text-stone-500">{fileName} — {rows.length} row{rows.length === 1 ? "" : "s"} found. Each dropdown shows a real example from your file — pick the one whose example matches what you're looking for.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="1. Date">
              <select className={inputCls} value={mapping.date} onChange={e => setMapping({ ...mapping, date: parseInt(e.target.value, 10) })}>{colOptions}</select>
            </Field>
            <Field label="2. Description">
              <select className={inputCls} value={mapping.description} onChange={e => setMapping({ ...mapping, description: parseInt(e.target.value, 10) })}>{colOptions}</select>
            </Field>
            <Field label="Payee (optional)">
              <select className={inputCls} value={mapping.payee} onChange={e => setMapping({ ...mapping, payee: parseInt(e.target.value, 10) })}>{colOptions}</select>
            </Field>
            {!useSplitColumns ? (
              <Field label="3. Amount">
                <select className={inputCls} value={mapping.amount} onChange={e => setMapping({ ...mapping, amount: parseInt(e.target.value, 10) })}>{colOptions}</select>
              </Field>
            ) : (
              <>
                <Field label="3a. Debit / withdrawal column">
                  <select className={inputCls} value={mapping.debit} onChange={e => setMapping({ ...mapping, debit: parseInt(e.target.value, 10) })}>{colOptions}</select>
                </Field>
                <Field label="3b. Credit / deposit column">
                  <select className={inputCls} value={mapping.credit} onChange={e => setMapping({ ...mapping, credit: parseInt(e.target.value, 10) })}>{colOptions}</select>
                </Field>
              </>
            )}
            <Field label="4. Category (optional)">
              <select className={inputCls} value={mapping.category} onChange={e => setMapping({ ...mapping, category: parseInt(e.target.value, 10) })}>{colOptions}</select>
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm text-stone-500">
            <input type="checkbox" checked={useSplitColumns} onChange={e => {
              const checked = e.target.checked;
              setUseSplitColumns(checked);
              setMapping(checked ? { ...mapping, amount: -1 } : { ...mapping, debit: -1, credit: -1 });
            }} />
            My file has separate Debit and Credit columns instead of one Amount column
          </label>

          <label className="flex items-center gap-2 text-sm text-stone-500">
            <input type="checkbox" checked={combineSplits} onChange={e => setCombineSplits(e.target.checked)} />
            Combine split transactions (e.g. MoneyWiz breaks one payment into a row per category) into one
          </label>
          {combineSplits && (
            <Field label="Column that identifies which rows belong to the same payment">
              <select className={inputCls} value={mapping.splitGroup} onChange={e => setMapping({ ...mapping, splitGroup: parseInt(e.target.value, 10) })}>{colOptions}</select>
            </Field>
          )}

          <Field label="Only import transactions on or after (optional — great for a first-time import when the account already has a starting balance)">
            <input type="date" className={inputCls} value={cutoffDate} onChange={e => setCutoffDate(e.target.value)} />
          </Field>
          {cutoffDate && <p className="text-xs text-stone-400 -mt-2">Skipping {skippedByDate} row{skippedByDate === 1 ? "" : "s"} before {cutoffDate}. Make sure this account's Starting Balance (on the Register tab) reflects the balance right before this date.</p>}

          {preview.length > 0 && (
            <div className="border border-stone-200 rounded-xl overflow-hidden">
              <p className="text-xs font-medium text-stone-500 px-3 py-2 bg-stone-50">Preview (first {preview.length} of {filteredBuilt.length} to import)</p>
              <div className="divide-y divide-stone-100">
                {preview.map((p, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="text-stone-400 w-24 shrink-0">{p.date || "—"}</span>
                    <span className="flex-1 truncate">{txnLabel(p)}</span>
                    <span className={"font-medium tabular-nums " + (p.amount < 0 ? "text-stone-700" : "text-brand")}>{fmtMoney(p.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!canImport && <p className="text-xs text-callout">Pick at least a Date column and either an Amount column or Debit/Credit columns.</p>}
        </>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
        {headers && (
          <button
            disabled={!canImport}
            onClick={() => onConfirm(filteredBuilt)}
            className={"px-4 py-2 rounded-lg text-sm flex items-center gap-1.5 " + (canImport ? "btn-brand" : "bg-stone-200 text-stone-400")}
          ><Check size={15} /> Import {filteredBuilt.length} row{filteredBuilt.length === 1 ? "" : "s"}</button>
        )}
      </div>
    </div>
  );
}

function MultiAccountImportModal({ accounts, onConfirm, onCancel }) {
  const [headers, setHeaders] = useState(null);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState(null);
  const [fileName, setFileName] = useState("");
  const [accountColumn, setAccountColumn] = useState(-1);
  const [accountMap, setAccountMap] = useState({}); // sourceValue -> our account name (or "" to skip)
  const fileRef = useRef();

  async function handleFile(file) {
    if (!file) return;
    setFileName(file.name);
    let text = await readFileAsText(file);
    text = text.replace(/^\uFEFF?sep=.\r?\n/, "");
    const parsed = Papa.parse(text.trim(), { skipEmptyLines: true });
    const all = parsed.data;
    const hdrs = all[0] || [];
    const dataRows = all.slice(1);
    setHeaders(hdrs);
    setRows(dataRows);
    const guessed = guessColumnMapping(hdrs);
    setMapping(guessed);
    const acctColGuess = hdrs.findIndex(h => String(h || "").trim().toLowerCase() === "account");
    setAccountColumn(acctColGuess);

    // Pre-fill the account mapping by matching each decorated source name
    // (e.g. "(13)✳️Hilton Honors Aspire Card") against our real account names.
    // Strip MoneyWiz noise — leading "(NN)" numbering, emoji/symbols, and
    // registered/trademark marks — then match on the alphanumeric core. This
    // is a best-guess prefill only; the user can still override every row.
    if (acctColGuess >= 0) {
      const strip = s => String(s || "")
        .replace(/\(\d+\)/g, " ")                 // "(13)" account numbers
        .replace(/[^\p{L}\p{N}\s]/gu, " ")         // emoji, ®, ✳️, ✅, etc.
        .replace(/\s+/g, " ").trim().toLowerCase();
      const tokens = s => new Set(strip(s).split(" ").filter(w => w.length > 2));
      const seen = new Set();
      const sourceNames = [];
      dataRows.forEach(r => {
        const raw = String(r[acctColGuess] || "").trim();
        if (raw && !seen.has(raw)) { seen.add(raw); sourceNames.push(raw); }
      });
      const prefill = {};
      sourceNames.forEach(sa => {
        const saTokens = tokens(sa);
        let best = null, bestScore = 0;
        accounts.forEach(a => {
          const aTokens = tokens(a.name);
          let overlap = 0;
          saTokens.forEach(t => { if (aTokens.has(t)) overlap++; });
          // Require a meaningful shared token; prefer the highest overlap.
          if (overlap > bestScore) { bestScore = overlap; best = a.name; }
        });
        if (best && bestScore > 0) prefill[sa] = best;
      });
      setAccountMap(prefill);
    }
  }

  const sampleRow = rows[0] || [];
  const colOptions = (
    <>
      <option value={-1}>— not in this file —</option>
      {(headers || []).map((h, i) => {
        const sample = String(sampleRow[i] || "").trim();
        const label = h || `Column ${i + 1}`;
        return <option key={i} value={i}>{sample ? `${label} — e.g. "${sample.slice(0, 30)}${sample.length > 30 ? "…" : ""}"` : label}</option>;
      })}
    </>
  );

  const distinctSourceAccounts = accountColumn >= 0
    ? [...new Set(rows.map(r => String(r[accountColumn] || "").trim()).filter(Boolean))]
    : [];

  const canImport = mapping && mapping.date >= 0 && (mapping.amount >= 0 || mapping.debit >= 0 || mapping.credit >= 0) && accountColumn >= 0
    && distinctSourceAccounts.some(sa => accountMap[sa]);

  function doImport() {
    // Some exports (like this one) only print the account name once at the
    // top of each account's block of rows — every row after that has a
    // blank account column and is meant to be understood as "still the same
    // account as whatever was named most recently above it." Forward-fill
    // before grouping, or every row after the first in each block silently
    // fails to match anything.
    let lastSeenAccount = "";
    const effectiveAccountFor = rows.map(r => {
      const raw = String(r[accountColumn] || "").trim();
      if (raw) lastSeenAccount = raw;
      return lastSeenAccount;
    });

    const byDestination = {};
    rows.forEach((r, i) => {
      const dest = accountMap[effectiveAccountFor[i]];
      if (!dest) return;
      (byDestination[dest] = byDestination[dest] || []).push(r);
    });
    const perAccountRows = {};
    Object.entries(byDestination).forEach(([dest, rowsForAccount]) => {
      perAccountRows[dest] = buildTransactionsFromRows(rowsForAccount, mapping, dest);
    });
    onConfirm(perAccountRows);
  }

  return (
    <div className="space-y-4">
      {!headers && (
        <div className="border-2 border-dashed border-stone-300 rounded-2xl p-8 text-center">
          <p className="text-sm text-stone-500 mb-3">Upload a combined CSV export covering all your accounts</p>
          <button onClick={() => fileRef.current.click()} className="btn-brand rounded-full px-4 py-2 text-sm font-medium inline-flex items-center gap-1.5">
            <Upload size={14} /> Choose file
          </button>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={e => handleFile(e.target.files[0])} />
        </div>
      )}

      {headers && mapping && (
        <>
          <p className="text-sm text-stone-500">{fileName} — {rows.length} row{rows.length === 1 ? "" : "s"} found.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Which column identifies the account?">
              <select className={inputCls} value={accountColumn} onChange={e => setAccountColumn(parseInt(e.target.value, 10))}>{colOptions}</select>
            </Field>
            <Field label="Date">
              <select className={inputCls} value={mapping.date} onChange={e => setMapping({ ...mapping, date: parseInt(e.target.value, 10) })}>{colOptions}</select>
            </Field>
            <Field label="Description">
              <select className={inputCls} value={mapping.description} onChange={e => setMapping({ ...mapping, description: parseInt(e.target.value, 10) })}>{colOptions}</select>
            </Field>
            <Field label="Payee (optional)">
              <select className={inputCls} value={mapping.payee} onChange={e => setMapping({ ...mapping, payee: parseInt(e.target.value, 10) })}>{colOptions}</select>
            </Field>
            <Field label="Amount">
              <select className={inputCls} value={mapping.amount} onChange={e => setMapping({ ...mapping, amount: parseInt(e.target.value, 10) })}>{colOptions}</select>
            </Field>
            <Field label="Category (optional)">
              <select className={inputCls} value={mapping.category} onChange={e => setMapping({ ...mapping, category: parseInt(e.target.value, 10) })}>{colOptions}</select>
            </Field>
          </div>

          {accountColumn >= 0 && distinctSourceAccounts.length > 0 && (
            <div className="border border-stone-200 rounded-xl p-4">
              <p className="text-xs font-medium text-stone-500 mb-3">Match each account name in the file to one of your accounts:</p>
              <div className="space-y-3">
                {distinctSourceAccounts.map(sa => (
                  <div key={sa} className="border-b border-stone-100 pb-3 last:border-b-0 last:pb-0">
                    <p className="text-sm font-medium mb-1.5 break-words">{sa}</p>
                    <select className={inputCls} value={accountMap[sa] || ""} onChange={e => setAccountMap({ ...accountMap, [sa]: e.target.value })}>
                      <option value="">— skip this account —</option>
                      {accounts.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!canImport && <p className="text-xs text-callout">Pick the account column, date, amount, and map at least one account to import.</p>}
        </>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
        {headers && (
          <button
            disabled={!canImport}
            onClick={doImport}
            className={"px-4 py-2 rounded-lg text-sm flex items-center gap-1.5 " + (canImport ? "btn-brand" : "bg-stone-200 text-stone-400")}
          ><Check size={15} /> Import all mapped accounts</button>
        )}
      </div>
    </div>
  );
}

// Catches any uncaught error during rendering — without this, a crash deep
// in a re-render (e.g. right after a large data import) leaves the whole
// screen frozen on whatever was last drawn, unresponsive to any further
// taps, with no way out except force-quitting the app. This turns that into
// a recoverable screen instead. The underlying data is unaffected either
// way, since storage writes happen independently of whether the render
// that follows succeeds.
class LedgerErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, showDetails: false };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("The Ledger crashed during render:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f6f3ec", padding: "1.5rem", fontFamily: "-apple-system, sans-serif" }}>
          <div style={{ maxWidth: 420, textAlign: "center" }}>
            <h1 style={{ fontFamily: "Georgia, serif", fontSize: "1.6rem", color: "#233b39", marginBottom: "0.6rem" }}>Something went wrong</h1>
            <p style={{ color: "#6b6459", fontSize: "0.92rem", lineHeight: 1.5, marginBottom: "1.2rem" }}>
              Your data is safe — this only affects the current screen. Reloading almost always fixes it.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{ background: "#2f6f6b", color: "#f6f3ec", border: "none", borderRadius: 999, padding: "0.7rem 1.6rem", fontSize: "0.9rem", fontWeight: 600, cursor: "pointer" }}
            >Reload</button>
            <div style={{ marginTop: "1.4rem" }}>
              <button
                onClick={() => this.setState(s => ({ showDetails: !s.showDetails }))}
                style={{ background: "none", border: "none", color: "#9a958a", fontSize: "0.78rem", textDecoration: "underline", cursor: "pointer" }}
              >{this.state.showDetails ? "Hide" : "Show"} technical details</button>
              {this.state.showDetails && (
                <pre style={{ textAlign: "left", fontSize: "0.72rem", color: "#6b6459", background: "#ffffff", border: "1px solid #e5dfd3", borderRadius: 10, padding: "0.8rem", marginTop: "0.6rem", overflow: "auto", maxHeight: 200 }}>
                  {String(this.state.error && (this.state.error.stack || this.state.error.message || this.state.error))}
                </pre>
              )}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function FamilyBudgetApp() {
  return (
    <LedgerErrorBoundary>
      <FamilyBudgetAppInner />
    </LedgerErrorBoundary>
  );
}
