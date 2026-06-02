SELECT
    *,
    ARRAY(
        SELECT
            unnest(systems_list) AS element
        ORDER BY
            element ASC
    ) AS systems_list
FROM
    alert.reports
WHERE
    email_schedule ->> $1 = 'true'
    AND field_name = $2;