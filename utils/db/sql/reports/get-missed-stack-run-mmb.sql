SELECT
	rf.system_id,
	rf.capture_datetime,
	sys.manufacturer,
	sys.modality,
	sites.name,
	sites.city,
	sites.state
FROM
	public.recent_files rf
	JOIN systems sys ON rf.system_id = sys.id
	JOIN sites ON sites.id = sys.site_id
WHERE
	rf.capture_datetime BETWEEN NOW() - INTERVAL '46 minutes'
	AND NOW() - INTERVAL '41 minutes'
	AND manufacturer != 'Philips'
ORDER BY
	rf.capture_datetime DESC;