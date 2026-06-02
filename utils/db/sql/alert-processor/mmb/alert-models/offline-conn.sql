SELECT  *
FROM    alert.models    am
WHERE   am.pg_table     = 'alert.offline_mmb_conn'
AND     am.enabled 	    IS TRUE
AND   
	(am.user_id = 'default' OR am.customized IS TRUE)
ORDER BY 
    am.user_id,
    am.system_id;