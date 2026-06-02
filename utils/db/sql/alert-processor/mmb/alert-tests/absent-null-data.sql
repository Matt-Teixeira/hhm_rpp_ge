DROP TABLE IF EXISTS temp_is_null_result;

DO $$
DECLARE
    col_names text[] := $4;
    col_name text;
    is_null boolean;
    capture_datetime timestamptz;
BEGIN
    -- CREATE A TEMPORARY TABLE
    CREATE TEMP TABLE temp_is_null_result (
        col_name text,
        is_null boolean,
        capture_datetime timestamptz
    );

     -- LOOP THROUGH EACH COLUMN NAME IN THE ARRAY
    FOREACH col_name IN ARRAY col_names
    LOOP
        -- BUILD THE DYNAMIC QUERY TO CHECK IF THE MOST RECENT VALUE IS NULL FOR THE SPECIFIC SYSTEM_ID
        EXECUTE format(
            'SELECT %I IS NULL, capture_datetime FROM %I.%I WHERE system_id = %L AND capture_datetime > NOW() - INTERVAL ''30 minutes'' ORDER BY capture_datetime DESC LIMIT 1',
            col_name, $1, $2, $3
        ) INTO is_null, capture_datetime;

        -- POPULATE TEMP TABLE WITH RESULTS
        INSERT INTO temp_is_null_result (col_name, is_null, capture_datetime)
        VALUES (col_name, is_null, capture_datetime);
    END LOOP;
END $$;

SELECT * FROM temp_is_null_result;
