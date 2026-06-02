SELECT
    sys.id AS system_id,
    lc.show_on_website_on,
    lc.process_log_on,
    lc.process_mag_on,
    lc.process_edu_on,
    c.name AS customer_name,
    sys.manufacturer,
    sys.modality,
    sites.name AS site_name,
    sites.city,
    sites.state
FROM
    life.life_cycle lc
    JOIN systems sys ON sys.id = lc.system_id
    JOIN sites ON sites.id = sys.site_id
    JOIN customers c ON c.id = sites.customer_id
WHERE
    (show_on_website_on >= NOW() - INTERVAL '7 days')
    OR (process_log_on >= NOW() - INTERVAL '7 days')
    OR (process_mag_on >= NOW() - INTERVAL '7 days')
    OR (process_edu_on >= NOW() - INTERVAL '7 days');