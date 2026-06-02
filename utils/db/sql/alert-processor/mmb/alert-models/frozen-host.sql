SELECT  *
FROM    alert.models   		
WHERE 	"operator"	= 'frozen_host'
AND     enabled     IS TRUE
AND     (user_id = 'default' OR customized IS TRUE)
ORDER BY 
    user_id, 
    system_id;