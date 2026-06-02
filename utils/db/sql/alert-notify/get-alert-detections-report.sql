SELECT
    cus.id           customer_id,
    cus.name         customer_name,
    sit.id           site_id,
    sit.name         site_name,
    sit.state        state,
    sit.city         city,
    sys.manufacturer manufacturer,
    sys.modality     modality, 
    d.alert_model_id,
    d.system_id,
    d.pg_table,
    d.field_name,
    d.units_field_name,
    d.resolved_field_content,
    d.resolved_field_units,
    d.operator,
    d.threshold,
    d.resolved_threshold_content,
    d.threshold_units,
    d.threshold_offset,
    d.severity,
    d.inserted_at,
    d.row_id,
    d.field_content,
    d.field_name_alias,
    d.alert_units,
    d.capture_datetime,
    d.log_msg
FROM        alert.detections           d
JOIN        public.systems             sys
ON          sys.id = d.system_id
JOIN        public.sites               sit
ON          sit.id = sys.site_id
JOIN        public.customers           cus
ON          cus.id = sit.customer_id
WHERE       inserted_at > (NOW() - INTERVAL '60 minutes')
AND         d.field_name = 'he_level_value'
AND         d.operator = 'less_than'
ORDER BY    cus.id, sit.id, sys.id;