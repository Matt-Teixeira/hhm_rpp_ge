SELECT 	
		sys.id,
		mag.file_name,
		mag.pg_tables,
		mag.regex_models
FROM 	systems sys
JOIN	config.acquisition 	acq ON acq.system_id = sys.id
JOIN	config.mag			   mag ON mag.system_id = sys.id
WHERE	sys.process_mag IS TRUE
AND	sys.id = $1
ORDER BY sys.id;