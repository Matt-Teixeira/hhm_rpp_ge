SELECT 
    ao.system_id,
    ao.capture_datetime
FROM    alert.offline_mmb_conn   ao 
JOIN    systems sys ON sys.id = ao.system_id
WHERE   (sys.process_edu IS TRUE OR sys.process_mag IS TRUE)
AND     ao.capture_datetime IS NOT NULL
AND     ao.inserted_at > ao.capture_datetime + INTERVAL '45 minutes'
ORDER BY 
    system_id;