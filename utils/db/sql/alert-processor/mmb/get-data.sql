-- RUN NESTED QUERY FIRST TO IMPROVE PERFORMANCE ON LARGE TABLES.
-- WITHOUT THE NESTED SELECT DISTINCT, THE JOIN LATERAL RUNS FOR EVERY LINE IN THE TABLE, 
-- EVEN THOUGH THE system_id IS OFTEN DUPLICATED. 
-- WITH THE NESTED SELECT DISTINCT, THE JOIN LATERAL RUNS ONCE AND ONLY ONCE FOR EACH DISTINCT system_id.

SELECT system_data_new.*
FROM (
   SELECT DISTINCT system_id
   FROM $1
) system_ids
JOIN LATERAL (
   SELECT   *
   FROM     $1 system_data_all
   WHERE    system_data_all.system_id = system_ids.system_id
   AND      system_data_all.capture_datetime > (NOW() - INTERVAL '30 minutes')   
   -- AND      system_data_all.capture_datetime > (NOW() - INTERVAL '60 minutes')   
   ORDER BY system_data_all.system_id, system_data_all.capture_datetime DESC
) system_data_new ON true;