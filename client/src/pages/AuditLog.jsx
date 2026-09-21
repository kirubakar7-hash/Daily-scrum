import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Card, ErrorBanner, Skeleton } from '../components/ui';
import HelpBanner from '../components/HelpBanner';
import AuditTimeline from '../components/AuditTimeline';

export default function AuditLog() {
  const [logs, setLogs] = useState(null);
  const [loadError, setLoadError] = useState('');

  function load() {
    setLoadError('');
    api.get('/audit').then((d) => setLogs(d.logs)).catch((e) => setLoadError(e.message || "Couldn't load the audit log."));
  }

  useEffect(load, []);

  return (
    <Card className="animate-fade-in-up">
      <div className="flex items-center gap-2.5 mb-1">
        <div className="w-9 h-9 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
          <History className="w-4.5 h-4.5" />
        </div>
        <h1 className="text-xl font-bold text-grey-900">Audit Log</h1>
      </div>
      <p className="text-grey-500 text-sm mb-3">Every important change — what changed, who changed it, and when.</p>
      <HelpBanner>
        This log records changes that could affect someone's access or history — role changes, deactivations, due date changes, and similar updates.
        Nothing here can be edited or removed.
      </HelpBanner>
      <ErrorBanner message={loadError} />
      {loadError && <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>}
      {!loadError && (
        <div className="mt-4">
          {logs === null ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : (
            <AuditTimeline logs={logs} />
          )}
        </div>
      )}
    </Card>
  );
}
