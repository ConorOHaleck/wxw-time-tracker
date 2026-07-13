"""
WxW Time Tracker — Event Timeline Dashboard (mock data)

Visualizes a timeline of discrete events that occur in pairs on specific dates.
Each pair is a start/stop that forms a tracked span (e.g. a TimeFlip session).

Run with:  streamlit run app.py
Data here is synthetic — swap `load_events()` for a real Airtable/local source later.
"""

from __future__ import annotations

import datetime as dt
import random

import pandas as pd
import plotly.express as px
import streamlit as st

# ----------------------------------------------------------------------------
# Mock data
# ----------------------------------------------------------------------------

PEOPLE = ["Kyle", "Ada", "Grace", "Linus"]
PROJECTS = ["Delivery", "Platform", "Research", "Support"]
TASKS = ["Design", "Build", "Review", "Meeting", "Docs"]

# Seeded so the dashboard is stable across reruns.
_RNG = random.Random(42)


@st.cache_data
def load_events(n_days: int = 21, pairs_per_day: int = 6) -> pd.DataFrame:
    """Generate discrete events in start/stop pairs on specific dates.

    Returns one row per *pair* (a span), which is the natural unit for a
    timeline. Individual start/stop events are derived from the columns.
    """
    rng = random.Random(42)
    today = dt.date(2026, 7, 7)
    rows: list[dict] = []
    session_id = 0

    for day_offset in range(n_days):
        day = today - dt.timedelta(days=n_days - 1 - day_offset)
        # Skip most weekends to make the timeline look real.
        if day.weekday() >= 5 and rng.random() > 0.25:
            continue

        n_pairs = rng.randint(max(1, pairs_per_day - 3), pairs_per_day)
        for _ in range(n_pairs):
            session_id += 1
            start_hour = rng.randint(8, 16)
            start_min = rng.choice([0, 15, 30, 45])
            duration_min = rng.choice([15, 30, 45, 60, 90, 120])

            start = dt.datetime.combine(
                day, dt.time(hour=start_hour, minute=start_min)
            )
            end = start + dt.timedelta(minutes=duration_min)

            rows.append(
                {
                    "session_id": session_id,
                    "date": day,
                    "person": rng.choice(PEOPLE),
                    "project": rng.choice(PROJECTS),
                    "task": rng.choice(TASKS),
                    "start": start,
                    "stop": end,
                    "duration_min": duration_min,
                }
            )

    df = pd.DataFrame(rows)
    return df.sort_values("start").reset_index(drop=True)


def to_event_log(pairs: pd.DataFrame) -> pd.DataFrame:
    """Explode each span into its two discrete events (start + stop)."""
    starts = pairs.assign(event="start", timestamp=pairs["start"])
    stops = pairs.assign(event="stop", timestamp=pairs["stop"])
    cols = ["session_id", "date", "person", "project", "task", "event", "timestamp"]
    return (
        pd.concat([starts[cols], stops[cols]])
        .sort_values("timestamp")
        .reset_index(drop=True)
    )


# ----------------------------------------------------------------------------
# Page
# ----------------------------------------------------------------------------

st.set_page_config(
    page_title="Time Tracker — Event Timeline",
    page_icon="⏱️",
    layout="wide",
)

st.title("⏱️ Event Timeline")
st.caption(
    "Discrete events in start/stop pairs. Each bar is one tracked session. "
    "Data is synthetic — wire `load_events()` to Airtable or the local store later."
)

pairs = load_events()

# --- Sidebar filters -------------------------------------------------------
with st.sidebar:
    st.header("Filters")

    min_date = pairs["date"].min()
    max_date = pairs["date"].max()
    date_range = st.date_input(
        "Date range",
        value=(min_date, max_date),
        min_value=min_date,
        max_value=max_date,
    )

    people = st.multiselect("People", PEOPLE, default=PEOPLE)
    projects = st.multiselect("Projects", PROJECTS, default=PROJECTS)
    color_by = st.selectbox("Color timeline by", ["person", "project", "task"])

# Normalize the date_input (it can return a single date mid-selection).
if isinstance(date_range, (list, tuple)) and len(date_range) == 2:
    start_date, end_date = date_range
else:
    start_date, end_date = min_date, max_date

mask = (
    pairs["date"].between(start_date, end_date)
    & pairs["person"].isin(people)
    & pairs["project"].isin(projects)
)
view = pairs[mask]

if view.empty:
    st.warning("No sessions match the current filters.")
    st.stop()

# --- Metrics ---------------------------------------------------------------
total_hours = view["duration_min"].sum() / 60
c1, c2, c3, c4 = st.columns(4)
c1.metric("Sessions", f"{len(view):,}")
c2.metric("Discrete events", f"{len(view) * 2:,}")
c3.metric("Total tracked", f"{total_hours:,.1f} h")
c4.metric("Active days", f"{view['date'].nunique()}")

# --- Timeline (Gantt-style) ------------------------------------------------
st.subheader("Session timeline")
fig = px.timeline(
    view,
    x_start="start",
    x_end="stop",
    y="person",
    color=color_by,
    hover_data=["project", "task", "duration_min"],
)
fig.update_yaxes(title=None, autorange="reversed")
fig.update_layout(
    height=460,
    margin=dict(l=10, r=10, t=10, b=10),
    legend_title=color_by.title(),
)
st.plotly_chart(fig, width='stretch')

# --- Daily totals ----------------------------------------------------------
left, right = st.columns([2, 1])

with left:
    st.subheader("Hours per day")
    daily = (
        view.groupby("date")["duration_min"].sum().div(60).reset_index(name="hours")
    )
    bar = px.bar(daily, x="date", y="hours")
    bar.update_layout(height=300, margin=dict(l=10, r=10, t=10, b=10))
    st.plotly_chart(bar, width='stretch')

with right:
    st.subheader("Split by project")
    by_project = (
        view.groupby("project")["duration_min"].sum().div(60).reset_index(name="hours")
    )
    pie = px.pie(by_project, names="project", values="hours", hole=0.45)
    pie.update_layout(height=300, margin=dict(l=10, r=10, t=10, b=10))
    st.plotly_chart(pie, width='stretch')

# --- Raw event log ---------------------------------------------------------
st.subheader("Discrete event log")
st.caption("Each session expanded into its two paired events.")
st.dataframe(
    to_event_log(view),
    width='stretch',
    hide_index=True,
)
