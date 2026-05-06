// Parses user-supplied dataset content (JSON array of objects, or CSV with
// header row) into a uniform array of records. Records are stored in the run
// config as JSONB and embedded into the generated k6 script as SharedArrays.

export type DatasetRecord = Record<string, unknown>;

export function parseDataset(format: 'json' | 'csv', content: string): DatasetRecord[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  if (format === 'json') return parseJson(trimmed);
  return parseCsv(trimmed);
}

function parseJson(s: string): DatasetRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(s);
  } catch (err) {
    throw new Error(`dataset JSON is invalid: ${(err as Error).message}`);
  }
  if (!Array.isArray(value)) {
    throw new Error('dataset JSON must be an array of objects');
  }
  return value.map((row, i) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`dataset JSON row ${i} is not an object`);
    }
    return row as DatasetRecord;
  });
}

// Minimal CSV parser. Supports quoted fields with embedded commas, escaped
// quotes ("") and CRLF line endings. Header row is required and used as keys.
function parseCsv(s: string): DatasetRecord[] {
  const rows = tokenizeCsv(s);
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((cells) => {
    const out: DatasetRecord = {};
    for (let i = 0; i < headers.length; i++) {
      out[headers[i]] = cells[i] ?? '';
    }
    return out;
  });
}

function tokenizeCsv(s: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      row.push(field);
      field = '';
      if (row.length > 0 && !(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
      if (c === '\r' && s[i + 1] === '\n') i++;
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
  }
  return rows;
}
