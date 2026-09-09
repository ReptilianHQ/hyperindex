import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// Dedicated local database only; this creates and drops its own benchmark schema.
const host = process.env.PGHOST ?? '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Use a local test database');
const sql = postgres({ host, port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres', database: process.env.PGDATABASE ?? 'postgres',
  max: 1, onnotice() {} });
const schema = `ordered_writes_${process.pid}`;
const seedRows = Number(process.env.SEED_ROWS ?? 500000);
const batchSize = Number(process.env.BATCH_SIZE ?? 16000);
const batchCount = 4;
const rounds = 4;
if (!Number.isSafeInteger(seedRows) || seedRows < 1 || seedRows > 2000000 ||
    !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100000) {
  throw new Error('Use SEED_ROWS=1..2000000 and BATCH_SIZE=1..100000');
}
const data = Array.from({length: batchCount}, (_, batch) => {
  const rows = Array.from({length: batchSize}, (_, i) => seedRows + batch * batchSize + i + 1);
  return [rows.map(i => `4663:0x${createHash('sha256').update(String(i)).digest('hex')}:1`), rows, rows.map(() => 'b'.repeat(100))];
});
const results = [];
let createdSchema = false;
try {
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  createdSchema = true;
  await sql.unsafe(`CREATE TABLE "${schema}".seed(id text PRIMARY KEY, block bigint NOT NULL, payload text NOT NULL)`);
  await sql.unsafe(`INSERT INTO "${schema}".seed SELECT '4663:0x'||md5(i::text)||md5(('x'||i)::text)||':1',i,repeat('a',100) FROM generate_series(1,$1::int)i`, [seedRows]);
  for (let round = 0; round < rounds; round++) {
    for (const mode of round % 2 ? ['client', 'sql', 'arrival'] : ['arrival', 'sql', 'client']) {
      await sql.unsafe(`CREATE TABLE "${schema}".work(LIKE "${schema}".seed INCLUDING ALL)`);
      await sql.unsafe(`INSERT INTO "${schema}".work SELECT * FROM "${schema}".seed`);
      const totals = {sharedReadBlocks:0, sharedHitBlocks:0, tempWrittenBlocks:0, executionMs:0};
      const start = performance.now();
      for (const original of data) {
        const values = mode === 'client'
          ? original[0].map((id, i) => ({id, i})).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
              .reduce((columns, {i}) => { original.forEach((column, c) => columns[c].push(column[i])); return columns; }, [[],[],[]])
          : original;
        const query = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) INSERT INTO "${schema}".work(id,block,payload)
SELECT * FROM unnest($1::text[],$2::bigint[],$3::text[]) AS incoming(id,block,payload)
${mode === 'sql' ? 'ORDER BY id' : ''} ON CONFLICT(id) DO UPDATE SET block=excluded.block,payload=excluded.payload`;
        const plan = (await sql.unsafe(query, values))[0]['QUERY PLAN'][0];
        totals.executionMs += plan['Execution Time'];
        totals.sharedReadBlocks += plan.Plan['Shared Read Blocks'];
        totals.sharedHitBlocks += plan.Plan['Shared Hit Blocks'];
        totals.tempWrittenBlocks += plan.Plan['Temp Written Blocks'];
      }
      const elapsedMs = performance.now() - start;
      const [check] = await sql.unsafe(`SELECT count(*)::int AS rows, sum(block)::text AS sum FROM "${schema}".work`);
      const expectedRows = seedRows + batchSize * batchCount;
      if (check.rows !== expectedRows || check.sum !== (BigInt(expectedRows) * BigInt(expectedRows + 1) / 2n).toString()) throw new Error('Row parity failed');
      const result = {round, mode, elapsedMs, ...totals, check};
      results.push(result);
      console.log(JSON.stringify(result));
      await sql.unsafe(`DROP TABLE "${schema}".work`);
    }
  }
  console.log(JSON.stringify({seedRows, batchSize, settings: await sql.unsafe("SELECT name,setting FROM pg_settings WHERE name IN ('shared_buffers','lc_collate','work_mem')"), results}));
} finally {
  try {
    if (createdSchema) await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await sql.end();
  }
}
