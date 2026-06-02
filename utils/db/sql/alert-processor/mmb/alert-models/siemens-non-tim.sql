SELECT 
   	    am.*,
   	    u.he_level_units,
   	    u.shield_temp_units
FROM	alert.models	am
JOIN	mag.siemens_non_tim_units	u	ON	u.system_id = am.system_id 
WHERE   am.pg_table 	= 'mmb_siemens_non_tim' 
AND	    am.enabled		IS TRUE
AND     (am.user_id = 'default' OR am.customized IS TRUE)
AND	    am."operator"	!= 'frozen_host'
AND     am.operator     != 'absent_null_data'
ORDER BY 
    am.user_id, 
    am.system_id, 
    am.pg_table, 
    am.severity, 
    am.field_name;