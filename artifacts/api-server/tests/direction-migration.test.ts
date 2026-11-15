import { afterAll, beforeAll, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "@workspace/db";
import { migrationsFolder } from "@workspace/db/migrations";
import { assertTestDatabase, assertTestMarker } from "@workspace/db/testing";

beforeAll(async () => {
  assertTestDatabase(process.env.DATABASE_URL, process.env.SERVICNA_DEMO_DATABASE_URL);
  await assertTestMarker(pool, process.env.SERVICNA_DEMO_DATABASE_URL!);
});
afterAll(async () => { await pool.end(); });

it("migrates real legacy requests without deletion/FK loss, archives endpoints, cancels only preboarding activity with events", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // This scratch schema is INSIDE the guarded disposable DB, never the demo DB.
    await client.query("CREATE SCHEMA migration_fixture");
    await client.query("SET LOCAL search_path TO migration_fixture");
    for (const file of ["0000_baseline", "0001_accounts_sessions", "0002_remove_phones", "0003_demo_sessions", "0004_demo_setup_marker"]) {
      const sql = await readFile(path.join(migrationsFolder, `${file}.sql`), "utf8");
      await client.query(sql.replaceAll('"public".', '"migration_fixture".'));
    }
    await client.query(`
      INSERT INTO routes(id,name) VALUES(1,'legacy');
      INSERT INTO route_directions(id,route_id,code,name,from_name,to_name,ascending)
        VALUES(1,1,'to_center','center','a','b',true),(2,1,'to_waer','return','b','a',false);
      INSERT INTO route_stops(route_id,seq,name,lat,lng)
        SELECT 1,n,'old stop '||n,34+n*.001,36+n*.001 FROM generate_series(1,8) n;
      INSERT INTO users(id,key,name,role,login_name,enabled)
        VALUES(1,'passenger-1','p1','passenger','p1',true),(2,'passenger-2','p2','passenger','p2',true),
        (3,'passenger-3','p3','passenger','p3',true),(4,'driver-1','d1','driver','d1',true);
      INSERT INTO vehicles(id,driver_id,plate,label,capacity) VALUES(1,4,'old','old',12);
      INSERT INTO trips(id,vehicle_id,direction_id,current_stop_id,lat,lng,seats_taken)
        VALUES(1,1,2,8,34.008,36.008,2);
      INSERT INTO ride_requests(id,client_request_id,passenger_id,direction_id,pickup_stop_id,dropoff_stop_id,status,trip_id,expires_at)
        VALUES(1,'legacy-pending',1,1,2,7,'pending',null,now()+interval '1 hour'),
        (2,'legacy-accepted',2,2,7,2,'accepted',1,now()+interval '1 hour'),
        (3,'legacy-boarded',3,2,6,2,'boarded',1,now()+interval '1 hour'),
        (4,'legacy-completed',1,2,7,1,'completed',1,now()-interval '1 hour');
      INSERT INTO request_events(request_id,to_status,actor_role,actor_name)
        SELECT id,status,'system','fixture' FROM ride_requests;
    `);
    const migration = await readFile(path.join(migrationsFolder, "0005_direction_routes.sql"), "utf8");
    await client.query(migration);
    const rows = (await client.query(`
      SELECT r.id,r.status,r.cancel_reason,p.name AS pickup_name,p.lat AS pickup_lat,
      p.direction_id AS pickup_direction,p.enabled AS pickup_enabled,
      d.direction_id AS dropoff_direction, r.direction_id
      FROM ride_requests r JOIN route_stops p ON p.id=r.pickup_stop_id
      JOIN route_stops d ON d.id=r.dropoff_stop_id ORDER BY r.id`)).rows;
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "cancelled", "boarded", "completed"]);
    expect(rows.map((r) => r.pickup_name)).toEqual(["old stop 2", "old stop 7", "old stop 6", "old stop 7"]);
    expect(rows.every((r) => !r.pickup_enabled && r.direction_id === r.pickup_direction && r.direction_id === r.dropoff_direction)).toBe(true);
    expect(rows[1].cancel_reason).toBe("route_reconfigured");
    expect(Number(rows[1].pickup_lat)).toBeCloseTo(34.007);
    const events = (await client.query("SELECT * FROM request_events ORDER BY id")).rows;
    expect(events).toHaveLength(6);
    expect(events.filter((e) => e.to_status === "cancelled").map((e) => e.from_status).sort()).toEqual(["accepted", "pending"]);
    expect((await client.query("SELECT * FROM trips")).rows[0]).toMatchObject({ status: "active", seats_taken: 1 });
    const points = (await client.query("SELECT direction_id,count(*)::int AS n FROM route_stops WHERE enabled GROUP BY direction_id")).rows;
    expect(points).toHaveLength(2);
    expect(points.every((r) => r.n === 6)).toBe(true);
    expect((await client.query("SELECT plate,capacity FROM vehicles")).rows[0]).toEqual({ plate: "DEMO-001", capacity: 6 });
    // The transaction proves all FK relationships are valid at commit time too.
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
