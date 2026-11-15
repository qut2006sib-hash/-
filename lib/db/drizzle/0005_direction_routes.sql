-- Preserve historical stop labels/coordinates and all request/event records.
-- Serialize against writers while moving shared stops to direction-owned stops.
LOCK TABLE routes, route_directions, route_stops, trips, ride_requests, request_events, vehicles IN ACCESS EXCLUSIVE MODE;
ALTER TABLE route_directions ADD COLUMN geometry jsonb NOT NULL DEFAULT '[]';
ALTER TABLE route_directions ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE route_stops ADD COLUMN direction_id integer CONSTRAINT route_stops_direction_id_route_directions_id_fk REFERENCES route_directions(id);
ALTER TABLE route_stops ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE vehicles ADD COLUMN description text NOT NULL DEFAULT 'مركبة عرض تجريبية';
ALTER TABLE vehicles ADD COLUMN enabled boolean NOT NULL DEFAULT true;
DROP INDEX route_stops_route_seq_uq;

-- Archive the original stops under the first direction, cloning for the other
-- direction so historical requests retain exactly the same labels/coordinates.
CREATE TEMP TABLE legacy_stop_map (old_id integer, direction_id integer, new_id integer) ON COMMIT DROP;
DO $$
DECLARE s record; d record; owner_id integer; copied_id integer;
BEGIN
  FOR s IN SELECT * FROM route_stops ORDER BY id LOOP
    SELECT min(id) INTO owner_id FROM route_directions WHERE route_id = s.route_id;
    IF owner_id IS NULL THEN RAISE EXCEPTION 'Stop without direction; migration refused'; END IF;
    UPDATE route_stops SET direction_id = owner_id, enabled = false WHERE id = s.id;
    INSERT INTO legacy_stop_map VALUES (s.id, owner_id, s.id);
    FOR d IN SELECT * FROM route_directions WHERE route_id = s.route_id AND id <> owner_id LOOP
      INSERT INTO route_stops (route_id, direction_id, seq, name, lat, lng, enabled)
        VALUES (s.route_id, d.id, s.seq, s.name, s.lat, s.lng, false) RETURNING id INTO copied_id;
      INSERT INTO legacy_stop_map VALUES (s.id, d.id, copied_id);
    END LOOP;
  END LOOP;
END $$;
UPDATE ride_requests r SET pickup_stop_id = m.new_id FROM legacy_stop_map m
  WHERE r.pickup_stop_id = m.old_id AND r.direction_id = m.direction_id;
UPDATE ride_requests r SET dropoff_stop_id = m.new_id FROM legacy_stop_map m
  WHERE r.dropoff_stop_id = m.old_id AND r.direction_id = m.direction_id;
UPDATE trips t SET current_stop_id = m.new_id FROM legacy_stop_map m
  WHERE t.current_stop_id = m.old_id AND t.direction_id = m.direction_id;

-- Explicit terminal transition, not deletion, for requests to the retired stops.
INSERT INTO request_events (request_id, from_status, to_status, actor_role, actor_name, note)
  SELECT id, status, 'cancelled', 'system', 'النظام', 'route_reconfigured: أُرشف المسار السابق مع حفظ نقطتي الطلب'
  FROM ride_requests WHERE status IN ('pending', 'accepted');
UPDATE trips t SET seats_taken = greatest(0, seats_taken - coalesce((
  SELECT sum(seats) FROM ride_requests r WHERE r.trip_id = t.id AND r.status = 'accepted'
), 0));
UPDATE ride_requests SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'route_reconfigured'
  WHERE status IN ('pending', 'accepted');
-- Never invent boarding/completion. A boarded request and its trip remain intact
-- until explicitly completed; other old trips are retired.
UPDATE trips t SET status = 'ended', ended_at = now()
  WHERE status = 'active' AND NOT EXISTS (SELECT 1 FROM ride_requests r WHERE r.trip_id = t.id AND r.status = 'boarded');

ALTER TABLE route_stops ALTER COLUMN direction_id SET NOT NULL;
ALTER TABLE route_stops DROP COLUMN route_id;
ALTER TABLE route_directions DROP COLUMN ascending;
CREATE UNIQUE INDEX route_stops_direction_seq_uq ON route_stops(direction_id, seq) WHERE enabled = true;

-- Six generated demo points per independent direction around Homs, NOT surveyed.
INSERT INTO route_stops(direction_id, seq, name, lat, lng)
SELECT d.id, p.seq, 'نقطة تجريبية ' || p.seq, p.lat, p.lng
FROM route_directions d CROSS JOIN LATERAL (
  SELECT * FROM (VALUES
    ('to_center',1,34.7432,36.6605),('to_center',2,34.7401,36.6688),
    ('to_center',3,34.7368,36.6779),('to_center',4,34.7322,36.6884),
    ('to_center',5,34.7309,36.7126),('to_center',6,34.7334,36.7172),
    ('to_waer',1,34.7345,36.7170),('to_waer',2,34.7320,36.7115),
    ('to_waer',3,34.7334,36.6888),('to_waer',4,34.7380,36.6784),
    ('to_waer',5,34.7415,36.6695),('to_waer',6,34.7444,36.6610)
  ) AS points(code,seq,lat,lng) WHERE points.code = d.code
) p;
UPDATE route_directions d SET geometry = coalesce((
  SELECT jsonb_agg(jsonb_build_object('lat',s.lat,'lng',s.lng) ORDER BY s.seq)
  FROM route_stops s WHERE s.direction_id = d.id AND s.enabled
), '[]'::jsonb);
ALTER TABLE route_directions ALTER COLUMN geometry DROP DEFAULT;
UPDATE vehicles v SET plate = 'DEMO-' || lpad(right(u.key,1),3,'0'),
  label = 'سرفيس تجريبي ' || right(u.key,1), capacity = 6, description = 'مركبة عرض تجريبية — ستة مقاعد'
  FROM users u WHERE v.driver_id = u.id AND u.key IN ('driver-1','driver-2','driver-3');