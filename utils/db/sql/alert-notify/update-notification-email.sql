UPDATE 
   alert.notifications   
SET 
   email_status = $1
WHERE 
   run_id = $2
AND
   job_id = $3;