ALTER TABLE cam.wheelseye_location_segments ADD COLUMN IF NOT EXISTS angle double precision NOT NULL DEFAULT 0;
ALTER TABLE cam.wheelseye_location_segments ADD COLUMN IF NOT EXISTS charge_on boolean;
ALTER TABLE cam.wheelseye_location_segments ADD COLUMN IF NOT EXISTS accurate boolean;
