DO $$ 
DECLARE
    current_date            DATE := CURRENT_DATE;
    from_date               DATE := current_date + INTERVAL '1 month';
    to_date                 DATE := from_date + INTERVAL '1 month';
    -- partition_suffix_date IS REDUNDANT VIA from_date, ONLY ADDED FOR CONCEPT CLARITY
    partition_suffix_date   DATE := current_date + INTERVAL '1 month';
    formatted_suffix_date   TEXT;
    formatted_from_date     TEXT;
    formatted_to_date       TEXT;
    partition_name          TEXT;
    schema_name             TEXT;
BEGIN
    -- FORMAT DATETIMES AS NEEDED
    formatted_suffix_date   := TO_CHAR(partition_suffix_date, 'YYYY_MM');
    formatted_from_date     := TO_CHAR(from_date, 'YYYY_MM_01 00:00');
    formatted_to_date       := TO_CHAR(to_date, 'YYYY_MM_01 00:00');
    
    -- FOR EACH TABLE TO BE PARTITIONED...
    -- 1. CONSTRUCT THE PARTITION NAME DYNAMICALLY
    -- 2. CREATE PARTITION
    -- PRINT EXAMPLE : RAISE NOTICE 'partition_name: %', partition_name;

    -- ALERT SCHEMA PARTITIONS
    schema_name := 'alert';
    partition_name := 'detections_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF alert.detections
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);
    
    partition_name := 'notifications_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF alert.notifications
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);
    
    -- EDU SCHEMA PARTITIONS
    schema_name := 'edu';
    partition_name := 'v1_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF edu.v1
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);
    
    partition_name := 'v2_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF edu.v2
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);

    -- LOG SCHEMA PARTITIONS
    schema_name := 'log';

    partition_name := 'ge_ct_gesys_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF log.ge_ct_gesys
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);

    partition_name := 'ge_cv_syserror_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF log.ge_cv_syserror
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);

    partition_name := 'ge_mri_gesys_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF log.ge_mri_gesys
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);

    partition_name := 'philips_ct_eal_events_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF log.philips_ct_eal_events
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);

    partition_name := 'philips_cv_eventlog_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF log.philips_cv_eventlog
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);
    
    partition_name := 'philips_mri_logcurrent_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF log.philips_mri_logcurrent
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);

    partition_name := 'siemens_ct_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF log.siemens_ct
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);

    partition_name := 'siemens_cv_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF log.siemens_cv
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);

    partition_name := 'siemens_mri_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF log.siemens_mri
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);
    
    partition_name := 'stt_magnet_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF log.stt_magnet
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);

    -- MAG SCHEMA PARTITIONS
    schema_name := 'mag';
    
    partition_name := 'ge_mm3_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF mag.ge_mm3
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);
    
    partition_name := 'ge_mm4_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF mag.ge_mm4
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);
    
    partition_name := 'philips_mri_rmmu_history_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF mag.philips_mri_rmmu_history
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);
    
    partition_name := 'philips_mri_rmmu_long_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF mag.philips_mri_rmmu_long
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);
    
    partition_name := 'philips_mri_rmmu_magnet_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF mag.philips_mri_rmmu_magnet
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);
    
    partition_name := 'philips_mri_rmmu_short_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF mag.philips_mri_rmmu_short
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);

    partition_name := 'siemens_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF mag.siemens
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);
    
    partition_name := 'siemens_non_tim_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF mag.siemens_non_tim
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);
    
    partition_name := 'stt_magnet_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF mag.stt_magnet
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);

    -- UTIL SCHEMA PARTITIONS
    schema_name := 'util';
    partition_name := 'app_run_logs_' || formatted_suffix_date;
    EXECUTE format('
        CREATE TABLE %I.%I PARTITION OF util.app_run_logs
        FOR VALUES FROM (%L) TO (%L);', schema_name, partition_name, formatted_from_date, formatted_to_date);
        
END $$;