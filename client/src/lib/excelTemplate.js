// Excel import templates with real dropdowns, and reading them back. A CSV can only hold text, so it
// can't carry a dropdown — these templates are .xlsx instead:
//   • "Import" sheet: the columns to fill in, with a dropdown on every column that has fixed choices.
//   • "Lists" sheet (hidden): the choices themselves — live data (people, Processes, Activities…)
//     at the moment of download, which the dropdowns point at.
// exceljs is large, so it is only loaded when someone actually downloads or imports a file.

const TEMPLATE_ROWS = 500; // rows that get dropdowns — well beyond any realistic single import

async function loadExcel() {
  return (await import('exceljs')).default;
}

function columnLetter(n) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

const unique = (values) => [...new Set(values.filter((v) => v !== undefined && v !== null && String(v).trim() !== '').map(String))];

/** Builds and downloads an .xlsx template.
 *  fields: { [column]: {
 *    options?: string[]            fixed choices → a dropdown
 *    multiple?: true               the cell may hold several choices separated by ";" (dropdown still offered)
 *    dependsOn?: column, pairs?: [parentValue, value][]   choices that depend on another column in the same row
 *    date?: true                   a date column (Excel's date checking; imported as YYYY-MM-DD)
 *    hint?: string                 shown when the cell is selected
 *  } } */
export async function downloadExcelTemplate({ fileName, ...template }) {
  const buffer = await buildExcelTemplate(template);
  const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** The template workbook itself, as file bytes. */
export async function buildExcelTemplate({ headers, example, fields = {} }) {
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Import', { views: [{ state: 'frozen', ySplit: 1 }] });
  const lists = wb.addWorksheet('Lists');
  lists.state = 'hidden';

  sheet.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(18, h.length + 6) }));
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16469D' } };

  if (example) {
    const row = {};
    for (const h of headers) {
      const v = example[h];
      row[h] = fields[h]?.date && /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? new Date(`${v}T00:00:00Z`) : (v ?? '');
    }
    sheet.addRow(row);
  }

  let nextListColumn = 1;
  const addList = (title, values) => {
    const col = nextListColumn++;
    const letter = columnLetter(col);
    lists.getCell(1, col).value = title;
    values.forEach((v, i) => { lists.getCell(i + 2, col).value = v; });
    lists.getColumn(col).width = Math.max(18, ...values.map((v) => String(v).length + 2));
    return letter;
  };

  headers.forEach((h, index) => {
    const f = fields[h];
    if (!f) return;
    const col = index + 1;
    const prompt = f.hint ? { showInputMessage: true, promptTitle: h, prompt: f.hint } : {};

    if (f.date) {
      sheet.getColumn(col).numFmt = 'yyyy-mm-dd';
      for (let r = 2; r <= TEMPLATE_ROWS + 1; r++) {
        sheet.getCell(r, col).dataValidation = {
          type: 'date', operator: 'greaterThan', allowBlank: true, formulae: [new Date(Date.UTC(2000, 0, 1))],
          showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Not a date', error: 'Enter a date, e.g. 2026-09-30.', ...prompt,
        };
      }
      return;
    }

    if (f.dependsOn && f.pairs) {
      // Classic dependent dropdown: pairs sorted by parent, and each row's list is the block of values
      // whose parent matches what's chosen in that row's parent column.
      const pairs = f.pairs.filter(([p, v]) => p && v).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
      if (!pairs.length) return;
      const parentList = addList(`${f.dependsOn} (for ${h})`, pairs.map((p) => p[0]));
      const valueList = addList(h, pairs.map((p) => p[1]));
      const parentColumn = columnLetter(headers.indexOf(f.dependsOn) + 1);
      for (let r = 2; r <= TEMPLATE_ROWS + 1; r++) {
        sheet.getCell(r, col).dataValidation = {
          type: 'list', allowBlank: true,
          formulae: [`OFFSET(Lists!$${valueList}$1,MATCH($${parentColumn}${r},Lists!$${parentList}:$${parentList},0)-1,0,COUNTIF(Lists!$${parentList}:$${parentList},$${parentColumn}${r}),1)`],
          showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Not in the list',
          error: `Choose the ${f.dependsOn} first, then pick from its list.`, ...prompt,
        };
      }
      return;
    }

    const options = unique(f.options || []);
    if (!options.length) return;
    const listLetter = addList(h, options);
    for (let r = 2; r <= TEMPLATE_ROWS + 1; r++) {
      sheet.getCell(r, col).dataValidation = {
        type: 'list', allowBlank: true, formulae: [`Lists!$${listLetter}$2:$${listLetter}$${options.length + 1}`],
        // A "several people" column must still accept "a@x.com;b@x.com", which isn't one list entry.
        showErrorMessage: !f.multiple, errorStyle: f.multiple ? 'information' : 'stop',
        errorTitle: 'Not in the list', error: 'Choose a value from the dropdown.', ...prompt,
      };
    }
  });

  return wb.xlsx.writeBuffer();
}

function cellToText(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10); // Excel dates arrive as UTC midnight
  if (typeof v === 'object') {
    if (v.result instanceof Date) return v.result.toISOString().slice(0, 10);
    if ('result' in v) return String(v.result ?? '').trim(); // formula
    if (v.richText) return v.richText.map((t) => t.text).join('').trim();
    if ('text' in v) return String(v.text ?? '').trim(); // an email Excel turned into a link
  }
  return String(v).trim();
}

/** The rows of the first visible sheet of an .xlsx file, as objects keyed by the header row — the same
 *  shape parseCsv returns, so the import endpoints don't need to know which kind of file it was. */
export async function readExcelRows(file) {
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const sheet = wb.worksheets.find((w) => w.state !== 'hidden' && w.state !== 'veryHidden') || wb.worksheets[0];
  if (!sheet) return [];
  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { headers[col] = cellToText(cell); });
  const rows = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const obj = {};
    let any = false;
    headers.forEach((h, col) => {
      if (!h) return;
      const text = cellToText(row.getCell(col));
      obj[h] = text;
      if (text) any = true;
    });
    if (any) rows.push(obj);
  }
  return rows;
}
