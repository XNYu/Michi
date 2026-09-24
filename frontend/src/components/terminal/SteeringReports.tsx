import type { SteeringReport } from 'michi-shared';
import './SteeringReports.css';

export function SteeringReports({ reports }: { reports?: readonly SteeringReport[] }) {
  if (!reports?.length) return null;
  return (
    <details className="t-steering-reports">
      <summary>
        Steering notes{reports.length > 1 ? ` (${reports.length})` : ''}
        <span className="t-steering-source">Model-reported</span>
      </summary>
      <div className="t-steering-report-body">
        {reports.map((report) => (
          <div className="t-steering-report" key={report.messageId}>
            {!report.complete && <span className="t-steering-incomplete">Incomplete note</span>}
            <p>{report.text || 'No explanation received.'}</p>
          </div>
        ))}
      </div>
    </details>
  );
}
