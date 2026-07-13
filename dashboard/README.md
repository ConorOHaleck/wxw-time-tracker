# Event Timeline Dashboard

A Streamlit dashboard visualizing a timeline of discrete events that occur in
start/stop **pairs** on specific dates. Each pair is one tracked session (a bar
on the timeline); the raw log expands every pair back into its two events.

The data is **synthetic** — generated in `load_events()`. Swap that function for
a real source (Airtable Hours table, or the local store the Electron app writes)
without touching the rest of the app.

## Run

```bash
cd dashboard
python -m venv .venv
.venv\Scripts\activate        # Windows PowerShell:  .venv\Scripts\Activate.ps1
pip install -r requirements.txt
streamlit run app.py
```

Then open http://localhost:8501.

## What's on it

- **Metrics** — session count, discrete-event count, total tracked hours, active days
- **Session timeline** — Gantt-style bars, one per session, colored by person/project/task
- **Hours per day** — daily totals bar chart
- **Split by project** — donut breakdown
- **Discrete event log** — every session expanded into its paired start/stop events

Sidebar filters (date range, people, projects) drive every panel.

## Wiring to real data

Replace the body of `load_events()` so it returns a DataFrame with these columns:

| column         | type       | notes                          |
| -------------- | ---------- | ------------------------------ |
| `session_id`   | int        | unique per pair                |
| `date`         | date       | the day of the session         |
| `person`       | str        |                                |
| `project`      | str        |                                |
| `task`         | str        |                                |
| `start`        | datetime   | first event of the pair        |
| `stop`         | datetime   | second event of the pair       |
| `duration_min` | int/float  | minutes between start and stop |
