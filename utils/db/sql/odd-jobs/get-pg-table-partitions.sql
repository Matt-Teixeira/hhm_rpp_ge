-- RETURNS PARTITION NAMES ONLY, CLEANER BUT LESS INFORMATIVE
SELECT DISTINCT 
        n.nspname       AS schema_name,
        c.relname       AS partition_table
FROM    pg_class        c
JOIN    pg_inherits     i   ON c.oid = i.inhrelid
JOIN    pg_namespace    n   ON c.relnamespace = n.oid
WHERE   c.relkind       =   'r'
-- AND     c.relname       LIKE '%' || to_char(CURRENT_DATE, 'YYYY_MM')
AND     c.relname       LIKE CONCAT('%', TO_CHAR(CURRENT_DATE + INTERVAL '1 month', 'YYYY_MM'))
ORDER BY n.nspname, c.relname;

-- VERBOSE QUERY WHICH RETURNS PARTITIONS *AND ASSOCIATED INDEXES
-- WITH partitioned_tables AS (
--     SELECT 
--         c.relname AS partition_name,
--         n.nspname AS schema_name
--     FROM 
--         pg_inherits i
--         JOIN pg_class c ON c.oid = i.inhrelid
--         JOIN pg_class parent ON parent.oid = i.inhparent
--         JOIN pg_namespace n ON c.relnamespace = n.oid
--     WHERE 
--         -- c.relname LIKE '%' || to_char(CURRENT_DATE, 'YYYY_MM')
--         c.relname LIKE CONCAT('%', TO_CHAR(CURRENT_DATE + INTERVAL '1 month', 'YYYY_MM'))
-- )
-- SELECT 
--     pi.schemaname   AS schema_name,
--     pi.tablename    AS partition_name,
--     pi.indexname    AS index_name,
--     pi.indexdef     AS index_def
-- FROM 
--     pg_indexes pi
--     JOIN partitioned_tables pt 
--       ON pi.tablename = pt.partition_name 
--      AND pi.schemaname = pt.schema_name
-- ORDER BY 
--     pi.schemaname,
--     pi.tablename,
--     pi.indexname;