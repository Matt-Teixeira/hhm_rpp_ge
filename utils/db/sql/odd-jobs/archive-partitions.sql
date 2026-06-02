DO $$
DECLARE
    current_date            DATE := CURRENT_DATE;
    suffix_date             DATE := current_date - INTERVAL '6 month';    
    formatted_suffix_date   TEXT := TO_CHAR(suffix_date, 'YYYY_MM');

    source_schema           TEXT;
    archive_schema          TEXT;
    partition_parent        TEXT;
    partition_child         TEXT;

    schema_list             TEXT[] := ARRAY['alert', 'edu', 'log', 'mag', 'util'];
    partition_map           JSONB;
    parent_array            TEXT[];
BEGIN
    -- JSONB MAPPING EACH SCHEMA TO ITS PARTITION_PARENT TABLES
    partition_map := jsonb_build_object(
        'alert',        to_jsonb(ARRAY['detections', 'notifications']),
        'edu',          to_jsonb(ARRAY['v1', 'v2']),
        'log',          to_jsonb(ARRAY[
                            'ge_ct_gesys', 'ge_cv_syserror', 'ge_mri_gesys',
                            'philips_ct_eal_events', 'philips_cv_eventlog', 'philips_mri_logcurrent',
                            'siemens_ct', 'siemens_cv', 'siemens_mri', 'stt_magnet'
                        ]),
        'mag',          to_jsonb(ARRAY[
                            'ge_mm3', 'ge_mm4', 
                            'philips_mri_rmmu_history', 'philips_mri_rmmu_long',
                            'philips_mri_rmmu_magnet', 'philips_mri_rmmu_short',
                            'siemens', 'siemens_non_tim', 'stt_magnet'
                        ]),
        'util',         to_jsonb(ARRAY['app_run_logs'])
    );

    -- LOOP THROUGH EACH SCHEMA
    FOREACH source_schema IN ARRAY schema_list LOOP
        archive_schema := 'archive_' || source_schema;
        parent_array := ARRAY(SELECT jsonb_array_elements_text(partition_map -> source_schema));

        -- LOOP THROUGH EACH PARTITION_PARENT TABLE WITHIN THE SCHEMA
        FOREACH partition_parent IN ARRAY parent_array LOOP
            partition_child := partition_parent || '_' || formatted_suffix_date;

            -- DETACH AND MOVE THE PARTITION TO ARCHIVE SCHEMA
            BEGIN
                EXECUTE format(
                    'ALTER TABLE %I.%I DETACH PARTITION %I.%I;',
                    source_schema, partition_parent, source_schema, partition_child
                );
                EXECUTE format(
                    'ALTER TABLE %I.%I SET SCHEMA %I;',
                    source_schema, partition_child, archive_schema
                );
            EXCEPTION
                WHEN OTHERS THEN
                    RAISE NOTICE 'Skipping % due to error: %',
                        format('%I.%I', source_schema, partition_child),
                        SQLERRM;
            END;
        END LOOP;
    END LOOP;
END $$;

-- VERBOSE METHOD
-- DO $$ 
-- DECLARE
--     current_date            DATE := CURRENT_DATE;
--     suffix_date             DATE := current_date - INTERVAL '6 month';    
--     formatted_suffix_date   TEXT;
--     source_schema           TEXT;
--     partition_parent        TEXT;
--     partition_child         TEXT;
--     archive_schema          TEXT;
-- BEGIN
--     -- FOR EACH PARENT TABLE
--     -- 1. DETACH OLD PARTITION
--     -- 2. RENAME PARTITION FOR ARCHIVE STORAGE
    
--     -- SOURCE SCHEMA AND PARENT TABLE   EX: alert.detections
--     -- CHILD PARTITION                  EX: detections_2025_01
--     -- ARCHIVE SCHEMA                   EX: archive_alert

--     -- DEV PRINTS    
--     -- RAISE NOTICE 'source_schema: %',     source_schema;
--     -- RAISE NOTICE 'partition_parent: %',  partition_parent;
--     -- RAISE NOTICE 'partition_child: %',   partition_child;
--     -- RAISE NOTICE 'archive_schema: %',    archive_schema;

--     -- UNIVERSAL partition_child SUFFIX
--     formatted_suffix_date   := TO_CHAR(suffix_date, 'YYYY_MM');    
    
--     -------------------------------------------- ALERT SCHEMA ------------------------------------------
--     source_schema := 'alert';
--     archive_schema := 'archive' || '_' || source_schema;

--     -- alert.detections
--     partition_parent := 'detections';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);    
    
--     -- alert.notifications
--     partition_parent := 'notifications';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);
    
--     -------------------------------------------- EDU SCHEMA --------------------------------------------
--     source_schema := 'edu';
--     archive_schema := 'archive' || '_' || source_schema;

--     -- edu.v1
--     partition_parent := 'v1';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);    

--     -- edu.v2
--     partition_parent := 'v2';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);    

--     -------------------------------------------- LOG SCHEMA --------------------------------------------
--     source_schema := 'log';
--     archive_schema := 'archive' || '_' || source_schema;

--     -- log.ge_ct_gesys
--     partition_parent := 'ge_ct_gesys';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);    
    
--     -- log.ge_cv_syserror
--     partition_parent := 'ge_cv_syserror';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);

--     -- log.ge_mri_gesys
--     partition_parent := 'ge_mri_gesys';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);

--     -- log.philips_ct_eal_events
--     partition_parent := 'philips_ct_eal_events';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);

--     -- log.philips_cv_eventlog
--     partition_parent := 'philips_cv_eventlog';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);
    
--     -- log.philips_mri_logcurrent
--     partition_parent := 'philips_mri_logcurrent';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);

--     -- log.siemens_ct
--     partition_parent := 'siemens_ct';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);

--     -- log.siemens_cv
--     partition_parent := 'siemens_cv';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);

--     -- log.siemens_mri
--     partition_parent := 'siemens_mri';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);
    
--     -- log.stt_magnet
--     partition_parent := 'stt_magnet';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);

--     -------------------------------------------- MAG SCHEMA --------------------------------------------
--     source_schema := 'mag';
--     archive_schema := 'archive' || '_' || source_schema;

--     -- mag.ge_mm3
--     partition_parent := 'ge_mm3';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);
    
--     -- mag.ge_mm4
--     partition_parent := 'ge_mm4';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);
    
--     -- mag.philips_mri_rmmu_history
--     partition_parent := 'philips_mri_rmmu_history';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);
    
--     -- mag.philips_mri_rmmu_long
--     partition_parent := 'philips_mri_rmmu_long';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);
    
--     -- mag.philips_mri_rmmu_magnet
--     partition_parent := 'philips_mri_rmmu_magnet';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);
    
--     -- mag.philips_mri_rmmu_short
--     partition_parent := 'philips_mri_rmmu_short';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);

--     -- mag.siemens
--     partition_parent := 'siemens';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);
    
--     -- mag.siemens_non_tim
--     partition_parent := 'siemens_non_tim';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);
    
--     -- mag.stt_magnet
--     partition_parent := 'stt_magnet';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);

--  -------------------------------------------- UTIL SCHEMA --------------------------------------------
--     source_schema := 'util';
--     archive_schema := 'archive' || '_' || source_schema;
    
--     -- util.app_run_logs
--     partition_parent := 'app_run_logs';
--     partition_child := partition_parent || '_' || formatted_suffix_date;
--     EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I;', source_schema, partition_parent, source_schema, partition_child);
--     EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I;', source_schema, partition_child, archive_schema);
        
-- END $$;
