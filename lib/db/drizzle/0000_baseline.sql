CREATE TABLE "request_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_role" text NOT NULL,
	"actor_name" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ride_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_request_id" text NOT NULL,
	"passenger_id" integer NOT NULL,
	"direction_id" integer NOT NULL,
	"pickup_stop_id" integer NOT NULL,
	"dropoff_stop_id" integer NOT NULL,
	"seats" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"trip_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"boarded_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"cancel_reason" text,
	CONSTRAINT "ride_requests_client_request_id_unique" UNIQUE("client_request_id")
);
--> statement-breakpoint
CREATE TABLE "route_directions" (
	"id" serial PRIMARY KEY NOT NULL,
	"route_id" integer NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"from_name" text NOT NULL,
	"to_name" text NOT NULL,
	"ascending" boolean NOT NULL,
	CONSTRAINT "route_directions_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "route_stops" (
	"id" serial PRIMARY KEY NOT NULL,
	"route_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_demo_data" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" serial PRIMARY KEY NOT NULL,
	"vehicle_id" integer NOT NULL,
	"direction_id" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"seats_taken" integer DEFAULT 0 NOT NULL,
	"current_stop_id" integer NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"is_simulated" boolean DEFAULT true NOT NULL,
	"last_location_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"phone" text,
	"description" text DEFAULT '' NOT NULL,
	CONSTRAINT "users_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" serial PRIMARY KEY NOT NULL,
	"plate" text NOT NULL,
	"label" text NOT NULL,
	"capacity" integer NOT NULL,
	"driver_id" integer NOT NULL,
	CONSTRAINT "vehicles_plate_unique" UNIQUE("plate"),
	CONSTRAINT "vehicles_driver_id_unique" UNIQUE("driver_id")
);
--> statement-breakpoint
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_request_id_ride_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."ride_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_requests" ADD CONSTRAINT "ride_requests_passenger_id_users_id_fk" FOREIGN KEY ("passenger_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_requests" ADD CONSTRAINT "ride_requests_direction_id_route_directions_id_fk" FOREIGN KEY ("direction_id") REFERENCES "public"."route_directions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_requests" ADD CONSTRAINT "ride_requests_pickup_stop_id_route_stops_id_fk" FOREIGN KEY ("pickup_stop_id") REFERENCES "public"."route_stops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_requests" ADD CONSTRAINT "ride_requests_dropoff_stop_id_route_stops_id_fk" FOREIGN KEY ("dropoff_stop_id") REFERENCES "public"."route_stops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_requests" ADD CONSTRAINT "ride_requests_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_directions" ADD CONSTRAINT "route_directions_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_direction_id_route_directions_id_fk" FOREIGN KEY ("direction_id") REFERENCES "public"."route_directions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_current_stop_id_route_stops_id_fk" FOREIGN KEY ("current_stop_id") REFERENCES "public"."route_stops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_driver_id_users_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_events_request_idx" ON "request_events" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ride_requests_one_active_per_passenger" ON "ride_requests" USING btree ("passenger_id") WHERE status in ('pending','accepted','boarded');--> statement-breakpoint
CREATE INDEX "ride_requests_status_idx" ON "ride_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "route_stops_route_seq_uq" ON "route_stops" USING btree ("route_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "trips_one_active_per_vehicle" ON "trips" USING btree ("vehicle_id") WHERE status = 'active';