SELECT 
    am.*,
    units.he_level_units,
    units.he_pressure_units 
FROM 	alert.models   		am
JOIN 	mag.ge_mm3_units   	units   
ON 		units.system_id 	= am.system_id
WHERE 	am.pg_table     	= 'mmb_ge_mm3'
AND		am.enabled 			IS TRUE
AND   	(am.user_id = 'default' OR am.customized IS TRUE)
AND		am."operator"		!= 'frozen_host'
AND     am.operator         != 'absent_null_data'
ORDER BY 
    am.user_id, 
    am.system_id, 
    am.pg_table, 
    am.severity, 
    am.field_name;