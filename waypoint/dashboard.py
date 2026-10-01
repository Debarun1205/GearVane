"""Web dashboard for monitoring Waypoint routing and costs."""

import json
import logging
from datetime import datetime
from typing import Dict, Any, Optional

from .logger import RoutingLogger
from .cost import CostTracker
from .health import ModelHealthChecker


logger = logging.getLogger(__name__)


DASHBOARD_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Waypoint Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f172a;
            color: #e2e8f0;
            padding: 2rem;
        }
        h1 { color: #38bdf8; margin-bottom: 0.5rem; }
        h2 { color: #94a3b8; margin: 1.5rem 0 1rem; font-size: 1.1rem; }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }
        .card {
            background: #1e293b;
            border: 1px solid #334155;
            border-radius: 12px;
            padding: 1.5rem;
        }
        .card h3 {
            color: #64748b;
            font-size: 0.85rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 0.5rem;
        }
        .card .value {
            font-size: 2rem;
            font-weight: 700;
            color: #f8fafc;
        }
        .card .sub {
            color: #64748b;
            font-size: 0.85rem;
            margin-top: 0.25rem;
        }
        .status-healthy { color: #22c55e; }
        .status-degraded { color: #f59e0b; }
        .status-unhealthy { color: #ef4444; }
        .status-unknown { color: #64748b; }
        table {
            width: 100%;
            border-collapse: collapse;
            background: #1e293b;
            border-radius: 12px;
            overflow: hidden;
        }
        th, td {
            padding: 0.75rem 1rem;
            text-align: left;
            border-bottom: 1px solid #334155;
        }
        th {
            background: #334155;
            color: #94a3b8;
            font-weight: 600;
            font-size: 0.8rem;
            text-transform: uppercase;
        }
        tr:last-child td { border-bottom: none; }
        .tier-local { color: #22c55e; }
        .tier-mid { color: #f59e0b; }
        .tier-frontier { color: #ef4444; }
        .refresh-info {
            color: #475569;
            font-size: 0.8rem;
            margin-top: 1rem;
        }
        .progress-bar {
            height: 6px;
            background: #334155;
            border-radius: 3px;
            margin-top: 0.5rem;
            overflow: hidden;
        }
        .progress-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.3s;
        }
    </style>
</head>
<body>
    <h1>Waypoint Dashboard</h1>
    <p style="color: #64748b;">AI Harness Monitoring</p>

    <div class="grid">
        <div class="card">
            <h3>Total Routed</h3>
            <div class="value">{{total_routed}}</div>
            <div class="sub">Tasks routed</div>
        </div>
        <div class="card">
            <h3>Success Rate</h3>
            <div class="value">{{success_rate}}%</div>
            <div class="sub">{{successes}} successes / {{failures}} failures</div>
        </div>
        <div class="card">
            <h3>Total Cost</h3>
            <div class="value">${{total_cost}}</div>
            <div class="sub">Session: ${{session_spend}}</div>
        </div>
        <div class="card">
            <h3>Escalations</h3>
            <div class="value">{{escalations}}</div>
            <div class="sub">Auto-promoted tasks</div>
        </div>
    </div>

    <h2>Tier Distribution</h2>
    <div class="grid">
        {{tier_cards}}
    </div>

    <h2>Model Health</h2>
    <table>
        <thead>
            <tr>
                <th>Model</th>
                <th>Provider</th>
                <th>Status</th>
                <th>Latency</th>
                <th>Last Checked</th>
            </tr>
        </thead>
        <tbody>
            {{health_rows}}
        </tbody>
    </table>

    <h2>Recent Routing Decisions</h2>
    <table>
        <thead>
            <tr>
                <th>Time</th>
                <th>Task</th>
                <th>Tier</th>
                <th>Model</th>
                <th>Confidence</th>
                <th>Status</th>
            </tr>
        </thead>
        <tbody>
            {{routing_rows}}
        </tbody>
    </table>

    <p class="refresh-info">Last updated: {{last_updated}}</p>
</body>
</html>
"""


class DashboardGenerator:
    """Generates HTML dashboard from routing and cost data."""

    def __init__(self, routing_logger: RoutingLogger, 
                 cost_tracker: Optional[CostTracker] = None,
                 health_checker: Optional[ModelHealthChecker] = None):
        self.routing_logger = routing_logger
        self.cost_tracker = cost_tracker
        self.health_checker = health_checker

    def generate(self) -> str:
        """Generate the HTML dashboard."""
        stats = self.routing_logger.get_stats()
        cost_stats = self.cost_tracker.get_stats() if self.cost_tracker else {}
        
        # Calculate success rate
        total = stats.get("total", 0)
        successes = stats.get("successes", 0)
        failures = stats.get("failures", 0)
        success_rate = round((successes / total) * 100, 1) if total > 0 else 0

        # Tier distribution cards
        tier_cards = ""
        for tier, count in stats.get("tier_distribution", {}).items():
            pct = round((count / total) * 100, 1) if total > 0 else 0
            color = {"local": "#22c55e", "mid": "#f59e0b", "frontier": "#ef4444"}.get(tier, "#64748b")
            tier_cards += f"""
            <div class="card">
                <h3>{tier.upper()}</h3>
                <div class="value tier-{tier}">{count}</div>
                <div class="sub">{pct}% of tasks</div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width: {pct}%; background: {color};"></div>
                </div>
            </div>
            """

        # Health rows
        health_rows = ""
        if self.health_checker:
            for model, result in self.health_checker.get_all_status().items():
                status_class = f"status-{result.status.value}"
                health_rows += f"""
                <tr>
                    <td>{model}</td>
                    <td>{result.provider}</td>
                    <td class="{status_class}">{result.status.value.upper()}</td>
                    <td>{result.latency_ms:.0f}ms</td>
                    <td>{datetime.fromtimestamp(result.last_checked).strftime('%H:%M:%S')}</td>
                </tr>
                """
        else:
            health_rows = '<tr><td colspan="5" style="text-align:center;color:#64748b;">No health data</td></tr>'

        # Routing rows (recent 10)
        routing_rows = ""
        for entry in self.routing_logger._entries[-10:]:
            status = "⏳ Pending" if entry.success is None else ("✅" if entry.success else "❌")
            routing_rows += f"""
            <tr>
                <td>{datetime.fromtimestamp(entry.timestamp).strftime('%H:%M:%S')}</td>
                <td>{entry.task_id}</td>
                <td class="tier-{entry.tier}">{entry.tier.upper()}</td>
                <td>{entry.model}</td>
                <td>{entry.confidence:.0%}</td>
                <td>{status}</td>
            </tr>
            """

        # Fill template
        html = DASHBOARD_HTML
        html = html.replace("{{total_routed}}", str(total))
        html = html.replace("{{success_rate}}", str(success_rate))
        html = html.replace("{{successes}}", str(successes))
        html = html.replace("{{failures}}", str(failures))
        html = html.replace("{{total_cost}}", str(cost_stats.get("total_cost_usd", "0.00")))
        html = html.replace("{{session_spend}}", str(cost_stats.get("session_spend_usd", "0.00")))
        html = html.replace("{{escalations}}", str(stats.get("escalations", 0)))
        html = html.replace("{{tier_cards}}", tier_cards)
        html = html.replace("{{health_rows}}", health_rows)
        html = html.replace("{{routing_rows}}", routing_rows)
        html = html.replace("{{last_updated}}", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))

        return html

    def save(self, filepath: str):
        """Save dashboard to file."""
        html = self.generate()
        with open(filepath, "w") as f:
            f.write(html)
        logger.info(f"Dashboard saved to {filepath}")
