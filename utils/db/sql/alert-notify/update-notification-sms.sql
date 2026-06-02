UPDATE 
   alert.notifications
SET 
   sms_status = $1,
   sms_sid = $2
WHERE 
   run_id = $3
AND
   job_id = $4;