SELECT
    sys.id AS system_id,
    ohc.capture_datetime AS last_file_pulled_at,
    ohc.inserted_at,
    ohc.host_intervention,
    ohc.rpp_host_datetime AS latest_data_datetime,
    ohc.successful_acquisition,
    ohc.connection_error,
    sys.manufacturer,
    sys.modality,
    c.name AS cust_name,
    sites.name AS site_name,
    sites.city,
    sites.state
FROM
    alert.offline_hhm_conn ohc
    JOIN systems sys ON sys.id = ohc.system_id
    JOIN sites ON sites.id = sys.site_id
    JOIN customers c ON c.id = sites.customer_id 
WHERE
    ohc.successful_acquisition IS FALSE
    AND sys.process_log IS TRUE
    AND sys.show_on_website IS TRUE
ORDER BY
    c.name,
    sites.name,
    sys.manufacturer,
    sys.modality;