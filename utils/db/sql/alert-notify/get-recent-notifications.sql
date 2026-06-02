SELECT   * 
FROM     alert.notifications 
WHERE    user_id = $1
AND      last_update > (NOW() - INTERVAL '72 hours')
-- AND      last_update > (NOW() - INTERVAL '6 hours')
ORDER BY last_update DESC;