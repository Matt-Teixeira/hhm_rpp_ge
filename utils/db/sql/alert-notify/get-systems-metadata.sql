SELECT 
    systems.id system_id,
    systems.manufacturer,
    systems.modality,
    sites.name site_name,
    sites.state,
    sites.city 
FROM systems 
JOIN sites ON sites.id = systems.site_id
ORDER BY systems.id;