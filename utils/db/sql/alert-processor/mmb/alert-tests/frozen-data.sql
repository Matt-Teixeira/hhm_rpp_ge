-- SELECT 
-- 		system_id,
--       MAX(capture_datetime)            AS max_cap_dt,
--       MIN(capture_datetime)            AS min_cap_dt,
-- 		COUNT(*) 						      AS row_total,
-- 		COUNT(DISTINCT($1:name))	      AS distinct_total
-- FROM 	$2 
-- WHERE system_id = $3
-- AND 	capture_datetime >= NOW() - INTERVAL '$4 hours'
-- AND   host_datetime IS NOT NULL
-- GROUP BY system_id;

-- SUB-QUERY USED TO EXCLUDE ~OLD DATA FROM BEING ANALYZED AFTER AN OFFLINE EVENT
SELECT 
    system_id,
    MAX(capture_datetime)           AS max_cap_dt,
    MIN(capture_datetime)           AS min_cap_dt,
    COUNT(*)                        AS row_total,
    COUNT(DISTINCT($1:name))        AS distinct_total
FROM  $2
WHERE system_id = $3
AND   $1:name IS NOT NULL
AND   capture_datetime >= NOW() - INTERVAL '$4 hours'
AND (
   SELECT   MAX(capture_datetime) 
   FROM     $2 
   WHERE    system_id = $3
) >= NOW() - INTERVAL '1 hour'
GROUP BY system_id;