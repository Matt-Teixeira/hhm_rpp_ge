SELECT  * 
FROM    alert.models    am
JOIN    edu.v2_units    u   ON  u.system_id =  am.system_id
WHERE   am.pg_table     =   'mmb_edu2'
AND		am.enabled 		IS TRUE
AND     (am.user_id = 'default' OR am.customized IS TRUE)
AND     am.operator     != 'absent_null_data'
ORDER BY
    am.user_id, 
    am.system_id, 
    am.pg_table, 
    am.severity, 
    am.field_name;