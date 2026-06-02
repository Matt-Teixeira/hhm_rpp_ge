SELECT  * 
FROM    alert.models    am
WHERE   am.pg_table     = 'log.siemens_ct'
AND	    am.enabled 		IS TRUE
AND   
	(am.user_id = 'default' OR am.customized IS TRUE)
ORDER BY
    am.user_id, 
    am.system_id, 
    am.pg_table, 
    am.severity, 
    am.field_name;