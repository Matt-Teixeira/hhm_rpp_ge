SELECT 
        am.*,
        u.helium_level_units,
        u.he_psi_avg_units,
        u.mag_dps_status_units
FROM    alert.models        am
JOIN    mag.philips_mri_monitoring_data_units    u	ON	u.system_id    = am.system_id 
WHERE   am.pg_table    		= 'philips_monitoring_agg' 
AND	    am.enabled 			IS TRUE
AND     (am.user_id = 'default' OR am.customized IS TRUE)
AND	    am."operator"		!= 'frozen_host'
ORDER BY 
    am.user_id, 
    am.system_id, 
    am.pg_table, 
    am.severity, 
    am.field_name;