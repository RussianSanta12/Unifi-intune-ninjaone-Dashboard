// Everything department-specific about the page: its title, the two ticket
// panels' titles, and the NinjaOne boards and fields behind them. Each
// department runs its own copy with its own .env (IT/AV, Maintenance, ...);
// the defaults here are the IT/AV values.
//
// The page has two ticket panels plus a strip on top:
//   - the list panel (left): a plain request queue, e.g. IT Support Requests;
//   - the calendar panel (right): event requests on a month grid, with the
//     "This Week" strip above showing the same tickets' current week.
//
// Board and field names must match NinjaOne exactly (npm run discover lists
// them). An optional field set to empty (FIELD=) is simply not shown. Older
// setting names (NINJAONE_IT_*, NINJAONE_AV_*) are still read when the new
// ones aren't set, so existing .env files keep working.

// The first of `names` that's set (even to empty), else `fallback`.
function setting(names, fallback) {
  for (const name of names) {
    if (process.env[name] !== undefined) return process.env[name].trim();
  }
  return fallback;
}

const listBoard = setting(['LIST_PANEL_BOARD', 'NINJAONE_IT_BOARD'], 'IT Support Requests');
const calendarBoard = setting(['CALENDAR_PANEL_BOARD', 'NINJAONE_AV_BOARD'], 'AV Support Requests');

module.exports = {
  dashboardTitle: setting(['DASHBOARD_TITLE'], 'Tickets Dashboard'),

  list: {
    title: setting(['LIST_PANEL_TITLE'], listBoard),
    board: listBoard,
    fields: {
      location: setting(['LIST_PANEL_LOCATION_FIELD', 'NINJAONE_IT_LOCATION_FIELD'], 'Location(IT)'),
      // A DATE field shown as "Needed by …" under the location (Maintenance).
      neededBy: setting(['LIST_PANEL_DATE_FIELD'], ''),
    },
  },

  calendar: {
    title: setting(['CALENDAR_PANEL_TITLE'], calendarBoard),
    weekTitle: setting(['WEEK_PANEL_TITLE'], 'AV Events This Week'),
    board: calendarBoard,
    // Tickets in this status stay on the calendar (shown brown).
    closedStatus: setting(['CALENDAR_PANEL_CLOSED_STATUS', 'NINJAONE_AV_CLOSED_STATUS'], 'Closed'),
    fields: {
      date: setting(['CALENDAR_PANEL_DATE_FIELD', 'NINJAONE_AV_EVENT_DATE_FIELD'], 'Date of Event / Program'), // required
      startTime: setting(['CALENDAR_PANEL_START_TIME_FIELD', 'NINJAONE_AV_START_TIME_FIELD'], 'Event Start Time'),
      endTime: setting(['CALENDAR_PANEL_END_TIME_FIELD', 'NINJAONE_AV_END_TIME_FIELD'], 'End Time'),
      location: setting(['CALENDAR_PANEL_LOCATION_FIELD', 'NINJAONE_AV_LOCATION_FIELD'], 'Location(IT)'),
      recurring: setting(['CALENDAR_PANEL_RECURRING_FIELD', 'NINJAONE_AV_RECURRING_FIELD'], 'Reoccurring Event'),
      recurringDays: setting(['CALENDAR_PANEL_RECURRING_DAYS_FIELD', 'NINJAONE_AV_RECURRING_DAYS_FIELD'], 'Reoccurring Days'),
      // Shown on the week cards' bottom line (Maintenance).
      attendees: setting(['CALENDAR_PANEL_ATTENDEES_FIELD'], ''),
    },
  },
};
