SELECT
    DISTINCT ON (lehm.system_id, lehm.name) lehm.system_id,
    lehm.name AS field_name,
    lehm.host_datetime,
    lehm.value AS rpp_value,
    sys.manufacturer,
    sys.modality,
    sites.name AS site_name,
    sites.city,
    sites.state
FROM
    logfile_event_history_metadata lehm
    JOIN systems sys ON sys.id = lehm.system_id
    JOIN sites ON sys.site_id = sites.id
WHERE
    lehm.name = 'scan_seconds'
    OR lehm.name = 'system_scan_seconds'
ORDER BY
    lehm.system_id,
    lehm.name,
    lehm.host_datetime DESC;