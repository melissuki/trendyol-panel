import ExcelJS from 'exceljs';
import { LINE_STATUS, UNKNOWN_CUSTOMER } from './ordersService.js';
import { formatDayLabel, weekdayLabel } from '../lib/dates.js';
import { round2 } from '../lib/money.js';
import { env } from '../config/env.js';

/**
 * EXCEL URETIMI (exceljs)
 *
 * Uretilen dosya 4 sayfadan olusur:
 *   1) "Günlük Özet"        -> gün gün satış / iptal / iade / net ciro tablosu
 *   2) "Günlük Detay"       -> ISTENEN A-H sutun yapisi, gune gore gruplu
 *   3) "İptal & İade Nedenleri" -> neden bazinda kirilim
 *   4) "Ham Veri"           -> filtrelenebilir tam veri (denetim/kontrol icin)
 */

/** Komisyon oraninin nereden geldigi - denetim izi icin. */
const RATE_SOURCE_TR = {
  settlement: 'Mutabakat (kesin)',
  orderLine: 'Sipariş satırı oranı',
  settlementObserved: 'Aynı barkodun gözlenen oranı',
  accountAverage: 'Hesap geneli ortalama',
  unknown: 'Bilinmiyor',
};

/** Iadenin kaynagi: talep kaydi mi, siparis statusu mu. */
const RETURN_SOURCE_TR = {
  claims: 'İade talebi (/claims)',
  orderStatus: 'Sipariş statüsü (teslim edilemedi)',
};

// --- Bicim sabitleri --------------------------------------------------------
const MONEY_FMT = '#,##0.00 "₺"';
const INT_FMT = '#,##0';
const PCT_FMT = '0.0"%"';

const THEME = {
  brand: 'FFF27A1A',        // Trendyol turuncusu
  headerBg: 'FF1F2937',
  headerFg: 'FFFFFFFF',
  dayBg: 'FFDBE7F3',
  dayFg: 'FF1E3A5F',
  saleFg: 'FF14532D',
  cancelBg: 'FFFDE8E8',
  cancelFg: 'FF991B1B',
  returnBg: 'FFFEF3C7',
  returnFg: 'FF92400E',
  subtotalBg: 'FFEFF6FF',
  totalBg: 'FF1F2937',
  emptyFg: 'FF9CA3AF',
  border: 'FFD1D5DB',
  positive: 'FF15803D',
  negative: 'FFB91C1C',
};

const THIN_BORDER = {
  top: { style: 'thin', color: { argb: THEME.border } },
  left: { style: 'thin', color: { argb: THEME.border } },
  bottom: { style: 'thin', color: { argb: THEME.border } },
  right: { style: 'thin', color: { argb: THEME.border } },
};

const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

/**
 * ExcelJS bir hucreye obje/dizi yazilmaya calisildiginda ya patlar ya da
 * "[object Object]" yazar. Musteri adi gibi API'den gelen serbest metin
 * alanlarini hucreye koymadan once daima buradan geciriyoruz.
 *
 * @param {unknown} value  API'den gelen ham deger
 * @param {string}  fallback  deger kullanilamazsa yazilacak metin
 */
function safeText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : fallback;
  if (typeof value === 'boolean') return fallback;
  if (Array.isArray(value)) {
    const joined = value.map((item) => safeText(item)).filter(Boolean).join(' ');
    return joined || fallback;
  }
  return fallback;
}

function styleHeaderRow(row, { bg = THEME.headerBg, fg = THEME.headerFg, height = 26 } = {}) {
  row.height = height;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: fg }, size: 11, name: 'Calibri' };
    cell.fill = fill(bg);
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = THIN_BORDER;
  });
}

/**
 * Sutun genisliklerini icerige gore otomatik ayarlar.
 * Birlestirilmis hucreler (baslik bandi, gun bandi) HESABA KATILMAZ: exceljs
 * birlesmis bir hucrenin degerini kapsadigi tum sutunlar icin dondurur ve
 * bu da her sutunu gereksiz yere maksimuma sisirir.
 */
function autoFitColumns(sheet, { min = 10, max = 55, padding = 3 } = {}) {
  sheet.columns.forEach((column) => {
    let longest = min;
    column.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.isMerged) return;

      let value = cell.value;
      if (value && typeof value === 'object') {
        value = value.richText
          ? value.richText.map((t) => t.text).join('')
          : (value.result ?? value.text ?? value.formula ?? '');
      }
      const text = value === null || value === undefined ? '' : String(value);
      const width = Math.max(0, ...text.split('\n').map((l) => l.length));
      // Para hucrelerinde bicimlenmis metin ham sayidan uzundur (binlik ayraci, ₺)
      const bonus = typeof cell.value === 'number' && String(cell.numFmt ?? '').includes('₺') ? 5 : 0;
      if (width + bonus > longest) longest = width + bonus;
    });
    column.width = Math.min(max, longest + padding);
  });
}

function statusStyle(status) {
  if (status === LINE_STATUS.CANCELLED) return { bg: THEME.cancelBg, fg: THEME.cancelFg };
  if (status === LINE_STATUS.RETURNED) return { bg: THEME.returnBg, fg: THEME.returnFg };
  return { bg: null, fg: THEME.saleFg };
}

// ---------------------------------------------------------------------------
// 1) GÜNLÜK ÖZET
// ---------------------------------------------------------------------------
function buildSummarySheet(workbook, report) {
  const sheet = workbook.addWorksheet('Günlük Özet', {
    views: [{ state: 'frozen', ySplit: 14 }],
    properties: { defaultRowHeight: 18 },
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  sheet.mergeCells('A1:I1');
  const title = sheet.getCell('A1');
  title.value = 'TRENDYOL ÜRÜN BAZLI GÜNLÜK SATIŞ RAPORU';
  title.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  title.fill = fill(THEME.brand);
  title.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(1).height = 32;

  const info = [
    ['Ürün Adı', report.product.productName],
    ['Barkod', report.product.barcode],
    ['Stok Kodu (SKU)', report.product.merchantSku || '-'],
    ['Rapor Aralığı', `${formatDayLabel(report.range.startDate)} — ${formatDayLabel(report.range.endDate)}`],
    ['Oluşturulma', report.meta.generatedAt],
    ['Tutar Kaynağı', 'Hibrit: mutabakat kaydı varsa kesin tutar, yoksa siparişteki gerçek komisyon oranı'],
    ['KESİNLEŞMİŞ Satır', `${report.meta.settledRows} satır (Trendyol mutabakat kaydından)`],
    ['TAHMİNİ Satır', `${report.meta.estimatedRows} satır (siparişin kendi komisyon oranıyla hesaplandı)`],
    ['Oranı Bilinmeyen Satır', `${report.meta.unknownRows} satır`],
    ['İade Kargo Bedeli', `${report.meta.returnShippingFee} ₺ / adet (yalnızca İADE satırlarına uygulanır)`],
  ];

  info.forEach(([label, value], index) => {
    const rowIndex = index + 2;
    sheet.getCell(`A${rowIndex}`).value = label;
    sheet.getCell(`A${rowIndex}`).font = { bold: true, color: { argb: 'FF374151' } };
    sheet.mergeCells(`B${rowIndex}:D${rowIndex}`);
    sheet.getCell(`B${rowIndex}`).value = value;
    sheet.getCell(`B${rowIndex}`).alignment = { horizontal: 'left' };
  });

  /**
   * MALI MUSAVIR (CPA) DENETIM KIRILIMI  (F2:G12)
   * Iptal/iade edilen tutar GORUNMEZ SEKILDE dusulmez; her adim ayri satirdir:
   *   1) İlk Brüt Ciro  −  2) İptal/İade  =  3) Net Satış
   *   3) Net Satış      −  4) Komisyon+Kargo  =  5) NET CİRO
   */
  const t = report.totals;
  const kpis = [
    ['1) İlk Brüt Ciro (tümü)', t.totalGrossRevenue, MONEY_FMT, 'step'],
    ['2) (−) İptal / İade Edilen', t.cancelledReturnedGross, MONEY_FMT, 'minus'],
    ['3) (=) Net Satış', t.netSales, MONEY_FMT, 'subtotal'],
    ['4) (−) Komisyon ve Kargo', t.deductions, MONEY_FMT, 'minus'],
    ['5) (=) NET CİRO', t.netRevenue, MONEY_FMT, 'net'],
    ['', null, null, 'spacer'],
    ['Sipariş (benzersiz)', t.orderCount, INT_FMT, 'count'],
    ['Satılan Adet', t.quantitySold, INT_FMT, 'count'],
    ['İptal Adedi', t.quantityCancelled, INT_FMT, 'count'],
    ['İade Adedi', t.quantityReturned, INT_FMT, 'count'],
    ['Farklı Müşteri', t.customerCount, INT_FMT, 'count'],
  ];
  kpis.forEach(([label, value, format, kind], index) => {
    const rowIndex = index + 2;
    const labelCell = sheet.getCell(`F${rowIndex}`);
    const valueCell = sheet.getCell(`G${rowIndex}`);
    if (kind === 'spacer') return;

    labelCell.value = label;
    labelCell.font = { bold: kind === 'net' || kind === 'subtotal', color: { argb: 'FF374151' } };
    valueCell.value = value;
    valueCell.numFmt = format;
    valueCell.font = {
      bold: true,
      size: kind === 'net' ? 13 : 11,
      color: {
        argb:
          kind === 'net'
            ? value >= 0
              ? THEME.positive
              : THEME.negative
            : kind === 'minus'
              ? THEME.negative
              : 'FF111827',
      },
    };
    if (kind === 'subtotal' || kind === 'net') {
      labelCell.fill = fill(THEME.subtotalBg);
      valueCell.fill = fill(THEME.subtotalBg);
    }
    labelCell.border = THIN_BORDER;
    valueCell.border = THIN_BORDER;
  });

  const headerRowIndex = 14; // KPI kutusu 2-12 satirlarini kaplar
  sheet.getRow(headerRowIndex).values = [
    'Gün',
    'Haftanın Günü',
    'Satılan Adet',
    'Brüt Ciro',
    'İptal Adedi',
    'İade Adedi',
    'İade Tutarı',
    'Kesintiler',
    'Net Ciro',
  ];
  styleHeaderRow(sheet.getRow(headerRowIndex));

  let cursor = headerRowIndex + 1;
  for (const day of report.days) {
    const d = day.totals;
    const row = sheet.getRow(cursor);
    row.values = [
      formatDayLabel(day.date),
      weekdayLabel(day.date, report.range.timeZone),
      d.quantitySold,
      d.grossSales,
      d.quantityCancelled,
      d.quantityReturned,
      d.returnedAmount,
      d.deductions,
      d.netRevenue,
    ];
    row.getCell(3).numFmt = INT_FMT;
    row.getCell(4).numFmt = MONEY_FMT;
    row.getCell(5).numFmt = INT_FMT;
    row.getCell(6).numFmt = INT_FMT;
    row.getCell(7).numFmt = MONEY_FMT;
    row.getCell(8).numFmt = MONEY_FMT;
    row.getCell(9).numFmt = MONEY_FMT;
    row.getCell(9).font = { bold: true, color: { argb: d.netRevenue >= 0 ? THEME.positive : THEME.negative } };

    const isEmptyDay = day.rows.length === 0;
    row.eachCell((cell, col) => {
      cell.border = THIN_BORDER;
      if (isEmptyDay) cell.font = { ...(cell.font ?? {}), color: { argb: THEME.emptyFg } };
      if (col >= 3) cell.alignment = { horizontal: 'right' };
    });
    if (d.quantityCancelled > 0 || d.quantityReturned > 0) {
      row.getCell(5).font = { bold: d.quantityCancelled > 0, color: { argb: THEME.cancelFg } };
      row.getCell(6).font = { bold: d.quantityReturned > 0, color: { argb: THEME.returnFg } };
    }
    cursor += 1;
  }

  // Genel toplam satiri
  const totalRow = sheet.getRow(cursor);
  totalRow.values = [
    'GENEL TOPLAM',
    '',
    t.quantitySold,
    t.grossSales,
    t.quantityCancelled,
    t.quantityReturned,
    t.returnedAmount,
    t.deductions,
    t.netRevenue,
  ];
  totalRow.eachCell((cell, col) => {
    cell.font = { bold: true, color: { argb: THEME.headerFg }, size: 11 };
    cell.fill = fill(THEME.totalBg);
    cell.border = THIN_BORDER;
    if (col >= 3) cell.alignment = { horizontal: 'right' };
    if ([4, 7, 8, 9].includes(col)) cell.numFmt = MONEY_FMT;
    if ([3, 5, 6].includes(col)) cell.numFmt = INT_FMT;
  });
  totalRow.height = 24;

  sheet.autoFilter = { from: { row: headerRowIndex, column: 1 }, to: { row: cursor - 1, column: 9 } };
  autoFitColumns(sheet, { min: 12, max: 40 });
  return sheet;
}

// ---------------------------------------------------------------------------
// 2) GÜNLÜK DETAY  (gün gün, sipariş sipariş)
// ---------------------------------------------------------------------------

/**
 * Sutun haritasi tek yerde tutulur; formul/hizalama/bicim mantigi bu haritadan
 * turedigi icin ileride sutun eklenirken yalnizca burasi ve DETAIL_COLUMNS degisir.
 */
const DETAIL_COLUMNS = [
  { key: 'SEQ', header: 'Sıra', width: 7, type: 'seq' },
  { key: 'DAY', header: 'Gün', width: 13, type: 'text' },
  { key: 'TIME', header: 'Saat', width: 8, type: 'text' },
  { key: 'STATUS', header: 'Sipariş Durumu', width: 16, type: 'text' },
  { key: 'ORDER_NO', header: 'Sipariş No', width: 20, type: 'text' },
  { key: 'CUSTOMER', header: 'Müşteri Adı Soyadı', width: 24, type: 'text' },
  { key: 'VARIANT', header: 'Beden/Varyant', width: 14, type: 'text' },
  { key: 'QUANTITY', header: 'Adet', width: 8, type: 'int' },
  { key: 'UNIT_PRICE', header: 'Birim Fiyat', width: 14, type: 'money' },
  { key: 'GROSS', header: 'Brüt Tutar', width: 15, type: 'money' },
  { key: 'COMMISSION', header: 'Komisyon', width: 14, type: 'money' },
  { key: 'SHIPPING', header: 'Kargo/Hizmet', width: 14, type: 'money' },
  { key: 'DEDUCTIONS', header: 'Kesintiler', width: 15, type: 'money' },
  { key: 'NET', header: 'Net Ciro', width: 15, type: 'money' },
  { key: 'SETTLED', header: 'Değerleme', width: 14, type: 'text' },
  { key: 'RATE', header: 'Kom. Oranı', width: 11, type: 'text' },
  { key: 'REASON', header: 'İptal/İade Nedeni', width: 42, type: 'text' },
];

/** { SEQ: 1, DAY: 2, ... } -> 1 tabanli sutun indeksleri */
const DETAIL_COL = Object.fromEntries(DETAIL_COLUMNS.map((column, index) => [column.key, index + 1]));
const DETAIL_LAST_COL = DETAIL_COLUMNS.length;
/** 1 -> 'A', 14 -> 'N' */
const colLetter = (index) => {
  let n = index;
  let letter = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
};
const DETAIL_LAST_LETTER = colLetter(DETAIL_LAST_COL);

const MONEY_COLS = DETAIL_COLUMNS.flatMap((c, i) => (c.type === 'money' ? [i + 1] : []));
const NUMERIC_COLS = DETAIL_COLUMNS.flatMap((c, i) => (['money', 'int'].includes(c.type) ? [i + 1] : []));
/** Gun ara toplaminda SUM() alinacak sutunlar */
const SUMMABLE_COLS = [DETAIL_COL.QUANTITY, DETAIL_COL.GROSS, DETAIL_COL.COMMISSION, DETAIL_COL.SHIPPING, DETAIL_COL.DEDUCTIONS, DETAIL_COL.NET];

function applyDetailNumberFormats(row) {
  DETAIL_COLUMNS.forEach((column, index) => {
    if (column.type === 'money') row.getCell(index + 1).numFmt = MONEY_FMT;
    if (column.type === 'int' || column.type === 'seq') row.getCell(index + 1).numFmt = INT_FMT;
  });
}

function buildDetailSheet(workbook, report) {
  const sheet = workbook.addWorksheet('Günlük Detay', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  sheet.mergeCells(`A1:${DETAIL_LAST_LETTER}1`);
  const title = sheet.getCell('A1');
  title.value = `${report.product.productName}  •  ${report.product.barcode}  •  ${formatDayLabel(report.range.startDate)} - ${formatDayLabel(report.range.endDate)}`;
  title.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
  title.fill = fill(THEME.brand);
  title.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(1).height = 26;

  const headerRow = sheet.getRow(2);
  headerRow.values = DETAIL_COLUMNS.map((column) => column.header);
  styleHeaderRow(headerRow, { height: 30 });

  let cursor = 3;

  for (const day of report.days) {
    // --- Gün başlığı (birleştirilmiş bant) ---
    const dayHeader = sheet.getRow(cursor);
    sheet.mergeCells(`A${cursor}:${DETAIL_LAST_LETTER}${cursor}`);
    const label = `${formatDayLabel(day.date)} — ${weekdayLabel(day.date, report.range.timeZone)}`;
    const summary = day.rows.length === 0
      ? '  |  Hareket yok'
      : `  |  ${day.rows.length} hareket  •  ${day.totals.orderCount} sipariş  •  ${day.totals.customerCount} müşteri` +
        `  •  Satış: ${day.totals.quantitySold} adet  •  İptal: ${day.totals.quantityCancelled}  •  İade: ${day.totals.quantityReturned}`;
    dayHeader.getCell(1).value = label + summary;
    dayHeader.getCell(1).font = {
      bold: true,
      size: 11,
      color: { argb: day.rows.length === 0 ? THEME.emptyFg : THEME.dayFg },
    };
    dayHeader.getCell(1).fill = fill(THEME.dayBg);
    dayHeader.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    dayHeader.height = 22;
    for (let col = 1; col <= DETAIL_LAST_COL; col += 1) sheet.getCell(cursor, col).border = THIN_BORDER;
    cursor += 1;

    const firstDataRow = cursor;

    // --- Gün içindeki her sipariş satırı, saate göre sıralı ve numaralı ---
    for (const row of day.rows) {
      const excelRow = sheet.getRow(cursor);
      excelRow.values = [
        row.sequence,
        formatDayLabel(row.day),
        row.eventTime || '',
        row.statusLabel,
        String(row.orderNumber),
        safeText(row.customerFullName, '—'),
        safeText(row.variantLabel || row.productSize, '—'),
        row.quantity,
        row.unitPrice,
        row.grossAmount,
        row.commission,
        round2(row.shippingFee + row.returnShippingFee),
        row.deductions,
        row.netRevenue,
        row.valuationLabel ?? (row.settled ? 'Kesinleşmiş' : 'Tahmini'),
        row.commissionRate === null || row.commissionRate === undefined ? '—' : `%${round2(row.commissionRate)}`,
        row.reason || '',
      ];
      applyDetailNumberFormats(excelRow);

      const { bg, fg } = statusStyle(row.status);
      excelRow.eachCell({ includeEmpty: true }, (cell, col) => {
        cell.border = THIN_BORDER;
        if (bg) cell.fill = fill(bg);
        cell.alignment = {
          vertical: 'middle',
          horizontal: NUMERIC_COLS.includes(col)
            ? 'right'
            : [DETAIL_COL.SEQ, DETAIL_COL.DAY, DETAIL_COL.TIME, DETAIL_COL.STATUS].includes(col)
              ? 'center'
              : 'left',
          wrapText: col === DETAIL_COL.REASON,
        };
      });

      excelRow.getCell(DETAIL_COL.SEQ).font = { color: { argb: 'FF9CA3AF' }, size: 10 };
      excelRow.getCell(DETAIL_COL.STATUS).font = { bold: true, color: { argb: fg } };
      excelRow.getCell(DETAIL_COL.NET).font = {
        bold: true,
        color: { argb: row.netRevenue > 0 ? THEME.positive : row.netRevenue < 0 ? THEME.negative : 'FF6B7280' },
      };
      if (row.status !== LINE_STATUS.SALE) {
        excelRow.getCell(DETAIL_COL.REASON).font = { color: { argb: fg }, italic: true };
      }
      cursor += 1;
    }

    // --- Gün ara toplamı (canlı SUM formülleri) ---
    const subtotal = sheet.getRow(cursor);
    subtotal.getCell(DETAIL_COL.DAY).value = 'Gün Toplamı';
    subtotal.getCell(DETAIL_COL.TIME).value = '';
    subtotal.getCell(DETAIL_COL.STATUS).value = `${day.rows.length} hareket`;
    subtotal.getCell(DETAIL_COL.ORDER_NO).value = `${day.totals.orderCount} sipariş`;
    subtotal.getCell(DETAIL_COL.CUSTOMER).value = `${day.totals.customerCount} müşteri`;

    if (day.rows.length > 0) {
      const last = cursor - 1;
      const results = {
        [DETAIL_COL.QUANTITY]: day.totals.quantitySold + day.totals.quantityCancelled + day.totals.quantityReturned,
        [DETAIL_COL.GROSS]: day.totals.grossSales + day.totals.cancelledAmount + day.totals.returnedAmount,
        [DETAIL_COL.COMMISSION]: day.totals.commission,
        [DETAIL_COL.SHIPPING]: day.totals.shippingFee,
        [DETAIL_COL.DEDUCTIONS]: day.totals.deductions,
        [DETAIL_COL.NET]: day.totals.netRevenue,
      };
      SUMMABLE_COLS.forEach((col) => {
        const letter = colLetter(col);
        subtotal.getCell(col).value = {
          formula: `SUM(${letter}${firstDataRow}:${letter}${last})`,
          result: results[col],
        };
      });
    } else {
      SUMMABLE_COLS.forEach((col) => {
        subtotal.getCell(col).value = 0;
      });
    }
    subtotal.getCell(DETAIL_COL.REASON).value =
      day.totals.quantityCancelled + day.totals.quantityReturned > 0
        ? `${day.totals.quantityCancelled + day.totals.quantityReturned} adet iptal/iade`
        : '';

    applyDetailNumberFormats(subtotal);
    subtotal.getCell(DETAIL_COL.SEQ).numFmt = undefined;
    subtotal.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.fill = fill(THEME.subtotalBg);
      cell.border = THIN_BORDER;
      cell.font = {
        bold: true,
        color: {
          argb: col === DETAIL_COL.NET
            ? (day.totals.netRevenue >= 0 ? THEME.positive : THEME.negative)
            : 'FF1F2937',
        },
      };
      cell.alignment = {
        vertical: 'middle',
        horizontal: NUMERIC_COLS.includes(col) ? 'right' : 'left',
        indent: col === DETAIL_COL.DAY ? 1 : 0,
      };
    });
    subtotal.height = 20;
    cursor += 2; // gruplar arası boşluk
  }

  // --- Genel toplam ---
  const t = report.totals;
  const totalRow = sheet.getRow(cursor);
  totalRow.values = [
    '',
    'GENEL TOPLAM',
    '',
    `${report.rows.length} hareket`,
    `${t.orderCount} sipariş`,
    `${t.customerCount} müşteri`,
    t.quantitySold + t.quantityCancelled + t.quantityReturned,
    null,
    t.grossSales + t.cancelledAmount + t.returnedAmount,
    t.commission,
    t.shippingFee,
    t.deductions,
    t.netRevenue,
    `Satış: ${t.quantitySold} • İptal: ${t.quantityCancelled} • İade: ${t.quantityReturned}`,
  ];
  totalRow.height = 26;
  applyDetailNumberFormats(totalRow);
  totalRow.getCell(DETAIL_COL.SEQ).numFmt = undefined;
  totalRow.eachCell({ includeEmpty: true }, (cell, col) => {
    cell.fill = fill(THEME.totalBg);
    cell.font = { bold: true, size: 11, color: { argb: THEME.headerFg } };
    cell.border = THIN_BORDER;
    cell.alignment = {
      vertical: 'middle',
      horizontal: NUMERIC_COLS.includes(col) ? 'right' : 'left',
      indent: col === DETAIL_COL.DAY ? 1 : 0,
    };
  });

  // Uyarı notları
  if (report.meta.warnings.length > 0) {
    cursor += 2;
    for (const warning of report.meta.warnings) {
      sheet.mergeCells(`A${cursor}:${DETAIL_LAST_LETTER}${cursor}`);
      const cell = sheet.getCell(`A${cursor}`);
      cell.value = `ⓘ ${warning}`;
      cell.font = { italic: true, size: 10, color: { argb: THEME.returnFg } };
      cell.alignment = { horizontal: 'left', indent: 1 };
      cursor += 1;
    }
  }

  // Taban genişlikler DETAIL_COLUMNS'tan gelir; içerik daha uzunsa otomatik büyür
  autoFitColumns(sheet, { min: 7, max: 46 });
  DETAIL_COLUMNS.forEach((column, index) => {
    const sheetColumn = sheet.getColumn(index + 1);
    sheetColumn.width = Math.max(sheetColumn.width ?? 0, column.width);
  });
  return sheet;
}

// ---------------------------------------------------------------------------
// 3) İPTAL & İADE NEDENLERİ
// ---------------------------------------------------------------------------
function buildReasonSheet(workbook, report) {
  const sheet = workbook.addWorksheet('İptal & İade Nedenleri', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.getRow(1).values = ['Tür', 'İptal / İade Nedeni', 'Kayıt Sayısı', 'Adet', 'Tutar', 'Pay (%)'];
  styleHeaderRow(sheet.getRow(1));

  if (report.reasons.length === 0) {
    sheet.mergeCells('A2:F2');
    const cell = sheet.getCell('A2');
    cell.value = 'Bu dönemde iptal veya iade kaydı bulunmuyor. 🎉';
    cell.font = { italic: true, color: { argb: THEME.positive } };
    cell.alignment = { horizontal: 'center' };
  }

  report.reasons.forEach((reason, index) => {
    const row = sheet.getRow(index + 2);
    row.values = [reason.statusLabel, reason.reason, reason.count, reason.quantity, reason.amount, reason.share];
    row.getCell(3).numFmt = INT_FMT;
    row.getCell(4).numFmt = INT_FMT;
    row.getCell(5).numFmt = MONEY_FMT;
    row.getCell(6).numFmt = PCT_FMT;

    const { bg, fg } = statusStyle(reason.status);
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.border = THIN_BORDER;
      if (bg) cell.fill = fill(bg);
      cell.alignment = { vertical: 'middle', horizontal: col >= 3 ? 'right' : 'left', wrapText: col === 2 };
    });
    row.getCell(1).font = { bold: true, color: { argb: fg } };
  });

  if (report.reasons.length > 0) {
    const totalRowIndex = report.reasons.length + 2;
    const totalRow = sheet.getRow(totalRowIndex);
    totalRow.values = [
      'TOPLAM',
      '',
      report.reasons.reduce((s, r) => s + r.count, 0),
      report.reasons.reduce((s, r) => s + r.quantity, 0),
      report.reasons.reduce((s, r) => s + r.amount, 0),
      100,
    ];
    totalRow.getCell(5).numFmt = MONEY_FMT;
    totalRow.getCell(6).numFmt = PCT_FMT;
    totalRow.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.fill = fill(THEME.totalBg);
      cell.font = { bold: true, color: { argb: THEME.headerFg } };
      cell.border = THIN_BORDER;
      cell.alignment = { horizontal: col >= 3 ? 'right' : 'left' };
    });
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: totalRowIndex - 1, column: 6 } };
  }

  autoFitColumns(sheet, { min: 12, max: 60 });
  return sheet;
}

// ---------------------------------------------------------------------------
// 4) VARYANT / BEDEN KIRILIMI
// Ana urun raporunda bedenler panelde tek satirda toplanir; DENETIM icin
// beden bazli kirilim burada AYNEN korunur.
// ---------------------------------------------------------------------------
function buildVariantSheet(workbook, report) {
  const sheet = workbook.addWorksheet('Varyant Kırılımı', { views: [{ state: 'frozen', ySplit: 2 }] });

  const columns = [
    { header: 'Beden/Varyant', key: 'variantLabel', width: 16 },
    { header: 'Varyant Adı', key: 'productName', width: 40 },
    { header: 'Barkod', key: 'barcode', width: 20 },
    { header: 'Satılan Adet', key: 'quantitySold', width: 13 },
    { header: 'İptal Adet', key: 'quantityCancelled', width: 12 },
    { header: 'İade Adet', key: 'quantityReturned', width: 12 },
    { header: 'Brüt Satış', key: 'grossSales', width: 15 },
    { header: 'Komisyon', key: 'commission', width: 14 },
    { header: 'Kargo/Hizmet', key: 'shipping', width: 14 },
    { header: 'İptal/İade Brütü (hariç)', key: 'excluded', width: 22 },
    { header: 'Net Ciro', key: 'netRevenue', width: 15 },
    { header: 'Kesinleşmiş Satır', key: 'settledRows', width: 17 },
    { header: 'Tahmini Satır', key: 'estimatedRows', width: 14 },
  ];

  sheet.mergeCells(1, 1, 1, columns.length);
  const title = sheet.getCell('A1');
  title.value = `${report.product.productName} — beden/varyant bazında kırılım`;
  title.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
  title.fill = fill(THEME.brand);
  title.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(1).height = 24;

  const headerRow = sheet.getRow(2);
  headerRow.values = columns.map((c) => c.header);
  styleHeaderRow(headerRow, { height: 28 });
  columns.forEach((c, i) => { sheet.getColumn(i + 1).width = c.width; });

  // Satirlari varyant bazinda topla
  const byVariant = new Map();
  for (const row of report.rows) {
    const key = row.barcode || row.variantLabel || row.productName || '—';
    if (!byVariant.has(key)) {
      byVariant.set(key, {
        variantLabel: safeText(row.variantLabel || row.productSize, '—'),
        productName: safeText(row.productName, '—'),
        barcode: safeText(row.barcode, '—'),
        quantitySold: 0, quantityCancelled: 0, quantityReturned: 0,
        grossSales: 0, commission: 0, shipping: 0, excluded: 0, netRevenue: 0,
        settledRows: 0, estimatedRows: 0,
      });
    }
    const entry = byVariant.get(key);
    // IPTAL ve IADE ayri kovalarda tutulur - hicbir zaman toplanmaz
    if (row.status === LINE_STATUS.CANCELLED) entry.quantityCancelled += row.quantity;
    else if (row.status === LINE_STATUS.RETURNED) entry.quantityReturned += row.quantity;
    else if (row.status === LINE_STATUS.SALE) entry.quantitySold += row.quantity;

    entry.grossSales += row.grossSales ?? 0;
    entry.commission += row.commission ?? 0;
    entry.shipping += row.shipping ?? 0;
    entry.excluded += row.excludedAmount ?? row.excluded ?? 0;
    entry.netRevenue += row.netRevenue ?? 0;
    if (row.settled) entry.settledRows += 1;
    else if (row.valuationBasis === 'estimate') entry.estimatedRows += 1;
  }

  const list = [...byVariant.values()]
    .map((v) => ({
      ...v,
      grossSales: round2(v.grossSales), commission: round2(v.commission),
      shipping: round2(v.shipping), excluded: round2(v.excluded), netRevenue: round2(v.netRevenue),
    }))
    .sort((a, b) => b.grossSales - a.grossSales);

  const moneyKeys = ['grossSales', 'commission', 'shipping', 'excluded', 'netRevenue'];
  // Sutun anahtari yerine KONUMA gore yaziyoruz: bu sayfada `sheet.columns`
  // tanimli degil (1. satir birlestirilmis baslik bandi), bu yuzden
  // addRow(obje) eslesmez ve satirlar bos kalirdi.
  const toArray = (v) => columns.map((column) => v[column.key]);

  const applyFormats = (excelRow) => {
    excelRow.eachCell({ includeEmpty: true }, (cell) => { cell.border = THIN_BORDER; });
    columns.forEach((column, index) => {
      if (moneyKeys.includes(column.key)) excelRow.getCell(index + 1).numFmt = MONEY_FMT;
      else if (column.key.startsWith('quantity') || column.key.endsWith('Rows')) {
        excelRow.getCell(index + 1).numFmt = INT_FMT;
      }
    });
  };

  for (const variant of list) {
    applyFormats(sheet.addRow(toArray(variant)));
  }

  // Toplam satiri: varyantlarin toplami ana urun toplamina ESIT olmali
  const totalRow = sheet.addRow(toArray({
    variantLabel: 'TOPLAM',
    productName: `${list.length} varyant`,
    barcode: '',
    quantitySold: list.reduce((s, v) => s + v.quantitySold, 0),
    quantityCancelled: list.reduce((s, v) => s + v.quantityCancelled, 0),
    quantityReturned: list.reduce((s, v) => s + v.quantityReturned, 0),
    grossSales: round2(list.reduce((s, v) => s + v.grossSales, 0)),
    commission: round2(list.reduce((s, v) => s + v.commission, 0)),
    shipping: round2(list.reduce((s, v) => s + v.shipping, 0)),
    excluded: round2(list.reduce((s, v) => s + v.excluded, 0)),
    netRevenue: round2(list.reduce((s, v) => s + v.netRevenue, 0)),
    settledRows: list.reduce((s, v) => s + v.settledRows, 0),
    estimatedRows: list.reduce((s, v) => s + v.estimatedRows, 0),
  }));
  applyFormats(totalRow);
  totalRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = fill(THEME.totalBg);
  });

  sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: columns.length } };
  return sheet;
}

// ---------------------------------------------------------------------------
// 5) HAM VERİ
// ---------------------------------------------------------------------------
function buildRawSheet(workbook, report) {
  const sheet = workbook.addWorksheet('Ham Veri', { views: [{ state: 'frozen', ySplit: 1 }] });

  const columns = [
    { header: 'Gün', key: 'day', width: 12 },
    { header: 'Sipariş Tarihi', key: 'orderDateText', width: 18 },
    { header: 'İşlem Tarihi', key: 'eventDateText', width: 18 },
    { header: 'Durum', key: 'statusLabel', width: 12 },
    { header: 'Trendyol Statüsü', key: 'rawLineStatus', width: 20 },
    { header: 'Sipariş No', key: 'orderNumber', width: 20 },
    { header: 'Müşteri Adı', key: 'customerFirstName', width: 16 },
    { header: 'Müşteri Soyadı', key: 'customerLastName', width: 16 },
    { header: 'Müşteri Adı Soyadı', key: 'customerFullName', width: 24 },
    { header: 'Paket No', key: 'packageId', width: 16 },
    { header: 'Sipariş Satır ID', key: 'orderLineId', width: 18 },
    { header: 'Ana Ürün', key: 'parentName', width: 34 },
    { header: 'Varyant Adı', key: 'productName', width: 34 },
    { header: 'Barkod', key: 'barcode', width: 18 },
    { header: 'Stok Kodu', key: 'merchantSku', width: 18 },
    { header: 'Beden/Varyant', key: 'variantLabel', width: 14 },
    { header: 'Beden', key: 'productSize', width: 10 },
    { header: 'Renk', key: 'productColor', width: 12 },
    { header: 'Adet', key: 'quantity', width: 8 },
    { header: 'Birim Fiyat', key: 'unitPrice', width: 14 },
    { header: 'Brüt Tutar', key: 'grossAmount', width: 14 },
    { header: 'Komisyon (Mutabakat)', key: 'commission', width: 20 },
    { header: 'İade Edilen Komisyon', key: 'commissionRefunded', width: 20 },
    { header: 'Kargo/Hizmet', key: 'shippingFee', width: 13 },
    { header: 'İade Kargo', key: 'returnShippingFee', width: 12 },
    { header: 'Toplam Kesinti', key: 'deductions', width: 15 },
    { header: 'Net Ciro', key: 'netRevenue', width: 14 },
    { header: 'Değerleme', key: 'valuationLabel', width: 14 },
    { header: 'Komisyon Oranı (%)', key: 'commissionRatePct', width: 18 },
    { header: 'Oran Kaynağı', key: 'commissionSourceText', width: 20 },
    { header: 'İade Kaynağı', key: 'returnSourceText', width: 16 },
    { header: 'Bekleyen İade Adedi', key: 'returnPendingQuantity', width: 18 },
    { header: 'Değerleme Notu', key: 'settlementNote', width: 40 },
    { header: 'İşlem Tipleri', key: 'transactionTypeText', width: 24 },
    { header: 'İptal/İade Nedeni', key: 'reason', width: 40 },
    { header: 'Neden Kaynağı', key: 'reasonSource', width: 26 },
    { header: 'Talep No', key: 'claimId', width: 22 },
    { header: 'Talep Durumu', key: 'claimStatus', width: 16 },
    { header: 'İade Talep Tarihi', key: 'claimDateText', width: 20 },
    { header: 'Müşteri Notu', key: 'customerNote', width: 34 },
    { header: 'Kargo Firması', key: 'cargoProvider', width: 18 },
  ];
  sheet.columns = columns;
  styleHeaderRow(sheet.getRow(1), { height: 28 });

  const sorted = [...report.rows].sort((a, b) => String(a.day).localeCompare(String(b.day)) || Number(a.eventDate) - Number(b.eventDate));

  sorted.forEach((row) => {
    const added = sheet.addRow({
      ...row,
      day: formatDayLabel(row.day),
      // Musteri alanlari API'den obje/eksik gelebilir; hucreye daima duz metin yaziyoruz.
      customerFirstName: safeText(row.customerFirstName),
      customerLastName: safeText(row.customerLastName),
      customerFullName: safeText(row.customerFullName, UNKNOWN_CUSTOMER),
      valuationLabel: safeText(row.valuationLabel, row.settled ? 'Kesinleşmiş' : 'Tahmini'),
      commissionRatePct: row.commissionRate === null || row.commissionRate === undefined ? '' : round2(row.commissionRate),
      commissionSourceText: RATE_SOURCE_TR[row.commissionSource] ?? safeText(row.commissionSource),
      returnSourceText: RETURN_SOURCE_TR[row.returnSource] ?? '',
      returnPendingQuantity: row.returnPendingQuantity ?? 0,
      settlementNote: safeText(row.settlementNote),
      transactionTypeText: safeText((row.transactionTypes ?? []).join(', ')),
    });
    const moneyKeys = ['unitPrice', 'grossAmount', 'commission', 'commissionRefunded', 'shippingFee', 'returnShippingFee', 'deductions', 'netRevenue'];
    moneyKeys.forEach((key) => {
      const index = columns.findIndex((c) => c.key === key) + 1;
      added.getCell(index).numFmt = MONEY_FMT;
    });
    added.getCell(columns.findIndex((c) => c.key === 'quantity') + 1).numFmt = INT_FMT;

    const { bg, fg } = statusStyle(row.status);
    added.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = THIN_BORDER;
      if (bg) cell.fill = fill(bg);
    });
    added.getCell(columns.findIndex((c) => c.key === 'statusLabel') + 1).font = { bold: true, color: { argb: fg } };
  });

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sorted.length + 1, column: columns.length } };
  return sheet;
}

// ---------------------------------------------------------------------------
// Genel giriş noktası
// ---------------------------------------------------------------------------
export async function buildProductWorkbook(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Trendyol Analitik Paneli';
  workbook.lastModifiedBy = 'Trendyol Analitik Paneli';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.properties.date1904 = false;
  workbook.calcProperties.fullCalcOnLoad = true; // ara toplam formülleri açılışta hesaplansın

  buildSummarySheet(workbook, report);
  buildDetailSheet(workbook, report);
  buildReasonSheet(workbook, report);
  buildVariantSheet(workbook, report);
  buildRawSheet(workbook, report);

  return workbook;
}

/** Türkçe karakterleri koruyan ve koruyamayan iki isim üretir (Content-Disposition için). */
export function buildFileName(report) {
  const slugSource = `${report.product.productName}-${report.product.barcode}`;
  const pretty = `${slugSource}-${report.range.startDate}_${report.range.endDate}.xlsx`
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '_');

  const asciiMap = { ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U' };
  const ascii = pretty
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (ch) => asciiMap[ch] ?? ch)
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 120) || 'trendyol-rapor.xlsx';

  return { pretty, ascii };
}

export const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const reportTimeZone = env.REPORT_TIMEZONE;
