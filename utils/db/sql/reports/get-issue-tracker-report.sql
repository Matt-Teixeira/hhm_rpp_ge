SELECT
    sys.id as system_id,
    ar.author,
    ar.report_name,
    ar.field_name,
    ar.email_schedule,
    ar.issue_note,
    sys.manufacturer,
    sys.modality,
    sites.name,
    sites.city,
	sites.state
FROM
    alert.reports ar
    JOIN systems sys ON ar.issue_system_id = sys.id
    JOIN sites ON sites.id = sys.site_id
WHERE
    field_name = 'reportable_issue';