SELECT 
        DISTINCT b.field_name AS relevant_field_name,
        a.*
FROM    alert.models a
JOIN    alert.models b  ON  a.user_id   = b.user_id
                        AND a.enabled   = b.enabled
                        AND a.pg_table  = b.pg_table
                        AND a.system_id = b.system_id
WHERE   a.operator      = 'absent_null_data'
AND     a.user_id       = 'default'
AND     a.enabled       IS TRUE
AND     b.field_name    != 'dynamic' -- EXCLUDE SELF-REFERENTIAL ALERT MODELS
ORDER BY
        a.system_id, b.field_name;