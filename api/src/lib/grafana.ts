// 30s padding either side so any late-arriving InfluxDB writes still fall
// inside the dashboard's time window.
const TIME_PADDING_MS = 30_000;

// Builds the URL the portal's "Open in Grafana" button uses. Sets every
// dashboard variable the worker tags metrics with (run_id, service) plus the
// run's actual time window so the user lands on a fully scoped view.
//
// Dashboard variable names this URL targets:
//   - run_id   → var-run_id
//   - service  → var-service
// If you rename either in infra/grafana-dashboard.json, update both ends.
export function buildGrafanaUrl(
  runId: string,
  startedAt?: Date | string | null,
  finishedAt?: Date | string | null,
  service?: string | null,
): string | null {
  const base = process.env.GRAFANA_BASE_URL;
  const uid = process.env.GRAFANA_DASHBOARD_UID;
  if (!base || !uid) return null;

  const u = new URL(`/d/${uid}`, base);
  u.searchParams.set('var-run_id', runId);
  if (service) {
    // Lock the dashboard's service filter to this run's service so the
    // run_id dropdown's WHERE clause matches and shows our run.
    u.searchParams.set('var-service', service);
  }

  // Only set the time range once the worker has started executing — for
  // queued runs we leave Grafana's dashboard default in place.
  if (startedAt) {
    const fromMs = new Date(startedAt).getTime() - TIME_PADDING_MS;
    u.searchParams.set('from', String(fromMs));
    if (finishedAt) {
      const toMs = new Date(finishedAt).getTime() + TIME_PADDING_MS;
      u.searchParams.set('to', String(toMs));
    } else {
      // Run is still active — let Grafana track to current time.
      u.searchParams.set('to', 'now');
    }
  }

  return u.toString();
}
