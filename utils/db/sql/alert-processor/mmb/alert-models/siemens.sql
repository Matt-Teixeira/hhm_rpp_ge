SELECT 
   		am.*,
		u.he_level_units,
		u.mag_psia_units,
		htv.mag_type_code,
   		htv.full_volume 
FROM	alert.models			am
JOIN  	mag.siemens_units    	u		ON	u.system_id = am.system_id 
FULL JOIN config.he_tank_volumes	htv	ON	htv.system_id  = am.system_id
WHERE 	am.pg_table    = 'mmb_siemens' 
AND		am.enabled 		IS TRUE
AND   	(am.user_id = 'default' OR am.customized IS TRUE)
AND		am."operator"	!= 'frozen_host'
AND     am.operator     != 'absent_null_data'
ORDER BY 
    am.user_id, 
    am.system_id, 
    am.pg_table, 
    am.severity, 
    am.field_name;