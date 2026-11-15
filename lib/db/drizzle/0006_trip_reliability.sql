ALTER TABLE trips ADD COLUMN driver_id integer REFERENCES users(id);
ALTER TABLE trips ADD COLUMN capacity_snapshot integer;
ALTER TABLE trips ADD COLUMN external_occupied integer NOT NULL DEFAULT 0;
ALTER TABLE trips ADD COLUMN reserved_seats integer NOT NULL DEFAULT 0;
ALTER TABLE trips ADD COLUMN boarded_seats integer NOT NULL DEFAULT 0;
ALTER TABLE trips ADD COLUMN progress_sequence integer NOT NULL DEFAULT 1;
ALTER TABLE trips ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE trips ADD COLUMN location_source text NOT NULL DEFAULT 'simulation';
ALTER TABLE trips ADD COLUMN location_sequence integer NOT NULL DEFAULT 0;
ALTER TABLE trips ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE trips ADD COLUMN is_demo_data boolean NOT NULL DEFAULT false;
UPDATE trips t SET driver_id=v.driver_id, capacity_snapshot=v.capacity FROM vehicles v WHERE t.vehicle_id=v.id;
UPDATE trips t SET progress_sequence=s.seq FROM route_stops s WHERE s.id=t.current_stop_id;
ALTER TABLE trips ALTER COLUMN driver_id SET NOT NULL;
ALTER TABLE trips ALTER COLUMN capacity_snapshot SET NOT NULL;
ALTER TABLE trips ADD CONSTRAINT trip_capacity_check CHECK (capacity_snapshot > 0 AND external_occupied >= 0 AND reserved_seats >= 0 AND boarded_seats >= 0 AND external_occupied + reserved_seats + boarded_seats <= capacity_snapshot);
ALTER TABLE trips ADD CONSTRAINT trip_location_source_check CHECK (location_source IN ('gps','simulation','manual'));
CREATE UNIQUE INDEX trips_one_active_per_driver ON trips(driver_id) WHERE status='active';
ALTER TABLE ride_requests ADD COLUMN terminal_reason text;
ALTER TABLE ride_requests ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE ride_requests ADD COLUMN is_demo_data boolean NOT NULL DEFAULT false;
ALTER TABLE request_events ADD COLUMN operation_id text;
UPDATE trips t SET reserved_seats=(SELECT count(*) FROM ride_requests r WHERE r.trip_id=t.id AND r.status='accepted'),
 boarded_seats=(SELECT count(*) FROM ride_requests r WHERE r.trip_id=t.id AND r.status='boarded');
UPDATE trips SET seats_taken=reserved_seats+boarded_seats;
UPDATE ride_requests SET expires_at=created_at+interval '5 minutes' WHERE status='pending';
UPDATE ride_requests SET expires_at=accepted_at+interval '10 minutes' WHERE status='accepted';
CREATE TABLE idempotency_records (
 id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id), operation text NOT NULL,
 key text NOT NULL, payload_hash text NOT NULL, response_status integer NOT NULL, response_body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idempotency_scope_uq ON idempotency_records(user_id, operation, key);
