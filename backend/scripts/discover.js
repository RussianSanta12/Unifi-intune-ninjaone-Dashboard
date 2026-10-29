// Prints NinjaOne ticketing reference data (statuses, forms, fields, boards)
// plus one sample ticket, so .env names can be checked against the real
// values. Run with: npm run discover

const ninja = require('../lib/ninja');

function show(title, value) {
  const text = JSON.stringify(value, null, 2);
  console.log(`\n===== ${title} =====`);
  console.log(text.length > 4000 ? text.slice(0, 4000) + '\n... (truncated)' : text);
}

async function tryShow(title, fn) {
  try {
    const value = await fn();
    show(title, value);
    return value;
  } catch (err) {
    console.log(`\n===== ${title} =====\nFAILED: ${err.message}`);
    return null;
  }
}

async function main() {
  await tryShow('Ticket statuses', () => ninja.get('/v2/ticketing/statuses'));
  await tryShow('Ticket forms', () => ninja.get('/v2/ticketing/ticket-form'));
  await tryShow('Ticket attributes (custom fields)', () => ninja.get('/v2/ticketing/attributes'));
  const boards = await tryShow('Boards', () => ninja.get('/v2/ticketing/trigger/boards'));

  const boardList = Array.isArray(boards) ? boards : [];
  if (!boardList.length) return;
  const board = boardList[0];
  const run = await tryShow(`Board run (first board: ${board.name || board.id}, 3 rows)`, () =>
    ninja.post(`/v2/ticketing/trigger/board/${board.id}/run`, { pageSize: 3 })
  );

  const rows = (run && (run.data || run.results)) || [];
  if (rows.length && rows[0].id) {
    await tryShow(`Ticket detail (#${rows[0].id})`, () => ninja.get(`/v2/ticketing/ticket/${rows[0].id}`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
