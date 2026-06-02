SELECT
    DISTINCT ON (system_id) snt.system_id,
    units.shield_temp_units AS unit,
    host_datetime,
    capture_datetime,
    shield_temp_value AS rpp_value,
    sys.manufacturer,
    sys.modality,
    sites.name AS site_name,
    sites.city,
    sites.state
FROM
    mag.siemens_non_tim snt
    JOIN systems sys ON sys.id = snt.system_id
    JOIN sites ON sys.site_id = sites.id
    JOIN mag.siemens_non_tim_units units ON units.system_id = snt.system_id
WHERE
    shield_temp_value IS NOT NULL
    AND sys.process_mag IS TRUE
ORDER BY
    system_id,
    capture_datetime DESC;