SELECT 
    ao.system_id,
    ao.capture_datetime
FROM    alert.offline_mmb_conn   ao 
JOIN    systems        		sys ON sys.id = ao.system_id
WHERE   (sys.process_edu IS TRUE OR sys.process_mag IS TRUE)
AND     ao.inserted_at > (NOW() - INTERVAL '45 minutes')
AND 	ao.capture_datetime IS NOT NULL -- ADD CODE CHECK FOR NULL TO ENHANCE LOGGING
ORDER BY 
        system_id;