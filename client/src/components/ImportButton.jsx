import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { Button, ErrorBanner } from './ui';
import { downloadCsv, parseCsv } from '../lib/csv';
import { api } from '../lib/api';

/** Shared "Download Template" + "Import CSV" pair for an Admin tab. `headers`/`example` define the
 *  downloadable template's columns; `endpoint` is the bulk-import route (e.g. '/users/import'), which
 *  must return `{ results: [{row, success, error?, note?}] }` in the same order as the rows sent. */
export default function ImportButton({ entityLabel, headers, example, endpoint, onDone }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');

  function downloadTemplate() {
    downloadCsv(`${entityLabel.toLowerCase().replace(/\s+/g, '-')}-import-template.csv`, headers, [example]);
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setResults(null);
    setBusy(true);
    try {
      const rows = parseCsv(await file.text());
      if (rows.length === 0) { setError('No rows found in that file.'); return; }
      const { results: res } = await api.post(endpoint, { rows });
      setResults(res);
      if (res.some((r) => r.success)) onDone?.();
    } catch (err) {
      setError(err.message || 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  const succeeded = results?.filter((r) => r.success).length ?? 0;
  const failed = results ? results.length - succeeded : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={downloadTemplate}>
          <Download className="w-3.5 h-3.5" /> Download Template
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          <Upload className="w-3.5 h-3.5" /> {busy ? 'Importing…' : 'Import CSV'}
        </Button>
        <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile} />
      </div>
      <ErrorBanner message={error} />
      {results && (
        <div className="text-xs rounded-lg border border-grey-200 bg-grey-50 px-3 py-2 space-y-1 max-h-40 overflow-y-auto">
          <p className="font-semibold text-grey-700">
            {succeeded} of {results.length} imported{failed > 0 ? `, ${failed} failed` : ''}.
          </p>
          {results.filter((r) => r.note).map((r) => <p key={`n${r.row}`} className="text-grey-500">Row {r.row}: {r.note}</p>)}
          {results.filter((r) => !r.success).map((r) => <p key={`e${r.row}`} className="text-accent-700">Row {r.row}: {r.error}</p>)}
        </div>
      )}
    </div>
  );
}
