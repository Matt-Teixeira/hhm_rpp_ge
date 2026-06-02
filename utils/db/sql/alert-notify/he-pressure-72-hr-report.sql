SELECT
    DISTINCT ON (systems.id) systems.id AS system_id,
    systems.manufacturer,
    systems.modality,
    systems.model,
    sys_fields.datapoint_count,
    sys_fields.max_value,
    sys_fields.min_value,
    units.unit,
    sys_fields.host_datetime_max_value,
    sys_fields.host_datetime_min_value
FROM
    (
        WITH CombinedData AS (
            SELECT
                system_id,
                he_pressure_value,
                host_datetime
            FROM
                mag.ge_mm3
            WHERE
                host_datetime >= NOW() - INTERVAL '72 hours'
            UNION
            ALL
            SELECT
                system_id,
                he_pressure_value,
                host_datetime
            FROM
                mag.ge_mm4
            WHERE
                host_datetime >= NOW() - INTERVAL '72 hours'
            UNION
            ALL
            SELECT
                system_id,
                mag_psia_value AS he_pressure_value,
                host_datetime
            FROM
                mag.siemens
            WHERE
                host_datetime >= NOW() - INTERVAL '72 hours'
            UNION
            ALL
            SELECT
                system_id,
                he_psi_avg_value AS he_pressure_value,
                host_datetime
            FROM
                mag.philips_mri_monitoring_data_agg
            WHERE
                host_datetime >= NOW() - INTERVAL '72 hours'
                AND he_psi_avg_value IS NOT NULL
        ),
        RankedValues AS (
            SELECT
                system_id,
                he_pressure_value,
                host_datetime,
                FIRST_VALUE(host_datetime) OVER(
                    PARTITION BY system_id
                    ORDER BY
                        he_pressure_value DESC
                ) AS max_he_host_datetime,
                FIRST_VALUE(host_datetime) OVER(
                    PARTITION BY system_id
                    ORDER BY
                        he_pressure_value ASC
                ) AS min_he_host_datetime,
                ROW_NUMBER() OVER(
                    PARTITION BY system_id
                    ORDER BY
                        he_pressure_value DESC
                ) AS rn_max,
                ROW_NUMBER() OVER(
                    PARTITION BY system_id
                    ORDER BY
                        he_pressure_value ASC
                ) AS rn_min
            FROM
                CombinedData
        )
        SELECT
            system_id,
            COUNT(he_pressure_value) AS datapoint_count,
            MAX(he_pressure_value) AS max_value,
            MIN(he_pressure_value) AS min_value,
            MAX(
                case
                    when rn_max = 1 then max_he_host_datetime
                end
            ) AS host_datetime_max_value,
            MAX(
                case
                    when rn_min = 1 then min_he_host_datetime
                end
            ) AS host_datetime_min_value
        FROM
            RankedValues
        GROUP BY
            system_id
        ORDER BY
            system_id
    ) AS sys_fields
    JOIN systems ON systems.id = sys_fields.system_id
    JOIN (
        SELECT
            system_id,
            he_pressure_units AS unit
        FROM
            mag.ge_mm3_units mm3
        UNION
        ALL
        SELECT
            system_id,
            he_pressure_units AS unit
        FROM
            mag.ge_mm4_units mm4
        UNION
        ALL
        SELECT
            system_id,
            mag_psia_units AS unit
        FROM
            mag.siemens_units siemens
        UNION
        ALL
        SELECT
            system_id,
            monitor_magnet_pressure_units AS unit
        FROM
            mag.philips_mri_monitoring_data_units phil
    ) AS units ON systems.id = units.system_id
    JOIN (
        SELECT
            am.id,
            am.system_id,
            ar.author,
            ar.systems_list,
            ar.cc_list,
            ar.OPERATOR,
            ar.threshold,
            ar.threshold_data_type,
            ar.report_name
        FROM
            alert.reports ar
            JOIN alert.models am ON ar.author = am.user_id
        WHERE
            ar.email_schedule ->> $1 = 'true'
            AND ar.field_name = 'he_pressure_72_hr'
            AND am.user_id = $2
    ) AS report ON systems.id = report.system_id;

    /* SELECT
     DISTINCT ON (systems.id) systems.id AS system_id,
     systems.manufacturer,
     systems.modality,
     systems.model,
     sys_fields.datapoint_count,
     sys_fields.max_value,
     sys_fields.min_value,
     units.unit,
     report.author,
     report.report_name
     FROM
     (
     SELECT
     system_id,
     COUNT(he_pressure_value) AS datapoint_count,
     MAX(he_pressure_value) AS max_value,
     MIN(he_pressure_value) AS min_value
     FROM
     mag.ge_mm3
     WHERE
     host_datetime >= NOW() - INTERVAL '72 hours'
     GROUP BY
     system_id
     UNION
     ALL
     SELECT
     system_id,
     COUNT(he_pressure_value) AS datapoint_count,
     MAX(he_pressure_value) AS max_value,
     MIN(he_pressure_value) AS min_value
     FROM
     mag.ge_mm4
     WHERE
     host_datetime >= NOW() - INTERVAL '72 hours'
     GROUP BY
     system_id
     UNION
     ALL
     SELECT
     system_id,
     COUNT(mag_psia_value) AS datapoint_count,
     MAX(mag_psia_value) AS max_value,
     MIN(mag_psia_value) AS min_value
     FROM
     mag.siemens siemens
     WHERE
     host_datetime >= NOW() - INTERVAL '72 hours'
     GROUP BY
     system_id
     UNION
     ALL
     SELECT
     system_id,
     COUNT(he_psi_avg_value) AS datapoint_count,
     MAX(he_psi_avg_value) AS max_value,
     MIN(he_psi_avg_value) AS min_value
     FROM
     mag.philips_mri_monitoring_data_agg
     WHERE
     host_datetime >= NOW() - INTERVAL '72 hours'
     AND he_psi_avg_value IS NOT NULL
     GROUP BY
     system_id
     ) AS sys_fields
     JOIN systems ON systems.id = sys_fields.system_id
     JOIN (
     SELECT
     system_id,
     he_pressure_units AS unit
     FROM
     mag.ge_mm3_units mm3
     UNION
     ALL
     SELECT
     system_id,
     he_pressure_units AS unit
     FROM
     mag.ge_mm4_units mm4
     UNION
     ALL
     SELECT
     system_id,
     mag_psia_units AS unit
     FROM
     mag.siemens_units siemens
     UNION
     ALL
     SELECT
     system_id,
     monitor_magnet_pressure_units AS unit
     FROM
     mag.philips_mri_monitoring_data_units phil
     ) AS units ON systems.id = units.system_id
     JOIN (
     SELECT
     am.id,
     am.system_id,
     ar.author,
     ar.systems_list,
     ar.cc_list,
     ar.OPERATOR,
     ar.threshold,
     ar.threshold_data_type,
     ar.report_name
     FROM
     alert.reports ar
     JOIN alert.models am ON ar.author = am.user_id
     WHERE
     ar.email_schedule ->> $1 = 'true'
     AND ar.field_name = 'he_pressure_72_hr'
     AND am.user_id = $2
     ) AS report ON systems.id = report.system_id
     */