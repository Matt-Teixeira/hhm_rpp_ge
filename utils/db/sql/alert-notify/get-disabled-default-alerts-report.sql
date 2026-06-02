SELECT
    am.system_id,
    am.id AS alert_model_id,
    am.field_name_alias AS field_name,
    am.operator,
    am.threshold, 
    am.enabled,am.last_update,
    am.last_updated_by,
    sys.show_on_website,
    sys.manufacturer,
    sys.modality,
    sites.name,
    sites.city,
    sites.state
FROM
    alert.models am
    JOIN systems sys ON sys.id = am.system_id
    JOIN sites ON sites.id = sys.site_id
WHERE
    user_id = 'default'
    AND enabled IS FALSE
    AND sys.show_on_website IS TRUE
    AND sys.modality = 'MRI'
    AND am.field_name_alias NOT LIKE '%HHM%'
ORDER BY
    system_id ASC;