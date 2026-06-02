SELECT
    ni.id AS system_id,
    sys.manufacturer,
    sys.modality,
    sites.name,
    ni.type,
    ni.notes,
    ni.diagnoses,
    ni.resolved,
    ni.inserted_at AS ticket_created_at,
    ni.updated_at AS ticket_updated_at,
    ohc.capture_datetime AS hhm_last_connected,
    ohc.inserted_at AS hhm_last_db_update,
    ohc.host_intervention AS intervention_detected,
    omc.capture_datetime AS mmb_last_connected,
    omc.inserted_at AS mmb_last_db_update
FROM
    alert.offline_hhm_conn ohc FULL
    JOIN network_issues ni ON ni.id = ohc.system_id
    JOIN systems sys ON ni.id = sys.id
    JOIN sites ON sites.id = sys.site_id FULL
    JOIN alert.offline_mmb_conn omc ON ni.id = omc.system_id
WHERE
    ohc.host_intervention IS TRUE
    AND ni.resolved IS NOT TRUE
ORDER BY
    name;