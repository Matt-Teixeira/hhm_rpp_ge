-- PHILIPS DATA CAN BE BACKFILLED WITH MANY ENTRIES HAVING RECENT capture_datetime
-- THIS QUERY IS SIMILAR TO get-data.sql BUT LIMITS THE NUMBER OF ENTRIES TO THE SINGLE MOST RECENT WITHIN capture_datetime INTERVAL
-- THIS QUERY WOULD TECHNICALLY WORK FOR get-data.sql 'PROD' ALSO, GIVEN THAT ANY STACK RUN SHOULD ONLY HAVE 1 READING WITH THE PAST 30 MINUTES
-- BUT THIS WOULD INHIBIT STAGING FROM RUNNING PROPERLY AS IT ONLY PROCESS ALERTS 1/HR AND USES A 60 MINUTE INTERVAL

SELECT system_data_new.*
FROM (
    SELECT      system_id
    FROM        mag.philips_mri_monitoring_data_agg
    GROUP BY    system_id
) system_ids
JOIN LATERAL (
    SELECT      system_data_all.*
    FROM        mag.philips_mri_monitoring_data_agg AS system_data_all
    WHERE       system_data_all.system_id = system_ids.system_id
    AND         system_data_all.capture_datetime > (NOW() - INTERVAL '30 minutes')
    ORDER BY    system_data_all.capture_datetime DESC
    LIMIT 1
) system_data_new ON true ORDER BY system_ids.system_id;