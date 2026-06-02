SELECT
    ni.id AS system_id,
    ni.notes,
    ni.assigned,
    ni.inserted_at AS created_at,
    ni.updated_at,
    ni.status,
    ni.report_id,
    ni.reported_by,
    ni.processor_type,
    sys.manufacturer,
    sys.modality,
    sites.name
FROM
    network_issues ni
    JOIN systems sys ON ni.id = sys.id
    JOIN sites ON sites.id = sys.site_id
WHERE
    ni.resolved IS NOT TRUE
    AND ni.status = 'active'
    AND ni.processor_type = 'MMB'
    AND ni.inserted_at > NOW() - INTERVAL '30 days';