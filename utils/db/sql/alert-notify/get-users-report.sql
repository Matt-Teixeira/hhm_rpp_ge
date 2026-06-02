SELECT
   u.email_address,
   u.notify_email,
   u.phone_number,
   u.notify_sms,
   am.id            alert_model_id,
   am.default_id    alert_model_default_id,
   am.customized    customized,
   am.enabled       enabled 
FROM    users       u
JOIN    alert.models    am
ON      am.user_id = u.email_address
WHERE   u.status = 'active'
AND	 u.email_address IN ('andrew.hoppe@avantehs.com', 'Ryan.Anderson@avantehs.com', 'jonathan.pope@avantehs.com', 'matt.teixeira@avantehs.com', 'ashley.mcgloon@avantehs.com');
-- AND	 u.email_address IN ('jonathan.pope@avantehs.com');
-- andrew.hoppe@avantehs.com, ashley.mcgloon@avantehs.com, matthew.talley@avantehs.com, bernie.dixon@avantehs.com"
-- AND	  am.enabled IS TRUE