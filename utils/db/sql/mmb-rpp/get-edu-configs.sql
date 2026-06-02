SELECT 	
		sys.id,
		edu.file_name,
		edu.pg_tables,
		edu.regex_models
FROM 	systems sys
JOIN	config.acquisition 	acq ON acq.system_id = sys.id
JOIN	config.edu			   edu ON edu.system_id = sys.id
WHERE	sys.process_edu IS TRUE
AND	edu.schedule = $1
ORDER BY sys.id;